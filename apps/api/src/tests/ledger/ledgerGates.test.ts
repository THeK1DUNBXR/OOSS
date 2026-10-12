/**
 * Ledger gates L1 to L3 and the posting rules around them (ORDERED-PLAN Wave 3,
 * items 1.1 to 1.3; MONEY-LEDGER-CONTRACT decisions 7 to 11 and 16).
 *
 * Real Postgres, real contexts, no mocks. The database checks are asserted as
 * the application role (kaizen_app), with raw SQL, because that is the writer
 * the database has to refuse even when post() is bypassed. Raw SQL in this file
 * is the point of the test: it proves the refusal, it is not a write path.
 *
 * Periods are keyed by IST month (cmp_accounting_periods.period). Each test
 * reads its own month so a closed month from one test cannot leak into another.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { unscopedPrisma } from '../../platform/db.js';
import { post, reverse } from '../../platform/ledger.js';
import { closePeriod } from '../../domains/compliance/books.js';
import { asUser, booksTenant, closeThrough, expectReject, reopenLatestFirst, type BooksTenant } from '../helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

// The gates run in a books tenant of their own: the close in L3 freezes months, and no other file's
// rows may sit in them.
let FIX: BooksTenant;
let CHAIRMAN: string;
const app = new PrismaClient({ datasourceUrl: APP_URL });

let tid: string;
let otherTid: string;
let entityId: string;
let bankId: string;
let salesId: string;
let rentId: string;
let capitalId: string;
let lineId: string;

/** Runs `fn` as the application role, with the tenant set the way platform/db.ts sets it. */
function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    return fn(tx);
  });
}

/** The period's first and last day, as the books' own rows carry them. */
function bounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    startsOn: new Date(`${month}-01T00:00:00.000Z`),
    endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
  };
}

/** An IST month's accounting period, opened or moved to `status` for this run. */
async function period(month: string, status: string) {
  return unscopedPrisma.accountingPeriod.upsert({
    where: { tenantId_period: { tenantId: tid, period: month } },
    create: { tenantId: tid, entityId, period: month, fy: '2030-31', status, ...bounds(month) },
    update: { status, entityId, ...bounds(month) },
  });
}

const asChairman = <T>(fn: () => Promise<T>) => asUser(CHAIRMAN, () => fn());

/** A sale in June 2030 (IST), debit bank, credit sales through a business line. */
function saleInput(amount = 10000n, key = `t:${randomUUID()}`) {
  return {
    entityId,
    entryDate: new Date('2030-06-15T00:00:00.000Z'),
    narration: 'Gate fixture sale',
    sourceType: 'manual' as const,
    idempotencyKey: key,
    lines: [
      { accountId: bankId, amountMinor: amount },
      { accountId: salesId, amountMinor: -amount, lineId },
    ],
  };
}

async function postSale(amount = 10000n, key?: string) {
  return asChairman(() => post(saleInput(amount, key)));
}

