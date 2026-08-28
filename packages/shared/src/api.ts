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
  personId: string;
  fullName: string;
  email: string;
  tenantId: string;
  tenantName: string;
  activeAffiliationId: string;
  roleSlug: string;
  archetype: SurfaceArchetype;
  classificationCeiling: SensitivityClass;
  affiliations: AffiliationSummary[];
  grants: string[];
  authorityGrants: AuthorityGrantView[];
  branch: string | null;
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
  recordCode: string;
  accountId: string | null;
  accountName: string | null;
  contractId: string | null;
  status: string;
  currency: string;
  issuedDate: string | null;
  dueDate: string | null;
  total: number | null;
  allocated: number | null;
  outstanding: number | null;
  daysOverdue: number | null;
  lines: { id: string; offeringName: string | null; description: string; amount: number | null; revenueMethod: string }[];
}

export interface PaymentView {
  id: string;
  recordCode: string;
  amount: number | null;
  currency: string;
  gatewayReference: string;
  receivedAt: string;
  status: string;
  allocated: number | null;
  unallocated: number | null;
  receipts: { id: string; invoiceId: string | null; feeInstalmentId: string | null; allocatedAmount: number | null; allocatedAt: string }[];
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
