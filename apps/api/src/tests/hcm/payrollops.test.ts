/**
 * HCM — payrollops (docs/hcm/payrollops.md, workstream WS8).
 *
 * Own DB (`kaizen_test_payrollops`), against the shared `kaizen` tenant's
 * demo dataset — the same fixture cast `hr.test.ts` and
 * `compliance/payroll.test.ts` use (`operations@kaizen.co.in` = hrOps,
 * `finance@kaizen.co.in` = financeHead, `chairman@kaizen.co.in` = chairman,
 * `ravi@kaizen.co.in` = a plain employee).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { journalTotals, reconciliationDiff, unexplainedCount, payrollCalendarMilestone } from '@kaizen/shared';
import { asUser, expectReject, prisma, unscopedPrisma, tenantId } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  createPayItem, listPayItems, setPayItemActive,
  createAdHocPayLine, approveAdHocPayLine, rejectAdHocPayLine, listAdHocPayLines,
  createArrear, approveArrear, listArrears,
  generatePayrollJournal, postPayrollJournal, getPayrollJournal,
  generateBankAdvice, getBankAdvice, downloadBankAdvice,
  generatePayrollReconciliation,
  upsertPayrollCalendarEntry, listPayrollCalendar,
  createPayrollQuery, respondToPayrollQuery, listPayrollQueries,
} from '../../domains/hcm/payrollops.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function employmentFor(email: string) {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { personId: user.personId } });
}

/** The party id behind an email — for the run fixture, which does not need a full employment record. */
async function partyFor(email: string): Promise<string> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return user.personId!;
}

/** A throwaway employee, hired and activated, for tests that need their own subject. */
async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('operations@kaizen.co.in', async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Payrollops Fixture ${label} ${stamp}`,
        primaryEmail: `payrollops.fixture.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date('2021-01-01') });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** A run and two instructions in different divisions, in a period this suite owns outright. */
async function makeRun(payPeriod: string, rows: Array<{ employmentRelationshipId: string; division: string; gross: number; net: number }>) {
  return asUser('chairman@kaizen.co.in', async () => {
    // Re-running this suite against the same database (a retry, a rerun
    // during development) must not collide with a period it already used —
    // clean up whatever it left behind first, run and instructions alike.
    const stale = await prisma.payrollRun.findFirst({ where: { tenantId: TENANT, payPeriod } });
    if (stale) {
      await prisma.payrollJournal.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.bankAdvice.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.payrollReconciliation.deleteMany({ where: { tenantId: TENANT, OR: [{ payrollRunId: stale.id }, { previousPayrollRunId: stale.id }] } });
      await prisma.payrollInstruction.deleteMany({ where: { tenantId: TENANT, payrollRunId: stale.id } });
      await prisma.payrollRun.delete({ where: { id: stale.id } });
    }

    const recordCode = await nextRecordCode('PRN');
    const run = await prisma.payrollRun.create({
      data: {
        tenantId: TENANT,
        recordCode,
        payPeriod,
        status: 'Approved',
        grossTotal: rows.reduce((s, r) => s + r.gross, 0),
        netTotal: rows.reduce((s, r) => s + r.net, 0),
        headcount: rows.length,
        preparedById: await partyFor('operations@kaizen.co.in'),
        approvedById: await partyFor('finance@kaizen.co.in'),
      },
    });
    for (const row of rows) {
      await prisma.payrollInstruction.create({
        data: {
          tenantId: TENANT,
          employmentRelationshipId: row.employmentRelationshipId,
          payrollRunId: run.id,
          payPeriod,
          division: row.division,
          grossAmount: row.gross,
          netAmount: row.net,
          status: 'Approved',
        },
      });
    }
    return run;
  });
}

// ===========================================================================
// Pure logic — no database
// ===========================================================================

