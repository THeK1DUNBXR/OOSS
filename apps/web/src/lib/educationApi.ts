/**
 * Typed endpoints for the Education and Delivery screens: training batches
 * (cohorts), enrolments, the course catalogue, projects after award, and the
 * learner timeline with its open queue.
 *
 * One object per domain on the single `api` client, as `hcmApi.ts` does. The
 * shapes below are the rows the route handlers build, not the Prisma rows:
 * `education.routes.ts` maps cohorts, enrolments and projects into their own
 * payloads, and each interface cites the handler it mirrors.
 *
 * Decimal columns arrive as JSON strings. None of the education endpoints read
 * here carry one: progress and attendance are `Int` in the schema
 * (`prisma/schema/main.prisma` Enrollment, Project), so they are typed as
 * numbers. Money on the course catalogue is typed where it is shared
 * (`CourseView` in `@kaizen/shared`) and is not changed here.
 */

import type { CourseView, LearnerTimelineView } from '@kaizen/shared';
import { api } from './api.js';

/** A list route returns `{ items, total }`, or a bare array on the routes that have no paging yet. */
export interface Page<T> {
  items: T[];
  total: number;
}

// ---------------------------------------------------------------------------
// Batches (cohorts) — education.routes.ts GET /cohorts
// ---------------------------------------------------------------------------

export interface CohortRow {
  id: string;
  recordCode: string;
  name: string;
  courseName: string;
  courseCode: string;
  startDate: string;
  endDate: string | null;
  trainerPartyId: string | null;
  institutionId: string | null;
  capacity: number;
  status: string;
  enrolledCount: number;
  atRiskCount: number;
  /** True when a batch_member scope narrowed the list for this viewer. */
  scopedToOwnBatches: boolean;
}

// ---------------------------------------------------------------------------
// Enrolments — education.routes.ts GET /enrollments
// ---------------------------------------------------------------------------

export interface EnrollmentRow {
  id: string;
  recordCode: string;
  legacyReference: string | null;
  personId: string;
  personName: string | null;
  personRecordCode: string | null;
  cohortId: string;
  cohortName: string;
  courseName: string;
  institutionId: string | null;
  institutionName: string | null;
  status: string;
  enrolledAt: string | null;
  completedAt: string | null;
  progressPct: number;
  attendancePct: number;
  atRisk: boolean;
  isMinor: boolean;
  /**
   * Present only when the viewer's classification ceiling clears `regulated`
   * (education.routes.ts:~205). Structurally absent otherwise, so the page
   * tests for the key with `in`, not for a null value.
   */
  guardianName?: string | null;
  guardianPhone?: string | null;
  guardianEmail?: string | null;
}

export interface EnrollmentQuery {
  atRisk?: boolean;
  /** education.routes.ts:141 filters the list to one person. */
  personId?: string;
}

// ---------------------------------------------------------------------------
// Students — crm.routes.ts GET /students and GET /students/:id
// ---------------------------------------------------------------------------

/**
 * A student is a CRM person with a funded place on a course, so the record is
 * served by the CRM routes (crm.routes.ts:593, :608) and read here, where the
 * Students screens that list and open it live. The shape is the one that page
 * reads, with the fields the route returns for a learner.
 */
export interface StudentRow {
  id: string;
  personId: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  registrationNumber: string | null;
  status: string;
  address: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  institution: { id: string; name: string; recordCode: string } | null;
  funding: string;
  fundingFramework: string | null;
  sponsor: { id: string; name: string; recordCode: string } | null;
  deliveryLocation: string | null;
  billable: boolean;
  enrolmentCount: number;
  createdAt: string;
}

export type StudentQuery = {
  status?: string;
  funding?: string;
  q?: string;
};

// ---------------------------------------------------------------------------
// Projects after award — education.routes.ts GET /projects
// ---------------------------------------------------------------------------

