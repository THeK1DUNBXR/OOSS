/**
 * Tasks. Created as a side effect of an interaction's next action
 * (domains/interactions.ts), and closed here. Closing a task is a state change
 * someone is accountable for, so it goes through the same governance as every
 * other write: permitted, audited, emitted.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';

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
