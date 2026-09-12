/**
 * The course catalogue.
 *
 * A course was creatable and then permanent: no edit, no retire, no price. That
 * is the wrong shape for the thing it models. A catalogue is edited constantly —
 * a fee goes up, a programme goes from twenty weeks to twenty-four, a course
 * stops being sold — and a list that can only be appended to fills with rows
 * nobody dares touch and a note somewhere saying which ones are real.
 *
 * Two additions beyond the obvious edit.
 *
 * **A course carries its price, its tax rate and its SAC.** It is a price list as
 * much as a syllabus, and holding those three here is what lets somebody at a
 * counter raise a correct tax invoice by naming the course — rather than knowing
 * the fee, knowing that training is 18%, and knowing the service accounting code.
 *
 * **Retiring is not deleting.** Students are enrolled on courses that stopped
 * being sold years ago, and their record has to keep saying what they did. So
 * `active` goes false, the course stops being billable and stops appearing in the
 * pickers, and every enrolment that points at it still reads correctly.
 */

import { EVENTS, isDivision, round2 } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { enrolStudent } from './education.js';

export interface CourseInput {
  name: string;
  code: string;
  description?: string | null;
  durationWeeks?: number | null;
  feeAmount?: number | null;
  gstRate?: number | null;
  hsnSac?: string | null;
  division?: string | null;
}

export async function listCourses(options: { includeRetired?: boolean } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'courses', verb: 'view' });

  const courses = await prisma.course.findMany({
    where: { tenantId: auth.tenantId, ...(options.includeRetired ? {} : { active: true }) },
    include: {
      cohorts: {
        select: { id: true, name: true, status: true, startDate: true, endDate: true, capacity: true, _count: { select: { enrollments: true } } },
        orderBy: { startDate: 'desc' },
      },
    },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });

  return courses.map((c) => ({
    id: c.id,
    recordCode: c.recordCode,
    name: c.name,
    code: c.code,
    description: c.description,
    durationWeeks: c.durationWeeks,
    feeAmount: num(c.feeAmount),
    gstRate: num(c.gstRate),
    hsnSac: c.hsnSac,
    division: c.division,
    active: c.active,
    // What a customer actually pays, worked out here rather than on four
    // different screens. The tax split still depends on the place of supply,
    // which is an invoice's business and not a course's.
    feeWithTax:
      num(c.feeAmount) === null
        ? null
        : round2((num(c.feeAmount) ?? 0) * (1 + (num(c.gstRate) ?? 0) / 100)),
    batchCount: c.cohorts.length,
    enrolledCount: c.cohorts.reduce((s, h) => s + h._count.enrollments, 0),
    cohorts: c.cohorts.map((h) => ({
      id: h.id,
      name: h.name,
      status: h.status,
      startDate: h.startDate.toISOString(),
      endDate: h.endDate?.toISOString() ?? null,
      capacity: h.capacity,
      enrolledCount: h._count.enrollments,
    })),
  }));
}

function validateShape(input: Partial<CourseInput>) {
  if (input.feeAmount !== undefined && input.feeAmount !== null && input.feeAmount < 0) {
    throw ApiError.badRequest('A course fee cannot be negative.');
  }
  if (input.gstRate !== undefined && input.gstRate !== null) {
    if (input.gstRate < 0 || input.gstRate > 100) {
      throw ApiError.badRequest('A GST rate is a percentage between 0 and 100.');
    }
  }
  if (input.durationWeeks !== undefined && input.durationWeeks !== null && input.durationWeeks <= 0) {
    throw ApiError.badRequest('A course that runs for no weeks is not a course.');
  }
  if (input.division !== undefined && input.division !== null && !isDivision(input.division)) {
    throw ApiError.badRequest(`'${input.division}' is not a division of this company.`);
  }
}