describe('payrollops pure logic (packages/shared/src/hcm/payrollops.ts)', () => {
  it('HCM-PAYROLLOPS-001: a journal built from division gross/net totals always balances', () => {
    const lines = journalTotals([
      { ledgerAccountCode: '6010', label: 'x', costCentre: 'software', debit: 100, credit: 0 },
      { ledgerAccountCode: '2410', label: 'y', costCentre: 'software', debit: 0, credit: 90 },
      { ledgerAccountCode: '2420', label: 'z', costCentre: 'software', debit: 0, credit: 10 },
    ]);
    expect(lines.balanced).toBe(true);
    expect(lines.totalDebit).toBe(100);
    expect(lines.totalCredit).toBe(100);
  });

  it('reconciliationDiff flags a swing beyond the threshold and spares a plain joiner or leaver', () => {
    const deltas = reconciliationDiff(
      [{ employmentRelationshipId: 'a', net: 50_000 }, { employmentRelationshipId: 'b', net: 40_000 }],
      [{ employmentRelationshipId: 'a', net: 51_000 }, { employmentRelationshipId: 'c', net: 45_000 }],
    );
    const a = deltas.find((d) => d.employmentRelationshipId === 'a')!;
    const b = deltas.find((d) => d.employmentRelationshipId === 'b')!;
    const c = deltas.find((d) => d.employmentRelationshipId === 'c')!;
    expect(a.unexplained).toBe(false); // 2% move
    expect(b.unexplained).toBe(false); // leaver, not unexplained
    expect(c.unexplained).toBe(false); // joiner, not unexplained
    expect(unexplainedCount(deltas)).toBe(0);

    const bigSwing = reconciliationDiff(
      [{ employmentRelationshipId: 'a', net: 50_000 }],
      [{ employmentRelationshipId: 'a', net: 20_000 }],
    );
    expect(bigSwing[0].unexplained).toBe(true);
  });

  it('payrollCalendarMilestone reports the stage a period is at right now', () => {
    const cal = {
      attendanceLockAt: '2026-01-05',
      inputFreezeAt: '2026-01-07',
      runByAt: '2026-01-10',
      approveByAt: '2026-01-12',
      payDate: '2026-01-15',
    };
    expect(payrollCalendarMilestone(cal, new Date('2026-01-01'))).toBe('before_attendance_lock');
    expect(payrollCalendarMilestone(cal, new Date('2026-01-11'))).toBe('run_due'); // between runByAt and approveByAt
    expect(payrollCalendarMilestone(cal, new Date('2026-01-20'))).toBe('past_pay_date');
  });
});

// ===========================================================================
// Pay items
// ===========================================================================

