/**
 * PR11b: the scope axis, and the guarantee that legacy grants are untouched by the
 * access-model branches (P11-DESIGN c, e; ACCESS-MODEL-PLAN s.4, s.11).
 *
 * The characterisation block below pins what evaluate, scopeWhere and visibilityWhere
 * return for legacy grants (individual grants with no assignment tag). It was written
 * and run green before any PR11b code, and it must stay green: a change that alters a
 * legacy answer is a regression, not a feature.
 */

import { describe, expect, it } from 'vitest';
import { evaluate, scopeWhere, visibilityWhere } from '../platform/permissions.js';
import type { AuthContext } from '../platform/context.js';
import { asPrincipal, tenantId } from './helpers.js';
import { authOf, grantIndividual, makePerson, uniqCode } from './access/factories.js';

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
