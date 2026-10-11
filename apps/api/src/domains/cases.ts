/**
 * Cases (Wave 6, OP:116; SPINE-CONTRACT 1.2; OPUS decision 2).
 *
 * A case is a customer, learner or complaint matter one named person owns, due
 * at a UTC instant. The rules below each have a reason, and the tests in
 * src/tests/cases.test.ts are the check that they hold:
 *   - Silence never acknowledges. A case past its response due instant with no
 *     acknowledgement is flagged overdue by the job, which leaves it open. Only a
 *     named person acknowledges, and the job cannot.
 *   - A case raises at most one exception. The exception is the consequence of
 *     the case and carries the case's owner and severity; the case is what a
 *     person works, and a second raise would fork that work across two rows.
 *   - Visibility is the WHAT axis. A case's tier is a SensitivityClass, and a
 *     caller whose classification ceiling does not clear it gets 404 on the case,
 *     the same as for a case that does not exist: the list omits it, and a
 *     command on it finds nothing.
 *   - The backup is never the owner. A backup who is also the owner covers nothing.
 *   - A state moves only along CASE_TRANSITIONS. An illegal move is a 409 and
 *     leaves the row and its history as they were.
 *   - A move is one conditional update on the state it was read with. Two
 *     concurrent moves cannot both win, and the loser is a 409.
 *   - Every write is governed: assertCan, the row and its CaseEvent, auditWrite,
 *     emit, all in one transaction.
 */

import type { Case, ExceptionRecord } from '@prisma/client';
import {
  EVENTS,
  SENSITIVITY_CLASSES,
  SENSITIVITY_RANK,
  type SensitivityClass,
  type SeverityCode,
} from '@kaizen/shared';
import { prisma, Prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { assertCan, can, visibilityWhere } from '../platform/permissions.js';
import { governedWrite } from '../platform/governedWrite.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { raiseException } from '../platform/exceptions.js';
import { ApiError } from '../platform/errors.js';
import { lockAssignableParty } from './ownership.js';

registerGovernedEntities('gov', ['case']);

export const CASE_KINDS = ['customer', 'learner', 'complaint'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_STATES = ['open', 'acknowledged', 'resolved', 'closed', 'withdrawn'] as const;
export type CaseState = (typeof CASE_STATES)[number];

/**
 * `resolved` only closes: a resolution is not reopened, because a dispute that
 * comes back is a new case with its own response clock. `withdrawn` is reachable
 * only before resolution, since a case already resolved has been answered.
 */
export const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  open: ['acknowledged', 'withdrawn'],
  acknowledged: ['resolved', 'withdrawn'],
  resolved: ['closed'],
  closed: [],
  withdrawn: [],
};

/**
 * The exception code a case raises. Its severity is the case's own severity, not
 * a fixed one for the code: how bad the matter is belongs to the case.
 */
export const CASE_EXCEPTION_CODE = 'EX-CASE-001';
const CASE_EXCEPTION_LABEL = 'Customer case raised as an exception';

/** States from which a case may raise its exception. A case already withdrawn, resolved or closed raises nothing. */
const RAISABLE_FROM: readonly CaseState[] = ['open', 'acknowledged'];

const EVENT_FOR: Partial<Record<CaseState, string>> = {
  acknowledged: EVENTS.CASE_ACKNOWLEDGED,
  resolved: EVENTS.CASE_RESOLVED,
  closed: EVENTS.CASE_CLOSED,
  withdrawn: EVENTS.CASE_WITHDRAWN,
};

export interface OpenCaseInput {
  kind: CaseKind;
  title: string;
  description?: string | null;
  ownerPartyId: string;
  backupPartyId?: string | null;
  responseDueAt: Date;
  visibilityTier: SensitivityClass;
  severity: SeverityCode;
  lineId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Paise. A JavaScript number never reaches here: the route parses the wire string into bigint. */
  remedyAmountMinor?: bigint | null;
}

export interface CaseFilter {
  state?: CaseState;
  ownerPartyId?: string;
  page?: number;
  pageSize?: number;
}

/** One state change, or the overdue flag (`to` equals the state it starts from). */
interface Change {
  row: Case;
  to: CaseState;
  eventName: string;
  data?: Prisma.CaseUncheckedUpdateManyInput;
  /** Set on a reassignment, so the new owner is locked and checked before the row moves. */
  newOwnerPartyId?: string;
  reason: string | null;
  /** The caller's transaction, for a handover that writes inside the exit's. Absent, the write opens its own. */
  tx?: DbTx;
}

export async function openCase(input: OpenCaseInput): Promise<Case> {
  const auth = currentAuth();
  await assertCan({ resource: 'cases', verb: 'edit' });

  const backup = input.backupPartyId ?? null;
  assertOwnerIsNotBackup(input.ownerPartyId, backup);
  assertSubjectPaired(input.subjectType ?? null, input.subjectId ?? null);
  assertRemedyNonNegative(input.remedyAmountMinor ?? null);
  await assertPersonInTenant(input.ownerPartyId);
  if (backup) await assertPersonInTenant(backup);

  return governedWrite(async (tx) => {
    await lockAssignableParty(tx, auth.tenantId, input.ownerPartyId);
    const recordCode = await nextRecordCode('CAS', new Date(), tx);
    const row = await tx.case.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        ownerPartyId: input.ownerPartyId,
        backupPartyId: backup,
        responseDueAt: input.responseDueAt,
        state: 'open',
        visibilityTier: input.visibilityTier,
        severity: input.severity,
        lineId: input.lineId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        remedyAmountMinor: input.remedyAmountMinor ?? null,
      },
    });
    await tx.caseEvent.create({
      data: {
        tenantId: auth.tenantId,
        caseId: row.id,
        fromState: null,
        toState: 'open',
        actorPartyId: auth.partyId ?? null,
      },
    });
    await auditWrite({ action: 'create', subjectType: 'case', subjectId: row.id, after: row, tx });
    await emit({
      name: EVENTS.CASE_OPENED,
      subject: { entityType: 'case', entityId: row.id, recordCode },
      newState: { state: 'open', ownerPartyId: row.ownerPartyId, responseDueAt: row.responseDueAt.toISOString() },
      owner: { partyId: row.ownerPartyId },
      severity: input.severity,
      tx,
    });
    return row;
  });
}

