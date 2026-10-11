/**
 * FX-71a (Wave 5, PR3): an import revert reverses the rows it wrote; it deletes
 * none of them.
 *
 * Real Postgres, real request contexts, no mocks. Written before the change. On
 * the revert as it stood: each Transaction is hard-deleted (imports/commit.ts
 * revertImport), a bank line matched to one is left pointing at nothing, a
 * compensation or attendance row is deleted, nothing is audited, a failing row
 * is swallowed and the batch still reads reverted, and a revert does not wait
 * for a commit of the same batch.
 *
 * Tests named T71-n are the contract's (LEDGER-CONSUMERS-CONTRACT.md section
 * 5.4). The rest pin the behaviour the contract asks for and the defects found
 * while building it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS, istMonthKey, parseMinor } from '@kaizen/shared';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { stageImport, setImportOptions } from '../imports/service.js';
import { commitImport, revertImport } from '../imports/commit.js';
import { reverseTransaction } from '../domains/books.js';
import { createBusinessLine } from '../domains/businessLines.js';
import { currentCompensation, listCompensationForEmployment } from '../domains/employment.js';
import { attendanceForPeriod } from '../domains/leave.js';
import { requestClosePeriod, closePeriod, reopenPeriod } from '../domains/compliance/books.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';

const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

// August 2013 has no period row, so it is open. The GST test uses March 2014,
// which it files for the test and nothing else in the suite reads.
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
const GST_PERIOD = '2014-03';

const CSV_HEADER = 'Date,Narration,Withdrawal,Deposit,Reference';

let TENANT: string;
let BANK_ACCOUNT_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  BANK_ACCOUNT_ID = (
    await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    })
  ).id;
});

afterAll(async () => {
  // Nothing to undo: the periods this file closes are reopened in their own
  // finally blocks, and the rows it writes are reversed, never deleted.
});

const uniqueTag = (label: string) => `W5REV-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

/** Letters only, so the name survives the name matcher the staff importers use. */
const uniqueName = (label: string) => {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `Revqa ${label} ${letters}`;
};

interface Line {
  date: string;
  amount: string;
  direction: 'in' | 'out';
}

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

const rowsFor = (batchId: string) =>
  unscopedPrisma.importRow.findMany({
    where: { tenantId: TENANT, batchId },
    orderBy: { rowNumber: 'asc' },
    select: { rowNumber: true, status: true, entityId: true, entityType: true, message: true },
  });

const batchFor = (batchId: string) => unscopedPrisma.importBatch.findFirstOrThrow({ where: { id: batchId } });

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

const txnById = (id: string) => unscopedPrisma.transaction.findUniqueOrThrow({ where: { id } });

async function auditFor(subjectType: string, subjectId: string, action?: string) {
  return unscopedPrisma.auditRecord.findMany({
    where: { tenantId: TENANT, subjectType, subjectId, ...(action ? { action } : {}) },
  });
}

/** Commits a staged statement and returns the entity ids its committed rows wrote. */
async function commitStatement(tag: string, lines: Line[]) {
  const staged = await stageStatement(tag, lines);
  const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
  expect(result.errors).toEqual([]);
  const entityIds = (await rowsFor(staged.batchId))
    .filter((r) => r.status === 'committed')
    .map((r) => r.entityId as string);
  return { batchId: staged.batchId, entityIds };
}

/** Closes a month for the probe and reopens it afterwards, as booksAuditAndPeriod does. */
async function withClosedMonth<T>(period: string, probe: () => Promise<T>): Promise<T> {
  await asUser(FINANCE, () => requestClosePeriod(period));
  await asUser(CHAIRMAN, () => closePeriod(period));
  try {
    return await probe();
  } finally {
    await asUser(CHAIRMAN, () => reopenPeriod(period, 'W5 revert probe finished; reopening the month'));
  }
}

