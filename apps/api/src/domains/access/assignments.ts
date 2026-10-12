/**
 * Access assignments: suggest, confirm and expire (Wave 6 PR11a; ACCESS-MODEL-PLAN
 * s.2.3, s.7; P11-DESIGN b).
 *
 * A suggestion grants nothing. A confirmation is the decision that makes an
 * assignment count, and the rules for who may make it are in rules.ts. Every write
 * is assertCan, then governedWrite (the write, auditWrite, emit in one transaction;
 * CLAUDE.md rule 5). Refusals are thrown before the transaction opens, so a refused
 * caller writes nothing.
 *
 * PR11b fills the two seams at the bottom: confirming compiles the assignment into
 * Grant rows, and expiring removes them. Until then a confirmed assignment is data.
 */

import type { AccessAssignment } from '@prisma/client';
import { EVENTS } from '@kaizen/shared';
import { prisma, type DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, invalidateGrantCache } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { reasonOf } from '../businessLines.js';
import {
  checkConfirmRules,
  DUTY_SENSITIVITY,
  expiryWithinCap,
  IDENTITY_TYPES,
  type ConfirmViolation,
  type IdentityType,
  type Reach,
} from './rules.js';

registerGovernedEntities('gov', [
  'access_vertical',
  'access_level',
  'access_level_limit',
  'access_capability_rule',
  'access_resource_binding',
  'access_assignment',
  'access_placement',
  'access_duty',
]);

export interface PlacementInput {
  verticalCode: string;
  levelCode: string;
  /** A unit's code. Null or empty for the whole vertical. */
  unitCode?: string | null;
}

export interface DutyInput {
  dutyCode: string;
  expiresAt?: string | null;
}

export interface SuggestAssignmentInput {
  personId: string;
  identityType: IdentityType;
  placements: PlacementInput[];
  duties?: DutyInput[];
  /** An ISO instant. Required for a non-employee; at most twelve months out (IST). */
  expiresAt?: string | null;
  reason: string;
}

/** The fields a confirmation or expiry is judged and audited on. */
function stateOf(row: Partial<AccessAssignment>): Record<string, unknown> {
  return {
    personId: row.personId,
    identityType: row.identityType,
    status: row.status,
    suggestedById: row.suggestedById,
    confirmedById: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    expiredById: row.expiredById ?? null,
    expiredAt: row.expiredAt ?? null,
    expiresAt: row.expiresAt ?? null,
  };
}

function instantOf(text: string, field: string): Date {
  const t = new Date(text);
  if (Number.isNaN(t.getTime())) throw ApiError.unprocessable(`${field} is not a date and time.`);
  return t;
}

/** Vertical and level codes become ids, and a unit must name an open unit row. */
async function resolvePlacements(inputs: PlacementInput[]) {
  if (inputs.length === 0) {
    throw ApiError.unprocessable('An assignment places the person in at least one vertical.');
  }
  const verticals = await prisma.accessVertical.findMany({
    where: { code: { in: inputs.map((p) => p.verticalCode) } },
    select: { id: true, code: true, businessLineId: true },
  });
  // No SQL foreign key reaches business_lines (a relation broke invoicing.ts typechecking),
  // so the line is checked here. The scoped client reads only this tenant's lines.
  const lineIds = verticals.map((v) => v.businessLineId).filter((id): id is string => id !== null);
  const ownLines = lineIds.length
    ? new Set(
        (await prisma.businessLine.findMany({ where: { id: { in: lineIds } }, select: { id: true } })).map((l) => l.id),
      )
    : new Set<string>();
  for (const v of verticals) {
    if (v.businessLineId !== null && !ownLines.has(v.businessLineId)) {
      throw ApiError.unprocessable(`Vertical ${v.code} names a business line this tenant does not have.`);
    }
  }
  const levels = await prisma.accessLevel.findMany({
    where: { code: { in: inputs.map((p) => p.levelCode) } },
    select: { id: true, code: true },
  });
  const seen = new Set<string>();
  const out: { verticalId: string; levelId: string; unitCode: string }[] = [];
  for (const p of inputs) {
    const vertical = verticals.find((v) => v.code === p.verticalCode);
    if (!vertical) throw ApiError.unprocessable(`Vertical ${p.verticalCode} is not defined for this tenant.`);
    const level = levels.find((l) => l.code === p.levelCode);
    if (!level) throw ApiError.unprocessable(`Level ${p.levelCode} is not defined for this tenant.`);
    const unitCode = (p.unitCode ?? '').trim();
    if (unitCode !== '') {
      const unit = await prisma.unit.findFirst({ where: { code: unitCode, effectiveTo: null }, select: { id: true } });
      if (!unit) throw ApiError.unprocessable(`Unit ${unitCode} has no open row.`);
    }
    const key = `${vertical.id}|${unitCode}`;
    if (seen.has(key)) throw ApiError.unprocessable(`${p.verticalCode} is placed twice in one assignment.`);
    seen.add(key);
    out.push({ verticalId: vertical.id, levelId: level.id, unitCode });
  }
  return out;
}

