/**
 * FX-72 (Wave 5, PR2): the import commit writes its rows in chunks of 500, one
 * transaction per chunk, through the legacy writer inside that transaction.
 *
 * Real Postgres, real request contexts, no mocks. The one injected fault is a
 * database trigger, so it fails where a dropped connection would: inside the
 * chunk's transaction, after the row's Transaction is written and before its
 * import row is marked. The $transaction spy passes every call through and only
 * counts them.
 *
 * Written before the change. On the commit as it stood: a row dated in a closed
 * period is written, nothing is audited, a fault leaves the earlier rows of its
 * chunk and a rerun writes them again, two commits both insert, and nothing is
 * chunked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS, parseMinor } from '@kaizen/shared';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { stageImport, setImportOptions } from '../imports/service.js';
import { commitImport } from '../imports/commit.js';
import { requestClosePeriod, closePeriod } from '../domains/compliance/books.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';

const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

// Periods in 2013 are far from the demo dataset and from the 2016-2017 periods
// the books tests use. They outlive a run, so each is closed only if still open.
const CLOSED = '2013-07';
const CLOSING = '2013-09';
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');

const CSV_HEADER = 'Date,Narration,Withdrawal,Deposit,Reference';
const CHUNK = 500;

interface Line {
  date: string;
  amount: string;
  direction: 'in' | 'out';
}

let TENANT: string;
let BANK_ACCOUNT_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  BANK_ACCOUNT_ID = (
    await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    })
  ).id;

  const statusOf = async (period: string) =>
    (await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period } }))?.status ?? 'open';

  if ((await statusOf(CLOSED)) === 'open') await asUser(FINANCE, () => requestClosePeriod(CLOSED));
  if ((await statusOf(CLOSED)) === 'closing') await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  if ((await statusOf(CLOSING)) === 'open') await asUser(FINANCE, () => requestClosePeriod(CLOSING));
});

afterAll(async () => {
  await unscopedPrisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fx72_inject_fault ON import_rows');
  await unscopedPrisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fx72_inject_fault()');
});

const uniqueTag = (label: string) => `FX72-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

/** Stages a bank statement CSV for the bank account and returns the batch. */
async function stageStatement(tag: string, lines: Line[]) {
  const body = lines.map((l, i) => {
    const withdrawal = l.direction === 'out' ? l.amount : '';
    const deposit = l.direction === 'in' ? l.amount : '';
    return `${l.date},${tag} line ${i + 1},${withdrawal},${deposit},${tag}-${i + 1}`;
  });
  return asUser(CHAIRMAN, async () => {
    const staged = await stageImport({
      fileName: `${tag}.csv`,
      buffer: Buffer.from([CSV_HEADER, ...body].join('\n'), 'utf8'),
      kindOverride: 'bank_statement',
    });
    await setImportOptions(staged.batchId, { accountId: BANK_ACCOUNT_ID });
    return staged;
  });
}

/** Two thousand-odd dated lines in August 2013, a month with no period row (so open). */
function bulkLines(count: number): Line[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `${String(13 + (i % 16)).padStart(2, '0')}/08/2013`,
    amount: `${100 + i}.${String(i % 100).padStart(2, '0')}`,
    direction: i % 2 === 0 ? 'in' : 'out',
  }));
}

/** Transactions whose narration carries this tag: what the batch wrote. */
const writtenFor = (tag: string) =>
  unscopedPrisma.transaction.findMany({
    where: { tenantId: TENANT, note: { contains: tag } },
    select: { id: true },
  });

const countFor = async (tag: string) => (await writtenFor(tag)).length;

const rowsFor = (batchId: string) =>
  unscopedPrisma.importRow.findMany({
    where: { tenantId: TENANT, batchId },
    orderBy: { rowNumber: 'asc' },
    select: { rowNumber: true, status: true, entityId: true, message: true },
  });

async function auditCreatesFor(subjectType: string, subjectId: string) {
  const rows = await unscopedPrisma.auditRecord.findMany({
    where: { tenantId: TENANT, subjectType, subjectId },
  });
  return rows.filter((r) => r.action === 'create');
}

/** The account's movement in paise, read from the Decimal column as text. */
async function accountNetPaise(accountId: string): Promise<bigint> {
  const rows = await unscopedPrisma.transaction.findMany({
    where: { tenantId: TENANT, accountId, deletedAt: null },
    select: { direction: true, amount: true },
  });
  return rows.reduce((net, r) => {
    const paise = parseMinor(r.amount.toString());
    return r.direction === 'in' ? net + paise : net - paise;
  }, 0n);
}