export async function createCourse(input: CourseInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'courses', verb: 'create' });
  validateShape(input);

  const code = input.code.trim().toUpperCase();
  const clash = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, code } });
  if (clash) {
    throw ApiError.conflict(
      `A course with the code ${code} already exists: ${clash.name}${clash.active ? '' : ' (retired)'}.`,
    );
  }

  const course = await prisma.course.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CRS'),
      name: input.name.trim(),
      code,
      description: input.description ?? null,
      durationWeeks: input.durationWeeks ?? null,
      feeAmount: input.feeAmount ?? null,
      gstRate: input.gstRate ?? 18,
      hsnSac: input.hsnSac ?? null,
      division: input.division ?? 'education',
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'course',
    subjectId: course.id,
    after: { code, name: course.name, feeAmount: num(course.feeAmount) },
  });
  await emit({
    name: EVENTS.COURSE_CREATED,
    subject: { entityType: 'course', entityId: course.id, recordCode: course.recordCode },
    newState: { code, name: course.name, feeAmount: num(course.feeAmount), gstRate: num(course.gstRate) },
    impact: { domains: ['edu'] },
  });
  return course;
}

/**
 * Edits a course.
 *
 * The code is editable, with a clash check, because a catalogue whose codes are
 * frozen ends up with `EDU-FSD-2` beside `EDU-FSD` and nobody able to say which
 * is current. Nothing points at a course by code — the enrolments, the batches
 * and the invoice lines all hold ids — so a corrected code corrects every screen
 * at once rather than orphaning history.
 *
 * A fee change applies to invoices raised from now on. Invoices already raised
 * keep their own copy of the price, which is the whole reason the line stores it.
 */
export async function updateCourse(courseId: string, input: Partial<CourseInput> & { active?: boolean }) {
  const auth = currentAuth();
  await assertCan({ resource: 'courses', verb: 'edit' });
  validateShape(input);

  const existing = await prisma.course.findFirst({ where: { id: courseId, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Course');

  let code = existing.code;
  if (input.code !== undefined) {
    code = input.code.trim().toUpperCase();
    if (code !== existing.code) {
      const clash = await prisma.course.findFirst({
        where: { tenantId: auth.tenantId, code, id: { not: courseId } },
      });
      if (clash) throw ApiError.conflict(`${code} is already the code of ${clash.name}.`);
    }
  }

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.code !== undefined ? { code } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.durationWeeks !== undefined ? { durationWeeks: input.durationWeeks } : {}),
      ...(input.feeAmount !== undefined ? { feeAmount: input.feeAmount } : {}),
      ...(input.gstRate !== undefined && input.gstRate !== null ? { gstRate: input.gstRate } : {}),
      ...(input.hsnSac !== undefined ? { hsnSac: input.hsnSac } : {}),
      ...(input.division !== undefined && input.division !== null ? { division: input.division } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'course',
    subjectId: courseId,
    before: {
      name: existing.name,
      code: existing.code,
      feeAmount: num(existing.feeAmount),
      gstRate: num(existing.gstRate),
      durationWeeks: existing.durationWeeks,
      active: existing.active,
    },
    after: {
      name: updated.name,
      code: updated.code,
      feeAmount: num(updated.feeAmount),
      gstRate: num(updated.gstRate),
      durationWeeks: updated.durationWeeks,
      active: updated.active,
    },
  });
  await emit({
    name: existing.active && updated.active === false ? EVENTS.COURSE_RETIRED : EVENTS.COURSE_UPDATED,
    subject: { entityType: 'course', entityId: courseId, recordCode: updated.recordCode },
    previousState: { name: existing.name, feeAmount: num(existing.feeAmount), active: existing.active },
    newState: { name: updated.name, feeAmount: num(updated.feeAmount), active: updated.active },
    impact: { domains: ['edu'] },
  });
  return updated;
}

/**
 * Stops a course being sold.
 *
 * Never a delete. Students hold enrolments on courses that were withdrawn years
 * ago and their record has to keep reading correctly; a retired course also
 * stops being billable, which is checked when an invoice line names one.
 */
export async function retireCourse(courseId: string) {
  const auth = currentAuth();
  const course = await prisma.course.findFirst({ where: { id: courseId, tenantId: auth.tenantId } });
  if (!course) throw ApiError.notFound('Course');

  const running = await prisma.cohort.count({
    where: { tenantId: auth.tenantId, courseId, status: { in: ['planned', 'active'] } },
  });
  if (running > 0) {
    throw ApiError.unprocessable(
      `${course.name} has ${running} batch${running === 1 ? '' : 'es'} still planned or running. Close or cancel them first — retiring the course underneath a live batch would leave students on something we no longer offer.`,
      { runningBatches: running },
    );
  }
  return updateCourse(courseId, { active: false });
}

// ---------------------------------------------------------------------------
// Assigning a course to a customer
// ---------------------------------------------------------------------------

/**
 * The batch a course is assigned into when nobody names one.
 *
 * Every enrolment belongs to a batch: that is what carries the trainer, the
 * dates and the capacity, and it is what the whole education domain narrows and
 * reports on. But assigning a course to a walk-in is a one-minute act at a
 * counter, and making somebody invent a batch first is how that act does not
 * happen.
 *
 * So a course has a rolling batch — open-ended, created on first use, reused
 * afterwards. It is a real batch rather than a null: the trainer can still be
 * set on it, attendance still works, and a course sold to sixty individuals over
 * a year reports as sixty enrolments on one rolling batch rather than as sixty
 * batches of one.
 */
async function rollingCohortFor(courseId: string) {
  const auth = currentAuth();
  const course = await prisma.course.findFirst({ where: { id: courseId, tenantId: auth.tenantId } });
  if (!course) throw ApiError.notFound('Course');
  if (!course.active) {
    throw ApiError.unprocessable(
      `${course.name} (${course.code}) is retired and is not being taught. Reactivate it before assigning students to it.`,
    );
  }

  const name = `${course.name} — rolling`;
  const existing = await prisma.cohort.findFirst({
    where: { tenantId: auth.tenantId, courseId, name },
  });
  if (existing) return existing;

  return prisma.cohort.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('COH'),
      courseId,
      name,
      startDate: new Date(),
      // No end date on purpose: it is the batch for people who join whenever
      // they join, and giving it one would make it expire for no reason.
      endDate: null,
      // Capacity high enough not to be a gate. A rolling intake is not a room.
      capacity: 9_999,
      status: 'active',
    },
  });
}

