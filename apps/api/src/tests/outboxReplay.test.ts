/**
 * Governed replay of a dead-lettered outbox event (FX-24 follow-up).
 *
 * A dead letter is an event the outbox gave up on. Replaying it puts the
 * outbox row back in line for delivery, and that is a write: it needs the
 * `events:edit` grant, it is audited, and it emits its own past-tense fact. A
 * row whose name fails the grammar cannot succeed on a later attempt, so
 * replaying it is refused rather than queued.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { ApiError } from '../platform/errors.js';
import { subscribe, clearSubscribers } from '../platform/eventBus.js';
import { drainOutbox, replayDeadLetter } from '../platform/outbox.js';
import { EVENTS } from '@kaizen/shared';
import {
  asUser,
  principalFor,
  sessionToken,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
  type TestPrincipal,
} from './helpers.js';

let TENANT: string;
let server: Server;
let base: string;

beforeAll(async () => {
  TENANT = await tenantId();
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

const NAME = 'kz.crm.outboxreplay.created';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
let seen: string[];

beforeEach(async () => {
  // A row left pending by an earlier test would be drained into this one's
  // `seen` list, so the probe name starts each test with no outbox rows.
  clearSubscribers();
  seen = [];
  await unscopedPrisma.outboxEvent.deleteMany({ where: { tenantId: TENANT, eventName: NAME } });
  await unscopedPrisma.eventDeadLetter.deleteMany({ where: { tenantId: TENANT, eventName: NAME } });
});

/** A row the dispatcher already gave up on, written the way a dead letter is left behind. */
async function deadEvent(eventName: string = NAME, state: 'dead' | 'dispatched' = 'dead') {
  const id = stamp();
  const eventRecordId = `replay-${id}`;
  const envelope = { eventId: id, eventName, subject: { entityType: 'OutboxReplay', entityId: id } };
  const outbox = await unscopedPrisma.outboxEvent.create({
    data: {
      tenantId: TENANT,
      eventRecordId,
      eventName,
      payload: envelope as never,
      state,
      attempts: 8,
      nextAttemptAt: new Date(0),
      deliveredTo: [],
      lastError: 'boom',
    },
  });
  const letter = await unscopedPrisma.eventDeadLetter.create({
    data: {
      tenantId: TENANT,
      eventRecordId,
      eventName,
      subscriberKey: 'probe',
      attempts: 8,
      lastError: 'boom',
      payload: envelope as never,
    },
  });
  return { id, outbox, letter };
}

async function snapshot(outboxId: string, letterId: string) {
  const o = await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxId } });
  const l = await unscopedPrisma.eventDeadLetter.findUniqueOrThrow({ where: { id: letterId } });
  return { state: o.state, attempts: o.attempts, outboxNext: o.nextAttemptAt.getTime(), letterState: l.state };
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the replay to be refused');
}

describe('replayDeadLetter — the governed replay', () => {
  it('resets the dead row to pending with attempts cleared, audits it, emits it, and the next drain delivers it', async () => {
    subscribe(NAME, 'probe', (e) => void seen.push(e.subject.entityId));
    const { id, outbox, letter } = await deadEvent();

    const before = Date.now();
    await asUser('chairman@kaizen.co.in', () => replayDeadLetter(letter.id));

    const row = await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const replayed = await unscopedPrisma.eventDeadLetter.findUniqueOrThrow({ where: { id: letter.id } });
    expect(replayed.state).toBe('replayed');
    expect(replayed.replayedAt).not.toBeNull();

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'event_dead_letter', subjectId: letter.id, action: 'update' },
    });
    expect(audit).not.toBeNull();

    const fact = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: TENANT, eventName: EVENTS.OUTBOX_DEAD_LETTER_REPLAYED, subjectEntityId: letter.id },
    });
    expect(fact).not.toBeNull();

    await drainOutbox({ tenantId: TENANT });
    expect(seen).toEqual([id]);
    const delivered = await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(delivered.state).toBe('dispatched');
  });

  it('refuses a row whose event name fails the grammar with 409, and changes nothing', async () => {
    const { outbox, letter } = await deadEvent('PersonCreated');
    const before = await snapshot(outbox.id, letter.id);

    const err = await refusal(asUser('chairman@kaizen.co.in', () => replayDeadLetter(letter.id)));
    expect(err.status).toBe(409);
    expect(await snapshot(outbox.id, letter.id)).toEqual(before);
  });

  it('refuses a dead letter whose outbox row is not dead with 409, and changes nothing', async () => {
    const { outbox, letter } = await deadEvent(NAME, 'dispatched');
    const before = await snapshot(outbox.id, letter.id);

    const err = await refusal(asUser('chairman@kaizen.co.in', () => replayDeadLetter(letter.id)));
    expect(err.status).toBe(409);
    expect(await snapshot(outbox.id, letter.id)).toEqual(before);
  });

  it("does not replay another tenant's dead letter: it is not found from this tenant", async () => {
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'Replay other', slug: `replay-other-${stamp()}` },
    });
    const foreign = await unscopedPrisma.eventDeadLetter.create({
      data: {
        tenantId: other.id,
        eventRecordId: `foreign-${stamp()}`,
        eventName: NAME,
        subscriberKey: 'probe',
        attempts: 8,
        lastError: 'boom',
        payload: {} as never,
      },
    });

    const err = await refusal(asUser('chairman@kaizen.co.in', () => replayDeadLetter(foreign.id)));
    expect(err.status).toBe(404);
    const still = await unscopedPrisma.eventDeadLetter.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(still.state).toBe('dead');
  });
});

describe('POST /admin/events/dead-letters/:id/replay', () => {
  async function tokenFor(p: TestPrincipal): Promise<string> {
    return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
  }

  async function post(p: TestPrincipal, id: string) {
    return fetch(`${base}/admin/events/dead-letters/${id}/replay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(p)}` },
    });
  }

  it('a caller with events:edit replays the letter and gets 200', async () => {
    const { outbox, letter } = await deadEvent();
    const chairman = await principalFor('chairman@kaizen.co.in');
    const res = await post(chairman, letter.id);
    expect(res.status).toBe(200);
    expect((await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } })).state).toBe('pending');
  });

  it('a caller who can only view the dead letters is refused with 403, and nothing changes', async () => {
    const { outbox, letter } = await deadEvent();
    const before = await snapshot(outbox.id, letter.id);
    await withFixtureRole(
      { slug: 'w1_replay_viewer', grants: [{ resource: 'events', verbs: ['view'] }] },
      async (p) => {
        const res = await post(p, letter.id);
        expect(res.status).toBe(403);
      },
    );
    expect(await snapshot(outbox.id, letter.id)).toEqual(before);
  });

  it('a grammar-invalid row is refused over HTTP with 409', async () => {
    const { outbox, letter } = await deadEvent('PersonCreated');
    const chairman = await principalFor('chairman@kaizen.co.in');
    const res = await post(chairman, letter.id);
    expect(res.status).toBe(409);
    expect((await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } })).state).toBe('dead');
  });
});
