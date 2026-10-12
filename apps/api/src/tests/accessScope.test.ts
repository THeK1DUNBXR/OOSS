/**
 * PR11b: the scope axis, and the guarantee that legacy grants are untouched by the
 * access-model branches (P11-DESIGN c, e; ACCESS-MODEL-PLAN s.4, s.11).
 *
 * The characterisation block below pins what evaluate, scopeWhere and visibilityWhere
 * return for legacy grants (individual grants with no assignment tag). It was written
 * and run green before any PR11b code, and it must stay green: a change that alters a
 * legacy answer is a regression, not a feature.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { assertScopeAll, evaluate, scopeWhere, visibilityWhere } from '../platform/permissions.js';
import type { AuthContext } from '../platform/context.js';
import { unscopedPrisma } from '../platform/db.js';
import { asPrincipal, expectReject, tenantId } from './helpers.js';
import {
  authOf,
  grantIndividual,
  grantVertical,
  makePerson,
  makeResourceBinding,
  makeVertical,
  uniqCode,
} from './access/factories.js';

let tid: string;

const resourceName = () => `char_${uniqCode('')}`;

describe('PR11b characterisation: legacy grants (design test 12)', () => {
  it('scopeWhere returns the same fragment for each legacy scope', async () => {
    tid = await tenantId();
    const base = authOf(tid, 'P-1');
    expect(scopeWhere('all', base)).toEqual({});
    expect(scopeWhere('own', base)).toEqual({ ownerPartyId: 'P-1' });
    expect(scopeWhere('own', base, 'personId')).toEqual({ personId: 'P-1' });
    // No branch on the caller: an unowned row is unreachable, so the fragment is the owner alone.
    expect(scopeWhere('own_or_unowned', base)).toEqual({ ownerPartyId: 'P-1' });
    const branched: AuthContext = { ...base, branch: 'B1' };
    expect(scopeWhere('own_or_unowned', branched)).toEqual({
      OR: [{ ownerPartyId: 'P-1' }, { ownerPartyId: null, branch: 'B1' }],
    });
    // An agent with no party owns nothing: the fragment matches no row.
    const noParty: AuthContext = { ...base, partyId: null };
    expect(scopeWhere('own', noParty)).toEqual({ ownerPartyId: { in: [] } });
  });

  it('visibilityWhere returns the same fragment for each legacy grant', async () => {
    tid = tid ?? (await tenantId());
    const resource = resourceName();
    const owner = await makePerson(tid);
    const auth = authOf(tid, owner.id);
    const where = (r: string) => asPrincipal(auth, () => visibilityWhere(r, 'ownerPartyId', auth));
    expect(await where(resource)).toEqual({ ownerPartyId: { in: [] } });

    await grantIndividual(tid, owner.id, resource, ['view'], 'own');
    expect(await where(resource)).toEqual({ ownerPartyId: owner.id });

    const widerResource = resourceName();
    await grantIndividual(tid, owner.id, widerResource, ['view'], 'all');
    expect(await where(widerResource)).toEqual({});
  });

  it('evaluate returns the same decision for each legacy grant', async () => {
    tid = tid ?? (await tenantId());
    const resource = resourceName();
    const holder = await makePerson(tid);
    const stranger = await makePerson(tid);
    const auth = authOf(tid, holder.id);
    await grantIndividual(tid, holder.id, resource, ['view'], 'own');

    const ev = (input: Parameters<typeof evaluate>[0]) => asPrincipal(auth, () => evaluate(input));
    const none = await ev({ resource: 'never_granted', verb: 'view', auth });
    expect(none.allowed).toBe(false);
    expect(none.deniedBy).toBe('WHO');
    expect(none.reasonCode).toBe('no_permission');

    const mine = await ev({ resource, verb: 'view', record: { ownerPartyId: holder.id }, auth });
    expect(mine.allowed).toBe(true);
    expect(mine.axes.find((a) => a.axis === 'WHO')?.reason).toBe(`${resource}:view@own`);

    const theirs = await ev({ resource, verb: 'view', record: { ownerPartyId: stranger.id }, auth });
    expect(theirs.allowed).toBe(false);
    expect(theirs.deniedBy).toBe('WHERE');
    expect(theirs.reasonCode).toBe('out_of_scope');

    const wrongVerb = await ev({ resource, verb: 'edit', record: { ownerPartyId: holder.id }, auth });
    expect(wrongVerb.deniedBy).toBe('WHO');
    expect(wrongVerb.reasonCode).toBe('no_permission');
  });
});

/**
 * PR11b scope tests (P11-DESIGN c, e tests 1-4 and 6). Each one is red on the base:
 * the access-grant branches do not exist yet, so a vertical grant is read as the
 * legacy grant it looks like. Grants are written in the compile's row shape, so the
 * scope axis is tested on its own, before the compile is in place.
 */
