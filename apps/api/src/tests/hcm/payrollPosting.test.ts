/**
 * HCM payroll posting — FX-73a (Wave 5 PR7). A run's net pay reaches the legacy
 * books once, however many times it is posted and by whichever of the two routes
 * (`/books/payroll/:id/post`, `/hcm/payrollops/journals/:id/post`), and the
 * journal's `Posted` status commits in the same transaction as those writes.
 *
 * Real Postgres, no mocks. The injected failure is a trigger on the journal table
 * that refuses one payroll period, as FX-33's refund test does; the period is one
 * this file owns, so the trigger cannot touch the other payroll suite running
 * against the same database.
 *
 * Legacy TB is the `trialBalance` the close and the Tally export read
 * (`compliance/books.ts`). The journal TB is `journalTrialBalance`, which no
 * posting in this PR touches, but it is asserted after every committed step.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, unscopedPrisma, tenantId } from '../helpers.js';
import { parseMinor } from '@kaizen/shared';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { trialBalance } from '../../domains/compliance/books.js';
import { postPayrollToBooks } from '../../domains/books.js';
import { generatePayrollJournal, postPayrollJournal } from '../../domains/hcm/payrollops.js';
import { nextRecordCode } from '../../platform/recordCode.js';

const OPERATIONS = 'operations@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');
/** The one period the injected failure refuses. No other test in this file uses it. */
const INJECT_PERIOD = '2044-06';
const INJECT_TRIGGER = 'fx73a_refuse_inject';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** Two divisions, one employment each, net 34,000 and 20,000: net pay is 54,000 in total. */
const SHARES = [
  { division: 'software', net: 34_000 },
  { division: 'skill', net: 20_000 },
];
const NET_TOTAL = SHARES.reduce((s, r) => s + r.net, 0);
const NET_PAISE = parseMinor(`${NET_TOTAL}.00`);

/** A disbursed run for `payPeriod`, one instruction per share. The run is refreshed if the period was used before. */
async function makeDisbursedRun(payPeriod: string) {
  const employments = await unscopedPrisma.employmentRelationship.findMany({
    where: { tenantId: TENANT },
    orderBy: { id: 'asc' },
    take: SHARES.length,
  });
  if (employments.length < SHARES.length) throw new Error('The demo dataset needs two employment relationships');

  return asUser(OPERATIONS, async () => {
    const stale = await prisma.payrollRun.findFirst({ where: { tenantId: TENANT, payPeriod } });
    if (stale) {
      await prisma.payrollJournal.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.bankAdvice.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.payrollReconciliation.deleteMany({
        where: { tenantId: TENANT, OR: [{ payrollRunId: stale.id }, { previousPayrollRunId: stale.id }] },
      });
      await prisma.payrollInstruction.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.payrollRun.delete({ where: { id: stale.id } });
    }

    const approver = await unscopedPrisma.user.findFirstOrThrow({ where: { email: FINANCE } });
    const preparer = await unscopedPrisma.user.findFirstOrThrow({ where: { email: OPERATIONS } });
    const run = await prisma.payrollRun.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PRN'),
        payPeriod,
        status: 'Disbursed',
        disbursedAt: new Date(),
        grossTotal: NET_TOTAL,
        netTotal: NET_TOTAL,
        headcount: SHARES.length,
        preparedById: preparer.personId!,
        approvedById: approver.personId!,
      },
    });
    for (const [i, share] of SHARES.entries()) {
      await prisma.payrollInstruction.create({
        data: {
          tenantId: TENANT,
          employmentRelationshipId: employments[i]!.id,
          payrollRunId: run.id,
          payPeriod,
          division: share.division,
          grossAmount: share.net,
          netAmount: share.net,
          status: 'Disbursed',
        },
      });
    }
    return run;
  });
}

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({
    where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    orderBy: { id: 'asc' },
  });
}

/**
 * The bank account's signed balance on the legacy TB, in paise. The TB is computed
 * in JavaScript numbers (compliance/books.ts), so each figure is read back to paise
 * before it is compared: 1,025,869.93 - 54,000 is not exactly 1,025,869.93 - 54,000
 * in floating point, and the test has to say what it means, which is paise.
 */
async function legacyBankPaise(accountName: string): Promise<bigint> {
  const tb = await asUser(FINANCE, () => trialBalance(FAR_FUTURE));
  const row = tb.rows.find((r) => r.name === accountName);
  return parseMinor((row?.debit ?? 0).toFixed(2)) - parseMinor((row?.credit ?? 0).toFixed(2));
}

async function legacyTransactionsFor(runId: string) {
  return unscopedPrisma.transaction.findMany({
    where: { tenantId: TENANT, payrollRunId: runId, deletedAt: null },
    orderBy: { id: 'asc' },
  });
}

async function assertJournalTrialBalance() {
  const tb = await asUser(FINANCE, () => journalTrialBalance(FAR_FUTURE));
  expect(() => assertTrialBalance(tb)).not.toThrow();
}

/** The HTTP status of a rejected call, for the concurrent cases where `expectReject` cannot be used. */
function statusOf(reason: unknown): number | undefined {
  return (reason as { status?: number }).status;
}

