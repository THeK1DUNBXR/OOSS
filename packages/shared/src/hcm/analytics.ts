/**
 * HCM — WS12 analytics (docs/hcm/analytics.md).
 *
 * Pure, side-effect-free shapes and arithmetic — no Prisma import here, so
 * every formula is unit-testable without a database and the domain layer and
 * the test suite build on exactly the same definitions.
 *
 * Every metric this module ever returns is one of two shapes: `measured`
 * (a value, computed from real rows) or not (`measured: false`, `value:
 * null`, and a human `reason`). A dashboard tile renders those two states
 * distinctly — "not measured yet" is never drawn as a zero.
 */

import { monthKey } from '../finance.js';
export { monthKey };

export const HCM_ANALYTICS_MODULE = 'analytics' as const;

// ---------------------------------------------------------------------------
// The measured/not-measured envelope
// ---------------------------------------------------------------------------

export interface Measured<T> {
  measured: true;
  value: T;
}

export interface NotMeasured {
  measured: false;
  value: null;
  /** Why — insufficient data, a dependent workstream not yet landed, or a
   *  field this schema structurally does not carry. Always a plain sentence. */
  reason: string;
}

export type Metric<T> = Measured<T> | NotMeasured;

export function measured<T>(value: T): Measured<T> {
  return { measured: true, value };
}

export function notMeasured(reason: string): NotMeasured {
  return { measured: false, value: null, reason };
}

// ---------------------------------------------------------------------------
// Reports this workstream exports (auditExport'd CSVs)
// ---------------------------------------------------------------------------

export const ANALYTICS_REPORTS = [
  'headcount_register',
  'attrition_report',
  'leave_liability',
  'overtime_register',
  'training_register',
] as const;
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number];

// ---------------------------------------------------------------------------
// Time buckets
//
// `monthKey` (`YYYY-MM` in UTC, the same shape `PayrollInstruction.payPeriod`
// uses) is `@kaizen/shared`'s `finance.ts` export, imported above and
// re-exported here rather than redefined — one definition instead of two
// that could drift apart.
// ---------------------------------------------------------------------------

/** The `count` trailing month keys ending at (and including) `asOf`'s month, oldest first. */
export function trailingMonths(count: number, asOf: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    out.push(monthKey(new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1))));
  }
  return out;
}

export const TENURE_BUCKETS = ['<1y', '1-3y', '3-5y', '5-10y', '10y+'] as const;
export type TenureBucket = (typeof TENURE_BUCKETS)[number];

/** Whole years of tenure, floor-rounded — the same measure a staff list reports it by. */
export function tenureYears(hireDate: Date, asOf: Date = new Date()): number {
  const ms = asOf.getTime() - hireDate.getTime();
  return Math.max(0, ms / (365.25 * 86_400_000));
}

export function tenureBucket(hireDate: Date, asOf: Date = new Date()): TenureBucket {
  const y = tenureYears(hireDate, asOf);
  if (y < 1) return '<1y';
  if (y < 3) return '1-3y';
  if (y < 5) return '3-5y';
  if (y < 10) return '5-10y';
  return '10y+';
}

// ---------------------------------------------------------------------------
// Headcount, attrition, absenteeism
// ---------------------------------------------------------------------------

/** Monthly compounding rate → the standard basic/26 daily rate used for both overtime and leave encashment on this platform. */
export function dailyRateFromBasic(basicMonthly: number): number {
  return basicMonthly / 26;
}

/**
 * Annualised attrition, the standard HR formula: leavers over the period,
 * divided by average headcount over the period, scaled to a 365-day year so
 * a quarter and a year are comparable. Null (not a formula failure) when
 * there is no headcount to divide by — an empty roster has no attrition
 * rate, not a zero one.
 */
export function annualizedAttritionRate(leavers: number, avgHeadcount: number, periodDays: number): number | null {
  if (avgHeadcount <= 0 || periodDays <= 0) return null;
  return (leavers / avgHeadcount) * (365 / periodDays) * 100;
}

/** A separation inside `thresholdMonths` of the hire date — the "we lost them fast" cut most HR teams track apart from overall attrition. */
export function isEarlyAttrition(hireDate: Date, separationDate: Date, thresholdMonths = 12): boolean {
  const months = (separationDate.getTime() - hireDate.getTime()) / (30.4375 * 86_400_000);
  return months >= 0 && months <= thresholdMonths;
}

