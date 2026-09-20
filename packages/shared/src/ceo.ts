/**
 * Chairman's Office (`docs/plan/ceo-office.md`).
 *
 * Shared DTO types and enums for every phase (1 through 9) of the module.
 * Phase 0 owns this file in full — it is written once, up front, so nine
 * phases can build against a shape that is already agreed rather than
 * negotiating field names at merge time. No Prisma model lives here; each
 * phase's own `ceo-<area>.prisma` is the source of truth for storage, this
 * file is the wire/view shape every route and page imports instead.
 *
 * Dates are ISO strings on the wire (never `Date`), matching every other
 * view shape in this package (see `board.ts`). Money is always a plain
 * number here — the server holds `Decimal`, the client never computes on it.
 */

// ---------------------------------------------------------------------------
// Phase 1 — Cockpit, Company Scorecard, KPI Library
// ---------------------------------------------------------------------------

export const KPI_STATUSES = ['draft', 'active', 'deprecated'] as const;
export type KpiStatus = (typeof KPI_STATUSES)[number];

export const KPI_VALUE_STATES = ['computed', 'manual', 'not_yet_measured'] as const;
export type KpiValueState = (typeof KPI_VALUE_STATES)[number];

export const KPI_CONSUMER_TYPES = ['okr', 'initiative', 'meeting', 'cockpit'] as const;
export type KpiConsumerType = (typeof KPI_CONSUMER_TYPES)[number];

export const COCKPIT_SNAPSHOT_STATES = ['captured', 'superseded'] as const;
export type CockpitSnapshotState = (typeof COCKPIT_SNAPSHOT_STATES)[number];

export interface KpiDefinitionView {
  id: string;
  recordCode: string; // KPD-...
  name: string;
  definitionText: string;
  unit: string;
  ownerId: string;
  domain: string;
  division: string | null;
  status: KpiStatus;
}

