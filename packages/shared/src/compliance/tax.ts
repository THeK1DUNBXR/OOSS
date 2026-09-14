/**
 * Compliance — tax (docs/plan/compliance.md, workstream C): types and pure
 * arithmetic for TDS on vendor payments and salary, shared by API and web.
 *
 * Every rate, threshold and slab is an input here, never a constant baked
 * into the function — the numbers live in a dated table (`TdsSectionRate`,
 * `IncomeTaxSlabTable`) and this module only does the arithmetic once they
 * are known.
 */

import { round2 } from '../finance.js';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const TDS_SECTIONS = [
  '194C_IND',
  '194C_COMP',
  '194J_PROF',
  '194J_TECH',
  '194H',
  '194I_LAND',
  '194I_PLANT',
  '194Q',
  '192',
] as const;
export type TdsSection = (typeof TDS_SECTIONS)[number];

export const TDS_SECTION_LABELS: Record<TdsSection, string> = {
  '194C_IND': '194C — contractor (individual/HUF)',
  '194C_COMP': '194C — contractor (other than individual/HUF)',
  '194J_PROF': '194J — professional fees',
  '194J_TECH': '194J — technical/royalty fees',
  '194H': '194H — commission or brokerage',
  '194I_LAND': '194I — rent of land/building/furniture',
  '194I_PLANT': '194I — rent of plant/machinery',
  '194Q': '194Q — purchase of goods',
  '192': '192 — salary',
};

// ---------------------------------------------------------------------------
// Vendor TDS
// ---------------------------------------------------------------------------

export interface TdsThresholds {
  perTransaction: number;
  perFy: number;
}

export interface ComputeTdsInput {
  /** This payment's taxable value. */
  amount: number;
  /** What has already been paid to the same payee under the same section this FY, before this payment. */
  cumulativeFy: number;
  section: TdsSection;
  /** The section's rate, from the dated table. */
  ratePercent: number;
  thresholds: TdsThresholds;
  /** Whether the payee has furnished a PAN. */
  panPresent: boolean;
  /** Sec 206AA flat rate applied when PAN is missing, whichever is higher. */
  panMissingRatePercent: number;
  /** A lower/nil-deduction certificate (Sec 197) rate, when one applies — overrides the table rate outright. */
  certificateRate?: number | null;
}

export interface ComputeTdsResult {
  applicable: boolean;
  ratePercentApplied: number;
  tdsAmount: number;
  reason: string;
}

/**
 * Whether TDS applies to this payment, and at what rate.
 *
 * A certificate rate, once given, is authoritative — the payee's own
 * assessing officer decided it, and this function does not second-guess it,
 * including a certificate rate of zero (a full waiver). Absent a
 * certificate, deduction turns on the two thresholds: a single payment
 * above the per-transaction line, or the FY's cumulative payments (this one
 * included) crossing the per-FY line, either one is enough — because a
 * payer who deducts nothing every month on the theory that no single
 * payment crossed the line is exactly the case Sec 194C's per-FY threshold
 * exists to catch. Once either threshold is crossed, the whole payment is
 * subject to deduction, not just the excess over the threshold — matching
 * how 194C/194H/194I/194J actually work (194Q is a partial exception in
 * practice via a separate exemption up to 50 lakh cumulative, which this
 * platform does not yet model beyond the FY threshold given here).
 */
export function computeTds(input: ComputeTdsInput): ComputeTdsResult {
  if (input.certificateRate !== undefined && input.certificateRate !== null) {
    const tdsAmount = round2((input.amount * input.certificateRate) / 100);
    return {
      applicable: input.certificateRate > 0,
      ratePercentApplied: input.certificateRate,
      tdsAmount,
      reason:
        input.certificateRate === 0
          ? 'Sec 197 nil-deduction certificate on file.'
          : `Sec 197 lower-deduction certificate: ${input.certificateRate}%.`,
    };
  }

  const cumulativeAfter = round2(input.cumulativeFy + input.amount);
  const overTransaction = input.thresholds.perTransaction > 0 && input.amount >= input.thresholds.perTransaction;
  const overFy = input.thresholds.perFy > 0 && cumulativeAfter >= input.thresholds.perFy;

  if (!overTransaction && !overFy) {
    return {
      applicable: false,
      ratePercentApplied: 0,
      tdsAmount: 0,
      reason: `Below both the per-transaction (₹${input.thresholds.perTransaction}) and per-FY (₹${input.thresholds.perFy}) thresholds for ${input.section}.`,
    };
  }

  const rate = input.panPresent
    ? input.ratePercent
    : Math.max(input.ratePercent, input.panMissingRatePercent);

  return {
    applicable: true,
    ratePercentApplied: rate,
    tdsAmount: round2((input.amount * rate) / 100),
    reason: input.panPresent
      ? overTransaction
        ? `Over the per-transaction threshold for ${input.section}.`
        : `Cumulative FY payments crossed the per-FY threshold for ${input.section}.`
      : `No PAN on file — Sec 206AA flat rate (${input.panMissingRatePercent}%) applied.`,
  };
}

