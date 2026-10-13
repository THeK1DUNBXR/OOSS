/**
 * FX-24 consumer idempotency. The outbox delivers at least once, so a subscriber can be
 * handed the same event twice: after a crash between its effect and the outbox settle, or
 * when a dead letter is replayed. The consumer receipt (event_consumer_receipts) makes the
 * second handing a no-op. Each test below owns its records; the subscriber keys and event
 * names are unique to this file.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { emit, subscribe } from '../platform/eventBus.js';
import { drainOutbox, replayDeadLetter } from '../platform/outbox.js';
import { asUser, principalFor, tenantId, unscopedPrisma } from './helpers.js';
import { readyInvoicePosting } from './fixtures/invoicePostingReady.js';

const LATHA = 'latha@kaizen.co.in';
const CHAIR = 'chairman@kaizen.co.in';
let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
  await readyInvoicePosting(TENANT);
  await principalFor(LATHA);
});

/** The outbox row the dispatcher settles for an emitted event. */
async function outboxRowFor(eventName: string, eventId: string) {
  const record = await unscopedPrisma.eventRecord.findFirstOrThrow({
    where: { tenantId: TENANT, eventId, eventName },
  });
  return unscopedPrisma.outboxEvent.findFirstOrThrow({ where: { tenantId: TENANT, eventRecordId: record.id } });
}

/** Puts a settled row back in line, as a crash before its settle would have left it. */
async function requeue(outboxId: string) {
  await unscopedPrisma.outboxEvent.update({
    where: { id: outboxId },
    data: { state: 'pending', deliveredTo: [], attempts: 0, nextAttemptAt: new Date(0) },
  });
}

async function signedContract() {
  const org = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return unscopedPrisma.contract.create({
    data: {
      tenantId: TENANT,
      recordCode: `CTR-IDEM-${randomUUID().slice(0, 8)}`,
      title: 'Consumer idempotency contract',
      organizationId: org.organizationId,
      status: 'signed',
      commercialValueMinor: 500000n,
      currency: 'INR',
    },
  });
}

describe("a redelivered event does not repeat a real subscriber's effect", () => {
  it('replaying a delivered CONTRACT_SIGNED raises no second draft invoice', async () => {
    const contract = await signedContract();
    const env = await asUser(LATHA, () =>
      emit({
        name: EVENTS.CONTRACT_SIGNED,
        subject: { entityType: 'contract', entityId: contract.id, recordCode: contract.recordCode },
        newState: { status: 'signed' },
        confidentiality: 'confidential',
        impact: { domains: ['fin'] },
      }),
    );
    const row = await outboxRowFor(EVENTS.CONTRACT_SIGNED, env.eventId);
    expect(row.state).toBe('dispatched');
    expect(await unscopedPrisma.invoice.count({ where: { tenantId: TENANT, contractId: contract.id } })).toBe(1);

    // Take the draft off the contract. The handler's own guard looks for a draft on
    // the contract, so once this is done a second run would create one, and only the
    // receipt stops it. Without this step the test could not tell the two apart.
    const draft = await unscopedPrisma.invoice.findFirstOrThrow({
      where: { tenantId: TENANT, contractId: contract.id },
    });
    await unscopedPrisma.invoice.update({ where: { id: draft.id }, data: { contractId: null } });

    await requeue(row.id);
    await asUser(LATHA, () => drainOutbox({ tenantId: TENANT, ids: [row.id] }));

    expect(await unscopedPrisma.invoice.count({ where: { tenantId: TENANT, contractId: contract.id } })).toBe(0);
    expect((await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('dispatched');
    const receipts = await unscopedPrisma.eventConsumerReceipt.count({
      where: { tenantId: TENANT, consumerKey: 'fin.billing_schedule', eventId: env.eventId },
    });
    expect(receipts).toBe(1);
  });
});

describe('a subscriber acts once per event', () => {
  const PROBE = 'kz.crm.idemprobe.recorded';

  it('a redelivered event reaches the subscriber once', async () => {
    const seen: string[] = [];
    subscribe(PROBE, 'idem.probe', (e) => void seen.push(e.eventId));

    const env = await asUser(LATHA, () =>
      emit({ name: PROBE, subject: { entityType: 'idem_probe', entityId: randomUUID() } }),
    );
    expect(seen).toEqual([env.eventId]);

    const row = await outboxRowFor(PROBE, env.eventId);
    await requeue(row.id);
    await asUser(LATHA, () => drainOutbox({ tenantId: TENANT, ids: [row.id] }));

    // Without the receipt check the second drain calls the probe again, and this list
    // holds two ids.
    expect(seen).toEqual([env.eventId]);
  });

  const REPLAYED = 'kz.crm.idemreplay.recorded';

  it('replaying a dead letter for an event the subscriber already handled runs nothing', async () => {
    const seen: string[] = [];
    subscribe(REPLAYED, 'idem.replay_probe', (e) => void seen.push(e.eventId));

    const env = await asUser(LATHA, () =>
      emit({ name: REPLAYED, subject: { entityType: 'idem_replay', entityId: randomUUID() } }),
    );
    expect(seen).toEqual([env.eventId]);

    // The crash this stands for: the subscriber ran and its receipt landed, but the
    // row never settled, so the retries ran out and the row was dead-lettered.
    const row = await outboxRowFor(REPLAYED, env.eventId);
    const record = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: TENANT, eventId: env.eventId, eventName: REPLAYED },
    });
    await unscopedPrisma.outboxEvent.update({
      where: { id: row.id },
      data: { state: 'dead', attempts: 8, deliveredTo: [], lastError: 'boom' },
    });
    const letter = await unscopedPrisma.eventDeadLetter.create({
      data: {
        tenantId: TENANT,
        eventRecordId: record.id,
        eventName: REPLAYED,
        subscriberKey: 'idem.replay_probe',
        attempts: 8,
        lastError: 'boom',
        payload: env as never,
      },
    });

    await asUser(CHAIR, () => replayDeadLetter(letter.id));
    await asUser(LATHA, () => drainOutbox({ tenantId: TENANT, ids: [row.id] }));

    // Without the receipt check the replayed row reaches the probe a second time.
    expect(seen).toEqual([env.eventId]);
    expect((await unscopedPrisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('dispatched');
  });
});
