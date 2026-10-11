/**
 * FX-71b (Wave 5 PR5, decision O8 (a)) — a spin-out revert reverses and marks;
 * it never deletes.
 *
 * The revert used to hard-delete the subsidiary's transactions, certificates
 * and register rows. Each delete was a lost audit trail in the accounting path:
 * no audit row, no event, and a booked transaction that vanished from the
 * books instead of being reversed by a second row. These tests pin what
 * replaces it: the rows stay, marked; the books net to their pre-spin-out
 * value through reversal rows; one tombstone records who, when and why; a
 * second revert is refused; a revert into a closed period is refused; and two
 * reverts racing for one batch produce exactly one reversal.
 *
 * Three holding/subsidiary pairs, one per scenario, because a revert leaves the
 * subsidiary's marked rows in place and a fresh commit into the same
 * subsidiary would be blocked by them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { istFinancialYear, istMonthKey } from '@kaizen/shared';
import { seedBootstrap } from '../seed/bootstrap.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asSystem } from '../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';
import { commitSpinOut, revertSpinOut } from '../seed/spinOutEngine.js';
import {
  asPrincipal,
  authFor,
  expectReject,
  type TestPrincipal,
  unscopedPrisma,
  prisma as scopedPrisma,
} from './helpers.js';

const ALL_TIME = new Date('2100-01-01T00:00:00Z');
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const OPERATOR = 'w5-spin-tombstone-test';

interface Pair {
  hold: string;
  sub: string;
  batchId: string;
  legacyNetBeforeCommit: number;
}

async function principalIn(tid: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({
    where: { tenantId: tid, email: 'chairman@kaizen.co.in' },
  });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { partyId: user.personId, tenantId: tid, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: tid,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'chairman',
    branch: user.branch,
  };
}

async function asChairmanOf<T>(tid: string, fn: () => Promise<T>): Promise<T> {
  return asPrincipal(authFor(await principalIn(tid)), fn);
}

/**
 * The legacy cashbook's signed net over live transactions. Read from SQL in the
 * table's own decimal and converted only for comparison in the test.
 */
async function legacyNet(tid: string): Promise<number> {
  const [row] = await unscopedPrisma.$queryRaw<Array<{ net: string }>>`
    SELECT COALESCE(SUM(CASE WHEN "direction" = 'in' THEN "amount" ELSE -"amount" END), 0)::text AS net
      FROM "transactions"
     WHERE "tenantId" = ${tid} AND "deletedAt" IS NULL`;
  return Number(row!.net);
}

interface RegisterCounts {
  holder: number;
  shareClass: number;
  shareCertificate: number;
  shareTransaction: number;
}

/** Rows of the four register models the batch created, written out per model so each delegate keeps its own type. */
async function registerRowCounts(tid: string, batchId: string): Promise<RegisterCounts> {
  const where = { tenantId: tid, spinOutBatchId: batchId };
  return {
    holder: await unscopedPrisma.holder.count({ where }),
    shareClass: await unscopedPrisma.shareClass.count({ where }),
    shareCertificate: await unscopedPrisma.shareCertificate.count({ where }),
    shareTransaction: await unscopedPrisma.shareTransaction.count({ where }),
  };
}

/** The same four counts, restricted to rows the revert has not yet marked. */
async function unmarkedRegisterRowCounts(tid: string, batchId: string): Promise<RegisterCounts> {
  const where = { tenantId: tid, spinOutBatchId: batchId, spinOutRevertedAt: null };
  return {
    holder: await unscopedPrisma.holder.count({ where }),
    shareClass: await unscopedPrisma.shareClass.count({ where }),
    shareCertificate: await unscopedPrisma.shareCertificate.count({ where }),
    shareTransaction: await unscopedPrisma.shareTransaction.count({ where }),
  };
}

/** Holding rows still pointing at the subsidiary (migratedToTenantId). */
async function holdingPointerCount(p: Pair): Promise<number> {
  return unscopedPrisma.transaction.count({ where: { tenantId: p.hold, migratedToTenantId: p.sub } });
}

async function assertJournalBalances(tid: string): Promise<void> {
  assertTrialBalance(await asSystem(tid, () => journalTrialBalance(ALL_TIME)));
}