/**
 * Only a named person acknowledges. The check is on the principal, before the
 * permission check, as for a commitment's confirmation: a system job or a model
 * is refused for being the wrong kind of caller, which is a different answer from
 * one that lacks a grant. This is the rule that keeps silence from becoming an
 * acknowledgement.
 */
export async function acknowledgeCase(id: string): Promise<Case> {
  const auth = currentAuth();
  if (auth.principalType !== 'human' || !auth.partyId) {
    throw ApiError.forbidden(
      'Only a named person can acknowledge a case. A scheduled job or a model cannot, and a case nobody has acknowledged stays open.',
      [{ axis: 'WHO', passed: false, reason: 'non_human_principal' }],
    );
  }
  const row = await loadForCommand(id, 'edit');
  refuseIllegal(row.state, 'acknowledged');
  return unwrap(
    await applyChange({
      row,
      to: 'acknowledged',
      eventName: EVENTS.CASE_ACKNOWLEDGED,
      data: { acknowledgedById: auth.partyId, acknowledgedAt: new Date() },
      reason: null,
    }),
  );
}

export function resolveCase(id: string, reason: string | null = null): Promise<Case> {
  return humanMove(id, 'resolved', reason);
}

export function closeCase(id: string, reason: string | null = null): Promise<Case> {
  return humanMove(id, 'closed', reason);
}

/** Withdrawing is a decision, so it says why; the reason is what an auditor asks for first. */
export function withdrawCase(id: string, reason: string): Promise<Case> {
  if (!reason.trim()) throw ApiError.badRequest('A withdrawal needs a reason.');
  return humanMove(id, 'withdrawn', reason.trim());
}

