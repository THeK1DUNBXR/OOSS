/**
 * Commitments (Wave 6, OP:115; SPINE-CONTRACT 1.1; OPUS decision 9).
 *
 * A commitment is a promise one named person owns, due at a UTC instant. The
 * rules below each have a reason, and the tests in src/tests/commitments.test.ts
 * are the check that they hold:
 *   - Only a human confirms. A proposal from a model or from a job stays
 *     `proposed` until a person confirms it. The model can put a promise in
 *     front of a person; it cannot make the company answer for one.
 *   - The backup is never the owner. A backup who is also the owner covers
 *     nothing, and the owner's absence is exactly the case a backup is for.
 *   - A state moves only along COMMITMENT_TRANSITIONS. An illegal move is a 409
 *     and leaves the row and its history as they were.
 *   - A move is one conditional update on the state and owner it was read
 *     with. Two concurrent moves cannot both win, and the loser is a 409.
 *   - Every write is governed: assertCan, the row and its CommitmentEvent,
 *     auditWrite, emit, all in one transaction. A row that changed without its
 *     event, or an event with no row, is the gap governedWrite exists to close.
 */

import type { Commitment } from '@prisma/client';
import { EVENTS } from '@kaizen/shared';
import { prisma, Prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { governedWrite } from '../platform/governedWrite.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { lockAssignableParty } from './ownership.js';

registerGovernedEntities('gov', ['commitment']);

export const COMMITMENT_STATES = ['proposed', 'confirmed', 'met', 'missed', 'cancelled'] as const;
export type CommitmentState = (typeof COMMITMENT_STATES)[number];

/**
 * `missed` is reachable from `confirmed` by the job or by a person, and may
 * still become `met` afterwards: a promise kept two days late is kept. Nothing
 * leaves `met` or `cancelled`, so a closed record stays closed.
 */
export const COMMITMENT_TRANSITIONS: Record<CommitmentState, readonly CommitmentState[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['met', 'missed', 'cancelled'],
  missed: ['met', 'cancelled'],
  met: [],
  cancelled: [],
};

/**
 * Where the owner still has to act. `missed` is open, because it can still become
 * `met`; only `met` and `cancelled` close a promise, as reassignCommitment refuses them.
 */
export const OPEN_COMMITMENT_STATES: readonly CommitmentState[] = ['proposed', 'confirmed', 'missed'];

/** Where a promise came from. A model's suggestion is `agent`, whatever the sourceId. */
export const COMMITMENT_SOURCE_TYPES = ['manual', 'agent', 'decision', 'exception', 'interaction'] as const;
export type CommitmentSourceType = (typeof COMMITMENT_SOURCE_TYPES)[number];

const EVENT_FOR: Record<CommitmentState, string> = {
  proposed: EVENTS.COMMITMENT_PROPOSED,
  confirmed: EVENTS.COMMITMENT_CONFIRMED,
  met: EVENTS.COMMITMENT_MET,
  missed: EVENTS.COMMITMENT_MISSED,
  cancelled: EVENTS.COMMITMENT_CANCELLED,
};

export interface ProposeCommitmentInput {
  title: string;
  ownerPartyId: string;
  backupPartyId?: string | null;
  nextAction?: string | null;
  dueAt: Date;
  sourceType: CommitmentSourceType;
  sourceId?: string | null;
  subjectType: string;
  subjectId: string;
}

export interface CommitmentFilter {
  state?: CommitmentState;
  ownerPartyId?: string;
  page?: number;
  pageSize?: number;
}

/** One state change, or a reassignment (`to` equals the state it starts from). */
interface Change {
  row: Commitment;
  to: CommitmentState;
  eventName: string;
  data?: Prisma.CommitmentUncheckedUpdateManyInput;
  /** Set on a reassignment, so the new owner is locked and checked before the row moves. */
  newOwnerPartyId?: string;
  reason: string | null;
  /** The job's guard: a row moves only if its due instant is before this. */
  dueBefore?: Date;
  /** The caller's transaction, for a handover that writes inside the exit's. Absent, the write opens its own. */
  tx?: DbTx;
}

export async function proposeCommitment(input: ProposeCommitmentInput): Promise<Commitment> {
  const auth = currentAuth();
  await assertCan({ resource: 'commitments', verb: 'edit' });

  const backup = input.backupPartyId ?? null;
  assertOwnerIsNotBackup(input.ownerPartyId, backup);
  await assertPersonInTenant(input.ownerPartyId);
  if (backup) await assertPersonInTenant(backup);

  return governedWrite(async (tx) => {
    await lockAssignableParty(tx, auth.tenantId, input.ownerPartyId);
    const recordCode = await nextRecordCode('CMT', new Date(), tx);
    const row = await tx.commitment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        title: input.title,
        nextAction: input.nextAction ?? null,
        ownerPartyId: input.ownerPartyId,
        backupPartyId: backup,
        dueAt: input.dueAt,
        state: 'proposed',
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    });
    await tx.commitmentEvent.create({
      data: {
        tenantId: auth.tenantId,
        commitmentId: row.id,
        fromState: null,
        toState: 'proposed',
        actorPartyId: auth.partyId ?? null,
      },
    });
    await auditWrite({ action: 'create', subjectType: 'commitment', subjectId: row.id, after: row, tx });
    await emit({
      name: EVENTS.COMMITMENT_PROPOSED,
      subject: { entityType: 'commitment', entityId: row.id, recordCode },
      newState: { state: 'proposed', ownerPartyId: row.ownerPartyId, dueAt: row.dueAt.toISOString() },
      owner: { partyId: row.ownerPartyId },
      tx,
    });
    return row;
  });
}

