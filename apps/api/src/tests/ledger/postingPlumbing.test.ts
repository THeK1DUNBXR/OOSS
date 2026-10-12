/**
 * Posting plumbing for the domain consumers (ORDERED-PLAN Wave 5, FX-70a; the
 * contract's PR6): postInTx, the posting-role table and its resolver, and the
 * pure builders. No domain posts here (PR8 to PR10 wait on the accountant's
 * mapping), so every account and every role mapping in this file is a fixture
 * row inserted by the test and labelled TEST ONLY.
 *
 * Real Postgres, real contexts, no mocks. The role table is written as the
 * application role, the writer the database has to accept, and the refusals
 * are asserted as that role and as the table owner.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  buildInvoiceIssueEntry,
  buildReceiptAllocationEntry,
  postingAccountKey,
  postingKeys,
  PostingRuleError,
  type ResolvedPostingAccounts,
} from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { post, postInTx } from '../../platform/ledger.js';
import {
  PostingRoleUnmappedError,
  resolvePostingAccount,
  resolvePostingAccounts,
} from '../../platform/postingRoles.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant } from '../helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

/** The books tenant's chairman, set in beforeAll: this file closes periods, so it cannot share `kaizen`. */
let CHAIRMAN: string;
const app = new PrismaClient({ datasourceUrl: APP_URL });
/** Past every real posting: the trial balance is taken over the whole tenant. */
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');

let tid: string;
let otherTid: string;
let entityId: string;
let lineId: string;
let otherLineId: string;
/** Fixture account ids by short name. TEST ONLY: these are not the chart the finance head maps (A1). */
const acct = {} as Record<
  'bank' | 'receivable' | 'revenue' | 'cgst' | 'sgst' | 'igst' | 'roundOff' | 'effA' | 'effB',
  string
>;

/** Runs `fn` as the application role, with the tenant set the way platform/db.ts sets it. */
function asAppRole<T>(
  fn: (tx: Parameters<Parameters<typeof app.$transaction>[0]>[0]) => Promise<T>,
  t = tid,
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
    return fn(tx);
  });
}

/** Runs `fn` as the table owner, with the tenant set. Owner rows are still under FORCE RLS. */
function asOwner<T>(
  fn: (tx: Parameters<Parameters<typeof unscopedPrisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return unscopedPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
    return fn(tx);
  });
}

const asChairman = <T>(fn: () => Promise<T>) => asUser(CHAIRMAN, () => fn());

/** The period's first and last day, as the books' own rows carry them. */
function bounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return {
    startsOn: new Date(`${month}-01T00:00:00.000Z`),
    endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
  };
}

/** An IST month's accounting period, opened or moved to `status` for this run. */
async function period(month: string, status: string) {
  return unscopedPrisma.accountingPeriod.upsert({
    where: { tenantId_period: { tenantId: tid, period: month } },
    create: { tenantId: tid, entityId, period: month, fy: '2043-44', status, ...bounds(month) },
    update: { status, entityId, ...bounds(month) },
  });
}

/** Mapping rows are insert-only, so a row that exists from an earlier run is left as it is. */
async function mapRole(
  role: string,
  scopeKey: string,
  ledgerAccountId: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
) {
  await asAppRole(
    (tx) => tx.$executeRaw`
    INSERT INTO "ledger_posting_roles"
      ("id", "tenantId", "role", "scopeKey", "ledgerAccountId", "effectiveFrom", "effectiveTo", "setById")
    VALUES (${randomUUID()}, ${tid}, ${role}, ${scopeKey}, ${ledgerAccountId},
            ${effectiveFrom}::date, ${effectiveTo}::date, ${randomUUID()})
    ON CONFLICT ("tenantId", "role", "scopeKey", "effectiveFrom") DO NOTHING`,
  );
}

/** Throws when the tenant's journal does not balance. Taken after every committed step. */
async function assertBalances() {
  assertTrialBalance(await journalTrialBalance(ALL_TIME));
}

