/**
 * The AuditRecord hash chain: fork refusal, the genesis, the verifier's walk,
 * and the backfill of pre-chain rows. Real Postgres, real contexts. Each test
 * gets its own tenant so a deliberately broken row cannot reach another suite.
 */

import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { asSystem } from '../platform/context.js';
import { unscopedPrisma } from '../platform/db.js';
import {
  chainUnhashedAuditRecords,
  computeAuditHash,
  createChainedAuditRecord,
  hashPayloadOf,
  verifyAuditChain,
} from '../platform/audit.js';

async function freshTenant(): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await unscopedPrisma.tenant.create({ data: { name: `Audit ${stamp}`, slug: `audit-${stamp}` } });
  return t.id;
}

function append(tenantId: string, i: number) {
  return createChainedAuditRecord({
    tenantId,
    action: 'create',
    subjectType: 'person',
    subjectId: `audit-probe-${i}`,
  } as never);
}

/**
 * A chained row built the way `createChainedAuditRecord` builds one, for bulk
 * fixtures. The hash comes from the same `hashPayloadOf` the verifier uses.
 */
function fixtureAudit(tenantId: string, i: number, prevHash: string | null) {
  const timestamp = new Date(Date.UTC(2026, 9, 1) + i);
  const row = {
    id: ulid(),
    tenantId,
    action: 'create',
    subjectType: 'person',
    subjectId: `fixture-${i}`,
    actorId: null,
    timestamp,
    prevHash,
  };
  return { ...row, hash: computeAuditHash(hashPayloadOf({ ...row, diff: null }), prevHash) };
}

async function tamperAuditRecordBypassingTrigger(id: string, data: Record<string, unknown>) {
  await unscopedPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "audit_records" DISABLE TRIGGER "audit_record_immutable"`);
    await tx.auditRecord.update({ where: { id }, data: data as never });
    await tx.$executeRawUnsafe(`ALTER TABLE "audit_records" ENABLE TRIGGER "audit_record_immutable"`);
  });
}

describe('audit chain: appends', () => {
  it('two appends racing for one tenant never fork the chain', async () => {
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      for (let round = 0; round < 4; round++) {
        await Promise.all([append(tid, round * 2), append(tid, round * 2 + 1)]);
      }
    });
    const rows = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, prevHash: { not: null } },
      select: { prevHash: true },
    });
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(rows.length);
    expect(await asSystem(tid, () => verifyAuditChain(tid))).toMatchObject({ ok: true, checked: 8 });
  });

  it('a duplicate predecessor is refused by the database', async () => {
    const tid = await freshTenant();
    await asSystem(tid, async () => {
      await append(tid, 0);
      await append(tid, 1);
    });
    const head = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: tid, hash: { not: null } },
      orderBy: { timestamp: 'desc' },
    });
    expect(head.prevHash).not.toBeNull();
    const attempt = unscopedPrisma.auditRecord.create({
      data: {
        tenantId: tid,
        action: 'create',
        subjectType: 'person',
        subjectId: 'forked',
        prevHash: head.prevHash,
        hash: 'forked',
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a second hashed genesis for one tenant is refused by the database', async () => {
    // A NULL predecessor is distinct in a plain unique index. Unhashed rows also
    // carry a NULL predecessor, so the genesis index is partial on `hash` as
    // well: many unhashed rows are legitimate, and only one hashed genesis is.
    const tid = await freshTenant();
    await asSystem(tid, () => append(tid, 0));
    const attempt = unscopedPrisma.auditRecord.create({
      data: { tenantId: tid, action: 'create', subjectType: 'person', subjectId: 'forged-genesis', hash: 'forged' },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('audit chain: backfill', () => {
  it('pre-chain rows are chained onto the head, and the chain verifies', async () => {
    const tid = await freshTenant();
    await asSystem(tid, () => append(tid, 0));
    await unscopedPrisma.auditRecord.create({
      data: { tenantId: tid, action: 'read', subjectType: 'person', subjectId: 'legacy-a' },
    });
    await unscopedPrisma.auditRecord.create({
      data: { tenantId: tid, action: 'read', subjectType: 'person', subjectId: 'legacy-b' },
    });

    const chained = await asSystem(tid, () => chainUnhashedAuditRecords(tid));
    expect(chained).toBe(2);
    expect(await asSystem(tid, () => verifyAuditChain(tid))).toMatchObject({ ok: true, checked: 3 });
  });
});

describe('audit chain: verifyAuditChain walks the whole chain', () => {
  it('walks past 10,000 records and says it is complete, then finds a tampered record beyond that point', async () => {
    const N = 10_001;
    const tid = await freshTenant();
    const written: { id: string }[] = [];
    let prev: string | null = null;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < N; i++) {
      const r = fixtureAudit(tid, i, prev);
      rows.push(r);
      written.push({ id: r.id });
      prev = r.hash;
    }
    for (let s = 0; s < rows.length; s += 500) {
      await unscopedPrisma.auditRecord.createMany({ data: rows.slice(s, s + 500) as never });
    }

    const intact = await asSystem(tid, () => verifyAuditChain(tid));
    expect(intact).toEqual({ ok: true, checked: N, brokenAt: null, complete: true });

    const target = written[N - 1];
    await tamperAuditRecordBypassingTrigger(target.id, { diff: { tampered: true } });
    const tampered = await asSystem(tid, () => verifyAuditChain(tid));
    expect(tampered.ok).toBe(false);
    expect(tampered.brokenAt).toBe(target.id);
  });
});
