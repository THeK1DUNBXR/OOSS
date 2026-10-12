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

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { EVENTS, istMonthKey, parseMinor } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  reopenLatestFirst,
  tenantId,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { stageImport, setImportOptions } from '../imports/service.js';
import { commitImport, revertImport } from '../imports/commit.js';
import { reverseTransaction } from '../domains/books.js';
import { createBusinessLine } from '../domains/businessLines.js';
import { currentCompensation, listCompensationForEmployment } from '../domains/employment.js';
import { attendanceForPeriod } from '../domains/leave.js';
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

/** Where a statement is staged and committed, and who acts on it. Kaizen unless a test names its own books tenant. */
interface Ground {
  tenantId: string;
  bankAccountId: string;
  chairman: string;
}
let KAIZEN: Ground;

beforeAll(async () => {
  TENANT = await tenantId();
  BANK_ACCOUNT_ID = (
    await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    })
  ).id;
  KAIZEN = { tenantId: TENANT, bankAccountId: BANK_ACCOUNT_ID, chairman: CHAIRMAN };
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

async function stageStatement(tag: string, lines: Line[], g: Ground = KAIZEN) {
  const body = lines.map((l, i) => {
    const withdrawal = l.direction === 'out' ? l.amount : '';
    const deposit = l.direction === 'in' ? l.amount : '';
    return `${l.date},${tag} line ${i + 1},${withdrawal},${deposit},${tag}-${i + 1}`;
  });
  return asUser(g.chairman, async () => {
    const staged = await stageImport({
      fileName: `${tag}.csv`,
      buffer: Buffer.from([CSV_HEADER, ...body].join('\n'), 'utf8'),
      kindOverride: 'bank_statement',
    });
    await setImportOptions(staged.batchId, { accountId: g.bankAccountId });
    return staged;
  });
}

