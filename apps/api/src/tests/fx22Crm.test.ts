/**
 * FX-22: PATCH /api/crm/opportunities/:id wrote the opportunity with no audit
 * row and no event. The write now sits in domains/opportunities.ts
 * updateOpportunity, inside governedWrite, with auditWrite and emit.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERTICALS } from '@kaizen/shared';
import { createApp } from '../server.js';
import { createOpportunity } from '../domains/opportunities.js';
import { asUser, principalFor, sessionToken, unscopedPrisma, type TestPrincipal } from './helpers.js';

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

describe('PATCH /crm/opportunities/:id — audit', () => {
  it('a permitted edit writes an update audit row against the opportunity', async () => {
    const opp = await asUser('chairman@kaizen.co.in', () =>
      createOpportunity({ title: 'FX-22 CRM audit probe', vertical: VERTICALS[0]! }),
    );
    const chairman = await principalFor('chairman@kaizen.co.in');

    const res = await fetch(`${base}/crm/opportunities/${opp.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${await tokenFor(chairman)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'FX-22 CRM audit probe, renamed' }),
    });
    expect(res.status).toBe(200);

    const after = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { id: opp.id } });
    expect(after.title).toBe('FX-22 CRM audit probe, renamed');

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: opp.tenantId, subjectType: 'opportunity', subjectId: opp.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');
  });
});
