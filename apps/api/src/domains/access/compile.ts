/**
 * Compiles a confirmed access assignment into Grant rows (Wave 6 PR11b;
 * ACCESS-MODEL-PLAN s.4-s.5; P11-DESIGN c, b).
 *
 * Each compiled row is an individual grant tagged with its assignment
 * (Grant.accessAssignmentId). A recompile and an expiry touch only tagged rows, so a
 * role or individual grant is never removed by this module.
 *
 * Reach maps to rows as follows. Own is scope own, resolved to the vertical. Vertical
 * is scope all, resolved to the vertical, so the scope axis still narrows it to the
 * vertical's records. Company is scope all with no resolver, the one reach that is
 * company-wide. Team and unit compile to no rows at all: no reporting-line source is
 * chosen yet, so those reaches fail closed (O6).
 */

import type { Scope, Verb } from '@kaizen/shared';
import { EVENTS } from '@kaizen/shared';
import { prisma, type DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { assertCan, invalidateGrantCache } from '../../platform/permissions.js';
import { auditWrite } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { governedWrite } from '../../platform/governedWrite.js';
import type { Reach } from './rules.js';

export interface CompileRule {
  resource: string;
  verbs: Verb[];
}

export interface CompilePlacement {
  verticalCode: string;
  /** The unit's code, or '' for the whole vertical. */
  unitCode: string;
  reach: Reach;
  /** The capability rules the placement's vertical, level and unit carry. */
  rules: CompileRule[];
}

export interface CompileInput {
  assignmentId: string;
  personId: string;
  placements: CompilePlacement[];
}

/** The Grant columns a compiled row writes, without tenantId. */
export interface GrantRowSpec {
  accessAssignmentId: string;
  principalType: 'individual';
  principalId: string;
  resource: string;
  verbs: Verb[];
  scope: Scope;
  scopeResolver: 'vertical' | null;
  conditions: { verticalCode?: string; unitCode?: string };
}

/**
 * Pure: the Grant rows a confirmed assignment compiles to.
 *
 * A company placement with a unit code compiles to no rows. Its company-wide grant
 * would drop the unit, so the unit narrowing is refused rather than silently widened.
 */
export function compileRows(input: CompileInput): GrantRowSpec[] {
  const out: GrantRowSpec[] = [];
  for (const p of input.placements) {
    if (p.reach === 'team' || p.reach === 'unit') continue;
    if (p.reach === 'company' && p.unitCode !== '') continue;
    const company = p.reach === 'company';
    for (const rule of p.rules) {
      if (rule.verbs.length === 0) continue;
      out.push({
        accessAssignmentId: input.assignmentId,
        principalType: 'individual',
        principalId: input.personId,
        resource: rule.resource,
        verbs: [...rule.verbs],
        scope: p.reach === 'own' ? 'own' : 'all',
        scopeResolver: company ? null : 'vertical',
        conditions: company
          ? {}
          : { verticalCode: p.verticalCode, ...(p.unitCode !== '' ? { unitCode: p.unitCode } : {}) },
      });
    }
  }
  return out;
}

/** Loads the compile input for one assignment: its placements and the rules each one carries. */
export async function loadCompileInput(tx: DbTx, assignmentId: string): Promise<CompileInput> {
  const assignment = await tx.accessAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    select: { personId: true },
  });
  const placements = await tx.accessPlacement.findMany({
    where: { assignmentId },
    select: {
      verticalId: true,
      levelId: true,
      unitCode: true,
      vertical: { select: { code: true } },
      level: { select: { reach: true } },
    },
  });
  const rules =
    placements.length === 0
      ? []
      : await tx.accessCapabilityRule.findMany({
          where: {
            OR: placements.map((p) => ({ verticalId: p.verticalId, levelId: p.levelId, unitCode: p.unitCode })),
          },
          select: { verticalId: true, levelId: true, unitCode: true, resource: true, verbs: true },
        });
  return {
    assignmentId,
    personId: assignment.personId,
    placements: placements.map((p) => ({
      verticalCode: p.vertical.code,
      unitCode: p.unitCode,
      reach: p.level.reach as Reach,
      rules: rules
        .filter((r) => r.verticalId === p.verticalId && r.levelId === p.levelId && r.unitCode === p.unitCode)
        .map((r) => ({ resource: r.resource, verbs: r.verbs as Verb[] })),
    })),
  };
}

