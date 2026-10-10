/**
 * POST /api/crm/tasks/:id/complete — the route is a state change with no
 * governance: no permission check, no audit row, no event. These tests go
 * over HTTP so the refusal is the one a caller actually receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { signToken } from '../lib/auth.js';
import { emittedEvents, setEventCapture } from '../platform/eventBus.js';
import { principalFor, tenantId, unscopedPrisma, withFixtureRole, type TestPrincipal } from './helpers.js';

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

async function openTask(tid: string, title: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return unscopedPrisma.task.create({
    data: { tenantId: tid, recordCode: `TSK-W1A-${stamp}`, title, status: 'open' },
  });
}

describe('POST /crm/tasks/:id/complete — governance', () => {
  it('refuses a caller without tasks:edit with 403, and the task stays open', async () => {
    const tid = await tenantId();
    const task = await openTask(tid, 'Refusal probe');

    // A role that can see people and nothing about tasks.
    const status = await withFixtureRole(
      { slug: 'w1a_task_viewer', grants: [{ resource: 'people', verbs: ['view'] }] },
      async (p) => {
        const res = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenFor(p)}` },
        });
        return res.status;
      },
    );
    expect(status).toBe(403);

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('open');
    expect(after.completedAt).toBeNull();
  });

  it('a permitted caller completes the task, and an audit row and kz.wfl.task.completed are written', async () => {
    const tid = await tenantId();
    const task = await openTask(tid, 'Completion probe');
    const ops = await principalFor('operations@kaizen.co.in');

    setEventCapture(true);
    emittedEvents.length = 0;

    const res = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(ops)}` },
    });
    expect(res.status).toBe(200);

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('done');
    expect(after.completedAt).not.toBeNull();

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'task', subjectId: task.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');

    const events = emittedEvents.filter((e) => e.eventName === 'kz.wfl.task.completed' && e.subject.entityId === task.id);
    expect(events).toHaveLength(1);
  });
});
