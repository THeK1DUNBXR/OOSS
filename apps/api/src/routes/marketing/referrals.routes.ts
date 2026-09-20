/**
 * Referral & affiliate programs. Mounted at `/api/marketing` (this router
 * owns both `/referral-programs` and `/referrals`).
 */

import { Router } from 'express';
import { z } from 'zod';
import { REFERRAL_PROGRAM_KINDS, REWARD_KINDS } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import {
  createReferralProgram,
  listReferralPrograms,
  loadReferralProgram,
  updateReferralProgram,
  activateReferralProgram,
  deactivateReferralProgram,
  issueReferral,
  redeemReferral,
  listReferrals,
  qualifyReferral,
  rewardReferral,
  voidReferral,
  leaderboard,
} from '../../domains/marketing/referrals.js';

const router = Router();

const ProgramInputSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(REFERRAL_PROGRAM_KINDS),
  rewardKind: z.enum(REWARD_KINDS).optional(),
  rewardAmount: z.number().nonnegative().nullish(),
  terms: z.string().nullish(),
});

router.get('/referral-programs', handler(async (req) => listReferralPrograms({ active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined })));
router.get('/referral-programs/:id', handler(async (req) => loadReferralProgram(req.params.id)));

router.post(
  '/referral-programs',
  handler(async (req, res) => {
    const input = ProgramInputSchema.parse(req.body);
    const program = await createReferralProgram(input);
    res.status(201).json(program);
    return undefined;
  }),
);

router.patch(
  '/referral-programs/:id',
  handler(async (req) => updateReferralProgram(req.params.id, ProgramInputSchema.partial().parse(req.body))),
);

router.post('/referral-programs/:id/activate', handler(async (req) => activateReferralProgram(req.params.id)));
router.post('/referral-programs/:id/deactivate', handler(async (req) => deactivateReferralProgram(req.params.id)));

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

router.get(
  '/referrals',
  handler(async (req) => listReferrals({ programId: str(req.query.programId), status: str(req.query.status) })),
);

router.post(
  '/referrals/issue',
  handler(async (req, res) => {
    const schema = z.object({
      programId: z.string(),
      referrerPersonId: z.string().nullish(),
      referrerOrganizationId: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const referral = await issueReferral(input);
    res.status(201).json(referral);
    return undefined;
  }),
);

router.post(
  '/referrals/redeem',
  handler(async (req) => {
    const schema = z.object({
      code: z.string(),
      referredPersonId: z.string().optional(),
      person: z
        .object({
          fullName: z.string(),
          primaryPhone: z.string().nullish(),
          primaryEmail: z.string().nullish(),
        })
        .optional(),
    });
    const input = schema.parse(req.body);
    return redeemReferral(input);
  }),
);

router.post('/referrals/:id/qualify', handler(async (req) => qualifyReferral(req.params.id)));

router.post(
  '/referrals/:id/reward',
  handler(async (req) => {
    const schema = z.object({ rewardTransactionRef: z.string().optional() });
    const input = schema.parse(req.body ?? {});
    return rewardReferral(req.params.id, input.rewardTransactionRef);
  }),
);

router.post(
  '/referrals/:id/void',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return voidReferral(req.params.id, input.reason);
  }),
);

router.get(
  '/referrals/leaderboard',
  handler(async (req) => leaderboard(str(req.query.programId) ?? '')),
);

export default router;
