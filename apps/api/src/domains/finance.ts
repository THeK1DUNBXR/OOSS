/**
 * Finance — the money model, split for the first time into three distinct facts
 * the legacy single collection conflated:
 *
 *   obligation   → INVOICE / INVOICE_LINE (commercial) and FEE_INSTALMENT (education)
 *   movement     → PAYMENT, append-only, gateway-authoritative
 *   allocation   → RECEIPT, the many-to-many join
 *
 * Only the sum of a subject's RECEIPT.allocatedAmount rows determines what has
 * actually been paid against it. This is what finally makes partial payments
 * and credit notes representable.
 *
 * CREDIT_NOTE is the only permitted correction to an issued invoice line — an
 * obligation-reducing fact, kept structurally distinct from a payment-side
 * reversal so the two are never re-conflated the way a `refunded` status did.
 *
 * Money flows CRM → Finance via one event, and Finance → CRM via a read-only
 * projection. This edge is engineered to be acyclic by design.
 */

import { EVENTS, type RevenueTreatment } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';

// ---------------------------------------------------------------------------
// Obligation
// ---------------------------------------------------------------------------

export interface InvoiceLineInput {
  offeringId?: string | null;
  description: string;
  quantity?: number;
  amount: number;
}

/**
 * Created from a signed contract's billing terms. Finance derives the revenue
 * recognition method from OFFERING.defaultRevenueTreatment — never by asking
 * sales case by case.
 */