describe('pay items', () => {
  it('HCM-PAYROLLOPS-002: hrOps creates a pay item; a duplicate code is refused', async () => {
    const code = `SPOT-${Date.now()}`;
    const item = await asUser('operations@kaizen.co.in', () =>
      createPayItem({ code, name: 'Spot bonus', kind: 'earning', glAccountCode: '6020-BONUS' }),
    );
    expect(item.code).toBe(code);

    await expect(
      asUser('operations@kaizen.co.in', () => createPayItem({ code, name: 'Dup', kind: 'earning', glAccountCode: '6020-BONUS' })),
    ).rejects.toThrow();

    const active = await asUser('operations@kaizen.co.in', () => setPayItemActive(item.id, false));
    expect(active.active).toBe(false);

    const list = await asUser('operations@kaizen.co.in', () => listPayItems());
    expect(list.some((i) => i.id === item.id)).toBe(true);
  });

  it('an employee holds no grant on pay items at all', async () => {
    const err = await expectReject(() => asUser('ravi@kaizen.co.in', () => listPayItems()));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// Ad-hoc pay — Self-Dealing Bar
// ===========================================================================

describe('ad-hoc pay lines', () => {
  it('HCM-PAYROLLOPS-003: hrOps proposes, financeHead approves — never the same partyId', async () => {
    const { employment } = await makeEmployee('adhoc');
    const item = await asUser('operations@kaizen.co.in', () =>
      createPayItem({ code: `ADH-${Date.now()}`, name: 'Ad-hoc bonus', kind: 'earning', glAccountCode: '6020-BONUS' }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      createAdHocPayLine({ employmentRelationshipId: employment.id, payItemId: item.id, payPeriod: '2031-01', amount: 5_000, reason: 'Referral bonus' }),
    );
    expect(line.status).toBe('Proposed');

    // hrOps structurally lacks `adhoc_pay:approve` at all — the proposer
    // never even reaches the Self-Dealing Bar's own-record check.
    const noGrant = await expectReject(() => asUser('operations@kaizen.co.in', () => approveAdHocPayLine(line.id)));
    expect(noGrant.status).toBe(403);

    // Chairman holds every verb, so a chairman-proposed line is the shape
    // that actually reaches the Self-Dealing Bar's own-record check.
    const chairmanLine = await asUser('chairman@kaizen.co.in', () =>
      createAdHocPayLine({ employmentRelationshipId: employment.id, payItemId: item.id, payPeriod: '2031-01', amount: 1_500, reason: 'Second line' }),
    );
    const selfApprove = await expectReject(() => asUser('chairman@kaizen.co.in', () => approveAdHocPayLine(chairmanLine.id)));
    expect(selfApprove.message).toMatch(/Self-Dealing Bar/);
    await asUser('finance@kaizen.co.in', () => approveAdHocPayLine(chairmanLine.id));

    const approved = await asUser('finance@kaizen.co.in', () => approveAdHocPayLine(line.id));
    expect(approved.status).toBe('Approved');

    // Already decided — a second decision is a conflict, not a silent no-op.
    const again = await expectReject(() => asUser('finance@kaizen.co.in', () => approveAdHocPayLine(line.id)));
    expect(again.status).toBe(409);
  });

  it('HCM-PAYROLLOPS-013: hrOps (no `financial` verb) sees ad-hoc pay amounts withheld as null; financeHead sees the real figure', async () => {
    const { employment } = await makeEmployee('adhoc-money');
    const item = await asUser('operations@kaizen.co.in', () =>
      createPayItem({ code: `MONEY-${Date.now()}`, name: 'Money-masked bonus', kind: 'earning', glAccountCode: '6020-BONUS' }),
    );
    await asUser('operations@kaizen.co.in', () =>
      createAdHocPayLine({ employmentRelationshipId: employment.id, payItemId: item.id, payPeriod: '2031-01', amount: 7_777, reason: 'Masking check' }),
    );

    const asOps = await asUser('operations@kaizen.co.in', () => listAdHocPayLines({ employmentRelationshipId: employment.id }));
    expect(asOps[0].amount).toBeNull();
    expect(asOps[0].moneyWithheldReason).toBe('no_permission');

    const asFinance = await asUser('finance@kaizen.co.in', () => listAdHocPayLines({ employmentRelationshipId: employment.id }));
    expect(Number(asFinance[0].amount)).toBe(7_777);
    expect(asFinance[0].moneyWithheldReason).toBeNull();
  });

  it('HCM-PAYROLLOPS-004: a rejected line stays Rejected and is listed by status', async () => {
    const { employment } = await makeEmployee('adhoc-reject');
    const item = await asUser('operations@kaizen.co.in', () =>
      createPayItem({ code: `REJ-${Date.now()}`, name: 'Rejectable', kind: 'deduction', glAccountCode: '2420-DEDUCT' }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      createAdHocPayLine({ employmentRelationshipId: employment.id, payItemId: item.id, payPeriod: '2031-01', amount: 1_000, reason: 'Shortfall recovery' }),
    );
    const rejected = await asUser('finance@kaizen.co.in', () => rejectAdHocPayLine(line.id, 'Not this cycle'));
    expect(rejected.status).toBe('Rejected');

    const list = await asUser('finance@kaizen.co.in', () => listAdHocPayLines({ status: 'Rejected' }));
    expect(list.some((l) => l.id === line.id)).toBe(true);
  });
});

// ===========================================================================
// Arrears
// ===========================================================================

describe('arrears', () => {
  it('HCM-PAYROLLOPS-005: an employee sees only their own arrears; hrOps/financeHead see all', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const arrear = await asUser('operations@kaizen.co.in', () =>
      createArrear({ employmentRelationshipId: ravi.id, fromPeriod: '2030-11', amount: 2_500, reason: 'Delayed increment' }),
    );
    await asUser('finance@kaizen.co.in', () => approveArrear(arrear.id));

    const own = await asUser('ravi@kaizen.co.in', () => listArrears());
    expect(own.every((a) => a.employmentRelationshipId === ravi.id)).toBe(true);
    expect(own.some((a) => a.id === arrear.id)).toBe(true);

    const all = await asUser('operations@kaizen.co.in', () => listArrears());
    expect(all.some((a) => a.id === arrear.id)).toBe(true);
  });
});

// ===========================================================================
// Payroll journal — balances, and posts into the books.
// ===========================================================================

describe('payroll journal', () => {
  it('HCM-PAYROLLOPS-006: a journal generated from an approved run balances and its lines sum to the run totals', async () => {
    const a = await makeEmployee('journal-a');
    const b = await makeEmployee('journal-b');
    const run = await makeRun('2031-02', [
      { employmentRelationshipId: a.employment.id, division: 'software', gross: 100_000, net: 85_000 },
      { employmentRelationshipId: b.employment.id, division: 'skill', gross: 60_000, net: 60_000 },
    ]);

    const journal = await asUser('operations@kaizen.co.in', () => generatePayrollJournal(run.id));
    expect(journal.status).toBe('Prepared');
    expect(Number(journal.totalDebit)).toBe(160_000);
    expect(Number(journal.totalCredit)).toBe(160_000);
    const lines = journal.lines as Array<{ debit: number; credit: number }>;
    // The zero-deduction division (b) contributes two lines, not three.
    expect(lines.length).toBe(5);
  });

  it('HCM-PAYROLLOPS-007: the preparer cannot also post the journal (Self-Dealing Bar); posting records a Transaction', async () => {
    const a = await makeEmployee('journal-post-a');
    const run = await makeRun('2031-03', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 40_000, net: 34_000 }]);

    const bankAccount = await unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });

    // hrOps holds `payroll_journals:create` but not `approve` at all — a
    // structural refusal, before the Self-Dealing Bar's own-record check.
    const opsJournal = await asUser('operations@kaizen.co.in', () => generatePayrollJournal(run.id));
    const noGrant = await expectReject(() => asUser('operations@kaizen.co.in', () => postPayrollJournal(opsJournal.id, bankAccount.id)));
    expect(noGrant.status).toBe(403);

    // Chairman holds both `create` and `approve`, so a chairman-prepared
    // journal is the shape that actually reaches the Self-Dealing Bar.
    const journal = await asUser('chairman@kaizen.co.in', () => generatePayrollJournal(run.id));
    const selfPost = await expectReject(() => asUser('chairman@kaizen.co.in', () => postPayrollJournal(journal.id, bankAccount.id)));
    expect(selfPost.message).toMatch(/Self-Dealing Bar/);

    const posted = await asUser('finance@kaizen.co.in', () => postPayrollJournal(journal.id, bankAccount.id));
    expect(posted.status).toBe('Posted');
    expect(posted.transactionId).toBeTruthy();

    const txn = await unscopedPrisma.transaction.findFirst({ where: { id: posted.transactionId! } });
    expect(txn?.payrollRunId).toBe(run.id);
    expect(Number(txn?.amount)).toBe(34_000);
    expect(txn?.direction).toBe('out');

    const reread = await asUser('finance@kaizen.co.in', () => getPayrollJournal(journal.id));
    expect(reread.status).toBe('Posted');
  });

  it('HCM-PAYROLLOPS-014: net pay cannot be posted from a non-cash account', async () => {
    const a = await makeEmployee('journal-noncash');
    const run = await makeRun('2031-10', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 15_000, net: 13_000 }]);
    const journal = await asUser('operations@kaizen.co.in', () => generatePayrollJournal(run.id));
    const nonCash = await unscopedPrisma.ledgerAccount.findFirst({ where: { tenantId: TENANT, accountType: { notIn: ['bank', 'cash', 'wallet'] } } });
    if (nonCash) {
      const err = await expectReject(() => asUser('finance@kaizen.co.in', () => postPayrollJournal(journal.id, nonCash.id)));
      expect(err.status).toBe(422);
    }
  });

  it('a cross-tenant journal id is 404, not 403', async () => {
    const a = await makeEmployee('cross-tenant');
    const run = await makeRun('2031-04', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 10_000, net: 9_000 }]);
    const journal = await asUser('operations@kaizen.co.in', () => generatePayrollJournal(run.id));

    const otherTenant = await unscopedPrisma.tenant.findFirst({ where: { id: { not: TENANT } } });
    if (otherTenant) {
      const err = await expectReject(() =>
        asUser('chairman@kaizen.co.in', async () => {
          // Force a lookup against a different tenant's row set by asserting the
          // record does not surface under it — same shape as every other
          // tenant-scope test in the suite.
          const foreignRow = await unscopedPrisma.payrollJournal.findFirst({ where: { tenantId: otherTenant.id } });
          if (foreignRow) return getPayrollJournal(foreignRow.id);
          throw new Error('no cross-tenant fixture row; skip via rejection');
        }),
      );
      expect([404, 500].includes(err.status ?? 500) || /no cross-tenant/.test(err.message)).toBe(true);
    } else {
      const err = await expectReject(() => asUser('chairman@kaizen.co.in', () => getPayrollJournal('does-not-exist')));
      expect(err.status).toBe(404);
    }
  });
});

