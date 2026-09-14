/**
 * ESOP routes. Thin zod → domain, mounted at `/esop` under `requireAuth` in
 * `routes/index.ts`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../lib/http.js';
import {
  createPlan, activatePlan, listPlans, plan,
  proposeGrant, approveGrant, cancelGrant, lapseGrant, listGrants, grant,
  requestExercise, approveExercise, rejectExercise, listExercises,
  sh6Register, sh6Export, myGrants,
} from '../domains/esop.js';

const router = Router();

const vestingSchedule = z.object({
  cliffMonths: z.number().int().nonnegative(),
  totalMonths: z.number().int().positive(),
  frequency: z.enum(['monthly', 'quarterly', 'annual']),
});

// ---- Plans ------------------------------------------------------------------

router.get('/plans', handler(async () => ({ items: await listPlans() })));
router.get('/plans/:id', handler(async (req) => plan(req.params.id)));

router.post(
  '/plans',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        poolShareClassId: z.string(),
        targetShareClassId: z.string(),
        exercisePriceDefault: z.number().nonnegative().nullish(),
        vestingDefault: vestingSchedule,
        exerciseWindowMonthsAfterExit: z.number().int().positive().optional(),
      })
      .parse(req.body);
    return createPlan(body);
  }),
);

router.post(
  '/plans/:id/activate',
  handler(async (req) => {
    const body = z
      .object({ approvedOn: z.string(), resolutionRef: z.string().min(1), mgt14Srn: z.string().nullish() })
      .parse(req.body);
    return activatePlan(req.params.id, body);
  }),
);

// ---- Grants -------------------------------------------------------------------

router.get('/grants', handler(async () => ({ items: await listGrants() })));
router.get('/grants/:id', handler(async (req) => grant(req.params.id)));

router.post(
  '/grants',
  handler(async (req) => {
    const body = z
      .object({
        planId: z.string(),
        employmentId: z.string(),
        grantedOn: z.string(),
        count: z.number().positive(),
        exercisePrice: z.number().nonnegative().nullish(),
        vestingOverride: vestingSchedule.nullish(),
        grantLetterRef: z.string().nullish(),
        resolutionRef: z.string().nullish(),
      })
      .parse(req.body);
    return proposeGrant(body);
  }),
);

router.post('/grants/:id/approve', handler(async (req) => approveGrant(req.params.id)));

router.post(
  '/grants/:id/cancel',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return cancelGrant(req.params.id, body.reason);
  }),
);

router.post(
  '/grants/:id/lapse',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return lapseGrant(req.params.id, body.reason);
  }),
);

// ---- Exercises ------------------------------------------------------------------

router.get('/exercises', handler(async (req) => ({ items: await listExercises(str(req.query.grantId)) })));

router.post(
  '/exercises',
  handler(async (req) => {
    const body = z.object({ grantId: z.string(), count: z.number().positive(), requestedOn: z.string().optional() }).parse(req.body);
    return requestExercise(body);
  }),
);

router.post('/exercises/:id/approve', handler(async (req) => approveExercise(req.params.id)));

router.post(
  '/exercises/:id/reject',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return rejectExercise(req.params.id, body.reason);
  }),
);

// ---- Register & self-view -----------------------------------------------------

router.get('/register', handler(async () => ({ items: await sh6Register() })));

router.get(
  '/register/sh-6.xlsx',
  handler(async (_req, res) => {
    const file = await sh6Export();
    res
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="sh-6-register.xlsx"',
        'content-length': String(file.length),
        'cache-control': 'no-store',
      })
      .send(file);
    return undefined;
  }),
);

router.get('/me', handler(async () => ({ items: await myGrants() })));

export default router;
