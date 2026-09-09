/**
 * People (bounded context `hr`, plane P2) — Canon §14.
 *
 * The eleven lifecycle state machines of §14.3 and the Capability Intelligence
 * trust model of §14.6, transcribed from the source diagrams. Everything here
 * is pure: no I/O, no persistence, no Prisma. That is what lets the same
 * machine decide which buttons a surface renders and which transition the API
 * will accept, instead of the two drifting apart — and it is what lets the
 * machines be tested against the diagrams without a database.
 *
 * The service layer owns creation transitions ([*] --> X on the diagrams) and
 * every rule that reads more than one record; a machine only answers "may this
 * state take this event, and what does it become".
 */

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  readonly code = 'HR_INVALID_TRANSITION';
  constructor(
    readonly machine: string,
    readonly state: string,
    readonly event: string,
  ) {
    super(`${machine}: ${state} does not accept ${event}.`);
    this.name = 'InvalidTransitionError';
  }
}

export class HrRuleViolationError extends Error {
  readonly code = 'HR_RULE_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'HrRuleViolationError';
  }
}

export type Transitions<S extends string, E extends string> = Partial<Record<S, Partial<Record<E, S>>>>;

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly transitions: Transitions<S, E>;
  can(state: S, event: E): boolean;
  apply(state: S, event: E): S;
  allowedEvents(state: S): E[];
  isTerminal(state: S): boolean;
}

export function createMachine<S extends string, E extends string>(
  name: string,
  transitions: Transitions<S, E>,
): Machine<S, E> {
  const allowedEvents = (state: S): E[] => Object.keys(transitions[state] ?? {}) as E[];
  return {
    name,
    transitions,
    can: (state, event) => transitions[state]?.[event] !== undefined,
    apply(state, event) {
      const next = transitions[state]?.[event];
      if (next === undefined) throw new InvalidTransitionError(name, state, event);
      return next;
    },
    allowedEvents,
    // A terminal state is one the diagram draws with no outbound arrow. It is
    // derived rather than listed, so a state can never be declared terminal
    // and still be given a transition.
    isTerminal: (state) => allowedEvents(state).length === 0,
  };
}

// ---------------------------------------------------------------------------
// Diagram 14.1 — Employment Relationship
// ---------------------------------------------------------------------------

export type EmploymentState =
  | 'PendingHire' | 'OfferRescinded' | 'NoShow' | 'Active' | 'OnLeave'
  | 'Suspended' | 'Terminated' | 'NoticePeriod' | 'Absconded' | 'Alumni';

export type EmploymentEvent =
  | 'RESCIND_OFFER' | 'NO_SHOW' | 'ACTIVATE' | 'START_LEAVE' | 'RETURN_FROM_LEAVE'
  | 'SUSPEND' | 'REINSTATE' | 'TERMINATE_POST_DISCIPLINARY' | 'SUBMIT_RESIGNATION'
  | 'REACH_LAST_WORKING_DAY' | 'ABSENCE_BREACH' | 'EXPLANATION_ACCEPTED'
  | 'ABANDONMENT_CONFIRMED' | 'RETENTION_TRANSITION';

export const employmentRelationshipMachine = createMachine<EmploymentState, EmploymentEvent>(
  'EmploymentRelationship',
  {
    PendingHire: { RESCIND_OFFER: 'OfferRescinded', NO_SHOW: 'NoShow', ACTIVATE: 'Active' },
    Active: {
      START_LEAVE: 'OnLeave', SUSPEND: 'Suspended',
      SUBMIT_RESIGNATION: 'NoticePeriod', ABSENCE_BREACH: 'Absconded',
    },
    OnLeave: { RETURN_FROM_LEAVE: 'Active', SUBMIT_RESIGNATION: 'NoticePeriod', ABSENCE_BREACH: 'Absconded' },
    Suspended: { REINSTATE: 'Active', TERMINATE_POST_DISCIPLINARY: 'Terminated' },
    NoticePeriod: { REACH_LAST_WORKING_DAY: 'Terminated', ABSENCE_BREACH: 'Absconded' },
    Absconded: { EXPLANATION_ACCEPTED: 'Active', ABANDONMENT_CONFIRMED: 'Terminated' },
    Terminated: { RETENTION_TRANSITION: 'Alumni' },
    OfferRescinded: {},
    NoShow: {},
    Alumni: {},
  },
);