beforeAll(async () => {
  FIX = await booksTenant('ledger-gates-test');
  tid = FIX.tenantId;
  CHAIRMAN = FIX.chairman;
  const other = await unscopedPrisma.tenant.create({
    data: { name: 'Ledger gates other tenant', slug: `lgate-other-${randomUUID().slice(0, 8)}` },
  });
  otherTid = other.id;

  const entity = await unscopedPrisma.ledgerEntity.upsert({
    where: { tenantId_code: { tenantId: tid, code: 'LGATE' } },
    create: { tenantId: tid, code: 'LGATE', legalName: 'Ledger gates entity', stateCode: '27' },
    update: {},
  });
  entityId = entity.id;

  const account = async (name: string, accountClass: 'asset' | 'income' | 'expense' | 'equity') =>
    (
      await unscopedPrisma.ledgerAccount.upsert({
        where: { tenantId_name: { tenantId: tid, name } },
        create: { tenantId: tid, name, accountClass },
        update: {},
      })
    ).id;
  bankId = await account('Gate bank', 'asset');
  salesId = await account('Gate sales', 'income');
  rentId = await account('Gate rent', 'expense');
  capitalId = await account('Gate capital', 'equity');

  const existingLine = await unscopedPrisma.businessLine.findFirst({ where: { tenantId: tid, code: 'LGATE1' } });
  lineId = (
    existingLine ??
    (await unscopedPrisma.businessLine.create({
      data: {
        tenantId: tid,
        code: 'LGATE1',
        name: 'Gate line',
        payerKind: 'test_payer',
        revenueModel: 'test_model',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    }))
  ).id;
});

afterAll(async () => {
  await app.$disconnect();
  // Posted entries are not deleted (CLAUDE.md rule 2). The fixture tenant
  // here is a books tenant of its own (booksTenant) and the other tenant is a throwaway.
  await unscopedPrisma.tenant.deleteMany({ where: { id: otherTid } });
});

describe('L1: the database refuses an entry that is not a balanced double entry', () => {
  it('refuses an unbalanced entry written as the application role', async () => {
    await period('2030-06', 'open');
    const p = await unscopedPrisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: tid, period: '2030-06' } });
    const entryId = randomUUID();
    await expect(
      asAppRole(async (tx) => {
        await tx.$executeRaw`INSERT INTO "journal_entries" ("id","tenantId","entityId","periodId","entryNumber","entryDate","status","narration","sourceType") VALUES (${entryId}, ${tid}, ${entityId}, ${p.id}, ${'L1-' + entryId}, ${'2030-06-15'}::date, 'posted', 'raw', 'manual')`;
        await tx.$executeRaw`INSERT INTO "journal_lines" ("id","tenantId","entryId","lineNo","accountId","amountMinor","currency","baseAmountMinor") VALUES (${randomUUID()}, ${tid}, ${entryId}, 1, ${bankId}, ${10000n}, 'INR', ${10000n})`;
        await tx.$executeRaw`INSERT INTO "journal_lines" ("id","tenantId","entryId","lineNo","accountId","amountMinor","currency","baseAmountMinor") VALUES (${randomUUID()}, ${tid}, ${entryId}, 2, ${salesId}, ${-9999n}, 'INR', ${-9999n})`;
      }),
    ).rejects.toThrow(/not balanced/);
  });

  it('refuses an entry with no lines at commit, as the application role', async () => {
    const p = await unscopedPrisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: tid, period: '2030-06' } });
    const entryId = randomUUID();
    await expect(
      asAppRole(async (tx) => {
        await tx.$executeRaw`INSERT INTO "journal_entries" ("id","tenantId","entityId","periodId","entryNumber","entryDate","status","narration","sourceType") VALUES (${entryId}, ${tid}, ${entityId}, ${p.id}, ${'L1E-' + entryId}, ${'2030-06-15'}::date, 'posted', 'empty', 'manual')`;
      }),
    ).rejects.toThrow(/at least two lines/);
  });
});