/**
 * Only a human confirms. The check is on the principal, before the permission
 * check: an agent or a job is refused for being the wrong kind of caller, which
 * is a different answer from one that lacks a grant.
 */
export async function confirmCommitment(id: string): Promise<Commitment> {
  const auth = currentAuth();
  if (auth.principalType !== 'human' || !auth.partyId) {
    throw ApiError.forbidden(
      'Only a named person can confirm a commitment. A proposal from a model or a scheduled job stays proposed until a human confirms it.',
      [{ axis: 'WHO', passed: false, reason: 'non_human_principal' }],
    );
  }
  await assertCan({ resource: 'commitments', verb: 'edit' });
  const row = await loadOrNotFound(id);
  refuseIllegal(row.state, 'confirmed');
  return unwrap(
    await applyChange({
      row,
      to: 'confirmed',
      eventName: EVENTS.COMMITMENT_CONFIRMED,
      data: { confirmedById: auth.partyId, confirmedAt: new Date() },
      reason: null,
    }),
  );
}

export function markCommitmentMet(id: string, reason: string | null = null): Promise<Commitment> {
  return humanMove(id, 'met', reason);
}

export function markCommitmentMissed(id: string, reason: string | null = null): Promise<Commitment> {
  return humanMove(id, 'missed', reason);
}

/** Cancelling is a decision, so it says why; the reason is what an auditor asks for first. */
export function cancelCommitment(id: string, reason: string): Promise<Commitment> {
  if (!reason.trim()) throw ApiError.badRequest('A cancellation needs a reason.');
  return humanMove(id, 'cancelled', reason.trim());
}

export async function reassignCommitment(
  id: string,
  ownerPartyId: string,
  reason: string | null = null,
): Promise<Commitment> {
  await assertCan({ resource: 'commitments', verb: 'edit' });
  const row = await loadOrNotFound(id);
  if (row.state === 'met' || row.state === 'cancelled') {
    throw ApiError.conflict(`A ${row.state} commitment cannot be reassigned.`, { state: row.state });
  }
  if (ownerPartyId === row.ownerPartyId) {
    throw ApiError.unprocessable('That person already owns this commitment.');
  }
  assertOwnerIsNotBackup(ownerPartyId, row.backupPartyId);
  await assertPersonInTenant(ownerPartyId);

  // The new owner goes into the event's reason, because the event has no owner
  // column. The audit row carries the exact before and after.
  const note = `owner ${row.ownerPartyId} -> ${ownerPartyId}${reason ? `: ${reason}` : ''}`;
  return unwrap(
    await applyChange({
      row,
      to: row.state as CommitmentState,
      eventName: EVENTS.COMMITMENT_REASSIGNED,
      data: { ownerPartyId },
      newOwnerPartyId: ownerPartyId,
      reason: note,
    }),
  );
}

/** The grant a handover needs for commitments. Checked outside the exit's transaction, as every grant check here is. */
export async function authoriseCommitmentHandover(): Promise<void> {
  await assertCan({ resource: 'commitments', verb: 'edit' });
}

/**
 * The exit handover's write for one open commitment, inside the exit's transaction:
 * the row, its CommitmentEvent, the audit row and the event, the same governed
 * path as a reassignment made by a person. The caller has locked the row and
 * checked the grant.
 */
export async function handOverCommitmentInTx(
  tx: DbTx,
  row: Commitment,
  successorPartyId: string,
  reason: string,
): Promise<Commitment> {
  assertOwnerIsNotBackup(successorPartyId, row.backupPartyId);
  const note = `owner ${row.ownerPartyId} -> ${successorPartyId}: ${reason}`;
  return unwrap(
    await applyChange({
      row,
      to: row.state as CommitmentState,
      eventName: EVENTS.COMMITMENT_REASSIGNED,
      data: { ownerPartyId: successorPartyId },
      newOwnerPartyId: successorPartyId,
      reason: note,
      tx,
    }),
  );
}

