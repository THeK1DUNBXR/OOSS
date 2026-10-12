/**
 * Access-model fixtures (ACCESS-MODEL-PLAN s.11: "fixtures create verticals,
 * levels and assignments as data through factories").
 *
 * Rows are written with the owner client, as the seed writes them. That is
 * the point: the factories set up the state a test starts from, and the
 * behaviour under test is the domain command, not the fixture. Codes carry a
 * random suffix so reruns against the same database do not collide on the
 * immutable keys.
 */

import type { SensitivityClass } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';
import type { AuthContext } from '../../platform/context.js';
import { principalFor } from '../helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

/** An uppercase code that is unique enough per run: a letter, then A-Z0-9. */
export function uniqCode(prefix: string): string {
  const rand = Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X');
  return `${prefix}${rand}`;
}

/** A rank no other test row in the tenant is likely to hold. */
export function uniqRank(): number {
  return 100_000 + Math.floor(Math.random() * 900_000_000);
}

export async function chairmanPartyId(): Promise<string> {
  return (await principalFor(CHAIRMAN)).partyId;
}

export async function makePerson(tenantId: string, label = 'Access Test'): Promise<{ id: string }> {
  const suffix = uniqCode('');
  return unscopedPrisma.person.create({
    data: {
      tenantId,
      recordCode: `PER-ACC-${suffix}`,
      fullName: `${label} ${suffix}`,
      primaryEmail: `acc-${suffix.toLowerCase()}@access.example`,
      primaryEmailNormalised: `acc-${suffix.toLowerCase()}@access.example`,
    },
    select: { id: true },
  });
}

/**
 * A grant held by one person directly (principalType `individual`), without a
 * role. It is how a test gives an HR-like person the verbs it needs, and it is
 * the same row shape the PR11b compile will write.
 */
export async function grantIndividual(
  tenantId: string,
  partyId: string,
  resource: string,
  verbs: string[],
  scope: 'own' | 'own_or_unowned' | 'all' = 'all',
): Promise<void> {
  await unscopedPrisma.grant.create({
    data: {
      tenantId,
      principalType: 'individual',
      principalId: partyId,
      resource,
      verbs,
      scope,
    },
  });
}

/** The auth context of a person who holds no role: only individual grants apply. */
export function authOf(tenantId: string, partyId: string): AuthContext {
  return {
    tenantId,
    principalType: 'human',
    partyId,
    userId: null,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: null,
    roleSlug: null,
    branch: null,
    orgUnitId: null,
    classificationCeiling: 'internal' as SensitivityClass,
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
}

export async function makeVertical(
  tenantId: string,
  kind: 'business' | 'shared' = 'shared',
  code = uniqCode('V'),
): Promise<{ id: string; code: string }> {
  return unscopedPrisma.accessVertical.create({
    data: { tenantId, code, name: `Vertical ${code}`, kind, businessLineId: null },
    select: { id: true, code: true },
  });
}

export async function makeLevel(
  tenantId: string,
  reach: 'own' | 'team' | 'unit' | 'vertical' | 'company',
  code = uniqCode('L'),
): Promise<{ id: string; code: string }> {
  return unscopedPrisma.accessLevel.create({
    data: { tenantId, code, name: `Level ${code}`, rank: uniqRank(), reach },
    select: { id: true, code: true },
  });
}

export async function makeLevelLimit(
  tenantId: string,
  levelId: string,
  authorityClass: string,
  limitMinor: bigint,
): Promise<{ id: string }> {
  return unscopedPrisma.accessLevelLimit.create({
    data: { tenantId, levelId, authorityClass, limitMinor, currency: 'INR' },
    select: { id: true },
  });
}

export async function makeCapabilityRule(
  tenantId: string,
  verticalId: string,
  levelId: string,
  resource: string,
  verbs: string[],
  unitCode = '',
): Promise<{ id: string }> {
  return unscopedPrisma.accessCapabilityRule.create({
    data: { tenantId, verticalId, levelId, unitCode, resource, verbs },
    select: { id: true },
  });
}

export async function makeResourceBinding(
  tenantId: string,
  resource: string,
  bindingKind: 'field' | 'fixed' | 'derived' | 'none' = 'none',
  opts: { column?: string; verticalId?: string } = {},
): Promise<{ id: string }> {
  return unscopedPrisma.accessResourceBinding.create({
    data: { tenantId, resource, bindingKind, column: opts.column ?? null, verticalId: opts.verticalId ?? null },
    select: { id: true },
  });
}

/**
 * A confirmed placement, written as data. The suggester and the confirmer are
 * the same person here because the row is a fixture, not a decision; the
 * commands under test never see this shortcut.
 */
export async function makeConfirmedPlacement(
  tenantId: string,
  personId: string,
  verticalId: string,
  levelId: string,
  unitCode: string | null = null,
): Promise<{ assignmentId: string }> {
  const now = new Date();
  const assignment = await unscopedPrisma.accessAssignment.create({
    data: {
      tenantId,
      personId,
      identityType: 'employee',
      status: 'confirmed',
      suggestedById: personId,
      suggestedAt: now,
      confirmedById: personId,
      confirmedAt: now,
      reason: 'factory: confirmed placement',
    },
    select: { id: true },
  });
  await unscopedPrisma.accessPlacement.create({
    data: { tenantId, assignmentId: assignment.id, personId, verticalId, levelId, unitCode: unitCode ?? '' },
  });
  return { assignmentId: assignment.id };
}

/** Puts `chairman@kaizen.co.in` on the company-reach level, so the founder rules see a founder. */
export async function makeFounderPlacement(tenantId: string, partyId: string): Promise<void> {
  const vertical = await makeVertical(tenantId, 'shared');
  const level = await makeLevel(tenantId, 'company');
  await makeConfirmedPlacement(tenantId, partyId, vertical.id, level.id);
}

/**
 * A grant in the row shape PR11b's compile writes for a confirmed placement: an
 * individual grant tagged with its assignment, scope resolver `vertical`, and the
 * vertical (and unit) in its conditions. The scope tests use it so they do not depend
 * on the compile; the compile tests go through confirm and recompile instead.
 */
export async function grantVertical(opts: {
  tenantId: string;
  partyId: string;
  resource: string;
  verbs: string[];
  scope: 'own' | 'all';
  verticalCode: string;
  unitCode?: string;
}): Promise<{ assignmentId: string }> {
  const level = await makeLevel(opts.tenantId, opts.scope === 'all' ? 'vertical' : 'own');
  const vertical = await unscopedPrisma.accessVertical.findFirstOrThrow({
    where: { tenantId: opts.tenantId, code: opts.verticalCode },
    select: { id: true },
  });
  const { assignmentId } = await makeConfirmedPlacement(
    opts.tenantId,
    opts.partyId,
    vertical.id,
    level.id,
    opts.unitCode ?? null,
  );
  await unscopedPrisma.grant.create({
    data: {
      tenantId: opts.tenantId,
      principalType: 'individual',
      principalId: opts.partyId,
      resource: opts.resource,
      verbs: opts.verbs,
      scope: opts.scope,
      scopeResolver: 'vertical',
      conditions: { verticalCode: opts.verticalCode, ...(opts.unitCode ? { unitCode: opts.unitCode } : {}) },
      accessAssignmentId: assignmentId,
    },
  });
  return { assignmentId };
}
