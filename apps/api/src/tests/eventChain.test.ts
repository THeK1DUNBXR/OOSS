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
import { chainBodyOf, computeHash, computeHashV2, emit, verifyChain, type ChainFields } from '../platform/eventBus.js';

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
function fixtureRow(tenantId: string, i: number, prevHash: string | null, hashVersion = 2) {
  const row: ChainFields & { prevHash: string | null; hashVersion: number } = {
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
    hashVersion,
  };
  const hash = hashVersion === 1 ? computeHash(chainBodyOf(row), prevHash) : computeHashV2(chainBodyOf(row), prevHash);
  return { ...row, hash };
}

/**
 * Edits a stored event record the way an attacker with database access would:
 * with the immutability trigger disabled inside a transaction. The trigger is
 * re-enabled by the rollback path or the commit, never left off.
 */
async function tamperEventRecordBypassingTrigger(tenantId: string, eventId: string, data: Record<string, unknown>) {
  await unscopedPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "event_records" DISABLE TRIGGER "event_record_immutable"`);
    await tx.eventRecord.updateMany({ where: { tenantId, eventId }, data: data as never });
    await tx.$executeRawUnsafe(`ALTER TABLE "event_records" ENABLE TRIGGER "event_record_immutable"`);
  });
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

    await tamperEventRecordBypassingTrigger(tid, ids[1], { actorType: 'human' });

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
    await tamperEventRecordBypassingTrigger(tid, target.eventId, { actorType: 'human' });
    const tampered = await asSystem(tid, () => verifyChain(tid));
    expect(tampered.valid).toBe(false);
    expect(tampered.brokenAt).toBe(target.eventId);
  });
});

describe('0.6 hash chain: hash version 2 and the immutable boundary', () => {
  it('an edit inside nested newState is detected, because v2 hashes the full body', async () => {
    // Under v1 the hash replacer kept only top-level keys, so nested content
    // hashed as {} and this edit passed. The edit below changes nothing a
    // top-level column shows.
    const tid = await freshTenant();
    const ids: string[] = [];
    await asSystem(tid, async () => {
      const first = await emit({
        name: NAME,
        subject: { entityType: 'person', entityId: 'nested-1' },
        newState: { amount: 100, lines: [{ account: '4000', paise: 100 }] },
      });
      ids.push(first.eventId);
      ids.push((await emit(probe(1))).eventId);
    });
    const stored = await unscopedPrisma.eventRecord.findFirstOrThrow({ where: { tenantId: tid, eventId: ids[0] } });
    expect(stored.hashVersion).toBe(2);

    await tamperEventRecordBypassingTrigger(tid, ids[0], {
      newState: { amount: 1, lines: [{ account: '4000', paise: 1 }] },
    });

    const result = await asSystem(tid, () => verifyChain(tid));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(ids[0]);
  });

  it('an intact chain that crosses from v1 rows to v2 rows verifies, and the link continues across the change', async () => {
    // Existing rows keep their v1 hashes; they are not rewritten. New rows are
    // v2, and the first v2 row must chain onto the last v1 row.
    const tid = await freshTenant();
    const rows: Record<string, unknown>[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = fixtureRow(tid, i, prev, 1);
      rows.push({ ...r, impactDomains: ['crm'], source: {} });
      prev = r.hash;
    }
    await unscopedPrisma.eventRecord.createMany({ data: rows as never });

    await asSystem(tid, async () => {
      await emit(probe(10));
      await emit(probe(11));
    });

    const result = await asSystem(tid, () => verifyChain(tid));
    expect(result).toEqual({ valid: true, checked: 5, brokenAt: null, complete: true });
    const versions = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: tid },
      orderBy: { seq: 'asc' },
      select: { hashVersion: true },
    });
    expect(versions.map((v) => v.hashVersion)).toEqual([1, 1, 1, 2, 2]);
  });

  it('event records cannot be updated or deleted, by ORM or by a bypass that leaves the trigger on', async () => {
    const tid = await freshTenant();
    await asSystem(tid, () => emit(probe(0)));
    const rec = await unscopedPrisma.eventRecord.findFirstOrThrow({ where: { tenantId: tid } });

    await expect(
      unscopedPrisma.eventRecord.update({ where: { id: rec.id }, data: { actorType: 'human' } }),
    ).rejects.toThrow(/event records are immutable/);
    await expect(unscopedPrisma.eventRecord.delete({ where: { id: rec.id } })).rejects.toThrow(
      /event records are immutable/,
    );
  });
});
