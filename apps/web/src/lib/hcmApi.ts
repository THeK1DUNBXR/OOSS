/**
 * Typed endpoints for the HR and People screens: the workforce directory and
 * org chart, the approval delegations inbox, the team leave calendar, and the
 * CRM people and merge queue that the People screen shows beside them.
 *
 * One object per domain on the single `api` client. Paths are written once
 * here; a screen that reads a field the response does not carry fails to
 * typecheck instead of rendering undefined. Shapes that exist only as the
 * route's own row or aggregate (no shared view type) are declared below, next
 * to the call that returns them, with the handler they mirror cited.
 */

import type { InteractionView, OrgChartNode, PersonView } from '@kaizen/shared';
import { api } from './api.js';

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/workforce/directory` (domains/hcm/workforce.ts directorySearch). */
export interface DirectoryRow {
  employmentRelationshipId: string;
  recordCode: string;
  status: string;
  person: { id: string; fullName: string; primaryEmail: string | null; primaryPhone: string | null };
  title: string | null;
  orgUnit: string | null;
  location: { name: string; city: string | null } | null;
}

export interface OrgUnitOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Workflow: delegations of authority
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/workflow/delegations` (domains/hcm/workflow.ts listDelegations). */
export interface DelegationRow {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  fromDate: string;
  toDate: string;
  scope: string;
  note: string | null;
  revokedAt: string | null;
}

