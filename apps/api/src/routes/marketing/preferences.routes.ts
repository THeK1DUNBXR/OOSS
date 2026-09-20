import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import { unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import {
  getPreferences,
  recordMarketingConsent,
  withdrawMarketingConsent,
  setChannelPreference,
  setDoNotContact,
  consentCoverage,
  withdrawByToken,
  unsubscribeToken,
} from '../../domains/marketing/preferences.js';

// ---------------------------------------------------------------------------
// Authenticated router — mounted under /api/marketing/preferences.
// ---------------------------------------------------------------------------

const router = Router();

router.get(
  '/',
  handler(async (req) => {
    const personId = str(req.query.personId);
    if (!personId) throw ApiError.badRequest('personId is required.');
    return getPreferences(personId);
  }),
);

router.post(
  '/consent',
  handler(async (req) => {
    const schema = z.object({
      personId: z.string(),
      channel: z.enum(['portal', 'in_app', 'paper', 'verbal', 'guardian_intake']),
      evidence: z.record(z.unknown()).optional(),
    });
    const input = schema.parse(req.body);
    return recordMarketingConsent(input.personId, input.channel, input.evidence);
  }),
);

router.post(
  '/withdraw',
  handler(async (req) => {
    const schema = z.object({ personId: z.string(), reason: z.string().optional() });
    const input = schema.parse(req.body);
    return withdrawMarketingConsent(input.personId, input.reason);
  }),
);

router.post(
  '/channel',
  handler(async (req) => {
    const schema = z.object({ personId: z.string(), channelKey: z.string(), optedIn: z.boolean(), source: z.string().optional() });
    const input = schema.parse(req.body);
    return setChannelPreference(input.personId, input.channelKey, input.optedIn, input.source);
  }),
);

router.post(
  '/do-not-contact',
  handler(async (req) => {
    const schema = z.object({ personId: z.string(), doNotContact: z.boolean(), reason: z.string() });
    const input = schema.parse(req.body);
    return setDoNotContact(input.personId, input.doNotContact, input.reason);
  }),
);

router.get('/coverage', handler(async () => consentCoverage()));

export default router;

// ---------------------------------------------------------------------------
// Public router — no auth, mounted under /api/marketing/public/unsubscribe
// BEFORE the auth middleware. `contextMiddleware` still runs (it sets
// `req.ctx` even when unauthenticated), but no signed-in principal is
// present, so a token is checked across every tenant's own consent set as a
// SYSTEM_PRINCIPAL rather than through `currentAuth()`.
// ---------------------------------------------------------------------------

export const publicRouter = Router();

async function resolveByToken(token: string): Promise<{ tenantId: string; personId: string } | null> {
  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    const result = await asSystem(t.id, () => withdrawByToken(token));
    if (result) return { tenantId: t.id, personId: result.personId };
  }
  return null;
}

publicRouter.get('/unsubscribe/:token', async (req, res, next) => {
  try {
    // A GET only confirms the token resolves — it does not withdraw, so a
    // link preview fetch (email clients, chat unfurlers) never unsubscribes
    // anybody by accident. The actual withdrawal happens on POST (the page's
    // confirm button).
    const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
    let found = false;
    for (const t of tenants) {
      const rows = await unscopedPrisma.consent.findMany({
        where: { tenantId: t.id, purposeCode: 'marketing', status: 'granted' },
        select: { personId: true },
        distinct: ['personId'],
      });
      if (rows.some((r) => unsubscribeToken(r.personId) === req.params.token)) {
        found = true;
        break;
      }
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.status(found ? 200 : 404).send(
      found
        ? `<!doctype html><html><body><h1>Unsubscribe</h1><form method="post"><button type="submit">Confirm unsubscribe from marketing messages</button></form></body></html>`
        : `<!doctype html><html><body><h1>Link not recognised</h1><p>This unsubscribe link is invalid or has already been used.</p></body></html>`,
    );
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/unsubscribe/:token', async (req, res, next) => {
  try {
    const result = await resolveByToken(req.params.token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!result) {
      res.status(404).send(`<!doctype html><html><body><h1>Link not recognised</h1></body></html>`);
      return;
    }
    res.status(200).send(`<!doctype html><html><body><h1>You have been unsubscribed.</h1></body></html>`);
  } catch (err) {
    next(err);
  }
});
