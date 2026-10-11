/**
 * POST /api/hr/capabilities/:id/verify — the two-person rule on verification.
 *
 * The rule's inputs used to come from the request body, defaulting to false,
 * so a single verifier could certify a pay-affecting skill by leaving the
 * flags out (routes/hr.routes.ts:844-856). These tests go over HTTP, with the
 * flag sent in the body, to show the body is not where the answer comes from.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { assertClaim } from '../domains/capability.js';

let server: Server;
let base: string;

beforeAll(() => {
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function tokenFor(p: TestPrincipal): Promise<string> {
  return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
}

async function verifyOverHttp(verifier: TestPrincipal, claimId: string, body: Record<string, unknown>) {
  return fetch(`${base}/hr/capabilities/${claimId}/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(verifier)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /hr/capabilities/:id/verify — the body cannot switch the two-person rule off', () => {
  it('a single verifier sending feedsCompensationOrPromotionOrMobility:false gets 422, and the claim stays unverified', async () => {
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.findFirstOrThrow({ where: { tenantId: await tenantId() } });
    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'demonstrated' }),
    );
    const hr = await principalFor('hr@kaizen.co.in');

    const res = await verifyOverHttp(hr, claim.id, { feedsCompensationOrPromotionOrMobility: false });
    expect(res.status).toBe(422);

    const after = await unscopedPrisma.capabilityClaim.findFirstOrThrow({ where: { id: claim.id } });
    expect(after.tier).toBe('demonstrated');
  });
});
