/**
 * Technology workstream `itsm` — incidents, problems and changes
 * (docs/plan/cio.md, workstream E).
 *
 * Pure here: the three lifecycle machines (so a button on a screen can never
 * render a transition the API would refuse) and the arithmetic MTTR, change
 * success rate and freeze-window checks need — none of it touches the
 * database, all of it is exercised directly by unit tests.
 */

import { createMachine, type Machine } from '../hr.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const IT_INCIDENT_SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export type ItIncidentSeverity = (typeof IT_INCIDENT_SEVERITIES)[number];

export type ItIncidentState = 'declared' | 'acknowledged' | 'mitigated' | 'resolved' | 'closed';
export type ItIncidentEvent = 'ACKNOWLEDGE' | 'MITIGATE' | 'RESOLVE' | 'CLOSE';

export type ItProblemState = 'open' | 'analysing' | 'known_error' | 'resolved' | 'closed';
export type ItProblemEvent = 'ANALYSE' | 'MARK_KNOWN_ERROR' | 'RESOLVE' | 'REOPEN' | 'CLOSE';

export const IT_CHANGE_KINDS = ['standard', 'normal', 'emergency'] as const;
export type ItChangeKind = (typeof IT_CHANGE_KINDS)[number];

export const IT_CHANGE_RISKS = ['low', 'medium', 'high'] as const;
export type ItChangeRisk = (typeof IT_CHANGE_RISKS)[number];

export type ItChangeState =
  | 'draft' | 'submitted' | 'approved' | 'scheduled' | 'implemented'
  | 'reviewed' | 'failed' | 'rolled_back' | 'rejected';
export type ItChangeEvent = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'SCHEDULE' | 'IMPLEMENT' | 'FAIL' | 'REVIEW' | 'ROLLBACK';

// ---------------------------------------------------------------------------
// Lifecycle machines
// ---------------------------------------------------------------------------

/** Diagram: declared -> acknowledged -> mitigated -> resolved -> closed.
 * A second `acknowledge` (or any repeat of a stamp-setting transition) is not
 * a transition the machine has from a state that already left it, so
 * `platform/lifecycle.transition` refuses it as a 422/409 (IT-INC-001). */
export const itIncidentMachine: Machine<ItIncidentState, ItIncidentEvent> = createMachine('ItIncident', {
  declared: { ACKNOWLEDGE: 'acknowledged' },
  acknowledged: { MITIGATE: 'mitigated' },
  mitigated: { RESOLVE: 'resolved' },
  resolved: { CLOSE: 'closed' },
  closed: {},
});

export const ITSM_INCIDENT_VERBS: Record<ItIncidentEvent, string> = {
  ACKNOWLEDGE: 'acknowledged',
  MITIGATE: 'mitigated',
  RESOLVE: 'resolved',
  CLOSE: 'closed',
};

/** open -> analysing -> known_error|resolved -> closed, with `REOPEN` from a
 * resolved problem back to analysing (a fix that did not hold). */
export const itProblemMachine: Machine<ItProblemState, ItProblemEvent> = createMachine('ItProblem', {
  open: { ANALYSE: 'analysing' },
  analysing: { MARK_KNOWN_ERROR: 'known_error', RESOLVE: 'resolved' },
  known_error: { RESOLVE: 'resolved' },
  resolved: { CLOSE: 'closed', REOPEN: 'analysing' },
  closed: {},
});

export const ITSM_PROBLEM_VERBS: Record<ItProblemEvent, string> = {
  ANALYSE: 'analysing',
  MARK_KNOWN_ERROR: 'known_error',
  RESOLVE: 'resolved',
  REOPEN: 'reopened',
  CLOSE: 'closed',
};

/** draft -> submitted -> approved -> scheduled -> implemented -> reviewed,
 * with the two off-ramps (failed at implementation, rolled_back after) and
 * the two refusal ramps (rejected at submission). Standard changes skip
 * `APPROVE` entirely — the service auto-applies it on submit. */
export const itChangeMachine: Machine<ItChangeState, ItChangeEvent> = createMachine('ItChange', {
  draft: { SUBMIT: 'submitted' },
  submitted: { APPROVE: 'approved', REJECT: 'rejected' },
  approved: { SCHEDULE: 'scheduled' },
  scheduled: { IMPLEMENT: 'implemented', FAIL: 'failed' },
  implemented: { REVIEW: 'reviewed', ROLLBACK: 'rolled_back' },
  reviewed: {},
  failed: {},
  rolled_back: {},
  rejected: {},
});

export const ITSM_CHANGE_VERBS: Record<ItChangeEvent, string> = {
  SUBMIT: 'submitted',
  APPROVE: 'approved',
  REJECT: 'rejected',
  SCHEDULE: 'scheduled',
  IMPLEMENT: 'implemented',
  FAIL: 'failed',
  REVIEW: 'reviewed',
  ROLLBACK: 'rolled_back',
};

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

/** Mean time to recovery, in minutes, over resolved incidents only. `null`
 * with none — never zero, and never averaged over rows still open. */
export function mttrMinutes(rows: Array<{ detectedAt: Date | string; resolvedAt: Date | string | null }>): number | null {
  const resolved = rows.filter((r) => r.resolvedAt != null);
  if (resolved.length === 0) return null;
  const totalMinutes = resolved.reduce((sum, r) => {
    const detected = new Date(r.detectedAt).getTime();
    const closed = new Date(r.resolvedAt as Date | string).getTime();
    return sum + Math.max(0, closed - detected) / 60_000;
  }, 0);
  return totalMinutes / resolved.length;
}

/** The fraction of changes that landed clean, counting only changes that
 * reached a review-eligible outcome (`reviewed`, `failed`, `rolled_back`) —
 * a change still `scheduled` or `draft` says nothing about success yet.
 * `null` with no counted rows. */
export function changeSuccessRate(rows: Array<{ status: string }>): number | null {
  const counted = rows.filter((r) => r.status === 'reviewed' || r.status === 'failed' || r.status === 'rolled_back');
  if (counted.length === 0) return null;
  const successful = counted.filter((r) => r.status === 'reviewed').length;
  return successful / counted.length;
}

export interface ItFreezeWindow {
  name: string;
  startsAt: Date | string;
  endsAt: Date | string;
  allowEmergency: boolean;
}

/**
 * The freeze in force at `at`, or `null`. An emergency change passes through
 * a freeze that declares `allowEmergency`; every other kind (standard or
 * normal) is blocked by any freeze covering the moment.
 */
export function isInFreeze(freezes: ItFreezeWindow[], at: Date | string, kind: ItChangeKind): ItFreezeWindow | null {
  const t = new Date(at).getTime();
  for (const f of freezes) {
    const start = new Date(f.startsAt).getTime();
    const end = new Date(f.endsAt).getTime();
    if (t >= start && t <= end) {
      if (kind === 'emergency' && f.allowEmergency) continue;
      return f;
    }
  }
  return null;
}