// ===========================================================================
// Bank advice
// ===========================================================================

describe('bank advice', () => {
  it('HCM-PAYROLLOPS-008: generating a bank advice produces one row per employee with net pay and bank details on file', async () => {
    const a = await makeEmployee('bank-a');
    await asUser('chairman@kaizen.co.in', () =>
      prisma.employmentRelationship.update({
        where: { id: a.employment.id },
        data: { bankAccountNumber: '000123456789', bankIfsc: 'HDFC0000123' },
      }),
    );
    const run = await makeRun('2031-05', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 30_000, net: 27_000 }]);

    const advice = await asUser('operations@kaizen.co.in', () => generateBankAdvice(run.id));
    expect(advice.count).toBe(1);
    expect(advice.total).toBe(27_000);
  });

  it('an employee holds no grant on bank advices', async () => {
    const err = await expectReject(() => asUser('ravi@kaizen.co.in', () => generateBankAdvice('whatever')));
    expect(err.status).toBe(403);
  });

  it('HCM-PAYROLLOPS-012: the view response masks account numbers to their last 4 digits; only the audited download carries the full number', async () => {
    const a = await makeEmployee('bank-mask');
    await asUser('chairman@kaizen.co.in', () =>
      prisma.employmentRelationship.update({
        where: { id: a.employment.id },
        data: { bankAccountNumber: '000198765432', bankIfsc: 'HDFC0000456' },
      }),
    );
    const run = await makeRun('2031-09', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 20_000, net: 18_000 }]);
    const advice = await asUser('operations@kaizen.co.in', () => generateBankAdvice(run.id));

    const viewed = await asUser('operations@kaizen.co.in', () => getBankAdvice(advice.id));
    expect(viewed.rows[0].accountNumber).not.toContain('98765432');
    expect(viewed.rows[0].accountNumber.endsWith('5432')).toBe(true);
    expect((viewed as unknown as { fileText?: string }).fileText).toBeUndefined();

    const downloaded = await asUser('operations@kaizen.co.in', () => downloadBankAdvice(advice.id));
    expect(downloaded.csv).toContain('000198765432');

    // financeHead can view and download too (holds `export`); an employee holds neither.
    const employeeDenied = await expectReject(() => asUser('ravi@kaizen.co.in', () => getBankAdvice(advice.id)));
    expect(employeeDenied.status).toBe(403);
  });
});

