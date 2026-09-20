import { Router } from 'express';
import { z } from 'zod';
import { CHANNEL_KEYS } from '@kaizen/shared';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  createBudget,
  updateBudget,
  listBudgets,
  approveBudget,
  recordSpend,
  listSpend,
  reconcileSpend,
  budgetVariance,
  createVendor,
  updateVendor,
  listVendors,
} from '../../domains/marketing/budget.js';

const router = Router();

const BudgetInputSchema = z.object({
  period: z.string().min(1),
  division: z.string().min(1),
  channelKey: z.enum(CHANNEL_KEYS).nullish(),
  campaignId: z.string().nullish(),
  planned: z.number().nonnegative(),
  note: z.string().nullish(),
});

const SpendInputSchema = z.object({
  campaignId: z.string().nullish(),
  channelKey: z.enum(CHANNEL_KEYS),
  division: z.string().min(1),
  amount: z.number().positive(),
  spendDate: z.coerce.date(),
  vendorOrganizationId: z.string().nullish(),
  description: z.string().min(1),
  transactionId: z.string().nullish(),
  vendorBillId: z.string().nullish(),
});

const VendorInputSchema = z.object({
  organizationId: z.string().min(1),
  services: z.array(z.string()).optional(),
  contractRef: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

router.get(
  '/budgets',
  handler(async (req) => {
    const items = await listBudgets({ period: str(req.query.period), division: str(req.query.division) });
    return { items, total: items.length };
  }),
);

router.post(
  '/budgets',
  handler(async (req, res) => {
    const input = BudgetInputSchema.parse(req.body);
    const budget = await createBudget(input as never);
    res.status(201).json(budget);
    return undefined;
  }),
);

router.patch(
  '/budgets/:id',
  handler(async (req) => {
    const input = BudgetInputSchema.partial().parse(req.body);
    return updateBudget(req.params.id, input as never);
  }),
);

router.post('/budgets/:id/approve', handler(async (req) => approveBudget(req.params.id)));

router.get(
  '/budgets/variance',
  handler(async (req) => budgetVariance({ period: str(req.query.period), division: str(req.query.division) })),
);

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

router.get(
  '/spends',
  handler(async (req) => {
    const items = await listSpend({ campaignId: str(req.query.campaignId), from: date(req.query.from), to: date(req.query.to) });
    return { items, total: items.length };
  }),
);

router.post(
  '/spends',
  handler(async (req, res) => {
    const input = SpendInputSchema.parse(req.body);
    const spend = await recordSpend(input as never);
    res.status(201).json(spend);
    return undefined;
  }),
);

router.post(
  '/spends/:id/reconcile',
  handler(async (req) => {
    const schema = z.object({ transactionId: z.string().optional(), vendorBillId: z.string().optional() });
    const input = schema.parse(req.body ?? {});
    if (!input.transactionId && !input.vendorBillId) throw ApiError.badRequest('transactionId or vendorBillId is required.');
    return reconcileSpend(req.params.id, input);
  }),
);

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

router.get('/vendors', handler(async () => {
  const items = await listVendors();
  return { items, total: items.length };
}));

router.post(
  '/vendors',
  handler(async (req, res) => {
    const input = VendorInputSchema.parse(req.body);
    const vendor = await createVendor(input as never);
    res.status(201).json(vendor);
    return undefined;
  }),
);

router.patch(
  '/vendors/:id',
  handler(async (req) => {
    const schema = VendorInputSchema.partial().extend({ active: z.boolean().optional() });
    const input = schema.parse(req.body);
    return updateVendor(req.params.id, input as never);
  }),
);

export default router;
