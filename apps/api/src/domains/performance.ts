/**
 * Performance and growth (Canon §14.2, §14.4 rows 14 and 20, §14.7).
 *
 * There is deliberately no PERFORMANCE_REVIEW entity. A review is a reading of
 * the evidence at a moment, not a record that replaces it — so what is stored
 * is the evidence, append-only, and a review is something a manager does with
 * it rather than a row that supersedes it.
 *
 * The one visibility rule that genuinely bites is here: ICC and disciplinary
 * evidence is case-scoped. It is withheld from the line manager by default and
 * from the chairman by seniority, and reaching it takes a grant on
 * `performance_evidence` — need-to-know is something you hold, not something
 * your rank implies.
 */

import {
  EVENTS,
  goalMachine,
  GOAL_EVENT_VERB,
  PERFORMANCE_EVIDENCE_KINDS,
  type GoalState,
  type GoalEvent,
  type PerformanceEvidenceKind,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, can } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { auditRegulatedRead } from '../platform/audit.js';
import { claimFromLearningCompletion } from './capability.js';

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export async function listGoals(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'goals', verb: 'view' });
  return prisma.goal.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createGoal(input: {
  employmentRelationshipId: string;
  description: string;
  keyResultRef?: string | null;
  periodLabel?: string | null;
  dueAt?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'goals', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const goal = await prisma.goal.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      description: input.description,
      keyResultRef: input.keyResultRef ?? null,
      periodLabel: input.periodLabel ?? null,
      dueAt: input.dueAt ?? null,
    },
  });

  await emit({
    name: EVENTS.GOAL_CREATED,
    subject: { entityType: 'goal', entityId: goal.id },
    related: [
      { relation: 'held_by', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
    ],
    newState: { status: 'Draft', description: input.description, keyResultRef: input.keyResultRef },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return goal;
}

export async function transitionGoal(id: string, event: GoalEvent, note?: string) {
  const auth = currentAuth();
  const goal = await prisma.goal.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!goal) throw ApiError.notFound('Goal');

  const result = await transition({
    machine: goalMachine,
    eventObject: 'goal',
    verbs: GOAL_EVENT_VERB,
    resource: 'goals',
    subjectType: 'goal',
    subjectId: id,
    ownerPartyId: goal.employmentRelationship.personId,
    from: goal.status as GoalState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.goal.update({ where: { id }, data: { status: result.to } });
}

// ---------------------------------------------------------------------------
// Performance evidence
// ---------------------------------------------------------------------------

/**
 * Evidence for one person, with case-scoped rows filtered out unless the
 * viewer holds the grant that carries need-to-know.
 *
 * The filter is applied in the query rather than after it: a caller who cannot
 * see case-scoped evidence should not receive it and discard it, because that
 * is the shape of bug that leaks through a log line or an error message.
 */
export async function listEvidence(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'goals', verb: 'view' });

  const maySeeCases = await can({ resource: 'performance_evidence', verb: 'view' });

  const rows = await prisma.performanceEvidence.findMany({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      ...(maySeeCases ? {} : { caseScoped: false }),
    },
    orderBy: { createdAt: 'desc' },
  });

  // Reading a disciplinary record is itself an event worth recording.
  if (maySeeCases && rows.some((row) => row.caseScoped)) {
    await auditRegulatedRead('performance_evidence', employmentRelationshipId, ['caseScoped']);
  }

  return rows;
}

