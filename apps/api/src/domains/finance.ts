/**
 * Finance — the money model, split for the first time into three distinct facts
 * the legacy single collection conflated:
 *
 *   obligation   → INVOICE / INVOICE_LINE (commercial) and FEE_INSTALMENT (education)
 *   movement     → PAYMENT, append-only, gateway-authoritative
 *   allocation   → RECEIPT, the many-to-many join
 *
 * Only the sum of a subject's RECEIPT.allocatedAmountMinor rows determines what has
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

import { EVENTS, toMinorHalfUp } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';
import { runHooks } from '../platform/hooks.js';
import { openAccountingDate, periodRefusesEntries } from './compliance/books.js';
import { invoiceLabel, paymentWire, receiptWire, rehydrateReceivablesFor, totalsOf } from './invoicing.js';
import { rupeesToMinor, wireInt, withDecimalMinor } from '../platform/wire.js';
import { governedWrite } from '../platform/governedWrite.js';
import { lockLegacyPeriod } from '../platform/periodLock.js';
import {
  paymentHasReceiptEntries,
  postReceiptAllocation,
  receiptPostsFor,
  reverseReceiptEntries,
} from './invoicePosting.js';
import {
  assertFits,
  clampZero,
  lockAndLoadFeeInstalment,
  lockAndLoadInvoice,
  lockPayment,
  outstandingOfInstalment,
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
    const amountMinor = toMinorHalfUp(item.amount);
    const instalment = await governedWrite(async (tx) => {
      const row = await tx.feeInstalment.create({
        data: {
          tenantId: auth.tenantId,
          recordCode,
          enrollmentId,
          amountMinor,
          currency,
          dueDate: item.dueDate,
          status: 'issued',
        },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'fee_instalment',
        subjectId: row.id,
        after: {
          recordCode,
          enrollmentId,
          amountMinor: String(amountMinor),
          currency,
          dueDate: item.dueDate.toISOString(),
        },
        tx,
      });
      return row;
    });
    created.push(instalment);
    await emit({
      name: EVENTS.FEE_INSTALMENT_ISSUED,
      subject: { entityType: 'fee_instalment', entityId: instalment.id, recordCode },
      related: [{ relation: 'bills', entityType: 'enrollment', entityId: enrollmentId }],
      newState: { amount: item.amount, amountMinor: wireInt(amountMinor), dueDate: item.dueDate },
      impact: { domains: ['fin', 'edu'] },
      confidentiality: 'confidential',
    });
  }
  return created.map((row) => withDecimalMinor(row, ['amount'] as const));
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
  if (existing) return paymentWire(existing);

  // Interim policy, pending the accountant's confirmation: money that has
  // arrived is never refused. A caller with no human behind it (a gateway
  // webhook, `partyId` null, as `Payment.recordedById` describes) whose money
  // date falls in a closed or closing period is recorded in the current open period, and
  // the arrival date is kept as `valueDate`. A member of staff entering the same
  // payment is still refused by the hook below. Nothing is written into the
  // closed period either way; only the accounting date moves. A closing period
  // counts as closed here: the hook now refuses it, so without this the webhook
  // would be refused and the money would never be recorded.
  const arrivedAt = input.receivedAt ?? new Date();
  const movedFromClosed = auth.partyId === null && (await periodRefusesEntries(arrivedAt));
  if (!movedFromClosed) {
    await runHooks('accounting_document.before_write', { date: arrivedAt, what: 'This payment' });
  }
  const accountingDate = movedFromClosed ? await openAccountingDate(new Date()) : arrivedAt;
  // Half away from zero, as the number the route sent always read into a two-place column.
  const amountMinor = rupeesToMinor(input.amount);

  // The lock is on the accounting date, not the arrival date: a payment moved past a closed
  // month is written into the open one, and that is the month the lock must hold. The hook
  // above reads the status outside a transaction, so the lock is what holds it through the
  // insert (periodLock.ts, FX-70).
  const { recordCode, payment } = await prisma.$transaction(async (tx) => {
    await lockLegacyPeriod(tx, auth.tenantId, accountingDate);
    const recordCode = await nextRecordCode('PAY', new Date(), tx);
    const payment = await tx.payment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        amountMinor,
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
    return { recordCode, payment };
  });

  await auditWrite({
    action: 'create',
    subjectType: 'payment',
    subjectId: payment.id,
    after: {
      recordCode,
      amount: input.amount,
      amountMinor: wireInt(amountMinor),
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
    newState: { amount: input.amount, amountMinor: wireInt(amountMinor), currency: payment.currency },
    impact: {
      domains: ['fin'],
      materiality: { measure: 'payment_amount', value: input.amount, currency: payment.currency },
    },
    confidentiality: 'confidential',
  });

  return paymentWire(payment);
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
  // The reversal of the receipts' journal entries is a write in the transactions domain.
  if (await paymentHasReceiptEntries(paymentId)) await assertCan({ resource: 'transactions', verb: 'create' });

  // The payment's reversal row and the reversal of its receipts' entries commit together.
  const { recordCode, reversal } = await governedWrite(async (tx) => {
    // One clock read: the period the lock holds is the month the reversal row is dated in.
    // The hook above checked the same month, outside the transaction (periodLock.ts).
    const at = new Date();
    await lockLegacyPeriod(tx, auth.tenantId, at);
    const recordCode = await nextRecordCode('PAY', at, tx);
    const reversal = await tx.payment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        amountMinor: -original.amountMinor,
        currency: original.currency,
        gatewayReference: `${original.gatewayReference}:REVERSAL`,
        receivedAt: at,
        status: 'refunded',
        method: original.method,
        reversalOfPaymentId: paymentId,
        note: reason,
      },
    });
    await reverseReceiptEntries(tx, paymentId, reason);
    return { recordCode, reversal };
  });

  await auditWrite({
    action: 'create',
    subjectType: 'payment',
    subjectId: reversal.id,
    before: {
      reversedPaymentId: paymentId,
      amount: poundsOf(original.amountMinor),
      amountMinor: wireInt(original.amountMinor),
    },
    after: {
      recordCode,
      amount: poundsOf(reversal.amountMinor),
      amountMinor: wireInt(reversal.amountMinor),
      reason,
    },
  });

  await emit({
    name: EVENTS.PAYMENT_RECEIVED,
    subject: { entityType: 'payment', entityId: reversal.id, recordCode },
    previousState: { paymentId, amount: poundsOf(original.amountMinor), amountMinor: wireInt(original.amountMinor) },
    newState: {
      amount: poundsOf(reversal.amountMinor),
      amountMinor: wireInt(reversal.amountMinor),
      currency: reversal.currency,
      reversalOf: paymentId,
    },
    reason: { reasonCode: 'payment_reversed', note: reason },
    impact: {
      domains: ['fin'],
      severity: 'S2_WARNING',
      materiality: { measure: 'payment_amount', value: poundsOf(reversal.amountMinor), currency: reversal.currency },
    },
    confidentiality: 'confidential',
  });

  // Returned in the shape recordPayment returns: the Decimal `amount` a caller always read, beside its paise.
  return paymentWire(reversal);
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
  // An allocation to an invoice posts its receipt to the journal (invoicePosting.ts).
  if (input.invoiceId) await assertCan({ resource: 'transactions', verb: 'create' });

  const receipt = await governedWrite(async (tx) => {
    // Payment first, then invoice: the order every allocation takes them in, so
    // two allocations of one payment queue on the payment (allocation.ts).
    await lockPayment(tx, auth.tenantId, input.paymentId);
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, tenantId: auth.tenantId },
      include: { receipts: true },
    });
    if (!payment) throw ApiError.notFound('Payment');

    const allocatedFromPayment = payment.receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n);
    assertFits(amountPaise, payment.amountMinor - allocatedFromPayment, (left) =>
      ApiError.unprocessable(`Cannot allocate ${input.amount}: only ${left} of this payment is unallocated.`, {
        available: Number(left),
      }),
    );

    // The position this allocation leaves the subject in, snapshotted onto the
    // receipt. A receipt is a document as well as a join row, and the document has
    // to keep saying what was owed when it was written, so the figures are stored
    // here rather than recomputed at print time. Read under the invoice lock, for
    // the same reason as collectInvoicePayment.
    let subjectTotalMinor = 0n;
    let balanceAfterMinor = 0n;
    if (input.invoiceId) {
      const invoice = await lockAndLoadInvoice(tx, { tenantId: auth.tenantId, invoiceId: input.invoiceId });
      const position = positionOfInvoice(invoice);
      assertFits(amountPaise, position.outstanding, (left) =>
        ApiError.unprocessable(
          `Cannot allocate ${input.amount} to ${invoiceLabel(invoice)}: only ₹${left} is outstanding on it.`,
          { outstanding: Number(left), offered: input.amount },
        ),
      );
      subjectTotalMinor = position.payable;
      balanceAfterMinor = clampZero(position.outstanding - amountPaise);
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
      subjectTotalMinor = position.amount;
      balanceAfterMinor = clampZero(position.outstanding - amountPaise);
    }

    // The period row before the number is taken (periodLock.ts order). Taken for a fee
    // instalment too: the receipt is dated today whichever it allocates to, and the hook above
    // checked today's month outside this transaction. A month with no row gets one; a closed or
    // closing month is refused.
    const at = new Date();
    await lockLegacyPeriod(tx, auth.tenantId, at);
    const recordCode = await nextDocumentNumber(
      tx,
      DOCUMENT_SERIES.receipt,
      numbering.prefix,
      at,
      numbering.yearFormat,
    );
    const receipt = await tx.receipt.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        paymentId: input.paymentId,
        invoiceId: input.invoiceId ?? null,
        feeInstalmentId: input.feeInstalmentId ?? null,
        allocatedAmountMinor: amountPaise,
        allocatedById: auth.partyId,
        subjectTotalMinor,
        balanceAfterMinor,
        paymentMode: payment.method,
        paymentReference: payment.gatewayReference,
      },
    });

    if (input.invoiceId) {
      const invoice = await tx.invoice.findFirst({
        where: { id: input.invoiceId, tenantId: auth.tenantId },
        select: {
          recordCode: true,
          draftReference: true,
          ledgerEntityId: true,
          organizationId: true,
          personId: true,
        },
      });
      if (!invoice) throw ApiError.notFound('Invoice');
      // Owner decision, 2026-10-13: no journal entry against an invoice issued before
      // posting was wired (see collectInvoicePayment). The receipt row is still written.
      if (await receiptPostsFor(tx, input.invoiceId)) {
        await postReceiptAllocation(tx, {
          receiptId: receipt.id,
          receiptCode: recordCode,
          allocatedAmountMinor: receipt.allocatedAmountMinor,
          paymentMode: payment.method,
          invoice,
          receivedAt: new Date(),
        });
      }
    }

    await auditWrite({
      tx,
      action: 'create',
      subjectType: 'receipt',
      subjectId: receipt.id,
      after: {
        recordCode,
        amount: input.amount,
        amountMinor: wireInt(amountPaise),
        balanceAfter: poundsOf(balanceAfterMinor),
        balanceAfterMinor: wireInt(balanceAfterMinor),
      },
    });
    await emit({
      tx,
      name: EVENTS.RECEIPT_ISSUED,
      subject: { entityType: 'receipt', entityId: receipt.id, recordCode },
      related: [
        { relation: 'from', entityType: 'payment', entityId: input.paymentId },
        ...(input.invoiceId ? [{ relation: 'against', entityType: 'invoice', entityId: input.invoiceId }] : []),
      ],
      newState: {
        amount: input.amount,
        amountMinor: wireInt(amountPaise),
        subjectTotal: poundsOf(subjectTotalMinor),
        subjectTotalMinor: wireInt(subjectTotalMinor),
        balanceAfter: poundsOf(balanceAfterMinor),
        balanceAfterMinor: wireInt(balanceAfterMinor),
      },
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
      newState: { allocatedAmount: input.amount, allocatedAmountMinor: wireInt(amountPaise) },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
    });

    return receipt;
  });

  await settleIfFullyPaid(input.invoiceId ?? null, input.feeInstalmentId ?? null);
  return receiptWire(receipt);
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
      toMinorHalfUp(allocated) + toMinorHalfUp(creditNoted) >= toMinorHalfUp(payable)
        ? 'settled'
        : allocated > 0
          ? 'part_paid'
          : invoice.status;
    if (status !== invoice.status) {
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status } });
      // Runs after allocatePayment's transaction has committed (finance.ts:502), so
      // this row is written on its own, not in the settlement's transaction. That is FX-24.
      await auditWrite({
        action: 'update',
        subjectType: 'invoice',
        subjectId: invoiceId,
        before: { status: invoice.status },
        after: { status },
        meta: { source: 'settlement' },
      });
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
    // Summed in paise from each receipt's paise column. A float sum over instalments is
    // where the old 0.001 was absorbing noise, so the sum is no longer a float.
    const allocated = fee.receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n);
    const total = fee.amountMinor;
    const status = allocated >= total ? 'settled' : allocated > 0n ? 'part_paid' : fee.status;
    if (status !== fee.status) {
      await prisma.feeInstalment.update({ where: { id: feeInstalmentId }, data: { status } });
      // Post-commit, as the invoice settlement above: see the note there (FX-24).
      await auditWrite({
        action: 'update',
        subjectType: 'fee_instalment',
        subjectId: feeInstalmentId,
        before: { status: fee.status },
        after: { status },
        meta: { source: 'settlement' },
      });
    }
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
  // One clock read for the hook, the period lock and the number: a credit note is dated now.
  const now = new Date();
  await runHooks('accounting_document.before_write', { date: now, what: 'This credit note' });

  // The company's own document series ('C'), not the generic record-code
  // sequence: a credit note is a final document a customer holds, and its
  // numbering has to be gapless the way a tax invoice's is.
  const { documentNumbering } = await import('./companyProfile.js');
  const { DOCUMENT_SERIES, nextDocumentNumber } = await import('../platform/documentNumber.js');
  const numbering = await documentNumbering();
  // The number and the row it names commit together. Taken on the global client it
  // stayed taken when this write was refused, and the series had a hole in it.
  // The paise conversion is inside the transaction, after the number is taken, so a
  // refused amount gives the number back the same way a refused row does.
  const { recordCode, note, amountMinor } = await prisma.$transaction(async (tx) => {
    // The period lock comes before the number (periodLock.ts order), so a close that lands after
    // the hook refuses the note here and gives the number back with the rest of the transaction.
    await lockLegacyPeriod(tx, auth.tenantId, now);
    const recordCode = await nextDocumentNumber(
      tx,
      DOCUMENT_SERIES.creditNote,
      numbering.prefix,
      now,
      numbering.yearFormat,
    );
    const amountMinor = toMinorHalfUp(amount);
    const note = await tx.creditNote.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        invoiceId,
        amountMinor,
        reason,
        issuedById: auth.partyId,
      },
    });
    return { recordCode, note, amountMinor };
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
    after: { recordCode, invoiceId, amount, amountMinor: wireInt(amountMinor), reason, reasonCode: reasonCode ?? null },
  });

  await emit({
    name: EVENTS.CREDIT_NOTE_ISSUED,
    subject: { entityType: 'credit_note', entityId: note.id, recordCode },
    related: [{ relation: 'reduces', entityType: 'invoice', entityId: invoiceId }],
    newState: { amount, amountMinor: wireInt(amountMinor), reason },
    confidentiality: 'confidential',
  });

  return withDecimalMinor(note, ['amount'] as const);
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