/**
 * Raises the case's one exception, in the same transaction as the link that
 * records it. The row lock below makes a second raise wait for the first and
 * then see its link, so the answer is a 409 rather than a unique-index failure,
 * and neither raise can leave an exception without its link.
 */
export async function raiseExceptionFromCase(id: string): Promise<{ case: Case; exception: ExceptionRecord }> {
  const auth = currentAuth();
  const row = await loadForCommand(id, 'edit');
  if (!RAISABLE_FROM.includes(row.state as CaseState)) {
    throw ApiError.conflict(`A ${row.state} case cannot raise an exception.`, { state: row.state });
  }

  return governedWrite(async (tx) => {
    // The state is read again under the lock: a withdrawal that committed after
    // the read above must not let a raise through.
    const [locked] = await tx.$queryRaw<
      { state: string }[]
    >`SELECT "state" FROM "cases" WHERE "id" = ${id} AND "tenantId" = ${auth.tenantId} FOR UPDATE`;
    if (!locked || !RAISABLE_FROM.includes(locked.state as CaseState)) {
      throw ApiError.conflict(`A ${locked?.state ?? 'missing'} case cannot raise an exception.`, {
        state: locked?.state ?? null,
      });
    }
    const existing = await tx.caseExceptionLink.findFirst({ where: { caseId: id } });
    if (existing) {
      throw ApiError.conflict(
        'This case has already raised its exception. A case raises one, and a second is not recorded.',
        {
          exceptionRecordId: existing.exceptionRecordId,
        },
      );
    }

    const exception = await raiseException(
      {
        code: CASE_EXCEPTION_CODE,
        label: CASE_EXCEPTION_LABEL,
        severity: row.severity as SeverityCode,
        subjectType: 'case',
        subjectId: id,
        subjectLabel: row.title,
        domain: 'case',
        detail: `Raised from case ${row.recordCode}: ${row.title}`,
        ownerPartyId: row.ownerPartyId,
        slaDueAt: row.responseDueAt,
      },
      tx,
    );

    await tx.caseExceptionLink.create({
      data: { tenantId: auth.tenantId, caseId: id, exceptionRecordId: exception.id },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'case',
      subjectId: id,
      after: { exceptionRecordId: exception.id },
      meta: { change: 'exception_raised', exceptionRecordCode: exception.recordCode },
      tx,
    });
    await emit({
      name: EVENTS.CASE_EXCEPTION_RAISED,
      subject: { entityType: 'case', entityId: id, recordCode: row.recordCode },
      related: [{ relation: 'raised_exception', entityType: 'exception', entityId: exception.id }],
      newState: { exceptionRecordId: exception.id },
      owner: { partyId: row.ownerPartyId },
      tx,
    });
    return { case: row, exception };
  });
}

/**
 * The list a caller may read. The tier clause is the WHAT axis as a filter: a
 * case above the caller's ceiling is not returned, the same as the evaluator
 * would refuse it row by row.
 */
/**
 * The states in which a case still has work for its owner. `resolved` is open
 * because it is answered but not yet closed, and the owner still closes it.
 */
export const OPEN_CASE_STATES: readonly CaseState[] = ['open', 'acknowledged', 'resolved'];

/** The grant a handover needs for cases. Checked outside the exit's transaction, as every grant check here is. */
export async function authoriseCaseHandover(): Promise<void> {
  await assertCan({ resource: 'cases', verb: 'edit' });
}

/**
 * The exit handover's write for one open case, inside the exit's transaction: the
 * row, its CaseEvent, the audit row and the event, the same governed path as a
 * reassignment. The caller has locked the row and checked the grant.
 */