describe('T71-1: a revert keeps each Transaction and adds a reversal that points back at it', () => {
  it('keeps the originals, nets the batch to zero, and returns the account to its pre-commit figure', async () => {
    const tag = uniqueTag('KEEP');
    const before = await accountNetPaise(BANK_ACCOUNT_ID);
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '1500.00', direction: 'out' },
      { date: '14/08/2013', amount: '900.25', direction: 'in' },
      { date: '15/08/2013', amount: '75.10', direction: 'in' },
    ]);
    expect(entityIds).toHaveLength(3);
    const afterCommit = await accountNetPaise(BANK_ACCOUNT_ID);

    await asUser(CHAIRMAN, () => revertImport(batchId));

    const originals = await unscopedPrisma.transaction.findMany({
      where: { tenantId: TENANT, id: { in: entityIds } },
    });
    expect(originals).toHaveLength(3);
    expect(originals.every((o) => o.deletedAt === null && o.reversedById !== null)).toBe(true);

    const reversals = await unscopedPrisma.transaction.findMany({
      where: { tenantId: TENANT, reversalOfId: { in: entityIds } },
    });
    expect(reversals).toHaveLength(3);
    for (const reversal of reversals) {
      const original = originals.find((o) => o.id === reversal.reversalOfId)!;
      expect(reversal.direction).toBe(original.direction === 'in' ? 'out' : 'in');
      expect(reversal.amount.toString()).toBe(original.amount.toString());
      expect(original.reversedById).toBe(reversal.id);
    }

    // The batch's own movement nets to zero, and the account is where it was.
    expect(afterCommit - before).not.toBe(0n);
    expect(await accountNetPaise(BANK_ACCOUNT_ID)).toBe(before);

    // Rows keep their entity; the batch records which reversals it made.
    const rows = await rowsFor(batchId);
    expect(rows.map((r) => [r.status, r.entityId])).toEqual(entityIds.map((id) => ['reverted', id]));
    const batch = await batchFor(batchId);
    expect(batch.status).toBe('reverted');
    const reversalIds = (batch.stats as { reversalIds?: string[] }).reversalIds ?? [];
    expect([...reversalIds].sort()).toEqual(reversals.map((r) => r.id).sort());

    assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));
  });
});

describe('T71-2: each reversal and each reversed original leaves an audit row, and the batch one event', () => {
  it('audits the reversal create and the original update, and emits IMPORT_REVERTED once', async () => {
    const tag = uniqueTag('AUDIT');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '10.00', direction: 'in' },
      { date: '14/08/2013', amount: '20.00', direction: 'out' },
    ]);

    await asUser(CHAIRMAN, () => revertImport(batchId));

    for (const id of entityIds) {
      const original = await txnById(id);
      const reversalId = original.reversedById!;
      expect(await auditFor('transaction', reversalId, 'create')).toHaveLength(1);
      const originalUpdates = await auditFor('transaction', id, 'update');
      expect(originalUpdates.some((a) => JSON.stringify(a.diff).includes(reversalId))).toBe(true);
    }

    const events = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: TENANT, eventName: EVENTS.IMPORT_REVERTED, subjectEntityId: batchId },
    });
    expect(events).toHaveLength(1);
  });
});

describe('T71-3: a revert while today is in a closed month is refused per row, and the rows are untouched', () => {
  it('reports each row with its reason, leaves every entry unreversed, and keeps the batch committed', async () => {
    const tag = uniqueTag('CLOSEDTODAY');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '40.00', direction: 'in' },
      { date: '14/08/2013', amount: '41.00', direction: 'out' },
    ]);
    const period = istMonthKey(new Date());

    const result = await withClosedMonth(period, () => asUser(CHAIRMAN, () => revertImport(batchId)));

    expect(result.failed.map((f) => f.message).every((m) => m.includes('closed accounting period'))).toBe(true);
    expect(result.failed).toHaveLength(2);
    for (const id of entityIds) {
      expect((await txnById(id)).reversedById).toBeNull();
    }
    expect((await rowsFor(batchId)).map((r) => r.status)).toEqual(['committed', 'committed']);
    expect((await batchFor(batchId)).status).toBe('committed');
  });
});

describe('T71-4: a bank line matched to a reversed entry is unmatched, audited, and counted', () => {
  it('clears the match, writes an update audit row on the bank line, and reports the count', async () => {
    const tag = uniqueTag('BANKLINE');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '250.00', direction: 'out' },
    ]);
    const original = await txnById(entityIds[0]);
    const line = await unscopedPrisma.bankStatementLine.create({
      data: {
        tenantId: TENANT,
        accountId: BANK_ACCOUNT_ID,
        date: new Date('2013-08-13T00:00:00.000Z'),
        amount: original.amount,
        direction: 'out',
        narration: tag,
        matchedTransactionId: original.id,
        matchedAt: new Date(),
        fingerprint: `${tag}-line`,
      },
    });

    const result = await asUser(CHAIRMAN, () => revertImport(batchId));

    expect(result.unmatched).toBe(1);
    const after = await unscopedPrisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after.matchedTransactionId).toBeNull();
    expect(after.matchedAt).toBeNull();
    const updates = await auditFor('bank_statement_line', line.id, 'update');
    expect(updates).toHaveLength(1);
  });
});

