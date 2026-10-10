/**
 * Rate limits for `POST /auth/login`, both held in Postgres so they hold across
 * API instances: a per-address limit, and a per-email limit that stops a
 * credential-stuffing run from spreading one account's guesses over many
 * addresses. Both count every attempt, successful or not.
 */

import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PostgresRateLimitStore } from '../../../platform/rateLimitStore.js';

// Five attempts a minute per IP and five per minute per email — generous enough
// for a person who mistypes a password twice, tight enough to make a
// credential-stuffing run slow.
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

/** The email is lower-cased so `A@x` and `a@x` share one bucket. A body without one shares a bucket: malformed requests are not a way round the limit. */
const loginEmailLimit = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => (typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'unknown'),
  store: new PostgresRateLimitStore('login:email'),
  message: LOGIN_REFUSED,
});

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  // express-rate-limit answers the refusal itself and does not call `next`,
  // so reaching a callback means the request is still under that limit.
  loginAddressLimit(req, res, (err?: unknown) => {
    if (err) return next(err);
    loginEmailLimit(req, res, (emailErr?: unknown) => {
      if (emailErr) return next(emailErr);
      next();
    });
  });
}
