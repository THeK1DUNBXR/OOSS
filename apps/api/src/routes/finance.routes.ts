import { Router } from 'express';
import { z } from 'zod';
import { DIVISIONS, PAYMENT_MODES, type Division, type PaymentMode } from '@kaizen/shared';
import { handler, str, numeric, bool } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, canSeeMoney, visibilityWhere } from '../platform/permissions.js';
import {
  recordPayment,
  allocatePayment,
  issueCreditNote,
  issueFeeInstalments,
  rehydrateReceivables,
} from '../domains/finance.js';
import {
  createInvoice,
  updateInvoice,
  issueInvoiceDraft,
  voidInvoice,
  collectInvoicePayment,
  declarePaymentTerms,
  invoiceDocument,
  invoiceSummary,
  totalsOf,
} from '../domains/invoicing.js';
import {
  listReceipts,
  receiptDocument,
  raiseFinalInvoice,
  listFinalInvoices,
  finalInvoiceDocument,
} from '../domains/receipts.js';

const router = Router();

const divisionEnum = z.enum(DIVISIONS as unknown as [Division, ...Division[]]);
const paymentModeEnum = z.enum(PAYMENT_MODES as unknown as [PaymentMode, ...PaymentMode[]]);

/**
 * A line as the client sends it.
 *
 * `unitPrice` is optional because a line naming a course takes its price from
 * the course — which is what lets somebody at a counter raise a correct invoice
 * by choosing what was sold rather than by knowing the price list.
 */
const lineSchema = z.object({
  offeringId: z.string().nullish(),
  courseId: z.string().nullish(),
  /** The student's place on the course — what is actually being billed. */
  enrollmentId: z.string().nullish(),
  description: z.string().nullish(),
  quantity: z.number().int().positive().optional(),
  unitPrice: z.number().nonnegative().nullish(),
  /** Give one, never both — the other is derived from it. */
  discountAmount: z.number().nonnegative().nullish(),
  discountPercent: z.number().min(0).max(100).nullish(),
  gstRate: z.number().min(0).max(100).nullish(),
  hsnSac: z.string().nullish(),
});

const collectedPaymentSchema = z.object({
  amount: z.number().positive(),
  mode: paymentModeEnum,
  reference: z.string().nullish(),
  receivedAt: z.string().nullish(),
  note: z.string().nullish(),
});

function collected(input: z.infer<typeof collectedPaymentSchema> | null | undefined) {
  if (!input) return null;
  return {
    amount: input.amount,
    mode: input.mode,
    reference: input.reference ?? null,
    receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
    note: input.note ?? null,
  };
}

