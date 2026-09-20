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

const router = Router();

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

router.post(
  '/public/webhooks/:provider',
  handler(async (req, res) => {
    const tenantSlug = str(req.headers['x-kai-tenant']) ?? str(req.query.tenant);
    const result = await receiveWebhook(req.params.provider, (req.body ?? {}) as Record<string, unknown>, {
      tenantSlug,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.status(202);
    return result;
  }),
);

export default router;
