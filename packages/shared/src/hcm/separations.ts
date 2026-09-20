/**
 * HCM — J. Separations & exit management (docs/hcm/separations.md).
 *
 * Pure logic only: nothing here touches a database or a request context.
 * The domain layer (`apps/api/src/domains/hcm/separations.ts`) is what wires
 * this to Prisma, the event bus and the employment lifecycle machine.
 */

export const HCM_SEPARATIONS_MODULE = 'separations' as const;

// ---------------------------------------------------------------------------
// Resignation
// ---------------------------------------------------------------------------

export const RESIGNATION_REASON_CATEGORIES = [
  'personal', 'career_growth', 'compensation', 'relocation', 'health', 'conduct', 'other',
] as const;
export type ResignationReasonCategory = (typeof RESIGNATION_REASON_CATEGORIES)[number];

export const RESIGNATION_STATES = ['submitted', 'accepted', 'withdrawn', 'rejected'] as const;
export type ResignationState = (typeof RESIGNATION_STATES)[number];

/**
 * The transitions a resignation itself may take, distinct from what it does
 * to the employment relationship it rides on. `submitted` is the only state
 * with outbound arrows — once accepted, withdrawn or rejected, the record is
 * closed; a change of mind after that is a fresh resignation, not a reopened
 * one.
 */
export const RESIGNATION_TRANSITIONS: Record<ResignationState, ResignationState[]> = {
  submitted: ['accepted', 'withdrawn', 'rejected'],
  accepted: [],
  withdrawn: [],
  rejected: [],
};

export function canTransitionResignation(from: ResignationState, to: ResignationState): boolean {
  return RESIGNATION_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Notice policy
// ---------------------------------------------------------------------------

export interface NoticePolicyFact {
  id: string;
  grade: string | null;
  engagementType: string | null;
  noticeDays: number;
  buyoutAllowed: boolean;
  active: boolean;
}

/**
 * Picks the most specific active policy for a grade/engagement pair: a row
 * naming both beats one naming only one beats the one naming neither (the
 * fallback everybody else falls through to). Ties are resolved by whichever
 * sorts first — the caller decides the order rows are handed in, typically
 * `createdAt desc` so a newer specific rule wins over an older one at the
 * same specificity.
 */
export function resolveNoticePolicy(
  policies: NoticePolicyFact[],
  grade: string | null,
  engagementType: string | null,
): NoticePolicyFact | null {
  const active = policies.filter((p) => p.active);
  const specificity = (p: NoticePolicyFact): number =>
    (p.grade !== null && p.grade === grade ? 2 : 0) +
    (p.engagementType !== null && p.engagementType === engagementType ? 1 : 0);

  const candidates = active.filter(
    (p) =>
      (p.grade === null || p.grade === grade) &&
      (p.engagementType === null || p.engagementType === engagementType),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) => (specificity(p) > specificity(best) ? p : best));
}

/**
 * Days short of full notice, never negative — a resignation that gives more
 * than the required notice owes nothing back. This is what a buyout amount
 * (basic/30 × shortfall) is computed from downstream; the rate itself is a
 * payroll concern and not repeated here.
 */
export function noticeShortfallDays(noticeDays: number, submittedOn: Date, lastDay: Date): number {
  const servedDays = Math.round((lastDay.getTime() - submittedOn.getTime()) / 86_400_000);
  return Math.max(0, noticeDays - servedDays);
}

// ---------------------------------------------------------------------------
// Exit clearance
// ---------------------------------------------------------------------------

export const CLEARANCE_DEPARTMENTS = ['it', 'finance', 'admin', 'manager', 'hr'] as const;
export type ClearanceDepartment = (typeof CLEARANCE_DEPARTMENTS)[number];

export const CLEARANCE_STATUSES = ['pending', 'cleared', 'blocked'] as const;
export type ClearanceStatus = (typeof CLEARANCE_STATUSES)[number];

export interface ClearanceRowFact {
  department: string;
  status: string;
}

/** True only when every one of the five departments is present and `cleared` — a department never raised is not vacuously cleared. */
export function allClearancesComplete(rows: ClearanceRowFact[]): boolean {
  return CLEARANCE_DEPARTMENTS.every((dept) => rows.some((r) => r.department === dept && r.status === 'cleared'));
}

/** How many of the five stand blocked — the number a clearance tab leads with. */
export function blockedClearanceCount(rows: ClearanceRowFact[]): number {
  return rows.filter((r) => r.status === 'blocked').length;
}

// ---------------------------------------------------------------------------
// Alumni
// ---------------------------------------------------------------------------

export const ALUMNI_SEPARATION_TYPES = ['resignation', 'termination', 'abandonment'] as const;
