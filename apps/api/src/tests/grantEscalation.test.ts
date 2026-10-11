/**
 * POST /api/admin/grants — writing a grant is granting its verbs to a role, so
 * the writer must hold what they write. Over HTTP, so the refusal is the one a
 * caller receives, and the database is checked for what was not written.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { sessionToken, unscopedPrisma, withFixtureRole, type TestPrincipal } from './helpers.js';

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

async function postGrant(p: TestPrincipal, body: Record<string, unknown>) {
  return fetch(`${base}/admin/grants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(p)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function grantCount(roleSlug: string): Promise<number> {
  const role = await unscopedPrisma.accessRole.findFirstOrThrow({ where: { slug: roleSlug } });
  return unscopedPrisma.grant.count({ where: { roleId: role.id } });
}

describe('POST /admin/grants — no escalation', () => {
  it('refuses a grants:create holder who does not hold invoices:approve, and writes nothing', async () => {
    await withFixtureRole(
      { slug: 'w1a_grant_writer', grants: [{ resource: 'grants', verbs: ['create'] }] },
      async (writer) => {
        await withFixtureRole({ slug: 'w1a_grant_target', grants: [] }, async (target) => {
          const before = await grantCount(target.roleSlug);

          const res = await postGrant(writer, {
            roleSlug: target.roleSlug,
            resource: 'invoices',
            verbs: ['approve'],
            scope: 'all',
          });
          expect(res.status).toBe(403);

          expect(await grantCount(target.roleSlug)).toBe(before);
        });
      },
    );
  });

  it('refuses a grant written to the role the caller holds, even when the caller holds what it grants', async () => {
    const grants = [
      { resource: 'grants', verbs: ['create'] },
      { resource: 'invoices', verbs: ['approve'] },
    ];
    await withFixtureRole({ slug: 'w1a_grant_self', grants }, async (self) => {
      const before = await grantCount(self.roleSlug);

      const res = await postGrant(self, {
        roleSlug: self.roleSlug,
        resource: 'invoices',
        verbs: ['approve'],
        scope: 'all',
      });
      expect(res.status).toBe(403);

      expect(await grantCount(self.roleSlug)).toBe(before);
    });
  });

  it('lets a grants:create holder write an own-scoped grant they do not otherwise hold', async () => {
    await withFixtureRole(
      { slug: 'w1a_grant_own_writer', grants: [{ resource: 'grants', verbs: ['create'] }] },
      async (writer) => {
        await withFixtureRole({ slug: 'w1a_grant_own_target', grants: [] }, async (target) => {
          const res = await postGrant(writer, {
            roleSlug: target.roleSlug,
            resource: 'payments',
            verbs: ['view'],
            scope: 'own',
          });
          expect(res.status).toBe(201);
        });
      },
    );
  });
});
