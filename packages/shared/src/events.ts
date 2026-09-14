/**
 * P4 — Event Fabric.
 *
 * Every fact-changing action emits a durable, hash-chained, replayable event
 * named with a closed grammar: `kz.<domain>.<entity>.<verb>`.
 *
 * Reads are never events. A read of confidential or regulated data produces an
 * AUDIT_RECORD instead (CRM-FOUND-006).
 */

export type EventName = string;

/** The canonical event-name grammar. Used to validate every emission. */
export const EVENT_NAME_PATTERN = /^kz\.[a-z]{2,4}\.[a-z_]+\.[a-z_]+$/;

export function isCanonicalEventName(name: string): boolean {
  return EVENT_NAME_PATTERN.test(name);
}

/**
 * CRM-FOUND-002 crosswalk — all 23 legacy PascalCase names mapped one-to-one to
 * their canonical form, applied verbatim from the platform canon. An adapter
 * dual-publishes both names during the migration window; both writes share the
 * same event_id and correlation_id so they are recognisable as the same fact.
 */
export const LEGACY_EVENT_CROSSWALK: Record<string, EventName> = {
  PersonCreated: 'kz.idn.person.created',
  PersonMerged: 'kz.idn.person.merged',
  OrganizationCreated: 'kz.idn.organization.created',
  RelationshipCreated: 'kz.idn.relationship.created',
  LeadCreated: 'kz.crm.lead.created',
  LeadConverted: 'kz.crm.lead.converted',
  LeadUntouched: 'kz.crm.lead.untouched_detected',
  OpportunityCreated: 'kz.crm.opportunity.created',
  OpportunityStageChanged: 'kz.crm.opportunity.stage_changed',
  ActivityCreated: 'kz.crm.activity.logged',
  TaskCreated: 'kz.wfl.task.created',
  TaskOverdue: 'kz.wfl.task.overdue_detected',
  MoUCreated: 'kz.crm.mou.created',
  MoUStatusChanged: 'kz.crm.mou.status_changed',
  MoUExpiring: 'kz.crm.mou.expiry_approaching_detected',
  MoUExpired: 'kz.crm.mou.expired',
  StudentEnrolled: 'kz.edu.enrollment.confirmed',
  StudentCompleted: 'kz.edu.enrollment.completed',
  StudentAtRisk: 'kz.edu.learner.risk_detected',
  PaymentReceived: 'kz.fin.payment.received',
  PaymentPending: 'kz.fin.payment.overdue_detected',
  InstitutionInactive: 'kz.crm.institution.dormancy_detected',
  ProposalPending: 'kz.crm.proposal.stalled_detected',
};

/** Reverse crosswalk, for the dual-publish adapter and legacy subscriber support. */
export const CANONICAL_TO_LEGACY: Record<EventName, string> = Object.fromEntries(
  Object.entries(LEGACY_EVENT_CROSSWALK).map(([legacy, canonical]) => [canonical, legacy]),
);

