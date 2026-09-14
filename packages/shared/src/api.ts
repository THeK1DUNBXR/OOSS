/**
 * Wire contract shared by the API and the web client.
 */

import type { SensitivityClass, SeverityCode, WithholdReason, NotificationPriority } from './events.js';
import type { AiTierCode } from './ai.js';
import type { AxisOutcome } from './permissions.js';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    /** Populated on a 409 from the dedup service — the ranked candidate list. */
    candidates?: unknown[];
    /** Populated on a 403 — which axis denied, and why. */
    axes?: AxisOutcome[];
  };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Every payload a five-axis-filtered read produces carries its withheld list, so
 * a viewer can always ask why an item is missing — except for concealed items,
 * where recording "one item withheld here" would itself be the leak.
 */
export interface WithheldEntry {
  path: string;
  reason: WithholdReason;
}

export interface Filtered<T> {
  data: T;
  withheld: WithheldEntry[];
}

// ---------------------------------------------------------------------------
// Session & identity
// ---------------------------------------------------------------------------

export interface AffiliationSummary {
  id: string;
  affiliationType: string;
  counterpartyName: string | null;
  roleSlug: string;
  primaryFlag: boolean;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Privileged contexts require step-up re-auth to commit the switch. */
  requiresStepUp: boolean;
}

export interface SessionUser {
  userId: string;
  /** The cross-tenant identity this user is one entity's face of. */
  principalId: string;
  personId: string;
  fullName: string;
  email: string;
  tenantId: string;
  tenantName: string;
  tenantKind: TenantKind;
  parentTenantId: string | null;
  /** How many tenants this principal holds an active affiliation in — the entity picker shows itself when this is more than one. */
  entityCount: number;
  activeAffiliationId: string;
  roleSlug: string;
  archetype: SurfaceArchetype;
  classificationCeiling: SensitivityClass;
  affiliations: AffiliationSummary[];
  grants: string[];
  authorityGrants: AuthorityGrantView[];
  branch: string | null;
}