/** A sale of `amount` paise through a business line, as a plain two-line entry. */
function saleInput(key: string, amount = 10000n, day = '2044-01-15') {
  return {
    entityId,
    entryDate: new Date(`${day}T00:00:00.000Z`),
    narration: 'Posting plumbing fixture sale',
    sourceType: 'manual' as const,
    idempotencyKey: key,
    lines: [
      { accountId: acct.bank!, amountMinor: amount },
      { accountId: acct.revenue!, amountMinor: -amount, lineId },
    ],
  };
}

/** Fixture accounts for the builders: TEST ONLY, the mapping is not the accountant's. */
function fixtureAccounts(): ResolvedPostingAccounts {
  return new Map([
    [postingAccountKey('TRADE_RECEIVABLE', ''), acct.receivable!],
    [postingAccountKey('REVENUE', lineId), acct.revenue!],
    [postingAccountKey('REVENUE', otherLineId), acct.revenue!],
    [postingAccountKey('OUTPUT_CGST', ''), acct.cgst!],
    [postingAccountKey('OUTPUT_SGST', ''), acct.sgst!],
    [postingAccountKey('OUTPUT_IGST', ''), acct.igst!],
    [postingAccountKey('ROUND_OFF', ''), acct.roundOff!],
    [postingAccountKey('BANK', 'UPI'), acct.bank!],
  ]);
}

beforeAll(async () => {
  // Its own tenant (slug 'posting-plumbing-test'): this file writes closed and closing periods (2044-03, 2044-04),
  // and in `kaizen` those freeze every row-less month below them for every other file.
  const books = await booksTenant('posting-plumbing-test');
  tid = books.tenantId;
  CHAIRMAN = books.chairman;
  const other = await unscopedPrisma.tenant.create({
    data: { name: 'Posting plumbing other tenant', slug: `pplumb-other-${randomUUID().slice(0, 8)}` },
  });
  otherTid = other.id;

  const entity = await unscopedPrisma.ledgerEntity.upsert({
    where: { tenantId_code: { tenantId: tid, code: 'PPLUMB' } },
    create: { tenantId: tid, code: 'PPLUMB', legalName: 'Posting plumbing entity', stateCode: '27' },
    update: {},
  });
  entityId = entity.id;

  const account = async (name: string, accountClass: 'asset' | 'liability' | 'income') =>
    (
      await unscopedPrisma.ledgerAccount.upsert({
        where: { tenantId_name: { tenantId: tid, name } },
        create: { tenantId: tid, name, accountClass },
        update: {},
      })
    ).id;
  acct.bank = await account('PPL bank', 'asset');
  acct.receivable = await account('PPL trade receivable', 'asset');
  acct.revenue = await account('PPL revenue', 'income');
  acct.cgst = await account('PPL output CGST', 'liability');
  acct.sgst = await account('PPL output SGST', 'liability');
  acct.igst = await account('PPL output IGST', 'liability');
  // TEST ONLY: round-off is a P&L head once the accountant maps it (A6); a liability keeps the fixture free of lineId.
  acct.roundOff = await account('PPL round-off', 'liability');
  acct.effA = await account('PPL effective A', 'asset');
  acct.effB = await account('PPL effective B', 'asset');

  const line = async (code: string) =>
    (await unscopedPrisma.businessLine.findFirst({ where: { tenantId: tid, code } })) ??
    (await unscopedPrisma.businessLine.create({
      data: {
        tenantId: tid,
        code,
        name: `Posting plumbing ${code}`,
        payerKind: 'test_payer',
        revenueModel: 'test_model',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      },
    }));
  lineId = (await line('PPLUMB1')).id;
  otherLineId = (await line('PPLUMB2')).id;

  // TEST ONLY fixture mappings. The finance head enters the real rows (A1 to A4); none are seeded.
  await mapRole('TRADE_RECEIVABLE', '', acct.receivable!, '2000-01-01');
  await mapRole('REVENUE', lineId, acct.revenue!, '2000-01-01');
  await mapRole('OUTPUT_CGST', '', acct.cgst!, '2000-01-01');
  await mapRole('OUTPUT_SGST', '', acct.sgst!, '2000-01-01');
  await mapRole('OUTPUT_IGST', '', acct.igst!, '2000-01-01');
  await mapRole('ROUND_OFF', '', acct.roundOff!, '2000-01-01');
  await mapRole('BANK', 'UPI', acct.bank!, '2000-01-01');
});

