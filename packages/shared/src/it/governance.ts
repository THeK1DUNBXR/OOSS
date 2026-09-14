/**
 * Technology workstream `governance` (docs/plan/cio.md, workstream F).
 *
 * Pure types and arithmetic only — no I/O, no Prisma. `riskScore`, `riskBandFor`,
 * `remediationDueAt` and `acknowledgementRate` are what IT-RSK-001 and
 * IT-FND-001 ask to be tested without a database: the numbers a screen shows
 * come from data passed in, never from a constant buried in domain code.
 *
 * The three lifecycle machines (risk, policy, finding) live here too, the
 * same way `packages/shared/src/hr.ts` keeps its eleven — a machine is pure
 * data plus pure functions, so the same machine decides which buttons a
 * screen renders and which transition the API accepts.
 */

import { createMachine, type Machine } from '../hr.js';

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';
export const RISK_BANDS: RiskBand[] = ['low', 'medium', 'high', 'critical'];

export interface RiskScoringBandRow {
  setId: string;
  band: RiskBand;
  minScore: number;
  effectiveFrom: Date;
}

/** Likelihood x impact, both 1..5, so the score ranges 1..25. */
export function riskScore(likelihood: number, impact: number): number {
  return likelihood * impact;
}

/**
 * Picks the band whose `minScore` is the highest at or below `score`, among
 * the rows passed in (already narrowed to one set — the caller resolves
 * which set is in force). Falls back to the lowest band in the set when the
 * score is below every `minScore`.
 */
export function riskBandFor(score: number, bands: Array<Pick<RiskScoringBandRow, 'band' | 'minScore'>>): RiskBand {
  const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
  let result: RiskBand = sorted[0]?.band ?? 'low';
  for (const row of sorted) {
    if (score >= row.minScore) result = row.band;
  }
  return result;
}

/**
 * Resolves which `setId` is "in force" as of `at`: the set (group of rows
 * sharing an `effectiveFrom`) with the latest `effectiveFrom` at or before
 * `at`. Returns null when nothing has taken effect yet.
 */
export function bandSetInForce(bands: RiskScoringBandRow[], at: Date): string | null {
  const eligible = bands.filter((b) => b.effectiveFrom.getTime() <= at.getTime());
  if (!eligible.length) return null;
  const latest = eligible.reduce((x, y) => (y.effectiveFrom.getTime() > x.effectiveFrom.getTime() ? y : x));
  return latest.setId;
}

// ---------------------------------------------------------------------------
// Remediation SLA
// ---------------------------------------------------------------------------

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export const FINDING_SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

export interface RemediationRuleRow {
  severity: FindingSeverity;
  days: number;
  effectiveFrom: Date;
}

/**
 * The due date for a finding of `severity` created at `createdAt`, from
 * whichever rule for that severity was in force at that moment (the latest
 * `effectiveFrom` at or before `createdAt`). Throws rather than guessing when
 * no rule for the severity has ever taken effect by `createdAt` — a finding
 * with no SLA is a defect in the seed, not a silent default.
 */
export function remediationDueAt(createdAt: Date, severity: FindingSeverity, rules: RemediationRuleRow[]): Date {
  const eligible = rules.filter((r) => r.severity === severity && r.effectiveFrom.getTime() <= createdAt.getTime());
  if (!eligible.length) {
    throw new Error(`No remediation rule for severity '${severity}' is in force as of ${createdAt.toISOString()}.`);
  }
  const rule = eligible.reduce((x, y) => (y.effectiveFrom.getTime() > x.effectiveFrom.getTime() ? y : x));
  const due = new Date(createdAt);
  due.setUTCDate(due.getUTCDate() + rule.days);
  return due;
}

// ---------------------------------------------------------------------------
// Policy acknowledgement
// ---------------------------------------------------------------------------

/**
 * The share of a target audience that has acknowledged, or null when there
 * is no target (nobody published yet, or nobody in scope) — IT-POL-002's
 * "not yet measured" is this, never a divide-by-zero 0 or a false 100.
 */
