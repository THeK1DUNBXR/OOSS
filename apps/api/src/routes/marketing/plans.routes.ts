import { Router } from 'express';
import { z } from 'zod';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import { createPlan, listPlans, updatePlan, approvePlan, closePlan, calendar } from '../../domains/marketing/plans.js';

const router = Router();

const PlanInputSchema = z.object({
  period: z.string().min(1),
  division: z.string().min(1),
  theme: z.string().nullish(),
  goals: z.record(z.unknown()).optional(),
  campaignIds: z.array(z.string()).optional(),
});

router.get(
  '/plans',
  handler(async (req) => {
    const items = await listPlans({ period: str(req.query.period), division: str(req.query.division) });
    return { items, total: items.length };
  }),
);

router.post(
  '/plans',
  handler(async (req, res) => {
    const input = PlanInputSchema.parse(req.body);
    const plan = await createPlan(input as never);
    res.status(201).json(plan);
    return undefined;
  }),
);

router.patch(
  '/plans/:id',
  handler(async (req) => {
    const input = PlanInputSchema.partial().parse(req.body);
    return updatePlan(req.params.id, input as never);
  }),
);

router.post('/plans/:id/approve', handler(async (req) => approvePlan(req.params.id)));
router.post('/plans/:id/close', handler(async (req) => closePlan(req.params.id)));

router.get(
  '/calendar',
  handler(async (req) => {
    const from = date(req.query.from);
    const to = date(req.query.to);
    if (!from || !to) throw ApiError.badRequest('from and to are required.');
    return calendar(from, to);
  }),
);

export default router;
