/**
 * HCM — leavepolicy (docs/hcm/leavepolicy.md). Mounted at /api/hcm/leavepolicy.
 *
 * Pure arithmetic and validation shapes shared between the API and the web.
 * Nothing here touches the database — every function takes the facts it
 * needs as arguments, the same discipline compliance/labour.ts keeps for
 * holiday-aware leave counting, which this module extends rather than
 * duplicates: `effectiveLeaveDays` composes with a caller-supplied working-day
 * count instead of recomputing one.
 */

export const HCM_LEAVEPOLICY_MODULE = 'leavepolicy' as const;

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

export const ACCRUAL_FREQUENCIES = ['monthly', 'quarterly', 'yearly', 'none'] as const;
export type AccrualFrequency = (typeof ACCRUAL_FREQUENCIES)[number];

/** How many accrual events a frequency fires per year — `none` fires zero. */
export const ACCRUAL_PERIODS_PER_YEAR: Record<AccrualFrequency, number> = {
  monthly: 12,
  quarterly: 4,
  yearly: 1,
  none: 0,
};

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * The per-period credit a policy would need to reach an annual entitlement —
 * a suggestion the rule-editing screen offers, not a value the accrual job
 * itself uses (the job credits `LeavePolicyRule.accrualDays` as configured,
 * since a rule may deliberately credit a round number rather than an exact
 * fraction).
 */
export function suggestedAccrualDays(annualEntitlementDays: number, frequency: AccrualFrequency): number {
  const periods = ACCRUAL_PERIODS_PER_YEAR[frequency];
  return periods === 0 ? 0 : round2(annualEntitlementDays / periods);
}

