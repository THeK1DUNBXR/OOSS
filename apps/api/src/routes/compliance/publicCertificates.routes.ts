/**
 * The public certificate check: unauthenticated, mounted before `requireAuth`
 * in `routes/index.ts`. The tenant is found from the verification code inside
 * `publicCertificateStatus` and from nowhere else; a tenant header or query
 * parameter on this request is never read.
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { handler } from '../../lib/http.js';
import { publicCertificateStatus } from '../../domains/compliance/corporate/certificates.js';
import { PostgresRateLimitStore } from '../../platform/rateLimitStore.js';

const router = Router();

// The same ceiling as public form submission (marketing/public.routes.ts): a
// verifier checks a handful of certificates, and a scraper walking the code
// space is slowed to a crawl. Keyed on req.ip, which under trust proxy is the
// address the reverse proxy saw, not a header the caller wrote.
const verifyLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new PostgresRateLimitStore('certificate-verify'),
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many checks from this address. Try again in a minute.' },
  },
});

router.get(
  '/certificates/:code',
  verifyLimit,
  handler(async (req) => publicCertificateStatus(req.params.code)),
);

export default router;