router.get(
  '/invoices',
  handler(async (req) => {
    await assertCan({ resource: 'invoices', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('invoices');
    // The WHERE axis on the query itself. An employee holds `invoices:V@own`,
    // and without this the narrowing would exist on paper and the list would
    // return the company's invoices to anybody holding the resource at all.
    const scope = await visibilityWhere('invoices', 'createdById');

    const rows = await prisma.invoice.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...scope,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
        ...(str(req.query.accountId)
          ? { OR: [{ accountId: str(req.query.accountId) }, { organizationId: str(req.query.accountId) }] }
          : {}),
        ...(str(req.query.personId) ? { personId: str(req.query.personId) } : {}),
        ...(bool(req.query.openOnly) ? { status: { in: ['issued', 'part_paid', 'overdue'] } } : {}),
      },
      include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
      orderBy: { createdAt: 'desc' },
      take: numeric(req.query.limit) ?? 200,
    });

    const orgIds = [...new Set(rows.map((r) => r.organizationId ?? r.accountId).filter(Boolean) as string[])];
    const orgs = orgIds.length
      ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    const personIds = [...new Set(rows.map((r) => r.personId).filter(Boolean) as string[])];
    const people = personIds.length
      ? await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } })
      : [];
    const personMap = new Map(people.map((p) => [p.id, p.fullName]));

    const offeringIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.offeringId)).filter(Boolean) as string[])];
    const offerings = offeringIds.length
      ? await prisma.offering.findMany({ where: { id: { in: offeringIds } }, select: { id: true, name: true } })
      : [];
    const offeringMap = new Map(offerings.map((o) => [o.id, o.name]));

    const courseIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.courseId)).filter(Boolean) as string[])];
    const courses = courseIds.length
      ? await prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, name: true } })
      : [];
    const courseMap = new Map(courses.map((c) => [c.id, c.name]));

    return rows.map((inv) => {
      const totals = totalsOf(inv);
      const daysOverdue =
        inv.dueDate && inv.dueDate < new Date() && totals.outstanding > 0
          ? Math.floor((Date.now() - inv.dueDate.getTime()) / 86_400_000)
          : null;

      return {
        id: inv.id,
        recordCode: inv.recordCode,
        draftReference: inv.draftReference,
        /** The number where there is one, the draft reference where there is not. */
        label: inv.recordCode ?? inv.draftReference ?? inv.id,
        accountId: inv.accountId ?? inv.organizationId,
        accountName: inv.organizationId ? (orgMap.get(inv.organizationId) ?? null) : null,
        personId: inv.personId,
        personName: inv.personId ? (personMap.get(inv.personId) ?? null) : null,
        customerName:
          (inv.organizationId ? orgMap.get(inv.organizationId) : null) ??
          (inv.personId ? personMap.get(inv.personId) : null) ??
          null,
        contractId: inv.contractId,
        status: inv.status,
        currency: inv.currency,
        issuedDate: inv.issuedDate?.toISOString() ?? null,
        dueDate: inv.dueDate?.toISOString() ?? null,
        total: money ? totals.payable : null,
        taxableValue: money ? (num(inv.taxableValue) ?? 0) : null,
        taxAmount: money
          ? (num(inv.cgstAmount) ?? 0) + (num(inv.sgstAmount) ?? 0) + (num(inv.igstAmount) ?? 0)
          : null,
        allocated: money ? totals.allocated : null,
        outstanding: money ? totals.outstanding : null,
        daysOverdue,
        // What the document says about payment, which is a different fact from
        // `status`: the status follows the receipts, and this is the declaration
        // the customer was handed.
        paymentType: inv.paymentType,
        amountPayableNow: money ? (num(inv.amountPayableNow) ?? 0) : null,
        paymentMode: inv.paymentMode,
        paymentReference: inv.paymentReference,
        interState: inv.interState,
        placeOfSupply: inv.placeOfSupply,
        customerGstin: inv.customerGstin,
        division: inv.division,
        editable: inv.status === 'draft',
        gstFilingId: inv.gstFilingId,
        lines: inv.lines.map((l) => ({
          id: l.id,
          offeringName: l.offeringId ? (offeringMap.get(l.offeringId) ?? null) : null,
          courseId: l.courseId,
          courseName: l.courseId ? (courseMap.get(l.courseId) ?? null) : null,
          enrollmentId: l.enrollmentId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: money ? num(l.unitPrice) : null,
          amount: money ? num(l.amount) : null,
          discountAmount: money ? num(l.discountAmount) : null,
          discountPercent: money ? num(l.discountPercent) : null,
          gstRate: num(l.gstRate),
          taxAmount: money ? num(l.taxAmount) : null,
          hsnSac: l.hsnSac,
          // Derived from the offering's default treatment — never asked of sales.
          revenueMethod: l.revenueMethod,
        })),
      };
    });
  }),
);

router.get('/invoices/:id', handler(async (req) => invoiceSummary(req.params.id)));

/**
 * The invoice as a document.
 *
 * Everything a printed tax invoice needs, resolved on the server: the supplier,
 * the customer, the lines with their own tax, both totals, the mode of payment
 * and the amount in words. The client renders and computes nothing, because a
 * screen that recomputes a total is a screen that can disagree with the copy the
 * customer is holding.
 */
router.get('/invoices/:id/document', handler(async (req) => invoiceDocument(req.params.id)));

const invoiceBodySchema = z.object({
  accountId: z.string().nullish(),
  organizationId: z.string().nullish(),
  personId: z.string().nullish(),
  contractId: z.string().nullish(),
  opportunityId: z.string().nullish(),
  currency: z.string().length(3).optional(),
  issuedDate: z.string().nullish(),
  dueDate: z.string().nullish(),
  dueInDays: z.number().int().positive().optional(),
  placeOfSupply: z.string().nullish(),
  customerGstin: z.string().nullish(),
  interState: z.boolean().nullish(),
  division: divisionEnum.nullish(),
  notes: z.string().nullish(),
  lines: z.array(lineSchema).min(1),
  /** False leaves it a draft, which is the only editable state. */
  issue: z.boolean().optional(),
  /** Money taken across the counter as the invoice is handed over. */
  payment: collectedPaymentSchema.nullish(),
});

router.post(
  '/invoices',
  handler(async (req, res) => {
    const body = invoiceBodySchema.parse(req.body);
    const invoice = await createInvoice({
      ...body,
      issuedDate: body.issuedDate ? new Date(body.issuedDate) : undefined,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      payment: collected(body.payment),
    });
    res.status(201).json(invoice);
    return undefined;
  }),
);

