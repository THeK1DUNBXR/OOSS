/**
 * Business-line units (Zen 360 Phase 0 Wave 6, PR 1; SPINE-CONTRACT s.1.0 and
 * Opus decision 12). A unit is a dated row that belongs to a business line, or
 * to none. A unit moves between lines by closing its row and opening another
 * under the same code. Nothing edits a row's line: the database refuses it
 * (migration 20261013110000_business_line_units), and this module never tries.
 *
 * Every write is assertCan -> governedWrite (write, auditWrite, emit, in one
 * transaction; CLAUDE.md rule 5). Dates are IST calendar days, given as
 * YYYY-MM-DD and stored as UTC midnight, so "today" is today's IST day
 * (CLAUDE.md rule 3). OrgUnit, the reporting hierarchy, is not touched here.
 */

import type { BusinessLine, Unit } from '@prisma/client';
import { EVENTS } from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { governedWrite } from '../platform/governedWrite.js';
import {
  assertOpenOn,
  istDay,
  isRaceLoss,
  isoDay,
  RACE_MESSAGE_TEXT,
  reasonOf,
  textOf,
  todayIst,
} from './businessLines.js';

registerGovernedEntities('org', ['unit']);

/** A unit code is a key across every row of one unit: uppercase, short, starting with a letter. */
const CODE_PATTERN = /^[A-Z][A-Z0-9-]{1,23}$/;

export interface OpenUnitInput {
  code: string;
  name: string;
  /** The business line the unit delivers from its start day. Null for a support unit. */
  lineId?: string | null;
  parentUnitId?: string | null;
  /** IST day the unit opens. Defaults to today's IST day. */
  effectiveFrom?: string;
  reason: string;
}

export interface CloseUnitInput {
  id: string;
  /** IST day from which the row is no longer in force. Exclusive. */
  effectiveTo: string;
  reason: string;
}

export interface MoveUnitInput {
  id: string;
  /** The line the unit moves to from `effectiveFrom`. Null moves it to no line. */
  toLineId: string | null;
  /** The parent from `effectiveFrom`. Omitted keeps the parent the row has now. */
  parentUnitId?: string | null;
  /** IST day the move takes effect: the old row ends and the new one starts on it. */
  effectiveFrom: string;
  reason: string;
}

async function loadUnit(tx: DbTx, id: string): Promise<Unit> {
  const row = await tx.unit.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Unit');
  return row;
}

/**
 * A unit may start, or move, under a line only while that line is in force on
 * the day. The check is the business-line one, so the refusal reads the same
 * on both registries.
 */
async function assertLineOpen(tx: DbTx, lineId: string, day: Date): Promise<void> {
  const line: BusinessLine | null = await tx.businessLine.findFirst({ where: { id: lineId } });
  if (!line) throw ApiError.notFound('Business line');
  assertOpenOn(line, day, 'units');
}

/**
 * Walks the parent chain from `parentId`. Reaching a row with this code means
 * the unit would be its own ancestor. The walk follows row ids, so a loop that
 * runs through an older version of a unit is caught as well as a direct one. A
 * new unit has no rows yet, so only its existence is checked on open.
 */
async function assertNoCycle(tx: DbTx, code: string, parentId: string): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row: Pick<Unit, 'code' | 'parentUnitId'> | null = await tx.unit.findFirst({
      where: { id: cursor },
      select: { code: true, parentUnitId: true },
    });
    if (!row) throw ApiError.notFound('Parent unit');
    if (row.code === code) throw ApiError.badRequest(`Unit ${code} cannot be its own ancestor.`);
    cursor = row.parentUnitId;
  }
}

function assertNotClosed(row: Unit): void {
  if (row.status === 'closed' || row.effectiveTo !== null) {
    const end = row.effectiveTo ? ` from ${isoDay(row.effectiveTo)}` : '';
    throw ApiError.conflict(`Unit ${row.code} is already closed${end} and takes no further changes.`);
  }
}

function stateOf(row: Unit) {
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    lineId: row.lineId,
    parentUnitId: row.parentUnitId,
    effectiveFrom: isoDay(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? isoDay(row.effectiveTo) : null,
  };
}

/** Opens a unit under a line in force on its start day. A code is never reused, closed units included. */
export async function openUnit(input: OpenUnitInput): Promise<Unit> {
  await assertCan({ resource: 'org_design', verb: 'create' });
  const auth = currentAuth();
  if (!CODE_PATTERN.test(input.code)) {
    throw ApiError.badRequest('A unit code is 2 to 24 uppercase letters, digits or hyphens, starting with a letter.');
  }
  const name = textOf(input.name, 'name', 120);
  const reason = reasonOf(input.reason);
  const effectiveFrom = input.effectiveFrom ? istDay(input.effectiveFrom) : todayIst();
  const lineId = input.lineId ?? null;
  const parentUnitId = input.parentUnitId ?? null;

  return governedWrite(async (tx) => {
    const taken = await tx.unit.findFirst({ where: { code: input.code } });
    if (taken) throw ApiError.conflict(`Unit code ${input.code} is already used, closed units included.`);
    if (lineId) await assertLineOpen(tx, lineId, effectiveFrom);
    if (parentUnitId) await assertNoCycle(tx, input.code, parentUnitId);

    let row: Unit;
    try {
      row = await tx.unit.create({
        data: {
          tenantId: auth.tenantId,
          code: input.code,
          name,
          status: 'active',
          lineId,
          parentUnitId,
          effectiveFrom,
        },
      });
    } catch (err) {
      if (isRaceLoss(err)) throw ApiError.conflict(RACE_MESSAGE_TEXT);
      throw err;
    }
    await auditWrite({
      action: 'create',
      subjectType: 'unit',
      subjectId: row.id,
      after: row as never,
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.UNIT_OPENED,
      subject: { entityType: 'unit', entityId: row.id },
      newState: stateOf(row),
      reason: { note: reason },
      impact: { domains: ['org'] },
      tx,
    });
    return row;
  });
}