function resolveDuties(inputs: DutyInput[]) {
  return inputs.map((d) => {
    if (!Object.prototype.hasOwnProperty.call(DUTY_SENSITIVITY, d.dutyCode)) {
      throw ApiError.unprocessable(`Duty ${d.dutyCode} is not in the duty vocabulary.`);
    }
    return {
      dutyCode: d.dutyCode,
      sensitive: DUTY_SENSITIVITY[d.dutyCode] === true,
      expiresAt: d.expiresAt ? instantOf(d.expiresAt, `Duty ${d.dutyCode} expiry`) : null,
    };
  });
}

/** What the confirmer already holds, from its own confirmed placements that have not expired. */
async function reachOf(partyId: string, now: Date): Promise<{ company: boolean; verticalCodes: string[] }> {
  const rows = await prisma.accessPlacement.findMany({
    where: {
      personId: partyId,
      assignment: { status: 'confirmed', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    },
    select: { vertical: { select: { code: true } }, level: { select: { reach: true } } },
  });
  return {
    company: rows.some((r) => r.level.reach === 'company'),
    verticalCodes: rows
      .filter((r) => r.level.reach === 'vertical' || r.level.reach === 'company')
      .map((r) => r.vertical.code),
  };
}

async function loadAssignment(id: string) {
  const row = await prisma.accessAssignment.findFirst({
    where: { id },
    include: {
      placements: { select: { vertical: { select: { code: true } }, level: { select: { reach: true } } } },
      duties: { select: { sensitive: true } },
    },
  });
  if (!row) throw ApiError.notFound('Access assignment');
  return row;
}

function refusalText(violations: ConfirmViolation[]): string {
  const parts = violations.map((v) => {
    switch (v.rule) {
      case 'self':
        return 'a person cannot confirm their own access';
      case 'answerer':
        return 'the person who answered the mapping cannot also confirm it';
      case 'founder_required':
        return 'a Head placement or a sensitive duty needs the founder to confirm';
      case 'vertical_head_required':
        return `a placement in ${v.verticalCode} needs the Head of that vertical or the founder`;
    }
  });
  return `This assignment cannot be confirmed by you: ${parts.join('; ')}.`;
}

/**
 * Suggests an assignment for a person. The suggestion is recorded and grants
 * nothing; it waits for a confirmation by someone else.
 */
export async function suggestAssignment(input: SuggestAssignmentInput): Promise<AccessAssignment> {
  await assertCan({ resource: 'access_assignments', verb: 'create' });
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.forbidden('Only a person can suggest an access assignment.');
  const reason = reasonOf(input.reason);
  if (!(IDENTITY_TYPES as readonly string[]).includes(input.identityType)) {
    throw ApiError.unprocessable(`Identity type ${input.identityType} is not one of ${IDENTITY_TYPES.join(', ')}.`);
  }
  const person = await prisma.person.findFirst({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw ApiError.notFound('Person');

  const placements = await resolvePlacements(input.placements);
  const duties = resolveDuties(input.duties ?? []);
  const now = new Date();
  const expiresAt = input.expiresAt ? instantOf(input.expiresAt, 'Expiry') : null;
  if (!expiryWithinCap(input.identityType, now, expiresAt)) {
    throw ApiError.unprocessable('A non-employee needs an expiry no more than twelve months from today (IST).');
  }

  return governedWrite(async (tx) => {
    const row = await tx.accessAssignment.create({
      data: {
        tenantId: auth.tenantId,
        personId: input.personId,
        identityType: input.identityType,
        status: 'suggested',
        suggestedById: auth.partyId as string,
        suggestedAt: now,
        expiresAt,
        reason,
      },
    });
    await tx.accessPlacement.createMany({
      data: placements.map((p) => ({
        tenantId: auth.tenantId,
        assignmentId: row.id,
        personId: input.personId,
        verticalId: p.verticalId,
        levelId: p.levelId,
        unitCode: p.unitCode,
      })),
    });
    if (duties.length > 0) {
      await tx.accessDuty.createMany({
        data: duties.map((d) => ({
          tenantId: auth.tenantId,
          assignmentId: row.id,
          dutyCode: d.dutyCode,
          sensitive: d.sensitive,
          expiresAt: d.expiresAt,
        })),
      });
    }
    await auditWrite({
      action: 'create',
      subjectType: 'access_assignment',
      subjectId: row.id,
      after: stateOf(row),
      meta: { reason, placements: placements.length, duties: duties.length },
      tx,
    });
    await emit({
      name: EVENTS.ACCESS_ASSIGNMENT_SUGGESTED,
      subject: { entityType: 'access_assignment', entityId: row.id },
      newState: stateOf(row),
      reason: { note: reason },
      impact: { domains: ['gov'] },
      tx,
    });
    return row;
  });
}

/**
 * Confirms a suggested assignment. The confirmer must be someone other than the
 * person and the answerer, and must hold the reach the placements need (rules.ts).
 */
export async function confirmAssignment(input: { assignmentId: string; reason: string }): Promise<AccessAssignment> {
  await assertCan({ resource: 'access_assignments', verb: 'approve' });
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.forbidden('Only a person can confirm an access assignment.');
  const reason = reasonOf(input.reason);
  const row = await loadAssignment(input.assignmentId);
  if (row.status !== 'suggested') {
    throw ApiError.unprocessable(`Only a suggested assignment can be confirmed; this one is ${row.status}.`);
  }

  const now = new Date();
  const violations = checkConfirmRules({
    subjectPersonId: row.personId,
    answererPersonId: row.suggestedById,
    confirmerPersonId: auth.partyId,
    placements: row.placements.map((p) => ({ verticalCode: p.vertical.code, reach: p.level.reach as Reach })),
    hasSensitiveDuty: row.duties.some((d) => d.sensitive),
    confirmerReach: await reachOf(auth.partyId, now),
  });
  if (violations.length > 0) throw ApiError.forbidden(refusalText(violations));
  if (!expiryWithinCap(row.identityType as IdentityType, now, row.expiresAt)) {
    throw ApiError.unprocessable('A non-employee needs an expiry no more than twelve months from today (IST).');
  }

  const confirmerId = auth.partyId;
  const result = await governedWrite(async (tx) => {
    const { count } = await tx.accessAssignment.updateMany({
      where: { id: row.id, status: 'suggested' },
      data: { status: 'confirmed', confirmedById: confirmerId, confirmedAt: now },
    });
    if (count !== 1) throw ApiError.conflict('This assignment changed while you were confirming it. Reload it first.');
    const after = await tx.accessAssignment.findUniqueOrThrow({ where: { id: row.id } });
    await compileConfirmedAssignment(tx, row.id);
    await auditWrite({
      action: 'update',
      subjectType: 'access_assignment',
      subjectId: row.id,
      before: stateOf(row),
      after: stateOf(after),
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.ACCESS_ASSIGNMENT_CONFIRMED,
      subject: { entityType: 'access_assignment', entityId: row.id },
      previousState: stateOf(row),
      newState: stateOf(after),
      reason: { note: reason },
      impact: { domains: ['gov'] },
      tx,
    });
    return after;
  });
  invalidateGrantCache();
  return result;
}

/** Ends a suggested or confirmed assignment. The history stays; nothing is deleted. */
export async function expireAssignment(input: { assignmentId: string; reason: string }): Promise<AccessAssignment> {
  await assertCan({ resource: 'access_assignments', verb: 'edit' });
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.forbidden('Only a person can expire an access assignment.');
  const reason = reasonOf(input.reason);
  const row = await loadAssignment(input.assignmentId);
  if (row.status === 'expired') throw ApiError.unprocessable('This assignment has already expired.');

  const now = new Date();
  const expirerId = auth.partyId;
  const result = await governedWrite(async (tx) => {
    const { count } = await tx.accessAssignment.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'expired', expiredById: expirerId, expiredAt: now },
    });
    if (count !== 1) throw ApiError.conflict('This assignment changed while you were expiring it. Reload it first.');
    const after = await tx.accessAssignment.findUniqueOrThrow({ where: { id: row.id } });
    await removeCompiledGrants(tx, row.id);
    await auditWrite({
      action: 'update',
      subjectType: 'access_assignment',
      subjectId: row.id,
      before: stateOf(row),
      after: stateOf(after),
      meta: { reason },
      tx,
    });
    await emit({
      name: EVENTS.ACCESS_ASSIGNMENT_EXPIRED,
      subject: { entityType: 'access_assignment', entityId: row.id },
      previousState: stateOf(row),
      newState: stateOf(after),
      reason: { note: reason },
      impact: { domains: ['gov'] },
      tx,
    });
    return after;
  });
  invalidateGrantCache();
  return result;
}

/**
 * PR11b seam. A confirmed assignment becomes Grant rows here, inside the confirm
 * transaction, so the confirmation and its grants commit or vanish together. In
 * PR11a it writes nothing: a confirmed assignment grants nothing yet.
 */
export async function compileConfirmedAssignment(tx: DbTx, assignmentId: string): Promise<void> {
  void tx;
  void assignmentId;
}

/**
 * PR11b seam. The Grant rows a confirmed assignment wrote are removed here, inside
 * the expiry transaction. PR11a has none to remove.
 */
export async function removeCompiledGrants(tx: DbTx, assignmentId: string): Promise<void> {
  void tx;
  void assignmentId;
}