/**
 * Rewrites a draft.
 *
 * Whole-lines replacement, repriced in one transaction: an invoice's tax is a
 * property of the set of lines, so a half-applied edit would leave a document
 * whose tax belongs to neither version. Refused once the invoice is issued —
 * the correction to a document the customer holds is a credit note.
 */
router.patch(
  '/invoices/:id',
  handler(async (req) => {
    const body = invoiceBodySchema.partial({ lines: true }).parse(req.body);
    return updateInvoice(req.params.id, {
      ...body,
      lines: body.lines,
      issuedDate: body.issuedDate ? new Date(body.issuedDate) : undefined,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
    });
  }),
);

router.post(
  '/invoices/:id/issue',
  handler(async (req) => {
    const body = z
      .object({ issuedDate: z.string().nullish(), payment: collectedPaymentSchema.nullish() })
      .parse(req.body ?? {});
    return issueInvoiceDraft(req.params.id, {
      issuedDate: body.issuedDate ? new Date(body.issuedDate) : undefined,
      payment: collected(body.payment),
    });
  }),
);

/**
 * Takes money against an invoice and issues the receipt for it.
 *
 * One call because at a counter it is one act: the payment, the allocation, and
 * the document the customer walks away with. It does not touch the tax invoice
 * beyond its status — an issued invoice is final, and an instalment is a receipt
 * rather than an amendment to a document somebody is already holding.
 */
router.post(
  '/invoices/:id/collect',
  handler(async (req) => {
    const body = collectedPaymentSchema.parse(req.body);
    return collectInvoicePayment(req.params.id, collected(body)!);
  }),
);

// ---------------------------------------------------------------------------
// Receipts — where the part payments are
// ---------------------------------------------------------------------------

router.get(
  '/receipts',
  handler(async (req) =>
    listReceipts({ invoiceId: str(req.query.invoiceId), limit: numeric(req.query.limit) }),
  ),
);

/**
 * A receipt as a document: its own number and time, the invoice it is against,
 * the amount, the mode, and the balance left after it.
 */
router.get('/receipts/:id/document', handler(async (req) => receiptDocument(req.params.id)));

// ---------------------------------------------------------------------------
// The final invoice
// ---------------------------------------------------------------------------
//
// Raised once the instalments against a tax invoice are done. It names every
// receipt it consolidates, the total payable and what is left — the question
// neither the invoice nor any single receipt can answer on its own.

router.get(
  '/final-invoices',
  handler(async (req) =>
    listFinalInvoices({ invoiceId: str(req.query.invoiceId), limit: numeric(req.query.limit) }),
  ),
);

router.get('/final-invoices/:id/document', handler(async (req) => finalInvoiceDocument(req.params.id)));

router.post(
  '/invoices/:id/final-invoice',
  handler(async (req, res) => {
    const body = z.object({ note: z.string().nullish() }).parse(req.body ?? {});
    const final = await raiseFinalInvoice(req.params.id, { note: body.note ?? null });
    res.status(201).json(final);
    return undefined;
  }),
);

/**
 * States what is being paid now without money having moved yet — the counter
 * case where half is paid today and the rest is promised for next week.
 */
router.post(
  '/invoices/:id/payment-terms',
  handler(async (req) => {
    const body = z
      .object({
        amountPayableNow: z.number().nonnegative(),
        paymentMode: paymentModeEnum.nullish(),
        paymentReference: z.string().nullish(),
      })
      .parse(req.body);
    return declarePaymentTerms(req.params.id, body);
  }),
);

router.post(
  '/invoices/:id/void',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return voidInvoice(req.params.id, body.reason);
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

    // `recordedById` is who took the money, and the owner field the WHERE axis
    // reads: an employee holding `payments:V@own` sees their own collections
    // rather than the company's.
    const scope = await visibilityWhere('payments', 'recordedById');

    const rows = await prisma.payment.findMany({
      where: {
        tenantId: auth.tenantId,
        ...scope,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
      },
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
        recordedById: p.recordedById,
        allocated: money ? allocated : null,
        // A payment may exist before its resolving obligation is even issued —
        // an explicitly representable unallocated state.
        unallocated: money ? amount - allocated : null,
        receipts: p.receipts.map((r) => ({
          id: r.id,
          recordCode: r.recordCode,
          invoiceId: r.invoiceId,
          feeInstalmentId: r.feeInstalmentId,
          allocatedAmount: money ? num(r.allocatedAmount) : null,
          allocatedAt: r.allocatedAt.toISOString(),
          balanceAfter: money ? num(r.balanceAfter) : null,
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
      method: paymentModeEnum.optional(),
      payerOrganizationId: z.string().nullish(),
      payerPersonId: z.string().nullish(),
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