export async function issueInvoice(input: {
  accountId?: string | null;
  organizationId?: string | null;
  contractId?: string | null;
  opportunityId?: string | null;
  currency?: string;
  dueInDays?: number;
  lines: InvoiceLineInput[];
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'create' });
  if (input.lines.length === 0) throw ApiError.badRequest('An invoice requires at least one line.');

  const recordCode = await nextRecordCode('INV');
  const issuedDate = new Date();
  const dueDate = new Date(issuedDate.getTime() + (input.dueInDays ?? 30) * 86_400_000);

  const invoice = await prisma.invoice.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      accountId: input.accountId ?? null,
      organizationId: input.organizationId ?? null,
      contractId: input.contractId ?? null,
      opportunityId: input.opportunityId ?? null,
      status: 'issued',
      currency: input.currency ?? 'INR',
      issuedDate,
      dueDate,
      createdById: auth.partyId,
    },
  });

  for (const line of input.lines) {
    const revenueMethod = await revenueMethodFor(line.offeringId ?? null);
    await prisma.invoiceLine.create({
      data: {
        tenantId: auth.tenantId,
        invoiceId: invoice.id,
        offeringId: line.offeringId ?? null,
        description: line.description,
        quantity: line.quantity ?? 1,
        amount: line.amount,
        revenueMethod,
      },
    });
  }

  await auditWrite({ action: 'create', subjectType: 'invoice', subjectId: invoice.id, after: { recordCode } });
  await emit({
    name: EVENTS.INVOICE_ISSUED,
    subject: { entityType: 'invoice', entityId: invoice.id, recordCode },
    related: input.contractId ? [{ relation: 'bills', entityType: 'contract', entityId: input.contractId }] : [],
    newState: { total: input.lines.reduce((s, l) => s + l.amount, 0), dueDate },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  await rehydrateReceivables(input.accountId ?? input.organizationId ?? null, 'account');
  return invoice;
}

async function revenueMethodFor(offeringId: string | null): Promise<RevenueTreatment> {
  if (!offeringId) return 'point_in_time';
  const offering = await prisma.offering.findFirst({
    where: { id: offeringId },
    select: { defaultRevenueTreatment: true },
  });
  return (offering?.defaultRevenueTreatment as RevenueTreatment) ?? 'point_in_time';
}

/** The parallel obligation entity for the education motion — a sibling, not a variant. */
export async function issueFeeInstalments(
  enrollmentId: string,
  plan: Array<{ amount: number; dueDate: Date }>,
  currency = 'INR',
) {
  const auth = currentAuth();
  const created: Array<Awaited<ReturnType<typeof prisma.feeInstalment.create>>> = [];
  for (const item of plan) {
    const recordCode = await nextRecordCode('FEE');
    const instalment = await prisma.feeInstalment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        enrollmentId,
        amount: item.amount,
        currency,
        dueDate: item.dueDate,
        status: 'issued',
      },
    });
    created.push(instalment);
    await emit({
      name: EVENTS.FEE_INSTALMENT_ISSUED,
      subject: { entityType: 'fee_instalment', entityId: instalment.id, recordCode },
      related: [{ relation: 'bills', entityType: 'enrollment', entityId: enrollmentId }],
      newState: { amount: item.amount, dueDate: item.dueDate },
      impact: { domains: ['fin', 'edu'] },
      confidentiality: 'confidential',
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Movement — append-only, idempotent on gatewayReference
// ---------------------------------------------------------------------------

export async function recordPayment(input: {
  amount: number;
  currency?: string;
  gatewayReference: string;
  receivedAt?: Date;
  method?: string;
  payerOrganizationId?: string | null;
  payerPersonId?: string | null;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payments', verb: 'create' });

  // Idempotent on the gateway reference: a replayed webhook is a no-op.
  const existing = await prisma.payment.findFirst({
    where: { tenantId: auth.tenantId, gatewayReference: input.gatewayReference },
  });
  if (existing) return existing;

  const recordCode = await nextRecordCode('PAY');
  const payment = await prisma.payment.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      amount: input.amount,
      currency: input.currency ?? 'INR',
      gatewayReference: input.gatewayReference,
      receivedAt: input.receivedAt ?? new Date(),
      status: 'received',
      method: input.method ?? 'bank_transfer',
      payerOrganizationId: input.payerOrganizationId ?? null,
      payerPersonId: input.payerPersonId ?? null,
      note: input.note ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'payment', subjectId: payment.id, after: { recordCode, amount: input.amount } });
  await emit({
    name: EVENTS.PAYMENT_RECEIVED,
    subject: { entityType: 'payment', entityId: payment.id, recordCode },
    newState: { amount: input.amount, currency: payment.currency },
    impact: {
      domains: ['fin'],
      materiality: { measure: 'payment_amount', value: input.amount, currency: payment.currency },
    },
    confidentiality: 'confidential',
  });

  return payment;
}

/** A correction is a NEW row, never an update in place. */
export async function reversePayment(paymentId: string, reason: string) {
  const auth = currentAuth();
  const original = await prisma.payment.findFirst({ where: { id: paymentId } });
  if (!original) throw ApiError.notFound('Payment');

  const recordCode = await nextRecordCode('PAY');
  return prisma.payment.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      amount: num(original.amount)! * -1,
      currency: original.currency,
      gatewayReference: `${original.gatewayReference}:REVERSAL`,
      receivedAt: new Date(),
      status: 'refunded',
      method: original.method,
      reversalOfPaymentId: paymentId,
      note: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

export async function allocatePayment(input: {
  paymentId: string;
  invoiceId?: string | null;
  feeInstalmentId?: string | null;
  amount: number;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payments', verb: 'edit' });

  if (!input.invoiceId && !input.feeInstalmentId) {
    throw ApiError.badRequest('A receipt must allocate to an invoice or a fee instalment.');
  }

  const payment = await prisma.payment.findFirst({
    where: { id: input.paymentId },
    include: { receipts: true },
  });
  if (!payment) throw ApiError.notFound('Payment');

  const alreadyAllocated = payment.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
  const available = (num(payment.amount) ?? 0) - alreadyAllocated;
  if (input.amount > available + 0.001) {
    throw ApiError.unprocessable(
      `Cannot allocate ${input.amount}: only ${available.toFixed(2)} of this payment is unallocated.`,
      { available },
    );
  }

  const recordCode = await nextRecordCode('REC');
  const receipt = await prisma.receipt.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      paymentId: input.paymentId,
      invoiceId: input.invoiceId ?? null,
      feeInstalmentId: input.feeInstalmentId ?? null,
      allocatedAmount: input.amount,
      allocatedById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.RECEIPT_ALLOCATED,
    subject: { entityType: 'receipt', entityId: receipt.id, recordCode },
    related: [
      { relation: 'from', entityType: 'payment', entityId: input.paymentId },
      ...(input.invoiceId ? [{ relation: 'against', entityType: 'invoice', entityId: input.invoiceId }] : []),
      ...(input.feeInstalmentId ? [{ relation: 'against', entityType: 'fee_instalment', entityId: input.feeInstalmentId }] : []),
    ],
    newState: { allocatedAmount: input.amount },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  await settleIfFullyPaid(input.invoiceId ?? null, input.feeInstalmentId ?? null);
  return receipt;
}

async function settleIfFullyPaid(invoiceId: string | null, feeInstalmentId: string | null) {
  if (invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId },
      include: { lines: true, receipts: true },
    });
    if (!invoice) return;
    const total = invoice.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
    const allocated = invoice.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
    const status = allocated >= total - 0.001 ? 'settled' : allocated > 0 ? 'part_paid' : invoice.status;
    if (status !== invoice.status) {
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status } });
      if (status === 'settled') {
        await emit({
          name: EVENTS.INVOICE_SETTLED,
          subject: { entityType: 'invoice', entityId: invoiceId, recordCode: invoice.recordCode },
          newState: { status, allocated },
          impact: { domains: ['fin'] },
        });
      }
    }
    await rehydrateReceivables(invoice.accountId ?? invoice.organizationId, 'account');
  }

  if (feeInstalmentId) {
    const fee = await prisma.feeInstalment.findFirst({
      where: { id: feeInstalmentId },
      include: { receipts: true },
    });
    if (!fee) return;
    const allocated = fee.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
    const total = num(fee.amount) ?? 0;
    const status = allocated >= total - 0.001 ? 'settled' : allocated > 0 ? 'part_paid' : fee.status;
    if (status !== fee.status) await prisma.feeInstalment.update({ where: { id: feeInstalmentId }, data: { status } });
  }
}

