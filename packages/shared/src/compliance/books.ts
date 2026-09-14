/**
 * Compliance — books and audit (docs/plan/compliance.md, D). Types and pure
 * arithmetic shared by the API and the web app: Schedule III's default
 * grouping, Schedule II/Income-tax depreciation, retention dates and a small
 * CSV formatter. Rates and useful lives themselves are dated data (seeded),
 * never a constant here — only the arithmetic that takes them as input is.
 */

import { round2 } from '../finance.js';

// ---------------------------------------------------------------------------
// Schedule III — the statement format
// ---------------------------------------------------------------------------

export type ScheduleIIIStatement = 'profit_and_loss' | 'balance_sheet';

export interface ScheduleIIIHead {
  statement: ScheduleIIIStatement;
  head: string;
}

/**
 * The company's own category kind, defaulted to a Schedule III P&L head. An
 * explicit `ScheduleIIIMapping` row (keyed by category) overrides this; this
 * is only the fallback so nothing is ever silently unmapped for want of a
 * seeded row.
 */
export function defaultScheduleIIIHeadForCategory(
  kind: string,
  direction: 'in' | 'out',
): ScheduleIIIHead | null {
  if (kind === 'income') {
    return { statement: 'profit_and_loss', head: 'Revenue from operations' };
  }
  if (kind === 'expense') {
    return { statement: 'profit_and_loss', head: 'Other expenses' };
  }
  if (kind === 'tax') {
    return { statement: 'profit_and_loss', head: 'Tax expense' };
  }
  if (kind === 'asset_purchase') {
    return { statement: 'balance_sheet', head: 'Property, plant and equipment' };
  }
  // transfer, equity, drawings move cash without being a trading result or a
  // statutory head worth defaulting — left for an explicit mapping if one is
  // ever needed, rather than guessed at.
  return null;
}

/** A ledger account's group, defaulted to a Schedule III balance-sheet head. */
export function defaultScheduleIIIHeadForLedgerGroup(ledgerGroup: string): ScheduleIIIHead | null {
  switch (ledgerGroup) {
    case 'asset':
      return { statement: 'balance_sheet', head: 'Cash and cash equivalents' };
    case 'liability':
      return { statement: 'balance_sheet', head: 'Borrowings' };
    case 'equity':
      return { statement: 'balance_sheet', head: 'Reserves and surplus' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Depreciation — Schedule II (Companies Act) and the Income-tax Act block
// ---------------------------------------------------------------------------

/**
 * The Schedule II straight-line charge for one financial year, prorated for a
 * part year of purchase — the Act depreciates from the date put to use, not
 * from the start of the year.
 */
export function companiesActAnnualCharge(input: {
  cost: number;
  usefulLifeYears: number;
  residualPercent: number;
  purchaseDate: Date;
  fyStart: Date;
  fyEnd: Date;
}): { annualCharge: number; daysInYear: number; daysHeld: number; charge: number } {
  const residual = round2((input.cost * input.residualPercent) / 100);
  const depreciable = Math.max(0, round2(input.cost - residual));
  const annualCharge = input.usefulLifeYears > 0 ? round2(depreciable / input.usefulLifeYears) : 0;

  const daysInYear = Math.round((input.fyEnd.getTime() - input.fyStart.getTime()) / 86_400_000) + 1;
  const heldFrom = input.purchaseDate > input.fyStart ? input.purchaseDate : input.fyStart;
  const daysHeld =
    heldFrom > input.fyEnd ? 0 : Math.round((input.fyEnd.getTime() - heldFrom.getTime()) / 86_400_000) + 1;

  const charge = daysHeld >= daysInYear ? annualCharge : round2((annualCharge * daysHeld) / daysInYear);
  return { annualCharge, daysInYear, daysHeld, charge };
}

/**
 * The Income-tax Act's WDV charge for one asset for one year against its
 * block's rate — half-rate if put to use for fewer than 180 days in the year
 * it was acquired, full rate afterward. A simplification of true block
 * accounting (which nets additions/deletions at the block level, not the
 * asset level) but the right figure for "what would this asset's own charge
 * be", which is what a mismatch against Schedule II is checked against.
 */
export function incomeTaxWdvCharge(input: {
  openingWdv: number;
  ratePercent: number;
  usedLessThan180Days: boolean;
}): number {
  const rate = input.usedLessThan180Days ? input.ratePercent / 2 : input.ratePercent;
  return round2((input.openingWdv * rate) / 100);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** The date a record protected by `years` of retention may first be reviewed for disposal. */
export function retentionDueDate(recordDate: Date, years: number): Date {
  const d = new Date(recordDate);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

/** Whether a bank line and a ledger transaction are close enough to be the same movement. */
export function isLikelyMatch(input: {
  bankAmount: number;
  bankDate: Date;
  bankDirection: 'in' | 'out';
  bankReference: string | null;
  txnAmount: number;
  txnDate: Date;
  txnDirection: 'in' | 'out';
  txnReference: string | null;
  windowDays?: number;
}): boolean {
  if (input.bankDirection !== input.txnDirection) return false;
  if (round2(Math.abs(input.bankAmount - input.txnAmount)) > 0.005) return false;
  const days = Math.abs(input.bankDate.getTime() - input.txnDate.getTime()) / 86_400_000;
  if (days > (input.windowDays ?? 3)) return false;
  // A shared reference is corroborating, not required: many ledger entries
  // carry none. When both sides do have one, it must actually agree.
  if (input.bankReference && input.txnReference && input.bankReference !== input.txnReference) return false;
  return true;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** A minimal, correct CSV formatter: quotes a field only when it needs it. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
  return lines.join('\n');
}