/** The Prisma `Project` row, spread, plus the two fields the route derives. */
export interface ProjectRow {
  id: string;
  recordCode: string;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  opportunityId: string | null;
  contractId: string | null;
  managerPartyId: string | null;
  status: string;
  healthBand: string;
  scheduleVariancePct: number;
  startDate: string | null;
  targetEndDate: string | null;
  actualEndDate: string | null;
  handoffAcceptedAt: string | null;
  /** `handoffAcceptedAt` is null and the project is still `planned`. */
  handoffPending: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Learner queue — learnerTimeline.ts openLearnerItems (GET /learner-log/open)
// ---------------------------------------------------------------------------

export interface OpenLearnerItem {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  severity: string | null;
  status: string;
  entryDate: string;
  ageDays: number;
  enrollmentId: string;
  enrollmentCode: string;
  studentName: string | null;
  cohortName: string;
  courseName: string;
  trainerPartyId: string | null;
}

export interface LearnerLogBody {
  kind: string;
  title: string;
  detail: string | null;
  entryDate: string;
  severity: string | null;
  rating: number | null;
}

export interface AttendanceBody {
  sessionDate: string;
  status: string;
}

export interface DailyProgressBody {
  progressDate: string;
  score: number | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// CRM pickers used by course assignment — crm.routes.ts GET /people, /institutions
// ---------------------------------------------------------------------------

export interface PickerPerson {
  id: string;
  fullName: string;
  primaryPhone: string | null;
}

export interface PickerInstitution {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Course bodies — education.routes.ts courseBodySchema (POST/PATCH /courses)
// ---------------------------------------------------------------------------

export interface CourseBody {
  name?: string;
  code?: string;
  description?: string | null;
  durationWeeks?: number | null;
  feeAmount?: number | null;
  gstRate?: number | null;
  hsnSac?: string | null;
  hours?: number | null;
  division?: string | null;
  feePlans?: Array<{ tenureMonths: number; monthlyFee: number }>;
  addons?: Array<{
    name: string;
    price: number;
    gstRate?: number | null;
    hsnSac?: string | null;
    notes?: string | null;
  }>;
  /** Only the reactivation PATCH sends this (Courses.tsx reactivate). */
  active?: boolean;
}

export interface AssignCourseBody {
  cohortId: string | null;
  personId?: string;
  fullName?: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  institutionId: string | null;
  [age: string]: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BASE = '/education';

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const edu = {
  cohorts: (params: { status?: string } = {}) => api.get<CohortRow[]>(`${BASE}/cohorts${qs(params)}`),

  enrollments: (params: EnrollmentQuery = {}) =>
    api.get<EnrollmentRow[]>(
      `${BASE}/enrollments${qs({ atRisk: params.atRisk ? true : undefined, personId: params.personId })}`,
    ),

  /** crm.routes.ts GET /students, the list the Students screen filters. */
  students: (params: StudentQuery = {}) => api.get<Page<StudentRow>>(`/crm/students${qs(params)}`),

  /** crm.routes.ts GET /students/:id. */
  student: (id: string) => api.get<StudentRow>(`/crm/students/${id}`),

  /** education.routes.ts POST /enrollments/:id/status. */
  setEnrollmentStatus: (id: string, status: string) => api.post(`${BASE}/enrollments/${id}/status`, { status }),

  /** education.routes.ts GET /enrollments/:id/timeline, merged on the server. */
  learnerTimeline: (enrollmentId: string) =>
    api.get<LearnerTimelineView>(`${BASE}/enrollments/${enrollmentId}/timeline`),

  attendance: (enrollmentId: string, body: AttendanceBody) =>
    api.post(`${BASE}/enrollments/${enrollmentId}/attendance`, body),

  recordLearnerLog: (enrollmentId: string, body: LearnerLogBody) =>
    api.post(`${BASE}/enrollments/${enrollmentId}/log`, body),

  recordDailyProgress: (enrollmentId: string, body: DailyProgressBody) =>
    api.post(`${BASE}/enrollments/${enrollmentId}/progress`, body),

  /** learnerTimeline.ts openLearnerItems, through education.routes.ts GET /learner-log/open. */
  openLearnerItems: () => api.get<OpenLearnerItem[]>(`${BASE}/learner-log/open`),

  resolveLearnerLog: (logId: string) => api.post(`${BASE}/learner-log/${logId}/resolve`, { status: 'resolved' }),

  courses: (params: { includeRetired?: boolean } = {}) =>
    api.get<CourseView[]>(`${BASE}/courses${qs({ includeRetired: params.includeRetired ? true : undefined })}`),

  createCourse: (body: CourseBody) => api.post(`${BASE}/courses`, body),

  updateCourse: (id: string, body: CourseBody) => api.patch(`${BASE}/courses/${id}`, body),

  retireCourse: (id: string) => api.post(`${BASE}/courses/${id}/retire`, {}),

  assignCourse: (courseId: string, body: AssignCourseBody) => api.post(`${BASE}/courses/${courseId}/assign`, body),

  projects: () => api.get<ProjectRow[]>(`${BASE}/projects`),

  /** education.routes.ts POST /projects/:id/accept-handoff. */
  acceptProjectHandoff: (id: string) => api.post(`${BASE}/projects/${id}/accept-handoff`),

  /**
   * crm.routes.ts GET /people. Paged `{ items, total }`; the course assignment
   * picker reads the first 200 and tolerates a bare array.
   */
  pickerPeople: () => api.get<Page<PickerPerson> | PickerPerson[]>(`/crm/people?pageSize=200`),

  /** crm.routes.ts GET /institutions (listBodies), same paging as people. */
  pickerInstitutions: () => api.get<Page<PickerInstitution> | PickerInstitution[]>(`/crm/institutions?pageSize=200`),
};