afterAll(async () => {
  await app.$disconnect();
  // The fixture tenant is the shared kaizen tenant; the other tenant is a throwaway.
  await unscopedPrisma.tenant.deleteMany({ where: { id: otherTid } });
});

describe('postInTx: the same core as post(), inside the caller transaction', () => {
  it("rolls back with the caller's transaction: a fault after the write leaves no entry, no line, no audit, no event", async () => {
    await period('2044-01', 'open');
    const key = `pplumb:rollback:${randomUUID()}`;
    let written: string | undefined;

    const fault = await asChairman(() =>
      prisma
        .$transaction(async (tx) => {
          const entry = await postInTx(tx, saleInput(key));
          written = entry.id;
          throw new Error('fault after the journal write');
        })
        .then(
          () => null,
          (err: Error) => err,
        ),
    );

    expect(fault?.message).toBe('fault after the journal write');
    expect(written).toBeDefined();
    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } })).toBe(0);
    expect(await unscopedPrisma.journalLine.count({ where: { tenantId: tid, entryId: written } })).toBe(0);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: tid, subjectType: 'journal_entry', subjectId: written },
      }),
    ).toBe(0);
    expect(
      await unscopedPrisma.eventRecord.count({
        where: { tenantId: tid, subjectEntityType: 'journal_entry', subjectEntityId: written },
      }),
    ).toBe(0);
    await asChairman(assertBalances);
  });

  it('commits the same entry once for one idempotency key, within one transaction, across two, and through post()', async () => {
    await period('2044-02', 'open');
    const key = `pplumb:idem:${randomUUID()}`;

    const sameTx = await asChairman(() =>
      prisma.$transaction(async (tx) => {
        const first = await postInTx(tx, saleInput(key, 10000n, '2044-02-10'));
        const second = await postInTx(tx, saleInput(key, 10000n, '2044-02-10'));
        return [first.id, second.id];
      }),
    );
    expect(sameTx[0]).toBe(sameTx[1]);

    const later = await asChairman(() =>
      prisma.$transaction((tx) => postInTx(tx, saleInput(key, 10000n, '2044-02-10'))),
    );
    expect(later.id).toBe(sameTx[0]);

    const viaPost = await asChairman(() => post(saleInput(key, 10000n, '2044-02-10')));
    expect(viaPost.id).toBe(sameTx[0]);

    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } })).toBe(1);
    await asChairman(assertBalances);
  });

  it('refuses a closed period and a closing one, and writes no entry and no audit', async () => {
    await period('2044-03', 'closed');
    await period('2044-04', 'closing');
    for (const day of ['2044-03-15', '2044-04-15']) {
      const key = `pplumb:closed:${day}:${randomUUID()}`;
      await expect(
        asChairman(() => prisma.$transaction((tx) => postInTx(tx, saleInput(key, 10000n, day)))),
      ).rejects.toMatchObject({ status: 422 });
      expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } })).toBe(0);
    }
    await asChairman(assertBalances);
  });

  it('refuses an unbalanced entry with the same validation as post()', async () => {
    await period('2044-05', 'open');
    const bad = { ...saleInput(`pplumb:bad:${randomUUID()}`, 10000n, '2044-05-10') };
    bad.lines = [bad.lines[0]!, { accountId: acct.revenue!, amountMinor: -9999n, lineId }];
    await expect(asChairman(() => prisma.$transaction((tx) => postInTx(tx, bad)))).rejects.toMatchObject({
      status: 422,
    });
    await expect(asChairman(() => post(bad))).rejects.toMatchObject({ status: 422 });
    await asChairman(assertBalances);
  });
});

