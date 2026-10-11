/**
 * Payment allocation: the lock and the arithmetic every path that applies money
 * to an invoice goes through. Two callers: `collectInvoicePayment` in
 * invoicing.ts (money taken at the counter, which makes a payment and a receipt
 * at once) and `allocatePayment` in finance.ts (a payment already on file, which
 * makes a receipt). They write different rows, so each keeps its own write, but
 * both take the locks here and both read the balance here, under the lock.
 *
 * Why the lock. The balance was read outside any transaction and written after:
 * eight parallel collections of 2,000 against an invoice payable 11,800 all read
 * 11,800 outstanding, all passed, and 16,000 was allocated. A check that reads
 * and then writes is only correct if nothing can commit between the two.
 *
 * Lock order is payment, then invoice, always. Every path takes them in that
 * order, so two allocations of one payment to two invoices queue on the payment
 * rather than each holding one row and waiting for the other.
 *
 * Under READ COMMITTED a statement issued after the lock sees every receipt that
 * committed before the lock was granted. So the balance is read after the lock,
 * never before it.
 *
 * Paise, not floats. Every comparison here is on bigint paise (CLAUDE.md rule 1).
 * The receipts and totals still arrive as Prisma Decimal and as the float
 * `totalsOf` returns, and the conversion happens once, here, at the boundary,
 * with `toFixed(2)`: a value with a third decimal place cannot be paise, and
 * `parseMinor` refuses it rather than rounding it.
 */

import { formatMinor, parseMinor, sub } from '@kaizen/shared';
import type { DbTx } from '../platform/db.js';
import { ApiError } from '../platform/errors.js';

/** A Decimal or a float, at the boundary, as paise. */
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

/**
 * Takes both locks in order and reads the invoice with what it has been paid.
 * The caller computes `totalsOf` on the result and then `balanceOf`, so the
 * position is read entirely after the locks are held.
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

/** Paise to the pounds a Prisma Decimal or a wire field carries. Exact for any value with two places. */
export function poundsOf(p: bigint): number {
  return Number(formatMinor(p));
}

/** A balance cannot be negative: an overpayment is an advance, not a negative amount owed. */
export function clampZero(p: bigint): bigint {
  return p < 0n ? 0n : p;
}

/** What an invoice still owes, in paise, from the three figures `totalsOf` reports. */
export function balanceOf(totals: { payable: number; allocated: number; creditNoted: number }) {
  const payable = paiseOf(totals.payable);
  const allocated = paiseOf(totals.allocated);
  const creditNoted = paiseOf(totals.creditNoted);
  return { payable, allocated, creditNoted, outstanding: clampZero(sub(sub(payable, allocated), creditNoted)) };
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
