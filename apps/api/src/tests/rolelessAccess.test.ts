/**
 * An affiliation with no role must give its holder no access. The middleware
 * and the session builder used to read a null roleSlug as 'sales', so anyone
 * whose role was never set got the sales seat: here, the leads grant. This
 * tenant defines a 'sales' role that can view leads, so the old fallback is
 * visible as a 200.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { buildSessionUser } from '../lib/auth.js';
import { sessionToken, unscopedPrisma } from './helpers.js';

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TENANT_SLUG = `w1a-roleless-${stamp}`;

let server: Server;
let base: string;
let tenantId: string;
let userId: string;
let affiliationId: string;

beforeAll(async () => {
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `Roleless ${stamp}`, slug: TENANT_SLUG } });
  tenantId = tenant.id;

  // The tenant's own sales role, granting view on leads. It exists so that a
  // roleless holder has something to fall back into.
  const sales = await unscopedPrisma.accessRole.create({
    data: { tenantId, slug: 'sales', name: 'Sales', classificationCeiling: 'internal', isSystem: false },
  });
  await unscopedPrisma.grant.create({
    data: { tenantId, principalType: 'role', roleId: sales.id, resource: 'leads', verbs: ['view'], scope: 'all' },
  });

  const email = `roleless-${stamp}@fixture.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId,
      recordCode: `PER-RL-${stamp}`,
      fullName: `Roleless ${stamp}`,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: null,
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  affiliationId = affiliation.id;
  const user = await unscopedPrisma.user.create({
    data: { tenantId, personId: person.id, email, passwordHash: 'not-a-login', branch: 'Chennai' },
  });
  userId = user.id;

  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  server?.close();
  // The tenant is not deleted: its cascade reaches the immutable event_records.
  // The stamp in TENANT_SLUG makes a rerun on the same database a fresh tenant.
});

describe('a null role grants nothing', () => {
  it('the session resolves with no role and no grants, not the sales seat', async () => {
    const session = await buildSessionUser(userId, tenantId, affiliationId, true);
    expect(session.roleSlug).toBeNull();
    expect(session.grants).toEqual([]);
  });

  it('listing leads is refused with 403, not answered from the sales grant', async () => {
    const token = await sessionToken({ userId, tenantId, affiliationId, stepUp: true });
    const res = await fetch(`${base}/crm/leads`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