/** Share of recorded attendance days with zero worked minutes. Null with no rows to measure against. */
export function absenteeismRate(zeroMinuteDays: number, totalDays: number): number | null {
  if (totalDays <= 0) return null;
  return (zeroMinuteDays / totalDays) * 100;
}

// ---------------------------------------------------------------------------
// Hiring funnel
// ---------------------------------------------------------------------------

/**
 * Offer-accepted share of offers extended (accepted, joined and no-show all
 * count as an acceptance — the candidate said yes). Null with no offers
 * extended. Named distinctly from `recruiting.ts`'s `offerAcceptanceRate`
 * (accepted-of-decided, a slightly different base) so both can be exported
 * from the same `@kaizen/shared` barrel without a collision.
 */
export function hiringOfferAcceptanceRate(accepted: number, extended: number): number | null {
  if (extended <= 0) return null;
  return (accepted / extended) * 100;
}

/** Average calendar days from a requisition's creation to the resulting hire's effective date. Null with no matched pairs. */
export function averageTimeToHireDays(pairs: Array<{ requisitionCreatedAt: Date; hireEffectiveDate: Date }>): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce(
    (sum, p) => sum + Math.max(0, (p.hireEffectiveDate.getTime() - p.requisitionCreatedAt.getTime()) / 86_400_000),
    0,
  );
  return total / pairs.length;
}

// ---------------------------------------------------------------------------
// Span of control
// ---------------------------------------------------------------------------

export interface SpanOfControlStats {
  managerCount: number;
  averageSpan: number;
  minSpan: number;
  maxSpan: number;
}

/** `counts` is one entry per manager position: how many direct reports it holds. */
export function spanOfControlStats(counts: number[]): SpanOfControlStats | null {
  if (counts.length === 0) return null;
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    managerCount: counts.length,
    averageSpan: total / counts.length,
    minSpan: Math.min(...counts),
    maxSpan: Math.max(...counts),
  };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/** Buckets `values` by `bucketOf`, in the given bucket order — a histogram with every named bucket present, even at zero. */
export function distribution<T, B extends string>(values: T[], buckets: readonly B[], bucketOf: (v: T) => B): Record<B, number> {
  const out = Object.fromEntries(buckets.map((b) => [b, 0])) as Record<B, number>;
  for (const v of values) out[bucketOf(v)] += 1;
  return out;
}

/** As a list of `{ bucket, count }` in bucket order, rather than a keyed record — the shape a bar chart wants. */
export function distributionList<T, B extends string>(values: T[], buckets: readonly B[], bucketOf: (v: T) => B): Array<{ bucket: B; count: number }> {
  const byBucket = distribution(values, buckets, bucketOf);
  return buckets.map((bucket) => ({ bucket, count: byBucket[bucket] }));
}

// ---------------------------------------------------------------------------
// Compa-ratio buckets (WS7 `PayGrade` vs. an employment's current CTC)
// ---------------------------------------------------------------------------

export const COMP_RATIO_BUCKETS = ['<80%', '80-95%', '95-110%', '110-120%', '>120%'] as const;
export type CompRatioBucket = (typeof COMP_RATIO_BUCKETS)[number];

/** `ratio` is current CTC ÷ grade midpoint, e.g. 0.95 for 95%. */
export function compRatioBucket(ratio: number): CompRatioBucket {
  const pct = ratio * 100;
  if (pct < 80) return '<80%';
  if (pct < 95) return '80-95%';
  if (pct < 110) return '95-110%';
  if (pct < 120) return '110-120%';
  return '>120%';
}

// ---------------------------------------------------------------------------
// Open-case SLA buckets (WS9 `HrCase`)
// ---------------------------------------------------------------------------

export const SLA_BUCKETS = ['Breached', 'Due today', 'Due this week', 'On track'] as const;
export type SlaBucket = (typeof SLA_BUCKETS)[number];

/** `daysToDue` is calendar days until an open case's SLA deadline — negative once it has passed. */
export function slaBucket(daysToDue: number): SlaBucket {
  if (daysToDue < 0) return 'Breached';
  if (daysToDue < 1) return 'Due today';
  if (daysToDue < 7) return 'Due this week';
  return 'On track';
}