export interface KpiFormulaVersionView {
  id: string;
  kpiId: string;
  expression: string;
  sourceLineage: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface KpiTargetBandView {
  id: string;
  kpiId: string;
  period: string;
  target: number;
  greenMin: number;
  amberMin: number;
}

export interface KpiValueView {
  id: string;
  kpiId: string;
  period: string;
  value: number | null;
  computedAt: string | null;
  formulaVersionId: string | null;
  enteredById: string | null;
  manualNote: string | null;
  state: KpiValueState;
}

export interface KpiReferenceView {
  id: string;
  kpiId: string;
  consumerType: KpiConsumerType;
  consumerId: string;
}

export interface NorthStarMetricView {
  id: string;
  recordCode: string; // NSM-...
  name: string;
  kpiRef: string;
  target: number;
  cadence: string;
}

export interface CockpitViewConfig {
  id: string;
  ownerId: string;
  layoutConfig: Record<string, unknown>;
  pinnedKpiIds: string[];
  divisionFilter: string | null;
}

export interface CockpitSnapshotView {
  id: string;
  ownerId: string;
  takenAt: string;
  tileValues: Record<string, unknown>;
  state: CockpitSnapshotState;
}

// ---------------------------------------------------------------------------
// Phase 2 — Strategy & OKRs
// ---------------------------------------------------------------------------

export const PLAN_STATUSES = ['draft', 'active', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const AOP_STATUSES = ['draft', 'pending_decision', 'active', 'closed'] as const;
export type AopStatus = (typeof AOP_STATUSES)[number];

export const PLAN_ASSUMPTION_STATUSES = ['holding', 'broken'] as const;
export type PlanAssumptionStatus = (typeof PLAN_ASSUMPTION_STATUSES)[number];

export const OBJECTIVE_LEVELS = ['company', 'division', 'team', 'individual'] as const;
export type ObjectiveLevel = (typeof OBJECTIVE_LEVELS)[number];

export const OBJECTIVE_STATUSES = ['draft', 'committed', 'active', 'scoring', 'closed'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const KEY_RESULT_TYPES = ['metric', 'milestone'] as const;
export type KeyResultType = (typeof KEY_RESULT_TYPES)[number];

export const OKR_CYCLE_STATUSES = ['draft', 'open', 'grading', 'closed'] as const;
export type OkrCycleStatus = (typeof OKR_CYCLE_STATUSES)[number];

export interface VisionStatementView {
  id: string;
  text: string;
  effectiveFrom: string;
  version: number;
  status: PlanStatus;
}

export interface ThreeYearPictureView {
  id: string;
  targetFy: string;
  headlineMetrics: Record<string, unknown>;
  narrative: string;
  version: number;
  status: PlanStatus;
}

export interface AnnualOperatingPlanView {
  id: string;
  recordCode: string; // AOP-...
  fy: string;
  division: string | null;
  targetRevenue: number;
  targetMargin: number;
  targetHeadcount: number;
  targetCash: number;
  status: AopStatus;
  decisionId: string | null;
}

export interface StrategicThemeView {
  id: string;
  name: string;
  rationale: string;
  ownerId: string;
  status: 'active' | 'retired';
}

export interface PlanAssumptionView {
  id: string;
  planId: string;
  text: string;
  ownerId: string;
  reviewDate: string;
  status: PlanAssumptionStatus;
}

export interface ObjectiveView {
  id: string;
  recordCode: string; // OBJ-...
  title: string;
  ownerId: string;
  level: ObjectiveLevel;
  parentId: string | null;
  themeId: string | null;
  cycleId: string;
  status: ObjectiveStatus;
  isStretch: boolean;
}

export interface KeyResultView {
  id: string;
  recordCode: string; // KRS-...
  objectiveId: string;
  type: KeyResultType;
  startValue: number;
  targetValue: number;
  currentValue: number;
  unit: string;
  weight: number;
  kpiRef: string | null;
  status: string;
}

export interface CheckInView {
  id: string;
  keyResultId: string;
  date: string;
  value: number;
  confidence: number;
  comment: string | null;
  authorId: string;
}

export interface OkrCycleView {
  id: string;
  fy: string;
  period: string;
  status: OkrCycleStatus;
  lockDate: string | null;
}

// ---------------------------------------------------------------------------
// Phase 3 — Strategic Initiatives Portfolio
// ---------------------------------------------------------------------------

export const INITIATIVE_STATUSES = ['not_started', 'on_track', 'at_risk', 'off_track', 'done', 'killed'] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export const RAG_STATUSES = ['red', 'amber', 'green'] as const;
export type RagStatus = (typeof RAG_STATUSES)[number];

export const INITIATIVE_MILESTONE_STATUSES = ['pending', 'done'] as const;
export type InitiativeMilestoneStatus = (typeof INITIATIVE_MILESTONE_STATUSES)[number];

export const INITIATIVE_DEPENDENCY_TYPES = ['blocks', 'blocked_by'] as const;
export type InitiativeDependencyType = (typeof INITIATIVE_DEPENDENCY_TYPES)[number];

export interface InitiativeView {
  id: string;
  recordCode: string; // INI-...
  title: string;
  sponsorId: string;
  ownerId: string;
  themeId: string | null;
  objectiveIds: string[];
  status: InitiativeStatus;
  rag: RagStatus;
  startDate: string;
  targetEnd: string;
  actualEnd: string | null;
  budgetLineRef: string | null;
}

export interface InitiativeMilestoneView {
  id: string;
  initiativeId: string;
  name: string;
  dueDate: string;
  status: InitiativeMilestoneStatus;
  ownerId: string;
}

export interface InitiativeDependencyView {
  id: string;
  fromId: string;
  toId: string;
  type: InitiativeDependencyType;
}

// ---------------------------------------------------------------------------
// Phase 4 — Operating Rhythm
// ---------------------------------------------------------------------------

export const MEETING_SERIES_TYPES = ['l10', 'mbr', 'qbr', 'annual'] as const;
export type MeetingSeriesType = (typeof MEETING_SERIES_TYPES)[number];

export const MEETING_INSTANCE_STATUSES = ['scheduled', 'in_progress', 'closed'] as const;
export type MeetingInstanceStatus = (typeof MEETING_INSTANCE_STATUSES)[number];

export const ISSUE_ITEM_STATUSES = ['open', 'solving', 'solved'] as const;
export type IssueItemStatus = (typeof ISSUE_ITEM_STATUSES)[number];

export const ACTION_ITEM_STATUSES = ['open', 'done'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export interface MeetingSeriesView {
  id: string;
  type: MeetingSeriesType;
  cadence: string;
  templateId: string | null;
  participantGroup: string[];
}

export interface MeetingInstanceView {
  id: string;
  recordCode: string; // MTG-...
  seriesId: string;
  date: string;
  status: MeetingInstanceStatus;
  attendees: Array<{ partyId: string; present: boolean }>;
  ratingAvg: number | null;
}

export interface AgendaItemView {
  id: string;
  instanceId: string;
  section: string;
  notes: string;
  order: number;
}

export interface IssueItemView {
  id: string;
  title: string;
  raisedById: string;
  raisedDate: string;
  status: IssueItemStatus;
  carriedFromInstanceId: string | null;
  resolvedInInstanceId: string | null;
}

export interface ActionItemView {
  id: string;
  title: string;
  ownerId: string;
  dueDate: string;
  status: ActionItemStatus;
  sourceInstanceId: string;
}

export interface MeetingDecisionLinkView {
  id: string;
  instanceId: string;
  decisionId: string;
}

// ---------------------------------------------------------------------------
// Phase 5 — Delegation of Authority & Approvals Inbox
// ---------------------------------------------------------------------------

export const DELEGATION_LOG_STATUSES = ['active', 'ended'] as const;
export type DelegationLogStatus = (typeof DELEGATION_LOG_STATUSES)[number];

export interface DoaMatrixEntryView {
  id: string;
  recordCode: string; // DOA-...
  decisionClass: string;
  roleSlug: string;
  authorityGrantRef: string;
  /** The ceiling `resolveAuthorityCeiling` actually enforces — a display value, never a second one (§3.4). */
  displayedCeiling: number | null;
}

export interface DelegationLogView {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  responsibility: string;
  until: string;
  status: DelegationLogStatus;
  sourceDecisionId: string | null;
}

export interface ApprovalsInboxRowView {
  domain: string;
  subjectType: string;
  subjectId: string;
  summary: string;
  value: number | null;
  slaDueAt: string | null;
  /** The owning domain's real route — inbox actions POST here directly (§3.9). */
  actionEndpoint: string;
  /** Which policy/ceiling routed this row here — a "why this is here" line. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Phase 6 — Board Pack, Investor Updates & Stakeholders
// ---------------------------------------------------------------------------

export const DOCUMENT_VERSION_STATUSES = ['draft', 'issued'] as const;
export type DocumentVersionStatus = (typeof DOCUMENT_VERSION_STATUSES)[number];

export const STAKEHOLDER_KINDS = ['investor', 'customer', 'regulator', 'partner'] as const;
export type StakeholderKind = (typeof STAKEHOLDER_KINDS)[number];

// Named `Ceo...` to avoid colliding with `board.ts`'s existing `BoardPackView`
// (the per-meeting file-attachment list) — this is a different, generated
// document (docs/plan/ceo-office.md §2 "Board — the statutory layer stays
// statutory").
export interface CeoBoardPackView {
  id: string;
  recordCode: string; // BPK-...
  meetingId: string; // references eqt.BoardMeeting
  title: string;
}

export interface BoardPackVersionView {
  id: string;
  packId: string;
  version: number;
  sections: Record<string, unknown>;
  status: DocumentVersionStatus;
  issuedAt: string | null;
  issuedById: string | null;
}

export interface InvestorUpdateView {
  id: string;
  recordCode: string; // IVU-...
  title: string;
  periodLabel: string;
}

export interface InvestorUpdateVersionView {
  id: string;
  updateId: string;
  version: number;
  sections: Record<string, unknown>;
  status: DocumentVersionStatus;
  issuedAt: string | null;
}

export interface DocumentCirculationView {
  id: string;
  versionId: string;
  versionKind: 'board_pack' | 'investor_update';
  recipientPartyId: string;
  sentAt: string;
  openedAt: string | null;
  acknowledgedAt: string | null;
}

export interface StakeholderView {
  id: string;
  name: string;
  kind: StakeholderKind;
  contactPersonId: string | null;
  relationshipOwnerId: string;
  lastTouchAt: string | null;
  nextPlannedTouchAt: string | null;
}

export interface StakeholderTouchView {
  id: string;
  stakeholderId: string;
  date: string;
  note: string;
  documentRef: string | null;
}

// ---------------------------------------------------------------------------
// Phase 7 — Risk Register, Policy Register & Governance Overview
// ---------------------------------------------------------------------------

export const RISK_STATUSES = ['open', 'mitigating', 'closed'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const POLICY_DOCUMENT_STATUSES = ['draft', 'active', 'superseded'] as const;
export type PolicyDocumentStatus = (typeof POLICY_DOCUMENT_STATUSES)[number];

export interface RiskItemView {
  id: string;
  recordCode: string; // RSK-...
  title: string;
  category: string;
  likelihood: number;
  impact: number;
  mitigation: string | null;
  ownerId: string;
  reviewDate: string;
  status: RiskStatus;
  initiativeRef: string | null;
}

export interface PolicyDocumentView {
  id: string;
  recordCode: string; // PLY-...
  title: string;
  body: string;
  ownerId: string;
  version: number;
  reviewDueDate: string;
  status: PolicyDocumentStatus;
}

export interface PolicyAcknowledgementView {
  id: string;
  policyDocumentId: string;
  partyId: string;
  acknowledgedAt: string;
}

// ---------------------------------------------------------------------------
// Phase 8 — Financial Planning & Headcount
// ---------------------------------------------------------------------------

export const FINANCIAL_SCENARIO_KINDS = ['base', 'upside', 'downside'] as const;
export type FinancialScenarioKind = (typeof FINANCIAL_SCENARIO_KINDS)[number];

export const HEADCOUNT_PLAN_STATUSES = ['draft', 'active'] as const;
export type HeadcountPlanStatus = (typeof HEADCOUNT_PLAN_STATUSES)[number];

export interface FinancialScenarioAssumptions {
  growthRate: number;
  hiringPace: number;
  pricingChange: number;
  fundingTimingMonths: number | null;
}

export interface FinancialScenarioView {
  id: string;
  recordCode: string; // SCN-...
  name: string;
  kind: FinancialScenarioKind;
  assumptions: FinancialScenarioAssumptions;
}

export interface HeadcountPlanView {
  id: string;
  recordCode: string; // HCP-...
  fy: string;
  division: string;
  plannedHeadcount: number;
  plannedCompCost: number;
  status: HeadcountPlanStatus;
}

export interface HeadcountPlanLineView {
  id: string;
  planId: string;
  role: string;
  plannedCount: number;
  plannedCompCost: number;
  startMonth: string;
}

// ---------------------------------------------------------------------------
// Phase 9 — Leadership, Org, 1:1s & Succession
// ---------------------------------------------------------------------------

export const SEAT_STATUSES = ['filled', 'vacant'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const SUCCESSION_READINESS = ['now', '1yr', '2yr', 'none_identified'] as const;
export type SuccessionReadiness = (typeof SUCCESSION_READINESS)[number];

export const TIME_AUDIT_CATEGORIES = ['strategic', 'one_on_one', 'operational', 'external', 'admin'] as const;
export type TimeAuditCategory = (typeof TIME_AUDIT_CATEGORIES)[number];

export interface SeatView {
  id: string;
  recordCode: string; // SEA-...
  title: string;
  function: string;
  ownerId: string | null;
  responsibilities: string[];
  status: SeatStatus;
  parentSeatId: string | null;
}

export interface SuccessionCandidateView {
  id: string;
  seatId: string;
  candidateId: string;
  readiness: SuccessionReadiness;
  notes: string | null;
  reviewedAt: string | null;
}

export interface OneOnOneSeriesView {
  id: string;
  managerId: string;
  reportId: string;
  cadence: string;
  isSkipLevel: boolean;
}

export interface OneOnOneInstanceView {
  id: string;
  seriesId: string;
  date: string;
  notes: Record<string, unknown>;
  actionItems: Array<{ text: string; ownerId: string; done: boolean }>;
  privateFlag: boolean;
}

export interface TimeAuditEntryView {
  id: string;
  personId: string;
  category: TimeAuditCategory;
  durationMinutes: number;
  date: string;
  note: string | null;
}

/** Derived on read from `TimeAuditEntry` rows, never stored (like `budgetVariance`). */
export interface TimeAuditRollupView {
  personId: string;
  period: string;
  byCategory: Record<TimeAuditCategory, number>;
  totalMinutes: number;
}
