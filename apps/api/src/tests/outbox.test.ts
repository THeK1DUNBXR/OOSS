/**
 * FX-24 / D-16 — transactional outbox.
 *
 * Real Postgres, real contexts. The claim under test is that an event and the
 * write that caused it commit or vanish together, and that a committed event
 * reaches each subscriber exactly once even with several dispatchers racing.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unscopedPrisma, prisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { emit, subscribe, clearSubscribers } from '../platform/eventBus.js';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../platform/outbox.js';
import { tenantId } from './helpers.js';

let TENANT: string;
beforeAll(async () => {
  TENANT = await tenantId();
});

const NAME = 'kz.crm.outboxprobe.created';
let seen: string[];

beforeEach(async () => {
  // Other suites' subscribers must not fire on the probe name, and leftover
  // rows from an earlier test must not be drained into this one.
  clearSubscribers();
  seen = [];
  await unscopedPrisma.outboxEvent.deleteMany({ where: { tenantId: TENANT, eventName: NAME } });
});

const probe = (id: string) => ({ name: NAME, subject: { entityType: 'OutboxProbe', entityId: id } });

describe('FX-24 outbox', () => {
  it('a rolled-back write delivers nothing and leaves no outbox row', async () => {
    subscribe(NAME, 'probe', (e) => void seen.push(e.subject.entityId));
    await asSystem(TENANT, async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await emit({ ...probe('rolled-back'), tx });
          throw new Error('business write failed after emit');
        }),
      ).rejects.toThrow('business write failed');
      await drainOutbox({ tenantId: TENANT });
    });
    expect(seen).toEqual([]);
    expect(await unscopedPrisma.outboxEvent.count({ where: { tenantId: TENANT, eventName: NAME } })).toBe(0);
    expect(await unscopedPrisma.eventRecord.count({ where: { tenantId: TENANT, subjectEntityId: 'rolled-back' } })).toBe(0);
  });

  it('a committed write is not delivered until dispatch, then exactly once under two concurrent dispatchers', async () => {
    subscribe(NAME, 'probe', async (e) => {
      await new Promise((r) => setTimeout(r, 30));
      seen.push(e.subject.entityId);
    });
    await asSystem(TENANT, async () => {
      await prisma.$transaction(async (tx) => {
        await emit({ ...probe('committed'), tx });
      });
    });
    expect(seen).toEqual([]);
    const [a, b] = await Promise.all([drainOutbox({ tenantId: TENANT }), drainOutbox({ tenantId: TENANT })]);
    expect(seen).toEqual(['committed']);
    expect(a.delivered + b.delivered).toBe(1);
    const row = await unscopedPrisma.outboxEvent.findFirstOrThrow({ where: { tenantId: TENANT, eventName: NAME } });
    expect(row.state).toBe('dispatched');
  });

  it('a failing handler is retried with backoff and dead-lettered after the attempt limit', async () => {
    let calls = 0;
    subscribe(NAME, 'probe', () => {
      calls += 1;
      throw new Error('boom');
    });
    await asSystem(TENANT, async () => {
      await prisma.$transaction(async (tx) => {
        await emit({ ...probe('failing'), tx });
      });
    });
    const base = Date.now();
    for (let i = 0; i <= OUTBOX_MAX_ATTEMPTS + 1; i++) {
      // Jump the clock past any backoff rather than sleeping through it.
      await drainOutbox({ tenantId: TENANT, now: new Date(base + (i + 1) * 3_600_000 * 24) });
    }
    const row = await unscopedPrisma.outboxEvent.findFirstOrThrow({ where: { tenantId: TENANT, eventName: NAME } });
    expect(row.state).toBe('dead');
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(row.lastError).toContain('boom');
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it('an invalid event name is refused at emit and at dispatch', async () => {
    await asSystem(TENANT, async () => {
      await expect(emit({ name: 'PersonCreated', subject: { entityType: 'X', entityId: '1' } })).rejects.toThrow(/grammar/);
    });
    await unscopedPrisma.outboxEvent.create({
      data: {
        tenantId: TENANT,
        eventRecordId: 'none',
        eventName: 'NotCanonical',
        payload: {},
        nextAttemptAt: new Date(0),
      },
    });
    const r = await drainOutbox({ tenantId: TENANT });
    expect(r.dead).toBe(1);
    await unscopedPrisma.outboxEvent.deleteMany({ where: { tenantId: TENANT, eventName: 'NotCanonical' } });
  });
});
