/**
 * PR11b: compiling confirmed assignments into tagged Grant rows (ACCESS-MODEL-PLAN
 * s.4, s.5, s.11; P11-DESIGN c, e tests 5, 7-11).
 *
 * Real Postgres, real contexts, no mocks. Confirmations go through confirmAssignment
 * as the people who would make them. Red on the base: the confirm seam writes nothing,
 * so the grants these tests look for are never there.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { runWithContext, newRequestContext } from '../platform/context.js';
import { can, evaluate } from '../platform/permissions.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { confirmAssignment, expireAssignment, suggestAssignment } from '../domains/access/assignments.js';
import { compileRows, recompileAssignment, type CompileInput } from '../domains/access/compile.js';
import { asPrincipal, asUser, expectReject, principalFor, tenantId } from './helpers.js';
import {
  authOf,
  grantIndividual,
  makeCapabilityRule,
  makeConfirmedPlacement,
  makeFounderPlacement,
  makeLevel,
  makePerson,
  makeResourceBinding,
  makeVertical,
  uniqCode,
} from './access/factories.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

let tid: string;
let founderId: string;

/** A person who suggests assignments (the answerer). Holds the verbs and nothing else. */
async function makeSuggester(): Promise<string> {
  const p = await makePerson(tid, 'Answerer');
  await grantIndividual(tid, p.id, 'access_assignments', ['view', 'create', 'edit', 'approve'], 'all');
  return p.id;
}

async function suggestAs(suggesterId: string, personId: string, verticalCode: string, levelCode: string) {
  return asPrincipal(authOf(tid, suggesterId), () =>
    suggestAssignment({
      personId,
      identityType: 'employee',
      placements: [{ verticalCode, levelCode, unitCode: null }],
      reason: 'PR11b compile test',
    }),
  );
}

/** Runs `fn` in a request context without clearing the grant cache, as a second request would see it. */
function withoutCacheReset<T>(auth: ReturnType<typeof authOf>, fn: () => Promise<T>): Promise<T> {
  return runWithContext(newRequestContext({ auth }), fn);
}

async function taggedGrants(assignmentId: string) {
  return unscopedPrisma.grant.findMany({
    where: { tenantId: tid, accessAssignmentId: assignmentId },
    select: { id: true, principalId: true, resource: true, scope: true, scopeResolver: true, conditions: true },
  });
}

const expectedReach = (reach: string, inVertical: boolean, mine: boolean): boolean => {
  switch (reach) {
    case 'own':
      return inVertical && mine;
    case 'vertical':
      return inVertical;
    case 'company':
      return true;
    default:
      return false; // team and unit reach compile to no rows (O6): fail closed
  }
};

beforeAll(async () => {
  tid = await tenantId();
  await addMissingGrants(tid);
  founderId = (await principalFor(CHAIRMAN)).partyId;
  await makeFounderPlacement(tid, founderId);
});

describe('PR11b compile: pure rows (design test 7)', () => {
  it('7: team and unit reach compile to no rows; own reach compiles to a vertical-resolved row', () => {
    const base = (reach: CompileInput['placements'][number]['reach']): CompileInput => ({
      assignmentId: 'A-1',
      personId: 'P-1',
      placements: [{ verticalCode: 'VX', unitCode: '', reach, rules: [{ resource: 'res', verbs: ['view'] }] }],
    });
    expect(compileRows(base('team'))).toEqual([]);
    expect(compileRows(base('unit'))).toEqual([]);
    expect(compileRows(base('own'))).toEqual([
      {
        accessAssignmentId: 'A-1',
        principalType: 'individual',
        principalId: 'P-1',
        resource: 'res',
        verbs: ['view'],
        scope: 'own',
        scopeResolver: 'vertical',
        conditions: { verticalCode: 'VX' },
      },
    ]);
  });
});

