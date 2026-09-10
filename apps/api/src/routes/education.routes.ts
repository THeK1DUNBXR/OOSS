/**
 * Education (edu) and Delivery (prj) read/write surfaces.
 *
 * Trainer scoping is expressed as a GRANT with a `batch_member` scope resolver,
 * evaluated by the same five-axis evaluator every other check goes through —
 * not as a role-slug string comparison inside six service functions. A second
 * role needing the same batch-scoping is a POLICY_VERSION change alone, with
 * zero service-code edits.
 */

import { Router } from 'express';
import { z } from 'zod';
import { EVENTS, ATTENDANCE_STATUSES } from '@kaizen/shared';
import { handler, str, bool, numeric } from '../lib/http.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, scopeFor } from '../platform/permissions.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { auditRegulatedRead } from '../platform/audit.js';
import { raiseException } from '../platform/exceptions.js';

const router = Router();

/**
 * Resolves the batch-membership narrowing from the grant's scope resolver.
 * Where the grant carries `batch_member`, the query is narrowed to cohorts the
 * requester trains — the exact restriction the six hard-coded checks applied,
 * now triggered by a grant lookup instead of a string comparison.
 */
async function cohortScopeFilter(): Promise<Record<string, unknown>> {
  const auth = currentAuth();
  const role = await prisma.accessRole.findFirst({ where: { tenantId: auth.tenantId, slug: auth.roleSlug ?? '' } });
  if (!role) return {};

  const grant = await prisma.grant.findFirst({
    where: { tenantId: auth.tenantId, roleId: role.id, resource: 'education' },
  });

  if (grant?.scopeResolver === 'batch_member') {
    return { trainerPartyId: auth.partyId };
  }
  return {};
}

router.get(
  '/courses',
  handler(async () => {
    await assertCan({ resource: 'education', verb: 'view' });
    const auth = currentAuth();
    return prisma.course.findMany({
      where: { tenantId: auth.tenantId },
      include: { cohorts: { select: { id: true, name: true, status: true, startDate: true } } },
      orderBy: { name: 'asc' },
    });
  }),
);

router.get(
  '/cohorts',
  handler(async (req) => {
    await assertCan({ resource: 'education', verb: 'view' });
    const auth = currentAuth();
    const scopeFilter = await cohortScopeFilter();

    const cohorts = await prisma.cohort.findMany({
      where: {
        tenantId: auth.tenantId,
        ...scopeFilter,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
      },
      include: { course: { select: { name: true, code: true } }, enrollments: { select: { id: true, status: true, atRisk: true } } },
      orderBy: { startDate: 'desc' },
    });

    return cohorts.map((c) => ({
      id: c.id,
      recordCode: c.recordCode,
      name: c.name,
      courseName: c.course.name,
      courseCode: c.course.code,
      startDate: c.startDate.toISOString(),
      endDate: c.endDate?.toISOString() ?? null,
      trainerPartyId: c.trainerPartyId,
      institutionId: c.institutionId,
      capacity: c.capacity,
      status: c.status,
      enrolledCount: c.enrollments.length,
      atRiskCount: c.enrollments.filter((e) => e.atRisk).length,
      // The narrowing is visible so a trainer knows why their list is short.
      scopedToOwnBatches: Object.keys(scopeFilter).length > 0,
    }));
  }),
);