describe('ledger_posting_roles: insert-only, tenant-scoped, with a DB-side refusal', () => {
  it('refuses UPDATE and DELETE for the application role', async () => {
    const id = randomUUID();
    const scope = `pplumb-immut-${randomUUID()}`;
    await asAppRole(
      (tx) => tx.$executeRaw`
      INSERT INTO "ledger_posting_roles"
        ("id", "tenantId", "role", "scopeKey", "ledgerAccountId", "effectiveFrom", "setById")
      VALUES (${id}, ${tid}, 'BANK', ${scope}, ${acct.bank!}, '2001-01-01'::date, ${randomUUID()})`,
    );

    await expect(
      asAppRole(
        (tx) => tx.$executeRaw`UPDATE "ledger_posting_roles" SET "ledgerAccountId" = ${acct.effA!} WHERE "id" = ${id}`,
      ),
    ).rejects.toThrow(/permission denied|insert-only/);
    await expect(
      asAppRole((tx) => tx.$executeRaw`DELETE FROM "ledger_posting_roles" WHERE "id" = ${id}`),
    ).rejects.toThrow(/permission denied|insert-only/);
  });

  it('refuses UPDATE and DELETE for the table owner too: the trigger binds every role', async () => {
    const id = randomUUID();
    const scope = `pplumb-owner-${randomUUID()}`;
    await asAppRole(
      (tx) => tx.$executeRaw`
      INSERT INTO "ledger_posting_roles"
        ("id", "tenantId", "role", "scopeKey", "ledgerAccountId", "effectiveFrom", "setById")
      VALUES (${id}, ${tid}, 'BANK', ${scope}, ${acct.bank!}, '2001-01-01'::date, ${randomUUID()})`,
    );

    await expect(
      asOwner(
        (tx) => tx.$executeRaw`UPDATE "ledger_posting_roles" SET "ledgerAccountId" = ${acct.effA!} WHERE "id" = ${id}`,
      ),
    ).rejects.toThrow(/insert-only/);
    await expect(
      asOwner((tx) => tx.$executeRaw`DELETE FROM "ledger_posting_roles" WHERE "id" = ${id}`),
    ).rejects.toThrow(/insert-only/);
    const still = await unscopedPrisma.$queryRaw<
      { n: number }[]
    >`SELECT 1::int AS n FROM "ledger_posting_roles" WHERE "id" = ${id}`;
    expect(still).toHaveLength(1);
  });

  it('keeps the mappings inside the tenant: another tenant reads none of them and cannot write one for this tenant', async () => {
    const mine = await asAppRole(
      (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "ledger_posting_roles" WHERE "tenantId" = ${tid}`,
    );
    expect(mine[0]!.n).toBeGreaterThan(0);

    const theirs = await asAppRole(
      (tx) =>
        tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "ledger_posting_roles" WHERE "tenantId" = ${tid}`,
      otherTid,
    );
    expect(theirs[0]!.n).toBe(0);

    await expect(
      asAppRole(
        (tx) => tx.$executeRaw`
          INSERT INTO "ledger_posting_roles"
            ("id", "tenantId", "role", "scopeKey", "ledgerAccountId", "effectiveFrom", "setById")
          VALUES (${randomUUID()}, ${tid}, 'BANK', ${`cross-${randomUUID()}`}, ${acct.bank!}, '2001-01-01'::date, ${randomUUID()})`,
        otherTid,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('refuses a window that ends on or before it starts', async () => {
    await expect(
      asAppRole(
        (tx) => tx.$executeRaw`
        INSERT INTO "ledger_posting_roles"
          ("id", "tenantId", "role", "scopeKey", "ledgerAccountId", "effectiveFrom", "effectiveTo", "setById")
        VALUES (${randomUUID()}, ${tid}, 'BANK', ${`window-${randomUUID()}`}, ${acct.bank!},
                '2030-06-01'::date, '2030-06-01'::date, ${randomUUID()})`,
      ),
    ).rejects.toThrow(/ledger_posting_roles_effective_window/);
  });
});

describe('resolvePostingAccount: fails closed, never falls back to a default', () => {
  it('refuses an unmapped role with a typed error', async () => {
    const day = new Date('2044-06-15T00:00:00.000Z');
    const err = await asChairman(() =>
      prisma
        .$transaction((tx) => resolvePostingAccount(tx, 'CASH', '', day))
        .then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(PostingRoleUnmappedError);
    expect(err).toMatchObject({ status: 422, code: 'POSTING_ROLE_UNMAPPED' });
    expect((err as Error).message).toMatch(/Account role CASH is not mapped/);
  });

  it('does not fall back from a business line with no mapping to the unscoped row or to another line', async () => {
    const day = new Date('2044-06-15T00:00:00.000Z');
    // REVENUE is mapped for lineId, not for otherLineId; the refusal must not borrow lineId's account.
    await expect(
      asChairman(() => prisma.$transaction((tx) => resolvePostingAccount(tx, 'REVENUE', otherLineId, day))),
    ).rejects.toBeInstanceOf(PostingRoleUnmappedError);
    await expect(
      asChairman(() => prisma.$transaction((tx) => resolvePostingAccount(tx, 'REVENUE', '', day))),
    ).rejects.toBeInstanceOf(PostingRoleUnmappedError);
    const mapped = await asChairman(() =>
      prisma.$transaction((tx) => resolvePostingAccount(tx, 'REVENUE', lineId, day)),
    );
    expect(mapped).toBe(acct.revenue);
  });

  it('resolves the mapping in force on the IST day, and refuses on and after its effectiveTo', async () => {
    const scope = `eff-${randomUUID()}`;
    await mapRole('BANK', scope, acct.effA!, '2040-04-01');
    await mapRole('BANK', scope, acct.effB!, '2043-04-01', '2045-04-01');

    const at = (iso: string) =>
      asChairman(() => prisma.$transaction((tx) => resolvePostingAccount(tx, 'BANK', scope, new Date(iso))));

    expect(await at('2042-06-10T05:00:00.000Z')).toBe(acct.effA);
    // 23:30 IST on 31 March 2043 is still A; 00:30 IST on 1 April 2043 is B. The day is IST, not UTC (CLAUDE.md rule 3).
    expect(await at('2043-03-31T18:00:00.000Z')).toBe(acct.effA);
    expect(await at('2043-03-31T19:00:00.000Z')).toBe(acct.effB);
    // 31 March 2045 IST is the last day of B; 1 April 2045 IST is past effectiveTo, so the role is unmapped.
    expect(await at('2045-03-31T18:29:00.000Z')).toBe(acct.effB);
    await expect(at('2045-03-31T18:30:00.000Z')).rejects.toBeInstanceOf(PostingRoleUnmappedError);
  });

  it('resolves a set of roles for a builder, and refuses the whole set if one is unmapped', async () => {
    const day = new Date('2044-06-15T00:00:00.000Z');
    const resolved = await asChairman(() =>
      prisma.$transaction((tx) =>
        resolvePostingAccounts(
          tx,
          [
            { role: 'TRADE_RECEIVABLE', scopeKey: '' },
            { role: 'REVENUE', scopeKey: lineId },
            { role: 'OUTPUT_CGST', scopeKey: '' },
          ],
          day,
        ),
      ),
    );
    expect(resolved.get(postingAccountKey('REVENUE', lineId))).toBe(acct.revenue);
    await expect(
      asChairman(() =>
        prisma.$transaction((tx) =>
          resolvePostingAccounts(
            tx,
            [
              { role: 'TRADE_RECEIVABLE', scopeKey: '' },
              { role: 'CASH', scopeKey: '' },
            ],
            day,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(PostingRoleUnmappedError);
  });
});

describe('pure builders: balanced bigint lines, fixture accounts only', () => {
  const party = 'pplumb-party-1';

  it('builds a balanced invoice entry for an 18% supply: receivable, revenue, CGST and SGST', () => {
    const lines = buildInvoiceIssueEntry(
      {
        partyId: party,
        grandTotalMinor: 11800n,
        revenue: [{ lineId, taxableMinor: 10000n }],
        cgstMinor: 900n,
        sgstMinor: 900n,
        igstMinor: 0n,
        roundOffMinor: 0n,
      },
      fixtureAccounts(),
    );
    expect(lines.map((l) => l.accountId)).toEqual([acct.receivable, acct.revenue, acct.cgst, acct.sgst]);
    expect(lines[0]).toMatchObject({ accountId: acct.receivable, amountMinor: 11800n, partyId: party });
    expect(lines.every((l) => typeof l.amountMinor === 'bigint')).toBe(true);
    expect(lines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);
  });

  it('balances a round-off of +0.40 and of -0.30 to the paisa, on the round-off account', () => {
    const base = {
      partyId: party,
      revenue: [{ lineId, taxableMinor: 10000n }],
      cgstMinor: 900n,
      sgstMinor: 900n,
      igstMinor: 0n,
    };
    const up = buildInvoiceIssueEntry({ ...base, grandTotalMinor: 11840n, roundOffMinor: 40n }, fixtureAccounts());
    const down = buildInvoiceIssueEntry({ ...base, grandTotalMinor: 11770n, roundOffMinor: -30n }, fixtureAccounts());
    expect(up.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);
    expect(down.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);
    expect(up.find((l) => l.accountId === acct.roundOff)?.amountMinor).toBe(-40n);
    expect(down.find((l) => l.accountId === acct.roundOff)?.amountMinor).toBe(30n);
  });

  it('refuses components that do not add to the grand total, and says by how much', () => {
    expect(() =>
      buildInvoiceIssueEntry(
        {
          partyId: party,
          grandTotalMinor: 11801n,
          revenue: [{ lineId, taxableMinor: 10000n }],
          cgstMinor: 900n,
          sgstMinor: 900n,
          igstMinor: 0n,
          roundOffMinor: 0n,
        },
        fixtureAccounts(),
      ),
    ).toThrow(/out by 1/);
  });

  it('refuses an income line with no business line (O2), whether lineId is null or absent', () => {
    const source = {
      partyId: party,
      grandTotalMinor: 11800n,
      cgstMinor: 900n,
      sgstMinor: 900n,
      igstMinor: 0n,
      roundOffMinor: 0n,
    };
    for (const revenue of [
      [{ lineId: null, taxableMinor: 10000n }],
      [{ lineId: undefined, taxableMinor: 10000n }],
      [
        { lineId, taxableMinor: 4000n },
        { lineId: '', taxableMinor: 6000n },
      ],
    ]) {
      expect(() => buildInvoiceIssueEntry({ ...source, revenue }, fixtureAccounts())).toThrow(PostingRuleError);
      expect(() => buildInvoiceIssueEntry({ ...source, revenue }, fixtureAccounts())).toThrow(/business line/);
    }
  });

  it('refuses a JavaScript number where a bigint is required', () => {
    expect(() =>
      buildInvoiceIssueEntry(
        {
          partyId: party,
          grandTotalMinor: 11800 as unknown as bigint,
          revenue: [{ lineId, taxableMinor: 10000n }],
          cgstMinor: 900n,
          sgstMinor: 900n,
          igstMinor: 0n,
          roundOffMinor: 0n,
        },
        fixtureAccounts(),
      ),
    ).toThrow(TypeError);
  });

  it('refuses a role the accounts map does not carry, and never substitutes one', () => {
    const withoutCgst: ResolvedPostingAccounts = new Map(
      [...fixtureAccounts()].filter(([key]) => key !== postingAccountKey('OUTPUT_CGST', '')),
    );
    expect(() =>
      buildInvoiceIssueEntry(
        {
          partyId: party,
          grandTotalMinor: 11800n,
          revenue: [{ lineId, taxableMinor: 10000n }],
          cgstMinor: 900n,
          sgstMinor: 900n,
          igstMinor: 0n,
          roundOffMinor: 0n,
        },
        withoutCgst,
      ),
    ).toThrow(/Account role OUTPUT_CGST is not mapped/);
  });

  it('builds a balanced receipt allocation: bank debited, receivable credited, for the payment mode', () => {
    const lines = buildReceiptAllocationEntry(
      { partyId: party, amountMinor: 11800n, paymentMode: 'UPI' },
      fixtureAccounts(),
    );
    expect(lines).toEqual([
      { accountId: acct.bank, amountMinor: 11800n },
      { accountId: acct.receivable, amountMinor: -11800n, partyId: party },
    ]);
    expect(() =>
      buildReceiptAllocationEntry({ partyId: party, amountMinor: 0n, paymentMode: 'UPI' }, fixtureAccounts()),
    ).toThrow(PostingRuleError);
  });
});

describe('builders posted through postInTx, with resolved accounts; the trial balance after each step', () => {
  it('posts a resolved invoice issue and then a receipt allocation, and the trial balance holds after each', async () => {
    await period('2044-07', 'open');
    const day = new Date('2044-07-20T00:00:00.000Z');
    const party = randomUUID();
    const invoiceId = randomUUID();
    const receiptId = randomUUID();

    const invoice = await asChairman(() =>
      prisma.$transaction(async (tx) => {
        const accounts = await resolvePostingAccounts(
          tx,
          [
            { role: 'TRADE_RECEIVABLE', scopeKey: '' },
            { role: 'REVENUE', scopeKey: lineId },
            { role: 'OUTPUT_CGST', scopeKey: '' },
            { role: 'OUTPUT_SGST', scopeKey: '' },
          ],
          day,
        );
        const lines = buildInvoiceIssueEntry(
          {
            partyId: party,
            grandTotalMinor: 11800n,
            revenue: [{ lineId, taxableMinor: 10000n }],
            cgstMinor: 900n,
            sgstMinor: 900n,
            igstMinor: 0n,
            roundOffMinor: 0n,
          },
          accounts,
        );
        return postInTx(tx, {
          entityId,
          entryDate: day,
          narration: 'Invoice issued (fixture)',
          sourceType: 'invoice',
          sourceId: invoiceId,
          idempotencyKey: postingKeys.invoiceIssue(invoiceId),
          lines,
        });
      }),
    );
    await asChairman(assertBalances);

    const invoiceLines = await unscopedPrisma.journalLine.findMany({
      where: { tenantId: tid, entryId: invoice.id },
      orderBy: { lineNo: 'asc' },
    });
    expect(invoiceLines[0]).toMatchObject({ accountId: acct.receivable, amountMinor: 11800n, partyId: party });
    expect(invoiceLines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);

    const receipt = await asChairman(() =>
      prisma.$transaction(async (tx) => {
        const accounts = await resolvePostingAccounts(
          tx,
          [
            { role: 'BANK', scopeKey: 'UPI' },
            { role: 'TRADE_RECEIVABLE', scopeKey: '' },
          ],
          day,
        );
        const lines = buildReceiptAllocationEntry(
          { partyId: party, amountMinor: 11800n, paymentMode: 'UPI' },
          accounts,
        );
        return postInTx(tx, {
          entityId,
          entryDate: day,
          narration: 'Receipt allocated (fixture)',
          sourceType: 'receipt',
          sourceId: receiptId,
          idempotencyKey: postingKeys.receiptAllocated(receiptId),
          lines,
        });
      }),
    );
    await asChairman(assertBalances);
    expect(receipt.sourceType).toBe('receipt');
  });
});
