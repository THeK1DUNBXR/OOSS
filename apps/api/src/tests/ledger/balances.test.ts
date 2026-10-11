/**
 * Derived balances, the journal trial balance and the nightly drift check
 * (ORDERED-PLAN Wave 3, item 1.4; archive phase-1-ledger.md section 1.4).
 *
 * Real Postgres, real contexts, no mocks. Each test file-level fixture is a
 * tenant of its own, so the trial balance and the drift check see only the
 * entries this file posted. The owner role corrupts the cache (the only role
 * that can); the application role is asserted refused.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { istCivilDay } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { balanceOf, post, reverse } from '../../platform/ledger.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { closePeriod } from '../../domains/compliance/books.js';
import { ALL_JOBS } from '../../jobs/scheduler.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );
const app = new PrismaClient({ datasourceUrl: APP_URL });

const DRIFT_JOB = 'runAccountBalanceDriftJob';
const DRIFT_CODE = 'EX-LED-001';

interface Ledger {
  tid: string;
  entityId: string;
  bank: string;
  capital: string;
}

let ledger: Ledger;

/** A tenant of its own with a bank and a capital account, so no other file's entries are in its balances. */
async function freshLedger(label: string): Promise<Ledger> {
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Balances ${label}`, slug: `bal-${label}-${randomUUID().slice(0, 8)}` },
  });
  const tid = tenant.id;
  const entity = await unscopedPrisma.ledgerEntity.create({
    data: { tenantId: tid, code: 'BAL', legalName: 'Balances test entity', stateCode: '27' },
  });
  const bank = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Bank', accountClass: 'asset' },
  });
  const capital = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Capital', accountClass: 'equity' },
  });
  return { tid, entityId: entity.id, bank: bank.id, capital: capital.id };
}

/** An IST month's period, open. The 2030 months are the test's own; no real month is touched. */
async function openPeriod(l: Ledger, month: string, status = 'open') {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return unscopedPrisma.accountingPeriod.create({
    data: {
      tenantId: l.tid,
      entityId: l.entityId,
      period: month,
      fy: '2030-31',
      status,
      startsOn: new Date(`${month}-01T00:00:00.000Z`),
      endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
    },
  });
}

/** Posts `amount` into the bank from capital, dated by IST civil day (the caller's job, CLAUDE.md rule 3). */
function postOn(l: Ledger, isoDay: string, amount: bigint) {
  return asSystem(l.tid, () =>
    post({
      entityId: l.entityId,
      entryDate: new Date(`${isoDay}T00:00:00.000Z`),
      narration: 'Balances fixture',
      sourceType: 'manual',
      idempotencyKey: `bal:${randomUUID()}`,
      lines: [
        { accountId: l.bank, amountMinor: amount },
        { accountId: l.capital, amountMinor: -amount },
      ],
    }),
  );
}

/** Runs `fn` as the application role, with the tenant set the way platform/db.ts sets it. */
function asAppRole<T>(l: Ledger, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${l.tid}, true)`;
    return fn(tx);
  });
}

function driftJob() {
  const job = ALL_JOBS.find((j) => j.name === DRIFT_JOB);
  if (!job) throw new Error(`${DRIFT_JOB} is not registered`);
  return job;
}

function runDrift(l: Ledger) {
  return asSystem(l.tid, () => driftJob().run(new AbortController().signal));
}

afterAll(async () => {
  await app.$disconnect();
});

describe('1.4 balanceOf is as of an IST day', () => {
  beforeAll(async () => {
    ledger = await freshLedger('boundary');
  });

  it('IST midnight on a civil day is the day it names, whatever the UTC date of the instant', () => {
    // 00:10 IST on 1 April is 18:40Z on 31 March: a getUTCMonth-based reading puts it in March.
    expect(istCivilDay(new Date('2030-03-31T18:40:00.000Z')).toISOString()).toBe('2030-04-01T00:00:00.000Z');
    expect(istCivilDay(new Date('2030-03-31T18:29:59.999Z')).toISOString()).toBe('2030-03-31T00:00:00.000Z');
  });

  it('an entry posted 00:00 to 05:30 IST on 1 April is in the new year, not in the old one', async () => {
    await openPeriod(ledger, '2030-03');
    await openPeriod(ledger, '2030-04');
    await postOn(ledger, '2030-04-01', 50000n);

    await asSystem(ledger.tid, async () => {
      // 23:59:59 IST on 31 March, and 00:00 IST on 1 April.
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:29:59.999Z'))).toBe(0n);
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:30:00.000Z'))).toBe(50000n);
      // 00:10 IST on 1 April, as an instant the caller might pass.
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:40:00.000Z'))).toBe(50000n);
    });
  });
});

describe('1.4 reversal effects on the balance', () => {
  beforeAll(async () => {
    ledger = await freshLedger('reversal');
    await openPeriod(ledger, '2030-05');
  });

  it('a reversal returns the balance to where it was, and negates every line of the original', async () => {
    await postOn(ledger, '2030-05-02', 1000n);
    const original = await postOn(ledger, '2030-05-10', 25000n);
    const asOf = new Date('2030-05-31T00:00:00.000Z');

    await asSystem(ledger.tid, async () => {
      expect(await balanceOf(ledger.bank, asOf)).toBe(26000n);
      const reversal = await reverse(original.id, 'Entered in error');
      expect(await balanceOf(ledger.bank, asOf)).toBe(1000n);
      expect(await balanceOf(ledger.capital, asOf)).toBe(-1000n);

      const lines = await unscopedPrisma.journalLine.findMany({
        where: { entryId: reversal.id },
        orderBy: { lineNo: 'asc' },
      });
      expect(lines.map((l) => l.amountMinor)).toEqual([-25000n, 25000n]);
    });
  });
});

