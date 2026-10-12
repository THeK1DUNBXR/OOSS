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

/**
 * The canonical event-name grammar, `kz.<domain>.<object>.<verb>`. The verb is
 * captured so the tense can be checked. An event records a fact that already
 * happened, so the verb is past tense, and a present-tense name is refused at
 * both ends (emit and outbox dispatch) rather than stored.
 */
export const EVENT_NAME_PATTERN = /^kz\.[a-z]{2,4}\.[a-z_]+\.([a-z0-9_]+)$/;
// The verb admits digits because `onboarding.day1_activated` is a fact the
// onboarding machine already emits (ACTIVATE_DAY1). Refusing the digit made the
// outbox dead-letter that event as permanent; renaming it would orphan history.

/**
 * Past-tense verbs that do not end in -ed. Listed rather than inferred: a rule
 * that guessed would accept `kz.x.y.set` only by luck and refuse `kz.x.y.sent`.
 */
const IRREGULAR_PAST = new Set([
  'built',
  'begun',
  'brought',
  'bought',
  'caught',
  'cast',
  'cut',
  'done',
  'given',
  'got',
  'held',
  'hit',
  'kept',
  'known',
  'laid',
  'led',
  'left',
  'let',
  'lost',
  'made',
  'met',
  'paid',
  'put',
  'read',
  'reset',
  'run',
  'sent',
  'set',
  'shut',
  'sold',
  'spent',
  'split',
  'taken',
  'told',
  'withdrawn',
  'won',
  'written',
]);

/**
 * Names that predate the tense rule and are still emitted, subscribed to, or
 * stored in event_records, so renaming them would orphan that history and the
 * subscribers that read it. They are exempt from the tense check only. Any
 * new name must pass it, and removing an entry here means renaming the event
 * with a dual-publish window (CRM-FOUND-002 pattern), not just editing this list.
 */
export const TENSE_GRANDFATHERED: ReadonlySet<string> = new Set([
  // Lifecycle names whose verb is the state the record moved into, not a past
  // participle. Emitted by `platform/lifecycle.transition` from the machine's
  // verb map, so they are the names on the wire today. Each is a state, which
  // is why none has a participle to find.
  'kz.hr.compensation.effective', // CompensationRecord ACTIVATE (employment.ts:1036)
  'kz.hr.leave.extension_in_progress', // LeaveRequest EXTENSION_RUNNING (leave.ts:341)
  'kz.hr.ticket.waiting', // IT ticket WAIT before it was filed under kz.it.ticket.moved_to_waiting; kept so stored history passes the grammar
  'kz.ceo.key_result.checked_in',
  'kz.crm.contract.expiring',
  'kz.crm.opportunity.handed_off',
  'kz.eqt.allotment.effective',
  'kz.eqt.bonus.effective',
  'kz.eqt.buyback.effective',
  'kz.eqt.conversion.effective',
  'kz.eqt.redemption.effective',
  'kz.eqt.transfer.effective',
  'kz.it.asset.warranty_approaching',
  'kz.it.licence.renewal_approaching',
  'kz.it.vendor_contract.expiring',
  'kz.mkt.event.live',
  'kz.mkt.event.no_show',
]);

/** Words that end in -ed but are base forms, so they are not past tense. */
const ED_BASE_FORMS = new Set([
  'bleed',
  'breed',
  'embed',
  'exceed',
  'feed',
  'heed',
  'need',
  'proceed',
  'seed',
  'shed',
  'speed',
  'succeed',
  'weed',
]);

function isPastTenseWord(word: string): boolean {
  if (IRREGULAR_PAST.has(word)) return true;
  return word.length > 2 && word.endsWith('ed') && !ED_BASE_FORMS.has(word);
}

/**
 * A verb is past tense when any of its underscore-separated words is: the
 * participle is not always last (`submitted_for_review`, `routed_for_approval`,
 * `day1_activated`, `status_changed`). A present-tense verb has no past word
 * anywhere, so `create` and `pay` are still refused.
 */
export function isPastTenseVerb(verb: string): boolean {
  return verb.split('_').some(isPastTenseWord);
}

