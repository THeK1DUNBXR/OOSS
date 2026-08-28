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
      include: { cohort: { include: { course: { select: { name: true } } } } },
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