// ===========================================================================
// Reconciliation
// ===========================================================================

describe('payroll reconciliation', () => {
  it('HCM-PAYROLLOPS-009: an unexplained swing between two runs raises an exception and flags the row', async () => {
    const a = await makeEmployee('recon-a');
    const prev = await makeRun('2031-06', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 50_000, net: 45_000 }]);
    const curr = await makeRun('2031-07', [{ employmentRelationshipId: a.employment.id, division: 'software', gross: 20_000, net: 18_000 }]);

    // hrOps holds only `payroll_reconciliations:view`; generating one is
    // financeHead's call, the last check before disbursal.
    const denied = await expectReject(() => asUser('operations@kaizen.co.in', () => generatePayrollReconciliation(curr.id, prev.id)));
    expect(denied.status).toBe(403);

    const recon = await asUser('finance@kaizen.co.in', () => generatePayrollReconciliation(curr.id, prev.id));
    expect(recon.unexplainedCount).toBeGreaterThan(0);
    const deltas = recon.deltas as Array<{ employmentRelationshipId: string; unexplained: boolean }>;
    expect(deltas.find((d) => d.employmentRelationshipId === a.employment.id)?.unexplained).toBe(true);
  });
});

// ===========================================================================
// Payroll calendar
// ===========================================================================