describe('L2: a posted entry is immutable and a reversal is final', () => {
  it('refuses the posted-to-reversed UPDATE as the application role', async () => {
    const a = await postSale();
    const b = await postSale();
    await expect(
      asAppRole(
        (tx) =>
          tx.$executeRaw`UPDATE "journal_entries" SET "status" = 'reversed', "reversedById" = ${b.id} WHERE "id" = ${a.id}`,
      ),
    ).rejects.toThrow(/immutable|permission denied/);
    const row = await unscopedPrisma.journalEntry.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('posted');
    expect(row.reversedById).toBeNull();
  });

  it('refuses UPDATE and DELETE of posted lines and entries as the application role', async () => {
    const a = await postSale();
    await expect(
      asAppRole((tx) => tx.$executeRaw`UPDATE "journal_lines" SET "amountMinor" = 1 WHERE "entryId" = ${a.id}`),
    ).rejects.toThrow(/permission denied|immutable/);
    await expect(
      asAppRole((tx) => tx.$executeRaw`DELETE FROM "journal_lines" WHERE "entryId" = ${a.id}`),
    ).rejects.toThrow(/permission denied|immutable/);
    await expect(asAppRole((tx) => tx.$executeRaw`DELETE FROM "journal_entries" WHERE "id" = ${a.id}`)).rejects.toThrow(
      /permission denied|immutable/,
    );
    await expect(
      asAppRole((tx) => tx.$executeRaw`UPDATE "journal_entries" SET "narration" = 'changed' WHERE "id" = ${a.id}`),
    ).rejects.toThrow(/permission denied|immutable/);
  });

  it('reverses an entry once, and refuses a second reversal and a reversal of a reversal', async () => {
    const original = await postSale();
    const reversal = await asChairman(() => reverse(original.id, 'Entered in error'));
    expect(reversal.reversalOfId).toBe(original.id);

    const twice = await expectReject(() => asChairman(() => reverse(original.id, 'again')));
    expect(twice.status).toBe(409);

    const ofReversal = await expectReject(() => asChairman(() => reverse(reversal.id, 'undo the undo')));
    expect(ofReversal.status).toBe(409);
  });

  it('records the reversal in journal_reversals, insert-only', async () => {
    const original = await postSale();
    const reversal = await asChairman(() => reverse(original.id, 'Duplicate'));
    const link = await unscopedPrisma.journalReversal.findFirstOrThrow({
      where: { tenantId: tid, reversedEntryId: original.id },
    });
    expect(link.reversalEntryId).toBe(reversal.id);

    await expect(
      asAppRole((tx) => tx.$executeRaw`UPDATE "journal_reversals" SET "reason" = 'x' WHERE "id" = ${link.id}`),
    ).rejects.toThrow(/permission denied|immutable/);
    await expect(
      asAppRole((tx) => tx.$executeRaw`DELETE FROM "journal_reversals" WHERE "id" = ${link.id}`),
    ).rejects.toThrow(/permission denied|immutable/);
  });

  it('refuses a reversal of a reversal in the database, not only in post()', async () => {
    const original = await postSale();
    const reversal = await asChairman(() => reverse(original.id, 'Entered in error'));
    await expect(
      asAppRole(async (tx) => {
        await tx.$executeRaw`INSERT INTO "journal_reversals" ("id","tenantId","reversedEntryId","reversalEntryId","reason") VALUES (${randomUUID()}, ${tid}, ${reversal.id}, ${randomUUID()}, 'undo')`;
      }),
    ).rejects.toThrow(/cannot be reversed/);
  });

  it('keeps journal_reversals inside the tenant: a cross-tenant row is refused', async () => {
    const a = await postSale();
    const b = await postSale();
    await expect(
      asAppRole(async (tx) => {
        await tx.$executeRaw`INSERT INTO "journal_reversals" ("id","tenantId","reversedEntryId","reversalEntryId","reason") VALUES (${randomUUID()}, ${otherTid}, ${a.id}, ${b.id}, 'cross')`;
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('L3: a period admits postings only while it is open or reopened', () => {
  it('refuses a post into a period that is closing', async () => {
    await period('2030-08', 'closing');
    const e = await expectReject(() => postSale_in('2030-08-15'));
    expect(e.status).toBe(422);
  });

  it('refuses a post into a closed period', async () => {
    await period('2030-09', 'closed');
    const e = await expectReject(() => postSale_in('2030-09-15'));
    expect(e.status).toBe(422);
  });

  it('refuses a raw insert into a closing period in the database', async () => {
    const p = await period('2030-08', 'closing');
    await expect(
      asAppRole(async (tx) => {
        await tx.$executeRaw`INSERT INTO "journal_entries" ("id","tenantId","entityId","periodId","entryNumber","entryDate","status","narration","sourceType") VALUES (${randomUUID()}, ${tid}, ${entityId}, ${p.id}, ${'L3-' + randomUUID()}, ${'2030-08-15'}::date, 'posted', 'late', 'manual')`;
      }),
    ).rejects.toThrow(/not open/);
  });

  it('a close waits for a posting that holds the period lock, and a post after close refuses', async () => {
    // 2030-07 closes only after 2030-06 is closed (books.ts requestClosePeriod). The window's end
    // closes 2030-08, which the gate fixtures above left closing, so that every month this file
    // closed or fixtured can be reopened latest first and postable again for the tests below.
    await closeThrough(FIX, '2030-06');
    try {
      const p = await period('2030-07', 'closing');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
        await tx.$queryRaw`SELECT "id" FROM "cmp_accounting_periods" WHERE "id" = ${p.id} FOR SHARE`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 150));

      let settled = false;
      const closing = asUser(CHAIRMAN, () => closePeriod('2030-07')).then((row) => {
        settled = true;
        return row;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);

      release();
      await holding;
      const closed = await closing;
      expect(closed.status).toBe('closed');

      const e = await expectReject(() => postSale_in('2030-07-15'));
      expect(e.status).toBe(422);
    } finally {
      await closeThrough(FIX, '2030-08');
      await reopenLatestFirst(FIX, 'Ledger gates close probe finished; reopening the months it closed');
    }
  });
});

describe("tenant scope: a journal reference cannot name another tenant's entry", () => {
  it("refuses a line whose tenantId differs from its entry's, as the application role", async () => {
    const entry = await postSale();
    // The session is the other tenant, so RLS admits the rows; only the
    // reference to an entry of a different tenant is wrong.
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTid}, true)`;
        await tx.$executeRaw`INSERT INTO "journal_lines" ("id","tenantId","entryId","lineNo","accountId","amountMinor","currency","baseAmountMinor") VALUES (${randomUUID()}, ${otherTid}, ${entry.id}, 1, ${bankId}, ${100n}, 'INR', ${100n})`;
        await tx.$executeRaw`INSERT INTO "journal_lines" ("id","tenantId","entryId","lineNo","accountId","amountMinor","currency","baseAmountMinor") VALUES (${randomUUID()}, ${otherTid}, ${entry.id}, 2, ${salesId}, ${-100n}, 'INR', ${-100n})`;
      }),
    ).rejects.toThrow(/foreign key|journal_lines_tenantId_entryId/);
  });

  it('refuses a reversal link whose tenantId differs from the entries it names', async () => {
    const original = await postSale();
    const other = await postSale();
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTid}, true)`;
        await tx.$executeRaw`INSERT INTO "journal_reversals" ("id","tenantId","reversedEntryId","reversalEntryId","reason") VALUES (${randomUUID()}, ${otherTid}, ${original.id}, ${other.id}, 'cross tenant')`;
      }),
    ).rejects.toThrow(/foreign key|journal_reversals_tenantId/);
  });
});

describe('idempotency: the same key is the same entry', () => {
  it('returns the existing entry on a repeat, and writes it once', async () => {
    const key = `repeat:${randomUUID()}`;
    const first = await postSale(10000n, key);
    const second = await postSale(10000n, key);
    expect(second.id).toBe(first.id);
    const count = await unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('returns one entry to two concurrent posts with the same key', async () => {
    const key = `race:${randomUUID()}`;
    const [a, b] = await Promise.all([postSale(10000n, key), postSale(10000n, key)]);
    expect(a.id).toBe(b.id);
    const count = await unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } });
    expect(count).toBe(1);
  });
});

