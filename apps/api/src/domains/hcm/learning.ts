/**
 * HCM — learning (docs/hcm/learning.md). Mounted at /api/hcm/learning.
 *
 * L&D catalogue (programs, sessions), nomination/approval/completion of
 * enrollments, certifications with an expiry ladder, mandatory-training
 * tracking, individual development plans and a training budget.
 *
 * Deliberately does not reimplement capability tiers or evidence: a completed
 * enrollment against a program with `skillIds` calls straight into
 * `claimFromLearningCompletion` (apps/api/src/domains/capability.ts), the
 * same function `performance.ts`'s own learning-completion path uses. This
 * file owns the training catalogue and the enrollment workflow around it; it
 * never writes a CapabilityClaim or Evidence row directly.
 */

import {
  assertCertificationVerificationAllowed,
  assertEnrollmentApprovalAllowed,
  assertEnrollmentTransition,
  budgetUtilisationPercent,
  certificationExpiryFrom,
  expiryRungReached,
  isCertificationExpired,
  isMandatoryTrainingOverdue,
  mandatoryTrainingDueDate,
  nextRecurrenceDue,
  TRAINING_PROGRAM_KINDS,
  EVENTS,
  HrRuleViolationError,
  type TrainingEnrollmentStatus,
  type TrainingProgramKind,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { raiseException } from '../../platform/exceptions.js';
import { claimFromLearningCompletion } from '../capability.js';
import type { JobResult } from '../../jobs/scheduler.js';

function asApiError(err: unknown): never {
  if (err instanceof HrRuleViolationError) throw ApiError.unprocessable(err.message);
  throw err;
}

async function employmentOrThrow(employmentRelationshipId: string) {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
    select: { id: true, personId: true, hireEffectiveDate: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment;
}

/**
 * Admin-only gate. `assertCan({resource, verb})` with no `record` skips the
 * WHERE axis entirely — an own-scope grant would otherwise pass it and reach
 * an operation that acts on other people's records (approving someone else's
 * nomination, marking someone else's attendance, verifying someone else's
 * certification, reading the whole company's compliance status). Those are
 * not self-service actions, so they require the caller's resolved scope to
 * actually be `all`, checked explicitly rather than left to a record that is
 * never supplied.
 */
async function requireAllScope(resource: string, verb: 'approve' | 'edit' | 'view', message: string): Promise<void> {
  const scope = await scopeFor(resource, verb);
  if (scope !== 'all') throw ApiError.forbidden(message);
}

/** The ids of employment relationships belonging to the caller — for narrowing a list, or checking whether a target record is the caller's own. */
async function myEmploymentIds(): Promise<string[]> {
  const auth = currentAuth();
  if (!auth.partyId) return [];
  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, personId: auth.partyId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Training programs
// ---------------------------------------------------------------------------

export async function listPrograms(activeOnly = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'view' });
  return prisma.trainingProgram.findMany({
    where: { tenantId: auth.tenantId, ...(activeOnly ? { isActive: true } : {}) },
    orderBy: { title: 'asc' },
  });
}

export async function getProgram(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'view' });
  const program = await prisma.trainingProgram.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!program) throw ApiError.notFound('Training program');
  return program;
}