const rowsFor = (batchId: string, tid: string = TENANT) =>
  unscopedPrisma.importRow.findMany({
    where: { tenantId: tid, batchId },
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
async function commitStatement(tag: string, lines: Line[], g: Ground = KAIZEN) {
  const staged = await stageStatement(tag, lines, g);
  const result = await asUser(g.chairman, () => commitImport(staged.batchId));
  expect(result.errors).toEqual([]);
  const entityIds = (await rowsFor(staged.batchId, g.tenantId))
    .filter((r) => r.status === 'committed')
    .map((r) => r.entityId as string);
  return { batchId: staged.batchId, entityIds };
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

/**
 * Closes every unclosed month of the books tenant up to `period` for the probe, then reopens
 * them latest first. The order rule (books.ts requestClosePeriod) closes the earlier months
 * before today's month, so the window is the one the rule allows, not a single month.
 */
async function inClosedWindow<T>(f: BooksTenant, period: string, probe: () => Promise<T>): Promise<T> {
  await closeThrough(f, period);
  try {
    return await probe();
  } finally {
    await reopenLatestFirst(f, 'W5 revert probe finished; reopening the months it closed');
  }
}

describe('T71-3: a revert while today is in a closed month is refused per row, and the rows are untouched', () => {
  it('reports each row with its reason, leaves every entry unreversed, and keeps the batch committed', async () => {
    // A books tenant of its own: the close below must not freeze months another file writes into.
    const f = await booksTenant('import-revert-reversal-test');
    const tag = uniqueTag('CLOSEDTODAY');
    // Committed before the close: a row whose month is closed is refused by the commit.
    const { batchId, entityIds } = await commitStatement(
      tag,
      [
        { date: '13/08/2013', amount: '40.00', direction: 'in' },
        { date: '14/08/2013', amount: '41.00', direction: 'out' },
      ],
      f,
    );
    const period = istMonthKey(new Date());

    const result = await inClosedWindow(f, period, () => asUser(f.chairman, () => revertImport(batchId)));

    expect(result.failed.map((r) => r.message).every((m) => m.includes('closed accounting period'))).toBe(true);
    expect(result.failed).toHaveLength(2);
    for (const id of entityIds) {
      expect((await txnById(id)).reversedById).toBeNull();
    }
    expect((await rowsFor(batchId, f.tenantId)).map((r) => r.status)).toEqual(['committed', 'committed']);
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
    // The attendance grid reads its dates month first (extract.ts extractAttendance
    // calls toDate with dayFirst false), so these are 1 and 2 August 2013.
    const csv = ['Name,08/01/2013,08/02/2013', `${name},P,A`].join('\n');
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

describe('a pay record a batch matched rather than created is not voided by that batch revert', () => {
  it('batch B reuses the record batch A created; reverting B leaves it active and still read as current pay', async () => {
    const name = uniqueName('MATCH');
    const code = `KD/S/2026/${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const people = ['Name,Designation,Employee Code', `${name},Analyst,${code}`].join('\n');
    const emp = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('MATCHEMP')}.csv`, buffer: Buffer.from(people, 'utf8') }),
    );
    expect((await asUser(CHAIRMAN, () => commitImport(emp.batchId))).errors).toEqual([]);
    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: TENANT, fullName: name } });
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: person.id },
    });
    // Staging refuses a salary row whose key (person, period label, amount) is
    // already committed, so B must come from another period. The period label is
    // the sheet's name, so each batch is its own workbook with its own sheet.
    const stageSalary = (period: string) => {
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Name', 'Designation', 'Actual Salary'],
        [name, 'Analyst', 50000],
      ]);
      XLSX.utils.book_append_sheet(book, sheet, period);
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      return asUser(CHAIRMAN, () =>
        stageImport({ fileName: `${uniqueTag('SALMATCH')}.xlsx`, buffer, kindOverride: 'salary' }),
      );
    };

    const batchA = await stageSalary('January salary');
    const committedA = await asUser(CHAIRMAN, () => commitImport(batchA.batchId));
    expect(committedA.errors).toEqual([]);
    const recordA = await unscopedPrisma.compensationRecord.findFirstOrThrow({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id, status: 'Effective' },
    });

    // Batch B names the same person and the same pay, so commit reuses A's record.
    const batchB = await stageSalary('February salary');
    const committedB = await asUser(CHAIRMAN, () => commitImport(batchB.batchId));
    expect(committedB.errors).toEqual([]);

    await asUser(CHAIRMAN, () => revertImport(batchB.batchId));

    // A's record is not B's to void: still active, and still the current pay.
    const afterA = await unscopedPrisma.compensationRecord.findUniqueOrThrow({ where: { id: recordA.id } });
    expect(afterA.voidedAt).toBeNull();
    expect(afterA.status).toBe('Effective');
    const current = await asUser(CHAIRMAN, () => currentCompensation(employment.id));
    expect(current?.id).toBe(recordA.id);
    expect(await asUser(CHAIRMAN, () => listCompensationForEmployment(employment.id))).toHaveLength(1);
    // B created no pay record, and its row says it matched A's: nothing to undo.
    expect(committedB.created.compensationRecord ?? 0).toBe(0);
    const rowsB = await rowsFor(batchB.batchId);
    expect(rowsB.map((r) => [r.status, r.entityId])).toEqual([['matched', recordA.id]]);
    expect((await batchFor(batchB.batchId)).status).toBe('reverted');

    assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));
  });
});

describe('an employee row that matched a person on file does not soft-delete that person on revert', () => {
  it('a person entered by hand is matched by the staff import; reverting that batch leaves them live', async () => {
    const name = uniqueName('EMPMATCH');
    // Entered by hand, so no earlier import batch carries the name: staging
    // would refuse a second batch naming a person an import already made.
    const handPerson = await unscopedPrisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: uniqueTag('PER'),
        fullName: name,
        source: 'manual',
      },
    });

    const csv = [
      'Name,Designation,Employee Code',
      `${name},Analyst,KD/S/2026/${String(Math.floor(Math.random() * 9000) + 1000)}`,
    ].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('EMPMATCH')}.csv`, buffer: Buffer.from(csv, 'utf8') }),
    );
    const committed = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.person ?? 0).toBe(0);
    expect((await rowsFor(staged.batchId)).map((r) => [r.status, r.entityId])).toEqual([['matched', handPerson.id]]);

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    const after = await unscopedPrisma.person.findUniqueOrThrow({ where: { id: handPerson.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.fullName).toBe(name);
    expect((await batchFor(staged.batchId)).status).toBe('reverted');
  });
});

describe('a contact row that matched a person on file does not soft-delete that person on revert', () => {
  it('a contact matched by email to a person entered by hand is left live when its batch reverts', async () => {
    const name = uniqueName('CONTACT');
    const email = `${uniqueTag('contact').toLowerCase()}@w5rev.example.in`;
    const handPerson = await unscopedPrisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: uniqueTag('PER'),
        fullName: name,
        primaryEmail: email,
        primaryEmailNormalised: email,
        source: 'manual',
      },
    });

    const csv = ['Contact name,Phone,Email,Organisation', `${name},9840011223,${email},`].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({
        fileName: `${uniqueTag('CONTACT')}.csv`,
        buffer: Buffer.from(csv, 'utf8'),
        kindOverride: 'template_contacts',
      }),
    );
    const committed = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.person ?? 0).toBe(0);
    expect((await rowsFor(staged.batchId)).map((r) => [r.status, r.entityId])).toEqual([['matched', handPerson.id]]);

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    const after = await unscopedPrisma.person.findUniqueOrThrow({ where: { id: handPerson.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.fullName).toBe(name);
    expect((await batchFor(staged.batchId)).status).toBe('reverted');
  });
});

/** A staff member imported on a batch of their own, so the attendance a test writes is its alone. */
async function stageStaffMember(label: string): Promise<{ name: string; personId: string; employmentId: string }> {
  const name = uniqueName(label);
  const code = `KD/S/2026/${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const csv = ['Name,Designation,Employee Code', `${name},Analyst,${code}`].join('\n');
  const staged = await asUser(CHAIRMAN, () =>
    stageImport({ fileName: `${uniqueTag('STAFF')}.csv`, buffer: Buffer.from(csv, 'utf8') }),
  );
  expect((await asUser(CHAIRMAN, () => commitImport(staged.batchId))).errors).toEqual([]);
  const person = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: TENANT, fullName: name } });
  const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
    where: { tenantId: TENANT, personId: person.id },
  });
  return { name, personId: person.id, employmentId: employment.id };
}

