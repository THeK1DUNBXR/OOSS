/**
 * Client-side preview math for a course-sale invoice, before it is saved.
 *
 * Mirrors exactly what `invoiceDocument()` computes server-side for the
 * `ledger` block (see apps/api/src/domains/invoicing.ts) — same formulas,
 * same `round2` — so the live preview a counter sees while filling the form
 * never disagrees with what the saved, printed document goes on to show.
 * This is a preview only: the server reprices everything at save time.
 */
import { round2 } from '@kaizen/shared';
import { rupees } from '../documentSheet.js';

/** "Rs. 52,500.00" — the reference tool's own currency format, kept exactly. */
export function fmtINR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return `Rs. ${rupees(n)}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export interface RowMath {
  subtotal: number;
  discountAmount: number;
  taxable: number;
  effectiveMonthly: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export function computeRowMath(
  unitPrice: number,
  tenureMonths: number,
  discountPercent: number,
  gstRate: number,
  interState: boolean,
): RowMath {
  const subtotal = round2(unitPrice * tenureMonths);
  const discountAmount = round2((subtotal * discountPercent) / 100);
  const taxable = round2(subtotal - discountAmount);
  const taxAmount = round2((taxable * gstRate) / 100);
  const effectiveMonthly = round2(unitPrice * (1 - discountPercent / 100));
  const cgst = interState ? 0 : round2(taxAmount / 2);
  const sgst = interState ? 0 : round2(taxAmount / 2);
  const igst = interState ? taxAmount : 0;
  return { subtotal, discountAmount, taxable, effectiveMonthly, cgst, sgst, igst, total: round2(taxable + taxAmount) };
}
