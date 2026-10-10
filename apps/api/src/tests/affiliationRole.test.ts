/**
 * POST /api/crm/people/:id/affiliations — an affiliation carries an access
 * role, so writing one is granting access. Over HTTP, so the refusal is the
 * one a caller receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { signToken } from '../lib/auth.js';
import { principalFor, unscopedPrisma, withFixtureRole, type TestPrincipal } from './helpers.js';

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

function tokenFor(p: TestPrincipal): string {
  return signToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
}

function postAffiliation(p: TestPrincipal, personId: string, body: Record<string, unknown>) {
  return fetch(`${base}/crm/people/${personId}/affiliations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(p)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ affiliationType: 'contact', ...body }),
  });
}

describe('POST /crm/people/:id/affiliations — access role', () => {
  it('refuses a people editor who may not assign roles, and writes no affiliation', async () => {
    await withFixtureRole(
      { slug: 'w1a_aff_editor', grants: [{ resource: 'people', verbs: ['view', 'edit'] }] },
      async (editor) => {
        const target = await principalFor('arun@kaizen.co.in');
        const before = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });

        const res = await postAffiliation(editor, target.partyId, { roleSlug: 'employee' });
        expect(res.status).toBe(403);

        const after = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });
        expect(after).toBe(before);
      },
    );
  });

  it('refuses a role slug that is not in the tenant registry, even for someone who may assign', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    const target = await principalFor('arun@kaizen.co.in');
    const before = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });

    const res = await postAffiliation(ops, target.partyId, { roleSlug: 'admin' });
    expect(res.status).toBe(422);

    const after = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });
    expect(after).toBe(before);
  });

  it('a permitted assigner writes a registered role, and the create is audited', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    await withFixtureRole({ slug: 'w1a_aff_target', grants: [] }, async (fixture) => {
      const res = await postAffiliation(ops, fixture.partyId, { roleSlug: 'employee' });
      expect(res.ok).toBe(true);
      const created = (await res.json()) as { id: string; roleSlug: string | null };
      expect(created.roleSlug).toBe('employee');

      const audit = await unscopedPrisma.auditRecord.findMany({
        where: { subjectType: 'affiliation', subjectId: created.id },
      });
      expect(audit.map((r) => r.action)).toContain('create');
    });
  });
});