describe('a row in a closed or closing period is a row error, and the rest of the batch commits', () => {
  it('a row dated in a closed period is refused, and the rows in open months commit', async () => {
    const tag = uniqueTag('CLOSED');
    const staged = await stageStatement(tag, [
      { date: '20/08/2013', amount: '1500.00', direction: 'out' },
      { date: '20/07/2013', amount: '900.25', direction: 'in' },
      { date: '21/08/2013', amount: '75.10', direction: 'in' },
    ]);

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));

    expect(result.errors.map((e) => e.rowNumber)).toEqual([3]);
    expect(result.errors[0].message).toContain(CLOSED);
    expect(await countFor(tag)).toBe(2);
    expect(
      await unscopedPrisma.transaction.findFirst({ where: { tenantId: TENANT, note: { contains: `${tag} line 2` } } }),
    ).toBeNull();

    const rows = await rowsFor(staged.batchId);
    expect(rows.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, 'committed'],
      [3, 'error'],
      [4, 'committed'],
    ]);
  });

  it('a period that is being closed refuses its rows too', async () => {
    const tag = uniqueTag('CLOSING');
    const staged = await stageStatement(tag, [{ date: '20/09/2013', amount: '100.00', direction: 'out' }]);

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('being closed');
    expect(await countFor(tag)).toBe(0);
  });
});

