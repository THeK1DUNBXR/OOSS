/**
 * A small in-memory token-bucket rate limiter, for `POST /auth/login`.
 *
 * This is process-local state: a multi-process deployment (more than one API
 * instance behind a load balancer) needs a shared store (Redis, or a table
 * behind an atomic increment) for the limit to hold across instances — noted
 * here rather than pretended away, per docs/plan/compliance.md's own
 * "state what the platform does not do" discipline.
 */

import type { NextFunction, Request, Response } from 'express';

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
export const loginIpLimiter = new TokenBucketLimiter(5, 5 / 60_000);
export const loginEmailLimiter = new TokenBucketLimiter(5, 5 / 60_000);

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'unknown';

  const ipOk = loginIpLimiter.consume(`ip:${ip}`);
  const emailOk = loginEmailLimiter.consume(`email:${email}`);

  if (!ipOk || !emailOk) {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Wait a minute and try again.',
      },
    });
    return;
  }
  next();
}
