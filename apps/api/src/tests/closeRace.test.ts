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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istMonthKey, monthRange } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  prisma,
  reopenLatestFirst,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { recordTransaction, writeTransactionMinor } from '../domains/books.js';
import { closePeriod, openAccountingDate, requestClosePeriod, trialBalance } from '../domains/compliance/books.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';
import { stageImport, setImportOptions } from '../imports/service.js';
import { commitImport } from '../imports/commit.js';

const JAN = '2029-01';
const FEB = '2029-02';
const MAR = '2029-03';

const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
const TB_ASOF = new Date('2029-12-31T12:00:00.000Z');

let FIXTURE: BooksTenant;
let TENANT: string;
let FINANCE: string;
let CHAIRMAN: string;
let ACCOUNT_ID: string;
let CATEGORY_ID: string;

beforeAll(async () => {
  FIXTURE = await booksTenant('close-race');
  TENANT = FIXTURE.tenantId;
  FINANCE = FIXTURE.finance;
  CHAIRMAN = FIXTURE.chairman;
  ACCOUNT_ID = FIXTURE.bankAccountId;
  CATEGORY_ID = FIXTURE.categoryId;
  // A run that stopped inside a close window leaves months closed. Reopen the closed ones before this run writes.
  await reopenLatestFirst(FIXTURE, 'Test fixture reset at the start of the run');
});