describe('every written row leaves an audit row and a TRANSACTION_RECORDED event', () => {
  it('each committed transaction has one create audit row and one event, and the batch one IMPORT_COMMITTED', async () => {
    const tag = uniqueTag('AUDIT');
    const staged = await stageStatement(tag, [
      { date: '13/08/2013', amount: '10.00', direction: 'in' },
      { date: '14/08/2013', amount: '20.00', direction: 'out' },
      { date: '15/08/2013', amount: '30.00', direction: 'in' },
    ]);

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(result.errors).toEqual([]);

    const written = await writtenFor(tag);
    expect(written).toHaveLength(3);
    for (const txn of written) {
      expect(await auditCreatesFor('transaction', txn.id)).toHaveLength(1);
      const events = await unscopedPrisma.eventRecord.findMany({
        where: { tenantId: TENANT, eventName: EVENTS.TRANSACTION_RECORDED, subjectEntityId: txn.id },
      });
      expect(events).toHaveLength(1);
    }

    const batchEvents = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: TENANT, eventName: EVENTS.IMPORT_COMMITTED, subjectEntityId: staged.batchId },
    });
    expect(batchEvents).toHaveLength(1);
  });

  it('a ledger voucher writes its transaction through the audited path, and an account it creates is audited', async () => {
    const tag = uniqueTag('LEDGER');
    const startedAt = new Date();
    const xml = [
      '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>',
      `<VOUCHER VCHTYPE="Payment" ACTION="Create"><DATE>20130821</DATE><VOUCHERNUMBER>${tag}</VOUCHERNUMBER>`,
      `<NARRATION>${tag} rent</NARRATION>`,
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank Account ${tag}</LEDGERNAME><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>`,
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent Expense ${tag}</LEDGERNAME><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>`,
      '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
    ].join('');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${tag}.xml`, buffer: Buffer.from(xml, 'utf8') }),
    );
    expect(staged.kind).toBe('tally_ledger');

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(result.errors).toEqual([]);

    const written = await unscopedPrisma.transaction.findMany({
      where: { tenantId: TENANT, note: { contains: tag } },
      select: { id: true },
    });
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const txn of written) {
      expect(await auditCreatesFor('transaction', txn.id)).toHaveLength(1);
    }

    const accounts = await unscopedPrisma.ledgerAccount.findMany({
      where: { tenantId: TENANT, createdAt: { gte: startedAt }, name: { contains: tag } },
      select: { id: true },
    });
    for (const account of accounts) {
      expect(await auditCreatesFor('ledger_account', account.id)).toHaveLength(1);
    }
  });
});

describe('the commit runs in chunks of 500, one transaction each', () => {
  it('1,001 rows give three chunk transactions, and the whole batch commits', async () => {
    const tag = uniqueTag('CHUNKS');
    const staged = await stageStatement(tag, bulkLines(1001));

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(result.errors).toEqual([]);
    expect(await countFor(tag)).toBe(1001);

    // Every row a chunk transaction commits is stamped with that transaction's
    // id (xmin). Distinct xmin values among the committed rows are therefore the
    // chunk transactions, counted in Postgres rather than by wrapping the client.
    // 500 + 500 + 1 is three chunks; one transaction per row would be 1,001.
    const perChunk = await unscopedPrisma.$queryRaw<Array<{ xid: string; n: bigint }>>`
      SELECT "xmin"::text AS xid, COUNT(*) AS n FROM "import_rows"
      WHERE "batchId" = ${staged.batchId} AND "status" = 'committed'
      GROUP BY "xmin" ORDER BY MIN("rowNumber")`;
    expect(perChunk.map((c) => Number(c.n))).toEqual([500, 500, 1]);
  }, 240_000);

  it('a fault mid-chunk rolls that chunk back whole, and a rerun creates exactly one transaction per row', async () => {
    const tag = uniqueTag('FAULT');
    const staged = await stageStatement(tag, bulkLines(1001));
    // Row 600 is in the second chunk (rows 502 to 1001). The first chunk
    // (rows 2 to 501) is already committed when the fault hits.
    const FAULT_ROW = 600;

    await unscopedPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fx72_inject_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."batchId" = TG_ARGV[0] AND NEW."rowNumber" = TG_ARGV[1]::int AND NEW.status = 'committed' THEN
          RAISE EXCEPTION 'injected fault: connection lost mid-chunk' USING ERRCODE = 'XX000';
        END IF;
        RETURN NEW;
      END $$`);
    await unscopedPrisma.$executeRawUnsafe(
      `CREATE TRIGGER fx72_inject_fault BEFORE UPDATE ON import_rows FOR EACH ROW ` +
        `EXECUTE FUNCTION fx72_inject_fault('${staged.batchId}', '${FAULT_ROW}')`,
    );

    try {
      await expect(asUser(CHAIRMAN, () => commitImport(staged.batchId))).rejects.toThrow();
    } finally {
      await unscopedPrisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fx72_inject_fault ON import_rows');
    }

    // Chunk one is whole. Chunk two was rolled back: none of its rows is
    // written, and all of them are still ready for the rerun.
    expect(await countFor(tag)).toBe(CHUNK);
    const afterCrash = await rowsFor(staged.batchId);
    expect(afterCrash.filter((r) => r.status === 'committed').map((r) => r.rowNumber)).toEqual(
      Array.from({ length: CHUNK }, (_, i) => i + 2),
    );
    expect(afterCrash.filter((r) => r.status === 'ready')).toHaveLength(1001 - CHUNK);
    expect((await unscopedPrisma.importBatch.findFirstOrThrow({ where: { id: staged.batchId } })).status).toBe(
      'committing',
    );

    const rerun = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(rerun.errors).toEqual([]);
    expect(await countFor(tag)).toBe(1001);
    expect((await unscopedPrisma.importBatch.findFirstOrThrow({ where: { id: staged.batchId } })).status).toBe(
      'committed',
    );
  }, 240_000);

  it('two commits of one batch at once are serialised: one commits, the other is refused with 409', async () => {
    const tag = uniqueTag('RACE');
    const staged = await stageStatement(tag, bulkLines(50));

    const outcomes = await asUser(CHAIRMAN, () =>
      Promise.allSettled([commitImport(staged.batchId), commitImport(staged.batchId)]),
    );

    const committed = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(committed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await countFor(tag)).toBe(50);
  });
});

describe('the books hold after the commit', () => {
  it('the trial balance holds, and the account moves by exactly the imported amounts in paise', async () => {
    const tag = uniqueTag('TB');
    const lines: Line[] = [
      { date: '13/08/2013', amount: '1234.56', direction: 'in' },
      { date: '14/08/2013', amount: '0.07', direction: 'out' },
      { date: '15/08/2013', amount: '98765.43', direction: 'in' },
      { date: '16/08/2013', amount: '2500', direction: 'out' },
      { date: '17/08/2013', amount: '0.10', direction: 'in' },
    ];
    const staged = await stageStatement(tag, lines);
    const before = await accountNetPaise(BANK_ACCOUNT_ID);
    const journalBefore = await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } });

    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(result.errors).toEqual([]);

    assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));
    const expected = lines.reduce(
      (net, l) => (l.direction === 'in' ? net + parseMinor(l.amount) : net - parseMinor(l.amount)),
      0n,
    );
    expect((await accountNetPaise(BANK_ACCOUNT_ID)) - before).toBe(expected);

    // The commit writes the legacy books only: no journal entry is created.
    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } })).toBe(journalBefore);
  });
});