router.get(
  '/enrollments',
  handler(async (req) => {
    await assertCan({ resource: 'education', verb: 'view' });
    const auth = currentAuth();
    const cohortFilter = await cohortScopeFilter();

    const enrollments = await prisma.enrollment.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.cohortId) ? { cohortId: str(req.query.cohortId) } : {}),
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
        ...(bool(req.query.atRisk) ? { atRisk: true } : {}),
        ...(Object.keys(cohortFilter).length ? { cohort: cohortFilter } : {}),
      },
      include: {
        cohort: { include: { course: { select: { name: true } } } },
        institution: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: numeric(req.query.limit) ?? 200,
    });

    const personIds = [...new Set(enrollments.map((e) => e.personId))];
    const people = personIds.length
      ? await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true, recordCode: true } })
      : [];
    const personMap = new Map(people.map((p) => [p.id, p]));

    // Guardian contact is regulated (DPDP-covered). A viewer whose ceiling does
    // not clear it never sees it; a viewer whose ceiling does clear it triggers
    // a read-audit record naming the fields, never their values.
    const canSeeRegulated = auth.classificationCeiling === 'regulated';
    const withGuardian = enrollments.filter((e) => e.isMinor && (e.guardianPhone || e.guardianEmail));
    if (canSeeRegulated) {
      for (const e of withGuardian) {
        await auditRegulatedRead('enrollment', e.id, ['guardianPhone', 'guardianEmail', 'guardianName']);
      }
    }

    return enrollments.map((e) => {
      const person = personMap.get(e.personId);
      const base = {
        id: e.id,
        recordCode: e.recordCode,
        legacyReference: e.legacyReference,
        personId: e.personId,
        personName: person?.fullName ?? null,
        personRecordCode: person?.recordCode ?? null,
        cohortId: e.cohortId,
        cohortName: e.cohort.name,
        courseName: e.cohort.course.name,
        // Which college they came from. Shown on the row rather than only on a
        // detail page: "where are these students from" is the question the
        // list is usually being read to answer.
        institutionId: e.institutionId,
        institutionName: e.institution?.name ?? null,
        status: e.status,
        enrolledAt: e.enrolledAt?.toISOString() ?? null,
        completedAt: e.completedAt?.toISOString() ?? null,
        progressPct: e.progressPct,
        attendancePct: e.attendancePct,
        atRisk: e.atRisk,
        isMinor: e.isMinor,
      };
      // Structurally excluded from the response shape, not merely nulled.
      return canSeeRegulated
        ? { ...base, guardianName: e.guardianName, guardianPhone: e.guardianPhone, guardianEmail: e.guardianEmail }
        : base;
    });
  }),
);

/** The courses on offer, so a batch has something to be a batch of. */
router.get(
  '/courses',
  handler(async () => {
    await assertCan({ resource: 'education', verb: 'view' });
    const auth = currentAuth();
    return prisma.course.findMany({
      where: { tenantId: auth.tenantId, active: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { cohorts: true } } },
    });
  }),
);

router.post(
  '/courses',
  handler(async (req, res) => {
    await assertCan({ resource: 'education', verb: 'create' });
    const auth = currentAuth();
    const body = z
      .object({
        name: z.string().min(1),
        code: z.string().min(1),
        description: z.string().nullish(),
        durationWeeks: z.number().int().positive().nullish(),
      })
      .parse(req.body);

    const clash = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, code: body.code } });
    if (clash) throw ApiError.conflict(`A course with the code ${body.code} already exists: ${clash.name}.`);

    const course = await prisma.course.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('CRS'),
        name: body.name,
        code: body.code,
        description: body.description ?? null,
        durationWeeks: body.durationWeeks ?? null,
      },
    });
    res.status(201).json(course);
    return undefined;
  }),
);

/**
 * A batch of a course.
 *
 * `institutionId` here is where the batch runs — a college hosting it on their
 * campus. That is a different fact from where each student came from, which
 * lives on the enrolment, and they are often but not always the same college.
 */
router.post(
  '/cohorts',
  handler(async (req, res) => {
    await assertCan({ resource: 'education', verb: 'create' });
    const auth = currentAuth();
    const body = z
      .object({
        courseId: z.string(),
        name: z.string().min(1),
        startDate: z.coerce.date(),
        endDate: z.coerce.date().nullish(),
        trainerPartyId: z.string().nullish(),
        institutionId: z.string().nullish(),
        capacity: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const course = await prisma.course.findFirst({ where: { id: body.courseId, tenantId: auth.tenantId } });
    if (!course) throw ApiError.notFound('Course');

    if (body.endDate && body.endDate < body.startDate) {
      throw ApiError.badRequest('A batch cannot end before it starts.');
    }

    const cohort = await prisma.cohort.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: body.name,
        startDate: body.startDate,
        endDate: body.endDate ?? null,
        trainerPartyId: body.trainerPartyId ?? null,
        institutionId: body.institutionId ?? null,
        capacity: body.capacity ?? 30,
        status: 'planned',
      },
    });
    res.status(201).json(cohort);
    return undefined;
  }),
);

