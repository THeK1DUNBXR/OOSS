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

import { EVENTS } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';
import { runHooks } from '../platform/hooks.js';
import { openAccountingDate, periodStatus as accountingPeriodStatus } from './compliance/books.js';
import { invoiceLabel, rehydrateReceivablesFor, totalsOf } from './invoicing.js';
import { governedWrite } from '../platform/governedWrite.js';
import {
  assertFits,
  clampZero,
  lockAndLoadFeeInstalment,
  lockAndLoadInvoice,
  lockPayment,
  outstandingOfInstalment,
  paiseOf,
  paiseOfInput,
  poundsOf,
  positionOfInvoice,
} from './allocation.js';

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

  // Interim policy, pending the accountant's confirmation: money that has
  // arrived is never refused. A caller with no human behind it (a gateway
  // webhook, `partyId` null, as `Payment.recordedById` describes) whose money
  // date falls in a closed period is recorded in the current open period, and
  // the arrival date is kept as `valueDate`. A member of staff entering the same
  // payment is still refused by the hook below. Nothing is written into the
  // closed period either way; only the accounting date moves.
  const arrivedAt = input.receivedAt ?? new Date();
  const movedFromClosed = auth.partyId === null && (await accountingPeriodStatus(arrivedAt)) === 'closed';
  if (!movedFromClosed) {
    await runHooks('accounting_document.before_write', { date: arrivedAt, what: 'This payment' });
  }
  const accountingDate = movedFromClosed ? await openAccountingDate(new Date()) : arrivedAt;

  const recordCode = await nextRecordCode('PAY');
  const payment = await prisma.payment.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      amount: input.amount,
      currency: input.currency ?? 'INR',
      gatewayReference: input.gatewayReference,
      receivedAt: accountingDate,
      valueDate: movedFromClosed ? arrivedAt : null,
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

  await auditWrite({
    action: 'create',
    subjectType: 'payment',
    subjectId: payment.id,
    after: {
      recordCode,
      amount: input.amount,
      receivedAt: accountingDate,
      valueDate: movedFromClosed ? arrivedAt : null,
    },
  });
  if (movedFromClosed) {
    await raiseException({
      code: 'EX-FIN-007',
      label: 'Payment received for a closed period',
      severity: 'S2_WARNING',
      subjectType: 'payment',
      subjectId: payment.id,
      subjectLabel: recordCode,
      detail: `₹${input.amount.toFixed(2)} arrived on ${arrivedAt.toISOString().slice(0, 10)}, in a closed period. It is recorded in the open period from ${accountingDate.toISOString().slice(0, 10)}; the arrival date is kept. Confirm the treatment with the accountant.`,
      triggerFingerprint: `payment_received_closed:${payment.id}`,
      ladderRung: 1,
    });
  }
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

/**
 * A correction is a NEW row, never an update in place.
 *
 * This used to write a negative-amount payment with no `assertCan`, no
 * `auditWrite` and no `emit` — so any principal who could reach the route could
 * reverse money and leave no trace anywhere, while `recordPayment` twenty lines
 * above did all three. Money moving is exactly the event that has to be
 * permitted, recorded and announced.
 */