export async function createProgram(input: {
  title: string;
  kind: TrainingProgramKind;
  provider?: string | null;
  durationHours?: number | null;
  cost?: number;
  skillIds?: string[];
  validityMonths?: number | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'create' });

  if (!TRAINING_PROGRAM_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a training program kind. Expected one of: ${TRAINING_PROGRAM_KINDS.join(', ')}.`);
  }

  const program = await prisma.trainingProgram.create({
    data: {
      tenantId: auth.tenantId,
      title: input.title,
      kind: input.kind,
      provider: input.provider ?? null,
      durationHours: input.durationHours ?? null,
      cost: input.cost ?? 0,
      skillIds: input.skillIds ?? [],
      validityMonths: input.validityMonths ?? null,
    },
  });

  await emit({
    name: EVENTS.TRAINING_PROGRAM_CREATED,
    subject: { entityType: 'training_program', entityId: program.id },
    newState: { title: program.title, kind: program.kind },
    impact: { domains: ['hr'] },
  });

  return program;
}

export async function setProgramActive(id: string, isActive: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'edit' });
  const program = await prisma.trainingProgram.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!program) throw ApiError.notFound('Training program');
  return prisma.trainingProgram.update({ where: { id }, data: { isActive } });
}

// ---------------------------------------------------------------------------
// Training sessions
// ---------------------------------------------------------------------------

export async function listSessions(programId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_sessions', verb: 'view' });
  return prisma.trainingSession.findMany({
    where: { tenantId: auth.tenantId, ...(programId ? { programId } : {}) },
    include: { program: { select: { title: true, kind: true, cost: true } } },
    orderBy: { startsAt: 'desc' },
  });
}

export async function createSession(input: {
  programId: string;
  startsAt: Date;
  endsAt: Date;
  trainer?: string | null;
  seats?: number;
  location?: string | null;
  link?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_sessions', verb: 'create' });

  const program = await prisma.trainingProgram.findFirst({ where: { id: input.programId, tenantId: auth.tenantId } });
  if (!program) throw ApiError.notFound('Training program');

  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw ApiError.badRequest('A session must end after it starts.');
  }

  const session = await prisma.trainingSession.create({
    data: {
      tenantId: auth.tenantId,
      programId: input.programId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      trainer: input.trainer ?? null,
      seats: input.seats ?? 0,
      location: input.location ?? null,
      link: input.link ?? null,
    },
  });

  await emit({
    name: EVENTS.TRAINING_SESSION_SCHEDULED,
    subject: { entityType: 'training_session', entityId: session.id },
    related: [{ relation: 'instance_of', entityType: 'training_program', entityId: program.id }],
    newState: { startsAt: session.startsAt, programTitle: program.title },
    impact: { domains: ['hr'] },
  });

  return session;
}

export async function setSessionStatus(id: string, status: 'completed' | 'cancelled') {
  const auth = currentAuth();
  await assertCan({ resource: 'training_sessions', verb: 'edit' });
  const session = await prisma.trainingSession.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!session) throw ApiError.notFound('Training session');
  return prisma.trainingSession.update({ where: { id }, data: { status } });
}

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

export async function listEnrollments(filter: { sessionId?: string; employmentRelationshipId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'view' });

  let employmentFilter: string[] | undefined;
  if (filter.employmentRelationshipId) {
    await assertEmploymentVisible('training_enrollments', filter.employmentRelationshipId, 'view');
    employmentFilter = [filter.employmentRelationshipId];
  } else {
    // No target named: an own-scope caller (an `employee` role) would
    // otherwise see every colleague's enrollments, since the WHERE axis is
    // only evaluated against a record and none is supplied for a bare list.
    // Narrow explicitly to the caller's own employment(s) instead.
    const scope = await scopeFor('training_enrollments', 'view');
    if (scope !== 'all') employmentFilter = await myEmploymentIds();
  }

  return prisma.trainingEnrollment.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(employmentFilter ? { employmentRelationshipId: { in: employmentFilter } } : {}),
    },
    include: {
      session: { include: { program: { select: { title: true, kind: true, skillIds: true, validityMonths: true, cost: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** A nomination — the employee's own request, or a manager/HR nominating them. */
export async function nominate(input: { sessionId: string; employmentRelationshipId: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'create' });

  const session = await prisma.trainingSession.findFirst({ where: { id: input.sessionId, tenantId: auth.tenantId } });
  if (!session) throw ApiError.notFound('Training session');
  const employment = await employmentOrThrow(input.employmentRelationshipId);

  // `create` at `own` scope only covers nominating yourself — an own-scope
  // caller naming somebody else's employment would otherwise pass, since no
  // record is supplied to the earlier `assertCan` for the WHERE axis to
  // narrow against.
  const scope = await scopeFor('training_enrollments', 'create');
  if (scope !== 'all' && employment.personId !== auth.partyId) {
    throw ApiError.forbidden('You may only nominate yourself for a session.');
  }

  const enrollment = await prisma.trainingEnrollment.create({
    data: {
      tenantId: auth.tenantId,
      sessionId: input.sessionId,
      employmentRelationshipId: input.employmentRelationshipId,
      nominatedById: auth.partyId,
    },
  });

  await emit({
    name: 'kz.hr.training_enrollment.nominated',
    subject: { entityType: 'training_enrollment', entityId: enrollment.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { status: 'nominated', sessionId: input.sessionId },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return enrollment;
}

async function loadEnrollment(id: string) {
  const auth = currentAuth();
  const enrollment = await prisma.trainingEnrollment.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { session: { include: { program: true } } },
  });
  if (!enrollment) throw ApiError.notFound('Training enrollment');
  return enrollment;
}

/** Approves a nomination. Self-Dealing Bar: the approver may be neither the nominee nor the nominator. */
export async function approveEnrollment(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'approve' });
  await requireAllScope('training_enrollments', 'approve', 'Approving a nomination is not a self-service action.');

  const enrollment = await loadEnrollment(id);
  try {
    assertEnrollmentTransition(enrollment.status as TrainingEnrollmentStatus, 'approved');
  } catch (err) {
    asApiError(err);
  }

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: enrollment.employmentRelationshipId, tenantId: auth.tenantId },
    select: { personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  if (!auth.partyId) throw ApiError.forbidden('Approval requires a human principal.');

  try {
    assertEnrollmentApprovalAllowed({
      approverPartyId: auth.partyId,
      nomineePersonId: employment.personId,
      nominatedByPartyId: enrollment.nominatedById,
    });
  } catch (err) {
    asApiError(err);
  }

  const updated = await prisma.trainingEnrollment.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, approvedAt: new Date() },
  });

  await emit({
    name: 'kz.hr.training_enrollment.approved',
    subject: { entityType: 'training_enrollment', entityId: id },
    previousState: { status: enrollment.status },
    newState: { status: 'approved' },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

export async function rejectEnrollment(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'approve' });
  await requireAllScope('training_enrollments', 'approve', 'Rejecting a nomination is not a self-service action.');
  const enrollment = await loadEnrollment(id);
  try {
    assertEnrollmentTransition(enrollment.status as TrainingEnrollmentStatus, 'rejected');
  } catch (err) {
    asApiError(err);
  }
  const updated = await prisma.trainingEnrollment.update({ where: { id }, data: { status: 'rejected' } });
  await emit({
    name: 'kz.hr.training_enrollment.rejected',
    subject: { entityType: 'training_enrollment', entityId: id },
    previousState: { status: enrollment.status },
    newState: { status: 'rejected' },
    reason: note ? { reasonCode: 'declined', note } : null,
    impact: { domains: ['hr'] },
  });
  return updated;
}

export async function markAttendance(id: string, attended: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'edit' });
  await requireAllScope('training_enrollments', 'edit', 'Recording someone else\'s attendance is not a self-service action.');
  const enrollment = await loadEnrollment(id);
  const target: TrainingEnrollmentStatus = attended ? 'attended' : 'no_show';
  try {
    assertEnrollmentTransition(enrollment.status as TrainingEnrollmentStatus, target);
  } catch (err) {
    asApiError(err);
  }
  return prisma.trainingEnrollment.update({ where: { id }, data: { status: target } });
}

/**
 * Completing an enrollment. If the program names skills, this asserts a
 * capability claim per skill via `claimFromLearningCompletion` — the existing
 * capability system, not a shadow copy of it. If the program is
 * certification-kind, this also issues a Certification row, unverified until
 * someone other than the holder checks it.
 */
export async function completeEnrollment(id: string, input: { score?: number | null; feedback?: string | null } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_enrollments', verb: 'edit' });
  await requireAllScope('training_enrollments', 'edit', 'Completing someone else\'s enrollment is not a self-service action.');

  const enrollment = await loadEnrollment(id);
  try {
    assertEnrollmentTransition(enrollment.status as TrainingEnrollmentStatus, 'completed');
  } catch (err) {
    asApiError(err);
  }

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: enrollment.employmentRelationshipId, tenantId: auth.tenantId },
    select: { personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const completedAt = new Date();
  const updated = await prisma.trainingEnrollment.update({
    where: { id },
    data: { status: 'completed', completedAt, score: input.score ?? null, feedback: input.feedback ?? null },
  });

  await emit({
    name: EVENTS.TRAINING_ENROLLMENT_COMPLETED,
    subject: { entityType: 'training_enrollment', entityId: id },
    previousState: { status: enrollment.status },
    newState: { status: 'completed', programTitle: enrollment.session.program.title },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  const program = enrollment.session.program;
  for (const skillId of program.skillIds) {
    await claimFromLearningCompletion({ partyId: employment.personId, skillId, learningRecordId: id });
  }

  let certification: Awaited<ReturnType<typeof issueCertificationFromEnrollment>> | null = null;
  if (program.kind === 'certification') {
    certification = await issueCertificationFromEnrollment({
      employmentRelationshipId: enrollment.employmentRelationshipId,
      programTitle: program.title,
      provider: program.provider,
      issuedOn: completedAt,
      validityMonths: program.validityMonths,
      sourceEnrollmentId: id,
    });
  }

  return { enrollment: updated, certification };
}

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

export async function listCertifications(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'certifications', verb: 'view' });

  let employmentFilter: string[] | undefined;
  if (employmentRelationshipId) {
    await assertEmploymentVisible('certifications', employmentRelationshipId, 'view');
    employmentFilter = [employmentRelationshipId];
  } else {
    const scope = await scopeFor('certifications', 'view');
    if (scope !== 'all') employmentFilter = await myEmploymentIds();
  }

  return prisma.certification.findMany({
    where: { tenantId: auth.tenantId, ...(employmentFilter ? { employmentRelationshipId: { in: employmentFilter } } : {}) },
    orderBy: { issuedOn: 'desc' },
  });
}

async function issueCertificationFromEnrollment(input: {
  employmentRelationshipId: string;
  programTitle: string;
  provider: string | null;
  issuedOn: Date;
  validityMonths: number | null;
  sourceEnrollmentId: string;
}) {
  const auth = currentAuth();
  const expiresOn = certificationExpiryFrom(input.issuedOn, input.validityMonths);
  const cert = await prisma.certification.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CERT'),
      employmentRelationshipId: input.employmentRelationshipId,
      name: input.programTitle,
      issuer: input.provider,
      issuedOn: input.issuedOn,
      expiresOn,
      sourceEnrollmentId: input.sourceEnrollmentId,
    },
  });

  await emit({
    name: EVENTS.CERTIFICATION_ISSUED,
    subject: { entityType: 'certification', entityId: cert.id, recordCode: cert.recordCode },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { name: cert.name, expiresOn: cert.expiresOn },
    impact: { domains: ['hr'] },
  });

  return cert;
}

/** A certification entered directly — one the person already held, or one from outside this platform's training catalogue. */
export async function addCertification(input: {
  employmentRelationshipId: string;
  name: string;
  issuer?: string | null;
  issuedOn: Date;
  expiresOn?: Date | null;
  documentRef?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'certifications', verb: 'create', record: { ownerPartyId: (await employmentOrThrow(input.employmentRelationshipId)).personId } });

  const cert = await prisma.certification.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CERT'),
      employmentRelationshipId: input.employmentRelationshipId,
      name: input.name,
      issuer: input.issuer ?? null,
      issuedOn: input.issuedOn,
      expiresOn: input.expiresOn ?? null,
      documentRef: input.documentRef ?? null,
    },
  });

  await emit({
    name: EVENTS.CERTIFICATION_ISSUED,
    subject: { entityType: 'certification', entityId: cert.id, recordCode: cert.recordCode },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { name: cert.name, expiresOn: cert.expiresOn },
    impact: { domains: ['hr'] },
  });

  return cert;
}

/** Verification — deliberately gated the same way as everything else that turns a claim into a fact: not by the holder. */
export async function verifyCertification(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'certifications', verb: 'approve' });
  await requireAllScope('certifications', 'approve', 'Verifying a certification is not a self-service action.');

  const cert = await prisma.certification.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cert) throw ApiError.notFound('Certification');

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: cert.employmentRelationshipId, tenantId: auth.tenantId },
    select: { personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  if (!auth.partyId) throw ApiError.forbidden('Verification requires a human principal.');

  try {
    assertCertificationVerificationAllowed({ verifierPartyId: auth.partyId, holderPersonId: employment.personId });
  } catch (err) {
    asApiError(err);
  }

  const updated = await prisma.certification.update({
    where: { id },
    data: { verified: true, verifiedById: auth.partyId, verifiedAt: new Date() },
  });

  await emit({
    name: 'kz.hr.certification.verified',
    subject: { entityType: 'certification', entityId: id, recordCode: cert.recordCode },
    newState: { verified: true },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

/** The 90/30/7 expiry ladder job. Idempotent per rung via `lastExpiryRungDays`. */
export async function runCertificationExpiryLadder(): Promise<JobResult> {
  const auth = currentAuth();
  // Reachable both as a scheduled job (SYSTEM_PRINCIPAL, which `assertScopeAll`
  // always passes) and via the route a human can call directly — the latter
  // had no permission check at all before this, so any authenticated user
  // could trigger it and would receive every certification's expiry state
  // back through the exceptions it raises.
  await assertScopeAll('certifications');
  const now = new Date();
  const horizon = new Date(now.getTime() + 91 * 86_400_000);

  const certs = await prisma.certification.findMany({
    where: { tenantId: auth.tenantId, expiresOn: { not: null, lte: horizon } },
  });
  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, id: { in: certs.map((c) => c.employmentRelationshipId) } },
    select: { id: true, personId: true },
  });
  const personIdByEmployment = new Map<string, string>(employments.map((e) => [e.id, e.personId]));

  let processed = 0;
  let notified = 0;
  let skippedIdempotent = 0;

  for (const cert of certs) {
    if (!cert.expiresOn) continue;
    processed += 1;

    if (isCertificationExpired(cert.expiresOn, now)) {
      if (cert.lastExpiryRungDays === 0) {
        skippedIdempotent += 1;
        continue;
      }
      await raiseException({
        code: 'CERTIFICATION_EXPIRED',
        label: `Certification expired: ${cert.name}`,
        severity: 'S4_CRITICAL',
        subjectType: 'certification',
        subjectId: cert.id,
        subjectLabel: cert.recordCode,
        domain: 'hr',
        detail: `${cert.name} expired on ${cert.expiresOn.toISOString().slice(0, 10)} and has not been renewed.`,
        ownerPartyId: (personIdByEmployment.get(cert.employmentRelationshipId) ?? null),
        triggerFingerprint: 'expired',
        ladderRung: 0,
      });
      await prisma.certification.update({ where: { id: cert.id }, data: { lastExpiryRungDays: 0 } });
      await emit({
        name: EVENTS.CERTIFICATION_EXPIRED,
        subject: { entityType: 'certification', entityId: cert.id, recordCode: cert.recordCode },
        newState: { expiresOn: cert.expiresOn },
        owner: { partyId: (personIdByEmployment.get(cert.employmentRelationshipId) ?? null) },
        impact: { domains: ['hr'] },
      });
      notified += 1;
      continue;
    }

    const rung = expiryRungReached(cert.expiresOn, now);
    if (!rung) continue;
    if (cert.lastExpiryRungDays != null && cert.lastExpiryRungDays <= rung.days) {
      skippedIdempotent += 1;
      continue;
    }

    await raiseException({
      code: 'CERTIFICATION_EXPIRING',
      label: `Certification expiring: ${cert.name}`,
      severity: rung.severity,
      subjectType: 'certification',
      subjectId: cert.id,
      subjectLabel: cert.recordCode,
      domain: 'hr',
      detail: `${cert.name} expires on ${cert.expiresOn.toISOString().slice(0, 10)} (${rung.days} days or fewer out).`,
      ownerPartyId: (personIdByEmployment.get(cert.employmentRelationshipId) ?? null),
      triggerFingerprint: 'expiring',
      ladderRung: rung.days,
    });
    await prisma.certification.update({ where: { id: cert.id }, data: { lastExpiryRungDays: rung.days } });
    await emit({
      name: EVENTS.CERTIFICATION_EXPIRING,
      subject: { entityType: 'certification', entityId: cert.id, recordCode: cert.recordCode },
      newState: { expiresOn: cert.expiresOn, rungDays: rung.days },
      owner: { partyId: (personIdByEmployment.get(cert.employmentRelationshipId) ?? null) },
      impact: { domains: ['hr'] },
    });
    notified += 1;
  }

  return { processed, notified, skippedIdempotent, errors: [] };
}

// ---------------------------------------------------------------------------
// Mandatory training
// ---------------------------------------------------------------------------

export async function listMandatoryRules() {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'view' });
  return prisma.mandatoryTrainingRule.findMany({
    where: { tenantId: auth.tenantId },
    include: { program: { select: { title: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createMandatoryRule(input: {
  programId: string;
  dueWithinDaysOfJoin?: number | null;
  recurrenceMonths?: number | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_programs', verb: 'create' });
  const program = await prisma.trainingProgram.findFirst({ where: { id: input.programId, tenantId: auth.tenantId } });
  if (!program) throw ApiError.notFound('Training program');
  return prisma.mandatoryTrainingRule.create({
    data: {
      tenantId: auth.tenantId,
      programId: input.programId,
      dueWithinDaysOfJoin: input.dueWithinDaysOfJoin ?? null,
      recurrenceMonths: input.recurrenceMonths ?? null,
    },
  });
}

export interface MandatoryComplianceRow {
  ruleId: string;
  programId: string;
  programTitle: string;
  employmentRelationshipId: string;
  dueDate: Date | null;
  overdue: boolean;
}

/** Every active employee against every active mandatory rule, with a due date and whether it has been missed. Auditable, so it needs an all-scope view. */
export async function mandatoryComplianceStatus(): Promise<MandatoryComplianceRow[]> {
  const auth = currentAuth();
  // Gated on `training_enrollments`, not `training_programs`: the programme
  // catalogue is deliberately company-wide (`view@all` even for `employee`),
  // but this reads every colleague's completion and overdue state, which is
  // the sensitive resource. `employee` holds `training_enrollments` at `own`
  // scope only, so this correctly bars them from the company-wide view.
  await assertScopeAll('training_enrollments');

  const [rules, employments] = await Promise.all([
    prisma.mandatoryTrainingRule.findMany({
      where: { tenantId: auth.tenantId, isActive: true },
      include: { program: { select: { title: true } } },
    }),
    prisma.employmentRelationship.findMany({
      where: { tenantId: auth.tenantId, status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
      select: { id: true, hireEffectiveDate: true },
    }),
  ]);
  if (rules.length === 0 || employments.length === 0) return [];

  const completions = await prisma.trainingEnrollment.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'completed',
      employmentRelationshipId: { in: employments.map((e) => e.id) },
      session: { programId: { in: rules.map((r) => r.programId) } },
    },
    select: { employmentRelationshipId: true, completedAt: true, session: { select: { programId: true } } },
    orderBy: { completedAt: 'desc' },
  });

  const latestByKey = new Map<string, Date>();
  for (const c of completions) {
    const key = `${c.employmentRelationshipId}:${c.session.programId}`;
    if (!latestByKey.has(key) && c.completedAt) latestByKey.set(key, c.completedAt);
  }

  const now = new Date();
  const rows: MandatoryComplianceRow[] = [];
  for (const rule of rules) {
    for (const emp of employments) {
      const key = `${emp.id}:${rule.programId}`;
      const lastCompleted = latestByKey.get(key);
      const dueDate = lastCompleted
        ? nextRecurrenceDue(lastCompleted, rule.recurrenceMonths)
        : mandatoryTrainingDueDate(emp.hireEffectiveDate, rule.dueWithinDaysOfJoin);
      // Completed with no recurrence configured: satisfied for good.
      if (lastCompleted && !rule.recurrenceMonths) continue;
      rows.push({
        ruleId: rule.id,
        programId: rule.programId,
        programTitle: rule.program.title,
        employmentRelationshipId: emp.id,
        dueDate,
        overdue: isMandatoryTrainingOverdue(dueDate, now),
      });
    }
  }
  return rows;
}

/** The overdue-mandatory-training job — one exception per overdue (employment, rule) pair, idempotent per calendar day. */
export async function runMandatoryTrainingOverdueCheck(): Promise<JobResult> {
  const auth = currentAuth();
  const rows = (await mandatoryComplianceStatus()).filter((r) => r.overdue);

  let notified = 0;
  for (const row of rows) {
    const employment = await prisma.employmentRelationship.findFirst({
      where: { id: row.employmentRelationshipId, tenantId: auth.tenantId },
      select: { personId: true },
    });
    await raiseException({
      code: 'MANDATORY_TRAINING_OVERDUE',
      label: `Mandatory training overdue: ${row.programTitle}`,
      severity: 'S2_WARNING',
      subjectType: 'employment_relationship',
      subjectId: row.employmentRelationshipId,
      domain: 'hr',
      detail: `${row.programTitle} was due ${row.dueDate?.toISOString().slice(0, 10) ?? 'unknown'} and has not been completed.`,
      ownerPartyId: employment?.personId ?? null,
      triggerFingerprint: `${row.ruleId}:${row.dueDate?.toISOString().slice(0, 10) ?? 'none'}`,
      ladderRung: 0,
    });
    notified += 1;
  }

  return { processed: rows.length, notified, skippedIdempotent: 0, errors: [] };
}

// ---------------------------------------------------------------------------
// Individual development plans
// ---------------------------------------------------------------------------

export async function listIdps(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'idps', verb: 'view' });

  let employmentFilter: string[] | undefined;
  if (employmentRelationshipId) {
    await assertEmploymentVisible('idps', employmentRelationshipId, 'view');
    employmentFilter = [employmentRelationshipId];
  } else {
    const scope = await scopeFor('idps', 'view');
    if (scope !== 'all') employmentFilter = await myEmploymentIds();
  }

  return prisma.individualDevelopmentPlan.findMany({
    where: { tenantId: auth.tenantId, ...(employmentFilter ? { employmentRelationshipId: { in: employmentFilter } } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createIdp(input: {
  employmentRelationshipId: string;
  goals: unknown;
  mentorId?: string | null;
  reviewDate?: Date | null;
}) {
  const auth = currentAuth();
  const employment = await employmentOrThrow(input.employmentRelationshipId);
  await assertCan({ resource: 'idps', verb: 'create', record: { ownerPartyId: employment.personId } });

  const idp = await prisma.individualDevelopmentPlan.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      goals: input.goals as never,
      mentorId: input.mentorId ?? null,
      reviewDate: input.reviewDate ?? null,
    },
  });

  await emit({
    name: EVENTS.IDP_UPDATED,
    subject: { entityType: 'idp', entityId: idp.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { status: 'active' },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return idp;
}

export async function updateIdp(id: string, input: { goals?: unknown; mentorId?: string | null; reviewDate?: Date | null; status?: 'active' | 'closed' }) {
  const auth = currentAuth();
  await assertCan({ resource: 'idps', verb: 'edit' });
  const idp = await prisma.individualDevelopmentPlan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!idp) throw ApiError.notFound('Individual development plan');

  // `edit@own` covers updating your own plan only — without this, any
  // own-scope holder could edit or close a colleague's IDP, since no record
  // was supplied to the `assertCan` above for the WHERE axis to narrow.
  const scope = await scopeFor('idps', 'edit');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({
      where: { id: idp.employmentRelationshipId, tenantId: auth.tenantId },
      select: { personId: true },
    });
    if (!employment || employment.personId !== auth.partyId) {
      throw ApiError.notFound('Individual development plan');
    }
  }

  const updated = await prisma.individualDevelopmentPlan.update({
    where: { id },
    data: {
      ...(input.goals !== undefined ? { goals: input.goals as never } : {}),
      ...(input.mentorId !== undefined ? { mentorId: input.mentorId } : {}),
      ...(input.reviewDate !== undefined ? { reviewDate: input.reviewDate } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });

  await emit({
    name: EVENTS.IDP_UPDATED,
    subject: { entityType: 'idp', entityId: id },
    previousState: { status: idp.status },
    newState: { status: updated.status },
    impact: { domains: ['hr'] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Training budgets
// ---------------------------------------------------------------------------

export async function listBudgets(fy?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_budgets', verb: 'view' });
  const budgets = await prisma.trainingBudget.findMany({
    where: { tenantId: auth.tenantId, ...(fy ? { fy } : {}) },
    orderBy: [{ fy: 'desc' }],
  });

  const spendByFy = new Map<string, number>();
  const distinctFys: string[] = [...new Set(budgets.map((b) => b.fy))];
  for (const fyLabel of distinctFys) {
    spendByFy.set(fyLabel, await trainingSpendForFy(fyLabel));
  }

  return budgets.map((b) => {
    const amount = num(b.amount) ?? 0;
    const spent = spendByFy.get(b.fy) ?? 0;
    return { ...b, spent, utilisationPercent: budgetUtilisationPercent(amount, spent) };
  });
}

/**
 * Spend for a financial year — the cost of every completed enrollment whose
 * session started in that FY. Not split by division: `TrainingBudget.division`
 * is recorded but there is no reliable employee→division join in this
 * workstream's own tables, so a division-scoped budget's `spent` is the whole
 * FY's spend rather than a fabricated division split. Recorded as a gap.
 */
async function trainingSpendForFy(fy: string): Promise<number> {
  const auth = currentAuth();
  const [startYear] = fy.replace(/^FY/i, '').split('-');
  const start = new Date(Date.UTC(Number(startYear), 3, 1));
  const end = new Date(Date.UTC(Number(startYear) + 1, 3, 1));

  const completed = await prisma.trainingEnrollment.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'completed',
      session: { startsAt: { gte: start, lt: end } },
    },
    include: { session: { select: { program: { select: { cost: true } } } } },
  });

  return completed.reduce((sum, e) => sum + (num(e.session.program.cost) ?? 0), 0);
}

export async function createBudget(input: { fy: string; division?: string | null; amount: number }) {
  const auth = currentAuth();
  await assertCan({ resource: 'training_budgets', verb: 'create' });
  return prisma.trainingBudget.create({
    data: { tenantId: auth.tenantId, fy: input.fy, division: input.division ?? null, amount: input.amount },
  });
}
