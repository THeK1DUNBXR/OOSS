/**
 * Rate limits for `POST /auth/login`: a per-address limit held in Postgres, and
 * a per-email token bucket that is still process-local.
 *
 * The per-email bucket is the gap. A process-local count holds for one API
 * instance only; it is noted here rather than pretended away, per
 * docs/plan/compliance.md's own "state what the platform does not do"
 * discipline, until it moves onto the same store.
 */

import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PostgresRateLimitStore } from '../../../platform/rateLimitStore.js';

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number, // tokens regained per millisecond
  ) {}

  /** True when a request under `key` may proceed; consumes one token if so. */
  consume(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Test/ops hook: drop a key's state so a fixture run starts clean. */
  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }
}

// Five attempts a minute per IP, five per minute per email — generous enough
// for a person who mistypes a password twice, tight enough to make a
// credential-stuffing run slow.
//
// The address bucket is in Postgres so it holds across API instances; the
// email bucket is still per process (FX-53 tracks moving it too).
export const loginEmailLimiter = new TokenBucketLimiter(5, 5 / 60_000);

const LOGIN_REFUSED = {
  error: {
    code: 'RATE_LIMITED',
    message: 'Too many sign-in attempts. Wait a minute and try again.',
  },
};

const loginAddressLimit = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new PostgresRateLimitStore('login:ip'),
  message: LOGIN_REFUSED,
});

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  // express-rate-limit answers the refusal itself and does not call `next`,
  // so reaching the callback means the address is still under its limit.
  loginAddressLimit(req, res, (err?: unknown) => {
    if (err) return next(err);
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'unknown';
    if (!loginEmailLimiter.consume(`email:${email}`)) {
      res.status(429).json(LOGIN_REFUSED);
      return;
    }
    next();
  });
}