export function acknowledgementRate(acknowledgedCount: number, targetCount: number): number | null {
  if (targetCount <= 0) return null;
  return acknowledgedCount / targetCount;
}

// ---------------------------------------------------------------------------
// Lifecycle machines
// ---------------------------------------------------------------------------

export type RiskState = 'open' | 'treating' | 'accepted' | 'closed';
export type RiskEvent = 'START_TREATING' | 'ACCEPT' | 'CLOSE' | 'REOPEN';

export const riskMachine: Machine<RiskState, RiskEvent> = createMachine('ItRisk', {
  open: { START_TREATING: 'treating', ACCEPT: 'accepted', CLOSE: 'closed' },
  treating: { ACCEPT: 'accepted', CLOSE: 'closed' },
  accepted: { CLOSE: 'closed' },
  closed: { REOPEN: 'open' },
});

export const RISK_TRANSITION_VERBS: Record<RiskEvent, string> = {
  START_TREATING: 'started_treating',
  ACCEPT: 'accepted',
  CLOSE: 'closed',
  REOPEN: 'reopened',
};

export type PolicyState = 'draft' | 'published' | 'superseded' | 'retired';
export type PolicyEvent = 'PUBLISH' | 'SUPERSEDE' | 'RETIRE';

export const policyMachine: Machine<PolicyState, PolicyEvent> = createMachine('ItPolicyDocument', {
  draft: { PUBLISH: 'published', RETIRE: 'retired' },
  published: { SUPERSEDE: 'superseded', RETIRE: 'retired' },
  superseded: {},
  retired: {},
});

export const POLICY_TRANSITION_VERBS: Record<PolicyEvent, string> = {
  PUBLISH: 'published',
  SUPERSEDE: 'superseded',
  RETIRE: 'retired',
};

export type FindingState = 'open' | 'in_progress' | 'risk_accepted' | 'fixed' | 'verified';
export type FindingEvent = 'START' | 'ACCEPT_RISK' | 'FIX' | 'VERIFY' | 'REOPEN';

export const findingMachine: Machine<FindingState, FindingEvent> = createMachine('ItSecurityFinding', {
  open: { START: 'in_progress', ACCEPT_RISK: 'risk_accepted' },
  in_progress: { FIX: 'fixed', ACCEPT_RISK: 'risk_accepted' },
  fixed: { VERIFY: 'verified', REOPEN: 'in_progress' },
  risk_accepted: { REOPEN: 'in_progress' },
  verified: {},
});

export const FINDING_TRANSITION_VERBS: Record<FindingEvent, string> = {
  START: 'started',
  ACCEPT_RISK: 'risk_accepted',
  FIX: 'fixed',
  VERIFY: 'verified',
  REOPEN: 'reopened',
};

export type AccessReviewState = 'open' | 'in_progress' | 'closed';
export type AccessReviewEvent = 'START_PROGRESS' | 'CLOSE';

export const accessReviewMachine: Machine<AccessReviewState, AccessReviewEvent> = createMachine('ItAccessReview', {
  open: { START_PROGRESS: 'in_progress', CLOSE: 'closed' },
  in_progress: { CLOSE: 'closed' },
  closed: {},
});

export const ACCESS_REVIEW_TRANSITION_VERBS: Record<AccessReviewEvent, string> = {
  START_PROGRESS: 'started',
  CLOSE: 'closed',
};

// ---------------------------------------------------------------------------
// Ladder rungs
// ---------------------------------------------------------------------------

/** Days-before-due (positive) and days-after (negative) for a review-style
 * overdue ladder — shared by the risk review job and the access-review
 * campaign overdue job. */
export const GOVERNANCE_LADDER_RUNGS = [30, 7, 1, 0, -1, -7] as const;

/** Severity-scaled rungs for the finding overdue ladder: a critical finding
 * is warned sooner, relative to its own (short) SLA, than a low one. */
export const FINDING_LADDER_RUNGS: Record<FindingSeverity, readonly number[]> = {
  critical: [3, 1, 0, -1],
  high: [7, 3, 0, -1],
  medium: [14, 3, 0, -3],
  low: [30, 7, 0, -7],
};