/**
 * Ends a unit's row from an IST day. The day must be after the row starts and
 * not before today: a closure is a dated change, never a backdated edit.
 */
export async function closeUnit(input: CloseUnitInput): Promise<Unit> {
  await assertCan({ resource: 'org_design', verb: 'edit' });
  const reason = reasonOf(input.reason);
  const effectiveTo = istDay(input.effectiveTo);

  return governedWrite(async (tx) => {
    const before = await loadUnit(tx, input.id);
    assertNotClosed(before);
    if (effectiveTo <= before.effectiveFrom) {
      throw ApiError.badRequest('A unit closes on a day after its row starts.');
    }
    if (effectiveTo < todayIst()) {
      throw ApiError.badRequest('A closure cannot be backdated: choose today or a later IST day.');
    }
    const after = await tx.unit.update({
      where: { id: before.id },
      data: { status: 'closed', effectiveTo },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'unit',
      subjectId: before.id,
      before: before as never,
      after: after as never,
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.UNIT_CLOSED,
      subject: { entityType: 'unit', entityId: before.id },
      previousState: { status: before.status, effectiveTo: null },
      newState: { status: 'closed', effectiveTo: isoDay(effectiveTo) },
      reason: { note: reason },
      impact: { domains: ['org'] },
      tx,
    });
    return after;
  });
}

/**
 * Moves a unit to another line (and, when given, another parent) from a day.
 * The old row closes on that day and a new row with the same code opens on it,
 * in one transaction, so no day is left without a row for the unit.
 */
export async function moveUnit(input: MoveUnitInput): Promise<{ closed: Unit; opened: Unit }> {
  await assertCan({ resource: 'org_design', verb: 'edit' });
  await assertCan({ resource: 'org_design', verb: 'create' });
  const auth = currentAuth();
  const reason = reasonOf(input.reason);
  const day = istDay(input.effectiveFrom);

  return governedWrite(async (tx) => {
    const before = await loadUnit(tx, input.id);
    assertNotClosed(before);
    if (day <= before.effectiveFrom) {
      throw ApiError.badRequest('A move takes effect after the unit row starts.');
    }
    if (day < todayIst()) {
      throw ApiError.badRequest('A move cannot be backdated: choose today or a later IST day.');
    }
    if (input.toLineId) await assertLineOpen(tx, input.toLineId, day);
    const parentUnitId = input.parentUnitId === undefined ? before.parentUnitId : input.parentUnitId;
    if (parentUnitId) await assertNoCycle(tx, before.code, parentUnitId);

    // Close before opening: the old row's range ends on the day the new one starts.
    const closed = await tx.unit.update({
      where: { id: before.id },
      data: { status: 'closed', effectiveTo: day },
    });
    let opened: Unit;
    try {
      opened = await tx.unit.create({
        data: {
          tenantId: auth.tenantId,
          code: before.code,
          name: before.name,
          status: 'active',
          lineId: input.toLineId,
          parentUnitId,
          effectiveFrom: day,
        },
      });
    } catch (err) {
      if (isRaceLoss(err)) throw ApiError.conflict(RACE_MESSAGE_TEXT);
      throw err;
    }
    await auditWrite({
      action: 'update',
      subjectType: 'unit',
      subjectId: before.id,
      before: before as never,
      after: closed as never,
      meta: { reason },
      tx,
    });
    await auditWrite({
      action: 'create',
      subjectType: 'unit',
      subjectId: opened.id,
      after: opened as never,
      meta: { reason, movedFrom: before.id },
      tx,
    });
    await emit({
      name: EVENTS.UNIT_MOVED,
      subject: { entityType: 'unit', entityId: before.id },
      previousState: { lineId: before.lineId, parentUnitId: before.parentUnitId },
      newState: { lineId: opened.lineId, parentUnitId, effectiveFrom: isoDay(day), openedUnitId: opened.id },
      reason: { note: reason },
      impact: { domains: ['org'] },
      tx,
    });
    return { closed, opened };
  });
}

/**
 * The units in force on an IST day: effective from it, and not ended on or
 * before it. The end is exclusive, so a unit closed on D is absent from D and
 * present on D-1. Defaults to today's IST day.
 */
export async function listUnits(input: { asOf?: string } = {}): Promise<Unit[]> {
  await assertCan({ resource: 'org_design', verb: 'view' });
  const asOf = input.asOf ? istDay(input.asOf) : todayIst();
  return prisma.unit.findMany({
    where: {
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: [{ code: 'asc' }, { effectiveFrom: 'asc' }],
  });
}