export async function listCommitments(filter: CommitmentFilter = {}): Promise<Commitment[]> {
  await assertCan({ resource: 'commitments', verb: 'view' });
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
  const page = Math.max(filter.page ?? 1, 1);
  return prisma.commitment.findMany({
    where: {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
}

export async function getCommitment(id: string) {
  await assertCan({ resource: 'commitments', verb: 'view' });
  const row = await prisma.commitment.findFirst({
    where: { id },
    include: { events: { orderBy: { at: 'asc' } } },
  });
  if (!row) throw ApiError.notFound('Commitment');
  return row;
}

/**
 * The job's move: a confirmed commitment whose due instant has passed becomes
 * missed. Returns false when there is nothing to do, which is the normal case on
 * a rerun, so a second pass over the same data writes nothing.
 */
export async function markCommitmentMissedIfDue(id: string, now: Date): Promise<boolean> {
  await assertCan({ resource: 'commitments', verb: 'edit' });
  const row = await prisma.commitment.findFirst({ where: { id } });
  if (!row || row.state !== 'confirmed') return false;
  const moved = await applyChange({
    row,
    to: 'missed',
    eventName: EVENTS.COMMITMENT_MISSED,
    reason: 'The due instant passed while the commitment was confirmed.',
    dueBefore: now,
  });
  return moved !== null;
}

async function humanMove(id: string, to: CommitmentState, reason: string | null): Promise<Commitment> {
  await assertCan({ resource: 'commitments', verb: 'edit' });
  const row = await loadOrNotFound(id);
  refuseIllegal(row.state, to);
  return unwrap(await applyChange({ row, to, eventName: EVENT_FOR[to], reason }));
}

/**
 * Writes one change: the row, its CommitmentEvent, the audit row and the event.
 * The update is conditional on the state and owner the caller read, and on the
 * due instant when the job is the caller. A conditional update that matches no
 * row is a concurrent change (a 409 for a person) or a rerun (nothing to do for
 * the job), so the two callers get different answers.
 */
async function applyChange(change: Change): Promise<Commitment | null> {
  const { row, to, eventName, data = {}, newOwnerPartyId, reason, dueBefore, tx: outer } = change;
  const auth = currentAuth();
  const actorPartyId = auth.partyId ?? null;

  const work = async (tx: DbTx): Promise<Commitment | null> => {
    if (newOwnerPartyId !== undefined) await lockAssignableParty(tx, auth.tenantId, newOwnerPartyId);
    const { count } = await tx.commitment.updateMany({
      where: {
        id: row.id,
        state: row.state,
        ownerPartyId: row.ownerPartyId,
        ...(dueBefore ? { dueAt: { lt: dueBefore } } : {}),
      },
      data: { ...data, state: to },
    });
    if (count !== 1) {
      if (dueBefore) return null;
      throw ApiError.conflict('The commitment changed while this was being recorded. Reload it and try again.');
    }

    const after = await tx.commitment.findUniqueOrThrow({ where: { id: row.id } });
    await tx.commitmentEvent.create({
      data: {
        tenantId: auth.tenantId,
        commitmentId: row.id,
        fromState: row.state,
        toState: to,
        actorPartyId,
        reason,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'commitment',
      subjectId: row.id,
      before: { state: row.state, ownerPartyId: row.ownerPartyId },
      after: {
        state: after.state,
        ownerPartyId: after.ownerPartyId,
        confirmedById: after.confirmedById,
        confirmedAt: after.confirmedAt?.toISOString() ?? null,
      },
      meta: reason ? { reason } : undefined,
      tx,
    });
    await emit({
      name: eventName,
      subject: { entityType: 'commitment', entityId: row.id, recordCode: row.recordCode },
      previousState: { state: row.state, ownerPartyId: row.ownerPartyId },
      newState: { state: after.state, ownerPartyId: after.ownerPartyId },
      owner: { partyId: after.ownerPartyId },
      reason: reason ? { reasonCode: to, note: reason } : null,
      tx,
    });
    return after;
  };
  return outer ? work(outer) : governedWrite(work);
}

async function loadOrNotFound(id: string): Promise<Commitment> {
  const row = await prisma.commitment.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Commitment');
  return row;
}

function refuseIllegal(from: string, to: CommitmentState): void {
  const allowed = COMMITMENT_TRANSITIONS[from as CommitmentState] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.conflict(`A ${from} commitment cannot become ${to}.`, { from, to });
  }
}

function unwrap(row: Commitment | null): Commitment {
  if (row === null)
    throw ApiError.conflict('The commitment changed while this was being recorded. Reload it and try again.');
  return row;
}

function assertOwnerIsNotBackup(ownerPartyId: string, backupPartyId: string | null): void {
  if (backupPartyId !== null && backupPartyId === ownerPartyId) {
    throw ApiError.unprocessable(
      'The backup cannot be the owner. A backup who is also the owner covers nothing, and the owner being away is the case a backup exists for.',
    );
  }
}

/**
 * The tenant-scoped client finds only this tenant's people, so a person from
 * another tenant reads as absent. The composite foreign key on the row is the
 * database's own refusal of the same thing.
 */
async function assertPersonInTenant(partyId: string): Promise<void> {
  const person = await prisma.person.findFirst({ where: { id: partyId, deletedAt: null }, select: { id: true } });
  if (!person) throw ApiError.notFound('Person');
}