export const TENANT_KINDS = ['holding', 'subsidiary', 'standalone'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

/**
 * One entity a principal can continue into, as returned by `POST /auth/login`
 * when the principal holds an active affiliation in more than one, and by
 * `GET /auth/entities` at any time.
 */
export interface EntityOption {
  tenantId: string;
  slug: string;
  name: string;
  kind: TenantKind;
  parentTenantId: string | null;
  roleSlugs: string[];
  /** True when the email's domain matches this tenant's `config.emailDomains` — a hint only, first in the list, never the reason access is granted. */
  suggested?: boolean;
}

/** Returned instead of a token when a principal holds more than one entity. */
export interface EntitySelectionResponse {
  entities: EntityOption[];
  /** Short-lived (5 min) JWT carrying only `{ principalId, purpose: 'select-entity' }` — exchanged at `/auth/switch-entity` for a normal token, never usable for anything else. */
  selectionToken: string;
}

/**
 * Documents the keys the platform reads out of `Tenant.config`, which stays a
 * JSON blob rather than columns because most of it is optional and tenant-
 * specific. Not every key here is present on every tenant.
 */
export interface TenantConfig {
  bootstrapAuthoritySet?: string[];
  forecastPeriod?: string;
  baseCurrency?: string;
  onboardingComplete?: boolean;
  /** Domains that hint (never decide) which entity a login should pre-select — §3.2. */
  emailDomains?: string[];
  /** The division a subsidiary grew out of, before it was incorporated as its own tenant — §1.1. */
  originDivision?: 'software' | 'skill' | 'education';
  /** Set once `reconcileTenantKinds` has raised the small-company-status notice for this tenant, so it fires exactly once — §1a.1. */
  smallCompanyNoticeRaisedAt?: string;
  seed?: { sequence: number; at: string; build: number; commit: string; navNodes: number };
  /** Set on the subsidiary once `pnpm division:spin-out` has committed — §6b. */
  spinOut?: { from: string; division: 'software' | 'skill' | 'education'; at: string; batchId: string };
}

export interface AuthorityGrantView {
  authorityClass: string;
  ceilingValue: number | null;
  currency: string | null;
  countCeiling: number | null;
  countWindow: string | null;
  riskClassCeiling: string | null;
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

/** What `POST /auth/login` actually returns — a token when the principal resolves to exactly one entity, an entity list to choose from otherwise. */
export type LoginResult = LoginResponse | EntitySelectionResponse;

export function loginNeedsEntitySelection(result: LoginResult): result is EntitySelectionResponse {
  return (result as EntitySelectionResponse).entities !== undefined;
}

// ---------------------------------------------------------------------------
// Surface composition (P9)
// ---------------------------------------------------------------------------

export const SURFACE_ARCHETYPES = ['command', 'workspace', 'portal', 'console'] as const;
export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

export interface NavNodeView {
  key: string;
  label: string;
  icon: string;
  path: string;
  group: string;
  searchSynonyms: string[];
  children?: NavNodeView[];
}

/**
 * Relevance is six-band lexicographic: band always dominates score, so ranking
 * cannot be out-argued by a large score.
 */
export const RELEVANCE_BANDS = [
  'critical_in_scope',
  'my_high_risk',
  'i_am_blocker',
  'my_due_items',
  'scored',
  'suppressed',
] as const;
export type RelevanceBand = (typeof RELEVANCE_BANDS)[number];

export interface RankedItem {
  band: RelevanceBand;
  score: number;
  /** An unexplainable ordering is the same defect class as an undrillable score. */
  whyRanked: string[];
}

// ---------------------------------------------------------------------------
// Command Center
// ---------------------------------------------------------------------------

export interface HealthFactorView {
  factor: string;
  label: string;
  weight: number;
  value: number;
  target: number;
  factorScore: number;
  contribution: number;
  /** The reading series behind this factor — hop 2 of the three-hop drill. */
  drillPath: string;
  /** A factor with no downside excursion in its trailing 12 months is quarantined. */
  quarantined: boolean;
  narrative: string;
}

export interface HealthScoreView {
  domainCode: string;
  domainName: string;
  asOf: string;
  score: number | null;
  band: string | null;
  previousScore: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  distanceToEdge: number | null;
  severityFloor: string | null;
  largestNegativeContributor: string | null;
  factors: HealthFactorView[];
  /** A domain with insufficient inputs renders "Not yet measured", never a zero. */
  state: 'measured' | 'not_yet_measured' | 'unavailable';
  drillPath: string;
}

export interface DeltaItem {
  id: string;
  eventId: string;
  occurredAt: string;
  headline: string;
  detail: string;
  domain: string;
  severity: SeverityCode | null;
  materiality: number | null;
  /** Distinguishes "new to your view" from "changed in the world". */
  newToView: boolean;
  handledWithoutYou: boolean;
  drillPath: string;
}

export interface WhatChangedResponse {
  watermark: string;
  reachSignature: string;
  narrativeWindowElapsed: boolean;
  /** Rendered only past the narrative window; every claim resolves to an admitted delta item. */
  narrative: {
    reconciliationLine: string;
    body: string;
  } | null;
  items: DeltaItem[];
  suppressedBelowMateriality: number;
}

export interface ExceptionView {
  id: string;
  code: string;
  label: string;
  severity: SeverityCode;
  state: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  recordCode: string | null;
  /** Every exception arrives pre-owned — resolved before it is eligible to appear at all. */
  ownerPartyId: string | null;
  ownerName: string | null;
  accountablePositionId: string | null;
  raisedAt: string;
  acknowledgedAt: string | null;
  slaDueAt: string | null;
  slaBreached: boolean;
  escalationRung: number;
  escalationTrigger: string | null;
  detail: string;
  drillPath: string;
  ranked?: RankedItem;
}

export interface EvidencePackView {
  question: string;
  rejectedOptions: { option: string; outcome: string; risk: string; cost: string }[];
  noActionOption: { option: string; consequence: string; by: string };
  subjectState: Record<string, unknown>;
  lastFiveTransitions: { at: string; from: string; to: string; actor: string }[];
  nearestPrecedents: { decisionId: string; question: string; outcome: string; lesson: string }[];
  constraintsAndGrant: { constraint: string; grantExercised: string };
  modelView: { label: string; statement: string; isModel: true } | null;
  noActionConsequence: { statement: string; by: string };
  complete: boolean;
  missingComponents: string[];
}

export interface DecisionView {
  id: string;
  recordCode: string;
  question: string;
  state: string;
  raisedAt: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  authorityBasis: string;
  requiredAuthorityValue: number | null;
  currency: string | null;
  confidence: number | null;
  deferUntil: string | null;
  reviewDueOn: string | null;
  pointOfNoReturn: string | null;
  chosenOption: string | null;
  rationale: string | null;
  outcomeAssessment: string | null;
  evidencePack: EvidencePackView;
  availableDispositions: string[];
  ranked?: RankedItem;
}

export interface AutomationDigestRow {
  automationClass: string;
  label: string;
  count: number;
  valueMoved: number | null;
  successRate: number;
  exceptionCount: number;
  topDefinition: string | null;
  accountablePosition: string | null;
  /** What did *not* happen — the leading indicator of over- and under-granting. */
  suppressedByRateLimit: number;
  dryRunCount: number;
  authorityShortfall: number;
}

export interface AuthorityInForceRow {
  id: string;
  principalLabel: string;
  principalType: string;
  authorityClass: string;
  ceilingValue: number | null;
  currency: string | null;
  status: string;
  dependentAutomations: string[];
  dependentAgents: string[];
}

export interface CommandCenterResponse {
  asOf: string;
  scope: 'tenant' | 'portfolio' | 'unit';
  banner: { waitingCount: number; oldestClockHours: number | null };
  pulse: HealthScoreView[];
  attentionQueue: ExceptionView[];
  decisionQueue: DecisionView[];
  whatChanged: WhatChangedResponse;
  liveAndHandled: {
    rows: AutomationDigestRow[];
    materialEvents: DeltaItem[];
    authorityInForce: AuthorityInForceRow[];
  };
}

// ---------------------------------------------------------------------------
// CRM views
// ---------------------------------------------------------------------------

export interface PipelineStageView {
  id: string;
  stageKey: string;
  label: string;
  sequence: number;
  defaultProbability: number;
  pipelinePosition: number;
  isOpen: boolean;
  isTerminal: boolean;
  postAward: boolean;
  stageAgeBudgetDays: number | null;
  requiredFields: string[];
}

export interface PipelineTransitionView {
  id: string;
  fromStageKey: string | null;
  toStageKey: string;
  requiresApproval: boolean;
  requiredPermission: string;
  emitsEvent: string;
}

export interface PipelineView {
  id: string;
  pipelineCode: string;
  name: string;
  commercialMotion: string;
  appliesToVerticals: string[];
  appliesToAccountKind: string;
  defaultForecastMethod: string;
  requiresAwardArtefact: string;
  isDefault: boolean;
  usable: boolean;
  usableReason: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  stages: PipelineStageView[];
  transitions: PipelineTransitionView[];
}

export interface PersonView {
  id: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  additionalPhones: string[];
  additionalEmails: string[];
  dedupeStatus: string;
  mergedInto: string | null;
  affiliations: { id: string; affiliationType: string; status: string; counterpartyName: string | null }[];
  /** A CRM role sees "holds a non-CRM affiliation" as a badge, never the specialisation detail. */
  externalAffiliationBadges: string[];
  createdAt: string;
}

/**
 * The body `PATCH /hr/employees/:id` accepts. Personal fields (HR at `all`,
 * the employee at `own`) and employment fields (HR only — see
 * `apps/api/src/domains/employment.ts`'s `updateEmployeeProfile`) share one
 * envelope because they share one form; the service layer is what actually
 * tells them apart.
 *
 * A regulated field here is write-only by construction: there is no read
 * counterpart on `EmployeeDetailView` for `bloodGroup`, `panNumber`,
 * `uanNumber`, `esicNumber` or the bank fields — only the `has*`/`*Last4`
 * companions the response carries instead.
 */
export interface EmployeeProfileUpdateInput {
  fullName?: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  dateOfBirth?: string | null;
  bloodGroup?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  hireEffectiveDate?: string;
  noticePeriodDays?: number;
  engagementType?: string;
  panNumber?: string | null;
  uanNumber?: string | null;
  esicNumber?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankAccountName?: string | null;
}

export interface DedupCandidate {
  personId: string;
  recordCode: string;
  fullName: string;
  maskedPhone: string | null;
  maskedEmail: string | null;
  matchedOn: string[];
  confidence: number;
  affiliationSummary: string[];
  statutoryRetentionFloor: boolean;
  crossScope: boolean;
}

export interface OrganizationView {
  id: string;
  recordCode: string;
  name: string;
  website: string | null;
  parentOrgId: string | null;
  tags: string[];
  ownerPartyId: string | null;
  ownerName: string | null;
  legacyCategory: string | null;
  /** Both specialisations may coexist. Presence is never itself sensitive; contents are. */
  specialisations: { kind: 'account' | 'institution_profile'; present: true; viewable: boolean }[];
  account: AccountView | null;
  institutionProfile: InstitutionProfileView | null;
  computedRelationshipStatus: string;
  createdAt: string;
}

export interface AccountView {
  id: string;
  tier: string;
  ownerPartyId: string | null;
  ownerName: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  paymentTermsDays: number | null;
  annualRevenueBand: string | null;
  employeeCountBand: string | null;
}

export interface InstitutionProfileView {
  id: string;
  institutionType: string | null;
  managementType: string | null;
  district: string | null;
  taluk: string | null;
  state: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  externalIdentifier: string | null;
  establishedYear: number | null;
  studentCount: number | null;
  departments: string[];
  strategicPriority: string | null;
}

export interface LeadView {
  id: string;
  recordCode: string;
  title: string;
  personId: string | null;
  personName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  vertical: string;
  offeringId: string | null;
  offeringName: string | null;
  legacyProductText: string | null;
  pipelineId: string;
  pipelineCode: string;
  stageKey: string;
  stageLabel: string;
  pipelinePosition: number;
  leadStatus: string;
  ownerPartyId: string | null;
  ownerName: string | null;
  territoryId: string | null;
  territoryName: string | null;
  unrouted: boolean;
  unroutedReason: string | null;
  score: number | null;
  scoreReasons: string[];
  source: string;
  estimatedValue: number | null;
  currency: string;
  stageEnteredAt: string;
  stageAgeDays: number;
  stageAgeBreached: boolean;
  lastInteractionAt: string | null;
  createdAt: string;
}

export interface OpportunityView {
  id: string;
  recordCode: string;
  title: string;
  accountId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  primaryContactPersonId: string | null;
  primaryContactName: string | null;
  vertical: string;
  offeringId: string | null;
  offeringName: string | null;
  pipelineId: string;
  pipelineCode: string;
  pipelineName: string;
  stageKey: string;
  stageLabel: string;
  pipelinePosition: number;
  defaultProbability: number;
  forecastCategory: string;
  forecastCategoryChangedAt: string | null;
  forecastCategoryChangeReason: string | null;
  expectedValue: number | null;
  weightedValue: number | null;
  currency: string;
  expectedCloseDate: string | null;
  closeDateStale: boolean;
  ownerPartyId: string | null;
  ownerName: string | null;
  strategicValue: string | null;
  proposalId: string | null;
  proposalSentAt: string | null;
  quoteId: string | null;
  contractId: string | null;
  mouId: string | null;
  parentContractId: string | null;
  legacyStage: string | null;
  outcome: string | null;
  lostReason: string | null;
  stageEnteredAt: string;
  stageAgeDays: number;
  stageAgeBreached: boolean;
  wonGateSatisfied: boolean;
  createdAt: string;
}

export interface RoutingCandidateScore {
  candidateId: string;
  candidateName: string;
  passedHardFilters: boolean;
  hardFilterFailure: string | null;
  factors: { factor: string; weight: number; raw: number; weighted: number }[];
  total: number;
  won: boolean;
  tieBreakApplied: boolean;
}

export interface RoutingAuditView {
  leadId: string;
  evaluatedAt: string;
  territoryId: string | null;
  candidates: RoutingCandidateScore[];
  winnerId: string | null;
  unroutedReason: string | null;
}

export interface InteractionView {
  id: string;
  recordCode: string;
  interactionType: string;
  direction: string;
  occurredAt: string;
  durationMinutes: number | null;
  subject: string | null;
  notes: string | null;
  outcome: string | null;
  actorPartyId: string | null;
  actorName: string | null;
  participantPartyIds: string[];
  relatedReferences: { contextCode: string; entityType: string; entityId: string; displayLabel: string | null; recordCode: string | null }[];
  /** Computed as the max classification across every related reference. Never assigned by the logging user. */
  sensitivityClass: SensitivityClass;
  nextAction: string | null;
  nextActionDue: string | null;
  withheld: WithheldEntry[];
}

export interface OfferingView {
  id: string;
  recordCode: string;
  offeringCode: string;
  name: string;
  description: string | null;
  vertical: string;
  deliveryModel: string;
  defaultRevenueTreatment: string;
  status: string;
  owningBusinessUnit: string | null;
  legacyProductStrings: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  priceBookEntryCount: number;
  activePriceBookEntries: PriceBookEntryView[];
  /** DET-CRM-OFF-01: an offering reps can select but cannot price is a coverage gap. */
  coverageGap: boolean;
}

export interface PriceBookEntryView {
  id: string;
  offeringId: string;
  offeringName: string;
  priceBookId: string;
  priceBookName: string;
  currency: string;
  unitPrice: number | null;
  billingFrequency: string;
  minQuantity: number;
  maxDiscountPct: number;
  status: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface QuoteLineView {
  id: string;
  priceBookEntryId: string;
  priceBookEntryVersion: number;
  offeringName: string;
  quantity: number;
  listUnitPrice: number | null;
  discountPct: number;
  maxDiscountPct: number;
  overCeiling: boolean;
  discountAmount: number | null;
  lineTotal: number | null;
}

export interface QuoteView {
  id: string;
  recordCode: string;
  opportunityId: string;
  opportunityTitle: string;
  version: number;
  status: string;
  lines: QuoteLineView[];
  subtotal: number | null;
  discountTotal: number | null;
  grandTotal: number | null;
  currency: string;
  issuedAt: string | null;
  validUntil: string | null;
  blockedReason: string | null;
  approvalStepId: string | null;
}

export interface AgreementView {
  id: string;
  kind: 'mou' | 'contract' | 'partner_agreement';
  recordCode: string;
  legacyReference: string | null;
  title: string;
  organizationId: string | null;
  organizationName: string | null;
  institutionId: string | null;
  opportunityId: string | null;
  ownerPartyId: string | null;
  ownerName: string | null;
  status: string;
  scope: string | null;
  vertical: string | null;
  agreementType: string | null;
  commercialValue: number | null;
  currency: string;
  strategicValue: string | null;
  startDate: string | null;
  endDate: string | null;
  signedDate: string | null;
  renewedFromId: string | null;
  expiryNotifiedDays: number[];
  daysToExpiry: number | null;
  availableTransitions: string[];
  requiresApprovalFor: string[];
  documentId: string | null;
}

export interface WinLossReviewView {
  id: string;
  recordCode: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  outcome: string;
  competitorName: string | null;
  decisionMakerPersonId: string | null;
  decisionMakerName: string | null;
  realLostStage: string | null;
  lostReason: string | null;
  lostReasonOtherText: string | null;
  lesson: string | null;
  mandatory: boolean;
  mandatoryBasis: string;
  strategicValueSnapshot: string | null;
  commercialValueSnapshot: number | null;
  thresholdUsedSnapshot: number | null;
  completedById: string | null;
  completedByName: string | null;
  completedAt: string | null;
  dueAt: string | null;
  overdue: boolean;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface InvoiceView {
  id: string;
  /** The tax invoice number. Null while it is a draft — a draft takes no number. */
  recordCode: string | null;
  draftReference: string | null;
  /** The number where there is one, the draft reference where there is not. */
  label: string;
  accountId: string | null;
  accountName: string | null;
  /** An individual customer — a student, a walk-in. */
  personId: string | null;
  personName: string | null;
  /** Whichever of the two is the customer, resolved once on the server. */
  customerName: string | null;
  contractId: string | null;
  status: string;
  currency: string;
  issuedDate: string | null;
  dueDate: string | null;
  total: number | null;
  taxableValue: number | null;
  taxAmount: number | null;
  allocated: number | null;
  outstanding: number | null;
  daysOverdue: number | null;
  /**
   * What the document says about payment, which is a different fact from
   * `status`: the status follows the receipts, and this is the declaration the
   * customer was handed.
   */
  paymentType: string;
  amountPayableNow: number | null;
  paymentMode: string | null;
  paymentReference: string | null;
  interState: boolean;
  placeOfSupply: string | null;
  customerGstin: string | null;
  division: string | null;
  /** True only while it is a draft. An issued invoice is corrected by a credit note. */
  editable: boolean;
  gstFilingId: string | null;
  /** How many receipts have been issued against it. Part payments live there, not here. */
  receiptCount: number;
  /** The final invoice currently standing against it, if one has been raised. */
  finalInvoiceId: string | null;
  finalInvoiceCode: string | null;
  lines: InvoiceLineView[];
}

export interface InvoiceLineView {
  id: string;
  offeringName: string | null;
  courseId: string | null;
  courseName: string | null;
  /** The enrolment this fee is for: the student on that course. */
  enrollmentId: string | null;
  description: string;
  quantity: number;
  unitPrice: number | null;
  amount: number | null;
  discountAmount: number | null;
  discountPercent: number | null;
  gstRate: number | null;
  taxAmount: number | null;
  hsnSac: string | null;
  revenueMethod: string;
}

/**
 * The invoice as a printable document.
 *
 * Everything resolved on the server, including both totals and the amount in
 * words. The client renders and computes nothing: a screen that recomputes a
 * total is a screen that can disagree with the copy the customer is holding.
 */
export interface InvoiceDocumentView {
  id: string;
  recordCode: string | null;
  draftReference: string | null;
  /** What to call it in a sentence, whichever of the two it has. */
  label: string;
  status: string;
  currency: string;
  issuedDate: string | null;
  dueDate: string | null;
  /** Set only on a course-sale invoice — when the student enrolled, which the schedule below is computed from. */
  enrollmentDate: string | null;
  notes: string | null;
  division: string | null;
  raisedBy: string | null;
  /** tax_invoice | bill_of_supply (docs/plan/compliance.md, workstream B). */
  invoiceType: string;
  /** Rule 46(p): tax on this supply is payable by the recipient. */
  reverseCharge: boolean;

  supplier: {
    legalName: string;
    tradeName: string | null;
    gstin: string | null;
    stateCode: string | null;
    stateName: string | null;
    pan: string | null;
    cin: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    pincode: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    bank: {
      name: string | null;
      accountName: string | null;
      accountNumber: string | null;
      ifsc: string | null;
      branch: string | null;
      upiId: string | null;
    } | null;
    terms: string | null;
    footnote: string | null;
  };

  customer: {
    kind: 'student' | 'institution' | 'organization';
    kindLabel: string;
    name: string;
    recordCode: string | null;
    /** The learner's own registration number, where they have one. */
    registrationNumber: string | null;
    gstin: string | null;
    /** B2B or B2C, from whether the registration is real — it decides who can claim the tax. */
    supplyType: 'b2b' | 'b2c';
    address: string | null;
    email: string | null;
    phone: string | null;
  };

  placeOfSupply: string | null;
  interState: boolean;
  /** Which pair of taxes this invoice carries. Not cosmetic: they are different taxes. */
  taxHeads: readonly string[];

  lines: Array<{
    id: string;
    description: string;
    courseName: string | null;
    courseCode: string | null;
    /** Set where this line is a catalogue add-on rather than the course itself. */
    addonName: string | null;
    hsnSac: string | null;
    quantity: number;
    unitPrice: number;
    /** The fee before any discount — unitPrice x quantity. */
    grossAmount: number;
    /** The taxable value, after the line's own discount. What tax is charged on. */
    amount: number;
    discountAmount: number;
    discountPercent: number;
    gstRate: number;
    taxAmount: number;
    revenueMethod: string;
  }>;

  tax: { taxableValue: number; cgst: number; sgst: number; igst: number; roundOff: number };

  /**
   * The Kaizen course-ledger view of this invoice — present only on a
   * course-sale invoice (one raised with an enrollment date). Every figure
   * here is derived from `lines`/`tax`/`enrollmentDate` above rather than a
   * second source of truth; it exists so the printed ledger table (monthly
   * fee, tenure, effective-monthly-after-discount, the CGST/SGST/IGST split
   * per line) does not have to be recomputed by the client.
   */
  ledger: {
    schedule: { firstPaymentDue: string; subsequentFrom: string } | null;
    rows: Array<{
      lineId: string;
      hsnSac: string | null;
      courseName: string | null;
      addonName: string | null;
      monthlyFee: number;
      tenureMonths: number;
      subtotal: number;
      discountPercent: number;
      discountAmount: number;
      effectiveMonthly: number;
      taxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      total: number;
      isCourseRow: boolean;
    }>;
  } | null;

  /**
   * What the tax invoice says, fixed at issue. Both figures, side by side, and
   * both printed even when they are equal.
   */
  totals: {
    totalPayable: number;
    amountPayableNow: number;
    balanceAtIssue: number;
    inWords: string;
    payableNowInWords: string;
  };

  /** What the invoice said about payment on the day. Never restated. */
  payment: {
    type: string;
    mode: string | null;
    reference: string | null;
    isPartPayment: boolean;
  };

  /**
   * Where the account stands today. Separate from `totals` and not printed on the
   * tax invoice: it moves, and the document does not.
   */
  position: {
    received: number;
    creditNoted: number;
    outstanding: number;
    settled: boolean;
    instalments: number;
    canRaiseFinalInvoice: boolean;
  };

  /** The instalments since, each its own numbered document. */
  receipts: Array<{
    id: string;
    number: number;
    recordCode: string;
    issuedAt: string;
    amount: number;
    mode: string | null;
    reference: string | null;
    balanceAfter: number;
  }>;

  /** Final invoices raised against it, newest first. */
  statements: Array<{
    id: string;
    recordCode: string;
    issuedAt: string;
    totalReceived: number;
    balance: number;
    settled: boolean;
    status: string;
    receiptCount: number;
  }>;

  creditNotes: Array<{ recordCode: string; amount: number; reason: string; issuedAt: string }>;
}

/** A receipt in a list. Part payments live here rather than on the invoice. */
export interface ReceiptView {
  id: string;
  recordCode: string;
  /** When the receipt was issued, which is the fact a receipt exists to fix. */
  issuedAt: string;
  invoiceId: string | null;
  invoiceCode: string | null;
  feeInstalmentId: string | null;
  customerName: string | null;
  amount: number;
  currency: string;
  subjectTotal: number;
  balanceAfter: number;
  paymentMode: string | null;
  paymentReference: string | null;
  paymentCode: string;
  note: string | null;
  settledIt: boolean;
}

/**
 * A receipt as a printable document.
 *
 * The two figures — what the invoice is for, and what is being handed over now —
 * are snapshotted, so a reprint shows the position as it was when the customer
 * was given it.
 */
export interface ReceiptDocumentView {
  id: string;
  recordCode: string;
  issuedAt: string;
  issuedBy: string | null;
  currency: string;

  invoice: {
    id: string;
    recordCode: string;
    issuedDate: string | null;
    dueDate: string | null;
    status: string;
  };

  supplier: {
    legalName: string;
    tradeName: string | null;
    gstin: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
  };

  customer: {
    kind: 'person' | 'organization';
    name: string;
    recordCode: string | null;
    gstin: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };

  payment: {
    amount: number;
    mode: string;
    reference: string | null;
    paymentCode: string;
    note: string | null;
  };

  position: {
    totalPayable: number;
    amountReceivedNow: number;
    receivedToDate: number;
    balanceAfter: number;
    isPartPayment: boolean;
    instalmentNumber: number;
    instalmentsSoFar: number;
  };

  sequence: Array<{
    number: number;
    recordCode: string;
    issuedAt: string;
    amount: number;
    mode: string | null;
    isThisOne: boolean;
  }>;

  /** Never the invoice footnote: a receipt is not an invoice, and says so. */
  footnote: string | null;
}

export interface FinalInvoiceView {
  id: string;
  recordCode: string;
  invoiceId: string;
  invoiceCode: string;
  currency: string;
  issuedAt: string;
  totalPayable: number;
  totalReceived: number;
  creditNoted: number;
  balance: number;
  settled: boolean;
  receiptCodes: string[];
  receiptCount: number;
  status: string;
  note: string | null;
}

/**
 * The statement raised once the instalments are done: the total payable, every
 * part payment, and the receipt numbers they were issued under.
 */
export interface FinalInvoiceDocumentView {
  id: string;
  recordCode: string;
  issuedAt: string;
  issuedBy: string | null;
  status: string;
  currency: string;
  note: string | null;
  supersedes: string[];

  supplier: {
    legalName: string;
    tradeName: string | null;
    gstin: string | null;
    stateName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
    terms: string | null;
    footnote: string | null;
  };

  customer: {
    kind: 'person' | 'organization';
    name: string;
    recordCode: string | null;
    gstin: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };

  invoice: {
    id: string;
    recordCode: string;
    issuedDate: string | null;
    dueDate: string | null;
    placeOfSupply: string | null;
    interState: boolean;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    roundOff: number;
    lines: Array<{
      description: string;
      courseName: string | null;
      hsnSac: string | null;
      quantity: number;
      unitPrice: number;
      amount: number;
      gstRate: number;
      taxAmount: number;
    }>;
  };

  receipts: Array<{
    number: number;
    recordCode: string;
    issuedAt: string;
    amount: number;
    mode: string | null;
    reference: string | null;
    balanceAfter: number;
  }>;

  totals: {
    totalPayable: number;
    totalReceived: number;
    creditNoted: number;
    balance: number;
    settled: boolean;
    instalments: number;
  };
}

export interface GstFilingView {
  id: string;
  recordCode: string;
  returnType: string;
  period: string;
  gstin: string | null;
  status: string;
  taxableValue: number | null;
  cgstAmount: number | null;
  sgstAmount: number | null;
  igstAmount: number | null;
  inputTaxCredit: number | null;
  netPayable: number | null;
  invoiceCount: number;
  preparedAt: string;
  /** The portal's acknowledgement. A return with no ARN was not filed. */
  arn: string | null;
  filedAt: string | null;
  note: string | null;
}

export interface CourseView {
  id: string;
  recordCode: string;
  name: string;
  code: string;
  description: string | null;
  durationWeeks: number | null;
  /** Before tax. A course is a price list as much as a syllabus. */
  feeAmount: number | null;
  gstRate: number | null;
  hsnSac: string | null;
  /** Contact hours, shown beside the price — not used in any pricing arithmetic. */
  hours: number | null;
  division: string | null;
  active: boolean;
  feeWithTax: number | null;
  batchCount: number;
  enrolledCount: number;
  /** Tenure-based pricing — a course sold on 1/3/6/8-month plans has one row per plan instead of relying on `feeAmount`. */
  feePlans: Array<{ id: string; tenureMonths: number; monthlyFee: number }>;
  /** Paid extras sold alongside this course (a certification exam, a kit), priced as a fixed total. */
  addons: Array<{
    id: string;
    name: string;
    price: number;
    gstRate: number;
    hsnSac: string | null;
    notes: string | null;
  }>;
  cohorts: Array<{
    id: string;
    name: string;
    status: string;
    startDate: string;
    endDate: string | null;
    capacity: number;
    enrolledCount: number;
  }>;
}

/** One thing that happened to a student on a day. */
export interface TimelineEntryView {
  id: string;
  kind: string;
  at: string;
  day: string;
  title: string;
  detail: string | null;
  status: string | null;
  severity: string | null;
  rating: number | null;
  score: number | null;
  recordedById: string | null;
  recordedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface LearnerTimelineView {
  enrollment: {
    id: string;
    recordCode: string;
    status: string;
    progressPct: number;
    attendancePct: number;
    atRisk: boolean;
    isMinor: boolean;
    enrolledAt: string | null;
    completedAt: string | null;
    cohortId: string;
    cohortName: string;
    courseName: string;
    courseCode: string;
  };
  student: { id: string; name: string; recordCode: string; phone: string | null; email: string | null } | null;
  counts: {
    entries: number;
    sessions: number;
    present: number;
    queries: number;
    feedback: number;
    issues: number;
    openQueries: number;
    openIssues: number;
    meanRating: number | null;
  };
  /** Everything still open, first, because it is the part that is work. */
  open: Array<{
    id: string;
    kind: string;
    title: string;
    severity: string | null;
    status: string;
    raisedOn: string;
    ageDays: number;
  }>;
  entries: TimelineEntryView[];
  /** Grouped by day, which is how a student's record is read. */
  days: Array<{ day: string; entries: TimelineEntryView[] }>;
  invoices: Array<{
    id: string;
    recordCode: string;
    status: string;
    issuedDate: string | null;
    payable: number;
    allocated: number;
    paymentType: string;
    paymentMode: string | null;
  }>;
}

export interface CompanyProfileView {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  stateCode: string | null;
  stateName: string | null;
  pan: string | null;
  cin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  upiId: string | null;
  invoiceTerms: string | null;
  invoiceNotes: string | null;
  defaultDueDays: number;
}

export interface PaymentView {
  id: string;
  recordCode: string;
  amount: number | null;
  currency: string;
  gatewayReference: string;
  receivedAt: string;
  status: string;
  method: string;
  /** Who took the money. Null for a gateway webhook, which has no human behind it. */
  recordedById: string | null;
  allocated: number | null;
  unallocated: number | null;
  receipts: {
    id: string;
    recordCode: string;
    invoiceId: string | null;
    feeInstalmentId: string | null;
    allocatedAmount: number | null;
    allocatedAt: string;
    balanceAfter: number | null;
  }[];
}

export interface ReceivablesSummary {
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  amountOutstanding: number | null;
  nextDueDate: string | null;
  dunningStage: string | null;
  currency: string;
  /** Explicitly non-authoritative — safe to rebuild, discard, or re-hydrate at any time. */
  hydratedAt: string;
}

// ---------------------------------------------------------------------------
// Platform observability
// ---------------------------------------------------------------------------

export interface EventView {
  id: string;
  eventId: string;
  eventName: string;
  eventVersion: number;
  occurredAt: string;
  recordedAt: string;
  actorType: string;
  actorLabel: string;
  subjectType: string;
  subjectId: string;
  recordCode: string | null;
  correlationId: string;
  causationId: string | null;
  confidentiality: string;
  severity: string | null;
  domains: string[];
  prevHash: string | null;
  hash: string;
  chainValid: boolean;
  previousState: unknown;
  newState: unknown;
  reason: unknown;
}

export interface AuditRecordView {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string;
  actorLabel: string;
  timestamp: string;
  diff: unknown;
  fieldsRead: string[];
  meta: unknown;
}

export interface JobRunView {
  id: string;
  jobName: string;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  processed: number;
  notified: number;
  skippedIdempotent: number;
  errors: string[];
  automationVersionId: string;
}

export interface AgentView {
  id: string;
  agentKey: string;
  name: string;
  purpose: string;
  tier: AiTierCode;
  declaredTools: string[];
  status: string;
  authorityGrants: AuthorityGrantView[];
  actionsLast30d: number;
  authorityShortfallsLast30d: number;
}

export interface AgentActionView {
  id: string;
  agentName: string;
  tier: AiTierCode;
  tool: string;
  action: string;
  subjectType: string;
  subjectId: string;
  proposedAt: string;
  decidedAt: string | null;
  state: string;
  rationale: string;
  humanActorName: string | null;
  onBehalfOfPartyId: string | null;
  blockedReason: string | null;
}

export interface NotificationView {
  id: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  channel: string;
  createdAt: string;
  readAt: string | null;
  drillPath: string | null;
  severity: SeverityCode | null;
}
