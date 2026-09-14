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
 *
 * The obligation side — raising an invoice, pricing its tax, editing a draft,
 * collecting at a counter, printing the document — lives in `invoicing.ts`. The
 * split is by direction of dependency rather than by taste: invoices know
 * nothing about payments, payments know about invoices, and keeping the arrow
 * pointing one way is what stops the two files becoming one.
 */

import { EVENTS, round2 } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';
import { invoiceLabel, rehydrateReceivablesFor, totalsOf } from './invoicing.js';

/**
 * Raising an invoice, editing a draft, collecting at a counter and printing the
 * document all live in `invoicing.ts`. Re-exported here so that "the finance
 * domain" remains one import for callers who do not care which file a function
 * sits in.
 */
export {
  createInvoice,
  updateInvoice,
  issueInvoiceDraft,
  voidInvoice,
  collectInvoicePayment,
  declarePaymentTerms,
  invoiceDocument,
  invoiceSummary,
  totalsOf,
  assertPeriodOpen,
} from './invoicing.js';

// ---------------------------------------------------------------------------
// Obligation
// ---------------------------------------------------------------------------

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
      // Null for a gateway webhook, which has no human behind it; the party for
      // money somebody took. It is also the narrowing that lets an employee hold
      // `payments@own` and see their own collections rather than the company's.
      recordedById: auth.partyId,
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

  // The position this allocation leaves the subject in, snapshotted onto the
  // receipt. A receipt is a document as well as a join row, and the document has
  // to keep saying what was owed when it was written — so the figures are stored
  // here rather than recomputed at print time.
  const subject = input.invoiceId
    ? await prisma.invoice.findFirst({
        where: { id: input.invoiceId },
        include: { lines: true, receipts: true },
      })
    : null;
  const subjectTotals = subject ? totalsOf(subject) : null;
  const subjectTotal = subjectTotals?.payable ?? 0;
  const balanceAfter = subjectTotals
    ? round2(Math.max(subjectTotal - subjectTotals.allocated - input.amount - subjectTotals.creditNoted, 0))
    : 0;

  // The company's own receipt series, the same one the counter path uses: a
  // customer holding two receipts from one company should not find them numbered
  // by two different schemes.
  const { documentNumbering } = await import('./companyProfile.js');
  const { DOCUMENT_SERIES, nextDocumentNumber } = await import('../platform/documentNumber.js');
  const numbering = await documentNumbering();
  const recordCode = await nextDocumentNumber(
    DOCUMENT_SERIES.receipt,
    numbering.prefix,
    new Date(),
    numbering.yearFormat,
  );
  const receipt = await prisma.receipt.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      paymentId: input.paymentId,
      invoiceId: input.invoiceId ?? null,
      feeInstalmentId: input.feeInstalmentId ?? null,
      allocatedAmount: input.amount,
      allocatedById: auth.partyId,
      subjectTotal,
      balanceAfter,
      paymentMode: payment.method,
      paymentReference: payment.gatewayReference,
    },
  });

  await emit({
    name: EVENTS.RECEIPT_ISSUED,
    subject: { entityType: 'receipt', entityId: receipt.id, recordCode },
    related: [
      { relation: 'from', entityType: 'payment', entityId: input.paymentId },
      ...(input.invoiceId ? [{ relation: 'against', entityType: 'invoice', entityId: input.invoiceId }] : []),
    ],
    newState: { amount: input.amount, subjectTotal, balanceAfter },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
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
    // `totalsOf` reads the priced grand total where there is one and falls back
    // to the sum of the lines where there is not, which is the one reading of
    // "what is this invoice for" that every surface shares. Summing the lines
    // here independently is how a tax-inclusive invoice came to read as settled
    // when only the pre-tax value had been paid.
    const { payable, allocated, creditNoted } = totalsOf(invoice);
    const status =
      allocated + creditNoted >= payable - 0.001 ? 'settled' : allocated > 0 ? 'part_paid' : invoice.status;
    if (status !== invoice.status) {
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status } });
      if (status === 'settled') {
        await emit({
          name: EVENTS.INVOICE_SETTLED,
          subject: { entityType: 'invoice', entityId: invoiceId, recordCode: invoiceLabel(invoice) },
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
/**
 * `reasonCode` (docs/plan/compliance.md, workstream B — CMP-GST-003) is
 * optional here so the base finance route (which does not know about it) is
 * unaffected: given, it is stored on `CreditNoteReason` — kept off CreditNote
 * itself, which this workstream does not add a field to.
 */
export async function issueCreditNote(invoiceId: string, amount: number, reason: string, reasonCode?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'edit' });

  // The company's own document series ('C'), not the generic record-code
  // sequence: a credit note is a final document a customer holds, and its
  // numbering has to be gapless the way a tax invoice's is.
  const { documentNumbering } = await import('./companyProfile.js');
  const { DOCUMENT_SERIES, nextDocumentNumber } = await import('../platform/documentNumber.js');
  const numbering = await documentNumbering();
  const recordCode = await nextDocumentNumber(DOCUMENT_SERIES.creditNote, numbering.prefix, new Date(), numbering.yearFormat);
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

  if (reasonCode) {
    await prisma.creditNoteReason.create({
      data: { tenantId: auth.tenantId, creditNoteId: note.id, reasonCode },
    });
  }

  await auditWrite({
    action: 'create',
    subjectType: 'credit_note',
    subjectId: note.id,
    after: { recordCode, invoiceId, amount, reason, reasonCode: reasonCode ?? null },
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

export async function rehydrateReceivables(
  subjectId: string | null,
  subjectType: 'account' | 'opportunity',
) {
  return rehydrateReceivablesFor(subjectId, subjectType);
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
    const { outstanding } = totalsOf(inv);
    const days = Math.floor((now.getTime() - inv.dueDate!.getTime()) / 86_400_000);

    await raiseException({
      code: 'EX-FIN-001',
      label: 'Payment is overdue',
      severity: days > 45 ? 'S3_HIGH_RISK' : 'S2_WARNING',
      subjectType: 'invoice',
      subjectId: inv.id,
      subjectLabel: invoiceLabel(inv),
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
      subject: { entityType: 'invoice', entityId: inv.id, recordCode: invoiceLabel(inv) },
      newState: { outstanding, daysOverdue: days },
      impact: { domains: ['fin', 'crm'], severity: 'S2_WARNING' },
      confidentiality: 'confidential',
    });
  }

  return overdue.length;
}