function daysBetweenInclusive(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

/**
 * Pro-rated accrual for one period: the credit a full period would earn,
 * scaled by the fraction of the period the employment was active for. Used
 * for `prorateOnJoin` (the employment's `hireEffectiveDate` falls inside the
 * period) and, symmetrically, for a separation mid-period.
 */
export function proratedAccrual(
  periodDays: number,
  periodStart: Date,
  periodEnd: Date,
  activeFrom: Date,
  activeTo: Date | null,
): number {
  const clampedFrom = activeFrom > periodStart ? activeFrom : periodStart;
  const clampedTo = activeTo && activeTo < periodEnd ? activeTo : periodEnd;
  if (clampedTo < clampedFrom) return 0;
  const totalDays = daysBetweenInclusive(periodStart, periodEnd);
  const activeDays = daysBetweenInclusive(clampedFrom, clampedTo);
  return round2(periodDays * (activeDays / totalDays));
}

/**
 * What a balance may actually be credited without breaching a rule's cap —
 * the difference between the cap and the balance already standing, floored
 * at zero. `maxBalanceDays` of `null` means uncapped.
 */
export function creditableWithinCap(currentBalance: number, proposedCredit: number, maxBalanceDays: number | null): number {
  if (maxBalanceDays == null) return round2(proposedCredit);
  return round2(Math.max(0, Math.min(proposedCredit, maxBalanceDays - currentBalance)));
}

/** The `[start, end)` a period key spans, for the frequency it was issued under. `period` is `YYYY-MM`, `YYYY-Q<n>` or `YYYY`. */
export function parseAccrualPeriod(frequency: AccrualFrequency, period: string): { start: Date; end: Date } {
  if (frequency === 'monthly') {
    const [y, m] = period.split('-').map(Number);
    if (!y || !m) throw new Error(`"${period}" is not a YYYY-MM period.`);
    return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
  }
  if (frequency === 'quarterly') {
    const match = /^(\d{4})-Q([1-4])$/.exec(period);
    if (!match) throw new Error(`"${period}" is not a YYYY-Q# period.`);
    const y = Number(match[1]);
    const q = Number(match[2]);
    return { start: new Date(Date.UTC(y, (q - 1) * 3, 1)), end: new Date(Date.UTC(y, q * 3, 1)) };
  }
  // yearly / none
  const y = Number(period);
  if (!y) throw new Error(`"${period}" is not a YYYY period.`);
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
}

// ---------------------------------------------------------------------------
// Sandwich day counting
// ---------------------------------------------------------------------------

/**
 * The plain calendar span, inclusive, ignoring weekly-offs and holidays — what
 * a sandwich rule charges instead of the working-day count. Taking Friday and
 * Monday off under a sandwich rule costs four days, not two: the intervening
 * Saturday and Sunday are treated as leave rather than as free rest days.
 */
export function calendarSpanDays(start: Date, end: Date): number {
  return Math.max(1, daysBetweenInclusive(start, end));
}

/**
 * Extends `workingDayCount` (compliance/labour.ts) with the sandwich rule: the
 * charged length of a request is the full calendar span when the rule applies,
 * and the holiday/weekend-excluding working-day count otherwise.
 */
export function effectiveLeaveDays(start: Date, end: Date, workingDays: number, sandwichRule: boolean): number {
  return sandwichRule ? calendarSpanDays(start, end) : workingDays;
}

// ---------------------------------------------------------------------------
// Validation of a request against a policy rule
// ---------------------------------------------------------------------------

export const RESTRICTED_HOLIDAY_ANNUAL_LIMIT = 2;

export interface PolicyRuleFacts {
  accrualFrequency: AccrualFrequency;
  accrualDays: number;
  prorateOnJoin: boolean;
  maxBalanceDays: number | null;
  carryForwardCapDays: number | null;
  negativeAllowed: boolean;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
  sandwichRule: boolean;
  requiresDocumentAfterDays: number | null;
  /** `null` (or `'any'`) applies to everybody. */
  applicableGender: string | null;
}

export interface LeaveRequestFacts {
  startDate: Date;
  endDate: Date;
  workingDays: number;
  submittedAt: Date;
  availableDays: number;
  gender?: string | null;
  hasDocument?: boolean;
}

export interface PolicyViolation {
  code: string;
  message: string;
}

export interface PolicyValidationResult {
  ok: boolean;
  violations: PolicyViolation[];
  effectiveDays: number;
  documentRequired: boolean;
}

/**
 * Validates a leave request's facts against one policy rule, returning true
 * statements about what is wrong — never a blanket "not allowed" — so a
 * surface can show the employee exactly what to fix.
 */
export function validateLeaveRequestAgainstPolicy(rule: PolicyRuleFacts, facts: LeaveRequestFacts): PolicyValidationResult {
  const violations: PolicyViolation[] = [];
  const effectiveDays = effectiveLeaveDays(facts.startDate, facts.endDate, facts.workingDays, rule.sandwichRule);

  if (rule.minNoticeDays > 0) {
    const noticeDays = Math.floor((facts.startDate.getTime() - facts.submittedAt.getTime()) / 86_400_000);
    if (noticeDays < rule.minNoticeDays) {
      violations.push({
        code: 'min_notice',
        message: `This policy needs ${rule.minNoticeDays} days' notice; the request gives ${Math.max(0, noticeDays)}.`,
      });
    }
  }

  if (rule.maxConsecutiveDays != null && effectiveDays > rule.maxConsecutiveDays) {
    violations.push({
      code: 'max_consecutive',
      message: `This policy caps a single request at ${rule.maxConsecutiveDays} days; this one is ${effectiveDays}.`,
    });
  }

  if (!rule.negativeAllowed && round2(facts.availableDays - effectiveDays) < 0) {
    violations.push({
      code: 'insufficient_balance',
      message: `Only ${facts.availableDays} days are available; this policy does not allow a negative balance.`,
    });
  }

  if (rule.applicableGender && rule.applicableGender !== 'any' && facts.gender && facts.gender !== rule.applicableGender) {
    violations.push({
      code: 'gender_not_applicable',
      message: `This leave type applies to ${rule.applicableGender} employees only.`,
    });
  }

  const documentRequired = rule.requiresDocumentAfterDays != null && effectiveDays > rule.requiresDocumentAfterDays;
  if (documentRequired && facts.hasDocument === false) {
    violations.push({
      code: 'document_required',
      message: `A supporting document is required beyond ${rule.requiresDocumentAfterDays} days; none is attached.`,
    });
  }

  return { ok: violations.length === 0, violations, effectiveDays, documentRequired };
}