export function isCanonicalEventName(name: string): boolean {
  const match = EVENT_NAME_PATTERN.exec(name);
  if (match === null) return false;
  return TENSE_GRANDFATHERED.has(name) || isPastTenseVerb(match[1]!);
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
  PERSON_DELETED: 'kz.idn.person.deleted',
  PERSON_MERGED: 'kz.idn.person.merged',
  MERGE_CANDIDATE_RAISED: 'kz.idn.merge_candidate.raised',
  MERGE_CANDIDATE_CONFIRMED: 'kz.idn.merge_candidate.confirmed',
  MERGE_CANDIDATE_REJECTED: 'kz.idn.merge_candidate.rejected',
  AFFILIATION_CREATED: 'kz.idn.affiliation.created',
  AFFILIATION_ENDED: 'kz.idn.affiliation.ended',
  ORGANIZATION_CREATED: 'kz.idn.organization.created',
  SESSION_CONTEXT_SWITCHED: 'kz.idn.session.context_switched',
  SESSION_ISSUED: 'kz.idn.session.issued',
  SESSION_REVOKED: 'kz.idn.session.revoked',
  /// A rotated-away refresh secret was presented again: the whole session is revoked.
  SESSION_REFRESH_REUSED: 'kz.idn.session.refresh_reused',
  /// A refresh whose response was lost, recovered because the rotated secret was never used.
  SESSION_REFRESH_RECOVERED: 'kz.idn.session.refresh_recovered',
  /// A sign-in created for an outsider — a shareholder or board member with no
  /// employment here (§1.10). Never fires on the founding-account seed path.
  SIGN_IN_CREATED: 'kz.idn.sign_in.created',
  SIGN_IN_RESET: 'kz.idn.sign_in.reset',
  /// A locked-out account's sign-in was recovered by the founder or the IT desk:
  /// password rotated, live sessions revoked, optionally TOTP cleared. Carries no
  /// secret. The domain is `idn` because the grammar admits two to four letters.
  ACCOUNT_RECOVERED: 'kz.idn.account.recovered',
  /// A principal chose which entity to continue in, after `login()` returned
  /// more than one. Written in the target tenant only — switching carries no
  /// cross-tenant event, the same way the token it issues carries no
  /// cross-tenant reach.
  ENTITY_SWITCHED: 'kz.idn.entity.switched',
  /// `reconcileTenantKinds` flipped a tenant's `kind` for the first time —
  /// the moment s.2(85) ends small-company status for it (§1a.1).
  TENANT_KIND_CHANGED: 'kz.sys.tenant.kind_changed',
  // A dead-lettered outbox event put back in line for delivery. Replaying is a
  // governed act of its own, so it leaves a fact as well as the audit row.
  OUTBOX_DEAD_LETTER_REPLAYED: 'kz.sys.outbox_dead_letter.replayed',

  // --- Spin-out: a division carved out into its own subsidiary tenant
  // (equity-portal plan §6b) — emitted in both the holding and the
  // subsidiary tenant, by `pnpm division:spin-out`.
  TENANT_SPIN_OUT_PREVIEWED: 'kz.sys.spin_out.previewed',
  TENANT_SPIN_OUT_COMMITTED: 'kz.sys.spin_out.committed',
  TENANT_SPIN_OUT_REVERTED: 'kz.sys.spin_out.reverted',
  // The onboarding run (PR10). One name per state reached, in the past tense the grammar
  // requires. `activated` is the ACTIVATE self-loop's name too: a re-confirmation is a fact.
  ONBOARDING_COMPANY_PROFILE_RECORDED: 'kz.sys.onboarding.company_profile_recorded',
  ONBOARDING_STATUTORY_CONFIGURED: 'kz.sys.onboarding.statutory_configured',
  ONBOARDING_OPENINGS_IMPORTED: 'kz.sys.onboarding.openings_imported',
  ONBOARDING_VERIFIED: 'kz.sys.onboarding.verified',
  ONBOARDING_ACTIVATED: 'kz.sys.onboarding.activated',
  ONBOARDING_BLOCKED: 'kz.sys.onboarding.blocked',
  ONBOARDING_RESUMED: 'kz.sys.onboarding.resumed',

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
  /// A student left a course before finishing it. This is also a finance
  /// fact: it is what closes out that course's temp invoice with a final
  /// (tax) invoice, dated the day of withdrawal — see `finalizeCourseFeeInvoice`.
  ENROLLMENT_WITHDRAWN: 'kz.edu.enrollment.withdrawn',
  STUDENT_PROFILE_ENDED: 'kz.edu.student_profile.ended',
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
  /// A batch is the unit that attendance, progress and fees are booked against,
  /// so its creation is a fact the rest of the platform has to be able to see.
  COHORT_CREATED: 'kz.edu.cohort.created',
  /// Projects carry delivery status and hand-off, and are governed under the
  /// `prj` domain (registered in routes/education.routes.ts), so their events
  /// use that domain too rather than `edu`.
  PROJECT_CREATED: 'kz.prj.project.created',
  PROJECT_UPDATED: 'kz.prj.project.updated',

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
  DECISION_LINKED: 'kz.gov.decision.linked',
  // A commitment's state changes. `missed` is also written by the scheduled job,
  // so a subscriber must not assume a person did it: the actor is null then.
  COMMITMENT_PROPOSED: 'kz.gov.commitment.proposed',
  COMMITMENT_CONFIRMED: 'kz.gov.commitment.confirmed',
  COMMITMENT_MET: 'kz.gov.commitment.met',
  COMMITMENT_MISSED: 'kz.gov.commitment.missed',
  COMMITMENT_CANCELLED: 'kz.gov.commitment.cancelled',
  COMMITMENT_REASSIGNED: 'kz.gov.commitment.reassigned',
  // A case's state changes (Wave 6, OP:116). Silence is not an acknowledgement:
  // `marked_overdue` is written by the scheduled job and leaves the state open,
  // so a subscriber that reads it must not take it for a person's acknowledgement.
  CASE_OPENED: 'kz.gov.case.opened',
  CASE_ACKNOWLEDGED: 'kz.gov.case.acknowledged',
  CASE_RESOLVED: 'kz.gov.case.resolved',
  CASE_CLOSED: 'kz.gov.case.closed',
  // An open case handed to a successor when its owner exits (SPINE-CONTRACT 1.7).
  // Not a state change, so the state the subscriber reads is unchanged.
  CASE_REASSIGNED: 'kz.gov.case.reassigned',
  CASE_WITHDRAWN: 'kz.gov.case.withdrawn',
  CASE_MARKED_OVERDUE: 'kz.gov.case.marked_overdue',
  CASE_EXCEPTION_RAISED: 'kz.gov.case.exception_raised',
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
  AGENT_PRINCIPAL_STATUS_CHANGED: 'kz.agt.principal.status_changed',

  // --- People (hr) ----------------------------------------------------------
  // Every §14.3 lifecycle transition also publishes
  // `kz.hr.<object>.<verb_past_tense>`, built at emit time from the machine's
  // verb map, so the log carries the transition's own name rather than a
  // generic "updated". These are the events that exist outside a transition.
  EMPLOYMENT_RELATIONSHIP_CREATED: 'kz.hr.employment.created',
  EMPLOYMENT_CONFIRMATION_CHANGED: 'kz.hr.employment.confirmation_changed',
  EMPLOYMENT_RELATIONSHIP_ENDED: 'kz.hr.employment.ended',
  ONBOARDING_INITIATED: 'kz.hr.onboarding.initiated',
  OFFBOARDING_INITIATED: 'kz.hr.offboarding.initiated',
  // An exit went ahead with open rows left with the leaver, under a recorded
  // override. The rows and the reason are on the audit row; this says it happened.
  OFFBOARDING_HANDOVER_OVERRIDE_RECORDED: 'kz.hr.offboarding.handover_override_recorded',
  REQUISITION_CREATED: 'kz.hr.requisition.created',
  APPLICATION_CREATED: 'kz.hr.application.created',
  ASSIGNMENT_CREATED: 'kz.hr.assignment.created',
  ASSIGNMENT_ENDED: 'kz.hr.assignment.ended',
  COMPENSATION_RECORD_CREATED: 'kz.hr.compensation.created',
  COMPENSATION_RECORD_VOIDED: 'kz.hr.compensation.voided',
  COMPENSATION_RECORD_SUPERSEDED: 'kz.hr.compensation.superseded',
  COMPENSATION_RECORD_RESTORED: 'kz.hr.compensation.restored',
  LEAVE_REQUEST_CREATED: 'kz.hr.leave.created',
  LEAVE_BALANCE_POSTED: 'kz.hr.leave_balance.posted',
  WORK_ATTENDANCE_RECORDED: 'kz.hr.work_attendance.recorded',
  WORK_ATTENDANCE_VOIDED: 'kz.hr.work_attendance.voided',
  GOAL_CREATED: 'kz.hr.goal.created',
  PERFORMANCE_EVIDENCE_RECORDED: 'kz.hr.performance_evidence.recorded',
  LEARNING_RECORD_ENROLLED: 'kz.hr.learning_record.enrolled',
  LEARNING_RECORD_COMPLETED: 'kz.hr.learning_record.completed',
  SKILL_CREATED: 'kz.hr.skill.created',
  EVIDENCE_ADDED: 'kz.hr.evidence.added',
  CAPABILITY_CLAIM_ASSERTED: 'kz.hr.capability_claim.asserted',
  CAPABILITY_CLAIM_VERIFIED: 'kz.hr.capability_claim.verified',
  CAPABILITY_CLAIM_CONTRADICTED: 'kz.hr.capability_claim.contradicted',
  CAPABILITY_CLAIM_STATE_CHANGED: 'kz.hr.capability_claim.state_changed',
  PAYROLL_INSTRUCTION_CREATED: 'kz.hr.payroll_instruction.created',
  PAYROLL_RUN_CREATED: 'kz.hr.payroll_run.created',
  POSITION_CREATED: 'kz.org.position.created',
  POSITION_ENDED: 'kz.org.position.ended',

  // --- HCM/HRMS (docs/plan/hcm.md), one group per workstream. Every state
  // change a workstream makes emits one of these; a read of regulated data
  // (a payslip, a PAN) is an AUDIT_RECORD instead, never one of these. -------
  // WS1 workforce
  EMPLOYEE_PROFILE_UPDATED: 'kz.hr.employee_profile.updated',
  EMPLOYEE_DOCUMENT_UPLOADED: 'kz.hr.employee_document.uploaded',
  EMPLOYEE_DOCUMENT_VERIFIED: 'kz.hr.employee_document.verified',
  REPORTING_LINE_CHANGED: 'kz.hr.reporting_line.changed',
  EMPLOYEE_CHANGE_SUBMITTED: 'kz.hr.employee_change.submitted',
  EMPLOYEE_CHANGE_APPROVED: 'kz.hr.employee_change.approved',
  EMPLOYEE_CHANGE_REJECTED: 'kz.hr.employee_change.rejected',
  EMPLOYEE_CHANGE_APPLIED: 'kz.hr.employee_change.applied',
  // WS2 time
  SHIFT_CREATED: 'kz.hr.shift.created',
  ROSTER_PUBLISHED: 'kz.hr.roster.published',
  CLOCK_EVENT_RECORDED: 'kz.hr.clock_event.recorded',
  TIMESHEET_SUBMITTED: 'kz.hr.timesheet.submitted',
  TIMESHEET_APPROVED: 'kz.hr.timesheet.approved',
  TIMESHEET_REJECTED: 'kz.hr.timesheet.rejected',
  OVERTIME_REQUEST_SUBMITTED: 'kz.hr.overtime_request.submitted',
  OVERTIME_REQUEST_APPROVED: 'kz.hr.overtime_request.approved',
  OVERTIME_REQUEST_REJECTED: 'kz.hr.overtime_request.rejected',
  COMP_OFF_EARNED: 'kz.hr.comp_off.earned',
  COMP_OFF_CONSUMED: 'kz.hr.comp_off.consumed',
  COMP_OFF_EXPIRED: 'kz.hr.comp_off.expired_detected',
  ATTENDANCE_REGULARISATION_SUBMITTED: 'kz.hr.attendance_regularisation.submitted',
  ATTENDANCE_REGULARISATION_APPROVED: 'kz.hr.attendance_regularisation.approved',
  ATTENDANCE_REGULARISATION_REJECTED: 'kz.hr.attendance_regularisation.rejected',
  // WS3 leavepolicy
  LEAVE_POLICY_CREATED: 'kz.hr.leave_policy.created',
  LEAVE_POLICY_UPDATED: 'kz.hr.leave_policy.updated',
  LEAVE_ACCRUAL_RUN_COMPLETED: 'kz.hr.leave_accrual_run.completed',
  LEAVE_APPROVAL_CHAIN_UPDATED: 'kz.hr.leave_approval_chain.updated',
  // WS4 recruiting
  JOB_POSTING_PUBLISHED: 'kz.hr.job_posting.published',
  JOB_POSTING_CLOSED: 'kz.hr.job_posting.closed',
  CANDIDATE_CREATED: 'kz.hr.candidate.created',
  INTERVIEW_SCHEDULED: 'kz.hr.interview.scheduled',
  INTERVIEW_COMPLETED: 'kz.hr.interview.completed',
  SCORECARD_SUBMITTED: 'kz.hr.scorecard.submitted',
  OFFER_APPROVED: 'kz.hr.offer.approved',
  OFFER_SENT: 'kz.hr.offer.sent',
  OFFER_ACCEPTED: 'kz.hr.offer.accepted',
  OFFER_DECLINED: 'kz.hr.offer.declined',
  REFERRAL_SUBMITTED: 'kz.hr.referral.submitted',
  BACKGROUND_VERIFICATION_COMPLETED: 'kz.hr.background_verification.completed',
  ONBOARDING_TASK_COMPLETED: 'kz.hr.onboarding_task.completed',
  // WS5 performance
  REVIEW_CYCLE_OPENED: 'kz.hr.review_cycle.opened',
  REVIEW_CYCLE_CLOSED: 'kz.hr.review_cycle.closed',
  REVIEW_SUBMITTED: 'kz.hr.review.submitted',
  CALIBRATION_CLOSED: 'kz.hr.calibration.closed',
  FINAL_RATING_RELEASED: 'kz.hr.final_rating.released',
  FEEDBACK_GIVEN: 'kz.hr.feedback.given',
  ONE_ON_ONE_SCHEDULED: 'kz.hr.one_on_one.scheduled',
  PIP_OPENED: 'kz.hr.pip.opened',
  PIP_CLOSED: 'kz.hr.pip.closed',
  SUCCESSION_PLAN_UPDATED: 'kz.hr.succession_plan.updated',
  // WS6 learning
  TRAINING_PROGRAM_CREATED: 'kz.hr.training_program.created',
  TRAINING_SESSION_SCHEDULED: 'kz.hr.training_session.scheduled',
  TRAINING_ENROLLMENT_COMPLETED: 'kz.hr.training_enrollment.completed',
  CERTIFICATION_ISSUED: 'kz.hr.certification.issued',
  CERTIFICATION_EXPIRING: 'kz.hr.certification.expiry_approaching_detected',
  CERTIFICATION_EXPIRED: 'kz.hr.certification.expired_detected',
  IDP_UPDATED: 'kz.hr.idp.updated',
  // WS7 compensation
  SALARY_REVISION_PROPOSED: 'kz.hr.salary_revision.proposed',
  SALARY_REVISION_APPROVED: 'kz.hr.salary_revision.approved',
  SALARY_REVISION_APPLIED: 'kz.hr.salary_revision.applied',
  VARIABLE_PAY_APPROVED: 'kz.hr.variable_pay.approved',
  VARIABLE_PAY_PAID: 'kz.hr.variable_pay.paid',
  BENEFIT_ENROLLMENT_CREATED: 'kz.hr.benefit_enrollment.created',
  EMPLOYEE_LOAN_APPROVED: 'kz.hr.employee_loan.approved',
  EMPLOYEE_LOAN_DISBURSED: 'kz.hr.employee_loan.disbursed',
  EMPLOYEE_LOAN_CLOSED: 'kz.hr.employee_loan.closed',
  EXPENSE_CLAIM_SUBMITTED: 'kz.hr.expense_claim.submitted',
  EXPENSE_CLAIM_APPROVED: 'kz.hr.expense_claim.approved',
  EXPENSE_CLAIM_REJECTED: 'kz.hr.expense_claim.rejected',
  EXPENSE_CLAIM_REIMBURSED: 'kz.hr.expense_claim.reimbursed',
  // WS8 payrollops
  ADHOC_PAY_APPROVED: 'kz.hr.adhoc_pay.approved',
  ARREAR_APPROVED: 'kz.hr.arrear.approved',
  PAYROLL_JOURNAL_POSTED: 'kz.hr.payroll_journal.posted',
  BANK_ADVICE_GENERATED: 'kz.hr.bank_advice.generated',
  PAYROLL_RECONCILIATION_FLAGGED: 'kz.hr.payroll_reconciliation.unexplained_delta_detected',
  PAYROLL_QUERY_RAISED: 'kz.hr.payroll_query.raised',
  PAYROLL_QUERY_RESOLVED: 'kz.hr.payroll_query.resolved',
  // WS9 engagement
  ANNOUNCEMENT_PUBLISHED: 'kz.hr.announcement.published',
  RECOGNITION_GIVEN: 'kz.hr.recognition.given',
  SURVEY_OPENED: 'kz.hr.survey.opened',
  SURVEY_CLOSED: 'kz.hr.survey.closed',
  HR_CASE_OPENED: 'kz.hr.hr_case.opened',
  HR_CASE_RESOLVED: 'kz.hr.hr_case.resolved',
  HR_CASE_SLA_BREACHED: 'kz.hr.hr_case.sla_breached_detected',
  POLICY_DOCUMENT_PUBLISHED: 'kz.hr.policy_document.published',
  POLICY_ACKNOWLEDGED: 'kz.hr.policy_document.acknowledged',
  EXIT_INTERVIEW_COMPLETED: 'kz.hr.exit_interview.completed',
  // WS10 separations
  RESIGNATION_SUBMITTED: 'kz.hr.resignation.submitted',
  RESIGNATION_ACCEPTED: 'kz.hr.resignation.accepted',
  RESIGNATION_WITHDRAWN: 'kz.hr.resignation.withdrawn',
  RESIGNATION_REJECTED: 'kz.hr.resignation.rejected',
  EXIT_CLEARANCE_COMPLETED: 'kz.hr.exit_clearance.completed',
  NO_DUES_ISSUED: 'kz.hr.no_dues.issued',
  // WS11 assets
  ASSET_ASSIGNED: 'kz.hr.asset.assigned',
  // Custody moved from a leaver to a successor: the old spell is closed and a new
  // one opened, and the asset stays assigned throughout.
  ASSET_TRANSFERRED: 'kz.hr.asset.transferred',
  ASSET_RETURNED: 'kz.hr.asset.returned',
  TRAVEL_REQUEST_SUBMITTED: 'kz.hr.travel_request.submitted',
  TRAVEL_REQUEST_APPROVED: 'kz.hr.travel_request.approved',
  LETTER_REQUEST_SUBMITTED: 'kz.hr.letter_request.submitted',
  LETTER_REQUEST_ISSUED: 'kz.hr.letter_request.issued',
  // WS12 analytics
  HR_REPORT_EXPORTED: 'kz.hr.hr_report.exported',
  // WS13 workflow
  HR_REQUEST_SUBMITTED: 'kz.hr.hr_request.submitted',
  HR_REQUEST_APPROVED: 'kz.hr.hr_request.approved',
  HR_REQUEST_REJECTED: 'kz.hr.hr_request.rejected',
  HR_REQUEST_CLOSED: 'kz.hr.hr_request.closed',
  AUTHORITY_DELEGATION_CREATED: 'kz.hr.authority_delegation.created',
  AUTHORITY_DELEGATION_ENDED: 'kz.hr.authority_delegation.ended',

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
  JOURNAL_POSTED: 'kz.fin.journal.posted',
  JOURNAL_REVERSED: 'kz.fin.journal.reversed',
  // The books' own records. Past tense, one object per name, as the grammar asks.
  LEDGER_ACCOUNT_CREATED: 'kz.fin.ledger_account.created',
  LEDGER_CATEGORY_CREATED: 'kz.fin.ledger_category.created',
  VENDOR_BILL_OVERDUE_FLAGGED: 'kz.fin.vendor_bill.overdue_flagged',
  ACCOUNTING_PERIOD_OPENED: 'kz.fin.accounting_period.opened',
  ACCOUNTING_PERIOD_CLOSE_REQUESTED: 'kz.fin.accounting_period.close_requested',
  ACCOUNTING_PERIOD_CLOSED: 'kz.fin.accounting_period.closed',
  ACCOUNTING_PERIOD_REOPENED: 'kz.fin.accounting_period.reopened',
  BANK_STATEMENT_IMPORTED: 'kz.fin.bank_statement.imported',
  BANK_STATEMENT_LINE_MATCHED: 'kz.fin.bank_statement_line.matched',
  BANK_STATEMENT_LINE_UNMATCHED: 'kz.fin.bank_statement_line.unmatched',
  TRANSACTION_RECONCILED: 'kz.fin.transaction.reconciled',
  RETENTION_REVIEW_RECORDED: 'kz.fin.retention_review.recorded',

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
  // The staged cells of a committed import are blanked once the books hold
  // what they said. A separate event, not IMPORT_COMMITTED again, so a
  // subscriber counting commits does not count the purge as a second one.
  IMPORT_PURGED: 'kz.fin.import.purged',

  // --- Equity register (eqt), phase 1 ---------------------------------------
  SHARE_CLASS_CREATED: 'kz.eqt.share_class.created',
  HOLDER_CREATED: 'kz.eqt.holder.created',
  ALLOTMENT_PROPOSED: 'kz.eqt.allotment.proposed',
  ALLOTMENT_APPROVED: 'kz.eqt.allotment.approved',
  ALLOTMENT_EFFECTIVE: 'kz.eqt.allotment.effective',
  TRANSFER_PROPOSED: 'kz.eqt.transfer.proposed',
  TRANSFER_APPROVED: 'kz.eqt.transfer.approved',
  TRANSFER_EFFECTIVE: 'kz.eqt.transfer.effective',
  SHARE_TRANSACTION_REVERSED: 'kz.eqt.share_transaction.reversed',
  SHARE_TRANSACTION_REJECTED: 'kz.eqt.share_transaction.rejected',
  CERTIFICATE_ISSUED: 'kz.eqt.certificate.issued',
  CERTIFICATE_CANCELLED: 'kz.eqt.certificate.cancelled',
  VALUATION_RECORDED: 'kz.eqt.valuation.recorded',
  ENTITY_DOCUMENT_PUBLISHED: 'kz.eqt.document.published',

  // --- The group (eqt), phase 2 --------------------------------------------
  // Emitted in BOTH tenants on a publish: in the source tenant, a record that
  // its summary went up; in the parent, a record that the group's view of
  // that entity changed. Never the trigger for a cross-tenant read — the
  // written `EntitySnapshot` row is.
  SNAPSHOT_PUBLISHED: 'kz.eqt.snapshot.published',
  // --- Rounds, instruments, valuations, scenarios (eqt), phase 4 -----------
  ROUND_CREATED: 'kz.eqt.round.created',
  ROUND_OPENED: 'kz.eqt.round.opened',
  ROUND_CLOSED: 'kz.eqt.round.closed',
  ROUND_CANCELLED: 'kz.eqt.round.cancelled',
  CONVERSION_PROPOSED: 'kz.eqt.conversion.proposed',
  CONVERSION_APPROVED: 'kz.eqt.conversion.approved',
  CONVERSION_EFFECTIVE: 'kz.eqt.conversion.effective',
  REDEMPTION_PROPOSED: 'kz.eqt.redemption.proposed',
  REDEMPTION_APPROVED: 'kz.eqt.redemption.approved',
  REDEMPTION_EFFECTIVE: 'kz.eqt.redemption.effective',
  BUYBACK_PROPOSED: 'kz.eqt.buyback.proposed',
  BUYBACK_APPROVED: 'kz.eqt.buyback.approved',
  BUYBACK_EFFECTIVE: 'kz.eqt.buyback.effective',
  BONUS_PROPOSED: 'kz.eqt.bonus.proposed',
  BONUS_APPROVED: 'kz.eqt.bonus.approved',
  BONUS_EFFECTIVE: 'kz.eqt.bonus.effective',
  RIGHTS_OFFERED: 'kz.eqt.rights.offered',
  RIGHTS_ACCEPTED: 'kz.eqt.rights.accepted',
  RIGHTS_RENOUNCED: 'kz.eqt.rights.renounced',
  // --- ESOP (eqt), phase 5 ---------------------------------------------------
  ESOP_PLAN_CREATED: 'kz.eqt.esop_plan.created',
  ESOP_PLAN_ACTIVATED: 'kz.eqt.esop_plan.activated',
  OPTION_PROPOSED: 'kz.eqt.option.proposed',
  OPTION_GRANTED: 'kz.eqt.option.granted',
  OPTION_VESTED: 'kz.eqt.option.vested',
  OPTION_EXERCISE_REQUESTED: 'kz.eqt.option.exercise_requested',
  OPTION_EXERCISED: 'kz.eqt.option.exercised',
  OPTION_LAPSED: 'kz.eqt.option.lapsed',
  OPTION_CANCELLED: 'kz.eqt.option.cancelled',
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

  // --- Marketing (mkt) -------------------------------------------------------
  MKT_CAMPAIGN_CREATED: 'kz.mkt.campaign.created',
  MKT_CAMPAIGN_SUBMITTED: 'kz.mkt.campaign.submitted',
  MKT_CAMPAIGN_APPROVED: 'kz.mkt.campaign.approved',
  MKT_CAMPAIGN_REJECTED: 'kz.mkt.campaign.rejected',
  MKT_CAMPAIGN_SCHEDULED: 'kz.mkt.campaign.scheduled',
  MKT_CAMPAIGN_LAUNCHED: 'kz.mkt.campaign.launched',
  MKT_CAMPAIGN_PAUSED: 'kz.mkt.campaign.paused',
  MKT_CAMPAIGN_RESUMED: 'kz.mkt.campaign.resumed',
  MKT_CAMPAIGN_COMPLETED: 'kz.mkt.campaign.completed',
  MKT_CAMPAIGN_ARCHIVED: 'kz.mkt.campaign.archived',
  MKT_CAMPAIGN_CANCELLED: 'kz.mkt.campaign.cancelled',
  MKT_AUDIENCE_CREATED: 'kz.mkt.audience.created',
  MKT_AUDIENCE_EVALUATED: 'kz.mkt.audience.evaluated',
  MKT_AUDIENCE_MEMBER_ADDED: 'kz.mkt.audience.member_added',
  MKT_AUDIENCE_MEMBER_SUPPRESSED: 'kz.mkt.audience.member_suppressed',
  // Consent itself reuses the existing compliance consent events
  // (purposeCode 'marketing') — never duplicated here.
  MKT_PREFERENCE_CHANGED: 'kz.mkt.preference.changed',
  MKT_TEMPLATE_CREATED: 'kz.mkt.template.created',
  MKT_TEMPLATE_SUBMITTED: 'kz.mkt.template.submitted',
  MKT_TEMPLATE_APPROVED: 'kz.mkt.template.approved',
  MKT_TEMPLATE_RETIRED: 'kz.mkt.template.retired',
  MKT_SEND_REQUESTED: 'kz.mkt.send.requested',
  MKT_SEND_APPROVED: 'kz.mkt.send.approved',
  MKT_SEND_QUEUED: 'kz.mkt.send.queued',
  MKT_SEND_SENT: 'kz.mkt.send.sent',
  MKT_SEND_FAILED: 'kz.mkt.send.failed',
  MKT_SEND_CANCELLED: 'kz.mkt.send.cancelled',
  MKT_SEND_RECIPIENT_DELIVERED: 'kz.mkt.send.recipient_delivered',
  MKT_SEND_RECIPIENT_OPENED: 'kz.mkt.send.recipient_opened',
  MKT_SEND_RECIPIENT_CLICKED: 'kz.mkt.send.recipient_clicked',
  MKT_SEND_RECIPIENT_BOUNCED: 'kz.mkt.send.recipient_bounced',
  MKT_SEND_RECIPIENT_UNSUBSCRIBED: 'kz.mkt.send.recipient_unsubscribed',
  MKT_JOURNEY_ACTIVATED: 'kz.mkt.journey.activated',
  MKT_JOURNEY_PAUSED: 'kz.mkt.journey.paused',
  MKT_JOURNEY_RETIRED: 'kz.mkt.journey.retired',
  MKT_JOURNEY_RUN_STARTED: 'kz.mkt.journey.run_started',
  MKT_JOURNEY_RUN_ADVANCED: 'kz.mkt.journey.run_advanced',
  MKT_JOURNEY_RUN_COMPLETED: 'kz.mkt.journey.run_completed',
  MKT_JOURNEY_RUN_EXITED: 'kz.mkt.journey.run_exited',
  MKT_FORM_CREATED: 'kz.mkt.form.created',
  MKT_FORM_PUBLISHED: 'kz.mkt.form.published',
  MKT_FORM_SUBMISSION_RECEIVED: 'kz.mkt.form.submission_received',
  MKT_FORM_SUBMISSION_CONVERTED: 'kz.mkt.form.submission_converted',
  MKT_TOUCHPOINT_RECORDED: 'kz.mkt.touchpoint.recorded',
  MKT_ATTRIBUTION_COMPUTED: 'kz.mkt.attribution.computed',
  MKT_EVENT_CREATED: 'kz.mkt.event.created',
  MKT_EVENT_OPENED: 'kz.mkt.event.opened',
  MKT_EVENT_CLOSED: 'kz.mkt.event.closed',
  MKT_EVENT_COMPLETED: 'kz.mkt.event.completed',
  MKT_EVENT_CANCELLED: 'kz.mkt.event.cancelled',
  MKT_EVENT_REGISTERED: 'kz.mkt.event.registered',
  MKT_EVENT_ATTENDED: 'kz.mkt.event.attended',
  MKT_EVENT_NO_SHOW: 'kz.mkt.event.no_show',
  MKT_ASSET_CREATED: 'kz.mkt.asset.created',
  MKT_ASSET_SUBMITTED: 'kz.mkt.asset.submitted',
  MKT_ASSET_APPROVED: 'kz.mkt.asset.approved',
  MKT_ASSET_RETIRED: 'kz.mkt.asset.retired',
  MKT_SOCIAL_POST_SCHEDULED: 'kz.mkt.social_post.scheduled',
  MKT_SOCIAL_POST_PUBLISHED: 'kz.mkt.social_post.published',
  MKT_SOCIAL_POST_FAILED: 'kz.mkt.social_post.failed',
  MKT_REFERRAL_ISSUED: 'kz.mkt.referral.issued',
  MKT_REFERRAL_USED: 'kz.mkt.referral.used',
  MKT_REFERRAL_QUALIFIED: 'kz.mkt.referral.qualified',
  MKT_REFERRAL_REWARDED: 'kz.mkt.referral.rewarded',
  MKT_REFERRAL_VOIDED: 'kz.mkt.referral.voided',
  MKT_BUDGET_SET: 'kz.mkt.budget.set',
  MKT_BUDGET_APPROVED: 'kz.mkt.budget.approved',
  MKT_SPEND_RECORDED: 'kz.mkt.spend.recorded',
  MKT_SPEND_RECONCILED: 'kz.mkt.spend.reconciled',
  MKT_CLAIM_PROPOSED: 'kz.mkt.claim.proposed',
  MKT_CLAIM_APPROVED: 'kz.mkt.claim.approved',
  MKT_CLAIM_REJECTED: 'kz.mkt.claim.rejected',
  MKT_PLAN_CREATED: 'kz.mkt.plan.created',
  MKT_PLAN_APPROVED: 'kz.mkt.plan.approved',
  MKT_PLAN_CLOSED: 'kz.mkt.plan.closed',
  MKT_WEBHOOK_RECEIVED: 'kz.mkt.webhook.received',
  MKT_WEBHOOK_ENDPOINT_PROVISIONED: 'kz.mkt.webhook.endpoint_provisioned',

  // --- Filings, demat, FEMA (eqt), phase 6a ---------------------------------
  FILING_RECORDED: 'kz.eqt.filing.recorded',
  // Compliance calendar (docs/plan/compliance.md, workstream A). Generating a
  // period's obligations, marking one filed and waiving one are three separate
  // facts — generation is arithmetic, filing is the acknowledgement a portal
  // gave back, and a waiver is a deliberate decision not to file at all.
  COMPLIANCE_OBLIGATIONS_GENERATED: 'kz.cmp.obligation.generated',
  COMPLIANCE_OBLIGATION_FILED: 'kz.cmp.obligation.filed',
  COMPLIANCE_OBLIGATION_WAIVED: 'kz.cmp.obligation.waived',
  // Statutory rule parameters (FIXES P2). Approval is the fact that lets a rate
  // reach a payslip, so it is an event of its own, separate from drafting.
  STATUTORY_RULE_DRAFTED: 'kz.cmp.statutory_rule.drafted',
  STATUTORY_RULE_APPROVED: 'kz.cmp.statutory_rule.approved',
  STATUTORY_RULE_HELD: 'kz.cmp.statutory_rule.held',

  // --- Technology (docs/plan/cio.md) ----------------------------------------
  // A. Assets and devices
  IT_ASSET_CREATED: 'kz.it.asset.created',
  IT_ASSET_TRANSITIONED: 'kz.it.asset.transitioned',
  IT_ASSET_ASSIGNED: 'kz.it.asset.assigned',
  IT_ASSET_RETURNED: 'kz.it.asset.returned',
  IT_ASSET_WARRANTY_APPROACHING: 'kz.it.asset.warranty_approaching',
  // B. Applications, licences and subscriptions
  IT_APPLICATION_CREATED: 'kz.it.application.created',
  IT_APPLICATION_TRANSITIONED: 'kz.it.application.transitioned',
  IT_LICENCE_CREATED: 'kz.it.licence.created',
  IT_LICENCE_RENEWAL_PROPOSED: 'kz.it.licence.renewal_proposed',
  IT_LICENCE_RENEWED: 'kz.it.licence.renewed',
  IT_LICENCE_RENEWAL_APPROACHING: 'kz.it.licence.renewal_approaching',
  IT_LICENCE_CANCELLED: 'kz.it.licence.cancelled',
  // C. Vendors and contracts
  IT_VENDOR_CREATED: 'kz.it.vendor.created',
  IT_VENDOR_ASSESSED: 'kz.it.vendor.assessed',
  IT_VENDOR_CONTRACT_CREATED: 'kz.it.vendor_contract.created',
  IT_VENDOR_CONTRACT_TRANSITIONED: 'kz.it.vendor_contract.transitioned',
  IT_VENDOR_CONTRACT_EXPIRING: 'kz.it.vendor_contract.expiring',
  // D. Service desk
  IT_TICKET_RAISED: 'kz.it.ticket.raised',
  IT_TICKET_TRANSITIONED: 'kz.it.ticket.transitioned',
  // One name per ticket transition, the verbs in TICKET_EVENT_VERB (it/servicedesk.ts).
  IT_TICKET_TRIAGED: 'kz.it.ticket.triaged',
  IT_TICKET_STARTED: 'kz.it.ticket.started',
  IT_TICKET_MOVED_TO_WAITING: 'kz.it.ticket.moved_to_waiting',
  IT_TICKET_RESUMED: 'kz.it.ticket.resumed',
  IT_TICKET_RESOLVED: 'kz.it.ticket.resolved',
  IT_TICKET_CLOSED: 'kz.it.ticket.closed',
  IT_TICKET_REOPENED: 'kz.it.ticket.reopened',
  IT_TICKET_ASSIGNED: 'kz.it.ticket.assigned',
  IT_TICKET_SLA_BREACHED: 'kz.it.ticket.sla_breached',
  IT_TICKET_RATED: 'kz.it.ticket.rated',
  IT_KNOWLEDGE_PUBLISHED: 'kz.it.knowledge.published',
  // E. Incidents, problems and changes
  IT_INCIDENT_DECLARED: 'kz.it.incident.declared',
  IT_INCIDENT_TRANSITIONED: 'kz.it.incident.transitioned',
  IT_INCIDENT_REVIEW_PUBLISHED: 'kz.it.incident.review_published',
  IT_PROBLEM_CREATED: 'kz.it.problem.created',
  IT_PROBLEM_TRANSITIONED: 'kz.it.problem.transitioned',
  IT_CHANGE_CREATED: 'kz.it.change.created',
  IT_CHANGE_TRANSITIONED: 'kz.it.change.transitioned',
  IT_CHANGE_FREEZE_DECLARED: 'kz.it.change.freeze_declared',
  // F. Security and governance
  IT_RISK_CREATED: 'kz.it.risk.created',
  IT_RISK_TRANSITIONED: 'kz.it.risk.transitioned',
  IT_POLICY_PUBLISHED: 'kz.it.policy.published',
  IT_POLICY_RETIRED: 'kz.it.policy.retired',
  IT_POLICY_ACKNOWLEDGED: 'kz.it.policy.acknowledged',
  IT_CONTROL_TESTED: 'kz.it.control.tested',
  IT_ACCESS_REVIEW_OPENED: 'kz.it.access_review.opened',
  IT_ACCESS_REVIEW_DECIDED: 'kz.it.access_review.decided',
  IT_ACCESS_REVIEW_CLOSED: 'kz.it.access_review.closed',
  IT_FINDING_RAISED: 'kz.it.finding.raised',
  IT_FINDING_TRANSITIONED: 'kz.it.finding.transitioned',
  // G. Portfolio and budget
  IT_INITIATIVE_CREATED: 'kz.it.initiative.created',
  IT_INITIATIVE_TRANSITIONED: 'kz.it.initiative.transitioned',
  IT_INITIATIVE_UPDATED: 'kz.it.initiative.updated',
  IT_BUDGET_LINE_SET: 'kz.it.budget.line_set',
  IT_BUDGET_BURN_EXCEEDED: 'kz.it.budget.burn_exceeded',
  IT_TECH_DEBT_CREATED: 'kz.it.tech_debt.created',
  IT_TECH_DEBT_TRANSITIONED: 'kz.it.tech_debt.transitioned',
  // H. Continuity and operations
  IT_CONTINUITY_PLAN_SET: 'kz.it.continuity.plan_set',
  IT_CONTINUITY_TESTED: 'kz.it.continuity.tested',
  IT_AVAILABILITY_RECORDED: 'kz.it.availability.recorded',
  IT_MAINTENANCE_SCHEDULED: 'kz.it.maintenance.scheduled',
  // --- Chairman's Office (ceo), docs/plan/ceo-office.md §5/§6 --------------
  // Phase 0 owns the full list; each owning phase (1-9) emits only its own
  // names.
  // Phase 1 — Cockpit & KPI Library
  CEO_KPI_DEFINITION_CREATED: 'kz.ceo.kpi_definition.created',
  CEO_KPI_FORMULA_PUBLISHED: 'kz.ceo.kpi_formula.published',
  CEO_NORTH_STAR_CHANGED: 'kz.ceo.north_star.changed',
  // Phase 2 — Strategy & OKRs
  CEO_VISION_SET: 'kz.ceo.vision.set',
  CEO_AOP_SUBMITTED: 'kz.ceo.aop.submitted',
  CEO_AOP_ACTIVATED: 'kz.ceo.aop.activated',
  CEO_OBJECTIVE_CREATED: 'kz.ceo.objective.created',
  CEO_OBJECTIVE_SCORED: 'kz.ceo.objective.scored',
  CEO_KEY_RESULT_CHECKED_IN: 'kz.ceo.key_result.checked_in',
  // Phase 3 — Initiatives
  CEO_INITIATIVE_CREATED: 'kz.ceo.initiative.created',
  CEO_INITIATIVE_STATUS_CHANGED: 'kz.ceo.initiative.status_changed',
  CEO_INITIATIVE_KILLED: 'kz.ceo.initiative.killed',
  CEO_INITIATIVE_MILESTONE_COMPLETED: 'kz.ceo.initiative.milestone_completed',
  // Phase 4 — Operating Rhythm
  CEO_MEETING_SCHEDULED: 'kz.ceo.meeting.scheduled',
  CEO_MEETING_CLOSED: 'kz.ceo.meeting.closed',
  CEO_ISSUE_RAISED: 'kz.ceo.issue.raised',
  CEO_ISSUE_RESOLVED: 'kz.ceo.issue.resolved',
  CEO_ACTION_ITEM_COMPLETED: 'kz.ceo.action_item.completed',
  // Phase 5 — Delegation of Authority & Approvals Inbox
  CEO_DOA_ENTRY_CHANGED: 'kz.ceo.doa_entry.changed',
  CEO_DELEGATION_CREATED: 'kz.ceo.delegation.created',
  CEO_DELEGATION_ENDED: 'kz.ceo.delegation.ended',
  // Phase 6 — Board Pack, Investor Updates & Stakeholders
  CEO_BOARD_PACK_ISSUED: 'kz.ceo.board_pack.issued',
  CEO_INVESTOR_UPDATE_ISSUED: 'kz.ceo.investor_update.issued',
  CEO_DOCUMENT_CIRCULATED: 'kz.ceo.document.circulated',
  CEO_DOCUMENT_ACKNOWLEDGED: 'kz.ceo.document.acknowledged',
  CEO_STAKEHOLDER_TOUCHED: 'kz.ceo.stakeholder.touched',
  // Phase 7 — Risk Register, Policy Register & Governance Overview
  CEO_RISK_RAISED: 'kz.ceo.risk.raised',
  CEO_RISK_CLOSED: 'kz.ceo.risk.closed',
  CEO_POLICY_PUBLISHED: 'kz.ceo.policy.published',
  CEO_POLICY_ACKNOWLEDGED: 'kz.ceo.policy.acknowledged',
  // Phase 8 — Financial Planning & Headcount
  CEO_SCENARIO_CREATED: 'kz.ceo.scenario.created',
  CEO_BUDGET_LINE_PROPOSED: 'kz.ceo.budget_line.proposed',
  CEO_HEADCOUNT_PLAN_APPROVED: 'kz.ceo.headcount_plan.approved',
  // Phase 9 — Leadership, Org, 1:1s & Succession
  CEO_SEAT_CREATED: 'kz.ceo.seat.created',
  CEO_SEAT_REASSIGNED: 'kz.ceo.seat.reassigned',
  CEO_SUCCESSION_REVIEWED: 'kz.ceo.succession.reviewed',
  CEO_ONE_ON_ONE_LOGGED: 'kz.ceo.one_on_one.logged',

  // --- Organisation: business-line registry (VERTICAL-TAXONOMY s.6-7). Emitted
  // by apps/api/src/domains/businessLines.ts, one per governed write.
  BUSINESS_LINE_CREATED: 'kz.org.business_line.created',
  BUSINESS_LINE_RENAMED: 'kz.org.business_line.renamed',
  BUSINESS_LINE_RETIRED: 'kz.org.business_line.retired',
  BUSINESS_LINE_SUCCESSOR_RECORDED: 'kz.org.business_line_successor.recorded',
  LINE_DISTRIBUTION_RECORDED: 'kz.org.line_distribution.recorded',
  LINE_DISTRIBUTION_SUPERSEDED: 'kz.org.line_distribution.superseded',

  // --- Organisation: business-line units (SPINE-CONTRACT s.1.0). Emitted by
  // apps/api/src/domains/units.ts. A move emits one `moved`; its two rows are
  // audited separately.
  UNIT_OPENED: 'kz.org.unit.opened',
  UNIT_CLOSED: 'kz.org.unit.closed',
  UNIT_MOVED: 'kz.org.unit.moved',

  // --- Organisation: tunable thresholds (SPINE-CONTRACT s.1.10). Emitted by
  // apps/api/src/domains/thresholds.ts, one per governed write.
  THRESHOLD_UPDATED: 'kz.org.threshold.updated',

  // --- Governance: level-based access assignments (ACCESS-MODEL-PLAN s.7). Emitted by
  // apps/api/src/domains/access/assignments.ts, one per governed write. The domain is
  // `gov`, a bounded context; `kz.access` is refused by EVENT_NAME_PATTERN (4 letters max).
  ACCESS_ASSIGNMENT_SUGGESTED: 'kz.gov.access_assignment.suggested',
  ACCESS_ASSIGNMENT_CONFIRMED: 'kz.gov.access_assignment.confirmed',
  ACCESS_ASSIGNMENT_EXPIRED: 'kz.gov.access_assignment.expired',
  ACCESS_ASSIGNMENT_COMPILED: 'kz.gov.access_assignment.compiled',
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
