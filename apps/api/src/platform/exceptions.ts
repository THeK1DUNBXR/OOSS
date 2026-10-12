/**
 * The exception engine (§3.6).
 *
 * A record in an actionable bad state becomes an exception with a resolved
 * owner, not a data point in a report someone has to notice. Severity (S0–S4)
 * is kept structurally separate from notification priority (N0–N4).
 *
 * An accountable owner is always resolved BEFORE any notification fires.
 * Escalation is bounded to exactly four named triggers: SLA expiry, decline,
 * authority insufficiency, and severity increase.
 */

import {
  EVENTS,
  SEVERITY_RANK,
  type EscalationTrigger,
  type NotificationPriority,
  type SeverityCode,
} from '@kaizen/shared';
import { Prisma } from '@prisma/client';
import { prisma, type DbTx } from './db.js';
import { currentAuth } from './context.js';
import { emit } from './eventBus.js';
import { nextRecordCode } from './recordCode.js';
import { ApiError } from './errors.js';
import { assertCan } from './permissions.js';
import { auditWrite, registerGovernedEntities } from './audit.js';

// An exception's acknowledgement and resolution are governed writes: who closed
// a problem, and when, is the thing an auditor asks about.
registerGovernedEntities('gov', ['exception']);

export interface RaiseExceptionInput {
  code: string;
  label: string;
  severity: SeverityCode;
  subjectType: string;
  subjectId: string;
  subjectLabel?: string | null;
  domain?: string;
  detail?: string;
  reasonCode?: string;
  /** Resolved deterministically — never "whoever happens to be logged in". */
  ownerPartyId?: string | null;
  accountablePositionId?: string | null;
  slaDueAt?: Date | null;
  /** Part of the durable idempotency key (automationVersionId, subjectRef, triggerFingerprint, ladderRung). */
  triggerFingerprint?: string;
  ladderRung?: number;
  notify?: boolean;
  notificationPriority?: NotificationPriority;
}

/**
 * The Four-Property Test an exception must pass: abnormal, actionable, owned,
 * consequential. An exception that fails any of them is a data point, not an
 * exception.
 */
export function passesFourPropertyTest(input: RaiseExceptionInput): boolean {
  const owned = Boolean(input.ownerPartyId || input.accountablePositionId);
  const actionable = Boolean(input.detail);
  return owned && actionable;
}

/**
 * The states that still count as "open" for the natural key. Must match the
 * WHERE predicate of exception_records_open_natural_key in the migration; a
 * resolved row releases the key so the same problem can be raised again.
 */
export const OPEN_STATES = ['open', 'acknowledged', 'escalated'] as const;

/**
 * Audit and event writes take the caller's transaction only when there is one.
 * Passing the outer scoped client instead would run the audit chain write on a
 * connection of its own, where the per-tenant advisory lock that orders the
 * chain is released after each statement rather than at commit.
 */
function txOf(db: DbTx): DbTx | undefined {
  return (db as unknown) === prisma ? undefined : db;
}

async function findOpenException(input: RaiseExceptionInput, db: DbTx = prisma as unknown as DbTx) {
  return db.exceptionRecord.findFirst({
    where: {
      tenantId: currentAuth().tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      code: input.code,
      state: { in: [...OPEN_STATES] },
    },
  });
}

function absorbIntoOpen(
  open: { id: string; severity: string; escalationRung: number },
  input: RaiseExceptionInput,
  db: DbTx = prisma as unknown as DbTx,
) {
  if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[open.severity as SeverityCode]) {
    return escalateException(open.id, 'severity_increase', input.severity, undefined, open.escalationRung, db);
  }
  return open;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * `db` is the caller's transaction when the raise is part of a governed write:
 * the exception, its audit row, its event and its owner notification then commit
 * or roll back with that write. Omitted, it writes on its own, as before.
 */
