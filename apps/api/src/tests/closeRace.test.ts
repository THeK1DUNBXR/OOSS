/**
 * The close race (FX-70, Wave 5 PR1; contract section 4.1 defect 6 and section 8).
 *
 * Before this change a legacy cashbook write was refused only in a `closed`
 * period, so a write could land while the period was `closing`. The close took
 * its snapshot before it took the period row's lock, so a write that committed
 * between the two was in the closed period and not in its snapshot. These tests
 * hold the close at the lock and attempt that write inside the window.
 *
 * Real Postgres, real contexts, no mocks. The period row lock is held by a
 * second connection, the way a posting holds it (platform/ledger.ts
 * lockPostablePeriod takes FOR SHARE on the same row).
 *
 * Each test reads its own IST month so one test's period cannot leak into another.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { istMonthKey } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { recordTransaction } from '../domains/books.js';
import { closePeriod, openAccountingDate, requestClosePeriod, trialBalance } from '../domains/compliance/books.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';

const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

const JAN = '2029-01';
const FEB = '2029-02';
const MAR = '2029-03';

const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
const TB_ASOF = new Date('2029-12-31T12:00:00.000Z');

let TENANT: string;
let ACCOUNT_ID: string;
let CATEGORY_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  ACCOUNT_ID = (
    await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    })
  ).id;
  CATEGORY_ID = (await unscopedPrisma.ledgerCategory.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

/** Puts an IST month back to `open`, so each test starts from the same status. Direct write, test fixture only. */
async function openPeriodForTest(month: string) {
  await unscopedPrisma.accountingPeriod.upsert({
    where: { tenantId_period: { tenantId: TENANT, period: month } },
    create: { tenantId: TENANT, period: month, fy: '2028-29', status: 'open' },
    update: { status: 'open' },
  });
}

/** A cashbook receipt into the bank account, dated mid-month in IST. */
function receiptIn(month: string, reference: string) {
  return {
    txnDate: new Date(`${month}-15T06:00:00.000Z`),
    direction: 'in' as const,
    amount: 1000,
    accountId: ACCOUNT_ID,
    categoryId: CATEGORY_ID,
    reference,
    note: 'W5 close race probe',
    source: 'manual',
  };
}

async function countTransactions(reference: string): Promise<number> {
  return unscopedPrisma.transaction.count({ where: { tenantId: TENANT, reference } });
}

/** The journal balances as of now. Each committed step is followed by this. */
async function assertJournalBalances(): Promise<void> {
  assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));
}

/**
 * Resolves once some backend is waiting for a lock. While the period lock is
 * held, the only session that can be waiting on it is the close, so this is
 * the close parked at its lock. It waits on database state, not on the clock.
 * pg_stat_activity is not used: the scoped client connects under a role that
 * hides its sessions' queries from the test role.
 *
 * A row-level wait is a transactionid lock, and those rows carry no database
 * OID, hence the `database IS NULL` branch.
 */
async function untilBlockedOnLock(): Promise<void> {
  // A deadline is only a ceiling on a hung test. The close reads the legacy
  // trial balance before it reaches the lock, which can take seconds on a busy host.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const rows = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS "n" FROM pg_locks
      WHERE NOT "granted"
        AND ("database" IS NULL
          OR "database" = (SELECT "oid" FROM pg_database WHERE "datname" = current_database()))`;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the close never reached the period lock');
}

describe('T70-9: a legacy write in a closing period is refused', () => {
  it('a cashbook entry dated in a closing month is refused, writes nothing, and the legacy TB does not move', async () => {
    await openPeriodForTest(JAN);
    await asUser(FINANCE, () => requestClosePeriod(JAN));
    await assertJournalBalances();

    const tbBefore = await asUser(CHAIRMAN, () => trialBalance(TB_ASOF));
    const reference = unique('W5 closing probe');
    const refusal = await expectReject(() => asUser(FINANCE, () => recordTransaction(receiptIn(JAN, reference))));

    expect(refusal.status).toBe(422);
    expect(refusal.message).toContain('closing');
    expect(await countTransactions(reference)).toBe(0);
    expect(await asUser(CHAIRMAN, () => trialBalance(TB_ASOF))).toEqual(tbBefore);
    await assertJournalBalances();
  });
});

describe('T70-10: a legacy write that reaches the close while it waits for the lock is refused', () => {
  it('the close holds the period lock, a cashbook write lands in the window and is refused, and the snapshot is the books as the close left them', async () => {
    await openPeriodForTest(FEB);
    await asUser(FINANCE, () => requestClosePeriod(FEB));
    await assertJournalBalances();

    const period = await unscopedPrisma.accountingPeriod.findFirstOrThrow({
      where: { tenantId: TENANT, period: FEB },
    });

    // Stands in for a transaction that holds the period row while it writes.
    // The close cannot take its lock until this one ends.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    const holding = unscopedPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
      await tx.$queryRaw`SELECT "id" FROM "cmp_accounting_periods" WHERE "id" = ${period.id} FOR SHARE`;
      signalHeld();
      await gate;
    }, { timeout: 60_000, maxWait: 10_000 });
    // The close must not start until the lock is held, or it could finish before the hold exists.
    await held;

    const closing = asUser(CHAIRMAN, () => closePeriod(FEB));
    const reference = unique('W5 close window probe');
    let attempt: { status?: number; message: string } | 'accepted' = 'accepted';
    try {
      await untilBlockedOnLock();
      try {
        await asUser(FINANCE, () => recordTransaction(receiptIn(FEB, reference)));
      } catch (err) {
        const e = err as { status?: number; message: string };
        attempt = { status: e.status, message: e.message };
      }
    } finally {
      release();
      await holding;
    }

    const closed = await closing;
    expect(closed.status).toBe('closed');

    // A write made in the window is refused, not accepted into a period whose figures are being taken.
    expect(attempt).not.toBe('accepted');
    expect((attempt as { status?: number }).status).toBe(422);
    expect(await countTransactions(reference)).toBe(0);

    // The stored figures are the books as they stand once the close has taken them.
    const snapshot = closed.snapshot as unknown as {
      cashbook: unknown;
      journal: { asOf: string; debitsMinor: string; creditsMinor: string; lineCount: number };
    };
    expect(JSON.parse(JSON.stringify(snapshot.cashbook))).toEqual(
      JSON.parse(JSON.stringify(await asUser(CHAIRMAN, () => trialBalance(TB_ASOF)))),
    );
    assertTrialBalance({
      asOf: snapshot.journal.asOf,
      debitsMinor: BigInt(snapshot.journal.debitsMinor),
      creditsMinor: BigInt(snapshot.journal.creditsMinor),
      lineCount: snapshot.journal.lineCount,
    });
    await assertJournalBalances();
  });
});

describe('money that has already arrived moves past a closing month', () => {
  it('openAccountingDate skips a month that is closing, as it skips a closed one', async () => {
    await openPeriodForTest(MAR);
    await asUser(FINANCE, () => requestClosePeriod(MAR));

    const date = await asUser(FINANCE, () => openAccountingDate(new Date(`${MAR}-15T06:00:00.000Z`)));
    expect(istMonthKey(date)).toBe('2029-04');
    await assertJournalBalances();
  });
});