/** The complete registry of event names this platform emits. */
export const EVENTS = {
  // --- Identity (idn) -------------------------------------------------------
  PERSON_CREATED: 'kz.idn.person.created',
  PERSON_RESOLVED: 'kz.idn.person.resolved',
  PERSON_UPDATED: 'kz.idn.person.updated',
  PERSON_MERGED: 'kz.idn.person.merged',
  MERGE_CANDIDATE_RAISED: 'kz.idn.merge_candidate.raised',
  MERGE_CANDIDATE_CONFIRMED: 'kz.idn.merge_candidate.confirmed',
  MERGE_CANDIDATE_REJECTED: 'kz.idn.merge_candidate.rejected',
  AFFILIATION_CREATED: 'kz.idn.affiliation.created',
  AFFILIATION_ENDED: 'kz.idn.affiliation.ended',
  ORGANIZATION_CREATED: 'kz.idn.organization.created',
  SESSION_CONTEXT_SWITCHED: 'kz.idn.session.context_switched',
  /// A sign-in created for an outsider — a shareholder or board member with no
  /// employment here (§1.10). Never fires on the founding-account seed path.
  SIGN_IN_CREATED: 'kz.idn.sign_in.created',
  SIGN_IN_RESET: 'kz.idn.sign_in.reset',
  /// A principal chose which entity to continue in, after `login()` returned
  /// more than one. Written in the target tenant only — switching carries no
  /// cross-tenant event, the same way the token it issues carries no
  /// cross-tenant reach.
  ENTITY_SWITCHED: 'kz.idn.entity.switched',
  /// `reconcileTenantKinds` flipped a tenant's `kind` for the first time —
  /// the moment s.2(85) ends small-company status for it (§1a.1).
  TENANT_KIND_CHANGED: 'kz.sys.tenant.kind_changed',

  // --- CRM: organisation specialisations ------------------------------------
  CRM_ORGANIZATION_CREATED: 'kz.crm.organization.created',
  CRM_ORGANIZATION_UPDATED: 'kz.crm.organization.updated',
  ACCOUNT_ATTACHED: 'kz.crm.account.attached',
  ACCOUNT_DETACHED: 'kz.crm.account.detached',
  INSTITUTION_PROFILE_ATTACHED: 'kz.crm.institution_profile.attached',
  INSTITUTION_PROFILE_DETACHED: 'kz.crm.institution_profile.detached',
  INSTITUTION_DORMANCY_DETECTED: 'kz.crm.institution.dormancy_detected',

  // --- CRM: relationship graph ----------------------------------------------
  RELATIONSHIP_CREATED: 'kz.crm.relationship.created',
  RELATIONSHIP_ENDED: 'kz.crm.relationship.ended',
  RELATIONSHIP_STATUS_CHANGED: 'kz.crm.relationship.status_changed',
  RELATIONSHIP_STRENGTH_CHANGED: 'kz.crm.relationship.strength_changed',

  // --- CRM: pipeline configuration ------------------------------------------
  PIPELINE_DEFINITION_CREATED: 'kz.crm.pipeline_definition.created',
  PIPELINE_DEFINITION_UPDATED: 'kz.crm.pipeline_definition.updated',
  PIPELINE_DEFINITION_RETIRED: 'kz.crm.pipeline_definition.retired',
  PIPELINE_STAGE_CREATED: 'kz.crm.pipeline_stage.created',
  PIPELINE_STAGE_UPDATED: 'kz.crm.pipeline_stage.updated',
  PIPELINE_STAGE_RETIRED: 'kz.crm.pipeline_stage.retired',
  PIPELINE_TRANSITION_CREATED: 'kz.crm.pipeline_transition.created',
  PIPELINE_TRANSITION_UPDATED: 'kz.crm.pipeline_transition.updated',
  PIPELINE_TRANSITION_DELETED: 'kz.crm.pipeline_transition.deleted',

  // --- CRM: lead ------------------------------------------------------------
  LEAD_CREATED: 'kz.crm.lead.created',
  LEAD_UPDATED: 'kz.crm.lead.updated',
  LEAD_ROUTED: 'kz.crm.lead.routed',
  LEAD_UNROUTED: 'kz.crm.lead.unrouted',
  LEAD_REASSIGNED: 'kz.crm.lead.reassigned',
  LEAD_STAGE_CHANGED: 'kz.crm.lead.stage_changed',
  LEAD_CONVERTED: 'kz.crm.lead.converted',
  LEAD_UNTOUCHED_DETECTED: 'kz.crm.lead.untouched_detected',

  // --- CRM: opportunity -----------------------------------------------------
  OPPORTUNITY_CREATED: 'kz.crm.opportunity.created',
  OPPORTUNITY_UPDATED: 'kz.crm.opportunity.updated',
  OPPORTUNITY_STAGE_CHANGED: 'kz.crm.opportunity.stage_changed',
  OPPORTUNITY_FORECAST_CATEGORY_CHANGED: 'kz.crm.opportunity.forecast_category_changed',
  OPPORTUNITY_WON: 'kz.crm.opportunity.won',
  OPPORTUNITY_LOST: 'kz.crm.opportunity.lost',
  OPPORTUNITY_HANDED_OFF: 'kz.crm.opportunity.handed_off',
  OPPORTUNITY_RENEWAL_OPENED: 'kz.crm.opportunity.renewal_opened',
  OPPORTUNITY_STAGE_AGE_BREACHED: 'kz.crm.opportunity.stage_age_breached_detected',

  // --- CRM: territory & routing ---------------------------------------------
  TERRITORY_CREATED: 'kz.crm.territory.created',
  TERRITORY_UPDATED: 'kz.crm.territory.updated',
  ROUTING_RULE_CREATED: 'kz.crm.routing_rule.created',
  ROUTING_RULE_UPDATED: 'kz.crm.routing_rule.updated',

  // --- CRM: commercial catalog ----------------------------------------------
  OFFERING_CREATED: 'kz.crm.offering.created',
  OFFERING_UPDATED: 'kz.crm.offering.updated',
  OFFERING_RETIRED: 'kz.crm.offering.retired',
  PRICE_BOOK_ENTRY_PUBLISHED: 'kz.crm.price_book_entry.published',
  PRICE_BOOK_ENTRY_SUPERSEDED: 'kz.crm.price_book_entry.superseded',

  // --- PCT: proposals, quotes, contracts (crm-domain segment by bounded context)
  PROPOSAL_CREATED: 'kz.pct.proposal.created',
  PROPOSAL_SENT: 'kz.pct.proposal.sent',
  PROPOSAL_RESPONDED: 'kz.pct.proposal.responded',
  PROPOSAL_SUPERSEDED: 'kz.pct.proposal.superseded',
  PROPOSAL_STALLED_DETECTED: 'kz.crm.proposal.stalled_detected',
  QUOTE_CREATED: 'kz.crm.quote.created',
  QUOTE_ISSUED: 'kz.crm.quote.issued',
  QUOTE_DISCOUNT_BLOCKED: 'kz.crm.quote.discount_blocked',
  QUOTE_ACCEPTED: 'kz.crm.quote.accepted',
  CONTRACT_CREATED: 'kz.crm.contract.created',
  CONTRACT_STATUS_CHANGED: 'kz.crm.contract.status_changed',
  CONTRACT_SIGNED: 'kz.crm.contract.signed',
  CONTRACT_EXPIRING: 'kz.crm.contract.expiring',
  CONTRACT_EXPIRED: 'kz.crm.contract.expired',
  CONTRACT_TERMINATED: 'kz.crm.contract.terminated',

  // --- CRM/PCT: MoU & partner -----------------------------------------------
  MOU_CREATED: 'kz.crm.mou.created',
  MOU_STATUS_CHANGED: 'kz.crm.mou.status_changed',
  MOU_EXPIRY_APPROACHING: 'kz.crm.mou.expiry_approaching_detected',
  MOU_EXPIRED: 'kz.crm.mou.expired',
  MOU_RENEWED: 'kz.crm.mou.renewed',
  PARTNER_AGREEMENT_CREATED: 'kz.crm.partner_agreement.created',
  PARTNER_AGREEMENT_STATUS_CHANGED: 'kz.crm.partner_agreement.status_changed',

  // --- CRM: win/loss --------------------------------------------------------
  WIN_LOSS_REVIEW_RECORDED: 'kz.crm.win_loss_review.recorded',
  WIN_LOSS_REVIEW_OVERDUE: 'kz.crm.win_loss_review.overdue_detected',

  // --- CRM: activity / interaction ------------------------------------------
  ACTIVITY_LOGGED: 'kz.crm.activity.logged',
  INTERACTION_LOGGED: 'kz.crm.interaction.logged',

  // --- Workflow / tasks -----------------------------------------------------
  TASK_CREATED: 'kz.wfl.task.created',
  TASK_COMPLETED: 'kz.wfl.task.completed',
  TASK_OVERDUE_DETECTED: 'kz.wfl.task.overdue_detected',
  JOB_COMPLETED: 'kz.crm.job.completed',
  JOB_FAILED: 'kz.crm.job.failed',

  // --- Finance --------------------------------------------------------------
  INVOICE_ISSUED: 'kz.fin.invoice.issued',
  INVOICE_SETTLED: 'kz.fin.invoice.settled',
  FEE_INSTALMENT_ISSUED: 'kz.fin.fee_instalment.issued',
  PAYMENT_RECEIVED: 'kz.fin.payment.received',
  PAYMENT_OVERDUE_DETECTED: 'kz.fin.payment.overdue_detected',
  RECEIPT_ALLOCATED: 'kz.fin.receipt.allocated',
  CREDIT_NOTE_ISSUED: 'kz.fin.credit_note.issued',
  /// A draft's lines or tax were changed before it was issued. Separate from
  /// `issued`, because "somebody corrected this before it went out" and "this
  /// went out" are different facts about the same document.
  INVOICE_DRAFTED: 'kz.fin.invoice.drafted',
  INVOICE_UPDATED: 'kz.fin.invoice.updated',
  INVOICE_VOIDED: 'kz.fin.invoice.voided',
  /// Money taken at the counter against an invoice, in one act: the payment,
  /// the receipt that allocates it, and the receipt document the customer gets.
  INVOICE_PAYMENT_COLLECTED: 'kz.fin.invoice.payment_collected',
  /// The receipt is its own document, so issuing one is its own event. A part
  /// payment produces a receipt and never an edit to the tax invoice.
  RECEIPT_ISSUED: 'kz.fin.receipt.issued',
  /// The statement raised once the instalments are done, naming the receipts it
  /// consolidates.
  FINAL_INVOICE_RAISED: 'kz.fin.final_invoice.raised',
  FINAL_INVOICE_SUPERSEDED: 'kz.fin.final_invoice.superseded',

  // --- Education ------------------------------------------------------------
  ENROLLMENT_CREATED: 'kz.edu.enrollment.created',
  ENROLLMENT_CONFIRMED: 'kz.edu.enrollment.confirmed',
  ENROLLMENT_COMPLETED: 'kz.edu.enrollment.completed',
  LEARNER_RISK_DETECTED: 'kz.edu.learner.risk_detected',
  ATTENDANCE_RECORDED: 'kz.edu.attendance.recorded',
  PROGRESS_RECORDED: 'kz.edu.progress.recorded',
  /// The course catalogue, which is a price list as much as a syllabus.
  COURSE_CREATED: 'kz.edu.course.created',
  COURSE_UPDATED: 'kz.edu.course.updated',
  COURSE_RETIRED: 'kz.edu.course.retired',
  /// A day on a student's timeline that is neither attendance nor a score: a
  /// question, a piece of feedback, a problem, a note.
  LEARNER_LOG_RECORDED: 'kz.edu.learner_log.recorded',
  LEARNER_LOG_RESOLVED: 'kz.edu.learner_log.resolved',

  // --- Governance -----------------------------------------------------------
  POLICY_VERSION_PUBLISHED: 'kz.gov.policy_version.published',
  GRANT_CHANGED: 'kz.gov.grant.changed',
  AUTHORITY_GRANT_EXCEEDED: 'kz.gov.authority_grant.exceeded_detected',
  ACCESS_DENIED: 'kz.gov.access.denied',
  DECISION_RAISED: 'kz.gov.decision.raised',
  DECISION_DECIDED: 'kz.gov.decision.decided',
  DECISION_DELEGATED: 'kz.gov.decision.delegated',
  DECISION_DEFERRED: 'kz.gov.decision.deferred',
  DECISION_EVIDENCE_REQUESTED: 'kz.gov.decision.evidence_requested',
  APPROVAL_STEP_OPENED: 'kz.gov.approval_step.opened',
  APPROVAL_STEP_DECIDED: 'kz.gov.approval_step.decided',
  APPROVAL_STEP_ESCALATED: 'kz.gov.approval_step.escalated',

  // --- Exceptions -----------------------------------------------------------
  EXCEPTION_RAISED: 'kz.xcp.exception.raised',
  EXCEPTION_ACKNOWLEDGED: 'kz.xcp.exception.acknowledged',
  EXCEPTION_RESOLVED: 'kz.xcp.exception.resolved',
  EXCEPTION_ESCALATED: 'kz.xcp.exception.escalated',

  // --- Cross-domain health --------------------------------------------------
  HEALTH_SCORE_COMPUTED: 'kz.xdm.health_score.computed',
  HEALTH_BAND_CHANGED: 'kz.xdm.health_score.band_changed',

  // --- Agents ---------------------------------------------------------------
  AGENT_ACTION_PROPOSED: 'kz.agt.action.proposed',
  AGENT_ACTION_EXECUTED: 'kz.agt.action.executed',
  AGENT_ACTION_REJECTED: 'kz.agt.action.rejected',
  AGENT_AUTHORITY_SHORTFALL: 'kz.agt.action.authority_shortfall_detected',

  // --- People (hr) ----------------------------------------------------------
  // Every §14.3 lifecycle transition also publishes
  // `kz.hr.<object>.<verb_past_tense>`, built at emit time from the machine's
  // verb map, so the log carries the transition's own name rather than a
  // generic "updated". These are the events that exist outside a transition.
  EMPLOYMENT_RELATIONSHIP_CREATED: 'kz.hr.employment.created',
  EMPLOYMENT_CONFIRMATION_CHANGED: 'kz.hr.employment.confirmation_changed',
  ONBOARDING_INITIATED: 'kz.hr.onboarding.initiated',
  OFFBOARDING_INITIATED: 'kz.hr.offboarding.initiated',
  REQUISITION_CREATED: 'kz.hr.requisition.created',
  APPLICATION_CREATED: 'kz.hr.application.created',
  ASSIGNMENT_CREATED: 'kz.hr.assignment.created',
  COMPENSATION_RECORD_CREATED: 'kz.hr.compensation.created',
  LEAVE_REQUEST_CREATED: 'kz.hr.leave.created',
  LEAVE_BALANCE_POSTED: 'kz.hr.leave_balance.posted',
  WORK_ATTENDANCE_RECORDED: 'kz.hr.work_attendance.recorded',
  GOAL_CREATED: 'kz.hr.goal.created',
  PERFORMANCE_EVIDENCE_RECORDED: 'kz.hr.performance_evidence.recorded',
  LEARNING_RECORD_ENROLLED: 'kz.hr.learning_record.enrolled',
  LEARNING_RECORD_COMPLETED: 'kz.hr.learning_record.completed',
  CAPABILITY_CLAIM_ASSERTED: 'kz.hr.capability_claim.asserted',
  CAPABILITY_CLAIM_VERIFIED: 'kz.hr.capability_claim.verified',
  CAPABILITY_CLAIM_CONTRADICTED: 'kz.hr.capability_claim.contradicted',
  CAPABILITY_CLAIM_STATE_CHANGED: 'kz.hr.capability_claim.state_changed',
  PAYROLL_INSTRUCTION_CREATED: 'kz.hr.payroll_instruction.created',
  PAYROLL_RUN_CREATED: 'kz.hr.payroll_run.created',
  POSITION_CREATED: 'kz.org.position.created',

  // --- The books (fin) ------------------------------------------------------
  TRANSACTION_RECORDED: 'kz.fin.transaction.recorded',
  // A reversal is its own event rather than an update, because "this was
  // wrong and here is the correction" is a different fact from "this changed".
  TRANSACTION_REVERSED: 'kz.fin.transaction.reversed',
  VENDOR_BILL_RECORDED: 'kz.fin.vendor_bill.recorded',
  VENDOR_BILL_PAID: 'kz.fin.vendor_bill.paid',
  BUDGET_LINE_SET: 'kz.fin.budget_line.set',
  RECURRING_GENERATED: 'kz.fin.recurring.generated',
  FIXED_ASSET_RECORDED: 'kz.fin.fixed_asset.recorded',
  LOAN_RECORDED: 'kz.fin.loan.recorded',
  INVOICE_TAX_PRICED: 'kz.fin.invoice.tax_priced',
  PAYROLL_POSTED_TO_BOOKS: 'kz.fin.payroll.posted',

  // GST returns. Preparing one and filing it are separate events because they
  // are separate acts with different consequences: the first is arithmetic, the
  // second closes the period and is the one a notice will ask about.
  GST_RETURN_PREPARED: 'kz.fin.gst_return.prepared',
  GST_RETURN_FILED: 'kz.fin.gst_return.filed',
  GST_RETURN_SUPERSEDED: 'kz.fin.gst_return.superseded',

  // The company's own registration details, which every invoice is printed
  // from and every return is filed under.
  COMPANY_PROFILE_UPDATED: 'kz.fin.company_profile.updated',

  // Imports. A figure in the books must be traceable to the file it came from,
  // so staging, committing and reverting are all events rather than silent
  // bulk writes.
  IMPORT_STAGED: 'kz.fin.import.staged',
  IMPORT_COMMITTED: 'kz.fin.import.committed',
  IMPORT_REVERTED: 'kz.fin.import.reverted',

  // Board
  BOARD_MEMBER_ADDED: 'kz.eqt.board_member.added',
  BOARD_MEMBER_CEASED: 'kz.eqt.board_member.ceased',
  MEETING_CALLED: 'kz.eqt.meeting.called',
  MEETING_HELD: 'kz.eqt.meeting.held',
  MEETING_MINUTED: 'kz.eqt.meeting.minuted',
  MEETING_CANCELLED: 'kz.eqt.meeting.cancelled',
  RESOLUTION_PROPOSED: 'kz.eqt.resolution.proposed',
  RESOLUTION_CIRCULATED: 'kz.eqt.resolution.circulated',
  RESOLUTION_PASSED: 'kz.eqt.resolution.passed',
  RESOLUTION_FAILED: 'kz.eqt.resolution.failed',
  RESOLUTION_WITHDRAWN: 'kz.eqt.resolution.withdrawn',
  VOTE_CAST: 'kz.eqt.vote.cast',
  COMPLIANCE_ITEM_RAISED: 'kz.eqt.compliance.raised',
  COMPLIANCE_ITEM_RESOLVED: 'kz.eqt.compliance.resolved',
} as const;