/**
 * Enrolling a student.
 *
 * There was no way to do this at all — the enrolment endpoints could change a
 * student's status and mark their attendance, but nothing could create one, so
 * every learner in the system had to have arrived through a seed. That is a
 * strange thing for a platform whose Education division is one of three
 * businesses.
 *
 * The college is asked for here rather than inferred. Recruiting out of a
 * partner institution is the point of tracking colleges separately from client
 * companies, and a student whose college is unrecorded makes that relationship
 * unmeasurable. It stays optional, because a walk-in genuinely has none.
 */
router.post(
  '/enrollments',
  handler(async (req, res) => {
    await assertCan({ resource: 'education', verb: 'create' });
    const auth = currentAuth();

    const body = z
      .object({
        cohortId: z.string(),
        personId: z.string().optional(),
        fullName: z.string().min(1).optional(),
        primaryPhone: z.string().nullish(),
        primaryEmail: z.string().nullish(),
        institutionId: z.string().nullish(),
        isMinor: z.boolean().optional(),
        guardianName: z.string().nullish(),
        guardianPhone: z.string().nullish(),
        guardianEmail: z.string().nullish(),
      })
      .refine((b) => b.personId || b.fullName, {
        message: 'Either an existing person, or a name to create one from.',
      })
      .parse(req.body);

    const cohort = await prisma.cohort.findFirst({
      where: { id: body.cohortId, tenantId: auth.tenantId },
      include: { course: { select: { name: true } } },
    });
    if (!cohort) throw ApiError.notFound('Cohort');

    // A student is a person like any other. Somebody who was a lead last year
    // and is a learner now is one record with two roles, not two people, so an
    // existing id is reused where the caller has one.
    const person = body.personId
      ? await prisma.person.findFirst({ where: { id: body.personId, tenantId: auth.tenantId } })
      : await prisma.person.create({
          data: {
            tenantId: auth.tenantId,
            recordCode: await nextRecordCode('PER'),
            fullName: body.fullName!,
            ...(body.primaryEmail
              ? { primaryEmail: body.primaryEmail, primaryEmailNormalised: body.primaryEmail.toLowerCase() }
              : {}),
            ...(body.primaryPhone
              ? { primaryPhone: body.primaryPhone, primaryPhoneNormalised: body.primaryPhone.replace(/\D/g, '') }
              : {}),
            source: 'enrollment',
          },
        });
    if (!person) throw ApiError.notFound('Person');

    if (body.institutionId) {
      const college = await prisma.organization.findFirst({
        where: { id: body.institutionId, tenantId: auth.tenantId, deletedAt: null },
        include: { institutionProfile: { select: { id: true } } },
      });
      if (!college) throw ApiError.notFound('Organisation');
      if (!college.institutionProfile) {
        throw ApiError.badRequest(
          `${college.name} is on file but is not marked as a college, so students cannot be recorded as coming from it. ` +
            'Mark it as a college on its own page first.',
        );
      }
    }

    // A minor's guardian contact is DPDP-covered. Recording a minor without one
    // is refused rather than accepted and left incomplete, because the missing
    // field is the one that matters if anything goes wrong.
    if (body.isMinor && !body.guardianPhone && !body.guardianEmail) {
      throw ApiError.badRequest('A student under 18 needs a guardian phone or email on the record.');
    }

    const enrollment = await prisma.enrollment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('ENR'),
        personId: person.id,
        cohortId: cohort.id,
        institutionId: body.institutionId ?? null,
        status: 'reserved',
        isMinor: body.isMinor ?? false,
        guardianName: body.guardianName ?? null,
        guardianPhone: body.guardianPhone ?? null,
        guardianEmail: body.guardianEmail ?? null,
      },
    });

    await emit({
      name: EVENTS.ENROLLMENT_CREATED,
      subject: { entityType: 'enrollment', entityId: enrollment.id, recordCode: enrollment.recordCode },
      related: [
        { relation: 'about', entityType: 'person', entityId: person.id },
        { relation: 'in', entityType: 'cohort', entityId: cohort.id },
        ...(body.institutionId
          ? [{ relation: 'recruited_from', entityType: 'organization', entityId: body.institutionId }]
          : []),
      ],
      // The guardian's details are deliberately not in the event body: an event
      // log is a wider audience than the record.
      newState: { status: 'reserved', cohort: cohort.name, course: cohort.course.name, isMinor: enrollment.isMinor },
      owner: { partyId: person.id },
      confidentiality: enrollment.isMinor ? 'restricted' : 'internal',
      impact: { domains: ['edu'] },
    });

    res.status(201).json(enrollment);
    return undefined;
  }),
);

