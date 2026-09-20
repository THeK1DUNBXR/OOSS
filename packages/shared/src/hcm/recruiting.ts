/**
 * HCM — recruiting (docs/hcm/recruiting.md). Mounted at /api/hcm/recruiting.
 *
 * A full ATS on top of the existing Requisition/Application lifecycle
 * machines in `hr.ts` — this file adds the two machines recruiting owns
 * itself (a job posting's publish/close life, and an offer's approve/send/
 * decide life) plus the pure funnel arithmetic: time-to-hire, offer
 * acceptance and source effectiveness. Everything here is pure — no I/O — for
 * the same reason `hr.ts` is: a surface and the API enforcing it read the
 * same diagram, never two copies that can drift.
 */
import { createMachine, type Machine } from '../hr.js';

export const HCM_RECRUITING_MODULE = 'recruiting' as const;

// ---------------------------------------------------------------------------
// Job posting
// ---------------------------------------------------------------------------

export type JobPostingState = 'Draft' | 'Published' | 'Closed' | 'Cancelled';
export type JobPostingEvent = 'PUBLISH' | 'CLOSE' | 'REOPEN' | 'CANCEL';

export const jobPostingMachine: Machine<JobPostingState, JobPostingEvent> = createMachine('JobPosting', {
  Draft: { PUBLISH: 'Published', CANCEL: 'Cancelled' },
  Published: { CLOSE: 'Closed', CANCEL: 'Cancelled' },
  Closed: { REOPEN: 'Published' },
  Cancelled: {},
});

export const JOB_POSTING_EVENT_VERB: Record<JobPostingEvent, string> = {
  PUBLISH: 'published',
  CLOSE: 'closed',
  REOPEN: 'reopened',
  CANCEL: 'cancelled',
};

// ---------------------------------------------------------------------------
// Offer letter — proposer/approver split is enforced by the domain layer
// (Self-Dealing Bar), not by this machine; the machine only says which
// statuses accept which event.
// ---------------------------------------------------------------------------

export type OfferState = 'Draft' | 'ApprovalPending' | 'Approved' | 'Sent' | 'Accepted' | 'Declined' | 'Rescinded';
export type OfferEvent = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'SEND' | 'ACCEPT' | 'DECLINE' | 'RESCIND';

export const offerMachine: Machine<OfferState, OfferEvent> = createMachine('OfferLetter', {
  Draft: { SUBMIT: 'ApprovalPending', RESCIND: 'Rescinded' },
  ApprovalPending: { APPROVE: 'Approved', REJECT: 'Draft' },
  Approved: { SEND: 'Sent', RESCIND: 'Rescinded' },
  Sent: { ACCEPT: 'Accepted', DECLINE: 'Declined', RESCIND: 'Rescinded' },
  Accepted: {},
  Declined: {},
  Rescinded: {},
});

export const OFFER_EVENT_VERB: Record<OfferEvent, string> = {
  SUBMIT: 'submitted',
  APPROVE: 'approved',
  REJECT: 'rejected',
  SEND: 'sent',
  ACCEPT: 'accepted',
  DECLINE: 'declined',
  RESCIND: 'rescinded',
};

// ---------------------------------------------------------------------------
// Interview round
// ---------------------------------------------------------------------------

export type InterviewRoundStatus = 'Scheduled' | 'Completed' | 'Cancelled' | 'NoShow';
export type InterviewOutcome = 'advance' | 'reject' | 'hold';
export type ScorecardRecommendation = 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';

// ---------------------------------------------------------------------------
// Funnel metrics (§9.2.21-style, scoped to recruiting's own records).
// ---------------------------------------------------------------------------

/** Calendar days between a posting going live (or the requisition opening) and the join, rounded to one decimal. */
export function timeToHireDays(openedAt: Date, joinedAt: Date): number {
  const ms = joinedAt.getTime() - openedAt.getTime();
  return Math.round((ms / 86_400_000) * 10) / 10;
}

/** The mean of a set of time-to-hire figures — `null` when there is nothing to average, never zero. */
export function meanTimeToHireDays(days: number[]): number | null {
  if (days.length === 0) return null;
  return Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10;
}

/** Offers accepted over offers decided (accepted + declined + rescinded-after-send). `null` when nothing has been decided yet. */
export function offerAcceptanceRate(accepted: number, decided: number): number | null {
  if (decided <= 0) return null;
  return Math.round((accepted / decided) * 1000) / 10;
}

export interface SourceTally {
  source: string;
  applications: number;
  hired: number;
}

export interface SourceEffectiveness extends SourceTally {
  /** hired / applications as a percentage, one decimal. `null` when the source has no applications yet. */
  hireRate: number | null;
}

/** Which candidate sources actually convert, ranked by hire rate then volume. */
export function sourceEffectiveness(rows: SourceTally[]): SourceEffectiveness[] {
  return rows
    .map((r) => ({
      ...r,
      hireRate: r.applications > 0 ? Math.round((r.hired / r.applications) * 1000) / 10 : null,
    }))
    .sort((a, b) => (b.hireRate ?? -1) - (a.hireRate ?? -1) || b.applications - a.applications);
}

/** The offset-days on a template resolved against a joining date, for the day an onboarding task falls due. */
export function taskDueDate(hireEffectiveDate: Date, offsetDays: number): Date {
  const d = new Date(hireEffectiveDate);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}