describe('1.4 journal trial balance', () => {
  beforeAll(async () => {
    ledger = await freshLedger('trial');
    await openPeriod(ledger, '2030-06');
    await openPeriod(ledger, '2030-07');
    await postOn(ledger, '2030-06-05', 7000n);
    await postOn(ledger, '2030-06-20', 3000n);
    await postOn(ledger, '2030-07-03', 900n);
  });

  it('debits equal credits, as bigint, and the balance is the sum of the postings on the day', async () => {
    const tb = await journalTrialBalance(new Date('2030-06-30T00:00:00.000Z'));
    expect(typeof tb.debitsMinor).toBe('bigint');
    expect(tb.debitsMinor).toBe(10000n);
    expect(tb.creditsMinor).toBe(10000n);
    expect(() => assertTrialBalance(tb)).not.toThrow();
  });

  it('after every posting this file made, the whole tenant nets to zero', async () => {
    const tb = await journalTrialBalance(new Date('2099-12-31T00:00:00.000Z'));
    expect(tb.debitsMinor).toBe(10900n);
    expect(tb.debitsMinor - tb.creditsMinor).toBe(0n);
    assertTrialBalance(tb);
  });

  it('the assertion refuses a trial balance whose debits and credits differ', () => {
    expect(() =>
      assertTrialBalance({ asOf: '2030-06-30', debitsMinor: 100n, creditsMinor: 99n, lineCount: 2 }),
    ).toThrow(/debits 100 and credits 99/);
  });
});

describe('1.4 nightly drift check on the closed-period snapshots', () => {
  beforeAll(async () => {
    ledger = await freshLedger('drift');
    await openPeriod(ledger, '2030-08');
    await postOn(ledger, '2030-08-10', 7000n);
    await postOn(ledger, '2030-08-20', 3000n);
    await unscopedPrisma.accountingPeriod.updateMany({
      where: { tenantId: ledger.tid, period: '2030-08' },
      data: { status: 'closing' },
    });
    await asSystem(ledger.tid, () => closePeriod('2030-08'));
  });

  it('a clean closed period gets one snapshot per account and raises nothing', async () => {
    await runDrift(ledger);
    const snaps = await unscopedPrisma.accountBalanceSnapshot.findMany({ where: { tenantId: ledger.tid } });
    const byAccount = new Map(snaps.map((s) => [s.accountId, s.balanceMinor]));
    expect(byAccount.get(ledger.bank)).toBe(10000n);
    expect(byAccount.get(ledger.capital)).toBe(-10000n);
    expect(await exceptionsFor(ledger, DRIFT_CODE)).toHaveLength(0);
  });

  it('a rerun writes no second snapshot and raises nothing', async () => {
    const before = await unscopedPrisma.accountBalanceSnapshot.count({ where: { tenantId: ledger.tid } });
    const again = await runDrift(ledger);
    const after = await unscopedPrisma.accountBalanceSnapshot.count({ where: { tenantId: ledger.tid } });
    expect(after).toBe(before);
    expect(again.errors).toEqual([]);
    expect(await exceptionsFor(ledger, DRIFT_CODE)).toHaveLength(0);
  });

  it('a snapshot corrupted through the owner role raises one exception, names both figures, and is left as it is', async () => {
    await unscopedPrisma.accountBalanceSnapshot.updateMany({
      where: { tenantId: ledger.tid, accountId: ledger.bank },
      data: { balanceMinor: 9999n },
    });

    await runDrift(ledger);
    const raised = await exceptionsFor(ledger, DRIFT_CODE);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.subjectType).toBe('ledger_account');
    expect(raised[0]!.subjectId).toBe(ledger.bank);
    expect(raised[0]!.severity).toBe('S1_ATTENTION');
    expect(raised[0]!.detail).toContain('expected 10000');
    expect(raised[0]!.detail).toContain('actual 9999');

    const row = await unscopedPrisma.accountBalanceSnapshot.findFirstOrThrow({
      where: { tenantId: ledger.tid, accountId: ledger.bank },
    });
    expect(row.balanceMinor).toBe(9999n);
  });

  it('a rerun of the drift check on the same corruption raises no second exception', async () => {
    await runDrift(ledger);
    expect(await exceptionsFor(ledger, DRIFT_CODE)).toHaveLength(1);
  });

  it('the application role cannot update or delete a snapshot', async () => {
    await expect(
      asAppRole(ledger, (tx) =>
        tx.$executeRaw`UPDATE "account_balance_snapshots" SET "balanceMinor" = 10000 WHERE "tenantId" = ${ledger.tid}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAppRole(ledger, (tx) => tx.$executeRaw`DELETE FROM "account_balance_snapshots" WHERE "tenantId" = ${ledger.tid}`),
    ).rejects.toThrow(/permission denied/);
  });
});

function exceptionsFor(l: Ledger, code: string) {
  return unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: l.tid, code } });
}

describe('1.4 trial balance and drift are per tenant', () => {
  it('a tenant with no postings has a zero trial balance and nothing to drift', async () => {
    const empty = await freshLedger('empty');
    const tb = await asSystem(empty.tid, () => journalTrialBalance(new Date('2099-12-31T00:00:00.000Z')));
    expect(tb.debitsMinor).toBe(0n);
    expect(tb.creditsMinor).toBe(0n);
    const result = await runDrift(empty);
    expect(result.errors).toEqual([]);
    expect(result.processed).toBe(0);
  });
});