describe('T71-5: a row split across business lines is reported with its reason; the batch is not reverted', () => {
  it('refuses that row only, reverses the rest, and leaves the batch partial', async () => {
    const tag = uniqueTag('DISTRIB');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '300.00', direction: 'in' },
      { date: '14/08/2013', amount: '310.00', direction: 'in' },
    ]);
    const distributed = entityIds[0];
    // A split must total 10,000 basis points, checked at commit, so the header
    // and its one whole-entry line are written in one transaction.
    const line = await asUser(CHAIRMAN, () =>
      createBusinessLine({
        code: `W5R${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`,
        name: 'W5REV fixture line',
        payerKind: 'w5rev_fixture',
        revenueModel: 'w5rev_fixture',
        effectiveFrom: '2030-01-01',
        reason: 'FX-71a revert fixture',
      }),
    );
    await unscopedPrisma.$transaction(async (tx) => {
      const header = await tx.lineDistribution.create({
        data: {
          tenantId: TENANT,
          transactionId: distributed,
          effectiveFrom: new Date('2013-08-13T00:00:00.000Z'),
          recordedById: 'w5rev-test',
        },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: TENANT, distributionId: header.id, lineId: line.id, basisPoints: 10000 },
      });
    });

    const result = await asUser(CHAIRMAN, () => revertImport(batchId));

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toMatch(/business line/);
    expect((await txnById(distributed)).reversedById).toBeNull();
    expect((await txnById(entityIds[1])).reversedById).not.toBeNull();
    expect((await batchFor(batchId)).status).toBe('revert_partial');
    const rows = await rowsFor(batchId);
    expect(rows.map((r) => r.status)).toEqual(['committed', 'reverted']);
  });
});

describe('double reversal is refused', () => {
  it('two reversals of one entry at once: one lands, the other is refused with 409', async () => {
    const tag = uniqueTag('RACE2');
    const { entityIds } = await commitStatement(tag, [{ date: '13/08/2013', amount: '60.00', direction: 'out' }]);

    const outcomes = await asUser(FINANCE, () =>
      Promise.allSettled([
        reverseTransaction(entityIds[0], 'first of two'),
        reverseTransaction(entityIds[0], 'second of two'),
      ]),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ status: 409 });
    const reversals = await unscopedPrisma.transaction.count({
      where: { tenantId: TENANT, reversalOfId: entityIds[0] },
    });
    expect(reversals).toBe(1);
  });

  it('an entry reversed by hand before the revert is refused by the revert, and the batch is partial', async () => {
    const tag = uniqueTag('BYHAND');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '70.00', direction: 'in' },
      { date: '14/08/2013', amount: '71.00', direction: 'in' },
    ]);
    await asUser(FINANCE, () => reverseTransaction(entityIds[0], 'corrected by hand'));

    const result = await asUser(CHAIRMAN, () => revertImport(batchId));

    expect(result.failed.map((f) => f.rowNumber)).toEqual([2]);
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, reversalOfId: entityIds[0] } })).toBe(1);
    expect((await txnById(entityIds[1])).reversedById).not.toBeNull();
    expect((await batchFor(batchId)).status).toBe('revert_partial');
  });
});

describe('the GST filing lock applies to a revert (pending A14, interim default)', () => {
  it('refuses a row whose entry falls in a month with a filed GST return, and leaves it in place', async () => {
    const existing = await unscopedPrisma.gstFiling.findFirst({
      where: { tenantId: TENANT, period: GST_PERIOD, status: 'filed' },
    });
    if (!existing) {
      await unscopedPrisma.gstFiling.create({
        data: {
          tenantId: TENANT,
          recordCode: `W5REV-GSTR1-${GST_PERIOD}`,
          returnType: 'GSTR1',
          period: GST_PERIOD,
          snapshot: {},
          status: 'filed',
          filedAt: new Date(),
        },
      });
    }

    const tag = uniqueTag('GSTLOCK');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/03/2014', amount: '80.00', direction: 'out' },
    ]);

    const result = await asUser(CHAIRMAN, () => revertImport(batchId));

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toContain(GST_PERIOD);
    expect((await txnById(entityIds[0])).reversedById).toBeNull();
    expect((await batchFor(batchId)).status).toBe('committed');
  });
});

