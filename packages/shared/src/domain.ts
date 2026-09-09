/**
 * P2 — World Model vocabulary shared by API and web.
 */

// ---------------------------------------------------------------------------
// Verticals & pipelines
// ---------------------------------------------------------------------------

export const VERTICALS = [
  'education',
  'corporate_training',
  'sap_enterprise',
  'cybersecurity',
  'software_ai',
  'placement',
  'partnerships',
  'research',
  'other',
] as const;
export type Vertical = (typeof VERTICALS)[number];

export const VERTICAL_LABELS: Record<Vertical, string> = {
  education: 'Education',
  corporate_training: 'Corporate Training',
  sap_enterprise: 'SAP Enterprise',
  cybersecurity: 'Cybersecurity',
  software_ai: 'Software & AI',
  placement: 'Placement',
  partnerships: 'Partnerships',
  research: 'Research',
  other: 'Other',
};

export const COMMERCIAL_MOTIONS = [
  'enterprise_direct',
  'institution_partnership',
  'learner_admission',
  'workforce_placement',
  'renewal_expansion',
] as const;
export type CommercialMotion = (typeof COMMERCIAL_MOTIONS)[number];

export const ACCOUNT_KINDS = ['organization', 'institution', 'individual', 'any'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const FORECAST_METHODS = ['weighted_stage', 'manual_commit', 'milestone_based'] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export const AWARD_ARTEFACTS = ['contract', 'mou', 'enrollment', 'partner_agreement', 'none'] as const;
export type AwardArtefact = (typeof AWARD_ARTEFACTS)[number];

/**
 * The closed eight-value canonical ordinal. Written by the platform on every
 * stage transition, never directly settable by a user. This is the mechanism
 * that makes stages comparable across pipelines by position rather than by name.
 */
export const PIPELINE_POSITIONS = [0, 10, 20, 30, 40, 50, 60, 90] as const;
export type PipelinePosition = (typeof PIPELINE_POSITIONS)[number];

export const PIPELINE_POSITION_LABELS: Record<number, string> = {
  0: 'Lost',
  10: 'Identified',
  20: 'Engaged',
  30: 'Qualified',
  40: 'Shaped',
  50: 'Offered',
  60: 'Negotiating',
  90: 'Won',
};

export function isCanonicalPosition(n: number): n is PipelinePosition {
  return (PIPELINE_POSITIONS as readonly number[]).includes(n);
}

// ---------------------------------------------------------------------------
// Lead & opportunity
// ---------------------------------------------------------------------------

export const LEAD_STATUSES = ['open', 'converted', 'disqualified', 'dormant'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * `unrouted` is a queryable sub-state, not a separate boolean flag:
 * `leadStatus = 'open' AND ownerPartyId IS NULL` is the canonical predicate
 * everywhere — one source of truth for "is this lead routed".
 */
export function isUnrouted(lead: { leadStatus: string; ownerPartyId: string | null }): boolean {
  return lead.leadStatus === 'open' && lead.ownerPartyId === null;
}

export const UNROUTED_REASONS = ['no_vertical_coverage', 'all_candidates_over_capacity', 'no_territory_match'] as const;
export type UnroutedReason = (typeof UNROUTED_REASONS)[number];

export const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'closed_won', 'closed_lost'] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export const OPPORTUNITY_OUTCOMES = ['won', 'lost', 'no_decision', 'withdrawn'] as const;
export type OpportunityOutcome = (typeof OPPORTUNITY_OUTCOMES)[number];

export const LOST_REASONS = [
  'price',
  'timing',
  'competitor',
  'no_budget',
  'no_decision',
  'lost_to_incumbent',
  'requirements_mismatch',
  'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const STRATEGIC_VALUES = ['high', 'medium', 'low'] as const;
export type StrategicValue = (typeof STRATEGIC_VALUES)[number];

/**
 * Forecast-category state machine (CRM-LEAD-006). Closure is always stage-driven
 * and category-derived, never the reverse.
 */
export const FORECAST_TRANSITIONS: Record<ForecastCategory, ForecastCategory[]> = {
  pipeline: ['best_case'],
  best_case: ['pipeline', 'commit'],
  commit: ['pipeline', 'best_case'],
  closed_won: [],
  closed_lost: [],
};

// ---------------------------------------------------------------------------
// Commercial objects
// ---------------------------------------------------------------------------

export const DELIVERY_MODELS = [
  'cohort',
  'one_to_one',
  'saas_subscription',
  'professional_services',
  'placement_fee',
  'licensing',
  'other',
] as const;
export type DeliveryModel = (typeof DELIVERY_MODELS)[number];

export const REVENUE_TREATMENTS = ['point_in_time', 'over_time_ratable', 'milestone_based', 'usage_based'] as const;
export type RevenueTreatment = (typeof REVENUE_TREATMENTS)[number];

export const OFFERING_STATUSES = ['draft', 'active', 'retired'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const BILLING_FREQUENCIES = ['one_time', 'monthly', 'annual', 'per_seat', 'milestone'] as const;
export type BillingFrequency = (typeof BILLING_FREQUENCIES)[number];

export const PROPOSAL_RESPONSES = ['pending', 'accepted', 'rejected', 'expired', 'superseded'] as const;
export type ProposalResponse = (typeof PROPOSAL_RESPONSES)[number];

export const QUOTE_STATUSES = ['draft', 'issued', 'accepted', 'expired', 'superseded', 'blocked'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * MoU's is the most complete state machine in the built code. `expiring`,
 * `expired` and `renewed` are job-driven, never user transitions.
 */
export const MOU_STATUSES = [
  'proposed',
  'negotiating',
  'approved',
  'signed',
  'active',
  'expiring',
  'expired',
  'renewed',
] as const;
export type MouStatus = (typeof MOU_STATUSES)[number];

/** Contract mirrors MoU exactly, plus `terminated` for early exit on a priced commitment. */
export const CONTRACT_STATUSES = [...MOU_STATUSES, 'terminated'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const MOU_USER_TRANSITIONS: Record<string, string[]> = {
  proposed: ['negotiating', 'approved'],
  negotiating: ['approved', 'proposed'],
  approved: ['signed'],
  signed: ['active'],
  active: [],       // -> expiring/expired/renewed are job-driven only
  expiring: [],
  expired: ['renewed'],
  renewed: [],
};

export const CONTRACT_USER_TRANSITIONS: Record<string, string[]> = {
  ...MOU_USER_TRANSITIONS,
  active: ['terminated'],
  signed: ['active', 'terminated'],
  terminated: [],
};

/** Transitions that require the privileged-transition approval gate. */
export const PRIVILEGED_TARGET_STATUSES = ['approved', 'signed'] as const;

/** MoU expiry ladder rungs. A contract's ladder is wider — a priced commitment needs longer renewal lead time. */
export const MOU_EXPIRY_LADDER = [90, 60, 30, 7] as const;
export const CONTRACT_EXPIRY_LADDER = [120, 90, 60, 30] as const;

export const AGREEMENT_TYPES = ['reseller', 'referral', 'placement_channel', 'other'] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Identity & relationship
// ---------------------------------------------------------------------------

export const DEDUPE_STATUSES = ['active', 'merged', 'flagged_duplicate'] as const;
export type DedupeStatus = (typeof DEDUPE_STATUSES)[number];

export const AFFILIATION_TYPES = [
  'employee',
  'student',
  'customer_contact',
  'institution_contact',
  'partner_representative',
  'parent_guardian',
  'alumnus',
  'candidate',
  'vendor_contact',
] as const;
export type AffiliationType = (typeof AFFILIATION_TYPES)[number];

/**
 * Affiliation types carrying a statutory retention floor. A dedup match against
 * a PERSON holding one of these never auto-merges, regardless of confidence —
 * biased hard toward false negatives.
 */
export const STATUTORY_RETENTION_AFFILIATIONS: AffiliationType[] = ['employee', 'student'];

export const RELATIONSHIP_ENTITY_TYPES = ['person', 'organization', 'institution', 'project', 'contract'] as const;
export type RelationshipEntityType = (typeof RELATIONSHIP_ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  'studied_at',
  'employed_by',
  'decision_maker_for',
  'partner_of',
  'referred',
  'alumnus_of',
  'trainer_at',
  'vendor_of',
  'certified_in',
  'client_of',
  'other',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_STATUSES = ['active', 'inactive', 'ended'] as const;
export const RELATIONSHIP_STRENGTHS = ['weak', 'moderate', 'strong'] as const;
export type RelationshipStrength = (typeof RELATIONSHIP_STRENGTHS)[number];

/** Computed at query time from live aggregations — never stored on the row, because a stored value drifts from its evidence. */
export const COMPUTED_RELATIONSHIP_STATUSES = [
  'none',
  'prospect',
  'contacted',
  'active_opportunity',
  'active_relationship',
  'mou',
  'inactive',
] as const;
export type ComputedRelationshipStatus = (typeof COMPUTED_RELATIONSHIP_STATUSES)[number];

export const INSTITUTION_TYPES = ['university', 'engineering_college', 'arts_science_college', 'polytechnic', 'school', 'iti', 'other'] as const;
export const MANAGEMENT_TYPES = ['government', 'aided', 'self_financing', 'autonomous', 'deemed', 'private'] as const;

// ---------------------------------------------------------------------------
// Interaction / activity
// ---------------------------------------------------------------------------

export const INTERACTION_TYPES = [
  'call',
  'email',
  'meeting',
  'whatsapp',
  'site_visit',
  'demo',
  'webinar',
  'note',
  'sms',
  'social',
  'other',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const INTERACTION_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const INTERACTION_OUTCOMES = [
  'connected',
  'no_answer',
  'callback_requested',
  'not_interested',
  'information_shared',
  'meeting_scheduled',
  'follow_up_required',
  'completed',
] as const;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENT_KINDS = ['file_artefact', 'record_of_record', 'knowledge_object'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * TTL differentiation by document_kind replaces the fixed 300-second constant.
 * `knowledge_object` gets app-mediated access — no standalone signed URL at all.
 */
export const DOCUMENT_URL_TTL_SECONDS: Record<DocumentKind, number | null> = {
  file_artefact: 300,
  record_of_record: 60,
  knowledge_object: null,
};

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = ['draft', 'issued', 'part_paid', 'settled', 'void', 'overdue'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'received', 'reconciled', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FEE_INSTALMENT_STATUSES = ['scheduled', 'issued', 'part_paid', 'settled', 'waived', 'overdue'] as const;

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

export const ENROLLMENT_STATUSES = ['reserved', 'confirmed', 'active', 'completed', 'withdrawn', 'deferred'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;

// ---------------------------------------------------------------------------
// Record codes (CRM-FOUND-007).
// `record_code = <TYPE>-<YYYY>-<NNNNN>` — five digits, generated per tenant per
// type, gapless within a year, generator-assigned and immutable after creation.
// ---------------------------------------------------------------------------

export const RECORD_TYPE_CODES = [
  'PER', 'ORG', 'EMP', 'STU', 'LEAD', 'OPP', 'MOU', 'CON', 'PRJ', 'TSK', 'INV', 'PAY',
  'EXP', 'REQ', 'APP', 'CRS', 'COH', 'ENR', 'ASN', 'ASM', 'CAS', 'DEC', 'POL', 'SOP',
  'DOC', 'MTG', 'RSK', 'ISS', 'OBJ', 'KR', 'INI', 'CMP', 'EXC', 'WF', 'AG', 'PBE',
  'OFF', 'PA', 'QUO', 'PRO', 'WLR', 'INT', 'REC', 'FEE', 'TER',
  // People (§14): the seat, the leave request and the payroll run are the HR
  // records a human refers to out loud. EMP, REQ, APP and ASN are above.
  'POS', 'LVR', 'PRN',
  // The books (§15): a ledger movement, a supplier bill, a capital purchase
  // and a borrowing.
  'TXN', 'BILL', 'FA', 'LN',
  // A staged import: a file somebody uploaded, its rows, and what became of
  // them. A record because a figure in the books must be traceable to the
  // statement line it came from.
  'IMP',
] as const;
export type RecordTypeCode = (typeof RECORD_TYPE_CODES)[number];

export const RECORD_CODE_PATTERN = /^[A-Z]{2,4}-\d{4}-\d{5}$/;

export function formatRecordCode(type: RecordTypeCode, year: number, seq: number): string {
  return `${type}-${year}-${String(seq).padStart(5, '0')}`;
}

/** Sequence exhaustion is an operational alert condition, never a silent rollover. */
export const RECORD_CODE_MAX_SEQUENCE = 99_999;

// ---------------------------------------------------------------------------
// Health scores (§ CRM-RPT-001)
// ---------------------------------------------------------------------------

export const HEALTH_DOMAINS = [
  { code: 'H_FIN', name: 'Finance', module: 'fin' },
  { code: 'H_COM', name: 'Commercial', module: 'crm' },
  { code: 'H_PPL', name: 'People', module: 'hr' },
  { code: 'H_DLV', name: 'Delivery', module: 'prj' },
  { code: 'H_EDU', name: 'Education', module: 'edu' },
  { code: 'H_MKT', name: 'Marketing', module: 'mkt' },
  { code: 'H_CUS', name: 'Customer Success', module: 'cs' },
  { code: 'H_OPS', name: 'Operations', module: 'wfl' },
  { code: 'H_STR', name: 'Strategy', module: 'str' },
  { code: 'H_RSK', name: 'Risk', module: 'gov' },
] as const;

export type HealthDomainCode = (typeof HEALTH_DOMAINS)[number]['code'];

export const HEALTH_BANDS = ['strong', 'stable', 'watch', 'strained', 'critical'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

/**
 * A band carries a severity floor — but a band never itself reaches
 * S4_CRITICAL; only a named exception does.
 */
export const HEALTH_BAND_SEVERITY_FLOOR: Record<HealthBand, string | null> = {
  strong: null,
  stable: null,
  watch: 'S1_ATTENTION',
  strained: 'S2_WARNING',
  critical: 'S3_HIGH_RISK',
};

export function bandFor(score: number): HealthBand {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'stable';
  if (score >= 55) return 'watch';
  if (score >= 40) return 'strained';
  return 'critical';
}

/** Distance in points to the next band-down threshold. */
export function distanceToEdge(score: number): number {
  const edges = [85, 70, 55, 40, 0];
  for (const e of edges) {
    if (score >= e) return Number((score - e).toFixed(1));
  }
  return 0;
}

/** H_COM's factor weights (CRM-RPT-001). */
export const H_COM_FACTORS = [
  { code: 'pipeline_coverage', label: 'Enough deals to hit target', weight: 30 },
  { code: 'stage_velocity', label: 'Deals moving at a healthy pace', weight: 20 },
  { code: 'win_rate', label: 'Win rate', weight: 20 },
  { code: 'account_concentration', label: 'Too reliant on one customer', weight: 15 },
  { code: 'stalled_proposal_share', label: 'Proposals sitting unanswered', weight: 15 },
] as const;

// ---------------------------------------------------------------------------
// Decisions (P7)
// ---------------------------------------------------------------------------

export const DECISION_STATES = [
  'Raised',
  'Analysing',
  'AwaitingAuthority',
  'Decided',
  'Delegated',
  'Deferred',
  'EvidenceRequested',
  'Implemented',
  'Reviewed',
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

export const DECISION_DISPOSITIONS = ['decide', 'delegate', 'defer', 'request_evidence'] as const;
export type DecisionDisposition = (typeof DECISION_DISPOSITIONS)[number];

/** The seven mandatory evidence-pack components, assembled before routing, never after. */
export const EVIDENCE_PACK_COMPONENTS = [
  'question_and_rejected_options',
  'no_action_option',
  'subject_state_and_last_five_transitions',
  'three_nearest_precedents',
  'constraints_and_grant_exercised',
  'model_view',
  'no_action_consequence',
] as const;

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export const EXCEPTION_CODES = {
  EX_CRM_002: { code: 'EX-CRM-002', label: 'Merge candidate unresolved past threshold', severity: 'S1_ATTENTION' },
  EX_CRM_004: { code: 'EX-CRM-004', label: 'Unrouted lead', severity: 'S2_WARNING' },
  EX_CRM_008: { code: 'EX-CRM-008', label: 'Proposal stalled', severity: 'S2_WARNING' },
  EX_CRM_009: { code: 'EX-CRM-009', label: 'Stage age budget breached', severity: 'S2_WARNING' },
  EX_CRM_010: { code: 'EX-CRM-010', label: 'Lead untouched', severity: 'S1_ATTENTION' },
  EX_CRM_011: { code: 'EX-CRM-011', label: 'Won without contract or MoU reference', severity: 'S3_HIGH_RISK' },
  EX_CRM_012: { code: 'EX-CRM-012', label: 'Handoff unaccepted', severity: 'S2_WARNING' },
  EX_CRM_013: { code: 'EX-CRM-013', label: 'Dual-channel partner conflict', severity: 'S2_WARNING' },
  EX_CRM_014: { code: 'EX-CRM-014', label: 'MoU expiry approaching', severity: 'S1_ATTENTION' },
  EX_CRM_015: { code: 'EX-CRM-015', label: 'Win/loss review overdue', severity: 'S1_ATTENTION' },
  EX_CRM_016: { code: 'EX-CRM-016', label: 'Chronic recommit — commit past one full forecast period', severity: 'S2_WARNING' },
  EX_FIN_001: { code: 'EX-FIN-001', label: 'Payment overdue', severity: 'S2_WARNING' },
  EX_EDU_001: { code: 'EX-EDU-001', label: 'Learner at risk', severity: 'S2_WARNING' },
  DET_CRM_OFF_01: { code: 'DET-CRM-OFF-01', label: 'Active offering with no price book entry', severity: 'S1_ATTENTION' },
  // People (§14). An absence breach is high risk because it runs a clock the
  // company is answerable for; the other two are paperwork that becomes an
  // exposure if it is never done.
  EX_HR_001: { code: 'EX-HR-001', label: 'Unexplained absence breach', severity: 'S3_HIGH_RISK' },
  EX_HR_002: { code: 'EX-HR-002', label: 'Probation confirmation overdue', severity: 'S1_ATTENTION' },
  EX_HR_003: { code: 'EX-HR-003', label: 'Active employee with no compensation in force', severity: 'S2_WARNING' },
  EX_HR_004: { code: 'EX-HR-004', label: 'Leave taken beyond entitlement', severity: 'S2_WARNING' },
  EX_HR_005: { code: 'EX-HR-005', label: 'Payroll period closed with unresolved attendance', severity: 'S2_WARNING' },
  // The books (§15).
  EX_FIN_002: { code: 'EX-FIN-002', label: 'Supplier bill overdue', severity: 'S2_WARNING' },
  EX_FIN_003: { code: 'EX-FIN-003', label: 'Spending beyond budget', severity: 'S2_WARNING' },
  EX_FIN_004: { code: 'EX-FIN-004', label: 'Cash runway below threshold', severity: 'S3_HIGH_RISK' },
  EX_FIN_005: { code: 'EX-FIN-005', label: 'Disbursed payroll not posted to the books', severity: 'S2_WARNING' },
} as const;

export const EXCEPTION_STATES = ['open', 'acknowledged', 'resolved', 'escalated', 'suppressed'] as const;
export type ExceptionState = (typeof EXCEPTION_STATES)[number];

// ---------------------------------------------------------------------------
// Automation classes (the closed set of eight, for the Live & Handled digest)
// ---------------------------------------------------------------------------

export const AUTOMATION_CLASSES = [
  'routine_administration',
  'threshold_response',
  'communication_dispatch',
  'scheduling',
  'data_maintenance',
  'financial_processing',
  'escalation_routing',
  'agent_recommendation_applied',
] as const;
export type AutomationClass = (typeof AUTOMATION_CLASSES)[number];