describe('PR11b scope: vertical access grants', () => {
  beforeAll(async () => {
    tid = tid ?? (await tenantId());
  });

  it('T1: a vertical Head is not company-wide, so an aggregate refuses it', async () => {
    const resource = resourceName();
    const company = resourceName();
    const v = await makeVertical(tid, 'shared');
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const head = await makePerson(tid, 'Head');
    await grantVertical({
      tenantId: tid,
      partyId: head.id,
      resource,
      verbs: ['view'],
      scope: 'all',
      verticalCode: v.code,
    });
    await grantIndividual(tid, head.id, company, ['view'], 'all');
    const auth = authOf(tid, head.id);
    await asPrincipal(auth, async () => {
      await assertScopeAll(company, 'view', auth);
      const err = await expectReject(() => assertScopeAll(resource, 'view', auth));
      expect(err.status).toBe(403);
    });
  });

  it('T2: an owner-only vertical grant on a resource with no binding is denied', async () => {
    const resource = resourceName();
    const v = await makeVertical(tid, 'shared');
    const p = await makePerson(tid);
    await grantVertical({
      tenantId: tid,
      partyId: p.id,
      resource,
      verbs: ['view'],
      scope: 'own',
      verticalCode: v.code,
    });
    const auth = authOf(tid, p.id);
    const decision = await asPrincipal(auth, () =>
      evaluate({ resource, verb: 'view', record: { ownerPartyId: p.id, verticalCode: v.code }, auth }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe('WHERE');
  });

  it("T3: a Head's list is narrowed to the rows in its vertical", async () => {
    const resource = resourceName();
    const inV = await makeVertical(tid, 'shared');
    const outV = await makeVertical(tid, 'shared');
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const head = await makePerson(tid, 'Head');
    const auth = authOf(tid, head.id);
    await grantVertical({
      tenantId: tid,
      partyId: head.id,
      resource,
      verbs: ['view'],
      scope: 'all',
      verticalCode: inV.code,
    });
    const inRow = await unscopedPrisma.orgUnit.create({
      data: { tenantId: tid, name: `in ${inV.code}`, division: inV.code },
      select: { id: true },
    });
    const outRow = await unscopedPrisma.orgUnit.create({
      data: { tenantId: tid, name: `out ${outV.code}`, division: outV.code },
      select: { id: true },
    });
    const where = await asPrincipal(auth, () => visibilityWhere(resource, 'id', auth));
    const listed = await unscopedPrisma.orgUnit.findMany({
      where: { AND: [{ tenantId: tid, id: { in: [inRow.id, outRow.id] } }, where] },
      select: { id: true },
    });
    expect(listed.map((r) => r.id)).toEqual([inRow.id]);
  });

  it('T4: staff see their own rows in their vertical, and no one else in it or any other', async () => {
    const resource = resourceName();
    const v = await makeVertical(tid, 'shared');
    const other = await makeVertical(tid, 'shared');
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const staff = await makePerson(tid, 'Staff');
    const colleague = await makePerson(tid, 'Colleague');
    const auth = authOf(tid, staff.id);
    await grantVertical({
      tenantId: tid,
      partyId: staff.id,
      resource,
      verbs: ['view'],
      scope: 'own',
      verticalCode: v.code,
    });
    const ev = (record: { ownerPartyId: string; verticalCode: string }) =>
      asPrincipal(auth, () => evaluate({ resource, verb: 'view', record, auth }));
    expect((await ev({ ownerPartyId: staff.id, verticalCode: v.code })).allowed).toBe(true);
    expect((await ev({ ownerPartyId: staff.id, verticalCode: other.code })).allowed).toBe(false);
    expect((await ev({ ownerPartyId: colleague.id, verticalCode: v.code })).allowed).toBe(false);
  });

  it.each([
    ['no binding', null],
    ['a derived binding', 'derived'],
    ['a none binding', 'none'],
  ] as const)('T6: fails closed on read, list, create and update with %s', async (_label, kind) => {
    const resource = resourceName();
    const v = await makeVertical(tid, 'shared');
    if (kind) await makeResourceBinding(tid, resource, kind);
    const head = await makePerson(tid, 'Head');
    const auth = authOf(tid, head.id);
    await grantVertical({
      tenantId: tid,
      partyId: head.id,
      resource,
      verbs: ['view', 'create', 'edit'],
      scope: 'all',
      verticalCode: v.code,
    });
    const record = { ownerPartyId: head.id, verticalCode: v.code };
    for (const verb of ['view', 'create', 'edit'] as const) {
      const d = await asPrincipal(auth, () => evaluate({ resource, verb, record, auth }));
      expect(d.allowed, verb).toBe(false);
    }
    const where = await asPrincipal(auth, () => visibilityWhere(resource, 'id', auth));
    const row = await unscopedPrisma.orgUnit.create({
      data: { tenantId: tid, name: `row ${v.code}`, division: v.code },
      select: { id: true },
    });
    const listed = await unscopedPrisma.orgUnit.findMany({
      where: { AND: [{ tenantId: tid, id: row.id }, where] },
      select: { id: true },
    });
    expect(listed).toEqual([]);
  });

  it('T5: a unit-narrowed grant denies a record in that unit, as its list does', async () => {
    // No resource carries a unit binding yet (O6), so a unit-narrowed grant reaches nothing:
    // the record check and the list filter must both say no.
    const resource = resourceName();
    const v = await makeVertical(tid, 'shared');
    await makeResourceBinding(tid, resource, 'field', { column: 'division' });
    const head = await makePerson(tid, 'Unit head');
    const auth = authOf(tid, head.id);
    await grantVertical({
      tenantId: tid,
      partyId: head.id,
      resource,
      verbs: ['view'],
      scope: 'all',
      verticalCode: v.code,
      unitCode: 'U-1',
    });
    const decision = await asPrincipal(auth, () =>
      evaluate({ resource, verb: 'view', record: { ownerPartyId: head.id, verticalCode: v.code, unitCode: 'U-1' }, auth }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe('WHERE');
  });
});