/**
 * The only permitted correction to an issued invoice line. Every legacy
 * `refunded` row maps to BOTH a reversal payment AND a credit note — never one
 * without the other.
 */
export async function issueCreditNote(invoiceId: string, amount: number, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'edit' });

  const recordCode = await nextRecordCode('REC');
  const note = await prisma.creditNote.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      invoiceId,
      amount,
      reason,
      issuedById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.CREDIT_NOTE_ISSUED,
    subject: { entityType: 'credit_note', entityId: note.id, recordCode },
    related: [{ relation: 'reduces', entityType: 'invoice', entityId: invoiceId }],
    newState: { amount, reason },
    confidentiality: 'confidential',
  });

  return note;
}

// ---------------------------------------------------------------------------
// CRM-side receivables projection — explicitly non-authoritative, safe to
// rebuild, discard, or re-hydrate at any time.
// ---------------------------------------------------------------------------

export async function rehydrateReceivables(subjectId: string | null, subjectType: 'account' | 'opportunity') {
  if (!subjectId) return null;
  const auth = currentAuth();

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['issued', 'part_paid', 'overdue'] },
      ...(subjectType === 'account' ? { OR: [{ accountId: subjectId }, { organizationId: subjectId }] } : { opportunityId: subjectId }),
    },
    include: { lines: true, receipts: true },
  });

  let outstanding = 0;
  let nextDue: Date | null = null;
  for (const inv of invoices) {
    const total = inv.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
    const allocated = inv.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
    outstanding += Math.max(total - allocated, 0);
    if (inv.dueDate && (!nextDue || inv.dueDate < nextDue)) nextDue = inv.dueDate;
  }

  const overdueDays = nextDue ? Math.floor((Date.now() - nextDue.getTime()) / 86_400_000) : 0;
  const dunningStage = overdueDays <= 0 ? null : overdueDays < 15 ? 'reminder' : overdueDays < 45 ? 'chase' : 'escalated';

  const label =
    subjectType === 'account'
      ? (await prisma.organization.findFirst({ where: { id: subjectId }, select: { name: true } }))?.name ?? subjectId
      : subjectId;

  return prisma.receivablesProjection.upsert({
    where: { tenantId_subjectType_subjectId: { tenantId: auth.tenantId, subjectType, subjectId } },
    create: {
      tenantId: auth.tenantId,
      subjectType,
      subjectId,
      subjectLabel: label,
      amountOutstanding: outstanding,
      nextDueDate: nextDue,
      dunningStage,
    },
    update: {
      subjectLabel: label,
      amountOutstanding: outstanding,
      nextDueDate: nextDue,
      dunningStage,
      hydratedAt: new Date(),
    },
  });
}

/**
 * The overdue-payment detector. The idempotency marker CRM-FIN-001 adds is
 * what stops this re-notifying the same overdue obligation on every tick.
 */
export async function detectOverduePayments(): Promise<number> {
  const auth = currentAuth();
  const now = new Date();

  const overdue = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['issued', 'part_paid'] },
      dueDate: { lt: now },
      overdueNotifiedAt: null,
    },
    include: { lines: true, receipts: true },
    take: 200,
  });

  for (const inv of overdue) {
    const total = inv.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
    const allocated = inv.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
    const outstanding = total - allocated;
    const days = Math.floor((now.getTime() - inv.dueDate!.getTime()) / 86_400_000);

    await raiseException({
      code: 'EX-FIN-001',
      label: 'Payment overdue',
      severity: days > 45 ? 'S3_HIGH_RISK' : 'S2_WARNING',
      subjectType: 'invoice',
      subjectId: inv.id,
      subjectLabel: inv.recordCode,
      domain: 'fin',
      detail: `${outstanding.toFixed(2)} ${inv.currency} outstanding, ${days} days past due.`,
      ownerPartyId: inv.createdById,
      // The marker that structurally fixes the re-notify defect.
      triggerFingerprint: `invoice_overdue:${inv.id}`,
      ladderRung: days > 45 ? 3 : days > 15 ? 2 : 1,
    });

    await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'overdue', overdueNotifiedAt: now } });
    await emit({
      name: EVENTS.PAYMENT_OVERDUE_DETECTED,
      subject: { entityType: 'invoice', entityId: inv.id, recordCode: inv.recordCode },
      newState: { outstanding, daysOverdue: days },
      impact: { domains: ['fin', 'crm'], severity: 'S2_WARNING' },
      confidentiality: 'confidential',
    });
  }

  return overdue.length;
}

export async function invoiceSummary(invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    include: { lines: true, receipts: true },
  });
  if (!invoice) throw ApiError.notFound('Invoice');

  const total = invoice.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
  const allocated = invoice.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
  return { invoice, total, allocated, outstanding: total - allocated };
}