/**
 * The `kz.hr.*` name for a lifecycle transition. Composed rather than listed
 * because the verb maps in `hr.ts` are the authority on the past tense, and
 * duplicating 90-odd names here would let the two drift.
 */
export function hrTransitionEvent(object: string, verb: string): string {
  return `kz.hr.${object}.${verb}`;
}

export type KnownEventName = (typeof EVENTS)[keyof typeof EVENTS];

// ---------------------------------------------------------------------------
// The event envelope (§3.5). Every event carries the full envelope, not just a
// payload. `tenant_id` is present without exception.
// ---------------------------------------------------------------------------

export type ActorType = 'human' | 'agent' | 'system' | 'integration';

export interface EventActor {
  actorType: ActorType;
  partyId?: string | null;
  accessRole?: string | null;
  agentId?: string | null;
  onBehalfOfPartyId?: string | null;
}

export interface EventSubject {
  entityType: string;
  entityId: string;
  recordCode?: string | null;
}

export interface EventRelatedRef {
  relation: string;
  entityType: string;
  entityId: string;
}

export interface EventReason {
  reasonCode?: string | null;
  note?: string | null;
  decisionId?: string | null;
  policyId?: string | null;
  policyVersion?: number | null;
}

export interface EventSource {
  system: string;
  channel: string;
  requestId?: string | null;
  integrationId?: string | null;
  ingestBatchId?: string | null;
}