describe('PR11b compile: the reach matrix (design test 5)', () => {
  it('5: each reach grants exactly the records AMP s.4 says it reaches', async () => {
    const resource = `mx_${uniqCode('')}`;
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    for (const reach of ['own', 'team', 'unit', 'vertical', 'company'] as const) {
      const v = await makeVertical(tid, 'shared');
      const other = await makeVertical(tid, 'shared');
      const level = await makeLevel(tid, reach);
      await makeCapabilityRule(tid, v.id, level.id, resource, ['view']);
      const holder = await makePerson(tid, 'Holder');
      const stranger = await makePerson(tid, 'Stranger');
      const { assignmentId } = await makeConfirmedPlacement(tid, holder.id, v.id, level.id);
      await asUser(CHAIRMAN, () => recompileAssignment(assignmentId));

      const auth = authOf(tid, holder.id);
      for (const inVertical of [true, false]) {
        for (const mine of [true, false]) {
          const record = {
            ownerPartyId: mine ? holder.id : stranger.id,
            verticalCode: inVertical ? v.code : other.code,
          };
          const d = await asPrincipal(auth, () => evaluate({ resource, verb: 'view', record, auth }));
          expect(d.allowed, `${reach} inVertical=${inVertical} mine=${mine}`).toBe(
            expectedReach(reach, inVertical, mine),
          );
        }
      }
    }
  });

  it('5b: a unit placement reaches its unit inside the vertical and nothing outside it', async () => {
    const resource = `mu_${uniqCode('')}`;
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const v = await makeVertical(tid, 'shared');
    const level = await makeLevel(tid, 'vertical');
    await makeCapabilityRule(tid, v.id, level.id, resource, ['view'], 'U-1');
    const holder = await makePerson(tid, 'Unit holder');
    const { assignmentId } = await makeConfirmedPlacement(tid, holder.id, v.id, level.id, 'U-1');
    await asUser(CHAIRMAN, () => recompileAssignment(assignmentId));
    const auth = authOf(tid, holder.id);
    const decide = (unitCode?: string) =>
      asPrincipal(auth, () =>
        evaluate({
          resource,
          verb: 'view',
          record: { ownerPartyId: 'someone-else', verticalCode: v.code, unitCode },
          auth,
        }),
      );
    expect((await decide('U-1')).allowed).toBe(true);
    expect((await decide('U-2')).allowed).toBe(false);
    expect((await decide(undefined)).allowed).toBe(false);
  });
});

describe('PR11b compile: recompile and expiry touch only tagged rows (design test 8)', () => {
  it('8: a recompile and an expiry leave role and other-assignment grants alone', async () => {
    const resource = `rc_${uniqCode('')}`;
    const suggester = await makeSuggester();
    const v1 = await makeVertical(tid, 'shared');
    const v2 = await makeVertical(tid, 'shared');
    const own1 = await makeLevel(tid, 'own');
    const own2 = await makeLevel(tid, 'own');
    await makeCapabilityRule(tid, v1.id, own1.id, resource, ['view']);
    await makeCapabilityRule(tid, v2.id, own2.id, resource, ['view']);
    const person = await makePerson(tid, 'Compiled');
    // A legacy grant on the same resource, with no assignment tag.
    const legacy = await unscopedPrisma.grant.create({
      data: {
        tenantId: tid,
        principalType: 'individual',
        principalId: person.id,
        resource,
        verbs: ['view'],
        scope: 'all',
      },
      select: { id: true },
    });

    const a = await suggestAs(suggester, person.id, v1.code, own1.code);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: a.id, reason: 'PR11b test 8, first' }));
    const b = await suggestAs(suggester, person.id, v2.code, own2.code);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: b.id, reason: 'PR11b test 8, second' }));

    expect((await taggedGrants(a.id)).length).toBe(1);
    expect((await taggedGrants(b.id)).length).toBe(1);

    await asUser(CHAIRMAN, () => recompileAssignment(a.id));
    expect((await taggedGrants(a.id)).length).toBe(1);
    expect((await taggedGrants(b.id)).length).toBe(1);

    await asUser(CHAIRMAN, () => expireAssignment({ assignmentId: a.id, reason: 'PR11b test 8, expiry' }));
    expect((await taggedGrants(a.id)).length).toBe(0);
    expect((await taggedGrants(b.id)).length).toBe(1);
    expect(await unscopedPrisma.grant.findUnique({ where: { id: legacy.id }, select: { id: true } })).not.toBeNull();
  });
});

