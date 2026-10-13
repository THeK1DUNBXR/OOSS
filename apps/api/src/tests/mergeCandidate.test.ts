/**
 * FX-07 — resolving a merge candidate is permissioned, and confirming it
 * performs the merge.
 *
 * Before this fix `resolveMergeCandidate` had no assertCan at all, and
 * `confirm` only flipped the candidate's state. The queue then showed zero
 * open items while the two person records stayed split.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { mergePersons, resolveMergeCandidate } from '../domains/identity.js';
import { unscopedPrisma } from '../platform/db.js';
import { expectReject, tenantId, withFixtureRole } from './helpers.js';

const createdPersonIds: string[] = [];
const createdCandidateIds: string[] = [];

async function fixturePerson(tid: string, label: string) {
  const id = randomUUID().slice(0, 8);
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-FX07-${id}`,
      fullName: `FX07 ${label}`,
      primaryEmail: `fx07-${label}-${id}@fixture.test`,
      primaryEmailNormalised: `fx07-${label}-${id}@fixture.test`,
      source: 'test',
    },
  });
  createdPersonIds.push(person.id);
  return person;
}

async function openCandidate(tid: string, candidatePersonId: string, incomingEmail: string) {
  const mc = await unscopedPrisma.mergeCandidate.create({
    data: {
      tenantId: tid,
      incomingPayload: { fullName: 'FX07 incoming', primaryEmail: incomingEmail },
      candidatePersonId,
      confidence: 0.9,
      matchedOn: ['name'],
      raisedReason: 'ambiguous',
      state: 'open',
    },
  });
  createdCandidateIds.push(mc.id);
  return mc;
}

afterAll(async () => {
  await unscopedPrisma.mergeCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } }).catch(() => {});
  // Rows are merged, never deleted, so the incoming person created on confirm
  // is still referenced by mergedIntoId from the candidate's person. Clearing
  // the references first lets the test rows go.
  await unscopedPrisma.person
    .updateMany({ where: { id: { in: createdPersonIds } }, data: { mergedIntoId: null } })
    .catch(() => {});
  await unscopedPrisma.person.deleteMany({ where: { id: { in: createdPersonIds } } }).catch(() => {});
});

describe('FX-07 resolveMergeCandidate', () => {
  it('refuses a caller without the merge grant, and leaves the candidate open', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx07_editor', grants: [{ resource: 'people', verbs: ['view', 'edit'], scope: 'all' }] },
      async () => {
        const existing = await fixturePerson(tid, 'unpriv-target');
        const mc = await openCandidate(tid, existing.id, `unpriv-${randomUUID()}@fixture.test`);

        const err = await expectReject(() => resolveMergeCandidate(mc.id, 'confirm', 'should not run'));
        expect(err.status).toBe(403);

        const after = await unscopedPrisma.mergeCandidate.findUniqueOrThrow({ where: { id: mc.id } });
        expect(after.state).toBe('open');
      },
    );
  });

  it('confirm performs the merge: the incoming record is merged into the candidate', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx07_merger', grants: [{ resource: 'people', verbs: ['view', 'merge'], scope: 'all' }] },
      async () => {
        const existing = await fixturePerson(tid, 'survivor');
        const incomingEmail = `incoming-${randomUUID()}@fixture.test`;
        const mc = await openCandidate(tid, existing.id, incomingEmail);

        const open = await unscopedPrisma.mergeCandidate.count({ where: { tenantId: tid, state: 'open' } });
        await resolveMergeCandidate(mc.id, 'confirm', 'same person, confirmed by the desk');

        const after = await unscopedPrisma.mergeCandidate.findUniqueOrThrow({ where: { id: mc.id } });
        expect(after.state).toBe('confirmed');
        const openAfter = await unscopedPrisma.mergeCandidate.count({ where: { tenantId: tid, state: 'open' } });
        expect(openAfter).toBe(open - 1);

        // The incoming payload was never a person row. Confirming materialises
        // it and merges it into the survivor, which is the state the candidate
        // was raised to fix.
        const incoming = await unscopedPrisma.person.findFirstOrThrow({
          where: { tenantId: tid, primaryEmailNormalised: incomingEmail },
        });
        createdPersonIds.push(incoming.id);
        expect(incoming.dedupeStatus).toBe('merged');
        expect(incoming.mergedIntoId).toBe(existing.id);
      },
    );
  });

  it('a direct merge moves the active affiliations to the survivor and names them in its audit row', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx07_direct_merger', grants: [{ resource: 'people', verbs: ['view', 'merge'], scope: 'all' }] },
      async () => {
        const survivor = await fixturePerson(tid, 'direct-survivor');
        const source = await fixturePerson(tid, 'direct-source');
        const affiliation = await unscopedPrisma.affiliation.create({
          data: { tenantId: tid, partyId: source.id, affiliationType: 'customer_contact', status: 'active' },
        });

        await mergePersons(source.id, survivor.id, 'duplicate of the survivor');

        // The move is not undoable from the merged row alone, so the audit row
        // has to say which affiliations left the source. Before this fix the
        // meta carried only the note and the target code.
        const moved = await unscopedPrisma.affiliation.findUniqueOrThrow({ where: { id: affiliation.id } });
        expect(moved.partyId).toBe(survivor.id);

        const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
          where: { tenantId: tid, subjectType: 'person', subjectId: source.id, action: 'merge' },
        });
        expect((audit.meta as { movedAffiliationIds?: string[] }).movedAffiliationIds).toEqual([affiliation.id]);
      },
    );
  });
});
