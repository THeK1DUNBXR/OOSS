/**
 * Payment allocation: the locks and the balance every path that applies money to
 * an invoice or a fee instalment goes through. Two callers: `collectInvoicePayment`
 * in invoicing.ts (money taken at the counter, which makes a payment and a receipt
 * at once) and `allocatePayment` in finance.ts (a payment already on file, which
 * makes a receipt). They write different rows, so each keeps its own write, but
 * both take the locks here and both read the balance here, under the lock.
 *
 * Why the lock. The balance was read outside any transaction and written after:
 * eight parallel collections of 2,000 against an invoice payable 11,800 all read
 * 11,800 outstanding, all passed, and 16,000 was allocated. A check that reads
 * and then writes is only correct if nothing can commit between the two.
 *
 * Lock order is payment, then invoice, then fee instalment, always. Every path
 * takes them in that order, so two allocations that touch the same rows queue on
 * the first one they share instead of each holding one row and waiting for the
 * other. Nothing in the codebase locks in any other order: the only other
 * FOR UPDATE is outbox.ts, which locks its own rows and never a payment.
 *
 * Under READ COMMITTED a statement issued after the lock sees every receipt that
 * committed before the lock was granted. So the balance is read after the lock,
 * never before it.
 *
 * Paise, never a float. Each Decimal column is converted with its own `toFixed(2)`,
 * which is exact for a value stored at two places, and then summed as bigint.
 * The earlier version summed `totalsOf` output, which is a float sum, and then
 * converted the rounded float: a float sum of valid paise values can land a
 * fraction away from the exact total, and toFixed would then round that
 * fraction into a paisa that was never owed. A Decimal that somehow has a third
 * place is refused by parseMinor rather than rounded.
 */

import { formatMinor, parseMinor, sub } from '@kaizen/shared';
import type { DbTx } from '../platform/db.js';
import { ApiError } from '../platform/errors.js';

/** A Prisma Decimal (or a number, at a caller's boundary), as exact paise. */
export function paiseOf(value: { toFixed(digits: number): string } | number): bigint {
  return parseMinor(value.toFixed(2));
}

/**
 * An amount typed in by a caller. Refused when it has more than two decimal
 * places, because `toFixed` would round it and the caller would never know a
 * paisa had moved.
 */
export function paiseOfInput(amount: number): bigint {
  const text = amount.toFixed(2);
  if (Number(text) !== amount) {
    throw ApiError.badRequest('An amount has at most two decimal places.');
  }
  return parseMinor(text);
}

/** Locks the payment row until commit. Tenant-scoped in the predicate, as well as by RLS. */
export async function lockPayment(tx: DbTx, tenantId: string, paymentId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "payments"
    WHERE "id" = ${paymentId} AND "tenantId" = ${tenantId}
    FOR UPDATE`;
  if (rows.length === 0) throw ApiError.notFound('Payment');
}

/** Locks the invoice row until commit. Tenant-scoped in the predicate, as well as by RLS. */
export async function lockInvoice(tx: DbTx, tenantId: string, invoiceId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "invoices"
    WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId}
    FOR UPDATE`;
  if (rows.length === 0) throw ApiError.notFound('Invoice');
}

/** Locks the fee instalment row until commit. Tenant-scoped in the predicate, as well as by RLS. */
export async function lockFeeInstalment(tx: DbTx, tenantId: string, feeInstalmentId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "fee_instalments"
    WHERE "id" = ${feeInstalmentId} AND "tenantId" = ${tenantId}
    FOR UPDATE`;
  if (rows.length === 0) throw ApiError.notFound('Fee instalment');
}

/**
 * Takes the payment and invoice locks in order and reads the invoice with the
 * receipts that have been allocated to it. The caller takes `positionOfInvoice`
 * on the result, so the position is read entirely after the locks are held.
 */
export async function lockAndLoadInvoice(
  tx: DbTx,
  input: { tenantId: string; invoiceId: string; paymentId?: string | null },
) {
  if (input.paymentId) await lockPayment(tx, input.tenantId, input.paymentId);
  await lockInvoice(tx, input.tenantId, input.invoiceId);
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId, deletedAt: null },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
  });
  if (!invoice) throw ApiError.notFound('Invoice');
  return invoice;
}

/**
 * Takes the fee instalment lock and reads the instalment with the receipts
 * allocated to it. Called after the payment lock, so the order is payment,
 * instalment.
 */
export async function lockAndLoadFeeInstalment(tx: DbTx, input: { tenantId: string; feeInstalmentId: string }) {
  await lockFeeInstalment(tx, input.tenantId, input.feeInstalmentId);
  return tx.feeInstalment.findFirstOrThrow({
    where: { id: input.feeInstalmentId, tenantId: input.tenantId },
    include: { receipts: true },
  });
}

/**
 * What an invoice is for and what it has been paid, in paise.
 *
 * Mirrors `invoicePayable` in packages/shared/src/finance.ts: the grand total when
 * it is positive, otherwise the sum of the lines. Credit notes are not summed:
 * the CreditNote table has no relation to Invoice in the schema, and `totalsOf`
 * has never read them here either, so this keeps the behaviour as it was. Noted
 * as open rather than fixed in this change.
 */
export function positionOfInvoice(invoice: {
  grandTotalMinor: bigint;
  lines: Array<{ amountMinor: bigint }>;
  receipts: Array<{ allocatedAmountMinor: bigint }>;
  creditNotes?: Array<{ amountMinor: bigint }>;
}) {
  const grandTotal = invoice.grandTotalMinor;
  const linesTotal = invoice.lines.reduce((s, l) => s + l.amountMinor, 0n);
  const payable = grandTotal > 0n ? grandTotal : linesTotal;
  const allocated = invoice.receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n);
  const creditNoted = (invoice.creditNotes ?? []).reduce((s, c) => s + c.amountMinor, 0n);
  return { payable, allocated, creditNoted, outstanding: clampZero(sub(sub(payable, allocated), creditNoted)) };
}

/** What a fee instalment still owes, in paise, from its amount and the receipts against it. */
export function outstandingOfInstalment(instalment: {
  amountMinor: bigint;
  receipts: Array<{ allocatedAmountMinor: bigint }>;
}) {
  const amount = instalment.amountMinor;
  const allocated = instalment.receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n);
  return { amount, allocated, outstanding: clampZero(sub(amount, allocated)) };
}

/** Paise to the pounds a wire field carries. Exact for any value with two places. */
export function poundsOf(p: bigint): number {
  return Number(formatMinor(p));
}

/** A balance cannot be negative: an overpayment is an advance, not a negative amount owed. */
export function clampZero(p: bigint): bigint {
  return p < 0n ? 0n : p;
}

/**
 * Refuses an amount that does not fit in what is left. The message names what
 * is left, as the callers always have, so the refusal says what the customer
 * can actually take.
 */
export function assertFits(amount: bigint, available: bigint, refuse: (available: string) => ApiError): void {
  if (amount > available) throw refuse(formatMinor(clampZero(available)));
}

/**
 * The refusal for money offered beyond an invoice's balance. Built once here so
 * the pre-check and the check under the lock say the same thing to the customer.
 */
export function overdrawnRefusal(label: string, offered: number) {
  return (left: string) =>
    ApiError.unprocessable(
      `₹${offered.toFixed(2)} is more than the ₹${left} still outstanding on ${label}. ` +
        'Take the balance, or record the excess as a payment on its own and allocate it to the next invoice.',
      { outstanding: Number(left), offered },
    );
}