/** A holding with two education-tagged cashbook rows, and a subsidiary spun out of it. */
async function spinOutPair(label: string): Promise<Pair> {
  const holdSlug = `w5spin-${label}-hold-${suffix}`;
  const subSlug = `w5spin-${label}-sub-${suffix}`;
  const hold = await seedBootstrap({ tenantSlug: holdSlug, tenantName: `W5 ${label} Holding ${suffix}` });
  const sub = await seedBootstrap({
    tenantSlug: subSlug,
    tenantName: `W5 ${label} Education ${suffix} Pvt Ltd`,
    parentTenantSlug: holdSlug,
    originDivision: 'education',
  });
  const signatories = [
    { name: 'A Director', designation: 'Director' },
    { name: 'B Secretary', designation: 'Company Secretary' },
  ];
  await asChairmanOf(sub.tenantId, () =>
    scopedPrisma.companyProfile.upsert({
      where: { tenantId: sub.tenantId },
      create: {
        tenantId: sub.tenantId,
        legalName: `W5 ${label} Education ${suffix} Pvt Ltd`,
        certificateSignatories: signatories as never,
      },
      update: { certificateSignatories: signatories as never },
    }),
  );
  await asChairmanOf(hold.tenantId, async () => {
    const account = await scopedPrisma.ledgerAccount.create({
      data: {
        tenantId: hold.tenantId,
        name: `Corp Bank ${label} ${suffix}`,
        accountType: 'bank',
        ledgerGroup: 'asset',
      },
    });
    const category = await scopedPrisma.ledgerCategory.create({
      data: {
        tenantId: hold.tenantId,
        name: `Tuition ${label} ${suffix}`,
        kind: 'income',
        behaviour: 'variable',
        defaultDivision: 'education',
      },
    });
    const rows = [
      { direction: 'in', amount: 1000, day: '2026-04-01' },
      { direction: 'out', amount: 250, day: '2026-04-02' },
    ];
    for (const row of rows) {
      await scopedPrisma.transaction.create({
        data: {
          tenantId: hold.tenantId,
          recordCode: await nextRecordCode('TXN'),
          txnDate: new Date(row.day),
          direction: row.direction,
          amount: row.amount,
          accountId: account.id,
          categoryId: category.id,
          division: 'education',
          source: 'manual',
        },
      });
    }
  });

  const legacyNetBeforeCommit = await legacyNet(sub.tenantId);
  const batch = await commitSpinOut({
    holdingTenantId: hold.tenantId,
    division: 'education',
    faceValue: 10,
    className: `Equity ${label} ${suffix}`,
  });
  return { hold: hold.tenantId, sub: sub.tenantId, batchId: batch.batchId, legacyNetBeforeCommit };
}

function revertInput(p: Pair, reason: string) {
  return { holdingTenantId: p.hold, subsidiaryTenantId: p.sub, batchId: p.batchId, revertedBy: OPERATOR, reason };
}