export async function recordEvidence(input: {
  employmentRelationshipId: string;
  kind: PerformanceEvidenceKind;
  description: string;
  caseScoped?: boolean;
  caseRef?: string | null;
}) {
  const auth = currentAuth();

  if (!PERFORMANCE_EVIDENCE_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(
      `"${input.kind}" is not a kind of performance evidence. Expected one of: ${PERFORMANCE_EVIDENCE_KINDS.join(', ')}.`,
    );
  }

  // Writing into a case needs the case grant, not merely the goals grant —
  // otherwise anybody who could leave a manager note could open a disciplinary
  // record against somebody.
  await assertCan({ resource: input.caseScoped ? 'performance_evidence' : 'goals', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const evidence = await prisma.performanceEvidence.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      kind: input.kind,
      description: input.description,
      recordedByPartyId: auth.partyId,
      caseScoped: input.caseScoped ?? false,
      caseRef: input.caseRef ?? null,
    },
  });

  await emit({
    name: EVENTS.PERFORMANCE_EVIDENCE_RECORDED,
    subject: { entityType: 'performance_evidence', entityId: evidence.id },
    related: [
      { relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
    ],
    // The description is deliberately not in the event body. A case-scoped
    // note would otherwise be readable by anyone who can read the event log,
    // which is a wider audience than the case.
    newState: { kind: input.kind, caseScoped: evidence.caseScoped },
    owner: { partyId: employment.personId },
    confidentiality: evidence.caseScoped ? 'restricted' : 'internal',
    impact: { domains: ['hr'] },
  });

  return evidence;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export async function listLearningActivities() {
  const auth = currentAuth();
  await assertCan({ resource: 'learning', verb: 'view' });
  return prisma.learningActivity.findMany({ where: { tenantId: auth.tenantId }, orderBy: { title: 'asc' } });
}

export async function createLearningActivity(input: {
  title: string;
  isCompliance?: boolean;
  cost?: number;
  courseId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'learning', verb: 'create' });
  return prisma.learningActivity.create({
    data: {
      tenantId: auth.tenantId,
      title: input.title,
      isCompliance: input.isCompliance ?? false,
      cost: input.cost ?? 0,
      courseId: input.courseId ?? null,
    },
  });
}

export async function enrolInLearning(input: { employmentRelationshipId: string; learningActivityId: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'learning', verb: 'create' });

  const record = await prisma.learningRecord.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      learningActivityId: input.learningActivityId,
    },
  });

  await emit({
    name: EVENTS.LEARNING_RECORD_ENROLLED,
    subject: { entityType: 'learning_record', entityId: record.id },
    newState: { status: 'Enrolled', learningActivityId: input.learningActivityId },
    impact: { domains: ['hr'] },
  });

  return record;
}

/**
 * Completing a course. If the activity maps to a skill, this also asserts a
 * capability claim — capped at Assessed, per §14.6.4, and never higher.
 */
export async function completeLearning(id: string, input: { skillId?: string | null } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'learning', verb: 'edit' });

  const record = await prisma.learningRecord.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true, learningActivity: true },
  });
  if (!record) throw ApiError.notFound('Learning record');
  if (record.status === 'Completed') return record;

  const updated = await prisma.learningRecord.update({
    where: { id },
    data: { status: 'Completed', completedAt: new Date() },
  });

  await emit({
    name: EVENTS.LEARNING_RECORD_COMPLETED,
    subject: { entityType: 'learning_record', entityId: id },
    previousState: { status: record.status },
    newState: { status: 'Completed', isCompliance: record.learningActivity.isCompliance },
    owner: { partyId: record.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  if (input.skillId) {
    await claimFromLearningCompletion({
      partyId: record.employmentRelationship.personId,
      skillId: input.skillId,
      learningRecordId: id,
    });
  }

  return updated;
}

/** Compliance training that has not been completed — an audit exposure. */
export async function outstandingCompliance() {
  const auth = currentAuth();
  await assertCan({ resource: 'learning', verb: 'view' });

  return prisma.learningRecord.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { not: 'Completed' },
      learningActivity: { isCompliance: true },
      employmentRelationship: { status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
    },
    include: {
      learningActivity: { select: { title: true } },
      employmentRelationship: {
        select: { id: true, recordCode: true, person: { select: { fullName: true } } },
      },
    },
    take: 200,
  });
}