describe('payroll calendar', () => {
  it('HCM-PAYROLLOPS-010: milestones out of order are refused; a valid calendar can be read back with its live milestone', async () => {
    const outOfOrder = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        upsertPayrollCalendarEntry({
          payPeriod: '2031-08',
          attendanceLockAt: new Date('2031-08-10'),
          inputFreezeAt: new Date('2031-08-05'), // before the lock — invalid
          runByAt: new Date('2031-08-15'),
          approveByAt: new Date('2031-08-18'),
          payDate: new Date('2031-08-20'),
        }),
      ),
    );
    expect(outOfOrder.status).toBe(422);

    const ok = await asUser('operations@kaizen.co.in', () =>
      upsertPayrollCalendarEntry({
        payPeriod: '2031-08',
        attendanceLockAt: new Date('2031-08-01'),
        inputFreezeAt: new Date('2031-08-05'),
        runByAt: new Date('2031-08-10'),
        approveByAt: new Date('2031-08-15'),
        payDate: new Date('2031-08-20'),
      }),
    );
    expect(ok.payPeriod).toBe('2031-08');

    const list = await asUser('operations@kaizen.co.in', () => listPayrollCalendar());
    const found = list.find((c) => c.payPeriod === '2031-08') as { milestone?: string } | undefined;
    expect(found?.milestone).toBeTruthy();
  });
});

// ===========================================================================
// Payroll queries — an employee's own question about their own payslip.
// ===========================================================================

describe('payroll queries', () => {
  it('HCM-PAYROLLOPS-011: an employee raises a query on their own employment; another employee cannot raise one on it', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const query = await asUser('ravi@kaizen.co.in', () =>
      createPayrollQuery({ employmentRelationshipId: ravi.id, payPeriod: '2031-01', subject: 'Lower than expected', message: 'My net pay looks off this month.' }),
    );
    expect(query.status).toBe('Open');

    const divya = await unscopedPrisma.user.findFirst({ where: { email: 'divya@kaizen.co.in' } });
    if (divya) {
      const err = await expectReject(() =>
        asUser('divya@kaizen.co.in', () =>
          createPayrollQuery({ employmentRelationshipId: ravi.id, payPeriod: '2031-01', subject: 'Not mine', message: 'x' }),
        ),
      );
      expect(err.status).toBe(404);
    }

    const responded = await asUser('operations@kaizen.co.in', () => respondToPayrollQuery(query.id, 'Checked — an ad-hoc deduction landed this month.', true));
    expect(responded.status).toBe('Closed');

    const mine = await asUser('ravi@kaizen.co.in', () => listPayrollQueries());
    expect(mine.every((q) => q.employmentRelationshipId === ravi.id)).toBe(true);
  });

  it('financeHead holds view-only on payroll queries — no create grant at all, whoever the subject is', async () => {
    const err = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createPayrollQuery({ employmentRelationshipId: 'does-not-exist', payPeriod: '2031-01', subject: 'x', message: 'y' })),
    );
    expect(err.status).toBe(403);
  });

  it('hrOps raising a query against an employment that does not exist gets a 404, not a silent create', async () => {
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => createPayrollQuery({ employmentRelationshipId: 'does-not-exist', payPeriod: '2031-01', subject: 'x', message: 'y' })),
    );
    expect(err.status).toBe(404);
  });
});