export interface EventMateriality {
  measure: string;
  value: number;
  currency?: string | null;
}

export interface EventImpact {
  domains: string[];
  severity?: SeverityCode | null;
  materiality?: EventMateriality | null;
}

export interface EventOwner {
  partyId?: string | null;
  positionId?: string | null;
}

export interface EventIntegrity {
  prevHash: string | null;
  hash: string;
}

export interface EventEnvelope {
  eventId: string;
  eventName: EventName;
  eventVersion: number;
  tenantId: string;
  occurredAt: string;
  recordedAt: string;
  actor: EventActor;
  subject: EventSubject;
  related: EventRelatedRef[];
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  reason: EventReason | null;
  source: EventSource;
  impact: EventImpact;
  owner: EventOwner | null;
  correlationId: string;
  causationId: string | null;
  confidentiality: SensitivityClass;
  retentionClass: string;
  integrity: EventIntegrity;
}

// ---------------------------------------------------------------------------
// Exception severity (S0–S4) and notification priority (N0–N4) are kept
// structurally separate — a high-severity exception and an urgent notification
// are related but independent judgments (§3.6).
// ---------------------------------------------------------------------------

export const SEVERITIES = ['S0_INFO', 'S1_ATTENTION', 'S2_WARNING', 'S3_HIGH_RISK', 'S4_CRITICAL'] as const;
export type SeverityCode = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<SeverityCode, number> = {
  S0_INFO: 0,
  S1_ATTENTION: 1,
  S2_WARNING: 2,
  S3_HIGH_RISK: 3,
  S4_CRITICAL: 4,
};

export const NOTIFICATION_PRIORITIES = ['N0_AMBIENT', 'N1_LOW', 'N2_NORMAL', 'N3_HIGH', 'N4_URGENT'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** Escalation is bounded to exactly four named triggers. Nothing escalates by default outside these. */
export const ESCALATION_TRIGGERS = ['sla_expiry', 'decline', 'authority_insufficiency', 'severity_increase'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// Sensitivity classification (the WHAT axis).
// ---------------------------------------------------------------------------

export const SENSITIVITY_CLASSES = ['public', 'internal', 'restricted', 'confidential', 'regulated'] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

export const SENSITIVITY_RANK: Record<SensitivityClass, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
  confidential: 3,
  regulated: 4,
};

export function maxSensitivity(classes: SensitivityClass[]): SensitivityClass {
  if (classes.length === 0) return 'internal';
  return classes.reduce((a, b) => (SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a));
}

/** Closed set of withholding reason codes (§10.4.4). */
export const WITHHOLD_REASONS = [
  'no_permission',
  'out_of_scope',
  'classification_ceiling',
  'authority_insufficient',
  'purpose_unbound',
  'consent_absent',
] as const;
export type WithholdReason = (typeof WITHHOLD_REASONS)[number];
