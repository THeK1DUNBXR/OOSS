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

/** `GET /hr/employments?status=Active` (the employment picker). Only the person's name is read. */
export interface EmploymentOption {
  id: string;
  person: { fullName: string };
}

/** `GET /hr/employees` (the employee picker): one row per person with an employment. */
export interface EmployeeOption {
  id: string;
  person: { fullName: string; recordCode?: string };
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

export const hcmApi = {
  hr: {
    employments: () => api.get<EmploymentOption[]>('/hr/employments?status=Active'),
    employees: () => api.get<EmployeeOption[]>('/hr/employees'),
    requisitions: () => api.get<RequisitionRow[]>('/hr/requisitions'),
    applications: () => api.get<ApplicationRow[]>('/hr/applications'),
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
