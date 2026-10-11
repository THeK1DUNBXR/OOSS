/**
 * The audit log and the event list over HTTP carry `seq`, the chain order, as
 * a string. `seq` is a BigInt column, and JSON.stringify throws on a BigInt, so
 * a route that handed back a raw row would 500 the first time one came through.
 * These go through the real router and the real Postgres, so the response is
 * what a staff member's browser actually receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { createApp } from '../server.js';
import { asSystem } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
import { asUser, principalFor, sessionToken, tenantId, type TestPrincipal } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
let server: Server;
let base: string;
let TENANT: string;
let chairman: TestPrincipal;

beforeAll(async () => {
  TENANT = await tenantId();
  chairman = await principalFor(CHAIRMAN);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function get(path: string) {
  const token = await sessionToken({
    userId: chairman.userId,
    tenantId: chairman.tenantId,
    affiliationId: chairman.affiliationId,
    stepUp: true,
  });
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe('audit and event lists over HTTP: seq is on the wire', () => {
  it('GET /admin/audit returns 200, and each row carries seq as a decimal string', async () => {
    const subjectId = `seqjson-audit-${Date.now()}`;
    await asUser(CHAIRMAN, () =>
      auditWrite({
        action: 'update',
        subjectType: 'person',
        subjectId,
        before: { note: 'before' },
        after: { note: 'after' },
      }),
    );

    const res = await get(`/admin/audit?subjectType=person&subjectId=${subjectId}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ seq: unknown }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof rows[0].seq).toBe('string');
    expect(rows[0].seq).toMatch(/^\d+$/);
  });

  it('GET /admin/events returns 200, and each row carries seq as a decimal string', async () => {
    const subjectId = `seqjson-event-${Date.now()}`;
    await asSystem(TENANT, () =>
      emit({
        name: EVENTS.PERSON_CREATED,
        subject: { entityType: 'person', entityId: subjectId },
        newState: { probe: true },
      }),
    );

    const res = await get(`/admin/events?subject=${subjectId}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ seq: unknown }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof rows[0].seq).toBe('string');
    expect(rows[0].seq).toMatch(/^\d+$/);
  });
});