export interface AssignCourseInput {
  courseId: string;
  /** A specific batch, where the student is joining one. */
  cohortId?: string | null;
  personId?: string | null;
  fullName?: string | null;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  institutionId?: string | null;
  isMinor?: boolean;
  guardianName?: string | null;
  guardianPhone?: string | null;
  guardianEmail?: string | null;
}

/**
 * Puts a customer on a course.
 *
 * This is the endpoint the customer form calls, at creation or afterwards, so
 * "add a customer and assign them a course" is one action rather than two screens
 * and a lookup. Everything it can refuse — the course, the batch, a duplicate
 * enrolment, a minor with no guardian — is refused by `enrolStudent`, which is
 * where those rules already live and where the suite can reach them.
 */
export async function assignCourse(input: AssignCourseInput) {
  const auth = currentAuth();
  const cohortId =
    input.cohortId ??
    (await rollingCohortFor(input.courseId)).id;

  if (input.cohortId) {
    const cohort = await prisma.cohort.findFirst({
      where: { id: input.cohortId, tenantId: auth.tenantId },
      select: { courseId: true, name: true },
    });
    if (!cohort) throw ApiError.notFound('Cohort');
    if (cohort.courseId !== input.courseId) {
      throw ApiError.badRequest(
        `${cohort.name} is not a batch of the course named. Pick a batch of that course, or leave the batch blank to use its rolling intake.`,
      );
    }
  }

  return enrolStudent({
    cohortId,
    personId: input.personId ?? undefined,
    fullName: input.fullName ?? undefined,
    primaryPhone: input.primaryPhone ?? null,
    primaryEmail: input.primaryEmail ?? null,
    institutionId: input.institutionId ?? null,
    isMinor: input.isMinor ?? false,
    guardianName: input.guardianName ?? null,
    guardianPhone: input.guardianPhone ?? null,
    guardianEmail: input.guardianEmail ?? null,
  });
}