/**
 * Replaces the assignment's tagged Grant rows with the rows its rules compile to now.
 * Only rows carrying this assignment's id are removed; role and individual grants,
 * and the rows of other assignments, are not read or written. Runs inside the caller's
 * transaction, so the rows and their audit and event commit together.
 */
export async function compileAssignmentTx(tx: DbTx, assignmentId: string): Promise<number> {
  const auth = currentAuth();
  const specs = compileRows(await loadCompileInput(tx, assignmentId));
  await removeCompiledGrantsTx(tx, assignmentId);
  for (const spec of specs) {
    const row = await tx.grant.create({ data: { tenantId: auth.tenantId, ...spec } });
    await auditWrite({
      action: 'create',
      subjectType: 'grant',
      subjectId: row.id,
      after: { resource: spec.resource, verbs: spec.verbs, scope: spec.scope, accessAssignmentId: assignmentId },
      meta: { accessAssignmentId: assignmentId },
      tx,
    });
  }
  await emit({
    name: EVENTS.ACCESS_ASSIGNMENT_COMPILED,
    subject: { entityType: 'access_assignment', entityId: assignmentId },
    newState: { grantRows: specs.length },
    reason: { note: `Compiled to ${specs.length} grant rows` },
    impact: { domains: ['gov'] },
    tx,
  });
  return specs.length;
}

/**
 * Removes the Grant rows an assignment compiled to, and nothing else. Used by expiry
 * inside its transaction, and by a recompile before it writes the new rows.
 */
export async function removeCompiledGrantsTx(tx: DbTx, assignmentId: string): Promise<number> {
  const auth = currentAuth();
  const gone = await tx.grant.findMany({
    where: { tenantId: auth.tenantId, accessAssignmentId: assignmentId },
    select: { id: true, resource: true, verbs: true, scope: true },
  });
  if (gone.length === 0) return 0;
  await tx.grant.deleteMany({ where: { tenantId: auth.tenantId, accessAssignmentId: assignmentId } });
  for (const row of gone) {
    await auditWrite({
      action: 'delete',
      subjectType: 'grant',
      subjectId: row.id,
      before: { resource: row.resource, verbs: row.verbs, scope: row.scope, accessAssignmentId: assignmentId },
      meta: { accessAssignmentId: assignmentId },
      tx,
    });
  }
  return gone.length;
}

/**
 * Recompiles one assignment in its own governed write, for maintenance and tests. The
 * caller must hold the edit verb on access assignments. The grant cache is cleared after
 * the commit, so the next evaluation sees the new rows.
 */
export async function recompileAssignment(assignmentId: string): Promise<number> {
  await assertCan({ resource: 'access_assignments', verb: 'edit' });
  const n = await governedWrite((tx) => compileAssignmentTx(tx, assignmentId));
  invalidateGrantCache();
  return n;
}

/**
 * Access grants whose resource has no vertical binding. Such a grant denies every
 * record it is checked against (fail closed); this lists them so a missing binding
 * shows up at startup rather than as a silent denial.
 */
export async function listUnboundVerticalGrants(): Promise<{ grantId: string; resource: string }[]> {
  const tenantId = currentAuth().tenantId;
  const grants = await prisma.grant.findMany({
    where: { tenantId, accessAssignmentId: { not: null }, scopeResolver: 'vertical' },
    select: { id: true, resource: true },
  });
  const resources = [...new Set(grants.map((g) => g.resource))];
  const bound = await prisma.accessResourceBinding.findMany({
    where: { tenantId, resource: { in: resources }, bindingKind: { in: ['field', 'fixed'] } },
    select: { resource: true },
  });
  const boundSet = new Set(bound.map((b) => b.resource));
  return grants.filter((g) => !boundSet.has(g.resource)).map((g) => ({ grantId: g.id, resource: g.resource }));
}
