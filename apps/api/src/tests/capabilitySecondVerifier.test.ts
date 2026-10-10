/**
 * The second verifier of a pay-feeding capability claim (Canon §14.6.4).
 *
 * `secondVerifierPartyId` came from the request body and was only checked for
 * inequality with the claimant and the first verifier, so any cuid made the
 * claim verify with `twoPerson: true`. These tests go through verifyClaim with
 * real rows: a fabricated id, a person who cannot verify, and a person who can.
 *
 * The ordering test reads the source of verifyClaim. The audit row and the
 * event envelope are both written to Postgres in the same request, and nothing
 * in the database records which came first, so the order is asserted on the
 * code path itself, the way auditRegistry.test.ts does for registration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertClaim, verifyClaim } from '../domains/capability.js';
import { asUser, expectReject, principalFor, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function feedingSkill(tid: string) {
  return unscopedPrisma.skill.create({
    data: { tenantId: tid, name: `W1C second verifier ${stamp()}`, feedsCompensationOrPromotionOrMobility: true },
  });
}

async function arunClaim(tid: string) {
  const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
  const skill = await feedingSkill(tid);
  const claim = await asUser('hr@kaizen.co.in', () =>
    assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'demonstrated' }),
  );
  return claim;
}

async function verificationRows(claimId: string) {
  return unscopedPrisma.verificationEvent.count({ where: { capabilityClaimId: claimId } });
}

describe('verifyClaim — the second verifier must be a real, qualified person in this tenant', () => {
  it('a second verifier id that names nobody in the tenant is refused 422 and nothing is written', async () => {
    const tid = await tenantId();
    const claim = await arunClaim(tid);

    const err = await asUser('hr@kaizen.co.in', () =>
      expectReject(() => verifyClaim(claim.id, { secondVerifierPartyId: 'cmfabricatedpartyid0000000' })),
    );
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/second verifier/i);

    const after = await unscopedPrisma.capabilityClaim.findFirstOrThrow({ where: { id: claim.id } });
    expect(after.tier).toBe('demonstrated');
    expect(await verificationRows(claim.id)).toBe(0);
  });

  it('a finance head, who approves pay but holds no capabilities:approve, is refused 403 and nothing is written', async () => {
    const tid = await tenantId();
    const claim = await arunClaim(tid);
    // finance_head has no capabilities grant in the matrix (seed/grants.ts), so
    // a real senior person with a signing role is still not a second verifier.
    const finance = await principalFor('bhead@kaizen.co.in');

    const err = await asUser('hr@kaizen.co.in', () =>
      expectReject(() => verifyClaim(claim.id, { secondVerifierPartyId: finance.partyId })),
    );
    expect(err.status).toBe(403);

    const after = await unscopedPrisma.capabilityClaim.findFirstOrThrow({ where: { id: claim.id } });
    expect(after.tier).toBe('demonstrated');
    expect(await verificationRows(claim.id)).toBe(0);
  });

  it('a second verifier who holds capabilities:approve in this tenant is accepted and the claim verifies', async () => {
    const tid = await tenantId();
    const claim = await arunClaim(tid);

    // The fixture is torn down when withFixtureRole returns, so the verify call
    // runs inside it. Its affiliation is the only thing that makes the second
    // verifier qualified, so the grant is the variable under test.
    await withFixtureRole(
      { slug: 'w1c_second_verifier', grants: [{ resource: 'capabilities', verbs: ['approve'] }] },
      async (second) => {
        await asUser('hr@kaizen.co.in', () => verifyClaim(claim.id, { secondVerifierPartyId: second.partyId }));
        const event = await unscopedPrisma.verificationEvent.findFirstOrThrow({ where: { capabilityClaimId: claim.id } });
        expect(event.secondVerifierPartyId).toBe(second.partyId);
      },
    );

    const after = await unscopedPrisma.capabilityClaim.findFirstOrThrow({ where: { id: claim.id } });
    expect(after.tier).toBe('verified');
  });
});

describe('verifyClaim — audit is written before the event is emitted [Rule 5]', () => {
  it('auditWrite appears before emit in the verifyClaim source', () => {
    const src = readFileSync(fileURLToPath(new URL('../domains/capability.ts', import.meta.url)), 'utf8');
    const start = src.indexOf('export async function verifyClaim(');
    const end = src.indexOf('export async function recordContradiction(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const auditAt = body.indexOf('await auditWrite(');
    const emitAt = body.indexOf('await emit(');
    expect(auditAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(auditAt).toBeLessThan(emitAt);
  });
});
