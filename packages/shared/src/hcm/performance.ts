/**
 * HCM — WS5 performance (docs/hcm/performance.md).
 *
 * Review cycles and talent management. This sits alongside — never
 * replaces — the Goal/PerformanceEvidence pair already in `hr.ts` and
 * `domains/performance.ts`: those are the continuous, append-only record of
 * what a person did; this is the periodic reading of it (review cycles,
 * calibration, final ratings) plus the ongoing talent processes (feedback,
 * 1:1s, PIPs, succession) that sit around it.
 */

export const HCM_PERFORMANCE_MODULE = 'performance' as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const REVIEW_CYCLE_KINDS = ['annual', 'half', 'quarter', 'probation'] as const;
export type ReviewCycleKind = (typeof REVIEW_CYCLE_KINDS)[number];

/** Fixed order — a cycle only ever moves forward, one phase at a time. */
export const REVIEW_CYCLE_PHASES = ['self', 'manager', 'calibration', 'closed'] as const;
export type ReviewCyclePhase = (typeof REVIEW_CYCLE_PHASES)[number];

export const REVIEW_ASSIGNMENT_KINDS = ['self', 'manager', 'peer', 'upward', 'skip'] as const;
export type ReviewAssignmentKind = (typeof REVIEW_ASSIGNMENT_KINDS)[number];

export const FEEDBACK_KINDS = ['praise', 'constructive'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_VISIBILITIES = ['private', 'manager', 'public'] as const;
export type FeedbackVisibility = (typeof FEEDBACK_VISIBILITIES)[number];

export const PIP_OUTCOMES = ['open', 'successful', 'extended', 'exited'] as const;
export type PipOutcome = (typeof PIP_OUTCOMES)[number];

export const READINESS_LEVELS = ['now', '1yr', '2yr'] as const;
export type ReadinessLevel = (typeof READINESS_LEVELS)[number];

export const POTENTIAL_LEVELS = ['low', 'medium', 'high'] as const;
export type PotentialLevel = (typeof POTENTIAL_LEVELS)[number];

export const ONE_ON_ONE_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type OneOnOneStatus = (typeof ONE_ON_ONE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Phase order
// ---------------------------------------------------------------------------

/** The phase a cycle in `from` advances to next, or null once closed. */
export function nextPhase(from: ReviewCyclePhase): ReviewCyclePhase | null {
  const i = REVIEW_CYCLE_PHASES.indexOf(from);
  if (i < 0 || i === REVIEW_CYCLE_PHASES.length - 1) return null;
  return REVIEW_CYCLE_PHASES[i + 1];
}

/** A cycle may only ever step to the very next phase in the fixed order. */
export function canAdvancePhase(from: ReviewCyclePhase, to: ReviewCyclePhase): boolean {
  return nextPhase(from) === to;
}

export function isCycleClosed(phase: ReviewCyclePhase): boolean {
  return phase === 'closed';
}

// ---------------------------------------------------------------------------
// Reviewer / self-dealing rule
// ---------------------------------------------------------------------------

/**
 * A reviewer never reviews themselves except on the self form: `kind ===
 * 'self'` requires the reviewer and subject to be the same person; every
 * other kind requires them to differ.
 */
export function isValidReviewerAssignment(
  kind: ReviewAssignmentKind,
  subjectPartyId: string,
  reviewerPartyId: string,
): boolean {
  const same = subjectPartyId === reviewerPartyId;
  return kind === 'self' ? same : !same;
}

// ---------------------------------------------------------------------------
// Nine-box
// ---------------------------------------------------------------------------

/** A 1-5 rating collapses to the three-tier band the 9-box grid uses. */
export function ratingTier(rating: number): PotentialLevel {
  if (rating >= 4) return 'high';
  if (rating >= 3) return 'medium';
  return 'low';
}

export interface NineBoxCell {
  row: 0 | 1 | 2; // potential: 0 = low, 2 = high
  col: 0 | 1 | 2; // performance: 0 = low, 2 = high
  label: string;
}

const NINE_BOX_LABELS: string[][] = [
  ['Risk', 'Inconsistent', 'Enigma'],
  ['Average performer', 'Core player', 'Growth potential'],
  ['Solid performer', 'High performer', 'Star'],
];

const TIER_INDEX: Record<PotentialLevel, 0 | 1 | 2> = { low: 0, medium: 1, high: 2 };

/** The 9-box cell for a performance tier (from a rating) × a potential tier. */
export function nineBoxCell(performance: PotentialLevel, potential: PotentialLevel): NineBoxCell {
  const col = TIER_INDEX[performance];
  const row = TIER_INDEX[potential];
  return { row, col, label: NINE_BOX_LABELS[row][col] };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/** The rule stated in the plan, made checkable: a rating is visible to the
 * employee themselves only once the cycle is closed AND the row released. */
export function isRatingVisibleToSubject(cyclePhase: ReviewCyclePhase, released: boolean): boolean {
  return isCycleClosed(cyclePhase) && released;
}

// ---------------------------------------------------------------------------
// PIP
// ---------------------------------------------------------------------------

export function pipDurationDays(startsOn: Date, endsOn: Date): number {
  return Math.max(0, Math.round((endsOn.getTime() - startsOn.getTime()) / 86_400_000));
}

/** A PIP may be closed by anyone but the person it is about — corrective
 * process, not financial, but the Self-Dealing Bar applies just the same. */
export function canClosePip(subjectPartyId: string, closerPartyId: string): boolean {
  return subjectPartyId !== closerPartyId;
}

/** A final rating may be released by anyone but the subject themselves. */
export function canReleaseRating(subjectPartyId: string, releaserPartyId: string): boolean {
  return subjectPartyId !== releaserPartyId;
}