export interface CreateDelegationBody {
  toPartyId: string;
  fromDate: string;
  toDate: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Leave: team calendar (domains/hcm/leavepolicy.ts teamCalendar)
// ---------------------------------------------------------------------------

export interface TeamCalendarEntry {
  employmentRelationshipId: string;
  fullName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface TeamCalendarResult {
  month: string;
  entries: TeamCalendarEntry[];
  holidays: Array<{ date: string; name: string; kind: string }>;
}

// ---------------------------------------------------------------------------
// People (CRM): directory search, person detail and the merge queue
// ---------------------------------------------------------------------------

export type PeopleGroup = 'all' | 'student' | 'employee' | 'contact' | 'none';

/** `GET /crm/people`: the list view, with counts for each group filter. */
export interface PeopleListResponse {
  items: PersonListItem[];
  total: number;
  counts: Record<PeopleGroup, number>;
}

/**
 * A row of the people list. Mirrors `PersonView` in packages/shared/src/api.ts;
 * the list screen reads only the fields below, so it is typed as a view and not
 * re-declared here.
 */
export type PersonListItem = PersonView;

export interface PersonAffiliationRow {
  id: string;
  affiliationType: string;
  roleSlug: string | null;
  counterpartyName: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  statutoryRetentionFloor: boolean;
}

/**
 * `GET /crm/people/:id` returns the raw Person row with its affiliations, not
 * the `PersonView` the list returns. The two differ: the row carries
 * `mergedIntoId` and `source` where the view carries `mergedInto` and no source.
 */
export interface PersonDetailRow {
  id: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  dedupeStatus: string;
  mergedIntoId: string | null;
  source: string;
  createdAt: string;
  affiliations: PersonAffiliationRow[];
}

export interface PersonRelationshipRow {
  id: string;
  relationshipType: string;
  role: string | null;
  strength: string;
  status: string;
}

/** `GET /crm/people/:id` (routes/crm.routes.ts). */
export interface PersonDetailView {
  person: PersonDetailRow;
  relationships: PersonRelationshipRow[];
  timeline: InteractionView[];
}

/** One row of `GET /crm/merge-candidates` (routes/crm.routes.ts). */
export interface MergeCandidateRow {
  id: string;
  confidence: number;
  matchedOn: string[];
  raisedReason: string;
  state: string;
  createdAt: string;
  incomingPayload: Record<string, unknown> | null;
  candidate: {
    id: string;
    recordCode: string;
    fullName: string;
    affiliationBadges: string[];
    statutoryRetentionFloor: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Shared reads from the HR module, used by the HCM pickers and pipeline boards
// ---------------------------------------------------------------------------

/**
 * One row of `GET /hr/employees` (routes/hr.routes.ts:245). The person's name
 * is flattened onto the employment row; there is no nested `person` object.
 * `id` is the employment relationship id, which is what HCM routes take.
 */
export interface HrEmployeeRow {
  id: string;
  recordCode: string;
  personId: string;
  fullName: string;
  primaryEmail: string | null;
  status: string;
  jobTitle: string | null;
  orgUnit: string | null;
}

/** `GET /hr/requisitions` (domains/hiring.ts): read here for the posting and pipeline screens. */
export interface RequisitionRow {
  id: string;
  recordCode: string;
  status: string;
  position: { recordCode: string; job: { title: string }; orgUnit: { name: string } };
}

/** `GET /hr/applications` (domains/hiring.ts): read here for the pipeline, offers and interview pickers. */
export interface ApplicationRow {
  id: string;
  recordCode: string;
  status: string;
  funnelBucket: string;
  candidate: { id: string; fullName: string; primaryEmail: string | null };
  requisition: { recordCode: string; position: { job: { title: string } } };
}

/**
 * Prisma `Decimal` columns (CTC, bonus) reach the browser as JSON strings,
 * because `Decimal.toJSON()` emits a string. The API does not coerce them
 * (domains/hcm/recruiting.ts listCandidates, platform/audit.ts:246), so the
 * type is `string` and money() gets the number it can format. The value is
 * never rounded here: Decimal(14,2) fits a double with room to spare.
 */
export function decimalAmount(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Separations: resignations, exit clearance, no-dues, alumni, notice policy
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/separations/resignations` (domains/hcm/separations.ts listResignations): the Resignation row plus its employment with the person's name. */
export interface ResignationRow {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  employment: { personId: string; person: { fullName: string; recordCode: string } };
  submittedOn: string;
  requestedLastDay: string;
  agreedLastDay: string | null;
  noticeDays: number;
  reasonCategory: string;
  reasonNote: string | null;
  status: 'submitted' | 'accepted' | 'withdrawn' | 'rejected';
  rejectedReason: string | null;
  offboardingId: string | null;
}

/** One row of `GET /hcm/separations/offboarding/:id/clearances` (domains/hcm/separations.ts listExitClearances). */
export interface ClearanceRow {
  id: string;
  offboardingId: string;
  department: string;
  status: 'pending' | 'cleared' | 'blocked';
  note: string | null;
  clearedAt: string | null;
}

/** `GET /hcm/separations/offboarding/:id/no-dues` (getNoDues): the certificate row, or null until one is issued. */
export interface NoDuesCertificateRow {
  id: string;
  issuedOn: string;
}

/** One row of `GET /hcm/separations/alumni` (domains/hcm/separations.ts listAlumni). */
export interface AlumniRow {
  id: string;
  personId: string;
  employmentRelationshipId: string;
  lastDesignation: string;
  exitDate: string;
  separationType: string;
  rehireEligible: boolean | null;
  rehireNote: string | null;
  contactConsent: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
}

/** One row of `GET /hcm/separations/notice-policies` (domains/hcm/separations.ts listNoticePolicies). */
export interface NoticePolicyRow {
  id: string;
  name: string;
  grade: string | null;
  engagementType: string | null;
  noticeDays: number;
  buyoutAllowed: boolean;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Recruiting: postings, candidates, interviews, offers, referrals, BGV, onboarding
// ---------------------------------------------------------------------------

/** `GET /hcm/recruiting/funnel` (domains/hcm/recruiting.ts recruitingFunnel). */
export interface RecruitingFunnel {
  meanTimeToHireDays: number | null;
  offerAcceptanceRatePct: number | null;
  offersByStatus: Record<string, number>;
  sourceEffectiveness: Array<{ source: string; applications: number; hired: number; hireRate: number | null }>;
}

/** One row of `GET /hcm/recruiting/job-postings` (listJobPostings). */
export interface JobPosting {
  id: string;
  recordCode: string;
  title: string;
  channel: string;
  status: string;
  slug: string;
  publishedAt: string | null;
  closesAt: string | null;
  availableTransitions: string[];
  requisitionId: string;
}

/** One row of `GET /hcm/recruiting/candidates` (listCandidates). CTC is withheld as null without the financial grant. */
export interface CandidateRow {
  id: string;
  source: string;
  currentCtc: string | null;
  expectedCtc: string | null;
  noticeDays: number | null;
  person: {
    id: string;
    fullName: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    recordCode: string;
  } | null;
}

/** One row of `GET /hcm/recruiting/applications/:id/interviews` (listInterviewRounds). */
export interface InterviewRound {
  id: string;
  roundNo: number;
  kind: string;
  scheduledAt: string;
  mode: string;
  status: string;
  outcome: string | null;
  interviewerPartyIds: string[];
}

/** One row of `GET /hcm/recruiting/interviews/:id/scorecards` (listScorecards). */
export interface Scorecard {
  id: string;
  interviewerPartyId: string;
  recommendation: string;
  notes: string | null;
}

/** One row of `GET /hcm/recruiting/offers` (listOffers). CTC is withheld as null without the offers financial grant. */
export interface OfferRow {
  id: string;
  recordCode: string;
  applicationId: string;
  ctc: string | null;
  joiningDate: string;
  validUntil: string;
  status: string;
  availableTransitions: string[];
}

/** One row of `GET /hcm/recruiting/referrals` (listReferrals). Bonus is withheld as null without referrals:financial. */
export interface ReferralRow {
  id: string;
  referrerEmploymentId: string;
  candidatePersonId: string;
  bonusAmount: string | null;
  status: string;
}

/** One row of `GET /hcm/recruiting/background-verifications` (listBackgroundVerifications). */
export interface BgvRow {
  id: string;
  applicationId: string | null;
  employmentId: string | null;
  vendor: string;
  checks: string[];
  status: string;
  outcome: string | null;
}

/** One row of `GET /hcm/recruiting/onboarding-templates` (listOnboardingTemplates). */
export interface OnboardingTemplate {
  id: string;
  title: string;
  category: string;
  assignee: string;
  dueOffsetDays: number;
  active: boolean;
}

/** One row of `GET /hcm/recruiting/onboarding-tasks` (listOnboardingTasks). */
export interface OnboardingTask {
  id: string;
  title: string;
  assignee: string;
  dueDate: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Performance: cycles, assignments, calibration, 9-box, feedback, 1:1s, PIPs, succession
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/performance/review-cycles` (listReviewCycles). */
export interface ReviewCycle {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  periodLabel: string;
  phase: string;
  startsOn: string;
  endsOn: string;
}

/** One row of `GET /hcm/performance/review-assignments` (listReviewAssignments). */
export interface ReviewAssignment {
  id: string;
  cycleId: string;
  employmentRelationshipId: string;
  reviewerEmploymentRelationshipId: string;
  kind: string;
  status: string;
  response: { comments: string | null } | null;
}

export interface CalibrationDecision {
  employmentRelationshipId: string;
  rating: string;
  potential: string;
  promotionRecommended?: boolean;
}

/** One row of `GET /hcm/performance/calibrations` (listCalibrationSessions): `decisions` is the JSON column the update endpoint writes. */
export interface CalibrationSession {
  id: string;
  cycleId: string;
  status: string;
  decisions: CalibrationDecision[] | null;
}

/** One cell of `GET /hcm/performance/nine-box` (nineBoxForCycle). */
export interface NineBoxCell {
  employmentRelationshipId: string;
  rating: string;
  potential: string;
  row: number;
  col: number;
  label: string;
}

/** One row of `GET /hcm/performance/feedback` (listFeedback). */
export interface FeedbackRow {
  id: string;
  fromEmploymentRelationshipId: string;
  toEmploymentRelationshipId: string;
  kind: string;
  message: string;
  visibility: string;
  createdAt: string;
}

/** One row of `GET /hcm/performance/one-on-ones` (listOneOnOnes). */
export interface OneOnOne {
  id: string;
  managerEmploymentRelationshipId: string;
  reportEmploymentRelationshipId: string;
  scheduledAt: string;
  status: string;
}

/** One row of `GET /hcm/performance/pips` (listPips). */
export interface PipRow {
  id: string;
  employmentRelationshipId: string;
  startsOn: string;
  endsOn: string;
  outcome: string;
}

/** One row of `GET /hcm/performance/succession-plans` (listSuccessionPlans). */
export interface SuccessionPlan {
  id: string;
  positionTitle: string;
  successors: Array<{ employmentRelationshipId: string; readiness: string }>;
}

// Request bodies: the fields each create form sends. Optional fields are the
// ones a form leaves blank, which the server treats as absent.

export interface RecordAlumniBody {
  employmentRelationshipId: string;
  rehireEligible: boolean | null;
  rehireNote?: string;
  contactConsent: boolean;
  contactEmail?: string;
  contactPhone?: string;
}

export interface CreateNoticePolicyBody {
  name: string;
  grade?: string;
  engagementType?: string;
  noticeDays: number;
  buyoutAllowed: boolean;
}

export interface CreateJobPostingBody {
  requisitionId: string;
  title: string;
  description: string;
  channel: 'internal' | 'external' | 'referral';
}

export interface CreateCandidateBody {
  fullName: string;
  primaryPhone?: string;
  primaryEmail?: string;
  source: string;
  resumeText?: string;
  currentCtc?: number;
  expectedCtc?: number;
  noticeDays?: number;
}

export interface ScheduleInterviewBody {
  applicationId: string;
  roundNo: number;
  kind: string;
  scheduledAt: string;
  mode: string;
  interviewerPartyIds: string[];
}

export interface SubmitScorecardBody {
  competencyScores: Record<string, number>;
  recommendation: string;
  notes?: string;
}

export interface CreateOfferBody {
  applicationId: string;
  ctc: number;
  joiningDate: string;
  validUntil: string;
}

/** The candidate is created inline with the referral (the form sends it nested). */
export interface CreateReferralBody {
  referrerEmploymentId: string;
  candidate: { fullName: string; primaryPhone?: string; primaryEmail?: string };
  bonusAmount?: number;
}

export interface CreateBgvBody {
  applicationId?: string;
  vendor: string;
  checks: string[];
}

export interface CreateOnboardingTemplateBody {
  title: string;
  category: string;
  assignee: 'hr' | 'it' | 'manager' | 'employee';
  dueOffsetDays: number;
}

export interface CreateReviewCycleBody {
  name: string;
  kind: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
}

export interface CreateReviewAssignmentBody {
  cycleId: string;
  employmentRelationshipId: string;
  reviewerEmploymentRelationshipId: string;
  kind: string;
}

export interface OpenCalibrationBody {
  cycleId: string;
  participants: Array<{ employmentRelationshipId: string }>;
}

export interface GiveFeedbackBody {
  fromEmploymentRelationshipId: string;
  toEmploymentRelationshipId: string;
  kind: string;
  message: string;
  visibility: string;
}

export interface ScheduleOneOnOneBody {
  managerEmploymentRelationshipId: string;
  reportEmploymentRelationshipId: string;
  scheduledAt: string;
}

export interface OpenPipBody {
  employmentRelationshipId: string;
  managerEmploymentRelationshipId?: string;
  startsOn: string;
  endsOn: string;
  objectives: Array<{ description: string }>;
}

export interface CreateSuccessionPlanBody {
  positionTitle: string;
  successors: Array<{ employmentRelationshipId: string; readiness: string }>;
}

// ---------------------------------------------------------------------------
// Engagement: announcements, recognition, pulse surveys, HR helpdesk, policies
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/engagement/announcements` (domains/hcm/engagement.ts listAnnouncements). */
export interface Announcement {
  id: string;
  recordCode: string;
  title: string;
  body: string;
  status: string;
  pinned: boolean;
  acknowledgementRequired: boolean;
  publishAt: string;
  expiresAt: string | null;
}

/** One row of `GET /hcm/engagement/recognitions` (listRecognitions). */
export interface Recognition {
  id: string;
  recordCode: string;
  fromPartyId: string;
  toPartyId: string;
  badge: string;
  message: string;
  points: number;
  createdAt: string;
}

/** One row of `GET /hcm/engagement/recognitions/leaderboard` (recognitionLeaderboard). */
export interface RecognitionLeaderboardRow {
  toPartyId: string;
  totalPoints: number;
  count: number;
}

/** One row of `GET /hcm/engagement/surveys` (listPulseSurveys). */
export interface PulseSurvey {
  id: string;
  recordCode: string;
  title: string;
  anonymous: boolean;
  status: string;
  opensAt: string;
  closesAt: string;
}

/**
 * One question's aggregate in `GET /hcm/engagement/surveys/:id/results`
 * (pulseSurveyResults). Which fields are present depends on the question type:
 * eNPS carries the promoter/passive/detractor split, scale an average, text the answers.
 */
export interface SurveyQuestionResult {
  questionId: string;
  text: string;
  type: string;
  responses?: number;
  average?: number | null;
  answers?: string[];
  promoters?: number;
  passives?: number;
  detractors?: number;
  score?: number | null;
}

export interface SurveyResults {
  survey: PulseSurvey;
  totalResponses: number;
  questions: SurveyQuestionResult[];
}

/** One row of `GET /hcm/engagement/hr-cases` and `/confidential` (listHrCases, listConfidentialHrCases). */
export interface HrCase {
  id: string;
  recordCode: string;
  category: string;
  priority: string;
  status: string;
  subject: string;
  confidential: boolean;
  slaDueAt: string;
  raisedByPartyId: string;
  assigneePartyId: string | null;
}

/** One row of `GET /hcm/engagement/policies` (listPolicyDocuments). */
export interface PolicyDocument {
  id: string;
  recordCode: string;
  title: string;
  version: string;
  status: string;
  effectiveFrom: string;
  acknowledgementRequired: boolean;
}

/** `GET /hcm/engagement/policies/:id/status` (policyAckStatus). */
export interface PolicyAckStatus {
  policy: PolicyDocument;
  ackCount: number;
}

export interface CreateAnnouncementBody {
  title: string;
  body: string;
  pinned: boolean;
  acknowledgementRequired: boolean;
  publishNow: boolean;
}

export interface GiveRecognitionBody {
  toPartyId: string;
  badge: string;
  message: string;
  points: number;
}

export interface CreateSurveyBody {
  title: string;
  anonymous: boolean;
  questions: Array<{ id: string; type: string; text: string }>;
  opensAt: string;
  closesAt: string;
}

export interface CreateHrCaseBody {
  category: string;
  priority: string;
  subject: string;
  body: string;
}

export interface CreatePolicyDocumentBody {
  title: string;
  version: string;
  body: string;
  acknowledgementRequired: boolean;
  effectiveFrom: string;
}

// ---------------------------------------------------------------------------
// Learning: programs, sessions, enrollments, certifications, mandatory training, IDPs, budgets
// ---------------------------------------------------------------------------

/**
 * One row of `GET /hcm/learning/programs` (listPrograms). `cost` is a Prisma
 * Decimal, so it arrives as a JSON string (see decimalAmount above).
 */
export interface TrainingProgram {
  id: string;
  title: string;
  kind: string;
  provider: string | null;
  durationHours: number | null;
  cost: string;
  skillIds: string[];
  validityMonths: number | null;
  isActive: boolean;
}

/** One row of `GET /hcm/learning/sessions` (listSessions), with the program it runs. */
export interface TrainingSession {
  id: string;
  programId: string;
  startsAt: string;
  endsAt: string;
  trainer: string | null;
  seats: number;
  location: string | null;
  status: string;
  program: { title: string; kind: string; cost: string };
}

/** One row of `GET /hcm/learning/enrollments` (listEnrollments), with its session. */
export interface TrainingEnrollment {
  id: string;
  sessionId: string;
  employmentRelationshipId: string;
  status: string;
  score: number | null;
  session: { startsAt: string; program: { title: string; kind: string } };
}

/** One row of `GET /hcm/learning/certifications` (listCertifications). */
export interface TrainingCertification {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  name: string;
  issuer: string | null;
  issuedOn: string;
  expiresOn: string | null;
  verified: boolean;
}

/** One row of `GET /hcm/learning/mandatory-rules` (listMandatoryRules). */
export interface MandatoryTrainingRule {
  id: string;
  programId: string;
  dueWithinDaysOfJoin: number | null;
  recurrenceMonths: number | null;
  program: { title: string };
}

/** One row of `GET /hcm/learning/mandatory-status` (mandatoryComplianceStatus). */
export interface MandatoryTrainingRow {
  ruleId: string;
  programId: string;
  programTitle: string;
  employmentRelationshipId: string;
  dueDate: string | null;
  overdue: boolean;
}

/** One row of `GET /hcm/learning/idps` (listIdps). `goals` is a JSON column the create form fills as `{ items }`. */
export interface IndividualDevelopmentPlan {
  id: string;
  employmentRelationshipId: string;
  goals: { items?: string[] } | null;
  mentorId: string | null;
  reviewDate: string | null;
  status: string;
}

/** One row of `GET /hcm/learning/budgets` (listBudgets). `amount` is a Decimal string; `spent` and utilisation are computed. */
export interface TrainingBudget {
  id: string;
  fy: string;
  division: string | null;
  amount: string;
  spent: number;
  utilisationPercent: number | null;
}

export interface CreateTrainingProgramBody {
  title: string;
  kind: 'classroom' | 'online' | 'certification' | 'mandatory';
  provider?: string;
  cost: number;
  validityMonths?: number;
}

export interface CreateTrainingSessionBody {
  programId: string;
  startsAt: string;
  endsAt: string;
  trainer?: string;
  seats: number;
  location?: string;
}

export interface NominateBody {
  sessionId: string;
  employmentRelationshipId: string;
}

export interface CreateCertificationBody {
  employmentRelationshipId: string;
  name: string;
  issuer?: string;
  issuedOn: string;
  expiresOn?: string;
}

export interface CreateMandatoryRuleBody {
  programId: string;
  dueWithinDaysOfJoin?: number;
  recurrenceMonths?: number;
}

export interface CreateIdpBody {
  employmentRelationshipId: string;
  goals: { items: string[] };
  reviewDate?: string;
}

export interface CreateTrainingBudgetBody {
  fy: string;
  division?: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// Leave policy: policies and rules, accrual runs, approval chains
// ---------------------------------------------------------------------------

/** One row of `GET /hr/leave-types` (routes/hr.routes.ts:592). */
export interface LeaveTypeOption {
  id: string;
  code: string;
  name: string;
}

/**
 * One rule under a policy, as `GET /hcm/leavepolicy/policies` returns it
 * (listLeavePolicies). Decimal columns (accrual days, balances, caps) are JSON
 * strings, so they are typed as such.
 */
export interface LeavePolicyRule {
  id: string;
  leaveTypeId: string;
  accrualFrequency: string;
  accrualDays: string | number;
  prorateOnJoin: boolean;
  maxBalanceDays: string | number | null;
  carryForwardCapDays: string | number | null;
  negativeAllowed: boolean;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
  sandwichRule: boolean;
  requiresDocumentAfterDays: number | null;
  applicableGender: string | null;
}

export interface LeavePolicy {
  id: string;
  name: string;
  description: string | null;
  engagementTypes: string[];
  orgUnitIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  rules: LeavePolicyRule[];
}

/** One row of `GET /hcm/leavepolicy/accrual-runs` (listAccrualRuns). */
export interface AccrualRunRow {
  id: string;
  leavePolicyRuleId: string;
  leaveTypeId: string;
  period: string;
  status: string;
  employeesProcessed: number;
  totalDaysAccrued: string | number;
  runAt: string;
}

export interface ApprovalChainLevel {
  level: number;
  kind: 'manager' | 'hr' | 'custom_grant';
  approverPartyId?: string | null;
}

/** One row of `GET /hcm/leavepolicy/approval-chains` (listApprovalChains). */
export interface ApprovalChain {
  id: string;
  name: string;
  leavePolicyId: string | null;
  levels: ApprovalChainLevel[];
  isDefault: boolean;
}

export interface CreateLeavePolicyBody {
  name: string;
  description: string | null;
  engagementTypes: string[];
  effectiveFrom: string;
}

export interface CreateLeavePolicyRuleBody {
  leaveTypeId: string;
  accrualFrequency: string;
  accrualDays: number;
  prorateOnJoin: boolean;
  maxBalanceDays: number | null;
  carryForwardCapDays: number | null;
  negativeAllowed: boolean;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
  sandwichRule: boolean;
  requiresDocumentAfterDays: number | null;
  applicableGender: string | null;
}

export interface RunAccrualBody {
  leavePolicyRuleId: string | undefined;
  period: string;
}

export interface CreateApprovalChainBody {
  name: string;
  isDefault: boolean;
  levels: ApprovalChainLevel[];
}

// ---------------------------------------------------------------------------
// Time and attendance: shifts, rosters, clock punches, timesheets, overtime, comp-off, regularisations
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/time/shifts` (domains/hcm/time.ts listShifts). */
export interface TimeShift {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakMinutes: number;
  nightShift: boolean;
  active: boolean;
}

/** One row of `GET /hcm/time/rosters` (listRosterAssignments). */
export interface TimeRosterRow {
  id: string;
  employmentRelationshipId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  weeklyOffDays: number[];
}

/** One row of `GET /hcm/time/clock` (listClockEvents): a raw punch. */
export interface TimeClockEvent {
  id: string;
  kind: string;
  occurredAt: string;
  source: string;
}

/** One row of `GET /hcm/time/timesheets` (listTimesheets). Hours are Decimal, so they arrive as strings. */
export interface TimeTimesheet {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  weekStart: string;
  status: string;
  totalHours: string | number;
}

/** One row of `GET /hcm/time/overtime` (listOvertimeRequests). */
export interface TimeOvertimeRow {
  id: string;
  employmentRelationshipId: string;
  date: string;
  hours: string | number;
  reason: string | null;
  status: string;
}

/** One row of `GET /hcm/time/comp-offs` (listCompOffs). */
export interface TimeCompOffRow {
  id: string;
  employmentRelationshipId: string;
  earnedFrom: string;
  earnedOn: string;
  days: string | number;
  expiresOn: string;
  status: string;
}

/** One row of `GET /hcm/time/regularisations` (listRegularisations). */
export interface TimeRegularisationRow {
  id: string;
  employmentRelationshipId: string;
  date: string;
  reason: string;
  status: string;
}

export interface CreateTimeShiftBody {
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakMinutes: number;
  nightShift: boolean;
}

export interface AssignRosterBody {
  employmentRelationshipId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  weeklyOffDays: number[];
}

export interface HolidayWorkCompOffBody {
  employmentRelationshipId: string;
  earnedOn: string;
  days: number;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Assets, travel, letters and ID cards
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/assets/inventory` (listAssets). `cost` is a Decimal string, withheld as null without the financial grant. */
export interface Asset {
  id: string;
  recordCode: string;
  tag: string;
  category: string;
  serial: string | null;
  purchaseDate: string | null;
  cost: string | null;
  status: string;
  note: string | null;
}

/** One row of `GET /hcm/assets/assignments` (listAssetAssignments), with the asset it names. */
export interface AssetAssignment {
  id: string;
  assetId: string;
  employmentRelationshipId: string;
  issuedOn: string;
  returnedOn: string | null;
  condition: string;
  asset: Asset;
}

/** One row of `GET /hcm/assets/travel` (listTravelRequests). Money fields are Decimal strings, withheld as null without the financial grant. */
export interface TravelRequest {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  startDate: string;
  endDate: string;
  mode: string;
  estimatedCost: string | null;
  advanceRequested: string | null;
  status: string;
  expenseClaimId: string | null;
}

/** One row of `GET /hcm/assets/letters` (listLetterRequests). `snapshot` is the letter body, set once fulfilled. */
export interface LetterRequest {
  id: string;
  employmentRelationshipId: string;
  kind: string;
  status: string;
  number: string | null;
  hrLetterId: string | null;
  snapshot: { body: string } | null;
  createdAt: string;
}

/** One row of `GET /hcm/assets/idcards` (listIdCards). */
export interface IdCard {
  id: string;
  employmentRelationshipId: string;
  cardNumber: string;
  status: string;
  issuedOn: string;
  returnedOn: string | null;
}

export interface CreateAssetBody {
  tag: string;
  category: string;
  serial?: string;
  cost?: number;
  note?: string;
}

export interface IssueAssetBody {
  assetId: string;
  employmentRelationshipId: string;
  condition: 'good' | 'fair' | 'poor';
}

export const hcmApi = {
  hr: {
    employees: (status = '') =>
      api.get<HrEmployeeRow[]>(`/hr/employees${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    requisitions: () => api.get<RequisitionRow[]>('/hr/requisitions'),
    applications: () => api.get<ApplicationRow[]>('/hr/applications'),
    leaveTypes: () => api.get<LeaveTypeOption[]>('/hr/leave-types'),
  },
  separations: {
    resignations: {
      list: (status: string) =>
        api.get<ResignationRow[]>(`/hcm/separations/resignations${status ? `?status=${status}` : ''}`),
      accept: (id: string) => api.post(`/hcm/separations/resignations/${id}/accept`),
      reject: (id: string, reason: string) => api.post(`/hcm/separations/resignations/${id}/reject`, { reason }),
    },
    clearances: {
      list: (offboardingId: string) =>
        api.get<ClearanceRow[]>(`/hcm/separations/offboarding/${offboardingId}/clearances`),
      initiate: (offboardingId: string) =>
        api.post<ClearanceRow[]>(`/hcm/separations/offboarding/${offboardingId}/clearances/initiate`),
      clear: (id: string) => api.post(`/hcm/separations/clearances/${id}/clear`),
      block: (id: string, note: string) => api.post(`/hcm/separations/clearances/${id}/block`, { note }),
    },
    noDues: {
      get: (offboardingId: string) =>
        api.get<NoDuesCertificateRow | null>(`/hcm/separations/offboarding/${offboardingId}/no-dues`),
      issue: (offboardingId: string) => api.post(`/hcm/separations/offboarding/${offboardingId}/no-dues`),
    },
    alumni: {
      list: () => api.get<AlumniRow[]>('/hcm/separations/alumni'),
      record: (body: RecordAlumniBody) => api.post('/hcm/separations/alumni', body),
    },
    noticePolicies: {
      list: () => api.get<NoticePolicyRow[]>('/hcm/separations/notice-policies'),
      create: (body: CreateNoticePolicyBody) => api.post('/hcm/separations/notice-policies', body),
      setActive: (id: string, active: boolean) =>
        api.patch(`/hcm/separations/notice-policies/${id}/active`, { active }),
    },
  },
  recruiting: {
    funnel: () => api.get<RecruitingFunnel>('/hcm/recruiting/funnel'),
    postings: {
      list: () => api.get<JobPosting[]>('/hcm/recruiting/job-postings'),
      create: (body: CreateJobPostingBody) => api.post('/hcm/recruiting/job-postings', body),
      transition: (id: string, event: string) => api.post(`/hcm/recruiting/job-postings/${id}/transition`, { event }),
    },
    candidates: {
      list: (q: string) =>
        api.get<CandidateRow[]>(`/hcm/recruiting/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
      create: (body: CreateCandidateBody) => api.post('/hcm/recruiting/candidates', body),
    },
    interviews: {
      rounds: (applicationId: string) =>
        api.get<InterviewRound[]>(`/hcm/recruiting/applications/${applicationId}/interviews`),
      schedule: (body: ScheduleInterviewBody) => api.post('/hcm/recruiting/interviews', body),
      complete: (id: string, outcome: 'advance' | 'reject' | 'hold') =>
        api.post(`/hcm/recruiting/interviews/${id}/complete`, { outcome }),
      scorecards: (roundId: string) => api.get<Scorecard[]>(`/hcm/recruiting/interviews/${roundId}/scorecards`),
      submitScorecard: (roundId: string, body: SubmitScorecardBody) =>
        api.post(`/hcm/recruiting/interviews/${roundId}/scorecards`, body),
    },
    offers: {
      list: () => api.get<OfferRow[]>('/hcm/recruiting/offers'),
      create: (body: CreateOfferBody) => api.post('/hcm/recruiting/offers', body),
      transition: (id: string, event: string, declineReason?: string) =>
        api.post(`/hcm/recruiting/offers/${id}/transition`, { event, declineReason }),
      joinAndOnboard: (applicationId: string, hireEffectiveDate: string) =>
        api.post(`/hcm/recruiting/applications/${applicationId}/join-and-onboard`, { hireEffectiveDate }),
    },
    referrals: {
      list: () => api.get<ReferralRow[]>('/hcm/recruiting/referrals'),
      create: (body: CreateReferralBody) => api.post('/hcm/recruiting/referrals', body),
      setStatus: (id: string, status: string) => api.post(`/hcm/recruiting/referrals/${id}/status`, { status }),
    },
    bgv: {
      list: () => api.get<BgvRow[]>('/hcm/recruiting/background-verifications'),
      create: (body: CreateBgvBody) => api.post('/hcm/recruiting/background-verifications', body),
      update: (id: string, body: { status: string; outcome?: string }) =>
        api.patch(`/hcm/recruiting/background-verifications/${id}`, body),
    },
    onboarding: {
      templates: () => api.get<OnboardingTemplate[]>('/hcm/recruiting/onboarding-templates'),
      createTemplate: (body: CreateOnboardingTemplateBody) => api.post('/hcm/recruiting/onboarding-templates', body),
      tasks: (employmentId: string) =>
        api.get<OnboardingTask[]>(`/hcm/recruiting/onboarding-tasks?employmentId=${employmentId}`),
      completeTask: (id: string, skip: boolean) =>
        api.post(`/hcm/recruiting/onboarding-tasks/${id}/complete`, { skip }),
    },
  },
  performance: {
    cycles: {
      list: () => api.get<ReviewCycle[]>('/hcm/performance/review-cycles'),
      create: (body: CreateReviewCycleBody) => api.post('/hcm/performance/review-cycles', body),
      advance: (id: string, phase: string) => api.post(`/hcm/performance/review-cycles/${id}/phase`, { phase }),
    },
    assignments: {
      list: (cycleId: string) =>
        api.get<ReviewAssignment[]>(`/hcm/performance/review-assignments${cycleId ? `?cycleId=${cycleId}` : ''}`),
      create: (body: CreateReviewAssignmentBody) => api.post('/hcm/performance/review-assignments', body),
    },
    calibrations: {
      list: (cycleId: string) =>
        api.get<CalibrationSession[]>(`/hcm/performance/calibrations${cycleId ? `?cycleId=${cycleId}` : ''}`),
      open: (body: OpenCalibrationBody) => api.post('/hcm/performance/calibrations', body),
      recordDecisions: (sessionId: string, decisions: CalibrationDecision[]) =>
        api.patch(`/hcm/performance/calibrations/${sessionId}`, { decisions }),
      close: (id: string) => api.post(`/hcm/performance/calibrations/${id}/close`),
    },
    nineBox: (cycleId: string) => api.get<NineBoxCell[]>(`/hcm/performance/nine-box?cycleId=${cycleId}`),
    feedback: {
      list: (employmentRelationshipId: string) =>
        api.get<FeedbackRow[]>(
          `/hcm/performance/feedback${employmentRelationshipId ? `?employmentRelationshipId=${employmentRelationshipId}` : ''}`,
        ),
      give: (body: GiveFeedbackBody) => api.post('/hcm/performance/feedback', body),
    },
    oneOnOnes: {
      list: (reportId: string) =>
        api.get<OneOnOne[]>(`/hcm/performance/one-on-ones${reportId ? `?employmentRelationshipId=${reportId}` : ''}`),
      schedule: (body: ScheduleOneOnOneBody) => api.post('/hcm/performance/one-on-ones', body),
      complete: (id: string) => api.patch(`/hcm/performance/one-on-ones/${id}`, { status: 'completed' }),
    },
    pips: {
      list: () => api.get<PipRow[]>('/hcm/performance/pips'),
      open: (body: OpenPipBody) => api.post('/hcm/performance/pips', body),
      close: (id: string, outcome: string) => api.post(`/hcm/performance/pips/${id}/close`, { outcome }),
    },
    succession: {
      list: () => api.get<SuccessionPlan[]>('/hcm/performance/succession-plans'),
      create: (body: CreateSuccessionPlanBody) => api.post('/hcm/performance/succession-plans', body),
    },
  },
  engagement: {
    announcements: {
      list: () => api.get<Announcement[]>('/hcm/engagement/announcements'),
      create: (body: CreateAnnouncementBody) => api.post('/hcm/engagement/announcements', body),
      withdraw: (id: string) => api.post(`/hcm/engagement/announcements/${id}/withdraw`),
    },
    recognitions: {
      list: () => api.get<Recognition[]>('/hcm/engagement/recognitions'),
      leaderboard: () => api.get<RecognitionLeaderboardRow[]>('/hcm/engagement/recognitions/leaderboard'),
      give: (body: GiveRecognitionBody) => api.post('/hcm/engagement/recognitions', body),
    },
    surveys: {
      list: () => api.get<PulseSurvey[]>('/hcm/engagement/surveys'),
      create: (body: CreateSurveyBody) => api.post('/hcm/engagement/surveys', body),
      open: (id: string) => api.post(`/hcm/engagement/surveys/${id}/open`),
      close: (id: string) => api.post(`/hcm/engagement/surveys/${id}/close`),
      results: (id: string) => api.get<SurveyResults>(`/hcm/engagement/surveys/${id}/results`),
    },
    hrCases: {
      list: () => api.get<HrCase[]>('/hcm/engagement/hr-cases'),
      confidential: () => api.get<HrCase[]>('/hcm/engagement/hr-cases/confidential'),
      create: (body: CreateHrCaseBody) => api.post('/hcm/engagement/hr-cases', body),
      resolve: (id: string) => api.post(`/hcm/engagement/hr-cases/${id}/transition`, { status: 'resolved' }),
    },
    policies: {
      list: () => api.get<PolicyDocument[]>('/hcm/engagement/policies'),
      status: (id: string) => api.get<PolicyAckStatus>(`/hcm/engagement/policies/${id}/status`),
      create: (body: CreatePolicyDocumentBody) => api.post('/hcm/engagement/policies', body),
      publish: (id: string) => api.post(`/hcm/engagement/policies/${id}/publish`),
    },
  },
  learning: {
    programs: {
      list: () => api.get<TrainingProgram[]>('/hcm/learning/programs'),
      create: (body: CreateTrainingProgramBody) => api.post('/hcm/learning/programs', body),
      setActive: (id: string, isActive: boolean) => api.patch(`/hcm/learning/programs/${id}`, { isActive }),
    },
    sessions: {
      list: () => api.get<TrainingSession[]>('/hcm/learning/sessions'),
      create: (body: CreateTrainingSessionBody) => api.post('/hcm/learning/sessions', body),
      setStatus: (id: string, status: 'completed' | 'cancelled') =>
        api.post(`/hcm/learning/sessions/${id}/status`, { status }),
    },
    enrollments: {
      list: () => api.get<TrainingEnrollment[]>('/hcm/learning/enrollments'),
      nominate: (body: NominateBody) => api.post('/hcm/learning/enrollments', body),
      approve: (id: string) => api.post(`/hcm/learning/enrollments/${id}/approve`),
      reject: (id: string) => api.post(`/hcm/learning/enrollments/${id}/reject`, {}),
      attend: (id: string, attended: boolean) => api.post(`/hcm/learning/enrollments/${id}/attendance`, { attended }),
      complete: (id: string) => api.post(`/hcm/learning/enrollments/${id}/complete`, {}),
    },
    certifications: {
      list: () => api.get<TrainingCertification[]>('/hcm/learning/certifications'),
      create: (body: CreateCertificationBody) => api.post('/hcm/learning/certifications', body),
      verify: (id: string) => api.post(`/hcm/learning/certifications/${id}/verify`),
      runExpiryCheck: () => api.post('/hcm/learning/certifications/expiry-check'),
    },
    mandatory: {
      rules: () => api.get<MandatoryTrainingRule[]>('/hcm/learning/mandatory-rules'),
      createRule: (body: CreateMandatoryRuleBody) => api.post('/hcm/learning/mandatory-rules', body),
      status: () => api.get<MandatoryTrainingRow[]>('/hcm/learning/mandatory-status'),
    },
    idps: {
      list: () => api.get<IndividualDevelopmentPlan[]>('/hcm/learning/idps'),
      create: (body: CreateIdpBody) => api.post('/hcm/learning/idps', body),
      close: (id: string) => api.patch(`/hcm/learning/idps/${id}`, { status: 'closed' }),
    },
    budgets: {
      list: () => api.get<TrainingBudget[]>('/hcm/learning/budgets'),
      create: (body: CreateTrainingBudgetBody) => api.post('/hcm/learning/budgets', body),
    },
  },
  leavePolicy: {
    policies: {
      list: () => api.get<LeavePolicy[]>('/hcm/leavepolicy/policies'),
      create: (body: CreateLeavePolicyBody) => api.post('/hcm/leavepolicy/policies', body),
      createRule: (policyId: string, body: CreateLeavePolicyRuleBody) =>
        api.post(`/hcm/leavepolicy/policies/${policyId}/rules`, body),
    },
    accrualRuns: {
      list: () => api.get<AccrualRunRow[]>('/hcm/leavepolicy/accrual-runs'),
      run: (body: RunAccrualBody) => api.post('/hcm/leavepolicy/accrual-runs', body),
    },
    approvalChains: {
      list: () => api.get<ApprovalChain[]>('/hcm/leavepolicy/approval-chains'),
      create: (body: CreateApprovalChainBody) => api.post('/hcm/leavepolicy/approval-chains', body),
      remove: (id: string) => api.del(`/hcm/leavepolicy/approval-chains/${id}`),
    },
  },
  time: {
    shifts: {
      list: () => api.get<TimeShift[]>('/hcm/time/shifts'),
      create: (body: CreateTimeShiftBody) => api.post('/hcm/time/shifts', body),
    },
    rosters: {
      list: () => api.get<TimeRosterRow[]>('/hcm/time/rosters'),
      assign: (body: AssignRosterBody) => api.post('/hcm/time/rosters', body),
    },
    clock: {
      list: (employmentRelationshipId: string) =>
        api.get<TimeClockEvent[]>(`/hcm/time/clock?employmentRelationshipId=${employmentRelationshipId}`),
    },
    timesheets: {
      list: (employmentId: string) =>
        api.get<TimeTimesheet[]>(
          `/hcm/time/timesheets${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`,
        ),
      approve: (id: string) => api.post(`/hcm/time/timesheets/${id}/approve`, {}),
      reject: (id: string, note: string) => api.post(`/hcm/time/timesheets/${id}/reject`, { note }),
    },
    overtime: {
      list: (employmentId: string) =>
        api.get<TimeOvertimeRow[]>(
          `/hcm/time/overtime${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`,
        ),
      /** Approving also earns the comp-off, which is why the comp-off list is invalidated on success. */
      decide: (id: string, approve: boolean) =>
        api.post(
          `/hcm/time/overtime/${id}/${approve ? 'approve' : 'reject'}`,
          approve ? {} : { note: 'Not approved.' },
        ),
    },
    compOffs: {
      list: (employmentId: string) =>
        api.get<TimeCompOffRow[]>(
          `/hcm/time/comp-offs${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`,
        ),
      consume: (id: string) => api.post(`/hcm/time/comp-offs/${id}/consume`, {}),
      recordHolidayWork: (body: HolidayWorkCompOffBody) => api.post('/hcm/time/comp-offs/holiday-work', body),
    },
    regularisations: {
      list: (employmentId: string) =>
        api.get<TimeRegularisationRow[]>(
          `/hcm/time/regularisations${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`,
        ),
      approve: (id: string) => api.post(`/hcm/time/regularisations/${id}/approve`, {}),
      reject: (id: string, note: string) => api.post(`/hcm/time/regularisations/${id}/reject`, { note }),
    },
  },
  assets: {
    inventory: {
      list: (status = '') => api.get<Asset[]>(`/hcm/assets/inventory${status ? `?status=${status}` : ''}`),
      create: (body: CreateAssetBody) => api.post('/hcm/assets/inventory', body),
      transition: (id: string, status: string) => api.post(`/hcm/assets/inventory/${id}/transition`, { status }),
    },
    assignments: {
      list: () => api.get<AssetAssignment[]>('/hcm/assets/assignments'),
      issue: (body: IssueAssetBody) => api.post('/hcm/assets/assignments', body),
      return: (id: string, condition: string) => api.post(`/hcm/assets/assignments/${id}/return`, { condition }),
    },
    travel: {
      list: () => api.get<TravelRequest[]>('/hcm/assets/travel'),
      decide: (id: string, decision: 'approved' | 'rejected') =>
        api.post(`/hcm/assets/travel/${id}/decide`, { decision }),
      settle: (id: string, expenseClaimId: string) => api.post(`/hcm/assets/travel/${id}/settle`, { expenseClaimId }),
    },
    letters: {
      list: () => api.get<LetterRequest[]>('/hcm/assets/letters'),
      fulfil: (id: string) => api.post(`/hcm/assets/letters/${id}/fulfil`),
      reject: (id: string, note: string) => api.post(`/hcm/assets/letters/${id}/reject`, { note }),
    },
    idCards: {
      list: () => api.get<IdCard[]>('/hcm/assets/idcards'),
      issue: (employmentRelationshipId: string) => api.post('/hcm/assets/idcards', { employmentRelationshipId }),
      reportLost: (id: string) => api.post(`/hcm/assets/idcards/${id}/lost`),
      returnCard: (id: string) => api.post(`/hcm/assets/idcards/${id}/return`),
    },
  },
  workforce: {
    directory: (q: string) =>
      api.get<DirectoryRow[]>(`/hcm/workforce/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    orgChart: () => api.get<OrgChartNode[]>('/hcm/workforce/org-chart'),
  },
  orgUnits: {
    list: () => api.get<OrgUnitOption[]>('/hr/org-units'),
  },
  delegations: {
    list: () => api.get<DelegationRow[]>('/hcm/workflow/delegations'),
    create: (body: CreateDelegationBody) => api.post('/hcm/workflow/delegations', body),
    revoke: (id: string) => api.post(`/hcm/workflow/delegations/${id}/revoke`),
  },
  leave: {
    teamCalendar: (month: string, orgUnitId: string) =>
      api.get<TeamCalendarResult>(
        `/hcm/leavepolicy/team-calendar?month=${month}${orgUnitId ? `&orgUnitId=${orgUnitId}` : ''}`,
      ),
  },
  people: {
    list: (q: string, group: PeopleGroup) =>
      api.get<PeopleListResponse>(`/crm/people?q=${encodeURIComponent(q)}&affiliation=${group}`),
    get: (id: string) => api.get<PersonDetailView>(`/crm/people/${id}`),
    interactions: () => api.get<InteractionView[]>('/crm/interactions?limit=80'),
    mergeCandidates: () => api.get<MergeCandidateRow[]>('/crm/merge-candidates'),
    resolveMergeCandidate: (id: string, disposition: string, note: string) =>
      api.post(`/crm/merge-candidates/${id}/resolve`, { disposition, note }),
  },
};
