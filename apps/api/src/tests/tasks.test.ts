/**
 * POST /api/crm/tasks/:id/complete — the route is a state change with no
 * governance: no permission check, no audit row, no event. These tests go
 * over HTTP so the refusal is the one a caller actually receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { emittedEvents, setEventCapture } from '../platform/eventBus.js';
import {
  principalFor,
  sessionToken,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
  type TestPrincipal,
} from './helpers.js';

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
          headers: { Authorization: `Bearer ${await tokenFor(p)}` },
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
      headers: { Authorization: `Bearer ${await tokenFor(ops)}` },
    });
    expect(res.status).toBe(200);

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('done');
    expect(after.completedAt).not.toBeNull();

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'task', subjectId: task.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');

    const events = emittedEvents.filter(
      (e) => e.eventName === 'kz.wfl.task.completed' && e.subject.entityId === task.id,
    );
    expect(events).toHaveLength(1);
  });
});

describe('POST /crm/tasks/:id/complete — state and ownership', () => {
  it('a second completion is refused 409, and the first completedAt and single event are kept', async () => {
    const tid = await tenantId();
    const task = await openTask(tid, 'Double completion probe');
    const ops = await principalFor('operations@kaizen.co.in');

    setEventCapture(true);
    emittedEvents.length = 0;

    const first = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(ops)}` },
    });
    expect(first.status).toBe(200);
    const afterFirst = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });

    const second = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(ops)}` },
    });
    expect(second.status).toBe(409);

    const afterSecond = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(afterSecond.completedAt?.getTime()).toBe(afterFirst.completedAt?.getTime());

    const events = emittedEvents.filter(
      (e) => e.eventName === 'kz.wfl.task.completed' && e.subject.entityId === task.id,
    );
    expect(events).toHaveLength(1);
  });

  it('completing a task does not reassign its owner to the caller', async () => {
    const tid = await tenantId();
    const arun = await principalFor('arun@kaizen.co.in');
    const ops = await principalFor('operations@kaizen.co.in');
    const task = await unscopedPrisma.task.create({
      data: {
        tenantId: tid,
        recordCode: `TSK-W1A-OWN-${stamp()}`,
        title: 'Owner preservation probe',
        status: 'open',
        ownerPartyId: arun.partyId,
      },
    });

    const res = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(ops)}` },
    });
    expect(res.status).toBe(200);

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('done');
    expect(after.ownerPartyId).toBe(arun.partyId);
  });

  it('an own-scoped tasks:edit cannot complete a task owned by someone else: 403, task stays open', async () => {
    const tid = await tenantId();
    const ops = await principalFor('operations@kaizen.co.in');
    const task = await unscopedPrisma.task.create({
      data: {
        tenantId: tid,
        recordCode: `TSK-W1A-SCP-${stamp()}`,
        title: 'Scope refusal probe',
        status: 'open',
        ownerPartyId: ops.partyId,
      },
    });

    const status = await withFixtureRole(
      { slug: 'w1a_task_own', grants: [{ resource: 'tasks', verbs: ['edit'], scope: 'own' }] },
      async (p) => {
        const res = await fetch(`${base}/crm/tasks/${task.id}/complete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await tokenFor(p)}` },
        });
        return res.status;
      },
    );
    expect(status).toBe(403);

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('open');
  });
});

function stamp(): string {
  return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
}
