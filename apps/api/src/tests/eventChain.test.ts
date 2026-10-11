/**
 * 0.6 / FX-81 — the event hash chain.
 *
 * Real Postgres, real contexts. Each test gets its own tenant so that a
 * deliberately broken row cannot leak into another suite's `verifyChain`.
 */

import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { EVENTS } from '@kaizen/shared';
import { asSystem } from '../platform/context.js';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { chainBodyOf, computeHash, emit, verifyChain, type ChainFields } from '../platform/eventBus.js';

const NAME = EVENTS.PERSON_CREATED;

async function freshTenant(): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await unscopedPrisma.tenant.create({ data: { name: `Chain ${stamp}`, slug: `chain-${stamp}` } });
  return t.id;
}

function probe(i: number) {
  return { name: NAME, subject: { entityType: 'person', entityId: `chain-probe-${i}` }, newState: { i } };
}

async function headOf(tenantId: string) {
  return unscopedPrisma.eventRecord.findFirstOrThrow({
    where: { tenantId },
    orderBy: { seq: 'desc' },
  });
}

/**
 * A row built the way `emit` builds one, for bulk fixtures. The chain link is
 * computed from the same `chainBodyOf` the verifier uses, so this only proves
 * the round trip through the database when the intact-chain test passes.
 */
function fixtureRow(tenantId: string, i: number, prevHash: string | null) {
  const row: ChainFields & { prevHash: string | null } = {
    eventId: ulid(),
    eventName: NAME,
    eventVersion: 1,
    tenantId,
    occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    actorType: 'system',
    actorPartyId: null,
    actorAccessRole: null,
    actorAgentId: null,
    onBehalfOfPartyId: null,
    subjectEntityType: 'person',
    subjectEntityId: `fixture-${i}`,
    subjectRecordCode: null,
    related: [],
    previousState: undefined,
    newState: { i },
    reason: undefined,
    correlationId: 'fixture',
    causationId: null,
    prevHash,
  };
  return { ...row, hash: computeHash(chainBodyOf(row), prevHash) };
}

async function bulkChain(tenantId: string, n: number): Promise<{ eventId: string; hash: string }[]> {
  const written: { eventId: string; hash: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const r = fixtureRow(tenantId, i, prev);
    rows.push({ ...r, impactDomains: ['crm'], source: {} });
    written.push({ eventId: r.eventId, hash: r.hash });
    prev = r.hash;
  }
  for (let s = 0; s < rows.length; s += 500) {
    await unscopedPrisma.eventRecord.createMany({ data: rows.slice(s, s + 500) as never });
  }
  return written;
}