const stageAttendance = (fileName: string, csv: string) =>
  asUser(CHAIRMAN, () => stageImport({ fileName, buffer: Buffer.from(csv, 'utf8'), kindOverride: 'attendance' }));

const liveAttendanceIds = async (employmentId: string) =>
  (await asUser(CHAIRMAN, () => attendanceForPeriod(employmentId, '2013-08'))).map((r) => r.id).sort();

describe('an attendance batch that overlaps an earlier batch reverts only the days it created', () => {
  it('reverting the later batch leaves the days the earlier one wrote live and voids only its own new days', async () => {
    const { name, employmentId } = await stageStaffMember('ATTOVL');

    // Batch A writes 1 and 2 August 2013 (month first, as extractAttendance reads them).
    const a = await stageAttendance(
      `${uniqueTag('ATT-A')}.csv`,
      ['Name,08/01/2013,08/02/2013', `${name},P,A`].join('\n'),
    );
    expect((await asUser(CHAIRMAN, () => commitImport(a.batchId))).errors).toEqual([]);
    const daysA = await liveAttendanceIds(employmentId);
    expect(daysA).toHaveLength(2);

    // Batch B names 2, 3 and 4 August. Day 2 is A's and already live, so B writes 3 and 4 only.
    const b = await stageAttendance(
      `${uniqueTag('ATT-B')}.csv`,
      ['Name,08/02/2013,08/03/2013,08/04/2013', `${name},P,P,A`].join('\n'),
    );
    expect((await asUser(CHAIRMAN, () => commitImport(b.batchId))).errors).toEqual([]);
    const daysB = (await liveAttendanceIds(employmentId)).filter((id) => !daysA.includes(id));
    expect(daysB).toHaveLength(2);

    await asUser(CHAIRMAN, () => revertImport(b.batchId));

    expect(await liveAttendanceIds(employmentId)).toEqual(daysA);
    const voided = await unscopedPrisma.workAttendance.findMany({
      where: { tenantId: TENANT, id: { in: daysB } },
    });
    expect(voided).toHaveLength(2);
    expect(voided.every((v) => v.voidedAt !== null && v.voidBatchId === b.batchId)).toBe(true);
  });
});