afterAll(async () => {
  await reopenLatestFirst(FIXTURE, 'Close race tests finished; reopening the months they closed');
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Closes every month of the tenant before `month` that is not closed yet, ascending. A close
 * is refused while an earlier month is open or closing, so a race test whose month is later
 * than an earlier test's walks the earlier months first. These are plain requests and
 * approvals, not part of any race.
 */
async function closeEarlierThan(month: string): Promise<void> {
  const pending = await unscopedPrisma.accountingPeriod.findMany({
    where: { tenantId: TENANT, period: { lt: month }, status: { not: 'closed' } },
    select: { period: true, status: true },
    orderBy: { period: 'asc' },
  });
  for (const row of pending) {
    if (row.status === 'open' || row.status === 'reopened') {
      await asUser(FINANCE, () => requestClosePeriod(row.period));
    }
    await asUser(CHAIRMAN, () => closePeriod(row.period));
  }
}

/** Puts an IST month back to `open`, so each test starts from the same status. Direct write, test fixture only. */
async function openPeriodForTest(month: string) {
  await unscopedPrisma.accountingPeriod.upsert({
    where: { tenantId_period: { tenantId: TENANT, period: month } },
    create: { tenantId: TENANT, period: month, fy: '2028-29', status: 'open' },
    update: { status: 'open' },
  });
}

/** A month no earlier run has used. Periods persist in the test database, so a fixed month is fresh only once. */
function freshMonth(): string {
  const year = 2100 + Math.floor(Math.random() * 90);
  const month = 1 + Math.floor(Math.random() * 12);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** A cashbook receipt into the bank account, dated mid-month in IST. */
/**
 * A month later than every closed month of the tenant. A month with no row under a closed
 * later month counts as closed (periodStatus), so a probe month that has no row must sit
 * after the latest closed one for its legacy write to be accepted.
 */
async function freshMonthAfterLatestClosed(): Promise<string> {
  const latest = await unscopedPrisma.accountingPeriod.findFirst({
    where: { tenantId: TENANT, status: 'closed' },
    orderBy: { period: 'desc' },
    select: { period: true },
  });
  const [year, month] = (latest?.period ?? '2099-12').split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + 1 + Math.floor(Math.random() * 24);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function receiptIn(month: string, reference: string, amount = 1000) {
  return {
    txnDate: new Date(`${month}-15T06:00:00.000Z`),
    direction: 'in' as const,
    amount,
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
 * Resolves once some backend is waiting for a lock, or once `isDone` reports the
 * awaited call has settled, whichever comes first. While the period lock is
 * held, the only session that can be waiting on it is the close, so this is
 * the close parked at its lock. It waits on database state, not on the clock.
 * pg_stat_activity is not used: the scoped client connects under a role that
 * hides its sessions' queries from the test role.
 *
 * A row-level wait is a transactionid lock, and those rows carry no database
 * OID, hence the `database IS NULL` branch.
 */
async function lockWaiting(): Promise<boolean> {
  const rows = await unscopedPrisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS "n" FROM pg_locks
    WHERE NOT "granted"
      AND ("database" IS NULL
        OR "database" = (SELECT "oid" FROM pg_database WHERE "datname" = current_database()))`;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function untilBlockedOnLock(isDone: () => boolean = () => false): Promise<void> {
  // A deadline is only a ceiling on a hung test. The close reads the legacy
  // trial balance before it reaches the lock, which can take seconds on a busy host.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (isDone()) return;
    if (await lockWaiting()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the close never reached the period lock');
}

async function periodStatusOf(month: string): Promise<string | undefined> {
  const row = await unscopedPrisma.accountingPeriod.findFirst({
    where: { tenantId: TENANT, period: month },
    select: { status: true },
  });
  return row?.status;
}

/**
 * Resolves once the close has moved the period, or once it is parked on a lock.
 * Either way the status read after it says whether the close got past the open write.
 */
async function untilStatusMovedOrWaiting(month: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if ((await periodStatusOf(month)) !== 'open') return;
    if (await lockWaiting()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the close neither moved the period nor waited on a lock');
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
    await closeEarlierThan(FEB);
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
    const holding = unscopedPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await tx.$queryRaw`SELECT "id" FROM "cmp_accounting_periods" WHERE "id" = ${period.id} FOR SHARE`;
        signalHeld();
        await gate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
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
    const { journal, ...cashbook } = closed.snapshot as unknown as {
      journal: { asOf: string; debitsMinor: string; creditsMinor: string; lineCount: number };
      asOf: string;
      rows: unknown[];
      totalDebit: number;
      totalCredit: number;
    };
    // The close takes its figures as of the last instant of the month, so the live figures are read at that instant.
    const monthEnd = new Date(monthRange(FEB).to.getTime() - 1);
    expect(cashbook).toEqual(JSON.parse(JSON.stringify(await asUser(CHAIRMAN, () => trialBalance(monthEnd)))));
    assertTrialBalance({
      asOf: journal.asOf,
      debitsMinor: BigInt(journal.debitsMinor),
      creditsMinor: BigInt(journal.creditsMinor),
      lineCount: journal.lineCount,
    });
    await assertJournalBalances();
  });
});

describe('money that has already arrived moves past a closing month', () => {
  // The test below leaves MAR closing. It is closed here, so no later month's request is refused by it.
  afterAll(async () => {
    await closeThrough(FIXTURE, MAR);
  });

  it('openAccountingDate skips a month that is closing, as it skips a closed one', async () => {
    await openPeriodForTest(MAR);
    await asUser(FINANCE, () => requestClosePeriod(MAR));

    const date = await asUser(FINANCE, () => openAccountingDate(new Date(`${MAR}-15T06:00:00.000Z`)));
    expect(istMonthKey(date)).toBe('2029-04');
    await assertJournalBalances();
  });
});

describe('T70-13: a legacy write holding the period lock makes the close wait, and its amount is in the snapshot', () => {
  it('the close cannot move the period while a write is open; the write is in the snapshot; a write after the close is refused', async () => {
    const month = freshMonth();
    const monthEnd = new Date(monthRange(month).to.getTime() - 1);
    const refA = unique('W5 open write');
    const refB = unique('W5 after close');
    // The row exists before write A starts. Otherwise the close would create it, and that
    // creation is audited, which queues on the audit chain lock write A holds. The wait
    // would then look like the period lock. With the row present, the only thing the
    // close can wait on is the period row.
    await closeEarlierThan(month);
    await openPeriodForTest(month);

    // Write A: the legacy entry and its period lock in one transaction, held open until released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    const writeA = asUser(FINANCE, () =>
      prisma.$transaction(
        async (tx) => {
          const txn = await writeTransactionMinor({ ...receiptIn(month, refA), amount: 2500n }, tx);
          signalHeld();
          await gate;
          return txn;
        },
        { timeout: 60_000, maxWait: 10_000 },
      ),
    );
    await Promise.race([held, writeA]);

    // The close's first step, the request, takes the period row. It must queue behind write A.
    // Write A holds the audit chain lock too, so the close can also park after its status
    // update, on the audit write. The status read is the test: a committed update is visible.
    const requesting = asUser(FINANCE, () => requestClosePeriod(month));
    try {
      await untilStatusMovedOrWaiting(month);
      expect(await periodStatusOf(month)).toBe('open');
    } finally {
      release();
    }

    const txnA = await writeA;
    expect(txnA.recordCode).toMatch(/^TXN/);
    expect((await requesting).status).toBe('closing');
    await assertJournalBalances();

    const closed = await asUser(CHAIRMAN, () => closePeriod(month));
    expect(closed.status).toBe('closed');
    expect(await countTransactions(refA)).toBe(1);

    // The snapshot is the books as they stood once write A had committed.
    const { journal, ...cashbook } = closed.snapshot as unknown as {
      journal: { asOf: string; debitsMinor: string; creditsMinor: string; lineCount: number };
      asOf: string;
      rows: unknown[];
      totalDebit: number;
      totalCredit: number;
    };
    expect(cashbook).toEqual(JSON.parse(JSON.stringify(await asUser(CHAIRMAN, () => trialBalance(monthEnd)))));
    assertTrialBalance({
      asOf: journal.asOf,
      debitsMinor: BigInt(journal.debitsMinor),
      creditsMinor: BigInt(journal.creditsMinor),
      lineCount: journal.lineCount,
    });
    await assertJournalBalances();

    // A write after the close is refused and writes nothing.
    const refusal = await expectReject(() => asUser(FINANCE, () => recordTransaction(receiptIn(month, refB))));
    expect(refusal.status).toBe(422);
    expect(await countTransactions(refB)).toBe(0);
    await assertJournalBalances();
  });
});

describe('T70-14: a legacy write into a month with no period row creates the row under the lock', () => {
  it('the row exists and is open after the write, and the entry is booked', async () => {
    // After the latest closed month: a row-less month under a closed later month is closed, not open.
    const month = await freshMonthAfterLatestClosed();
    const reference = unique('W5 no period row');
    expect(await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: month } })).toBeNull();

    await asUser(FINANCE, () => recordTransaction(receiptIn(month, reference)));

    const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: month } });
    expect(row?.status).toBe('open');
    expect(await countTransactions(reference)).toBe(1);
    await assertJournalBalances();
  });
});

describe('an import chunk that spans two months, and a close of its earlier month', () => {
  it('the chunk and the close both finish with no deadlock, and each month keeps its row', async () => {
    // Why the earlier month is the one closed. The order rule (books.ts requestClosePeriod)
    // refuses a close while an earlier month is open, so a close of the later month with the
    // earlier one still open cannot happen. The cycle that can form is set up by the statement's
    // row order instead: the chunk takes its rows by rowNumber (imports/commit.ts:242), so a
    // statement that lists the later month first writes that month's row first. The chunk takes
    // every month row it will write, in ascending month order, before its first write
    // (imports/commit.ts:314, platform/periodLock.ts:198). So the close of the earlier month
    // waits on a row the chunk holds, not on the audit lock behind it.
    const months = [freshMonth(), freshMonth()];
    while (months[1] === months[0]) months[1] = freshMonth();
    const [earlier, later] = months.sort();
    await closeEarlierThan(earlier);
    await openPeriodForTest(earlier);
    await openPeriodForTest(later);
    // The earlier month is requested for close before the chunk runs. The request is its own
    // committed write, so it holds nothing afterwards: the close that waits is the approval
    // (closePeriod), which takes the tenant's period advisory lock and then the month row FOR UPDATE.
    await asUser(FINANCE, () => requestClosePeriod(earlier));

    const tag = `W5-CHUNK-${Math.random().toString(36).slice(2, 10)}`;
    const staged = await stageBankStatement(tag, [
      { month: later, amount: '75.00', direction: 'in' },
      { month: earlier, amount: '250.00', direction: 'out' },
    ]);

    // Connection X holds the event chain lock, which emit takes after the audit lock
    // (platform/eventBus.ts). The chunk writes its first row (the later month), takes the audit
    // lock, then queues on the chain, so it holds the audit lock while it waits. The close does
    // not need the audit lock to reach its wait: it queues on the earlier month's row, which the
    // chunk holds FOR SHARE from its up-front lock. Nothing is left to race: the chunk finishes
    // and releases the row as soon as X lets go.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => (releaseHolder = resolve));
    let holderHeld!: () => void;
    const holderReady = new Promise<void>((resolve) => (holderHeld = resolve));
    const holder = unscopedPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EVENT_CHAIN_NAMESPACE}::int, hashtext(${TENANT}))`;
        holderHeld();
        await holderGate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await holderReady;

    const chunk = settle(asUser(CHAIRMAN, () => commitImport(staged.batchId)));
    await waitFor(async () => (await lockWaiters()) >= 1, 'the import chunk to queue on the audit lock');

    const close = settle(asUser(CHAIRMAN, () => closePeriod(earlier)));
    await waitFor(async () => (await lockWaiters()) >= 2, 'the close to queue behind the chunk');

    releaseHolder();
    const [holderOut, chunkOut, closeOut] = await Promise.all([settle(holder), chunk, close]);

    expect(holderOut.status).toBe('fulfilled');
    const failures = [chunkOut, closeOut].flatMap((o) => (o.status === 'rejected' ? [o.reason as Error] : []));
    expect(failures.filter(isDeadlock).map((e) => e.message)).toEqual([]);
    expect(failures.map((e) => e.message)).toEqual([]);

    // The later month's row is written, since that month is open. The earlier month's row is
    // refused, as a row in a closing month is, and the close then completes.
    expect(await countTransactions(`${tag}-1`)).toBe(1);
    expect(await countTransactions(`${tag}-2`)).toBe(0);
    const chunkResult = (chunkOut as PromiseFulfilledResult<{ errors: Array<{ message: string }> }>).value;
    expect(chunkResult.errors.map((e) => e.message).join(' ')).toContain('closing accounting period');
    const after = await unscopedPrisma.accountingPeriod.findFirstOrThrow({
      where: { tenantId: TENANT, period: earlier },
    });
    expect(after.status).toBe('closed');
  }, 60_000);
});

const CSV_HEADER = 'Date,Narration,Withdrawal,Deposit,Reference';
/** The namespace of the event chain lock (platform/eventBus.ts:237). */
const EVENT_CHAIN_NAMESPACE = 4711;

/** Stages a bank statement with one line in each given IST month, mid-month, for the test bank account. */
async function stageBankStatement(
  tag: string,
  rows: Array<{ month: string; amount: string; direction: 'in' | 'out' }>,
) {
  const body = rows.map((r, i) => {
    const [year, month] = r.month.split('-');
    const withdrawal = r.direction === 'out' ? r.amount : '';
    const deposit = r.direction === 'in' ? r.amount : '';
    return `15/${month}/${year},${tag} line ${i + 1},${withdrawal},${deposit},${tag}-${i + 1}`;
  });
  return asUser(CHAIRMAN, async () => {
    const staged = await stageImport({
      fileName: `${tag}.csv`,
      buffer: Buffer.from([CSV_HEADER, ...body].join('\n'), 'utf8'),
      kindOverride: 'bank_statement',
    });
    await setImportOptions(staged.batchId, { accountId: ACCOUNT_ID });
    return staged;
  });
}

/**
 * Backends queued behind another transaction in this database. pg_locks, not
 * pg_stat_activity: the application role's sessions show no wait event to the test
 * client. A row-lock waiter shows as a `tuple` lock it holds while it waits for the
 * row's transaction, and an advisory-lock waiter as an ungranted request.
 */
async function lockWaiters(): Promise<number> {
  const rows = await unscopedPrisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT pid)::int AS n FROM pg_locks
    WHERE (NOT granted OR locktype = 'tuple')
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0]?.n ?? 0;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Postgres deadlock (40P01), or Prisma's wrapper for it (P2034). */
function isDeadlock(error: Error): boolean {
  return /deadlock detected|40P01|P2034/.test(`${error.message} ${(error as { code?: string }).code ?? ''}`);
}