export async function reversePayment(paymentId: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payments', verb: 'edit' });

  const original = await prisma.payment.findFirst({ where: { id: paymentId } });
  if (!original) throw ApiError.notFound('Payment');
  if (original.reversalOfPaymentId) {
    throw ApiError.unprocessable('This payment is itself a reversal. Reversing it would restore the original error.');
  }
  await runHooks('accounting_document.before_write', { date: new Date(), what: 'This reversal' });

  const recordCode = await nextRecordCode('PAY');
  const reversal = await prisma.payment.create({
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

  await auditWrite({
    action: 'create',
    subjectType: 'payment',
    subjectId: reversal.id,
    before: { reversedPaymentId: paymentId, amount: num(original.amount) },
    after: { recordCode, amount: num(reversal.amount), reason },
  });

  await emit({
    name: EVENTS.PAYMENT_RECEIVED,
    subject: { entityType: 'payment', entityId: reversal.id, recordCode },
    previousState: { paymentId, amount: num(original.amount) },
    newState: { amount: num(reversal.amount), currency: reversal.currency, reversalOf: paymentId },
    reason: { reasonCode: 'payment_reversed', note: reason },
    impact: {
      domains: ['fin'],
      severity: 'S2_WARNING',
      materiality: { measure: 'payment_amount', value: num(reversal.amount) ?? 0, currency: reversal.currency },
    },
    confidentiality: 'confidential',
  });

  return reversal;
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
  const amountPaise = paiseOfInput(input.amount);
  if (amountPaise <= 0n) throw ApiError.badRequest('An allocation has to be for something.');

  await runHooks('accounting_document.before_write', { date: new Date(), what: 'This receipt' });

  // The company's own receipt series, the same one the counter path uses: a
  // customer holding two receipts from one company should not find them numbered
  // by two different schemes. Read before the transaction, which refuses the
  // global client.
  const { documentNumbering } = await import('./companyProfile.js');
  const { DOCUMENT_SERIES, nextDocumentNumber } = await import('../platform/documentNumber.js');
  const numbering = await documentNumbering();

  const receipt = await governedWrite(async (tx) => {
    // Payment first, then invoice: the order every allocation takes them in, so
    // two allocations of one payment queue on the payment (allocation.ts).
    await lockPayment(tx, auth.tenantId, input.paymentId);
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, tenantId: auth.tenantId },
      include: { receipts: true },
    });
    if (!payment) throw ApiError.notFound('Payment');

    const allocatedFromPayment = payment.receipts.reduce((s, r) => s + paiseOf(r.allocatedAmount), 0n);
    assertFits(amountPaise, paiseOf(payment.amount) - allocatedFromPayment, (left) =>
      ApiError.unprocessable(`Cannot allocate ${input.amount}: only ${left} of this payment is unallocated.`, {
        available: Number(left),
      }),
    );

    // The position this allocation leaves the subject in, snapshotted onto the
    // receipt. A receipt is a document as well as a join row, and the document has
    // to keep saying what was owed when it was written, so the figures are stored
    // here rather than recomputed at print time. Read under the invoice lock, for
    // the same reason as collectInvoicePayment.
    let subjectTotal = 0;
    let balanceAfter = 0;
    if (input.invoiceId) {
      const invoice = await lockAndLoadInvoice(tx, { tenantId: auth.tenantId, invoiceId: input.invoiceId });
      const position = positionOfInvoice(invoice);
      assertFits(amountPaise, position.outstanding, (left) =>
        ApiError.unprocessable(
          `Cannot allocate ${input.amount} to ${invoiceLabel(invoice)}: only ₹${left} is outstanding on it.`,
          { outstanding: Number(left), offered: input.amount },
        ),
      );
      subjectTotal = poundsOf(position.payable);
      balanceAfter = poundsOf(clampZero(position.outstanding - amountPaise));
    } else if (input.feeInstalmentId) {
      // Payment, then invoice, then instalment: the one order every path takes
      // them in (allocation.ts). A fee instalment is a receivable like an invoice
      // and had no check at all, so parallel allocations could take more than it is for.
      const instalment = await lockAndLoadFeeInstalment(tx, {
        tenantId: auth.tenantId,
        feeInstalmentId: input.feeInstalmentId,
      });
      const position = outstandingOfInstalment(instalment);
      assertFits(amountPaise, position.outstanding, (left) =>
        ApiError.unprocessable(
          `Cannot allocate ${input.amount} to this fee instalment: only ₹${left} of it is outstanding.`,
          { outstanding: Number(left), offered: input.amount },
        ),
      );
      subjectTotal = poundsOf(position.amount);
      balanceAfter = poundsOf(clampZero(position.outstanding - amountPaise));
    }

    const recordCode = await nextDocumentNumber(
      tx,
      DOCUMENT_SERIES.receipt,
      numbering.prefix,
      new Date(),
      numbering.yearFormat,
    );
    const receipt = await tx.receipt.create({
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

    await auditWrite({
      tx,
      action: 'create',
      subjectType: 'receipt',
      subjectId: receipt.id,
      after: { recordCode, amount: input.amount, balanceAfter },
    });
    await emit({
      tx,
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
      tx,
      name: EVENTS.RECEIPT_ALLOCATED,
      subject: { entityType: 'receipt', entityId: receipt.id, recordCode },
      related: [
        { relation: 'from', entityType: 'payment', entityId: input.paymentId },
        ...(input.invoiceId ? [{ relation: 'against', entityType: 'invoice', entityId: input.invoiceId }] : []),
        ...(input.feeInstalmentId
          ? [{ relation: 'against', entityType: 'fee_instalment', entityId: input.feeInstalmentId }]
          : []),
      ],
      newState: { allocatedAmount: input.amount },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
    });

    return receipt;
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
  await runHooks('accounting_document.before_write', { date: new Date(), what: 'This credit note' });

  // The company's own document series ('C'), not the generic record-code
  // sequence: a credit note is a final document a customer holds, and its
  // numbering has to be gapless the way a tax invoice's is.
  const { documentNumbering } = await import('./companyProfile.js');
  const { DOCUMENT_SERIES, nextDocumentNumber } = await import('../platform/documentNumber.js');
  const numbering = await documentNumbering();
  // The number and the row it names commit together. Taken on the global client it
  // stayed taken when this write was refused, and the series had a hole in it.
  const { recordCode, note } = await prisma.$transaction(async (tx) => {
    const recordCode = await nextDocumentNumber(
      tx,
      DOCUMENT_SERIES.creditNote,
      numbering.prefix,
      new Date(),
      numbering.yearFormat,
    );
    const note = await tx.creditNote.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        invoiceId,
        amount,
        reason,
        issuedById: auth.partyId,
      },
    });
    return { recordCode, note };
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

export async function rehydrateReceivables(subjectId: string | null, subjectType: 'account' | 'opportunity') {
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