describe('lineId: a P&L line names its business line', () => {
  it('refuses an income or expense line with no lineId', async () => {
    const e = await expectReject(() =>
      asChairman(() =>
        post({
          ...saleInput(5000n),
          narration: 'No line named',
          lines: [
            { accountId: bankId, amountMinor: 5000n },
            { accountId: salesId, amountMinor: -5000n },
          ],
        }),
      ),
    );
    expect(e.status).toBe(422);
  });

  it('accepts a balance-sheet line with no lineId', async () => {
    const entry = await asChairman(() =>
      post({
        ...saleInput(7000n),
        narration: 'Capital introduced',
        lines: [
          { accountId: bankId, amountMinor: 7000n },
          { accountId: capitalId, amountMinor: -7000n },
        ],
      }),
    );
    expect(entry.status).toBe('posted');
  });

  it('refuses a lineId that is not a business line of this tenant at the database', async () => {
    const e = await expectReject(() =>
      asChairman(() =>
        post({
          ...saleInput(5000n),
          narration: 'Unknown line',
          lines: [
            { accountId: bankId, amountMinor: 5000n },
            { accountId: rentId, amountMinor: -5000n, lineId: 'no-such-line' },
          ],
        }),
      ),
    );
    expect(e.status).toBe(422);
  });
});

describe('trial balance', () => {
  it('sums to zero per entry and per tenant after every test above', async () => {
    const perEntry = await unscopedPrisma.$queryRaw<Array<{ entryId: string; total: bigint }>>`
      SELECT "entryId", SUM("amountMinor") AS total FROM "journal_lines"
      WHERE "tenantId" = ${tid} GROUP BY "entryId" HAVING SUM("amountMinor") <> 0`;
    expect(perEntry).toEqual([]);
    const perTenant = await unscopedPrisma.journalLine.aggregate({
      where: { tenantId: tid },
      _sum: { amountMinor: true },
    });
    expect(perTenant._sum.amountMinor ?? 0n).toBe(0n);
  });
});

/** Posts a sale dated inside the given IST day, through the governed path. */
function postSale_in(isoDay: string) {
  return asChairman(() => post({ ...saleInput(10000n), entryDate: new Date(`${isoDay}T00:00:00.000Z`) }));
}