describe('FX-71b — a spin-out revert reverses and marks; it never deletes', () => {
  let P: Pair;
  let originalIds: string[] = [];
  let registerCountsBefore: RegisterCounts = { holder: 0, shareClass: 0, shareCertificate: 0, shareTransaction: 0 };

  beforeAll(async () => {
    P = await spinOutPair('a');
    await assertJournalBalances(P.hold);
    await assertJournalBalances(P.sub);

    const originals = await unscopedPrisma.transaction.findMany({
      where: { tenantId: P.sub, spinOutBatchId: P.batchId },
    });
    originalIds = originals.map((t) => t.id);
    registerCountsBefore = await registerRowCounts(P.sub, P.batchId);

    await revertSpinOut(revertInput(P, 'Board reversed the carve-out'));
    await assertJournalBalances(P.hold);
    await assertJournalBalances(P.sub);
  }, 120_000);

  it('reverses each subsidiary transaction with a second row and keeps the original', async () => {
    expect(originalIds.length).toBeGreaterThan(0);
    const originals = await unscopedPrisma.transaction.findMany({ where: { id: { in: originalIds } } });
    expect(originals).toHaveLength(originalIds.length);
    for (const original of originals) {
      expect(original.reversedById).not.toBeNull();
      const reversal = await unscopedPrisma.transaction.findFirstOrThrow({ where: { id: original.reversedById! } });
      expect(reversal.reversalOfId).toBe(original.id);
      expect(reversal.direction).toBe(original.direction === 'in' ? 'out' : 'in');
      expect(reversal.amount.toString()).toBe(original.amount.toString());
    }
  });

  it('keeps the register rows, marked and cancelled rather than deleted', async () => {
    expect(await registerRowCounts(P.sub, P.batchId)).toEqual(registerCountsBefore);
    expect(await unmarkedRegisterRowCounts(P.sub, P.batchId)).toEqual({
      holder: 0,
      shareClass: 0,
      shareCertificate: 0,
      shareTransaction: 0,
    });
    const certs = await unscopedPrisma.shareCertificate.findMany({
      where: { tenantId: P.sub, spinOutBatchId: P.batchId },
    });
    expect(certs.every((c) => c.status === 'cancelled')).toBe(true);
    const shares = await unscopedPrisma.shareTransaction.findMany({
      where: { tenantId: P.sub, spinOutBatchId: P.batchId },
    });
    expect(shares.every((s) => s.status === 'reversed')).toBe(true);
  });

  it('writes a tombstone that records who, when and why', async () => {
    const [tombstone] = await unscopedPrisma.$queryRaw<
      Array<{ revertedBy: string; reason: string; revertedAt: Date; holdingTenantId: string }>
    >`SELECT "revertedBy", "reason", "revertedAt", "holdingTenantId"
        FROM "spinout_tombstones"
       WHERE "tenantId" = ${P.sub} AND "batchId" = ${P.batchId}`;
    expect(tombstone).toBeDefined();
    expect(tombstone!.revertedBy).toBe(OPERATOR);
    expect(tombstone!.reason).toBe('Board reversed the carve-out');
    expect(tombstone!.holdingTenantId).toBe(P.hold);
    expect(Date.now() - new Date(tombstone!.revertedAt).getTime()).toBeLessThan(10 * 60_000);
  });

  it('nets the legacy books to their pre-spin-out value', async () => {
    expect(await legacyNet(P.sub)).toBe(P.legacyNetBeforeCommit);
  });

  it('writes an audit row for each reversal and the tombstone, and an event for each reversal', async () => {
    for (const id of originalIds) {
      const audited = await unscopedPrisma.auditRecord.count({
        where: { tenantId: P.sub, subjectType: 'transaction', subjectId: id, action: 'update' },
      });
      expect(audited).toBeGreaterThan(0);
    }
    const tombstoneAudit = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "audit_records"
       WHERE "tenantId" = ${P.sub} AND "subjectType" = 'spin_out_tombstone' AND "action" = 'create'`;
    expect(Number(tombstoneAudit[0]!.n)).toBe(1);

    const reversed = await unscopedPrisma.eventRecord.count({
      where: { tenantId: P.sub, eventName: 'kz.fin.transaction.reversed' },
    });
    expect(reversed).toBe(originalIds.length);
    const batchEvents = await unscopedPrisma.eventRecord.count({
      where: { tenantId: P.sub, eventName: 'kz.sys.spin_out.reverted' },
    });
    expect(batchEvents).toBeGreaterThan(0);
  });

  it('refuses a second revert of the same batch with a 409, and writes nothing', async () => {
    const rejection = await expectReject(() => revertSpinOut(revertInput(P, 'second attempt')));
    expect(rejection.status).toBe(409);
    expect(await legacyNet(P.sub)).toBe(P.legacyNetBeforeCommit);
    const tombstones = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "spinout_tombstones" WHERE "tenantId" = ${P.sub} AND "batchId" = ${P.batchId}`;
    expect(Number(tombstones[0]!.n)).toBe(1);
  });
});