/**
 * [SUPERSEDES HRM Vol3 §9.2.8] Absconded resolves only into Terminated with
 * separation_type = abandonment, never directly into Alumni. Someone who
 * stopped coming in is a separation with a reason, not an alumnus.
 */
export const ABANDONMENT_SEPARATION_TYPE = 'abandonment';

export const SEPARATION_TYPES = ['resignation', 'termination', 'abandonment'] as const;
export type SeparationType = (typeof SEPARATION_TYPES)[number];

export const CONFIRMATION_STATES = ['not_applicable', 'in_probation', 'extended', 'confirmed'] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

/**
 * The event verb for each transition. Written out rather than derived from the
 * event constant because §6.1 requires the past tense and two of these names
 * are quoted verbatim in §14 — `.commenced` and `.resignation_submitted` —
 * which no mechanical rule would produce.
 */
export const EMPLOYMENT_EVENT_VERB: Record<EmploymentEvent, string> = {
  RESCIND_OFFER: 'offer_rescinded',
  NO_SHOW: 'no_show_recorded',
  ACTIVATE: 'commenced',
  START_LEAVE: 'leave_started',
  RETURN_FROM_LEAVE: 'leave_ended',
  SUSPEND: 'suspended',
  REINSTATE: 'reinstated',
  TERMINATE_POST_DISCIPLINARY: 'separated',
  SUBMIT_RESIGNATION: 'resignation_submitted',
  REACH_LAST_WORKING_DAY: 'separated',
  ABSENCE_BREACH: 'absence_breach_detected',
  EXPLANATION_ACCEPTED: 'reinstated',
  ABANDONMENT_CONFIRMED: 'separated',
  RETENTION_TRANSITION: 'alumni_recorded',
};

/** The states in which a person is on the payroll and counts as headcount. */
export const EMPLOYED_STATES: EmploymentState[] = ['Active', 'OnLeave', 'Suspended', 'NoticePeriod'];