// ---------------------------------------------------------------------------
// Salary TDS (Sec 192)
// ---------------------------------------------------------------------------

export type TaxRegime = 'old' | 'new';

export interface SlabRow {
  /** Income up to this figure is taxed at `ratePercent`; null means "and above". */
  upTo: number | null;
  ratePercent: number;
}

export interface SlabTable {
  regime: TaxRegime;
  slabs: SlabRow[];
  standardDeduction: number;
  rebate87ALimit: number;
  rebate87AMaxAmount: number;
  cessPercent: number;
}

/**
 * Tax on a slab table before cess, before rebate — the ladder computation:
 * each slab's own rate applies only to the income inside that slab.
 */
function slabTax(taxableIncome: number, slabs: SlabRow[]): number {
  let tax = 0;
  let lower = 0;
  for (const row of slabs) {
    const upper = row.upTo ?? Infinity;
    if (taxableIncome <= lower) break;
    const slice = Math.min(taxableIncome, upper) - lower;
    if (slice > 0) tax += (slice * row.ratePercent) / 100;
    lower = upper;
  }
  return tax;
}

/**
 * Annual tax payable under one regime: standard deduction off gross,
 * slab tax on what remains, the Sec 87A rebate applied when taxable income
 * is at or below its limit (zeroing the tax rather than capping it, up to
 * the rebate's own ceiling), then cess on top.
 */
export function computeAnnualTax(regime: TaxRegime, grossIncome: number, slabs: SlabTable): number {
  const taxableIncome = Math.max(0, round2(grossIncome - slabs.standardDeduction));
  let tax = slabTax(taxableIncome, slabs.slabs);

  if (taxableIncome <= slabs.rebate87ALimit) {
    tax = Math.max(0, tax - Math.min(tax, slabs.rebate87AMaxAmount));
  }

  const cess = round2(tax * (slabs.cessPercent / 100));
  return round2(tax + cess);
}

/**
 * What to deduct this month: the annual liability still outstanding, spread
 * evenly across the months remaining in the FY. Never negative — a
 * declaration change mid-year that lowers the liability below what has
 * already been deducted shows as zero this month, not a refund the payroll
 * run would have to reverse.
 */
export function monthlyTds(annualTax: number, monthsRemaining: number, alreadyDeducted: number): number {
  if (monthsRemaining <= 0) return 0;
  const outstanding = Math.max(0, round2(annualTax - alreadyDeducted));
  return round2(outstanding / monthsRemaining);
}

// ---------------------------------------------------------------------------
// Advance tax
// ---------------------------------------------------------------------------

/** 15/45/75/100% by 15 Jun / 15 Sep / 15 Dec / 15 Mar (Sec 211). */
export const ADVANCE_TAX_INSTALMENTS = [
  { label: 'By 15 June', cumulativePercent: 15, month: 6, day: 15 },
  { label: 'By 15 September', cumulativePercent: 45, month: 9, day: 15 },
  { label: 'By 15 December', cumulativePercent: 75, month: 12, day: 15 },
  { label: 'By 15 March', cumulativePercent: 100, month: 3, day: 15 },
] as const;

export interface AdvanceTaxInstalment {
  label: string;
  dueDate: string; // YYYY-MM-DD
  cumulativePercent: number;
  cumulativeDue: number;
  paidSoFar: number;
  outstanding: number;
}

/** fyStartYear is the calendar year the FY starts in, e.g. 2026 for FY2026-27. */
export function advanceTaxSchedule(
  estimatedAnnualTax: number,
  fyStartYear: number,
  paymentsByInstalment: number[],
): AdvanceTaxInstalment[] {
  let paidCumulative = 0;
  return ADVANCE_TAX_INSTALMENTS.map((row, i) => {
    const year = row.month <= 3 ? fyStartYear + 1 : fyStartYear;
    const cumulativeDue = round2((estimatedAnnualTax * row.cumulativePercent) / 100);
    paidCumulative = round2(paidCumulative + (paymentsByInstalment[i] ?? 0));
    return {
      label: row.label,
      dueDate: `${year}-${String(row.month).padStart(2, '0')}-${String(row.day).padStart(2, '0')}`,
      cumulativePercent: row.cumulativePercent,
      cumulativeDue,
      paidSoFar: paidCumulative,
      outstanding: round2(Math.max(0, cumulativeDue - paidCumulative)),
    };
  });
}

// ---------------------------------------------------------------------------
// MSME 43B(h)
// ---------------------------------------------------------------------------

/** The agreed term or 45 days, whichever is shorter, from the bill date. */
export function msmeDueDate(billDate: Date, agreedTermDays: number | null | undefined): Date {
  const days = Math.min(agreedTermDays ?? 45, 45);
  const due = new Date(billDate);
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}