describe('PR11b compile: confirmation is bounded by the confirmer (design test 9)', () => {
  it('9: the founder cannot confirm a grant on a resource the founder does not hold', async () => {
    // A resource no role holds: the founder's own grants do not cover it, so confirming
    // a vertical placement that compiles to it must be refused and leave no rows behind.
    const resource = `uncov_${uniqCode('')}`;
    const suggester = await makeSuggester();
    const v = await makeVertical(tid, 'shared');
    const level = await makeLevel(tid, 'vertical');
    await makeCapabilityRule(tid, v.id, level.id, resource, ['approve']);
    const person = await makePerson(tid, 'Uncovered');
    const a = await suggestAs(suggester, person.id, v.code, level.code);

    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => confirmAssignment({ assignmentId: a.id, reason: 'PR11b test 9' })),
    );
    expect(err.status).toBe(403);
    const row = await unscopedPrisma.accessAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('suggested');
    expect(await taggedGrants(a.id)).toEqual([]);
  });
});

describe('PR11b compile: the cache (design test 10)', () => {
  it('10: a confirmation is visible to the next evaluation without waiting out the grant cache', async () => {
    const suggester = await makeSuggester();
    const v = await makeVertical(tid, 'shared');
    const level = await makeLevel(tid, 'vertical');
    // access_model is in the founder's role, so the founder covers the compiled grant.
    await makeCapabilityRule(tid, v.id, level.id, 'access_model', ['view']);
    const person = await makePerson(tid, 'Cache');
    const auth = authOf(tid, person.id);
    const a = await suggestAs(suggester, person.id, v.code, level.code);

    expect(await withoutCacheReset(auth, () => can({ resource: 'access_model', verb: 'view' }))).toBe(false);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: a.id, reason: 'PR11b test 10' }));
    expect(await withoutCacheReset(auth, () => can({ resource: 'access_model', verb: 'view' }))).toBe(true);
  });
});

describe('PR11b compile: unions and no leak across assignments (design test 11)', () => {
  it('11: two placements union; an assignment compiles only its own rows', async () => {
    const resource = `un_${uniqCode('')}`;
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const suggester = await makeSuggester();
    const sv = await makeVertical(tid, 'shared');
    const ov = await makeVertical(tid, 'shared');
    const outside = await makeVertical(tid, 'shared');
    const levelA = await makeLevel(tid, 'own');
    const levelB = await makeLevel(tid, 'own');
    await makeCapabilityRule(tid, sv.id, levelA.id, resource, ['view']);
    await makeCapabilityRule(tid, ov.id, levelB.id, resource, ['view']);

    const holder = await makePerson(tid, 'Two placements');
    const other = await makePerson(tid, 'Other');
    const a1 = await suggestAs(suggester, holder.id, sv.code, levelA.code);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: a1.id, reason: 'PR11b test 11, first' }));
    const a2 = await suggestAs(suggester, holder.id, ov.code, levelB.code);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: a2.id, reason: 'PR11b test 11, second' }));
    const a3 = await suggestAs(suggester, other.id, sv.code, levelA.code);
    await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: a3.id, reason: 'PR11b test 11, other person' }));

    const rows1 = await taggedGrants(a1.id);
    const rows2 = await taggedGrants(a2.id);
    expect(rows1.map((r) => r.principalId)).toEqual([holder.id]);
    expect(rows2.map((r) => r.principalId)).toEqual([holder.id]);
    expect((await taggedGrants(a3.id)).map((r) => r.principalId)).toEqual([other.id]);

    const auth = authOf(tid, holder.id);
    const decide = (record: { ownerPartyId: string; verticalCode: string }) =>
      asPrincipal(auth, () => evaluate({ resource, verb: 'view', record, auth }));
    expect((await decide({ ownerPartyId: other.id, verticalCode: sv.code })).allowed).toBe(false);
    expect((await decide({ ownerPartyId: holder.id, verticalCode: sv.code })).allowed).toBe(true);
    expect((await decide({ ownerPartyId: holder.id, verticalCode: ov.code })).allowed).toBe(true);
    expect((await decide({ ownerPartyId: other.id, verticalCode: ov.code })).allowed).toBe(false);
    expect((await decide({ ownerPartyId: holder.id, verticalCode: outside.code })).allowed).toBe(false);
  });
});
