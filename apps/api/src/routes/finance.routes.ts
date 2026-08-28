import { Router } from 'express';
import { z } from 'zod';
import { handler, str, numeric } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, canSeeMoney } from '../platform/permissions.js';
import {
  issueInvoice,
  recordPayment,
  allocatePayment,
  issueCreditNote,
  issueFeeInstalments,
  invoiceSummary,
  rehydrateReceivables,
} from '../domains/finance.js';

const router = Router();

router.get(
  '/invoices',
  handler(async (req) => {
    await assertCan({ resource: 'invoices', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('invoices');

    const rows = await prisma.invoice.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
        ...(str(req.query.accountId) ? { OR: [{ accountId: str(req.query.accountId) }, { organizationId: str(req.query.accountId) }] } : {}),
      },
      include: { lines: true, receipts: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const orgIds = [...new Set(rows.map((r) => r.organizationId ?? r.accountId).filter(Boolean) as string[])];
    const orgs = orgIds.length ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [];
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    const offeringIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.offeringId)).filter(Boolean) as string[])];
    const offerings = offeringIds.length ? await prisma.offering.findMany({ where: { id: { in: offeringIds } }, select: { id: true, name: true } }) : [];
    const offeringMap = new Map(offerings.map((o) => [o.id, o.name]));

    return rows.map((inv) => {
      const total = inv.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
      const allocated = inv.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
      const daysOverdue = inv.dueDate && inv.dueDate < new Date() && allocated < total
        ? Math.floor((Date.now() - inv.dueDate.getTime()) / 86_400_000)
        : null;

      return {
        id: inv.id,
        recordCode: inv.recordCode,
        accountId: inv.accountId ?? inv.organizationId,
        accountName: inv.organizationId ? (orgMap.get(inv.organizationId) ?? null) : null,
        contractId: inv.contractId,
        status: inv.status,
        currency: inv.currency,
        issuedDate: inv.issuedDate?.toISOString() ?? null,
        dueDate: inv.dueDate?.toISOString() ?? null,
        total: money ? total : null,
        allocated: money ? allocated : null,
        outstanding: money ? total - allocated : null,
        daysOverdue,
        lines: inv.lines.map((l) => ({
          id: l.id,
          offeringName: l.offeringId ? (offeringMap.get(l.offeringId) ?? null) : null,
          description: l.description,
          amount: money ? num(l.amount) : null,
          // Derived from the offering's default treatment — never asked of sales.
          revenueMethod: l.revenueMethod,
        })),
      };
    });
  }),
);

router.get('/invoices/:id', handler(async (req) => invoiceSummary(req.params.id)));

router.post(
  '/invoices',
  handler(async (req, res) => {
    const schema = z.object({
      accountId: z.string().nullish(),
      organizationId: z.string().nullish(),
      contractId: z.string().nullish(),
      opportunityId: z.string().nullish(),
      currency: z.string().length(3).optional(),
      dueInDays: z.number().int().optional(),
      lines: z
        .array(z.object({ offeringId: z.string().nullish(), description: z.string(), quantity: z.number().int().optional(), amount: z.number().positive() }))
        .min(1),
    });
    const invoice = await issueInvoice(schema.parse(req.body));
    res.status(201).json(invoice);
    return undefined;
  }),
);

