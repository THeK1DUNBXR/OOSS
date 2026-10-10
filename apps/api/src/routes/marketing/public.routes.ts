/**
 * Marketing's public, unauthenticated surface (MKT-CAP-001).
 *
 * Mounted BEFORE the auth middleware (by the integration point that wires
 * `routes/marketing/index.ts` in) — nothing here runs `requireAuth`, and every
 * handler resolves its own tenant from the URL (a form's publicToken, a short
 * link's slug) or from the webhook's `X-Kai-Tenant` header / `tenant` query
 * param, exactly as `domains/marketing/capture.ts` documents.
 */

import express, { Router } from 'express';
import { handler, str } from '../../lib/http.js';
import { submitPublicForm, resolveAndClick, receiveWebhook } from '../../domains/marketing/capture.js';
import { rawBodyOf } from '../../lib/webhookSignature.js';
import { rateLimit } from 'express-rate-limit';
import { PostgresRateLimitStore } from '../../platform/rateLimitStore.js';

const router = Router();

// 30 submissions a minute per address, the limit the in-memory version held.
// Keyed on req.ip, not on the first X-Forwarded-For value: under trust proxy
// (server.ts) Express walks the chain from the rightmost entry Caddy appended,
// so a caller cannot rotate its way past the limit by writing the header.
const captureLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new PostgresRateLimitStore('capture'),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many submissions from this address. Try again in a minute.' } },
});

// Public form submissions arrive as JSON or classic form-encoded posts — the
// app-wide body parser in `server.ts` only reads JSON, so this router adds
// its own urlencoded parser rather than widening every other route's intake.
router.use(express.urlencoded({ extended: true }));

function clientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

router.post(
  '/public/forms/:publicToken/submit',
  captureLimit,
  handler(async (req, res) => {
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const utm: Record<string, unknown> = {};
    for (const key of ['source', 'medium', 'campaign', 'term', 'content']) {
      const v = str(req.query[`utm_${key}`]) ?? str(payload[`utm_${key}`]) ?? str(payload[key]);
      if (v) utm[key] = v;
    }
    const result = await submitPublicForm(req.params.publicToken, payload, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      utm,
    });
    res.status(200);
    return result;
  }),
);

router.get(
  '/public/l/:slug',
  handler(async (req, res) => {
    const { targetUrl } = await resolveAndClick(req.params.slug, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.redirect(302, targetUrl);
    return undefined;
  }),
);

// The endpoint token in the path is what names the tenant; the HMAC over the raw
// body is what authenticates the request. A tenant header is not read here at all.
// A replay of an applied event answers 200 rather than 202, so a provider can tell
// "already had it" from "accepted now" without the body being applied twice.
router.post(
  '/public/webhooks/:provider/:endpointToken',
  handler(async (req, res) => {
    const result = await receiveWebhook(
      {
        provider: req.params.provider,
        endpointToken: req.params.endpointToken,
        rawBody: rawBodyOf(req),
        timestamp: str(req.headers['x-kai-timestamp']),
        signature: str(req.headers['x-kai-signature']),
      },
      { ip: clientIp(req), userAgent: req.headers['user-agent'] },
    );
    res.status(result.duplicate ? 200 : 202);
    return result;
  }),
);

export default router;
