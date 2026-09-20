/**
 * HCM — WS7 compensation (docs/hcm/compensation.md).
 *
 * Pure logic only: compa-ratio, an EMI amortisation schedule, a revision
 * cycle's budget check, and variable-pay formula evaluation. Nothing here
 * touches a database or a request context — the domain layer supplies the
 * numbers, this module only does the arithmetic, so the arithmetic can be
 * tested without a tenant.
 */

export const HCM_COMPENSATION_MODULE = 'compensation' as const;

// ---------------------------------------------------------------------------
// Compa-ratio — a person's current pay against the grade midpoint.
// ---------------------------------------------------------------------------

export type CompaBand = 'below_range' | 'below_mid' | 'at_mid' | 'above_mid' | 'above_range';

/** Ratio of current pay to the grade midpoint, or null when there is no midpoint to compare against. */
export function compaRatio(currentCtc: number, midPay: number): number | null {
  if (!(midPay > 0)) return null;
  return currentCtc / midPay;
}

/**
 * Where a compa-ratio sits, in words rather than a bare decimal — 0.95 reads
 * as "below mid" on a screen, not as a number somebody has to interpret.
 * Bands are the conventional ±10% window around the range edges and 1.0.
 */
export function compaBand(ratio: number, minPay: number, midPay: number, maxPay: number): CompaBand {
  const minRatio = midPay > 0 ? minPay / midPay : 0;
  const maxRatio = midPay > 0 ? maxPay / midPay : Infinity;
  if (ratio < minRatio) return 'below_range';
  if (ratio > maxRatio) return 'above_range';
  if (ratio < 0.95) return 'below_mid';
  if (ratio > 1.05) return 'above_mid';
  return 'at_mid';
}

// ---------------------------------------------------------------------------
// EMI amortisation schedule — reducing balance, equal monthly instalments.
// ---------------------------------------------------------------------------

export interface EmiInstalment {
  month: number;
  emi: number;
  principalComponent: number;
  interestComponent: number;
  balance: number;
}

export interface EmiSchedule {
  emi: number;
  totalInterest: number;
  totalPayable: number;
  instalments: EmiInstalment[];
}

/** Rounds to paise-safe 2dp so a schedule never carries a fraction of a rupee that cannot be paid. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * A standard reducing-balance EMI schedule. `annualInterestPct` is the
 * nominal annual rate; the monthly rate is `annualInterestPct / 1200`. A
 * zero-interest loan (a common employee-benefit shape) divides principal
 * evenly across the tenure instead of dividing by zero.
 */
export function emiSchedule(principal: number, annualInterestPct: number, tenureMonths: number): EmiSchedule {
  if (principal <= 0 || tenureMonths <= 0) {
    return { emi: 0, totalInterest: 0, totalPayable: 0, instalments: [] };
  }
  const r = annualInterestPct / 1200;
  const emi = r === 0 ? round2(principal / tenureMonths) : round2((principal * r * (1 + r) ** tenureMonths) / ((1 + r) ** tenureMonths - 1));

  let balance = principal;
  const instalments: EmiInstalment[] = [];
  for (let month = 1; month <= tenureMonths; month += 1) {
    const interestComponent = round2(balance * r);
    let principalComponent = round2(emi - interestComponent);
    // The final instalment absorbs any rounding drift so the schedule closes
    // exactly at zero rather than leaving a stray paise balance forever.
    if (month === tenureMonths) principalComponent = round2(balance);
    balance = round2(balance - principalComponent);
    instalments.push({ month, emi: round2(principalComponent + interestComponent), principalComponent, interestComponent, balance: Math.max(balance, 0) });
  }
  const totalInterest = round2(instalments.reduce((sum, i) => sum + i.interestComponent, 0));
  const totalPayable = round2(principal + totalInterest);
  return { emi, totalInterest, totalPayable, instalments };
}

// ---------------------------------------------------------------------------
// Salary revision cycle budget check.
// ---------------------------------------------------------------------------

export interface RevisionLineTotals {
  currentCtc: number;
  proposedCtc: number;
}

export interface RevisionBudgetResult {
  totalCurrent: number;
  totalProposed: number;
  increaseAmount: number;
  increasePct: number;
  budgetPct: number;
  withinBudget: boolean;
}

/** Whether a cycle's proposed lines, in aggregate, sit within its declared budget percentage. */
export function revisionBudgetCheck(lines: RevisionLineTotals[], budgetPct: number): RevisionBudgetResult {
  const totalCurrent = round2(lines.reduce((sum, l) => sum + l.currentCtc, 0));
  const totalProposed = round2(lines.reduce((sum, l) => sum + l.proposedCtc, 0));
  const increaseAmount = round2(totalProposed - totalCurrent);
  const increasePct = totalCurrent > 0 ? round2((increaseAmount / totalCurrent) * 100) : 0;
  return { totalCurrent, totalProposed, increaseAmount, increasePct, budgetPct, withinBudget: increasePct <= budgetPct };
}

// ---------------------------------------------------------------------------
// Variable pay formulas.
// ---------------------------------------------------------------------------

export type VariablePayFormula =
  | { type: 'percentage_of_base'; pct: number }
  | { type: 'fixed'; amount: number }
  | { type: 'tiered'; tiers: Array<{ upTo: number | null; pct: number }> };

/**
 * Evaluates a variable-pay formula against a base figure (annual CTC, target
 * bonus base, or whatever the plan names as its base). `tiered` applies the
 * percentage of the highest tier whose `upTo` the base falls at or under, the
 * last tier's `upTo: null` acting as the open-ended top band.
 */
export function computeVariablePayout(base: number, formula: VariablePayFormula): number {
  if (base < 0) return 0;
  switch (formula.type) {
    case 'fixed':
      return round2(Math.max(formula.amount, 0));
    case 'percentage_of_base':
      return round2(base * (formula.pct / 100));
    case 'tiered': {
      const sorted = [...formula.tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
      const tier = sorted.find((t) => t.upTo === null || base <= t.upTo) ?? sorted.at(-1);
      return tier ? round2(base * (tier.pct / 100)) : 0;
    }
    default:
      return 0;
  }
}
