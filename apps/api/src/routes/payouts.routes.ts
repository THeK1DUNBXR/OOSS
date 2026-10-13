/**
 * Money-out requests (payments:approve; domains/payouts.ts). A request is made by posting
 * a vendor bill payment or a cash-out (books routes); these routes list, approve, decline
 * and withdraw them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler } from '../lib/http.js';
import { approvePayout, declinePayout, listPayoutRequests, withdrawPayout } from '../domains/payouts.js';

const router = Router();

router.get(
  '/',
  handler(async (req) => {
    const query = z
      .object({ state: z.enum(['requested', 'approved', 'declined', 'withdrawn']).optional() })
      .parse(req.query);
    return { items: await listPayoutRequests(query) };
  }),
);

router.post(
  '/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().nullish() }).parse(req.body ?? {});
    return approvePayout(req.params.id, body.note ?? null);
  }),
);

router.post(
  '/:id/decline',
  handler(async (req) => {
    const body = z.object({ note: z.string() }).parse(req.body);
    return declinePayout(req.params.id, body.note);
  }),
);

router.post(
  '/:id/withdraw',
  handler(async (req) => withdrawPayout(req.params.id)),
);

export default router;
