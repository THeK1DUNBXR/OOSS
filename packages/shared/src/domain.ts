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

// ---------------------------------------------------------------------------
// The three parties, as Kaizen actually meets them
//
// One engineering organisation, three divisions — Software Engineering, Skill
// Development, Education — and the same body can reach it through more than
// one. The vocabulary below is taken from how the company describes its own
// work rather than from a generic CRM: a college is an MoU partner at one of
// five depths, a business may be a sponsor and an employer at once, and a
// learner is very often not the person paying for their own course.
// ---------------------------------------------------------------------------

/**
 * Who is actually paying for a learner's place.
 *
 * The single most consequential fact about a student here, because the platform
 * bills people. Skill Development delivers "programmes commissioned by a scheme
 * or a sponsor, delivered to cohorts" — a beneficiary of a funded cohort owes
 * nothing, and an invoice raised to them is a document that should never have
 * existed. Education's own learners pay their own fees. Both sit in the same
 * classroom, so the distinction has to be on the learner and not on the course.
 */
export const FUNDING_SOURCES = ['self', 'sponsor', 'scheme', 'institution'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const FUNDING_SOURCE_LABELS: Record<FundingSource, string> = {
  self: 'Paying their own fee',
  sponsor: 'Sponsored by an organisation',
  scheme: 'Funded under a scheme',
  institution: 'Paid by their college',
};

/**
 * The funding frameworks Skill Development delivers into.
 *
 * Each has its own documentation standard, assessment model and reporting
 * expectation, which is why the framework is recorded rather than a free-text
 * note: "which of our learners are Naan Mudhalvan" is a question the scheme
 * owner asks, and it cannot be answered from a text field somebody typed.
 */
export const FUNDING_FRAMEWORKS = [
  'naan_mudhalvan',
  'vetri_nichayam',
  'tnsdc_other',
  'nsdc_linked',
  'csr',
  'institution_funded',
  'other',
] as const;
export type FundingFramework = (typeof FUNDING_FRAMEWORKS)[number];

export const FUNDING_FRAMEWORK_LABELS: Record<FundingFramework, string> = {
  naan_mudhalvan: 'Naan Mudhalvan',
  vetri_nichayam: 'Vetri Nichayam',
  tnsdc_other: 'Other TNSDC programme',
  nsdc_linked: 'NSDC-linked scheme',
  csr: 'CSR-funded',
  institution_funded: 'Institution-funded',
  other: 'Another framework',
};

/**
 * What an organisation is to Kaizen. Not exclusive: a manufacturer can sponsor
 * a CSR cohort and hire out of it, and most of the good relationships are both.
 *
 * This is the opposite call from institution-versus-organisation, which is one
 * exclusive identity. What a body *is* is one thing; what it *does with us* is
 * several, and flattening the second into the first is what produced a single
 * list nobody could read.
 */
export const ORGANIZATION_ROLES = ['client', 'sponsor', 'employer', 'government'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_ROLE_LABELS: Record<OrganizationRole, string> = {
  client: 'Buys from us',
  sponsor: 'Funds cohorts',
  employer: 'Hires our learners',
  government: 'Scheme or department',
};

export const ORGANIZATION_ROLE_HINTS: Record<OrganizationRole, string> = {
  client: 'Software, or training for their own staff.',
  sponsor: 'CSR or another budget paying for somebody else\u2019s learners.',
  employer: 'Takes people at the end of a cohort, or re-skills the ones they have.',
  government: 'A department or state skill agency appointing partners under a scheme.',
};

/**
 * The five depths of an institutional engagement, from For Educators.
 *
 * A college is not one relationship. "We run their faculty development" and
 * "we built their admissions portal" are different engagements with different
 * people, different money and different divisions, and a partnership that is
 * only ever recorded as "active" tells nobody which of them is true.
 */
export const INSTITUTION_ENGAGEMENTS = [
  'academic_alignment',
  'faculty_development',
  'student_capability',
  'research_innovation',
  'centre_of_excellence',
  'institutional_technology',
] as const;
export type InstitutionEngagement = (typeof INSTITUTION_ENGAGEMENTS)[number];

export const INSTITUTION_ENGAGEMENT_LABELS: Record<InstitutionEngagement, string> = {
  academic_alignment: 'Academic alignment',
  faculty_development: 'Faculty development',
  student_capability: 'Student capability',
  research_innovation: 'Research & innovation',
  centre_of_excellence: 'Centre of excellence',
  institutional_technology: 'Institutional technology',
};

export const INSTITUTION_ENGAGEMENT_HINTS: Record<InstitutionEngagement, string> = {
  academic_alignment: 'Curriculum enrichment, technical electives, project-based learning.',
  faculty_development: 'Workshops, masterclasses and bootcamps for their staff.',
  student_capability: 'Our programmes delivered on their campus, with industry exposure.',
  research_innovation: 'Applied research, proofs of concept, publications, patents.',
  centre_of_excellence: 'Institution-led, joint or extended.',
  institutional_technology: 'Portals, student-lifecycle workflows, dashboards \u2014 built by Software Engineering.',
};

/** Where a learner is taught. Two offices and online. */
export const DELIVERY_LOCATIONS = ['madurai', 'coimbatore', 'online', 'on_campus'] as const;
export type DeliveryLocation = (typeof DELIVERY_LOCATIONS)[number];

export const DELIVERY_LOCATION_LABELS: Record<DeliveryLocation, string> = {
  madurai: 'Madurai',
  coimbatore: 'Coimbatore',
  online: 'Online',
  on_campus: 'On their campus',
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
  // Equity & board — an outsider's relationship to this entity, not an
  // employment. The chairman holds `director` in a subsidiary the same way, by
  // the create-tenant script naming them explicitly (§6, phase 0 item 3);
  // nothing about being chairman elsewhere implies it.
  'shareholder',
  'director',
  'company_secretary',
] as const;
export type AffiliationType = (typeof AFFILIATION_TYPES)[number];

/**
 * Affiliation types carrying a statutory retention floor. A dedup match against
 * a PERSON holding one of these never auto-merges, regardless of confidence —
 * biased hard toward false negatives.
 */
export const STATUTORY_RETENTION_AFFILIATIONS: AffiliationType[] = ['employee', 'student'];

/**
 * Affiliations that make somebody another organisation's person rather than
 * ours: a client's contact, a college's contact, a partner's or a supplier's.
 *
 * Grouped because the distinction between them matters when you are looking at
 * one record and not at all when you are asking "who here is somebody else's
 * person, as opposed to our own student or our own staff".
 */
export const COUNTERPARTY_AFFILIATIONS: AffiliationType[] = [
  'customer_contact',
  'institution_contact',
  'partner_representative',
  'vendor_contact',
];

/** What a person is to us, in the words the product uses on screen. */
export const AFFILIATION_LABELS: Record<AffiliationType, string> = {
  employee: 'Staff',
  student: 'Student',
  customer_contact: 'Client contact',
  institution_contact: 'College contact',
  partner_representative: 'Partner',
  parent_guardian: 'Guardian',
  alumnus: 'Alumnus',
  candidate: 'Candidate',
  vendor_contact: 'Supplier contact',
  shareholder: 'Shareholder',
  director: 'Board member',
  company_secretary: 'Company secretary',
};

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

/**
 * What the invoice says about payment when it is handed over.
 *
 * This is a declaration printed on the document, not a derived status. A
 * customer paying an instalment at a counter is told two numbers — the whole
 * amount and the amount they are handing over today — and the invoice has to
 * say which it is, because "₹5,000" on a ₹11,800 bill is a receipt for a part
 * payment or a wrong total depending on one word.
 *
 * `credit` is the third case and the honest name for it: nothing collected at
 * issue, payable by the due date.
 */
export const PAYMENT_TYPES = ['full', 'part', 'credit'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  full: 'Full payment',
  part: 'Part payment',
  credit: 'Payable on credit',
};

/** How the money changes hands. Printed on the invoice. */
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'netbanking', 'other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  netbanking: 'Net banking',
  other: 'Other',
};

/**
 * The returns this platform prepares.
 *
 * GSTR-1 is the statement of outward supplies, invoice by invoice. GSTR-3B is
 * the monthly summary the tax is actually paid from. They are prepared from the
 * same books and are not the same document: a discrepancy between them is
 * exactly the thing a notice asks about, so both are computed and stored rather
 * than one being derived from the other at render time.
 */
export const GST_RETURN_TYPES = ['GSTR1', 'GSTR3B'] as const;
export type GstReturnType = (typeof GST_RETURN_TYPES)[number];

export const GST_RETURN_LABELS: Record<GstReturnType, string> = {
  GSTR1: 'GSTR-1 — outward supplies',
  GSTR3B: 'GSTR-3B — monthly summary and payment',
};

/** prepared → filed. `superseded` is a preparation replaced before filing. */
export const GST_FILING_STATUSES = ['prepared', 'filed', 'superseded'] as const;
export type GstFilingStatus = (typeof GST_FILING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

export const ENROLLMENT_STATUSES = ['reserved', 'confirmed', 'active', 'completed', 'withdrawn', 'deferred'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;

/**
 * What a day on a student's timeline can be, besides attendance and a score.
 *
 * Four kinds rather than one note field, because a question nobody has answered
 * and a problem nobody has closed are work, and work has to be countable. A
 * note is the fallback for whatever is neither.
 */
export const LEARNER_LOG_KINDS = ['query', 'feedback', 'issue', 'note'] as const;
export type LearnerLogKind = (typeof LEARNER_LOG_KINDS)[number];

export const LEARNER_LOG_LABELS: Record<LearnerLogKind, string> = {
  query: 'Query',
  feedback: 'Feedback',
  issue: 'Issue',
  note: 'Note',
};

/**
 * Feedback and a note are closed the moment they are recorded — there is
 * nothing to do about them. A query and an issue open, and stay open until
 * somebody says otherwise.
 */
export const LEARNER_LOG_KINDS_NEEDING_CLOSURE: LearnerLogKind[] = ['query', 'issue'];

export const LEARNER_LOG_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type LearnerLogStatus = (typeof LEARNER_LOG_STATUSES)[number];

export const LEARNER_LOG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type LearnerLogSeverity = (typeof LEARNER_LOG_SEVERITIES)[number];

/** The kinds a merged learner timeline is made of. */
export const LEARNER_TIMELINE_KINDS = [
  'attendance', 'progress', 'query', 'feedback', 'issue', 'note', 'invoice', 'enrollment',
] as const;
export type LearnerTimelineKind = (typeof LEARNER_TIMELINE_KINDS)[number];

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
  // A prepared or filed GST return. A record because a filed return is a
  // statement to the government that somebody has to be able to refer to.
  'GST',
  // The final invoice raised once the instalments against a tax invoice are
  // done: its own number, because a customer refers to it by one.
  'FNL',
  // A draft invoice, before it has an invoice number. Its own series so that a
  // draft reference can never be mistaken for a tax invoice number — the tax
  // series has to stay consecutive, which means a draft cannot take one.
  'DRF',
  // The register (equity-portal plan §5): a class of shares, a holder, one
  // ledger entry, a printed certificate, a recorded valuation.
  'SHC', 'HLD', 'SHT', 'CRT', 'VAL',
  // The group (equity-portal plan §6, phase 2): a subsidiary's published
  // summary, written into its parent's tenant.
  'ESN',
  // Rounds (equity-portal plan §6 phase 4): the container an allotment, a
  // bonus, a rights offer, a buy-back or a capital reduction is struck under.
  'RND',
  // ESOP (equity-portal plan §5/§6, phase 5): a scheme and a grant under it.
  'ESP', 'OPG',
  // Board (equity-portal plan §6, phase 3): a meeting, a board seat, a
  // resolution and a compliance item — each referred to by its own code.
  'BRD', 'BDM', 'RES', 'CPL',
  // The filing log (equity-portal plan §6 phase 6a): one row per statutory
  // form owed or filed — MGT-1/2, PAS-3, SH-4, PAS-6, FC-GPR, FC-TRS, FLA.
  'FIL',
  // Data protection (workstream G): a data-principal request and a breach
  // register entry, each a case a data principal or the company refers to by
  // number.
  'DPR', 'BRC',
  // Technology (docs/plan/cio.md): an asset, an application, a licence, a
  // vendor and a vendor contract (A-C); a ticket and a knowledge article (D);
  // an incident, a problem and a change (E); a risk, a policy document, a
  // control, an access review and a security finding (F); an initiative and
  // a technical-debt item (G); a continuity plan, a continuity test and a
  // maintenance window (H). Each is a thing a person refers to by number.
  'ITA', 'SWA', 'LIC', 'ITV', 'VCT',
  'TKT', 'KBA',
  'INC', 'PRB', 'CHG',
  'ITR', 'ITP', 'CTL', 'ACR', 'FND',
  'ITI', 'TDB',
  'DRP', 'DRT', 'MWN',
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
  // Technology (docs/plan/cio.md, workstream I): the desk, incidents,
  // changes, risk, findings and continuity, each factor omitted while its
  // inputs do not exist yet.
  { code: 'H_TEC', name: 'Technology', module: 'it' },
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
  // A GST return that has not been prepared with the deadline in sight. The
  // eleventh for GSTR-1 and the twentieth for GSTR-3B are statutory, and the
  // penalty is per day, so a return nobody has looked at is an exposure rather
  // than a task.
  EX_FIN_006: { code: 'EX-FIN-006', label: 'GST return not filed for a closed month', severity: 'S3_HIGH_RISK' },
  // A student's complaint. Held at the same rung as an absence breach because
  // the thing that makes it serious is the same: a clock is running and somebody
  // outside the company is waiting.
  EX_EDU_002: { code: 'EX-EDU-002', label: 'Learner issue raised', severity: 'S3_HIGH_RISK' },
  EX_EDU_003: { code: 'EX-EDU-003', label: 'Learner query unanswered', severity: 'S2_WARNING' },
  // Raised once, the moment `reconcileTenantKinds` first finds a tenant to be
  // a holding or a subsidiary: s.2(85) ends "small company" status for both
  // regardless of size, which changes the board-meeting cadence, the annual
  // return form and (per §1a.1) the demat mandate.
  EX_EQT_001: { code: 'EX-EQT-001', label: 'Small company status ended by group structure', severity: 'S2_WARNING' },
  // SH-1 (s.56): a certificate is due within two months of an allotment or a
  // transfer going effective. Raised once per share transaction, by the
  // `certificate_window` job and echoed on the cap table as `certificateOverdue`.
  EX_EQT_002: { code: 'EX-EQT-002', label: 'Share certificate overdue (SH-1, two months)', severity: 'S2_WARNING' },
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