describe('payroll run posts once (FX-73a)', () => {
  it('a repeated journal post is refused: one set of legacy rows, and the legacy TB moves once by net pay', async () => {
    const run = await makeDisbursedRun('2044-01');
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    const first = await asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id));
    expect(first.status).toBe('Posted');
    await assertJournalTrialBalance();

    const second = await expectReject(() => asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id)));
    expect(second.status).toBe(409);
    await assertJournalTrialBalance();

    const rows = await legacyTransactionsFor(run.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount)).toBe(NET_TOTAL);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
  });

  it('a journal post after a books post is refused, and the books post stands alone', async () => {
    const run = await makeDisbursedRun('2044-02');
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    const booked = await asUser(FINANCE, () => postPayrollToBooks(run.id, bank.id));
    expect(booked.posted).toBe(SHARES.length);
    await assertJournalTrialBalance();

    const late = await expectReject(() => asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id)));
    expect(late.status).toBe(409);
    await assertJournalTrialBalance();

    const rows = await legacyTransactionsFor(run.id);
    expect(rows).toHaveLength(SHARES.length);
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(NET_TOTAL);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
  });

  it('a books post after a journal post is refused, and the journal keeps the one net leg', async () => {
    const run = await makeDisbursedRun('2044-05');
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    await asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id));

    const late = await expectReject(() => asUser(FINANCE, () => postPayrollToBooks(run.id, bank.id)));
    expect(late.status).toBe(409);
    await assertJournalTrialBalance();

    const rows = await legacyTransactionsFor(run.id);
    expect(rows).toHaveLength(1);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
  });

  it('two concurrent journal posts: one posts, the other is refused, one set of rows', async () => {
    const run = await makeDisbursedRun('2044-03');
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    const results = await Promise.allSettled([
      asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id)),
      asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id)),
    ]);
    const posted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(posted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(statusOf(refused[0]!.reason)).toBe(409);
    await assertJournalTrialBalance();

    const rows = await legacyTransactionsFor(run.id);
    expect(rows).toHaveLength(1);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
  });

  it('two concurrent books posts: one set of rows, and the legacy TB moves once by net pay', async () => {
    const run = await makeDisbursedRun('2044-04');
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    const results = await Promise.allSettled([
      asUser(FINANCE, () => postPayrollToBooks(run.id, bank.id)),
      asUser(FINANCE, () => postPayrollToBooks(run.id, bank.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await assertJournalTrialBalance();

    const rows = await legacyTransactionsFor(run.id);
    expect(rows).toHaveLength(SHARES.length);
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(NET_TOTAL);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
  });

  it('an injected failure after the legacy write leaves the journal unposted with zero rows; the retry posts once', async () => {
    const run = await makeDisbursedRun(INJECT_PERIOD);
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();
    const before = await legacyBankPaise(bank.name);

    await unscopedPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fx73a_refuse_inject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."payPeriod" = '${INJECT_PERIOD}' THEN RAISE EXCEPTION 'fx73a injected failure'; END IF;
        RETURN NEW;
      END $$`);
    await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${INJECT_TRIGGER}" ON "hcm_payroll_journals"`);
    await unscopedPrisma.$executeRawUnsafe(`
      CREATE TRIGGER "${INJECT_TRIGGER}" BEFORE UPDATE ON "hcm_payroll_journals"
      FOR EACH ROW EXECUTE FUNCTION fx73a_refuse_inject()`);

    try {
      const failure = await expectReject(() => asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id)));
      expect(failure.message).toMatch(/fx73a injected failure/);
    } finally {
      await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${INJECT_TRIGGER}" ON "hcm_payroll_journals"`);
    }

    // The failed attempt is one transaction: no legacy row, no journal status, no audit row for the post.
    const afterFailure = await unscopedPrisma.payrollJournal.findUniqueOrThrow({ where: { id: journal.id } });
    expect(afterFailure.status).toBe('Prepared');
    expect(afterFailure.transactionId).toBeNull();
    expect(await legacyTransactionsFor(run.id)).toHaveLength(0);
    expect(await legacyBankPaise(bank.name)).toBe(before);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: TENANT, subjectType: 'payroll_journal', subjectId: journal.id, action: 'update' },
      }),
    ).toBe(0);

    // The retry posts exactly one set of rows.
    const retried = await asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id));
    expect(retried.status).toBe('Posted');
    expect(await legacyTransactionsFor(run.id)).toHaveLength(1);
    expect((await legacyBankPaise(bank.name)) - before).toBe(-NET_PAISE);
    await assertJournalTrialBalance();
  });

  it('a successful journal post writes an audit row for the journal and one for its transaction', async () => {
    const run = await makeDisbursedRun('2044-07');
    const journal = await asUser(OPERATIONS, () => generatePayrollJournal(run.id));
    const bank = await bankAccount();

    const posted = await asUser(FINANCE, () => postPayrollJournal(journal.id, bank.id));
    expect(posted.transactionId).toBeTruthy();

    const journalAudit = await unscopedPrisma.auditRecord.count({
      where: { tenantId: TENANT, subjectType: 'payroll_journal', subjectId: journal.id, action: 'update' },
    });
    expect(journalAudit).toBeGreaterThanOrEqual(1);

    const txnAudit = await unscopedPrisma.auditRecord.count({
      where: { tenantId: TENANT, subjectType: 'transaction', subjectId: posted.transactionId!, action: 'create' },
    });
    expect(txnAudit).toBe(1);
  });
});
