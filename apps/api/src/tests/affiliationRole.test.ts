/**
 * POST /api/crm/people/:id/affiliations — an affiliation carries an access
 * role, so writing one is granting access. Over HTTP, so the refusal is the
 * one a caller receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { principalFor, sessionToken, unscopedPrisma, withFixtureRole, type TestPrincipal } from './helpers.js';

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

async function postAffiliation(p: TestPrincipal, personId: string, body: Record<string, unknown>) {
  return fetch(`${base}/crm/people/${personId}/affiliations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(p)}`, 'content-type': 'application/json' },
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

describe('POST /crm/people/:id/affiliations — no escalation', () => {
  it('refuses an assigner naming a role on their own party, and writes nothing', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    expect(ops.roleSlug).toBe('hr_ops_manager');
    const before = await unscopedPrisma.affiliation.count({ where: { partyId: ops.partyId } });

    const res = await postAffiliation(ops, ops.partyId, { roleSlug: 'hr_ops_manager' });
    expect(res.status).toBe(403);

    const after = await unscopedPrisma.affiliation.count({ where: { partyId: ops.partyId } });
    expect(after).toBe(before);
  });

  it('refuses hr_ops_manager assigning chairman, and writes nothing', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    const target = await principalFor('arun@kaizen.co.in');
    const before = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });

    const res = await postAffiliation(ops, target.partyId, { roleSlug: 'chairman' });
    expect(res.status).toBe(403);

    const after = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });
    expect(after).toBe(before);
  });

  it('lets the chairman assign hr_ops_manager, which the chairman wholly covers', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    expect(chairman.roleSlug).toBe('chairman');
    await withFixtureRole({ slug: 'w1a_aff_ops_target', grants: [] }, async (fixture) => {
      const res = await postAffiliation(chairman, fixture.partyId, { roleSlug: 'hr_ops_manager' });
      expect(res.ok).toBe(true);
      const created = (await res.json()) as { roleSlug: string | null };
      expect(created.roleSlug).toBe('hr_ops_manager');
    });
  });

  it('lets an assigner name a role whose grants are all within their own', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    await withFixtureRole({ slug: 'w1a_aff_low', grants: [{ resource: 'people', verbs: ['view'], scope: 'own' }] }, async (low) => {
      await withFixtureRole({ slug: 'w1a_aff_low_target', grants: [] }, async (target) => {
        const res = await postAffiliation(ops, target.partyId, { roleSlug: low.roleSlug });
        expect(res.ok).toBe(true);
      });
    });
  });

  it('lets an assigner name a role whose only grants are own-scoped, though they hold none of its resources', async () => {
    const ops = await principalFor('operations@kaizen.co.in');
    const ownOnly = [{ resource: 'invoices', verbs: ['view', 'create', 'edit', 'financial'], scope: 'own' }];
    await withFixtureRole({ slug: 'w1a_aff_own_only', grants: ownOnly }, async (role) => {
      await withFixtureRole({ slug: 'w1a_aff_own_target', grants: [] }, async (target) => {
        const res = await postAffiliation(ops, target.partyId, { roleSlug: role.roleSlug });
        expect(res.ok).toBe(true);
      });
    });
  });

  it('refuses a role whose view grant is wider than the assigner holds, though the assigner may assign', async () => {
    // The route asserts people:edit before createAffiliation asserts people:assign,
    // so the narrow assigner needs both to reach the coverage check.
    const grants = [
      { resource: 'people', verbs: ['edit', 'assign'], scope: 'all' },
      { resource: 'people', verbs: ['view'], scope: 'own' },
    ];
    await withFixtureRole({ slug: 'w1a_aff_narrow', grants }, async (narrow) => {
      await withFixtureRole(
        { slug: 'w1a_aff_wide', grants: [{ resource: 'people', verbs: ['view'], scope: 'all' }] },
        async (wide) => {
          await withFixtureRole({ slug: 'w1a_aff_wide_target', grants: [] }, async (target) => {
            const before = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });

            const res = await postAffiliation(narrow, target.partyId, { roleSlug: wide.roleSlug });
            expect(res.status).toBe(403);

            const after = await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId } });
            expect(after).toBe(before);
          });
        },
      );
    });
  });
});