describe("FX-71b — a revert lands in today's period and is refused if that period is closed", () => {
  let Q: Pair;

  beforeAll(async () => {
    Q = await spinOutPair('b');
    const now = new Date();
    await unscopedPrisma.accountingPeriod.create({
      data: { tenantId: Q.sub, period: istMonthKey(now), fy: istFinancialYear(now), status: 'closed' },
    });
  }, 120_000);

  it('refuses the revert with a 422, and leaves every row as it was', async () => {
    const rejection = await expectReject(() => revertSpinOut(revertInput(Q, 'closed month')));
    expect(rejection.status).toBe(422);

    const live = await unscopedPrisma.transaction.count({
      where: { tenantId: Q.sub, spinOutBatchId: Q.batchId, reversedById: null, reversalOfId: null },
    });
    expect(live).toBeGreaterThan(0);
    const marked = await unscopedPrisma.shareCertificate.count({
      where: { tenantId: Q.sub, spinOutBatchId: Q.batchId, spinOutRevertedAt: { not: null } },
    });
    expect(marked).toBe(0);
    const tombstones = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "spinout_tombstones" WHERE "tenantId" = ${Q.sub}`;
    expect(Number(tombstones[0]!.n)).toBe(0);
    await assertJournalBalances(Q.sub);
  });
});

describe('FX-71b — two reverts racing for one batch produce exactly one reversal', () => {
  let R: Pair;

  beforeAll(async () => {
    R = await spinOutPair('c');
  }, 120_000);

  it('reverses everything once: a loser is refused with a 409, or finishes the holding side', async () => {
    const results = await Promise.allSettled([
      revertSpinOut(revertInput(R, 'first of two')),
      revertSpinOut(revertInput(R, 'second of two')),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) expect((r.reason as { status?: number }).status).toBe(409);

    const reversals = await unscopedPrisma.transaction.count({
      where: { tenantId: R.sub, spinOutBatchId: R.batchId, reversalOfId: { not: null } },
    });
    expect(reversals).toBe(2);
    expect(await holdingPointerCount(R)).toBe(0);
    const tombstones = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "spinout_tombstones" WHERE "tenantId" = ${R.sub} AND "batchId" = ${R.batchId}`;
    expect(Number(tombstones[0]!.n)).toBe(1);
    await assertJournalBalances(R.sub);
  });
});

describe('FX-71b — a failure between the two transactions is completed by the next revert', () => {
  let E: Pair;
  let originalCount = 0;
  let pointersBefore = 0;

  beforeAll(async () => {
    E = await spinOutPair('d');
    originalCount = await unscopedPrisma.transaction.count({
      where: { tenantId: E.sub, spinOutBatchId: E.batchId },
    });
    pointersBefore = await holdingPointerCount(E);
  }, 120_000);

  it('leaves the subsidiary reversed and the holding pointers set when the second transaction is interrupted', async () => {
    expect(pointersBefore).toBeGreaterThan(0);
    const rejection = await expectReject(() =>
      revertSpinOut({
        ...revertInput(E, 'interrupted revert'),
        afterSubsidiaryCommit: async () => {
          throw new Error('injected failure between the two transactions');
        },
      }),
    );
    expect(rejection.message).toMatch(/injected failure/);
    expect(await holdingPointerCount(E)).toBe(pointersBefore);
    const tombstones = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "spinout_tombstones" WHERE "tenantId" = ${E.sub} AND "batchId" = ${E.batchId}`;
    expect(Number(tombstones[0]!.n)).toBe(1);
    const reversed = await unscopedPrisma.transaction.count({
      where: { tenantId: E.sub, spinOutBatchId: E.batchId, reversedById: { not: null } },
    });
    expect(reversed).toBe(originalCount);
  });

  it('lets the next call finish the holding side, with no reversal written twice', async () => {
    const result = await revertSpinOut(revertInput(E, 'retry after interruption'));
    expect(result.resumed).toBe(true);
    expect(result.clearedOnHolding).toBe(pointersBefore);
    expect(await holdingPointerCount(E)).toBe(0);

    const reversals = await unscopedPrisma.transaction.count({
      where: { tenantId: E.sub, reversalOfId: { not: null } },
    });
    expect(reversals).toBe(originalCount);
    expect(await legacyNet(E.sub)).toBe(E.legacyNetBeforeCommit);
    await assertJournalBalances(E.hold);
    await assertJournalBalances(E.sub);
  });

  it('refuses a further call with a 409, now that both transactions have committed', async () => {
    const rejection = await expectReject(() => revertSpinOut(revertInput(E, 'third attempt')));
    expect(rejection.status).toBe(409);
    expect(await holdingPointerCount(E)).toBe(0);
  });
});