describe('a matched employee keeps the person on revert, and the employment the batch created is reversed', () => {
  it('soft-deletes nothing of the person and reverses the employment row this batch made', async () => {
    const name = uniqueName('EMPCHILD');
    // Entered by hand: the person exists before the batch, and has no employment yet.
    const handPerson = await unscopedPrisma.person.create({
      data: { tenantId: TENANT, recordCode: uniqueTag('PER'), fullName: name, source: 'manual' },
    });

    const csv = [
      'Name,Designation,Employee Code',
      `${name},Analyst,KD/S/2026/${String(Math.floor(Math.random() * 9000) + 1000)}`,
    ].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('EMPCHILD')}.csv`, buffer: Buffer.from(csv, 'utf8') }),
    );
    expect((await asUser(CHAIRMAN, () => commitImport(staged.batchId))).errors).toEqual([]);
    const made = await unscopedPrisma.employmentRelationship.findMany({
      where: { tenantId: TENANT, personId: handPerson.id },
    });
    expect(made).toHaveLength(1);

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    const person = await unscopedPrisma.person.findUniqueOrThrow({ where: { id: handPerson.id } });
    expect(person.deletedAt).toBeNull();
    expect(person.fullName).toBe(name);
    const employment = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: made[0].id } });
    expect(employment.deletedAt).not.toBeNull();
  });
});

const stageSalaryFor = (name: string, period: string, amount: number) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Designation', 'Actual Salary'],
    [name, 'Analyst', amount],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, period);
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return asUser(CHAIRMAN, () => stageImport({ fileName: `${uniqueTag('SAL')}.xlsx`, buffer, kindOverride: 'salary' }));
};

const compensationOf = (id: string) => unscopedPrisma.compensationRecord.findUniqueOrThrow({ where: { id } });

describe('a batch committed before per-row tracking is refused, not reverted by entity type', () => {
  it('refuses an attendance batch whose row has no created list, with a 409, and changes nothing', async () => {
    const { name, employmentId } = await stageStaffMember('LEGACY');
    const batch = await stageAttendance(`${uniqueTag('ATT-LEG')}.csv`, ['Name,08/01/2013', `${name},P`].join('\n'));
    expect((await asUser(CHAIRMAN, () => commitImport(batch.batchId))).errors).toEqual([]);
    const before = await liveAttendanceIds(employmentId);
    expect(before).toHaveLength(1);

    // A row committed before ImportRow.created existed: the column is null on it.
    await unscopedPrisma.importRow.updateMany({
      where: { tenantId: TENANT, batchId: batch.batchId },
      data: { created: Prisma.DbNull },
    });

    const err = await asUser(CHAIRMAN, () => revertImport(batch.batchId)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409 });
    expect(String((err as Error).message)).toMatch(/predates per-row tracking/);
    expect(await liveAttendanceIds(employmentId)).toEqual(before);
    expect((await batchFor(batch.batchId)).status).toBe('committed');
    expect((await rowsFor(batch.batchId)).map((r) => r.status)).toEqual(['committed']);
  });
});

describe('a student register revert undoes the person, profile and affiliation it made, with the enrolment', () => {
  const HEADER = [
    'NAME',
    'REGISTRATION NUMBER',
    'CONTACT',
    'MAIL-ID',
    'COURSE',
    'ACTUAL FEES',
    'Excluding GST',
    'GST',
    'Discount of Rs',
    'DISCOUNT',
    'Including GST',
    'REGISTRATION DATE',
    'COURSE START DATE',
    'COURSE END DATE',
    'IST INSTALLMENT',
    'DATE',
    'Receipt NUMBER',
    '2ND INSTALLMENT',
    'DATE',
    'Receipt NUMBER',
    '3RD  INSTALLMENT',
    'DATE',
    'Receipt NUMBER',
  ];

  it('withdraws the enrolment and ends the new person, their student profile and their student affiliation', async () => {
    const tag = `W5STU${Date.now()}`;
    const name = uniqueName('STUDENT');
    const course = uniqueName('Course');
    const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const rowCells = [
      name,
      `KI-${tag}/1`,
      phone,
      '',
      course,
      '24000',
      '15000',
      '2700',
      '6300',
      '26.25%',
      '17700',
      '7/8/26',
      '7/8/26',
      '9/9/26',
      '10000',
      '7/8/26',
      `KIPL/${tag}`,
      '',
      '',
      '',
      '',
      '',
      '',
      'Yes',
    ];
    const sheet = XLSX.utils.aoa_to_sheet([[...HEADER, 'Adult (18 or over)'], rowCells]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
    const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer);
    const staged = await asUser(CHAIRMAN, () => stageImport({ fileName: `${tag}.xlsx`, buffer }));
    expect(staged.kind).toBe('student_register');
    const committed = await asUser(CHAIRMAN, () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);
    expect(committed.created.enrollment).toBe(1);

    const enrolment = await unscopedPrisma.enrollment.findFirstOrThrow({
      where: { tenantId: TENANT, legacyReference: `KI-${tag}/1` },
    });
    const profile = await unscopedPrisma.studentProfile.findFirstOrThrow({
      where: { tenantId: TENANT, personId: enrolment.personId },
    });
    const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
      where: { tenantId: TENANT, partyId: enrolment.personId, affiliationType: 'student' },
    });

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    expect((await unscopedPrisma.enrollment.findUniqueOrThrow({ where: { id: enrolment.id } })).status).toBe(
      'withdrawn',
    );
    expect(
      (await unscopedPrisma.person.findUniqueOrThrow({ where: { id: enrolment.personId } })).deletedAt,
    ).not.toBeNull();
    expect(
      (await unscopedPrisma.studentProfile.findUniqueOrThrow({ where: { id: profile.id } })).deletedAt,
    ).not.toBeNull();
    expect(
      (await unscopedPrisma.affiliation.findUniqueOrThrow({ where: { id: affiliation.id } })).deletedAt,
    ).not.toBeNull();
  });
});

describe('a revert of a pay record a batch superseded restores that record, unless something later replaced it', () => {
  it('reverting the batch that superseded a pay record makes the earlier record Effective again', async () => {
    const { name, employmentId } = await stageStaffMember('PAYRESTORE');
    const sal50000 = await stageSalaryFor(name, 'January salary', 50000);
    expect((await asUser(CHAIRMAN, () => commitImport(sal50000.batchId))).errors).toEqual([]);
    const recordA = await unscopedPrisma.compensationRecord.findFirstOrThrow({
      where: { tenantId: TENANT, employmentRelationshipId: employmentId, status: 'Effective' },
    });

    const b = await stageSalaryFor(name, 'February salary', 60000);
    expect((await asUser(CHAIRMAN, () => commitImport(b.batchId))).errors).toEqual([]);
    expect((await compensationOf(recordA.id)).status).toBe('Superseded');

    await asUser(CHAIRMAN, () => revertImport(b.batchId));

    const restored = await compensationOf(recordA.id);
    expect(restored.status).toBe('Effective');
    expect(restored.voidedAt).toBeNull();
    expect(restored.effectiveTo).toBeNull();
    expect((await asUser(CHAIRMAN, () => currentCompensation(employmentId)))?.id).toBe(recordA.id);
  });

  it('a later pay record that replaced the superseded one stops the restore, and the row says why', async () => {
    const { name, employmentId } = await stageStaffMember('PAYLATER');
    const sal50000 = await stageSalaryFor(name, 'January salary', 50000);
    expect((await asUser(CHAIRMAN, () => commitImport(sal50000.batchId))).errors).toEqual([]);
    const recordA = await unscopedPrisma.compensationRecord.findFirstOrThrow({
      where: { tenantId: TENANT, employmentRelationshipId: employmentId, status: 'Effective' },
    });
    const b = await stageSalaryFor(name, 'February salary', 60000);
    expect((await asUser(CHAIRMAN, () => commitImport(b.batchId))).errors).toEqual([]);
    const c = await stageSalaryFor(name, 'March salary', 70000);
    expect((await asUser(CHAIRMAN, () => commitImport(c.batchId))).errors).toEqual([]);

    await asUser(CHAIRMAN, () => revertImport(b.batchId));

    expect((await compensationOf(recordA.id)).status).toBe('Superseded');
    const rowB = (await rowsFor(b.batchId)).find((r) => r.entityType === 'compensationRecord');
    expect(rowB?.message).toMatch(/Not restored/);
    expect((await asUser(CHAIRMAN, () => currentCompensation(employmentId)))?.amount.toString()).toBe('70000');
  });
});

describe('ending a record a revert undoes writes a past-tense event for it', () => {
  it('emits the employment, position and assignment the batch created as ended', async () => {
    const name = uniqueName('ENDEVT');
    const csv = [
      'Name,Designation,Employee Code',
      `${name},Analyst,KD/S/2026/${Math.floor(Math.random() * 9000) + 1000}`,
    ].join('\n');
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `${uniqueTag('ENDEVT')}.csv`, buffer: Buffer.from(csv, 'utf8') }),
    );
    expect((await asUser(CHAIRMAN, () => commitImport(staged.batchId))).errors).toEqual([]);
    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: TENANT, fullName: name } });
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: person.id },
    });
    const assignment = await unscopedPrisma.assignment.findFirstOrThrow({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
    });

    await asUser(CHAIRMAN, () => revertImport(staged.batchId));

    const count = (eventName: string, subjectEntityId: string) =>
      unscopedPrisma.eventRecord.count({ where: { tenantId: TENANT, eventName, subjectEntityId } });
    expect(await count('kz.hr.employment.ended', employment.id)).toBe(1);
    expect(await count('kz.hr.assignment.ended', assignment.id)).toBe(1);
    expect(await count('kz.org.position.ended', assignment.positionId)).toBe(1);
  });
});