describe('a revert and a commit of one batch cannot interleave', () => {
  it('a revert while the batch lock is held is refused with 409, and nothing is reversed', async () => {
    const tag = uniqueTag('LOCKED');
    const { batchId, entityIds } = await commitStatement(tag, [
      { date: '13/08/2013', amount: '90.00', direction: 'out' },
    ]);

    // The same key commit.ts takes (withBatchLock), held by another connection.
    await unscopedPrisma.$transaction(async (lock) => {
      const [row] = await lock.$queryRaw<Array<{ held: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`import_batch:${TENANT}:${batchId}`}, 0)) AS held`;
      expect(row.held).toBe(true);

      const err = await asUser(CHAIRMAN, () => revertImport(batchId)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: 409 });
      expect(String((err as Error).message)).toContain('already being committed');
    });

    expect((await txnById(entityIds[0])).reversedById).toBeNull();
    expect((await batchFor(batchId)).status).toBe('committed');
  });
});

describe('compensation and attendance rows are tombstoned, and the readers hide them', () => {
  /** A fresh employee, so the pay and attendance written below are this test's alone. */
  async function freshEmployee(): Promise<{ name: string; employmentId: string }> {
    const name = uniqueName('EMP');
    const code = `KD/S/2026/${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const csv = ['Name,Designation,Employee Code', `${name},Analyst,${code}`].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('EMPLOYEE')}.csv`, buffer: Buffer.from(csv, 'utf8') }),
    );
    const result = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(result.errors).toEqual([]);
    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: TENANT, fullName: name } });
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: person.id },
    });
    return { name, employmentId: employment.id };
  }

  it('a voided compensation record is not current pay and is not in the history', async () => {
    const { name, employmentId } = await freshEmployee();
    const csv = ['Name,Designation,Actual Salary', `${name},Analyst,50000`].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('SALARY')}.csv`, buffer: Buffer.from(csv, 'utf8'), kindOverride: 'salary' }),
    );
    const committed = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.compensationRecord).toBe(1);
    expect((await asUser(CHAIRMAN, () => currentCompensation(employmentId)))?.amount.toString()).toBe('50000');

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    expect(await asUser(CHAIRMAN, () => currentCompensation(employmentId))).toBeNull();
    expect(await asUser(CHAIRMAN, () => listCompensationForEmployment(employmentId))).toHaveLength(0);
    const kept = await unscopedPrisma.compensationRecord.findMany({
      where: { tenantId: TENANT, employmentRelationshipId: employmentId },
    });
    expect(kept).toHaveLength(1);
    expect(kept[0].voidedAt).not.toBeNull();
    expect(kept[0].voidBatchId).toBe(staged.batchId);
    expect(await auditFor('compensation_record', kept[0].id, 'update')).toHaveLength(1);
  });

  it('a voided attendance day is not in the period, and the same day can be imported again', async () => {
    const { name, employmentId } = await freshEmployee();
    const csv = ['Name,01/08/2013,02/08/2013', `${name},P,A`].join('\n');
    const first = await asUser(CHAIRMAN, () =>
      stageImport({
        fileName: `${uniqueTag('ATT')}.csv`,
        buffer: Buffer.from(csv, 'utf8'),
        kindOverride: 'attendance',
      }),
    );
    const committed = await asUser(CHAIRMAN, () => commitImport(first.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.workAttendance).toBe(1);
    const writtenIds = (await asUser(CHAIRMAN, () => attendanceForPeriod(employmentId, '2013-08'))).map((r) => r.id);
    expect(writtenIds).toHaveLength(2);

    await asUser(CHAIRMAN, () => revertImport(first.batchId));

    expect(await asUser(CHAIRMAN, () => attendanceForPeriod(employmentId, '2013-08'))).toHaveLength(0);
    const tombstones = await unscopedPrisma.workAttendance.findMany({
      where: { tenantId: TENANT, id: { in: writtenIds } },
    });
    expect(tombstones).toHaveLength(2);
    expect(tombstones.every((t) => t.voidedAt !== null && t.voidBatchId === first.batchId)).toBe(true);

    // The day is unique per employee, so the voided row holds it: the next
    // import of the same days takes those rows back rather than failing on the
    // unique key.
    const second = await asUser(CHAIRMAN, () =>
      stageImport({
        fileName: `${uniqueTag('ATT2')}.csv`,
        buffer: Buffer.from(csv, 'utf8'),
        kindOverride: 'attendance',
      }),
    );
    const recommitted = await asUser(CHAIRMAN, () => commitImport(second.batchId));
    expect(recommitted.errors).toEqual([]);
    const live = await asUser(CHAIRMAN, () => attendanceForPeriod(employmentId, '2013-08'));
    expect(live.map((r) => r.id).sort()).toEqual([...writtenIds].sort());
  });
});
