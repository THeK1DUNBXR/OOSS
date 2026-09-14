/**
 * ESOP (bounded context `eqt`) — equity-portal plan §5/§6, phase 5.
 *
 * Pure vocabulary and the tranche arithmetic Rule 12 constrains, kept here for
 * the same reason `equity.ts` is: the domain function that generates a grant's
 * tranches and the screen that previews them before submission must agree.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ESOP_PLAN_STATUSES = ['draft', 'active', 'closed'] as const;
export type EsopPlanStatus = (typeof ESOP_PLAN_STATUSES)[number];

export const VESTING_FREQUENCIES = ['monthly', 'quarterly', 'annual'] as const;
export type VestingFrequency = (typeof VESTING_FREQUENCIES)[number];

export const VESTING_FREQUENCY_MONTHS: Record<VestingFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

export const OPTION_GRANT_STATUSES = [
  'proposed', 'granted', 'partly_vested', 'fully_vested', 'exercised', 'lapsed', 'cancelled',
] as const;
export type OptionGrantStatus = (typeof OPTION_GRANT_STATUSES)[number];

export const VESTING_EVENT_STATUSES = ['scheduled', 'vested', 'lapsed'] as const;
export type VestingEventStatus = (typeof VESTING_EVENT_STATUSES)[number];

export const OPTION_EXERCISE_STATUSES = ['requested', 'approved', 'allotted', 'rejected'] as const;
export type OptionExerciseStatus = (typeof OPTION_EXERCISE_STATUSES)[number];

export const FMV_BASES = ['merchant_banker', 'none'] as const;
export type FmvBasis = (typeof FMV_BASES)[number];

/** Rule 12: the first vesting event may not fall earlier than this many months after the grant date. */
export const ESOP_MIN_CLIFF_MONTHS = 12;

/** Rule 12(4): a single grant at or above this share of issued capital needs its own shareholder resolution. */
export const ESOP_SINGLE_GRANT_RESOLUTION_THRESHOLD_PCT = 1;

/** Rule 3(8): a merchant-banker FMV is usable only within this many days of the exercise request. */
export const ESOP_FMV_VALIDITY_DAYS = 180;

// ---------------------------------------------------------------------------
// Vesting schedules
// ---------------------------------------------------------------------------

export interface VestingScheduleInput {
  cliffMonths: number;
  totalMonths: number;
  frequency: VestingFrequency;
}

export interface VestingTranche {
  /** ISO date. */
  on: string;
  count: number;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Rule 12: the grant is refused, not generated, when the cliff — the first
 * vesting event — falls short of twelve months after the grant date. Checked
 * on the schedule alone, before any date arithmetic, so the reason names the
 * rule rather than a date comparison the caller has to interpret.
 */
export function firstVestingIsRuleTwelveCompliant(schedule: VestingScheduleInput): boolean {
  return schedule.cliffMonths >= ESOP_MIN_CLIFF_MONTHS;
}

/**
 * Materialises a schedule into dated tranches: one at the cliff, then one per
 * period up to (and always including) the total — the last tranche absorbs
 * whatever whole-unit remainder even division leaves, so the tranches always
 * sum to exactly `totalCount`.
 */
export function generateVestingTranches(
  grantedOn: string,
  totalCount: number,
  schedule: VestingScheduleInput,
): VestingTranche[] {
  const periodMonths = VESTING_FREQUENCY_MONTHS[schedule.frequency];
  const months: number[] = [];
  for (let m = schedule.cliffMonths; m < schedule.totalMonths; m += periodMonths) months.push(m);
  months.push(schedule.totalMonths);
  const uniqueMonths = [...new Set(months)].sort((a, b) => a - b);

  const n = uniqueMonths.length;
  const per = Math.floor(totalCount / n);
  const remainder = totalCount - per * n;
  const base = new Date(grantedOn);

  return uniqueMonths.map((mo, i) => ({
    on: addMonths(base, mo).toISOString(),
    count: per + (i === n - 1 ? remainder : 0),
  }));
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

export interface EsopPlanPoolView {
  authorised: number | null;
  granted: number;
  vested: number;
  exercised: number;
  lapsed: number;
  available: number | null;
}

export interface EsopPlanView {
  id: string;
  recordCode: string;
  name: string;
  poolShareClassId: string;
  targetShareClassId: string;
  approvedOn: string | null;
  resolutionRef: string | null;
  mgt14Srn: string | null;
  isDpiitRecognised: boolean;
  exercisePriceDefault: number | null;
  vestingDefault: VestingScheduleInput;
  exerciseWindowMonthsAfterExit: number;
  status: EsopPlanStatus;
  pool?: EsopPlanPoolView;
}

export interface PromoterCheck {
  isPromoterOrPromoterGroup: boolean;
  holdsOver10Pct: boolean;
  dpiitReliefApplied: boolean;
}

export interface OptionGrantView {
  id: string;
  recordCode: string;
  planId: string;
  employmentId: string;
  personId: string;
  personName?: string;
  grantedOn: string;
  count: number;
  exercisePrice: number;
  vesting: { cliffMonths: number; schedule: VestingTranche[] };
  grantLetterRef: string | null;
  status: OptionGrantStatus;
  vested: number;
  exercised: number;
  lapsed: number;
  lapsedOn: string | null;
  lapseReason: string | null;
  exerciseWindowEndsOn: string | null;
  promoterCheck: PromoterCheck;
  resolutionRef: string | null;
  proposedByPartyId: string;
  approvedByPartyId: string | null;
}

export interface OptionExerciseView {
  id: string;
  grantId: string;
  requestedOn: string;
  count: number;
  exercisePrice: number;
  fmvPerShare: number | null;
  fmvBasis: FmvBasis;
  fmvValuationId: string | null;
  perquisite: number | null;
  perquisiteNote: string | null;
  taxDeferred: boolean;
  status: OptionExerciseStatus;
  allotmentTransactionId: string | null;
  paidReference: string | null;
}

/**
 * The plain-words tax line an employee reads on their own grant — never
 * computed twice, so the wording on `myGrants()` and any later screen that
 * quotes it stays the same sentence.
 */
export function esopTaxLine(input: { hasFmv: boolean; taxDeferred: boolean }): string {
  if (!input.hasFmv) {
    return 'No merchant-banker valuation is on record, so the tax figure cannot be shown yet.';
  }
  if (input.taxDeferred) {
    return (
      'On exercise, the difference between the merchant-banker value and your exercise price is deferred ' +
      'under section 192(1C) until the earliest of 48 months after the allotment year, sale, or leaving.'
    );
  }
  return 'On exercise, the difference between the merchant-banker value and your exercise price is taxed as salary in the month of exercise.';
}
