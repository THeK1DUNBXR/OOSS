/**
 * 0.6 (FX-81), the admin route over HTTP: GET /events/verify-chain pages through a
 * tenant's chain with `limit` and resumes it with `cursor`, and a cursor from another
 * tenant is refused. Real app, real Postgres, the chairman's own session.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { createApp } from '../server.js';
import { asSystem } from '../platform/context.js';
import { unscopedPrisma } from '../platform/db.js';
import { emit } from '../platform/eventBus.js';
import { principalFor, sessionToken, tenantId, type TestPrincipal } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

interface ChainBody {
  valid: boolean;
  checked: number;
  brokenAt: string | null;
  complete: boolean;
  nextCursor?: string;
}

describe('0.6 GET /events/verify-chain pages and resumes', () => {
  let server: Server;
  let base: string;
  let chairman: TestPrincipal;
  let token: string;
  let total: number;
  let otherCursor: string;

  beforeAll(async () => {
    const tid = await tenantId();
    chairman = await principalFor(CHAIRMAN);
    token = await sessionToken({
      userId: chairman.userId,
      tenantId: chairman.tenantId,
      affiliationId: chairman.affiliationId,
      stepUp: true,
    });
    total = await unscopedPrisma.eventRecord.count({ where: { tenantId: tid } });

    // A second tenant with its own chain, so there is a real cursor that belongs to it.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const other = await unscopedPrisma.tenant.create({ data: { name: `Chain ${stamp}`, slug: `chain-${stamp}` } });
    await asSystem(other.id, async () => {
      await emit({
        name: EVENTS.PERSON_CREATED,
        subject: { entityType: 'person', entityId: `vc-${stamp}` },
        newState: {},
      });
    });
    const row = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: other.id },
      select: { seq: true },
    });
    otherCursor = row.seq.toString();

    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    server?.close();
  });

  async function get(query: string): Promise<{ status: number; body: ChainBody & { error?: unknown } }> {
    const res = await fetch(`${base}/admin/events/verify-chain${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as ChainBody & { error?: unknown } };
  }

  it('the chain has more than one row, so a page of one is a real partial walk', () => {
    expect(total).toBeGreaterThan(1);
  });

  it('a limit of one checks one row, says the walk is not complete, and names where to resume', async () => {
    const { status, body } = await get('?limit=1');
    expect(status).toBe(200);
    expect(body.checked).toBe(1);
    expect(body.complete).toBe(false);
    expect(body.valid).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('resuming from that cursor checks the rest of the chain and reports it complete', async () => {
    const first = await get('?limit=1');
    const rest = await get(`?cursor=${first.body.nextCursor}`);
    expect(rest.status).toBe(200);
    expect(rest.body.valid).toBe(true);
    expect(rest.body.complete).toBe(true);
    expect(rest.body.checked).toBe(total - 1);
    expect(rest.body.nextCursor).toBeUndefined();
  });

  it('refuses a cursor that belongs to another tenant, rather than resuming from its hash', async () => {
    const { status, body } = await get(`?cursor=${otherCursor}`);
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('refuses a limit that is not a whole number of rows', async () => {
    const { status } = await get('?limit=0');
    expect(status).toBe(400);
  });
});