router.post(
  '/enrollments/:id/status',
  handler(async (req) => {
    await assertCan({ resource: 'education', verb: 'edit' });
    const schema = z.object({ status: z.enum(['reserved', 'confirmed', 'active', 'completed', 'withdrawn', 'deferred']) });
    const input = schema.parse(req.body);

    const enrollment = await prisma.enrollment.findFirst({ where: { id: req.params.id }, include: { cohort: true } });
    if (!enrollment) throw ApiError.notFound('Enrollment');

    // The batch_member narrowing applies to the mutation, evaluated through the
    // same evaluator as everything else.
    await assertCan({
      resource: 'education',
      verb: 'edit',
      record: { trainerPartyId: enrollment.cohort.trainerPartyId },
    });

    const updated = await prisma.enrollment.update({
      where: { id: req.params.id },
      data: {
        status: input.status,
        ...(input.status === 'confirmed' ? { enrolledAt: new Date() } : {}),
        ...(input.status === 'completed' ? { completedAt: new Date(), progressPct: 100 } : {}),
      },
    });

    if (input.status === 'confirmed') {
      // Triggers Finance's FEE_INSTALMENT generation — the education-motion
      // parallel to a signed contract's invoice.
      await emit({
        name: EVENTS.ENROLLMENT_CONFIRMED,
        subject: { entityType: 'enrollment', entityId: updated.id, recordCode: updated.recordCode },
        newState: { status: 'confirmed', cohortId: updated.cohortId },
        impact: { domains: ['edu', 'fin'] },
      });
    }
    if (input.status === 'completed') {
      await emit({
        name: EVENTS.ENROLLMENT_COMPLETED,
        subject: { entityType: 'enrollment', entityId: updated.id, recordCode: updated.recordCode },
        newState: { status: 'completed' },
        impact: { domains: ['edu'] },
      });
    }

    return updated;
  }),
);

