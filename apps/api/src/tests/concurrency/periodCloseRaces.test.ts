/**
 * A journal posting and the close of its own month, racing (platform/ledger.ts
 * lockPostablePeriod, domains/compliance/books.ts requestClosePeriod and closePeriod).
 *
 * The rule under test: a posting takes its period row FOR SHARE before it writes,
 * and a close waits for that row, so a posting either commits before the close's
 * snapshot is taken (and is in it) or finds the month closing or closed and is
 * refused. Nothing lands in a closed month that its snapshot does not hold.
 *
 * The interleaving is forced, not left to the scheduler. A posting is held inside
 * its transaction, after its FOR SHARE lock, and the close request is started
 * against it. The request's UPDATE has to queue behind the posting; the test
 * waits until it does, then lets the posting commit. A bare Promise.all would pass
 * on code that never waits, so the queue is checked explicitly.
 *
 * Each test raises its own tenant (freshTenant), so the months are its own.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { post, postInTx, type PostInput } from '../../platform/ledger.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { closePeriod, requestClosePeriod } from '../../domains/compliance/books.js';
import { expectReject } from '../helpers.js';

const MONTH = '2044-05';
const MONTH_END = new Date('2044-05-31T12:00:00.000Z');

interface Fixture {
  tid: string;
  entityId: string;
  bank: string;
  capital: string;
}

/** A tenant of its own, with one entity and the two accounts every entry here uses. */
async function freshTenant(): Promise<Fixture> {
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Close race ${MONTH}`, slug: `close-race-${randomUUID().slice(0, 8)}` },
  });
  const tid = tenant.id;
  const entity = await unscopedPrisma.ledgerEntity.create({
    data: { tenantId: tid, code: 'CR', legalName: 'Close race entity', stateCode: '27' },
  });
  const bank = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Bank', accountClass: 'asset' },
  });
  const capital = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Capital', accountClass: 'equity' },
  });
  return { tid, entityId: entity.id, bank: bank.id, capital: capital.id };
}

/** The month's period row, open, as the books' own rows carry it. */
async function openMonth(tid: string) {
  return unscopedPrisma.accountingPeriod.create({
    data: {
      tenantId: tid,
      period: MONTH,
      fy: '2044-45',
      status: 'open',
      startsOn: new Date(`${MONTH}-01T00:00:00.000Z`),
      endsOn: new Date(`${MONTH}-31T00:00:00.000Z`),
    },
  });
}

function entryFor(f: Fixture, amount: bigint): PostInput {
  return {
    entityId: f.entityId,
    entryDate: new Date(`${MONTH}-10T00:00:00.000Z`),
    narration: 'Close race fixture',
    sourceType: 'manual',
    idempotencyKey: `close-race:${randomUUID()}`,
    lines: [
      { accountId: f.bank, amountMinor: amount },
      { accountId: f.capital, amountMinor: -amount },
    ],
  };
}

/**
 * Posts inside an open transaction and holds it after the posting's FOR SHARE lock.
 * `posted` resolves once the entry is written; the transaction commits only when
 * `release` is called. `done` rejects if the posting itself fails, so the caller
 * never waits on `posted` for an entry that was refused.
 */
function holdPosting(f: Fixture, input: PostInput) {
  let markPosted!: () => void;
  const posted = new Promise<void>((resolve) => {
    markPosted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = asSystem(f.tid, () =>
    prisma.$transaction(
      async (tx) => {
        const entry = await postInTx(tx, input);
        markPosted();
        await gate;
        return entry;
      },
      { timeout: 30_000 },
    ),
  );
  return { posted, release, done };
}

/**
 * Sessions in this database queued on a lock. In this test the only session that can queue is
 * the close's request: the posting holds its row and does not wait. The close runs as the
 * application role (requestClosePeriod uses the scoped client), whose query text and wait event
 * this client cannot read, so the test cannot match the statement by its SQL. It reads the
 * ungranted lock requests instead, with the database from pg_stat_activity, since a row-lock
 * wait is a transactionid lock with no database of its own in pg_locks (as handoverGate.test.ts
 * does).
 */
async function waitersOnPeriodRows(): Promise<number> {
  const rows = await unscopedPrisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND a.datname = current_database()`;
  return rows[0]?.n ?? 0;
}

/** Resolves once a statement is queued behind the period row. Fails if none ever queues. */
async function untilQueuedOnPeriodRow(): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if ((await waitersOnPeriodRows()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The close did not queue behind the posting: the posting did not hold the period row.');
}

describe('a posting holding its period row, and the close of that month', () => {
  it('the close waits for the posting and its snapshot holds the entry; a posting after the close is refused', async () => {
    const f = await freshTenant();
    await openMonth(f.tid);

    const hold = holdPosting(f, entryFor(f, 100n));
    await Promise.race([hold.posted, hold.done]);

    // The close's request is an UPDATE of the month's row, which conflicts with the
    // posting's FOR SHARE, so it queues until the posting commits.
    const requested = asSystem(f.tid, () => requestClosePeriod(MONTH));
    // Handled here so a refused request does not surface as unhandled while the
    // posting is released; the await below still rethrows it.
    requested.catch(() => undefined);
    try {
      await untilQueuedOnPeriodRow();
    } finally {
      hold.release();
      await hold.done;
    }
    await requested;
    await asSystem(f.tid, () => closePeriod(MONTH));

    const row = await unscopedPrisma.accountingPeriod.findFirstOrThrow({
      where: { tenantId: f.tid, period: MONTH },
    });
    expect(row.status).toBe('closed');
    const snapshot = row.snapshot as unknown as {
      journal: { lineCount: number; debitsMinor: string; creditsMinor: string };
    };
    expect(snapshot.journal.lineCount).toBe(2);
    expect(BigInt(snapshot.journal.debitsMinor)).toBe(100n);
    expect(BigInt(snapshot.journal.creditsMinor)).toBe(100n);

    // The live figures for the month match the snapshot: nothing is in the closed
    // month that the snapshot does not hold.
    const live = await asSystem(f.tid, () => journalTrialBalance(MONTH_END));
    expect(live.lineCount).toBe(snapshot.journal.lineCount);
    expect(live.debitsMinor).toBe(BigInt(snapshot.journal.debitsMinor));
    expect(live.creditsMinor).toBe(BigInt(snapshot.journal.creditsMinor));
    assertTrialBalance(live);

    // A posting after the close is refused and writes nothing.
    const late = await expectReject(() => asSystem(f.tid, () => post(entryFor(f, 250n))));
    expect(late.status).toBe(422);
    expect(await unscopedPrisma.journalLine.count({ where: { tenantId: f.tid } })).toBe(2);
  });
});
