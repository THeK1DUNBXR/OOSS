/**
 * Tasks. Created either as a side effect of an interaction's next action
 * (domains/interactions.ts, kind manual) or by createTask below, which names the
 * row a task is about (TASK_SOURCE_KINDS). Closing a task is a state change
 * someone is accountable for, so it goes through the same governance as every
 * other write: permitted, audited, emitted.
 */

import type { Task } from '@prisma/client';
import { EVENTS, TASK_SOURCE_KINDS, type TaskSourceKind } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';
import { assertCan } from '../platform/permissions.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';

export interface CreateTaskInput {
  title: string;
  ownerPartyId: string;
  assigneePartyId?: string | null;
  dueAt?: Date | null;
  sourceKind: TaskSourceKind;
  sourceId?: string | null;
}

/**
 * Creates a task that says what it is about. The source is checked before the
 * transaction opens, so a refused task takes no record code and writes no row.
 * The check runs inside the caller's tenant; a row from another tenant is then
 * indistinguishable from a row that does not exist (assertTaskSource).
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const auth = currentAuth();
  await assertCan({ resource: 'tasks', verb: 'create' });

  const sourceId = input.sourceId ?? null;
  await assertTaskSource(input.sourceKind, sourceId);

  return governedWrite(async (tx) => {
    const recordCode = await nextRecordCode('TSK', undefined, tx);
    const task = await tx.task.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        title: input.title,
        ownerPartyId: input.ownerPartyId,
        assigneePartyId: input.assigneePartyId ?? input.ownerPartyId,
        dueAt: input.dueAt ?? null,
        sourceKind: input.sourceKind,
        sourceId,
        createdById: auth.partyId ?? null,
      },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'task',
      subjectId: task.id,
      after: { recordCode, title: input.title, sourceKind: input.sourceKind, sourceId },
      tx,
    });

    await emit({
      name: EVENTS.TASK_CREATED,
      subject: { entityType: 'task', entityId: task.id, recordCode },
      newState: { title: input.title, dueAt: input.dueAt ?? null, sourceKind: input.sourceKind, sourceId },
      tx,
    });

    return task;
  });
}

type TypedSourceKind = Exclude<TaskSourceKind, 'manual'>;

/**
 * One lookup per typed kind, each scoped to the caller's tenant by the explicit
 * tenantId and again by the client extension. There is no foreign key to lean on:
 * the target table is chosen by the kind, which Postgres cannot express.
 */
const SOURCE_EXISTS: Record<TypedSourceKind, (id: string, tenantId: string) => Promise<unknown>> = {
  commitment: (id, tenantId) => prisma.commitment.findFirst({ where: { id, tenantId }, select: { id: true } }),
  case: (id, tenantId) => prisma.case.findFirst({ where: { id, tenantId }, select: { id: true } }),
  decision: (id, tenantId) => prisma.decision.findFirst({ where: { id, tenantId }, select: { id: true } }),
  exception: (id, tenantId) => prisma.exceptionRecord.findFirst({ where: { id, tenantId }, select: { id: true } }),
  onboarding_task: (id, tenantId) => prisma.onboardingTask.findFirst({ where: { id, tenantId }, select: { id: true } }),
};

/**
 * Every refusal here is a 422: the request is well formed, and the source it names
 * is not one this tenant holds. A missing row and another tenant's row get the same
 * message on purpose. Telling them apart would let a caller in one tenant learn
 * which record ids exist in another.
 */
export async function assertTaskSource(kind: string, sourceId: string | null): Promise<void> {
  if (!(TASK_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw ApiError.unprocessable(`Task source kind "${kind}" is not in the registry.`);
  }

  if (kind === 'manual') {
    if (sourceId !== null) throw ApiError.unprocessable('A manual task names no source row.');
    return;
  }

  if (!sourceId) throw ApiError.unprocessable(`A ${kind} task must name its source row.`);

  const found = await SOURCE_EXISTS[kind as TypedSourceKind](sourceId, currentAuth().tenantId);
  if (!found) throw ApiError.unprocessable(`${kind} ${sourceId} does not exist in this tenant.`);
}

export async function completeTask(id: string) {
  await assertCan({ resource: 'tasks', verb: 'edit' });

  // A deleted task is not closed; it is gone from the caller's view, and
  // closing it would write an audit row for a record nobody can see.
  const before = await prisma.task.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw ApiError.notFound('Task');

  // The edit verb is held with a scope. Checked against the task's own owner,
  // so an own-scoped editor cannot close someone else's task. Done after the
  // lookup because the owner is a property of the record being checked.
  await assertCan({
    resource: 'tasks',
    verb: 'edit',
    record: { ownerPartyId: before.ownerPartyId, assigneePartyId: before.assigneePartyId },
  });

  // Conditional on status, so a second completion matches no row. A
  // find-then-update let a repeat call re-stamp completedAt and emit the
  // completion event again, so downstream counted a task twice.
  // The transition, its audit row and its event commit together: a task closed
  // with no record of who closed it is the gap governedWrite exists to close.
  return governedWrite(async (tx) => {
    const completedAt = new Date();
    const { count } = await tx.task.updateMany({
      where: { id, deletedAt: null, status: { not: 'done' } },
      data: { status: 'done', completedAt },
    });
    if (count !== 1) throw ApiError.conflict('Task is already completed.');

    // Ownership is not changed by completing. Closing a task does not make the
    // closer its owner: the owner is who the work belongs to, and a silent
    // reassignment is an unaudited change of accountability.
    const task = await tx.task.findUniqueOrThrow({ where: { id } });

    await auditWrite({
      action: 'update',
      subjectType: 'task',
      subjectId: id,
      before: { status: before.status },
      after: { status: 'done', completedAt: completedAt.toISOString() },
      tx,
    });

    await emit({
      name: EVENTS.TASK_COMPLETED,
      subject: { entityType: 'task', entityId: id, recordCode: task.recordCode },
      newState: { status: 'done', completedAt: completedAt.toISOString() },
      tx,
    });

    return task;
  });
}
