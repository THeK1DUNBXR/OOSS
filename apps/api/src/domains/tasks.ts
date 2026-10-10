/**
 * Tasks. Created as a side effect of an interaction's next action
 * (domains/interactions.ts), and closed here. Closing a task is a state change
 * someone is accountable for, so it goes through the same governance as every
 * other write: permitted, audited, emitted.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';

export async function completeTask(id: string) {
  await assertCan({ resource: 'tasks', verb: 'edit' });
  const auth = currentAuth();

  // A deleted task is not closed; it is gone from the caller's view, and
  // closing it would write an audit row for a record nobody can see.
  const before = await prisma.task.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw ApiError.notFound('Task');

  const completedAt = new Date();
  const task = await prisma.task.update({
    where: { id },
    data: { status: 'done', completedAt, ownerPartyId: auth.partyId },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'task',
    subjectId: id,
    before: { status: before.status },
    after: { status: 'done', completedAt: completedAt.toISOString() },
  });

  await emit({
    name: EVENTS.TASK_COMPLETED,
    subject: { entityType: 'task', entityId: id, recordCode: task.recordCode },
    newState: { status: 'done', completedAt: completedAt.toISOString(), ownerPartyId: auth.partyId },
  });

  return task;
}
