/**
 * The permission layer failed open in three places. Each test here is the
 * input that used to get through:
 *
 *  - An own-scoped grant held by a principal with no party (an agent) built a
 *    filter of `{ ownerPartyId: null }`, which is exactly the set of unowned
 *    rows. The fix is the unsatisfiable filter visibilityWhere already uses.
 *  - A field nobody classified passed at any ceiling, including `public`, when
 *    a route called applyFieldVisibility without an unclassifiedAs default.
 *  - A roleSlug that names no defined role was given the `internal` ceiling
 *    rather than the lowest one. A missing role is no role (rolelessAccess).
 *
 * Real Postgres throughout: the scope tests run the filter the list endpoints
 * would run, against rows that exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentContext } from '../platform/context.js';
import { applyFieldVisibility, evaluate, scopeWhere } from '../platform/permissions.js';
import type { AuthContext } from '../platform/context.js';
import { ceilingForRole } from '../lib/http.js';
import { asPrincipal, unscopedPrisma } from './helpers.js';

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TENANT_SLUG = `fc-perm-${stamp}`;
const OWNER = `party-owner-${stamp}`;

let tenantId: string;
let ownedPlanId: string;
let unownedPlanId: string;

beforeAll(async () => {
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `FailClosed ${stamp}`, slug: TENANT_SLUG } });
  tenantId = tenant.id;

  const base = {
    tenantId,
    applicationName: 'Fixture app',
    applicationTier: 2,
    rtoMinutes: 60,
    rpoMinutes: 15,
    backupMethod: 'snapshot',
    backupFrequency: 'daily',
    testCadenceDays: 90,
  };
  const owned = await unscopedPrisma.itContinuityPlan.create({
    data: { ...base, recordCode: `FC-OWN-${stamp}`, applicationId: `app-own-${stamp}`, ownerPartyId: OWNER },
  });
  const unowned = await unscopedPrisma.itContinuityPlan.create({
    data: { ...base, recordCode: `FC-UNOWN-${stamp}`, applicationId: `app-unown-${stamp}`, ownerPartyId: null },
  });
  ownedPlanId = owned.id;
  unownedPlanId = unowned.id;
});

afterAll(async () => {
  // Grants reference roles, so they go first; the tenant is last.
  await unscopedPrisma.grant.deleteMany({ where: { tenantId } });
  await unscopedPrisma.accessRole.deleteMany({ where: { tenantId } });
  await unscopedPrisma.itContinuityPlan.deleteMany({ where: { tenantId } });
  await unscopedPrisma.tenant.deleteMany({ where: { id: tenantId } });
});

async function listPlanIds(where: Record<string, unknown>): Promise<string[]> {
  const rows = await unscopedPrisma.itContinuityPlan.findMany({ where: { tenantId, ...where }, select: { id: true } });
  return rows.map((r) => r.id);
}

describe('an own-scoped grant never reaches unowned rows', () => {
  it('an agent principal (no party) with an own grant sees zero unowned rows', async () => {
    const agent = agentContext(tenantId, `agt-${stamp}`).auth!;
    expect(agent.partyId).toBeNull();

    const ids = await listPlanIds(scopeWhere('own', agent, 'ownerPartyId'));
    expect(ids).not.toContain(unownedPlanId);
    expect(ids).toEqual([]);
  });

  it('an agent principal with an own_or_unowned grant and no branch sees zero unowned rows', async () => {
    const agent = agentContext(tenantId, `agt-${stamp}`).auth!;
    const ids = await listPlanIds(scopeWhere('own_or_unowned', agent, 'ownerPartyId'));
    expect(ids).not.toContain(unownedPlanId);
  });

  it('a human with own_or_unowned and no branch sees their own rows but not unowned ones', async () => {
    const human = {
      ...agentContext(tenantId, 'unused').auth!,
      principalType: 'human' as const,
      partyId: OWNER,
      branch: null,
    };
    const ids = await listPlanIds(scopeWhere('own_or_unowned', human, 'ownerPartyId'));
    expect(ids).toContain(ownedPlanId);
    expect(ids).not.toContain(unownedPlanId);
  });
});

describe('an unclassified field is withheld at every ceiling', () => {
  it('a public-ceiling caller does not receive a field nobody classified', () => {
    const { data, withheld } = applyFieldVisibility(
      { unclassifiedThing: 'visible?' },
      { canSeeMoney: false, ceiling: 'public' },
    );
    expect(data.unclassifiedThing ?? null).toBeNull();
    expect(withheld.map((w) => w.path)).toContain('unclassifiedThing');
  });
});

describe('a roleSlug that names no defined role gets the lowest ceiling', () => {
  it('a dangling roleSlug resolves to public, not internal', async () => {
    expect(await ceilingForRole(tenantId, `ghost-role-${stamp}`)).toBe('public');
  });

  it('a null roleSlug resolves to public', async () => {
    expect(await ceilingForRole(tenantId, null)).toBe('public');
  });

  it('a defined tenant role keeps its own ceiling', async () => {
    const role = await unscopedPrisma.accessRole.create({
      data: { tenantId, slug: `fc-role-${stamp}`, name: 'FC', classificationCeiling: 'confidential', isSystem: false },
    });
    expect(await ceilingForRole(tenantId, `fc-role-${stamp}`)).toBe('confidential');
    await unscopedPrisma.accessRole.delete({ where: { id: role.id } });
  });
});

describe('the single-record check and the list filter give the same answer', () => {
  const cases: Array<{ scope: 'own' | 'own_or_unowned'; partyId: string | null; branch: string | null }> = [
    { scope: 'own', partyId: null, branch: null },
    { scope: 'own', partyId: OWNER, branch: null },
    { scope: 'own_or_unowned', partyId: null, branch: null },
    { scope: 'own_or_unowned', partyId: OWNER, branch: null },
  ];

  cases.forEach((c, i) => {
    it(`${c.scope}, party ${c.partyId ? 'set' : 'null'}, branch ${c.branch ?? 'null'}`, async () => {
      const slug = `fc-agree-${stamp}-${i}`;
      const role = await unscopedPrisma.accessRole.create({
        data: { tenantId, slug, name: slug, classificationCeiling: 'internal', isSystem: false },
      });
      await unscopedPrisma.grant.create({
        data: {
          tenantId,
          principalType: 'role',
          roleId: role.id,
          resource: 'it_continuity_plan',
          verbs: ['view'],
          scope: c.scope,
        },
      });
      const auth: AuthContext = {
        ...agentContext(tenantId, `agt-${stamp}`).auth!,
        principalType: 'human',
        agentId: null,
        roleSlug: slug,
        partyId: c.partyId,
        branch: c.branch,
      };

      const listed = await listPlanIds(scopeWhere(c.scope, auth, 'ownerPartyId'));
      const rows: Array<[string, string | null]> = [
        [ownedPlanId, OWNER],
        [unownedPlanId, null],
      ];
      for (const [id, owner] of rows) {
        const decision = await asPrincipal(auth, () =>
          evaluate({
            resource: 'it_continuity_plan',
            verb: 'view',
            record: { ownerPartyId: owner, branch: null },
            auth,
          }),
        );
        expect(decision.allowed, `single-record decision for row ${id}`).toBe(listed.includes(id));
      }
    });
  });

  it('an unowned row with no branch is refused to a branch-holding caller by the evaluator', async () => {
    const slug = `fc-agree-branch-${stamp}`;
    const role = await unscopedPrisma.accessRole.create({
      data: { tenantId, slug, name: slug, classificationCeiling: 'internal', isSystem: false },
    });
    await unscopedPrisma.grant.create({
      data: {
        tenantId,
        principalType: 'role',
        roleId: role.id,
        resource: 'it_continuity_plan',
        verbs: ['view'],
        scope: 'own_or_unowned',
      },
    });
    const auth: AuthContext = {
      ...agentContext(tenantId, `agt-${stamp}`).auth!,
      principalType: 'human',
      agentId: null,
      roleSlug: slug,
      partyId: OWNER,
      branch: 'Chennai',
    };
    // The filter's unowned clause is `{ owner: null, branch: 'Chennai' }`. In
    // SQL that never matches a row whose branch is NULL. No model in the schema
    // has both an owner and a branch column, so this half of the matrix is
    // checked against the evaluator alone.
    const decision = await asPrincipal(auth, () =>
      evaluate({
        resource: 'it_continuity_plan',
        verb: 'view',
        record: { ownerPartyId: null, branch: null },
        auth,
      }),
    );
    expect(decision.allowed).toBe(false);
  });
});