router.post(
  '/enrollments/:id/attendance',
  handler(async (req) => {
    const schema = z.object({
      sessionDate: z.string(),
      status: z.enum(ATTENDANCE_STATUSES),
      note: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const auth = currentAuth();

    const enrollment = await prisma.enrollment.findFirst({ where: { id: req.params.id }, include: { cohort: true } });
    if (!enrollment) throw ApiError.notFound('Enrollment');

    await assertCan({
      resource: 'education',
      verb: 'edit',
      record: { trainerPartyId: enrollment.cohort.trainerPartyId },
    });

    const sessionDate = new Date(input.sessionDate);
    const record = await prisma.attendance.upsert({
      where: { enrollmentId_sessionDate: { enrollmentId: req.params.id, sessionDate } },
      create: {
        tenantId: auth.tenantId,
        enrollmentId: req.params.id,
        sessionDate,
        status: input.status,
        note: input.note ?? null,
        recordedById: auth.partyId,
      },
      update: { status: input.status, note: input.note ?? null, recordedById: auth.partyId },
    });

    // Recompute attendance and the risk flag from live records, never a
    // hand-maintained field.
    const all = await prisma.attendance.findMany({ where: { enrollmentId: req.params.id } });
    const present = all.filter((a) => a.status === 'present' || a.status === 'late').length;
    const pct = all.length ? Math.round((present / all.length) * 100) : 100;
    const atRisk = pct < 70;

    await prisma.enrollment.update({
      where: { id: req.params.id },
      data: { attendancePct: pct, atRisk, ...(atRisk ? {} : { atRiskNotifiedAt: null }) },
    });

    if (atRisk && !enrollment.atRiskNotifiedAt) {
      await raiseException({
        code: 'EX-EDU-001',
        label: 'Learner at risk',
        severity: 'S2_WARNING',
        subjectType: 'enrollment',
        subjectId: enrollment.id,
        subjectLabel: enrollment.recordCode,
        domain: 'edu',
        detail: `Attendance at ${pct}% across ${all.length} recorded sessions.`,
        ownerPartyId: enrollment.cohort.trainerPartyId,
        triggerFingerprint: 'learner_at_risk',
        ladderRung: 1,
      });
      await prisma.enrollment.update({ where: { id: req.params.id }, data: { atRiskNotifiedAt: new Date() } });
      await emit({
        name: EVENTS.LEARNER_RISK_DETECTED,
        subject: { entityType: 'enrollment', entityId: enrollment.id, recordCode: enrollment.recordCode },
        newState: { attendancePct: pct },
        impact: { domains: ['edu'], severity: 'S2_WARNING' },
      });
    }

    await emit({
      name: EVENTS.ATTENDANCE_RECORDED,
      subject: { entityType: 'attendance', entityId: record.id },
      related: [{ relation: 'for', entityType: 'enrollment', entityId: req.params.id }],
      newState: { status: input.status, attendancePct: pct },
    });

    return { record, attendancePct: pct, atRisk };
  }),
);

router.get(
  '/attendance',
  handler(async (req) => {
    await assertCan({ resource: 'education', verb: 'view' });
    const auth = currentAuth();
    return prisma.attendance.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.enrollmentId) ? { enrollmentId: str(req.query.enrollmentId) } : {}),
      },
      orderBy: { sessionDate: 'desc' },
      take: numeric(req.query.limit) ?? 200,
    });
  }),
);

// ---------------------------------------------------------------------------
// Delivery — the record a project manager actually needs, post-award
// ---------------------------------------------------------------------------

router.get(
  '/projects',
  handler(async (req) => {
    await assertCan({ resource: 'projects', verb: 'view' });
    const auth = currentAuth();
    const projects = await prisma.project.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
        ...(str(req.query.handoff) === 'pending' ? { handoffAcceptedAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const orgIds = [...new Set(projects.map((p) => p.organizationId).filter(Boolean) as string[])];
    const orgs = orgIds.length ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [];
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    return projects.map((p) => ({
      ...p,
      organizationName: p.organizationId ? (orgMap.get(p.organizationId) ?? null) : null,
      handoffPending: p.handoffAcceptedAt === null && p.status === 'planned',
    }));
  }),
);

router.post(
  '/projects/:id/accept-handoff',
  handler(async (req) => {
    await assertCan({ resource: 'projects', verb: 'edit' });
    const auth = currentAuth();
    return prisma.project.update({
      where: { id: req.params.id },
      data: { handoffAcceptedAt: new Date(), status: 'active', managerPartyId: auth.partyId },
    });
  }),
);

router.patch(
  '/projects/:id',
  handler(async (req) => {
    await assertCan({ resource: 'projects', verb: 'edit' });
    const schema = z.object({
      status: z.enum(['planned', 'active', 'on_hold', 'delivered', 'closed']).optional(),
      scheduleVariancePct: z.number().int().optional(),
      healthBand: z.string().optional(),
      targetEndDate: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    return prisma.project.update({
      where: { id: req.params.id },
      data: {
        ...(input.status ? { status: input.status, ...(input.status === 'delivered' ? { actualEndDate: new Date() } : {}) } : {}),
        ...(input.scheduleVariancePct !== undefined ? { scheduleVariancePct: input.scheduleVariancePct } : {}),
        ...(input.healthBand ? { healthBand: input.healthBand } : {}),
        ...(input.targetEndDate !== undefined ? { targetEndDate: input.targetEndDate ? new Date(input.targetEndDate) : null } : {}),
      },
    });
  }),
);

export default router;