describe('0.6 hash chain: appends', () => {
  it('two appends racing for one tenant never fork the chain', async () => {
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      for (let round = 0; round < 5; round++) {
        await Promise.all([emit(probe(round * 2)), emit(probe(round * 2 + 1))]);
      }
    });

    const rows = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: tid, prevHash: { not: null } },
      select: { prevHash: true },
    });
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(rows.length);
    expect((await asSystem(tid, () => verifyChain(tid))).valid).toBe(true);
  });

  it('a second genesis row for one tenant is refused by the database', async () => {
    // Postgres treats NULLs as distinct in a unique index, so
    // `@@unique([tenantId, prevHash])` alone admits any number of rows with a
    // NULL predecessor. The genesis of a chain is one row, and the database
    // should say so.
    const tid = await freshTenant();
    await asSystem(tid, () => emit(probe(0)));
    const genesis = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: tid, prevHash: null },
    });
    const { id: _id, seq: _seq, ...rest } = genesis;
    const attempt = unscopedPrisma.eventRecord.create({
      data: { ...rest, eventId: ulid(), hash: 'forged-genesis' } as never,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a duplicate predecessor is refused by the database', async () => {
    // Two events, so the head has a real predecessor. A single-event chain's
    // head has a NULL predecessor, which is the genesis case tested above.
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      await emit(probe(0));
      await emit(probe(1));
    });
    const head = await headOf(tid);
    expect(head.prevHash).not.toBeNull();
    const { id: _id, seq: _seq, ...rest } = head;
    const attempt = unscopedPrisma.eventRecord.create({
      data: { ...rest, eventId: ulid(), hash: 'forked' } as never,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a record written with a dual-publish legacy name is part of the chain, not a break in it', async () => {
    // The append head is read over every row of the tenant, legacy rows
    // included, so the next canonical record links to the legacy row. A
    // verifier that skips legacy rows reads that link as a broken chain.
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      await emit({ ...probe(0), dualPublish: true });
      await emit(probe(1));
    });

    const legacy = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: tid, legacyName: { not: null } },
    });
    const canonical = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: tid, legacyName: null, subjectEntityId: 'chain-probe-0' },
    });
    // Both rows are written under one seq would make the walk skip one of
    // them, because the walk is a cursor on seq.
    expect(legacy.seq).not.toBe(canonical.seq);
    expect((await asSystem(tid, () => verifyChain(tid))).valid).toBe(true);
  });

  it('the outbox row is written in the same transaction as the chain link', async () => {
    const tid = await freshTenant();
    const committed = await asSystem(tid, () =>
      prisma.$transaction(async (tx) => {
        const env = await emit({ ...probe(0), tx });
        const rec = await tx.eventRecord.findFirstOrThrow({ where: { tenantId: tid, eventId: env.eventId } });
        const outbox = await tx.outboxEvent.findFirstOrThrow({ where: { tenantId: tid, eventRecordId: rec.id } });
        return { eventId: env.eventId, outboxId: outbox.id };
      }),
    );
    expect(committed.outboxId).toBeTruthy();

    const rolledBack: { eventId?: string } = {};
    await asSystem(tid, () =>
      expect(
        prisma.$transaction(async (tx) => {
          const env = await emit({ ...probe(1), tx });
          rolledBack.eventId = env.eventId;
          throw new Error('business write failed after emit');
        }),
      ).rejects.toThrow('business write failed'),
    );
    expect(await unscopedPrisma.eventRecord.count({ where: { tenantId: tid, eventId: rolledBack.eventId } })).toBe(0);
    expect(
      await unscopedPrisma.outboxEvent.count({ where: { tenantId: tid, eventName: NAME, state: 'pending' } }),
    ).toBe(1);
  });
});

describe('0.6 hash chain: FX-81 verifyChain', () => {
  it('passes an intact chain and reports that it walked all of it', async () => {
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      for (let i = 0; i < 3; i++) await emit(probe(i));
    });
    const result = await asSystem(tid, () => verifyChain(tid));
    expect(result).toEqual({ valid: true, checked: 3, brokenAt: null, complete: true });
  });

  it('detects a row edited after it was written, and names it', async () => {
    const tid = await freshTenant();
    const ids: string[] = [];
    await asSystem(tid, async () => {
      for (let i = 0; i < 3; i++) ids.push((await emit(probe(i))).eventId);
    });

    // The append path is the only writer, and the trail is not immutable at
    // the database for this table, so an edit is a plain update here.
    await unscopedPrisma.eventRecord.update({
      where: { tenantId_eventId_eventName: { tenantId: tid, eventId: ids[1], eventName: NAME } },
      data: { actorType: 'human' },
    });

    const result = await asSystem(tid, () => verifyChain(tid));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(ids[1]);
  });

  it('walks past 5,000 rows, and a tampered row beyond that point is found', async () => {
    // The old walk stopped at 5,000 rows and returned valid: true for the rest.
    const tid = await freshTenant();
    const written = await bulkChain(tid, 5010);

    const intact = await asSystem(tid, () => verifyChain(tid));
    expect(intact).toEqual({ valid: true, checked: 5010, brokenAt: null, complete: true });

    const target = written[5008];
    await unscopedPrisma.eventRecord.update({
      where: { tenantId_eventId_eventName: { tenantId: tid, eventId: target.eventId, eventName: NAME } },
      data: { actorType: 'human' },
    });
    const tampered = await asSystem(tid, () => verifyChain(tid));
    expect(tampered.valid).toBe(false);
    expect(tampered.brokenAt).toBe(target.eventId);
  });
});
