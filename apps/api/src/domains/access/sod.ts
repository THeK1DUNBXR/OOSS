/**
 * Separation of duties at confirm, and the founder's recorded override (PR12;
 * ACCESS-MODEL-PLAN s.8).
 *
 * A confirm refuses when the person would hold both halves of a blocked pair once the
 * assignment compiles. The grants the check reads are everything the person holds after
 * the confirm: their legacy role grants, their individual grants (which include the
 * rows earlier confirms compiled), and this assignment's compiled rows. Nothing is
 * written to make the check; the compile spec is read as data.
 *
 * An override is the founder's recorded decision to accept one pair on one assignment,
 * with a reason. It is raised as an exception so it shows in the founder view. A confirm
 * passes an overridden pair and no other.
 */

import { BUILT_IN_SOD_PAIRS, EVENTS, type SodPair, type Verb } from '@kaizen/shared';
import type { AccessSodOverride } from '@prisma/client';
import { prisma, type DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { raiseException } from '../../platform/exceptions.js';
import { compileRows, loadCompileInput } from './compile.js';

registerGovernedEntities('gov', ['access_sod_override']);

/** One permission the person holds: a resource and a single verb. */
export interface SodGrant {
  resource: string;
  verb: Verb;
}

export interface SodFinding {
  pairCode: string;
}

/**
 * Pure: the pairs the granted permissions form. A pair fires when each side is matched,
 * and a side matches when the person holds any one of its verbs on its resource. The
 * caller decides what to do with a finding; this only says which pairs are formed.
 */
export function sodFindings(pairs: readonly SodPair[], granted: readonly SodGrant[]): SodFinding[] {
  const holds = (side: SodPair['a']) =>
    granted.some((g) => g.resource === side.resource && side.verbs.includes(g.verb));
  return pairs.filter((p) => holds(p.a) && holds(p.b)).map((p) => ({ pairCode: p.pairCode }));
}

/**
 * Everything the person would hold once this assignment confirms: legacy role grants
 * through their active affiliations, individual grants (earlier compiled rows among
 * them), and the rows this assignment compiles to. Read inside the caller's transaction,
 * so it sees the state the confirm is about to commit.
 */
export async function grantedAfterConfirmTx(
  tx: DbTx,
  tenantId: string,
  personId: string,
  assignmentId: string,
  now: Date,
): Promise<SodGrant[]> {
  const affiliations = await tx.affiliation.findMany({
    where: {
      tenantId,
      partyId: personId,
      status: 'active',
      roleSlug: { not: null },
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { roleSlug: true },
  });
  const slugs = [...new Set(affiliations.map((a) => a.roleSlug!))];
  const roles = slugs.length
    ? await tx.accessRole.findMany({ where: { tenantId, slug: { in: slugs } }, select: { id: true } })
    : [];
  const roleIds = roles.map((r) => r.id);

  const rows = await tx.grant.findMany({
    where: {
      tenantId,
      effectiveFrom: { lte: now },
      OR: [
        ...(roleIds.length ? [{ roleId: { in: roleIds } }] : []),
        { principalType: 'individual', principalId: personId },
      ],
    },
    select: { resource: true, verbs: true, effectiveTo: true },
  });

  const held: SodGrant[] = [];
  for (const row of rows) {
    if (row.effectiveTo && row.effectiveTo <= now) continue;
    for (const verb of row.verbs) held.push({ resource: row.resource, verb: verb as Verb });
  }
  for (const spec of compileRows(await loadCompileInput(tx, assignmentId))) {
    for (const verb of spec.verbs) held.push({ resource: spec.resource, verb });
  }
  return held;
}

/** The pair codes the founder has already overridden on this assignment. */
export async function overriddenPairCodesTx(tx: DbTx, tenantId: string, assignmentId: string): Promise<Set<string>> {
  const rows = await tx.accessSodOverride.findMany({
    where: { tenantId, assignmentId },
    select: { pairCode: true },
  });
  return new Set(rows.map((r) => r.pairCode));
}

/**
 * Whether the person holds company reach through a confirmed placement that has not
 * expired. Company reach is what makes someone the founder for this purpose: only
 * they may accept an overlap that another person must have confirmed.
 */
async function holdsCompanyReach(personId: string, now: Date): Promise<boolean> {
  const placement = await prisma.accessPlacement.findFirst({
    where: {
      personId,
      level: { reach: 'company' },
      assignment: { status: 'confirmed', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    },
    select: { id: true },
  });
  return placement !== null;
}

export interface RecordSodOverrideInput {
  assignmentId: string;
  pairCode: string;
  reason: string;
}

/**
 * Records the founder's override of one blocked pair on a suggested assignment. Refused
 * without company reach (403) and without a reason (400); a refusal writes nothing. The
 * overlap is raised as an exception owned by the founder, so it appears in the founder
 * view (O11), and the override is audited and emitted in the same transaction.
 */
export async function recordSodOverride(input: RecordSodOverrideInput): Promise<AccessSodOverride> {
  await assertCan({ resource: 'access_assignments', verb: 'approve' });
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.forbidden('Only a person can record a separation-of-duties override.');

  const now = new Date();
  if (!(await holdsCompanyReach(auth.partyId, now))) {
    throw ApiError.forbidden('Only the founder, who holds company reach, can record a separation-of-duties override.');
  }

  const reason = input.reason.trim();
  if (!reason) throw ApiError.badRequest('An override states why the founder accepts the overlap.');

  const pair = BUILT_IN_SOD_PAIRS.find((p) => p.pairCode === input.pairCode);
  if (!pair) throw ApiError.unprocessable(`${input.pairCode} is not a built-in separation-of-duties pair.`);

  const assignment = await prisma.accessAssignment.findFirst({
    where: { id: input.assignmentId },
    select: { id: true, status: true },
  });
  if (!assignment) throw ApiError.notFound('Access assignment');
  if (assignment.status !== 'suggested') {
    throw ApiError.unprocessable(
      `An override is recorded before confirmation; this assignment is ${assignment.status}.`,
    );
  }

  return governedWrite(async (tx) => {
    const existing = await tx.accessSodOverride.findFirst({
      where: { tenantId: auth.tenantId, assignmentId: assignment.id, pairCode: pair.pairCode },
      select: { id: true },
    });
    if (existing) throw ApiError.conflict(`${pair.pairCode} is already overridden on this assignment.`);

    // Raised in the same transaction: the override and its exception commit together,
    // or neither does.
    const exception = await raiseException(
      {
        code: 'EX-GOV-SOD-001',
        label: 'Separation of duties overridden by the founder',
        severity: 'S2_WARNING',
        subjectType: 'access_assignment',
        subjectId: assignment.id,
        domain: 'gov',
        detail: `${pair.pairCode}: ${reason}`,
        ownerPartyId: auth.partyId,
      },
      tx,
    );

    const row = await tx.accessSodOverride.create({
      data: {
        tenantId: auth.tenantId,
        assignmentId: assignment.id,
        pairCode: pair.pairCode,
        reason,
        overriddenById: auth.partyId!,
        overriddenAt: now,
        exceptionId: exception.id,
      },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'access_sod_override',
      subjectId: row.id,
      after: { assignmentId: assignment.id, pairCode: pair.pairCode, reason, exceptionId: exception.id },
      tx,
    });
    await emit({
      name: EVENTS.ACCESS_SOD_OVERRIDE_RECORDED,
      subject: { entityType: 'access_sod_override', entityId: row.id },
      newState: { assignmentId: assignment.id, pairCode: pair.pairCode, exceptionId: exception.id },
      reason: { note: reason },
      impact: { domains: ['gov'] },
      tx,
    });
    return row;
  });
}