export async function handOverCaseInTx(tx: DbTx, row: Case, successorPartyId: string, reason: string): Promise<Case> {
  if (!OPEN_CASE_STATES.includes(row.state as CaseState)) {
    throw ApiError.conflict(`A ${row.state} case cannot be handed over.`, { state: row.state });
  }
  assertOwnerIsNotBackup(successorPartyId, row.backupPartyId);
  const note = `owner ${row.ownerPartyId} -> ${successorPartyId}: ${reason}`;
  return applyChange({
    row,
    to: row.state as CaseState,
    eventName: EVENTS.CASE_REASSIGNED,
    data: { ownerPartyId: successorPartyId },
    newOwnerPartyId: successorPartyId,
    reason: note,
    tx,
  });
}

export async function listCases(filter: CaseFilter = {}): Promise<Case[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'cases', verb: 'view' });
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
  const page = Math.max(filter.page ?? 1, 1);
  return prisma.case.findMany({
    where: {
      ...(await visibilityWhere('cases', 'ownerPartyId')),
      visibilityTier: { in: tiersClearedBy(auth.classificationCeiling) },
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
    },
    orderBy: [{ responseDueAt: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
}

/** A case the caller cannot see is a 404, not a 403: its existence is not a fact the caller may learn. */
export async function getCase(id: string) {
  await assertCan({ resource: 'cases', verb: 'view' });
  const row = await prisma.case.findFirst({
    where: { id },
    include: { events: { orderBy: { at: 'asc' } }, exceptionLink: true },
  });
  if (!row || !(await canReach(row, 'view'))) throw ApiError.notFound('Case');
  return row;
}

/**
 * The overdue job's move: an open case whose response due instant has passed is
 * flagged. The state stays open. Returns false when there is nothing to do, which
 * is the normal case on a rerun, so a second pass over the same data writes nothing.
 */
export async function flagCaseOverdue(id: string, now: Date): Promise<boolean> {
  await assertCan({ resource: 'cases', verb: 'edit' });
  const auth = currentAuth();
  const row = await prisma.case.findFirst({ where: { id } });
  if (!row || row.state !== 'open' || row.overdueFlaggedAt !== null || row.responseDueAt >= now) return false;

  const reason = 'The response due instant passed with no acknowledgement. The case stays open.';
  return governedWrite(async (tx) => {
    const { count } = await tx.case.updateMany({
      where: {
        id: row.id,
        state: 'open',
        overdueFlaggedAt: null,
        responseDueAt: { lt: now },
      },
      data: { overdueFlaggedAt: now },
    });
    if (count !== 1) return false;

    await tx.caseEvent.create({
      data: {
        tenantId: auth.tenantId,
        caseId: row.id,
        fromState: 'open',
        toState: 'open',
        actorPartyId: null,
        reason,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'case',
      subjectId: row.id,
      before: { overdueFlaggedAt: null },
      after: { overdueFlaggedAt: now.toISOString(), state: 'open' },
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.CASE_MARKED_OVERDUE,
      subject: { entityType: 'case', entityId: row.id, recordCode: row.recordCode },
      previousState: { state: 'open' },
      newState: { state: 'open', overdueFlaggedAt: now.toISOString() },
      owner: { partyId: row.ownerPartyId },
      reason: { reasonCode: 'response_overdue', note: reason },
      tx,
    });
    return true;
  });
}

async function humanMove(id: string, to: CaseState, reason: string | null): Promise<Case> {
  const row = await loadForCommand(id, 'edit');
  refuseIllegal(row.state, to);
  return unwrap(await applyChange({ row, to, eventName: EVENT_FOR[to]!, reason }));
}

/**
 * Writes one change: the row, its CaseEvent, the audit row and the event. The
 * update is conditional on the state the caller read, so a concurrent move that
 * got there first leaves this one with a 409 rather than a silent overwrite.
 */
async function applyChange(change: Change): Promise<Case> {
  const { row, to, eventName, data = {}, newOwnerPartyId, reason, tx: outer } = change;
  const auth = currentAuth();
  const actorPartyId = auth.partyId ?? null;

  const work = async (tx: DbTx): Promise<Case> => {
    if (newOwnerPartyId !== undefined) await lockAssignableParty(tx, auth.tenantId, newOwnerPartyId);
    const { count } = await tx.case.updateMany({
      where: { id: row.id, state: row.state },
      data: { ...data, state: to },
    });
    if (count !== 1) {
      throw ApiError.conflict('The case changed while this was being recorded. Reload it and try again.');
    }

    const after = await tx.case.findUniqueOrThrow({ where: { id: row.id } });
    await tx.caseEvent.create({
      data: {
        tenantId: auth.tenantId,
        caseId: row.id,
        fromState: row.state,
        toState: to,
        actorPartyId,
        reason,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'case',
      subjectId: row.id,
      before: { state: row.state },
      after: {
        state: after.state,
        ownerPartyId: after.ownerPartyId,
        acknowledgedById: after.acknowledgedById,
        acknowledgedAt: after.acknowledgedAt?.toISOString() ?? null,
      },
      meta: reason ? { reason } : undefined,
      tx,
    });
    await emit({
      name: eventName,
      subject: { entityType: 'case', entityId: row.id, recordCode: row.recordCode },
      previousState: { state: row.state },
      newState: { state: after.state, ownerPartyId: after.ownerPartyId },
      owner: { partyId: after.ownerPartyId },
      reason: reason ? { reasonCode: to, note: reason } : null,
      tx,
    });
    return after;
  };
  return outer ? work(outer) : governedWrite(work);
}

/**
 * Loads a case the caller may act on. The order is the answer the caller is owed:
 * no grant for the verb at all is a 403 whatever the row is, because that answer
 * reveals nothing about the row; a row the caller cannot see is a 404; a row the
 * caller can see but whose scope or verb refuses is the evaluator's 403.
 */
async function loadForCommand(id: string, verb: 'view' | 'edit'): Promise<Case> {
  await assertCan({ resource: 'cases', verb });
  const row = await prisma.case.findFirst({ where: { id } });
  if (!row || !(await canReach(row, verb))) throw ApiError.notFound('Case');
  await assertCan({
    resource: 'cases',
    verb,
    record: { ownerPartyId: row.ownerPartyId, sensitivityClass: row.visibilityTier },
  });
  return row;
}

/** Whether the caller's scope and ceiling both clear the case for this verb. */
async function canReach(row: Case, verb: 'view' | 'edit'): Promise<boolean> {
  return can({
    resource: 'cases',
    verb,
    record: { ownerPartyId: row.ownerPartyId, sensitivityClass: row.visibilityTier },
  });
}

/** The tiers at or below a ceiling, in the rank order the evaluator uses. */
function tiersClearedBy(ceiling: SensitivityClass): SensitivityClass[] {
  return SENSITIVITY_CLASSES.filter((tier) => SENSITIVITY_RANK[tier] <= SENSITIVITY_RANK[ceiling]);
}

function refuseIllegal(from: string, to: CaseState): void {
  const allowed = CASE_TRANSITIONS[from as CaseState] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.conflict(`A ${from} case cannot become ${to}.`, { from, to });
  }
}

function unwrap(row: Case | null): Case {
  if (row === null) throw ApiError.conflict('The case changed while this was being recorded. Reload it and try again.');
  return row;
}

function assertOwnerIsNotBackup(ownerPartyId: string, backupPartyId: string | null): void {
  if (backupPartyId !== null && backupPartyId === ownerPartyId) {
    throw ApiError.unprocessable(
      'The backup cannot be the owner. A backup who is also the owner covers nothing, and the owner being away is the case a backup exists for.',
    );
  }
}

function assertSubjectPaired(subjectType: string | null, subjectId: string | null): void {
  if ((subjectType === null) !== (subjectId === null)) {
    throw ApiError.unprocessable('A case names its subject with both a type and an id, or with neither.');
  }
}

function assertRemedyNonNegative(remedyAmountMinor: bigint | null): void {
  if (remedyAmountMinor !== null && remedyAmountMinor < 0n) {
    throw ApiError.unprocessable('A remedy amount is paise and cannot be negative.');
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