export async function raiseException(input: RaiseExceptionInput, db: DbTx = prisma as unknown as DbTx) {
  const auth = currentAuth();
  const tx = txOf(db);

  // Inside a transaction the overlap guard below cannot rely on the unique index
  // alone: a unique violation aborts the whole transaction, so there is no
  // "join the winner" recovery to run. A transaction-scoped advisory lock on the
  // natural key makes overlapping raises queue instead, and the second one then
  // sees the first one's row.
  if (tx) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`exception:${auth.tenantId}:${input.subjectType}:${input.subjectId}:${input.code}`}))`;
  }

  // Idempotency: the same rung of the same ladder on the same subject fires once.
  if (input.triggerFingerprint) {
    const existing = await db.exceptionRecord.findFirst({
      where: {
        tenantId: auth.tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        code: input.code,
        triggerFingerprint: input.triggerFingerprint,
        ladderRung: input.ladderRung ?? 0,
      },
    });
    if (existing) return existing;
  }

  // An open exception of the same code on the same subject escalates rather
  // than duplicating — severity increase is one of the four escalation triggers.
  const open = await findOpenException(input, db);
  if (open) return absorbIntoOpen(open, input, db);

  const recordCode = await nextRecordCode('EXC', new Date(), db);
  const ownerUnresolved = !input.ownerPartyId && !input.accountablePositionId;

  let record;
  try {
    record = await db.exceptionRecord.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        code: input.code,
        label: input.label,
        severity: input.severity,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel ?? null,
        domain: input.domain ?? 'crm',
        detail: input.detail ?? null,
        reasonCode: input.reasonCode ?? null,
        ownerPartyId: input.ownerPartyId ?? null,
        accountablePositionId: input.accountablePositionId ?? null,
        // An exception failing to resolve an owner is itself a first-class,
        // measured category feeding H_OPS — never something discovered by
        // noticing a blank assignee field.
        ownerUnresolved,
        slaDueAt: input.slaDueAt ?? null,
        triggerFingerprint: input.triggerFingerprint ?? null,
        ladderRung: input.ladderRung ?? null,
      },
    });
  } catch (err) {
    // The findFirst above is a read, not a claim: an overlapping run can pass
    // it at the same moment and insert first. The partial unique index
    // (exception_records_open_natural_key, migration 20261011120000) lets
    // exactly one of the two inserts win. The loser lands here and joins the
    // winner's row instead of creating a second open exception and a second
    // owner notification. A unique violation with no open row to join is not
    // this race, so it is rethrown.
    // Inside a transaction the violation has already aborted it, so the winner
    // cannot be read back here. The advisory lock above is what keeps overlapping
    // transaction-scoped raises from reaching this point.
    if (!isUniqueViolation(err) || tx) throw err;
    const winner = await findOpenException(input);
    if (!winner) throw err;
    return absorbIntoOpen(winner, input);
  }

  await auditWrite({
    action: 'create',
    subjectType: 'exception',
    subjectId: record.id,
    after: { recordCode, code: input.code, severity: input.severity, state: 'open' },
    tx,
  });

  await emit({
    name: EVENTS.EXCEPTION_RAISED,
    subject: { entityType: 'exception', entityId: record.id, recordCode },
    related: [{ relation: 'raised_for', entityType: input.subjectType, entityId: input.subjectId }],
    newState: { code: input.code, severity: input.severity, ownerPartyId: input.ownerPartyId ?? null },
    severity: input.severity,
    owner: { partyId: input.ownerPartyId ?? null, positionId: input.accountablePositionId ?? null },
    impact: { domains: [input.domain ?? 'crm'], severity: input.severity },
    tx,
  });

  // Ownership precedes notification, always. The notification is an in-app row;
  // nothing here leaves the system, so it can sit inside the transaction.
  if (input.notify !== false && input.ownerPartyId) {
    await notify(
      {
        recipientPartyId: input.ownerPartyId,
        priority: input.notificationPriority ?? severityToPriority(input.severity),
        title: input.label,
        body: input.detail ?? `${input.code} raised on ${input.subjectLabel ?? input.subjectId}`,
        severity: input.severity,
        subjectType: 'exception',
        subjectId: record.id,
        drillPath: `/exceptions/${record.id}`,
      },
      db,
    );
  }

  return record;
}

// Acknowledge and resolve are the two moves an owner makes on an exception.
// Resolve is not allowed from `resolved` itself: a second resolve would
// overwrite resolvedById and the note the first one left, so the record would
// name a closer who did not close it.
const ACKNOWLEDGE_FROM = ['open', 'escalated'] as const;
const RESOLVE_FROM = ['open', 'acknowledged', 'escalated'] as const;

/**
 * Permission is checked against the record's owner, so an editor with `own`
 * scope can only act on exceptions routed to them. The state guard is in the
 * UPDATE's WHERE clause, not a read-then-write, so two concurrent resolves
 * cannot both pass it.
 */
async function transitionException(
  id: string,
  from: readonly string[],
  apply: { state: string; data: Prisma.ExceptionRecordUpdateManyMutationInput },
  audit: { before: Record<string, unknown>; after: Record<string, unknown> },
  event: { name: string; newState: Record<string, unknown> },
) {
  const existing = await prisma.exceptionRecord.findFirst({ where: { id } });
  if (!existing) throw ApiError.notFound('Exception');
  await assertCan({ resource: 'exceptions', verb: 'edit', record: { ownerPartyId: existing.ownerPartyId } });

  const { count } = await prisma.exceptionRecord.updateMany({
    where: { id, state: { in: [...from] } },
    data: apply.data,
  });
  if (count !== 1) {
    throw ApiError.conflict(`Exception is ${existing.state}; it cannot move to ${apply.state} from there`);
  }
  const record = await prisma.exceptionRecord.findFirstOrThrow({ where: { id } });

  await auditWrite({
    action: 'update',
    subjectType: 'exception',
    subjectId: id,
    before: { state: existing.state, ...audit.before },
    after: { state: apply.state, ...audit.after },
  });

  await emit({
    name: event.name,
    subject: { entityType: 'exception', entityId: id, recordCode: record.recordCode },
    newState: event.newState,
  });
  return record;
}

export async function acknowledgeException(id: string, note?: string) {
  const auth = currentAuth();
  const at = new Date();
  return transitionException(
    id,
    ACKNOWLEDGE_FROM,
    {
      state: 'acknowledged',
      data: { state: 'acknowledged', acknowledgedAt: at, acknowledgedById: auth.partyId, resolutionNote: note },
    },
    { before: {}, after: { acknowledgedById: auth.partyId, resolutionNote: note ?? null } },
    { name: EVENTS.EXCEPTION_ACKNOWLEDGED, newState: { state: 'acknowledged' } },
  );
}

export async function resolveException(id: string, note: string) {
  const auth = currentAuth();
  const at = new Date();
  return transitionException(
    id,
    RESOLVE_FROM,
    {
      state: 'resolved',
      data: { state: 'resolved', resolvedAt: at, resolvedById: auth.partyId, resolutionNote: note },
    },
    { before: {}, after: { resolvedById: auth.partyId, resolutionNote: note } },
    { name: EVENTS.EXCEPTION_RESOLVED, newState: { state: 'resolved', note } },
  );
}

/**
 * Escalation is bounded to the four named triggers — nothing escalates by default outside them.
 *
 * The bump is a conditional UPDATE on `observedRung`, the rung the caller saw
 * when it decided to escalate, and an open state. Two overlapping SLA sweeps
 * that both observed rung N: only the first UPDATE matches, so only that call
 * moves the row to N+1, emits and notifies. The second returns the row as it
 * now stands. The rung is the caller's observation, not a read taken here: a
 * read inside this function would see the first sweep's commit and bump again,
 * which is the double-escalation this guard exists to stop. Omitted, it falls
 * back to the rung read here, which is correct only for a single caller.
 * Deliberately not retried: a retry would bump again and undo the guard.
 */
export async function escalateException(
  id: string,
  trigger: EscalationTrigger,
  newSeverity?: SeverityCode,
  escalateToPartyId?: string | null,
  observedRung?: number,
  db: DbTx = prisma as unknown as DbTx,
) {
  const tx = txOf(db);
  const existing = await db.exceptionRecord.findFirst({ where: { id } });
  if (!existing) return null;

  const { count } = await db.exceptionRecord.updateMany({
    where: { id, state: { in: [...OPEN_STATES] }, escalationRung: observedRung ?? existing.escalationRung },
    data: {
      state: 'escalated',
      severity: newSeverity ?? existing.severity,
      escalatedAt: new Date(),
      escalationRung: (observedRung ?? existing.escalationRung) + 1,
      escalationTrigger: trigger,
      escalatedToPartyId: escalateToPartyId ?? existing.escalatedToPartyId,
    },
  });
  const record = await db.exceptionRecord.findFirstOrThrow({ where: { id } });
  if (count !== 1) return record;

  await auditWrite({
    action: 'update',
    subjectType: 'exception',
    subjectId: id,
    before: { state: existing.state, severity: existing.severity, escalationRung: existing.escalationRung },
    after: {
      state: 'escalated',
      severity: record.severity,
      escalationRung: record.escalationRung,
      escalationTrigger: trigger,
    },
    tx,
  });

  await emit({
    name: EVENTS.EXCEPTION_ESCALATED,
    subject: { entityType: 'exception', entityId: id, recordCode: record.recordCode },
    previousState: { severity: existing.severity, rung: existing.escalationRung },
    newState: { severity: record.severity, rung: record.escalationRung, trigger },
    reason: { reasonCode: trigger },
    severity: record.severity as SeverityCode,
    tx,
  });

  if (record.escalatedToPartyId) {
    await notify(
      {
        recipientPartyId: record.escalatedToPartyId,
        priority: severityToPriority(record.severity as SeverityCode),
        title: `Escalated: ${record.label}`,
        body: `${record.code} escalated to rung ${record.escalationRung} (${trigger}).`,
        severity: record.severity as SeverityCode,
        subjectType: 'exception',
        subjectId: id,
        drillPath: `/exceptions/${id}`,
      },
      db,
    );
  }

  return record;
}

// ---------------------------------------------------------------------------
// Notifications. Priority is an independent judgment from severity — related,
// but not derived, which is why the mapping below is a default a caller may
// override rather than a fixed function.
// ---------------------------------------------------------------------------

export function severityToPriority(severity: SeverityCode): NotificationPriority {
  switch (severity) {
    case 'S4_CRITICAL':
      return 'N4_URGENT';
    case 'S3_HIGH_RISK':
      return 'N3_HIGH';
    case 'S2_WARNING':
      return 'N2_NORMAL';
    case 'S1_ATTENTION':
      return 'N1_LOW';
    default:
      return 'N0_AMBIENT';
  }
}

export interface NotifyInput {
  recipientPartyId: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  channel?: string;
  severity?: SeverityCode | null;
  subjectType?: string;
  subjectId?: string;
  drillPath?: string;
}

export async function notify(input: NotifyInput, db: DbTx = prisma as unknown as DbTx) {
  const auth = currentAuth();
  return db.notification.create({
    data: {
      tenantId: auth.tenantId,
      recipientPartyId: input.recipientPartyId,
      priority: input.priority,
      channel: input.channel ?? 'in_app',
      title: input.title,
      body: input.body,
      severity: input.severity ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      drillPath: input.drillPath ?? null,
      dispatchedAt: new Date(),
    },
  });
}