router.post(
  '/invoices/:id/credit-note',
  handler(async (req) => {
    const schema = z.object({ amount: z.number().positive(), reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return issueCreditNote(req.params.id, input.amount, input.reason);
  }),
);

router.get(
  '/payments',
  handler(async (req) => {
    await assertCan({ resource: 'payments', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('payments');

    const rows = await prisma.payment.findMany({
      where: { tenantId: auth.tenantId, ...(str(req.query.status) ? { status: str(req.query.status) } : {}) },
      include: { receipts: true },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });

    return rows.map((p) => {
      const allocated = p.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
      const amount = num(p.amount) ?? 0;
      return {
        id: p.id,
        recordCode: p.recordCode,
        amount: money ? amount : null,
        currency: p.currency,
        gatewayReference: p.gatewayReference,
        receivedAt: p.receivedAt.toISOString(),
        status: p.status,
        method: p.method,
        allocated: money ? allocated : null,
        // A payment may exist before its resolving obligation is even issued —
        // an explicitly representable unallocated state.
        unallocated: money ? amount - allocated : null,
        receipts: p.receipts.map((r) => ({
          id: r.id,
          invoiceId: r.invoiceId,
          feeInstalmentId: r.feeInstalmentId,
          allocatedAmount: money ? num(r.allocatedAmount) : null,
          allocatedAt: r.allocatedAt.toISOString(),
        })),
        // bankAccountReference is regulated: structurally excluded from this
        // projection entirely, not merely nulled.
      };
    });
  }),
);

router.post(
  '/payments',
  handler(async (req, res) => {
    const schema = z.object({
      amount: z.number().positive(),
      currency: z.string().length(3).optional(),
      gatewayReference: z.string().min(1),
      receivedAt: z.string().optional(),
      method: z.string().optional(),
      payerOrganizationId: z.string().nullish(),
      note: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const payment = await recordPayment({
      ...input,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
    });
    res.status(201).json(payment);
    return undefined;
  }),
);

router.post(
  '/payments/:id/allocate',
  handler(async (req) => {
    const schema = z.object({
      invoiceId: z.string().nullish(),
      feeInstalmentId: z.string().nullish(),
      amount: z.number().positive(),
    });
    const input = schema.parse(req.body);
    return allocatePayment({ paymentId: req.params.id, ...input });
  }),
);

router.get(
  '/receivables',
  handler(async (req) => {
    await assertCan({ resource: 'receivables', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('receivables');

    const rows = await prisma.receivablesProjection.findMany({
      where: { tenantId: auth.tenantId, ...(str(req.query.dunningStage) ? { dunningStage: str(req.query.dunningStage) } : {}) },
      orderBy: { amountOutstanding: 'desc' },
      take: 200,
    });

    return rows.map((r) => ({
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectLabel: r.subjectLabel ?? r.subjectId,
      amountOutstanding: money ? num(r.amountOutstanding) : null,
      nextDueDate: r.nextDueDate?.toISOString() ?? null,
      dunningStage: r.dunningStage,
      currency: r.currency,
      // Explicitly non-authoritative: safe to rebuild or discard at any time.
      hydratedAt: r.hydratedAt.toISOString(),
    }));
  }),
);

router.post(
  '/receivables/rehydrate',
  handler(async (req) => {
    const schema = z.object({ subjectId: z.string(), subjectType: z.enum(['account', 'opportunity']) });
    const input = schema.parse(req.body);
    return rehydrateReceivables(input.subjectId, input.subjectType);
  }),
);

router.get(
  '/fee-instalments',
  handler(async (req) => {
    await assertCan({ resource: 'payments', verb: 'view' });
    const auth = currentAuth();
    return prisma.feeInstalment.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.enrollmentId) ? { enrollmentId: str(req.query.enrollmentId) } : {}),
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
      },
      include: { receipts: true },
      orderBy: { dueDate: 'asc' },
      take: numeric(req.query.limit) ?? 100,
    });
  }),
);

router.post(
  '/fee-instalments',
  handler(async (req, res) => {
    const schema = z.object({
      enrollmentId: z.string(),
      currency: z.string().length(3).optional(),
      plan: z.array(z.object({ amount: z.number().positive(), dueDate: z.string() })).min(1),
    });
    const input = schema.parse(req.body);
    const created = await issueFeeInstalments(
      input.enrollmentId,
      input.plan.map((p) => ({ amount: p.amount, dueDate: new Date(p.dueDate) })),
      input.currency ?? 'INR',
    );
    res.status(201).json(created);
    return undefined;
  }),
);

export default router;
