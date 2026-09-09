/**
 * The books (bounded context `fin`) — Canon §15.
 *
 * The arithmetic, kept pure and here rather than in the API, for the same
 * reason the lifecycle machines are: a surface showing a depreciation schedule
 * and a service posting one must agree, and the only way to guarantee that is
 * for there to be one of them.
 *
 * Everything below is rupee arithmetic for an Indian private limited company:
 * GST that splits or does not depending on which side of a state line the
 * customer is, written-down-value depreciation because that is what the tax
 * computation uses, and a financial year that starts in April.
 */

// ---------------------------------------------------------------------------
// Divisions — the cut every figure in this company is read by
// ---------------------------------------------------------------------------

export const DIVISIONS = ['software', 'skill', 'education', 'shared'] as const;
export type Division = (typeof DIVISIONS)[number];

export const DIVISION_LABELS: Record<Division, string> = {
  software: 'Software',
  skill: 'Skill Development',
  education: 'Education',
  shared: 'Shared / Corporate',
};

export function isDivision(value: string | null | undefined): value is Division {
  return typeof value === 'string' && (DIVISIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Ledger vocabulary
// ---------------------------------------------------------------------------

export const CATEGORY_KINDS = [
  'income', 'expense', 'asset_purchase', 'transfer', 'tax', 'drawings', 'equity',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/**
 * Kinds that move cash without being trading performance.
 *
 * A transfer between the company's own accounts is not income on one side and
 * expense on the other; capital put in by the founders is funding, not
 * revenue; money taken out is not a cost of doing business. Counting any of
 * them in the profit and loss would make a funded month look profitable, which
 * is the single most misleading thing a founder's dashboard can do.
 */
export const NON_TRADING_KINDS: CategoryKind[] = ['transfer', 'equity', 'drawings'];

export function isTrading(kind: string | null | undefined): boolean {
  return !NON_TRADING_KINDS.includes((kind ?? 'expense') as CategoryKind);
}

/**
 * How a cost behaves over a year, which is what makes a cash forecast a
 * forecast rather than a guess: rent recurs whatever happens, program costs
 * follow delivery, and an audit fee lands once.
 */
export const CATEGORY_BEHAVIOURS = ['recurring_fixed', 'variable', 'one_time', 'annual'] as const;
export type CategoryBehaviour = (typeof CATEGORY_BEHAVIOURS)[number];

export const TRANSACTION_SOURCES = [
  'manual', 'bank_import', 'payroll', 'invoice', 'vendor_bill', 'recurring', 'asset', 'loan',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const LEDGER_GROUPS = ['asset', 'liability', 'equity'] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

// ---------------------------------------------------------------------------
// Periods. The Indian financial year runs April to March.
// ---------------------------------------------------------------------------

/** `YYYY-MM` for a date, in UTC. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(period: string): { from: Date; to: Date } {
  const [year, month] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

/** The label a financial year is referred to by: FY2026-27. */
export function financialYearOf(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function financialYearRange(fyStartYear: number): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(fyStartYear, 3, 1)), to: new Date(Date.UTC(fyStartYear + 1, 3, 1)) };
}

/** The `count` months ending with `endPeriod`, oldest first. */
export function monthsBack(endPeriod: string, count: number): string[] {
  const [year, month] = endPeriod.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(monthKey(d));
  }
  return out;
}

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

export interface GstLineInput {
  /** Line value before tax. */
  taxableValue: number;
  /** Percentage: 0, 5, 12, 18, 28. */
  gstRate: number;
}

export interface GstBreakdown {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  total: number;
  roundOff: number;
  grandTotal: number;
}

/** Rupees, to two places, without the drift of repeated float addition. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Splits GST across a set of lines.
 *
 * Within the state the tax is halved into CGST and SGST; across a state line
 * it is a single IGST. That is not a presentation choice — they are different
 * taxes, collected by different governments, and an invoice that shows the
 * wrong pair is wrong rather than merely untidy.
 *
 * The split is computed per line and then summed, because a single invoice can
 * carry an 18% service and a 5% good, and halving the invoice total would
 * misstate both.
 */
export function computeGst(lines: GstLineInput[], interState: boolean): GstBreakdown {
  let taxableValue = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  for (const line of lines) {
    const value = round2(line.taxableValue);
    const tax = round2((value * line.gstRate) / 100);
    taxableValue = round2(taxableValue + value);

    if (interState) {
      igst = round2(igst + tax);
    } else {
      // Half each, with the odd paisa going to CGST so the two halves still
      // sum to the tax rather than to a rupee either side of it.
      const half = round2(tax / 2);
      cgst = round2(cgst + half);
      sgst = round2(sgst + round2(tax - half));
    }
  }

  const tax = round2(cgst + sgst + igst);
  const total = round2(taxableValue + tax);
  // An invoice is presented to the nearest rupee, and the difference is
  // carried explicitly rather than absorbed — otherwise the ledger and the
  // printed document disagree by paise nobody can account for.
  const grandTotal = Math.round(total);
  const roundOff = round2(grandTotal - total);

  return { taxableValue, cgst, sgst, igst, tax, total, roundOff, grandTotal };
}

/**
 * Whether a supply crosses a state line, from the two GSTINs' state codes.
 *
 * The first two digits of a GSTIN are the state. If the customer has no GSTIN
 * — an unregistered buyer — the place of supply is what decides, and this
 * returns null so the caller has to say rather than guess.
 */
export function isInterState(supplierGstin: string | null, customerGstin: string | null): boolean | null {
  if (!supplierGstin || !customerGstin) return null;
  if (supplierGstin.length < 2 || customerGstin.length < 2) return null;
  return supplierGstin.slice(0, 2) !== customerGstin.slice(0, 2);
}

export const GST_RATES = [0, 5, 12, 18, 28] as const;

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export interface DepreciationPeriod {
  period: string;
  opening: number;
  charge: number;
  closing: number;
}

export interface DepreciationInput {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  purchaseDate: Date;
  /** `straight_line`, or `wdv` — which is what the Indian tax computation uses. */
  method: 'straight_line' | 'wdv';
  /** Annual percentage, for `wdv` only. */
  wdvRate?: number;
}

/**
 * The whole schedule, month by month.
 *
 * Computed on demand rather than stored: correcting a useful life then fixes
 * every future period at once, instead of leaving a table somebody has to
 * remember to regenerate.
 */
export function depreciationSchedule(input: DepreciationInput): DepreciationPeriod[] {
  const out: DepreciationPeriod[] = [];
  if (input.usefulLifeMonths <= 0 || input.cost <= 0) return out;

  const depreciable = Math.max(0, round2(input.cost - input.salvageValue));
  let carrying = input.cost;

  for (let i = 0; i < input.usefulLifeMonths; i += 1) {
    const d = new Date(
      Date.UTC(input.purchaseDate.getUTCFullYear(), input.purchaseDate.getUTCMonth() + i, 1),
    );
    const opening = carrying;

    let charge: number;
    if (input.method === 'wdv') {
      const monthlyRate = (input.wdvRate ?? 0) / 100 / 12;
      charge = round2(Math.max(0, opening - input.salvageValue) * monthlyRate);
    } else {
      charge = round2(depreciable / input.usefulLifeMonths);
    }

    // Never write below the salvage value, and let the final period absorb the
    // rounding rather than leaving a few paise stranded forever.
    const floor = input.salvageValue;
    if (opening - charge < floor) charge = round2(opening - floor);
    if (charge < 0) charge = 0;

    carrying = round2(opening - charge);
    out.push({ period: monthKey(d), opening, charge, closing: carrying });

    if (carrying <= floor) break;
  }

  return out;
}

/** What an asset is carried at on a date, from the same schedule. */
export function bookValueAt(input: DepreciationInput, asOf: Date): number {
  const schedule = depreciationSchedule(input);
  const key = monthKey(asOf);
  let value = input.cost;
  for (const row of schedule) {
    if (row.period > key) break;
    value = row.closing;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export interface AmortisationPeriod {
  period: string;
  opening: number;
  instalment: number;
  interest: number;
  principal: number;
  closing: number;
}

/** The level monthly instalment for a reducing-balance loan. */
export function emi(principal: number, annualRatePercent: number, tenureMonths: number): number {
  if (tenureMonths <= 0) return 0;
  const r = annualRatePercent / 100 / 12;
  // A zero-interest loan is just the principal divided by the term; the
  // general formula divides by zero there.
  if (r === 0) return round2(principal / tenureMonths);
  const factor = Math.pow(1 + r, tenureMonths);
  return round2((principal * r * factor) / (factor - 1));
}

export function amortisationSchedule(input: {
  principal: number;
  annualRate: number;
  tenureMonths: number;
  startDate: Date;
}): AmortisationPeriod[] {
  const out: AmortisationPeriod[] = [];
  if (input.tenureMonths <= 0 || input.principal <= 0) return out;

  const instalment = emi(input.principal, input.annualRate, input.tenureMonths);
  const r = input.annualRate / 100 / 12;
  let balance = input.principal;

  for (let i = 0; i < input.tenureMonths; i += 1) {
    const d = new Date(Date.UTC(input.startDate.getUTCFullYear(), input.startDate.getUTCMonth() + i, 1));
    const opening = balance;
    const interest = round2(opening * r);
    // The last instalment clears whatever is left, so rounding across the term
    // cannot leave a balance outstanding on a loan that has been repaid.
    let principalPart = round2(instalment - interest);
    if (i === input.tenureMonths - 1 || principalPart > opening) principalPart = opening;

    balance = round2(opening - principalPart);
    out.push({
      period: monthKey(d),
      opening,
      instalment: round2(principalPart + interest),
      interest,
      principal: principalPart,
      closing: balance,
    });

    if (balance <= 0) break;
  }

  return out;
}

/** What is still owed on a date. */
export function loanBalanceAt(
  input: { principal: number; annualRate: number; tenureMonths: number; startDate: Date },
  asOf: Date,
): number {
  const schedule = amortisationSchedule(input);
  const key = monthKey(asOf);
  let balance = input.principal;
  for (const row of schedule) {
    if (row.period > key) break;
    balance = row.closing;
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

/**
 * How long the cash lasts at the current burn.
 *
 * Returns null when the company is not burning — profitable or break-even —
 * because "infinite runway" is a number that reads as a fact and is not one.
 * A surface should say "not burning" rather than print ∞.
 *
 * Overdrawn returns 0, not a negative. A negative runway would render as
 * "-4.2 months", which reads as a quantity of time and is not one: the money
 * has already run out, and how far past the line the company is is a different
 * number with a different name.
 */
export function runwayMonths(cashOnHand: number, monthlyNetBurn: number): number | null {
  if (monthlyNetBurn <= 0) return null;
  if (cashOnHand <= 0) return 0;
  return round2(cashOnHand / monthlyNetBurn);
}