export function isEmployed(state: EmploymentState): boolean {
  return EMPLOYED_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Diagram 14.2 — Leave Request
// ---------------------------------------------------------------------------

export type LeaveRequestState =
  | 'Draft' | 'Submitted' | 'PendingApproval' | 'Approved' | 'Rejected'
  | 'CancelledWithdrawn' | 'InProgress' | 'Extended' | 'Completed';

export type LeaveRequestEvent =
  | 'SUBMIT' | 'ROUTE_FOR_APPROVAL' | 'APPROVE' | 'REJECT' | 'WITHDRAW'
  | 'CANCEL' | 'START' | 'REQUEST_EXTENSION' | 'EXTENSION_RUNNING' | 'COMPLETE';

export const leaveRequestMachine = createMachine<LeaveRequestState, LeaveRequestEvent>('LeaveRequest', {
  Draft: { SUBMIT: 'Submitted' },
  Submitted: { ROUTE_FOR_APPROVAL: 'PendingApproval', WITHDRAW: 'CancelledWithdrawn' },
  PendingApproval: { APPROVE: 'Approved', REJECT: 'Rejected' },
  Approved: { CANCEL: 'CancelledWithdrawn', START: 'InProgress' },
  InProgress: { REQUEST_EXTENSION: 'Extended', COMPLETE: 'Completed' },
  Extended: { EXTENSION_RUNNING: 'InProgress' },
  Rejected: {},
  CancelledWithdrawn: {},
  Completed: {},
});

export const LEAVE_TXN_TYPES = ['hold', 'deduction', 'reversal', 'adjustment', 'accrual'] as const;
export type LeaveTxnType = (typeof LEAVE_TXN_TYPES)[number];

/**
 * Three transitions move a balance, and they move it by writing a
 * LEAVE_TRANSACTION — approval places a hold, completion converts it to a
 * deduction, cancellation reverses it. The balance column is never written
 * directly, which is what makes the ledger reconstructable.
 */
export const LEAVE_POSTING_ON_EVENT: Partial<Record<LeaveRequestEvent, LeaveTxnType>> = {
  APPROVE: 'hold',
  COMPLETE: 'deduction',
  WITHDRAW: 'reversal',
  CANCEL: 'reversal',
};

export const LEAVE_REQUEST_EVENT_VERB: Record<LeaveRequestEvent, string> = {
  SUBMIT: 'requested',
  ROUTE_FOR_APPROVAL: 'routed_for_approval',
  APPROVE: 'approved',
  REJECT: 'rejected',
  WITHDRAW: 'withdrawn',
  CANCEL: 'cancelled',
  START: 'started',
  REQUEST_EXTENSION: 'extension_requested',
  EXTENSION_RUNNING: 'extension_in_progress',
  COMPLETE: 'completed',
};

// ---------------------------------------------------------------------------
// R5 — Requisition
// ---------------------------------------------------------------------------

export type RequisitionState =
  | 'Draft' | 'PendingApproval' | 'Approved' | 'Open' | 'OnHold'
  | 'Filled' | 'Closed' | 'Cancelled' | 'Rejected';

export type RequisitionEvent =
  | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'HOLD' | 'RESUME' | 'FILL' | 'CLOSE' | 'CANCEL';

export const requisitionMachine = createMachine<RequisitionState, RequisitionEvent>('Requisition', {
  Draft: { SUBMIT: 'PendingApproval', CANCEL: 'Cancelled' },
  PendingApproval: { APPROVE: 'Approved', REJECT: 'Rejected' },
  Approved: { PUBLISH: 'Open' },
  Open: { HOLD: 'OnHold', FILL: 'Filled', CLOSE: 'Closed', CANCEL: 'Cancelled' },
  OnHold: { RESUME: 'Open', CLOSE: 'Closed', CANCEL: 'Cancelled' },
  Filled: {},
  Closed: {},
  Cancelled: {},
  Rejected: {},
});

export const REQUISITION_EVENT_VERB: Record<RequisitionEvent, string> = {
  SUBMIT: 'raised',
  APPROVE: 'approved',
  REJECT: 'rejected',
  PUBLISH: 'opened',
  HOLD: 'held',
  RESUME: 'resumed',
  FILL: 'filled',
  CLOSE: 'closed',
  CANCEL: 'cancelled',
};

// ---------------------------------------------------------------------------
// R3 — Application
// ---------------------------------------------------------------------------

export type ApplicationState =
  | 'Applied' | 'Screening' | 'Interviewing' | 'Selected' | 'OfferExtended'
  | 'OfferAccepted' | 'Joined' | 'Rejected' | 'Withdrawn' | 'OfferDeclined'
  | 'OfferRescinded' | 'NoShow';

export type ApplicationEvent =
  | 'ADVANCE' | 'REJECT' | 'WITHDRAW' | 'EXTEND_OFFER' | 'ACCEPT_OFFER'
  | 'DECLINE_OFFER' | 'RESCIND_OFFER' | 'JOIN' | 'NO_SHOW';

export const applicationMachine = createMachine<ApplicationState, ApplicationEvent>('Application', {
  Applied: { ADVANCE: 'Screening', WITHDRAW: 'Withdrawn' },
  Screening: { ADVANCE: 'Interviewing', REJECT: 'Rejected', WITHDRAW: 'Withdrawn' },
  Interviewing: { ADVANCE: 'Selected', REJECT: 'Rejected', WITHDRAW: 'Withdrawn' },
  Selected: { EXTEND_OFFER: 'OfferExtended', WITHDRAW: 'Withdrawn' },
  OfferExtended: {
    ACCEPT_OFFER: 'OfferAccepted', DECLINE_OFFER: 'OfferDeclined',
    RESCIND_OFFER: 'OfferRescinded', WITHDRAW: 'Withdrawn',
  },
  // Offer Accepted is not Joined, and the gap between them is where
  // OfferRescinded and NoShow live [Canon §14.3 R3].
  OfferAccepted: { JOIN: 'Joined', RESCIND_OFFER: 'OfferRescinded', NO_SHOW: 'NoShow' },
  Joined: {},
  Rejected: {},
  Withdrawn: {},
  OfferDeclined: {},
  OfferRescinded: {},
  NoShow: {},
});

export const APPLICATION_EVENT_VERB: Record<ApplicationEvent, string> = {
  ADVANCE: 'advanced',
  REJECT: 'rejected',
  WITHDRAW: 'withdrawn',
  EXTEND_OFFER: 'offered',
  ACCEPT_OFFER: 'offer_accepted',
  DECLINE_OFFER: 'offer_declined',
  RESCIND_OFFER: 'offer_rescinded',
  JOIN: 'joined',
  NO_SHOW: 'no_show_recorded',
};

/**
 * §9.2.21's funnel is a reporting projection of the state, not a set of states
 * of its own — so it is derived here rather than stored.
 */
export function applicationFunnelBucket(state: ApplicationState): 'open' | 'offer' | 'hired' | 'closed' {
  if (state === 'Joined') return 'hired';
  if (state === 'OfferExtended' || state === 'OfferAccepted') return 'offer';
  if (['Applied', 'Screening', 'Interviewing', 'Selected'].includes(state)) return 'open';
  return 'closed';
}

// ---------------------------------------------------------------------------
// R1 — Position (org-owned; HR consumes it)
// ---------------------------------------------------------------------------

export type PositionState = 'Requested' | 'BudgetApproved' | 'Open' | 'Filled' | 'OnHold' | 'Closed';
export type PositionEvent = 'APPROVE_BUDGET' | 'PUBLISH' | 'FILL' | 'VACATE' | 'HOLD' | 'RESUME' | 'CLOSE';

export const positionMachine = createMachine<PositionState, PositionEvent>('Position', {
  Requested: { APPROVE_BUDGET: 'BudgetApproved' },
  BudgetApproved: { PUBLISH: 'Open' },
  Open: { FILL: 'Filled', HOLD: 'OnHold', CLOSE: 'Closed' },
  Filled: { VACATE: 'Open', HOLD: 'OnHold', CLOSE: 'Closed' },
  OnHold: { RESUME: 'Open', CLOSE: 'Closed' },
  Closed: {},
});

export const POSITION_EVENT_VERB: Record<PositionEvent, string> = {
  APPROVE_BUDGET: 'budget_approved',
  PUBLISH: 'opened',
  FILL: 'filled',
  VACATE: 'vacated',
  HOLD: 'held',
  RESUME: 'resumed',
  CLOSE: 'closed',
};

// ---------------------------------------------------------------------------
// R4 — Assignment change request
// ---------------------------------------------------------------------------

export type AssignmentRequestState =
  | 'Draft' | 'PendingApproval' | 'Approved' | 'Scheduled'
  | 'Effective' | 'Superseded' | 'Rejected' | 'Cancelled';

export type AssignmentRequestEvent =
  | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'SCHEDULE' | 'ACTIVATE' | 'SUPERSEDE' | 'CANCEL';

/**
 * This is the *change request* machine. The temporal row status every
 * effective-dated entity carries (Effective/Superseded per §7) is a separate
 * field — a request that has been superseded and a row that has been
 * superseded are different facts about different things.
 */
export const assignmentMachine = createMachine<AssignmentRequestState, AssignmentRequestEvent>('Assignment', {
  Draft: { SUBMIT: 'PendingApproval', CANCEL: 'Cancelled' },
  PendingApproval: { APPROVE: 'Approved', REJECT: 'Rejected', CANCEL: 'Cancelled' },
  Approved: { SCHEDULE: 'Scheduled' },
  Scheduled: { ACTIVATE: 'Effective' },
  Effective: { SUPERSEDE: 'Superseded' },
  Superseded: {},
  Rejected: {},
  Cancelled: {},
});

export const ASSIGNMENT_REASON_CODES = ['Hire', 'Promotion', 'Transfer', 'Restructure', 'Demotion'] as const;
export type AssignmentReasonCode = (typeof ASSIGNMENT_REASON_CODES)[number];

export const ASSIGNMENT_EVENT_VERB: Record<AssignmentRequestEvent, string> = {
  SUBMIT: 'proposed',
  APPROVE: 'approved',
  REJECT: 'rejected',
  SCHEDULE: 'scheduled',
  ACTIVATE: 'created',
  SUPERSEDE: 'superseded',
  CANCEL: 'cancelled',
};

// ---------------------------------------------------------------------------
// R2 — Compensation Record
// ---------------------------------------------------------------------------

export type CompensationState =
  | 'Proposed' | 'PendingApproval' | 'Approved' | 'Scheduled'
  | 'Effective' | 'Superseded' | 'Rejected' | 'Withdrawn';

export type CompensationEvent =
  | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'SCHEDULE' | 'ACTIVATE' | 'SUPERSEDE' | 'WITHDRAW';

export const compensationRecordMachine = createMachine<CompensationState, CompensationEvent>('CompensationRecord', {
  Proposed: { SUBMIT: 'PendingApproval', WITHDRAW: 'Withdrawn' },
  PendingApproval: { APPROVE: 'Approved', REJECT: 'Rejected', WITHDRAW: 'Withdrawn' },
  Approved: { SCHEDULE: 'Scheduled' },
  Scheduled: { ACTIVATE: 'Effective' },
  Effective: { SUPERSEDE: 'Superseded' },
  Superseded: {},
  Rejected: {},
  Withdrawn: {},
});

export const COMPENSATION_REVISION_REASONS = [
  'hire', 'promotion', 'annual_cycle', 'market_correction', 'off_cycle',
] as const;
export type CompensationRevisionReason = (typeof COMPENSATION_REVISION_REASONS)[number];

/**
 * [Canon §14.5] A pay change whose reason is a promotion must carry the
 * assignment that promoted them, under one correlation id and one decision.
 * A promotion that moved the money but not the position — or the reverse — is
 * the failure this constraint exists to prevent. Enforced in the service
 * layer, because it reads two records and the FSM only ever sees one.
 */
export const PROMOTION_REVISION_REASON: CompensationRevisionReason = 'promotion';

export const COMPENSATION_EVENT_VERB: Record<CompensationEvent, string> = {
  SUBMIT: 'proposed',
  APPROVE: 'approved',
  REJECT: 'rejected',
  SCHEDULE: 'scheduled',
  ACTIVATE: 'effective',
  SUPERSEDE: 'superseded',
  WITHDRAW: 'withdrawn',
};

// ---------------------------------------------------------------------------
// Onboarding / Offboarding
// ---------------------------------------------------------------------------

export type OnboardingState =
  | 'Initiated' | 'PreBoarding' | 'Day1Activated' | 'InProgress'
  | 'BlockedEscalated' | 'Completed' | 'Abandoned';

export type OnboardingEvent =
  | 'START_PREBOARDING' | 'ACTIVATE_DAY1' | 'BEGIN' | 'ESCALATE' | 'RESUME' | 'COMPLETE' | 'ABANDON';

export const onboardingMachine = createMachine<OnboardingState, OnboardingEvent>('Onboarding', {
  Initiated: { START_PREBOARDING: 'PreBoarding' },
  PreBoarding: { ACTIVATE_DAY1: 'Day1Activated', ABANDON: 'Abandoned' },
  Day1Activated: { BEGIN: 'InProgress', ABANDON: 'Abandoned' },
  InProgress: { ESCALATE: 'BlockedEscalated', COMPLETE: 'Completed', ABANDON: 'Abandoned' },
  BlockedEscalated: { RESUME: 'InProgress', ABANDON: 'Abandoned' },
  Completed: {},
  Abandoned: {},
});

export const ONBOARDING_EVENT_VERB: Record<OnboardingEvent, string> = {
  // `initiated` belongs to the record's creation, published when the row is
  // opened at hire time, so this transition takes a distinct verb — otherwise
  // the log could not tell "an onboarding began" from "pre-boarding began".
  START_PREBOARDING: 'pre_boarding_started',
  ACTIVATE_DAY1: 'day1_activated',
  BEGIN: 'started',
  ESCALATE: 'escalated',
  RESUME: 'resumed',
  COMPLETE: 'completed',
  ABANDON: 'abandoned',
};

export type OffboardingState =
  | 'Initiated' | 'NoticePeriodActive' | 'LastWorkingDayReached' | 'ClearancePending'
  | 'BlockedDisputed' | 'FFSettlementPending' | 'FFSettlementCompleted' | 'ClosedArchived';

export type OffboardingEvent =
  | 'START_NOTICE' | 'REACH_LWD' | 'BEGIN_CLEARANCE' | 'DISPUTE'
  | 'RESOLVE' | 'CLEARANCE_COMPLETE' | 'DISBURSE' | 'ARCHIVE';

export const offboardingMachine = createMachine<OffboardingState, OffboardingEvent>('Offboarding', {
  Initiated: { START_NOTICE: 'NoticePeriodActive' },
  NoticePeriodActive: { REACH_LWD: 'LastWorkingDayReached' },
  LastWorkingDayReached: { BEGIN_CLEARANCE: 'ClearancePending' },
  ClearancePending: { DISPUTE: 'BlockedDisputed', CLEARANCE_COMPLETE: 'FFSettlementPending' },
  BlockedDisputed: { RESOLVE: 'ClearancePending' },
  FFSettlementPending: { DISBURSE: 'FFSettlementCompleted' },
  FFSettlementCompleted: { ARCHIVE: 'ClosedArchived' },
  ClosedArchived: {},
});

export const OFFBOARDING_EVENT_VERB: Record<OffboardingEvent, string> = {
  START_NOTICE: 'notice_started',
  REACH_LWD: 'last_working_day_reached',
  BEGIN_CLEARANCE: 'clearance_started',
  DISPUTE: 'clearance_disputed',
  RESOLVE: 'dispute_resolved',
  CLEARANCE_COMPLETE: 'clearance_completed',
  DISBURSE: 'settlement_disbursed',
  ARCHIVE: 'archived',
};

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export type GoalState =
  | 'Draft' | 'Agreed' | 'InProgress' | 'AtRisk' | 'Achieved' | 'PartiallyAchieved' | 'Missed';

export type GoalEvent =
  | 'AGREE' | 'START' | 'FLAG_AT_RISK' | 'RECOVER' | 'ACHIEVE' | 'PARTIALLY_ACHIEVE' | 'MISS';

export const goalMachine = createMachine<GoalState, GoalEvent>('Goal', {
  Draft: { AGREE: 'Agreed' },
  Agreed: { START: 'InProgress' },
  InProgress: {
    FLAG_AT_RISK: 'AtRisk', ACHIEVE: 'Achieved',
    PARTIALLY_ACHIEVE: 'PartiallyAchieved', MISS: 'Missed',
  },
  AtRisk: {
    RECOVER: 'InProgress', ACHIEVE: 'Achieved',
    PARTIALLY_ACHIEVE: 'PartiallyAchieved', MISS: 'Missed',
  },
  Achieved: {},
  PartiallyAchieved: {},
  Missed: {},
});

export const GOAL_EVENT_VERB: Record<GoalEvent, string> = {
  AGREE: 'agreed',
  START: 'started',
  FLAG_AT_RISK: 'at_risk_flagged',
  RECOVER: 'recovered',
  ACHIEVE: 'achieved',
  PARTIALLY_ACHIEVE: 'partially_achieved',
  MISS: 'missed',
};

/**
 * There is deliberately no PERFORMANCE_REVIEW entity [Canon §14.2]: a review
 * is a reading of the evidence, not a record that replaces it. These are the
 * kinds of evidence that accumulate instead.
 */
export const PERFORMANCE_EVIDENCE_KINDS = [
  'milestone', 'quality_outcome', 'corrective_note', 'manager_note', 'self_note',
] as const;
export type PerformanceEvidenceKind = (typeof PERFORMANCE_EVIDENCE_KINDS)[number];

// ---------------------------------------------------------------------------
// Work Attendance
// ---------------------------------------------------------------------------

export type WorkAttendanceState = 'Recorded' | 'Disputed' | 'Regularised' | 'Locked';
export type WorkAttendanceEvent = 'DISPUTE' | 'REGULARISE' | 'LOCK';

export const workAttendanceMachine = createMachine<WorkAttendanceState, WorkAttendanceEvent>('WorkAttendance', {
  Recorded: { DISPUTE: 'Disputed', REGULARISE: 'Regularised', LOCK: 'Locked' },
  Disputed: { REGULARISE: 'Regularised' },
  Regularised: { LOCK: 'Locked' },
  Locked: {},
});

export const WORK_ATTENDANCE_EVENT_VERB: Record<WorkAttendanceEvent, string> = {
  DISPUTE: 'disputed',
  REGULARISE: 'regularised',
  LOCK: 'locked',
};

// ---------------------------------------------------------------------------
// Payroll — one shape for the instruction and the run
// ---------------------------------------------------------------------------

export type PayrollState =
  | 'Draft' | 'Computed' | 'UnderReview' | 'Approved' | 'Disbursed' | 'Locked' | 'Rejected';

export type PayrollEvent = 'COMPUTE' | 'SUBMIT_REVIEW' | 'APPROVE' | 'REJECT' | 'DISBURSE' | 'LOCK';

export const payrollMachine = createMachine<PayrollState, PayrollEvent>('Payroll', {
  Draft: { COMPUTE: 'Computed' },
  Computed: { SUBMIT_REVIEW: 'UnderReview' },
  UnderReview: { APPROVE: 'Approved', REJECT: 'Rejected' },
  Approved: { DISBURSE: 'Disbursed' },
  Disbursed: { LOCK: 'Locked' },
  Locked: {},
  Rejected: {},
});

export const PAYROLL_EVENT_VERB: Record<PayrollEvent, string> = {
  COMPUTE: 'computed',
  SUBMIT_REVIEW: 'submitted_for_review',
  APPROVE: 'approved',
  REJECT: 'rejected',
  DISBURSE: 'disbursed',
  LOCK: 'locked',
};

// ---------------------------------------------------------------------------
// Capability Intelligence — Canon §14.6
// ---------------------------------------------------------------------------

export type CapabilityTier = 'inferred' | 'claimed' | 'assessed' | 'demonstrated' | 'verified';
export type NonTierState = 'contradicted' | 'retracted' | 'revoked' | 'superseded';
export type CapabilityClaimState = 'active' | NonTierState;

export const CAPABILITY_TIERS: CapabilityTier[] = ['inferred', 'claimed', 'assessed', 'demonstrated', 'verified'];

/**
 * The tier names are not the confidence order, which is the whole point of
 * storing the rank: "claimed" sounds stronger than "inferred" and is, but
 * "assessed" sounding weaker than "verified" is a coincidence of English, not
 * a property of the data. Sorting by enum declaration order would be a bug
 * waiting for someone to reorder the enum, so the rank is written down.
 */
export const CONFIDENCE_RANK: Record<CapabilityTier, number> = {
  inferred: 1, claimed: 2, assessed: 3, demonstrated: 4, verified: 5,
};

export function confidenceRank(tier: CapabilityTier): number {
  return CONFIDENCE_RANK[tier];
}

export function isMoreConfident(
  a: { tier: CapabilityTier; confidenceScore: number },
  b: { tier: CapabilityTier; confidenceScore: number },
): boolean {
  const rankDiff = confidenceRank(a.tier) - confidenceRank(b.tier);
  if (rankDiff !== 0) return rankDiff > 0;
  return a.confidenceScore > b.confidenceScore;
}

export type OriginationSource =
  | 'extraction_event' | 'self_report_or_cv_parse' | 'assessment_completed'
  | 'work_sample_evidence' | 'issuer_verification';

/**
 * A claim does not climb the tiers. Each tier has its own way in, and a claim
 * can enter at Verified having never been Claimed — a degree certificate
 * checked with the issuing university was never somebody's self-report.
 */
export const ORIGINATION_FOR_TIER: Record<CapabilityTier, OriginationSource> = {
  inferred: 'extraction_event',
  claimed: 'self_report_or_cv_parse',
  assessed: 'assessment_completed',
  demonstrated: 'work_sample_evidence',
  verified: 'issuer_verification',
};

/** Each non-tier state can only be reached from the tier that gives it meaning. */
const ALLOWED_NON_TIER_ORIGIN: Record<NonTierState, CapabilityTier[]> = {
  revoked: ['verified'],
  retracted: ['claimed'],
  contradicted: ['assessed'],
  superseded: ['demonstrated'],
};

export function canEnterNonTierState(fromTier: CapabilityTier, target: NonTierState): boolean {
  return ALLOWED_NON_TIER_ORIGIN[target].includes(fromTier);
}

export function enterNonTierState(fromTier: CapabilityTier, target: NonTierState): CapabilityClaimState {
  if (!canEnterNonTierState(fromTier, target)) {
    throw new HrRuleViolationError(
      `A capability claim at tier "${fromTier}" cannot become "${target}" — only a ` +
        `${ALLOWED_NON_TIER_ORIGIN[target].join(' or ')} claim can [Canon §14.6.1].`,
    );
  }
  return target;
}

export type ContradictionType =
  | 'tier_conflict' | 'level_conflict' | 'temporal_conflict' | 'issuer_conflict' | 'identity_conflict';

export type ContradictionRegion = 'auto_accept' | 'human_review' | 'auto_reject';

export interface ContradictionBand {
  /** Below this the disagreement is noise, not a contradiction. */
  autoAcceptBelow: number;
  /** At or above this the claim is rejected outright. */
  autoRejectAtOrAbove: number;
}

/**
 * Per-contradiction-type bands, never one global threshold: two sources
 * disagreeing about a proficiency level is ordinary, two sources disagreeing
 * about who the person is never is.
 */
export const CONTRADICTION_BANDS: Record<ContradictionType, ContradictionBand> = {
  tier_conflict: { autoAcceptBelow: 0.2, autoRejectAtOrAbove: 0.5 },
  level_conflict: { autoAcceptBelow: 0.4, autoRejectAtOrAbove: 0.85 },
  // Usually a parse error rather than a real disagreement, so the band is narrow.
  temporal_conflict: { autoAcceptBelow: 0.15, autoRejectAtOrAbove: 0.4 },
  // The issuer said no. There is nothing to weigh.
  issuer_conflict: { autoAcceptBelow: 0, autoRejectAtOrAbove: 0 },
  identity_conflict: { autoAcceptBelow: -1, autoRejectAtOrAbove: Number.POSITIVE_INFINITY },
};

export function classifyContradiction(type: ContradictionType, score: number): ContradictionRegion {
  // An identity conflict always goes to a human, whatever the score says.
  if (type === 'identity_conflict') return 'human_review';
  const band = CONTRADICTION_BANDS[type];
  if (score < band.autoAcceptBelow) return 'auto_accept';
  if (score >= band.autoRejectAtOrAbove) return 'auto_reject';
  return 'human_review';
}

export interface VerificationAttempt {
  claimantPartyId: string;
  verifierPartyId: string;
  secondVerifierPartyId?: string | null;
  targetTier: CapabilityTier;
  /** Whether this claim will move somebody's pay, grade or posting. */
  feedsCompensationOrPromotionOrMobility: boolean;
  verifierIsManagerOnly: boolean;
}

/**
 * Segregation of duties on verification [Canon §14.6.4]. These are structural:
 * no role, however senior, is exempt, because the risk being managed is the
 * senior person's own claim.
 */
export function assertVerificationAllowed(attempt: VerificationAttempt): void {
  if (attempt.claimantPartyId === attempt.verifierPartyId) {
    throw new HrRuleViolationError('Nobody may verify their own capability claim, at any tier [Canon §14.6.4].');
  }
  if (attempt.secondVerifierPartyId && attempt.claimantPartyId === attempt.secondVerifierPartyId) {
    throw new HrRuleViolationError('Nobody may be the second verifier of their own claim [Canon §14.6.4].');
  }

  // The remaining rules bite only at Verified — the tier with consequences.
  if (attempt.targetTier !== 'verified') return;

  if (attempt.feedsCompensationOrPromotionOrMobility && attempt.verifierIsManagerOnly) {
    throw new HrRuleViolationError(
      'A manager alone cannot verify a claim that feeds compensation, promotion or mobility [Canon §14.6.4].',
    );
  }
  if (attempt.feedsCompensationOrPromotionOrMobility && !attempt.secondVerifierPartyId) {
    throw new HrRuleViolationError(
      'A consequential verified claim needs hr_ops and an independent second verifier [Canon §14.6.4].',
    );
  }
  if (attempt.secondVerifierPartyId && attempt.secondVerifierPartyId === attempt.verifierPartyId) {
    throw new HrRuleViolationError('The second verifier must be someone other than the first [Canon §14.6.4].');
  }
}

/**
 * Finishing a course caps at Assessed and never advances on its own. Sitting
 * through training is evidence that you were taught, not that you can do it.
 */
export function tierForLearningCompletion(): CapabilityTier {
  return 'assessed';
}

/**
 * Decay is computed when the claim is read, from `lastEvidencedAt` and the
 * skill's half-life — never stored as a decaying scalar, which would require
 * rewriting every claim every night and would still be stale between runs.
 */
export function decayedConfidence(params: {
  confidenceScore: number;
  lastEvidencedAt: Date;
  halfLifeMonths: number;
  asOf?: Date;
}): number {
  const asOf = params.asOf ?? new Date();
  const msPerMonth = 30.4375 * 24 * 60 * 60 * 1000;
  const monthsElapsed = (asOf.getTime() - params.lastEvidencedAt.getTime()) / msPerMonth;
  if (monthsElapsed <= 0 || params.halfLifeMonths <= 0) return params.confidenceScore;
  return params.confidenceScore * Math.pow(0.5, monthsElapsed / params.halfLifeMonths);
}

/**
 * §14.7's flagship field rule: a colleague looking at somebody's capability
 * profile sees the claim and its trust badge, never the score behind it. The
 * score is a model output and reads as a judgement of the person.
 */
export function toPublicProfileView<T extends { value: string; tier: CapabilityTier }>(
  claim: T,
): { value: string; tier: CapabilityTier } {
  return { value: claim.value, tier: claim.tier };
}

// ---------------------------------------------------------------------------
// The register, for surfaces that need to name a machine generically
// ---------------------------------------------------------------------------

export const HR_MACHINES = {
  employment_relationship: employmentRelationshipMachine,
  leave_request: leaveRequestMachine,
  requisition: requisitionMachine,
  application: applicationMachine,
  position: positionMachine,
  assignment: assignmentMachine,
  compensation_record: compensationRecordMachine,
  onboarding: onboardingMachine,
  offboarding: offboardingMachine,
  goal: goalMachine,
  work_attendance: workAttendanceMachine,
  payroll: payrollMachine,
} as const;

export type HrMachineKey = keyof typeof HR_MACHINES;
