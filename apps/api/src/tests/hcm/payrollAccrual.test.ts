/**
 * HCM payroll accrual — FX-73. A disbursed or approved run's liabilities reach
 * the ledger: one balanced journal entry per ledger entity, through post() and
 * postInTx with the posting roles resolved, in the same transaction as the run's
 * lock-for-posting, from either payroll posting route.
 *
 * Real Postgres, real contexts, no mocks. Every fixture is a tenant of its own
 * (booksTenant), so no other file's periods, roles or entries are in its balances.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseMinor, type PostingRole } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant, expectReject, type BooksTenant } from '../helpers.js';
import { approvePayrollRules, recordStatutoryLines } from './payrollLedgerFixture.js';
import { postPayrollJournal } from '../../domains/hcm/payrollops.js';
import { postPayrollToBooks } from '../../domains/books.js';
import { setPayrollDivisionLine } from '../../domains/hcm/payrollDivisionLines.js';

/** Tenant slugs are per run: booksTenant reuses a slug, so a fixed one would collide with the last run's rows. */
const RUN = randomUUID().slice(0, 8);
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
const FROM = '2000-01-01';

const ROLE_ACCOUNT_CLASS: Record<string, 'expense' | 'liability'> = {
  PAYROLL_SALARY_EXPENSE: 'expense',
  PAYROLL_EMPLOYER_CONTRIB_EXPENSE: 'expense',
  PAYROLL_NET_PAY_PAYABLE: 'liability',
  PAYROLL_PF_PAYABLE: 'liability',
  PAYROLL_ESI_PAYABLE: 'liability',
  PAYROLL_PT_PAYABLE: 'liability',
  PAYROLL_TDS_PAYABLE: 'liability',
  PAYROLL_LWF_PAYABLE: 'liability',
};
const ALL_ROLES = Object.keys(ROLE_ACCOUNT_CLASS) as PostingRole[];
const SHORT: Record<string, string> = {
  PAYROLL_SALARY_EXPENSE: 'SALARY',
  PAYROLL_EMPLOYER_CONTRIB_EXPENSE: 'ER',
  PAYROLL_NET_PAY_PAYABLE: 'NET',
  PAYROLL_PF_PAYABLE: 'PF',
  PAYROLL_ESI_PAYABLE: 'ESI',
  PAYROLL_PT_PAYABLE: 'PT',
  PAYROLL_TDS_PAYABLE: 'TDS',
  PAYROLL_LWF_PAYABLE: 'LWF',
};

interface Fixture {
  t: BooksTenant;
  /** A second ledger entity: the run's second entry lands here. */
  entity2: string;
  lineSoftware: string;
  lineShared: string;
  accounts: Record<string, string>;
}

/** A period is one IST month of the tenant; the pay month and the cash leg's month both need one. */
function bounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return {
    startsOn: new Date(`${month}-01T00:00:00.000Z`),
    endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
  };
}

const PERIODS = Array.from({ length: 12 }, (_, i) => `2041-${String(i + 1).padStart(2, '0')}`);

/** A tenant with accounts, business lines, posting roles (all but `omit`), division lines and open periods. */
async function fixture(slug: string, omit: readonly string[] = []): Promise<Fixture> {
  const t = await booksTenant(slug);
  const tid = t.tenantId;
  const entity2 = await unscopedPrisma.ledgerEntity.create({
    data: { tenantId: tid, code: 'E2', legalName: `Accrual entity two ${slug}`, stateCode: '29' },
  });
  const effectiveFrom = new Date(`${FROM}T00:00:00.000Z`);
  const lineSoftware = await unscopedPrisma.businessLine.create({
    data: {
      tenantId: tid,
      code: 'SOFT',
      name: 'Software',
      payerKind: 'corporate',
      revenueModel: 'licence',
      effectiveFrom,
    },
  });
  const lineShared = await unscopedPrisma.businessLine.create({
    data: {
      tenantId: tid,
      code: 'SHRD',
      name: 'Shared',
      payerKind: 'internal',
      revenueModel: 'allocation',
      effectiveFrom,
    },
  });
  // The run's statutory lines name the approved rules they were computed from (FX-73, S10).
  await approvePayrollRules(tid, `chairman@${slug}.books.test`);
  const accounts: Record<string, string> = {};
  for (const role of ALL_ROLES) {
    const account = await unscopedPrisma.ledgerAccount.create({
      data: { tenantId: tid, name: `TEST ONLY ${SHORT[role]}`, accountClass: ROLE_ACCOUNT_CLASS[role]! },
    });
    accounts[role] = account.id;
    if (omit.includes(role)) continue;
    await unscopedPrisma.ledgerPostingRole.create({
      data: { tenantId: tid, role, scopeKey: '', ledgerAccountId: account.id, effectiveFrom, setById: randomUUID() },
    });
  }
  await asUser(t.finance, () =>
    setPayrollDivisionLine({ division: 'software', lineId: lineSoftware.id, effectiveFrom: FROM }),
  );
  await asUser(t.finance, () =>
    setPayrollDivisionLine({ division: 'shared', lineId: lineShared.id, effectiveFrom: FROM }),
  );
  for (const month of PERIODS) {
    await unscopedPrisma.accountingPeriod.create({
      data: { tenantId: tid, entityId: t.entityId, period: month, fy: '2040-41', status: 'open', ...bounds(month) },
    });
  }
  return { t, entity2: entity2.id, lineSoftware: lineSoftware.id, lineShared: lineShared.id, accounts };
}

/** An employee in one ledger entity, or in none. */
async function employee(tid: string, ledgerEntityId: string | null): Promise<string> {
  const stamp = randomUUID().slice(0, 8);
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-${stamp}`,
      fullName: `Accrual fixture ${stamp}`,
      primaryEmail: `accrual.${stamp}@example.com`,
      source: 'test',
    },
  });
  const employment = await unscopedPrisma.employmentRelationship.create({
    data: {
      tenantId: tid,
      recordCode: `EMP-${stamp}`,
      personId: person.id,
      hireEffectiveDate: new Date('2020-01-01T00:00:00.000Z'),
      status: 'Active',
      ledgerEntityId,
    },
  });
  return employment.id;
}

interface Row {
  employmentId: string;
  division: string | null;
  gross: string;
  pfEe?: string;
  pfEr?: string;
  eps?: string;
  esiEe?: string;
  esiEr?: string;
  pt?: string;
  lwfEe?: string;
  lwfEr?: string;
  tds?: string;
  /** Employer costs the rules compute (EDLI and the PF admin charge), stored as statutory lines. */
  edli?: string;
  admin?: string;
  /** Stored net pay, when a test needs it wrong. Otherwise gross less the employee-side deductions. */
  netOverride?: string;
}

const zero = (v: string | undefined) => parseMinor(v ?? '0.00');

/** A run for `payPeriod` with one instruction per row, the way computeInstruction stores them. */
async function makeRun(tid: string, payPeriod: string, rows: Row[], status = 'Approved') {
  // Totals as COMPUTE writes them (payroll.ts transitionPayrollRun): the cash leg reads netTotal.
  let grossTotal = 0n;
  let netTotal = 0n;
  for (const r of rows) {
    const deductions = zero(r.pfEe) + zero(r.esiEe) + zero(r.pt) + zero(r.lwfEe) + zero(r.tds);
    const net = r.netOverride !== undefined ? parseMinor(r.netOverride) : zero(r.gross) - deductions;
    grossTotal += zero(r.gross);
    netTotal += net;
  }
  const run = await unscopedPrisma.payrollRun.create({
    data: {
      tenantId: tid,
      recordCode: `PRN-${payPeriod}-${randomUUID().slice(0, 6)}`,
      payPeriod,
      status,
      headcount: rows.length,
      grossTotalMinor: grossTotal,
      netTotalMinor: netTotal,
      disbursedAt: status === 'Disbursed' ? new Date(`${payPeriod}-28T10:00:00.000Z`) : null,
    },
  });
  for (const r of rows) {
    const deductions = zero(r.pfEe) + zero(r.esiEe) + zero(r.pt) + zero(r.lwfEe) + zero(r.tds);
    const net = r.netOverride !== undefined ? parseMinor(r.netOverride) : zero(r.gross) - deductions;
    await unscopedPrisma.payrollInstruction.create({
      data: {
        tenantId: tid,
        employmentRelationshipId: r.employmentId,
        payrollRunId: run.id,
        payPeriod,
        division: r.division,
        status,
        grossAmountMinor: zero(r.gross),
        deductionsMinor: deductions,
        netAmountMinor: net,
        pfEmployeeMinor: zero(r.pfEe),
        pfEmployerMinor: zero(r.pfEr),
        epsEmployerMinor: zero(r.eps),
        esiEmployeeMinor: zero(r.esiEe),
        esiEmployerMinor: zero(r.esiEr),
        professionalTaxMinor: zero(r.pt),
        lwfEmployeeMinor: zero(r.lwfEe),
        lwfEmployerMinor: zero(r.lwfEr),
        tdsAmountMinor: zero(r.tds),
      },
    });
    await recordStatutoryLines({
      tenantId: tid,
      payrollRunId: run.id,
      payPeriod,
      employmentId: r.employmentId,
      amounts: {
        PF_EMPLOYEE: zero(r.pfEe),
        PF_EMPLOYER: zero(r.pfEr),
        EPS_EMPLOYER: zero(r.eps),
        EDLI_EMPLOYER: zero(r.edli),
        ADMIN_EMPLOYER: zero(r.admin),
        ESI_EMPLOYEE: zero(r.esiEe),
        ESI_EMPLOYER: zero(r.esiEr),
        PT_EMPLOYEE: zero(r.pt),
        LWF_EMPLOYEE: zero(r.lwfEe),
        LWF_EMPLOYER: zero(r.lwfEr),
      },
    });
  }
  return run;
}

/** The journal row the payroll journal route posts: Prepared, prepared by nobody, so the Self-Dealing Bar does not apply. */
async function preparedJournal(tid: string, runId: string, payPeriod: string) {
  return unscopedPrisma.payrollJournal.create({
    data: {
      tenantId: tid,
      payrollRunId: runId,
      payPeriod,
      lines: [] as never,
      totalDebitMinor: 0n,
      totalCreditMinor: 0n,
      status: 'Prepared',
    },
  });
}

/** Every posted entry the run produced, with its lines, read as the finance head. */
function runEntries(f: Fixture, runId: string) {
  return asUser(f.t.finance, () =>
    prisma.journalEntry.findMany({
      where: { sourceType: 'payroll_run', sourceId: runId },
      include: { lines: true },
      orderBy: { entryNumber: 'asc' },
    }),
  );
}

/** A line as `ROLE|lineId|amount`, for an exact comparison of one entry. */
function summarise(f: Fixture, lines: Array<{ accountId: string; lineId: string | null; amountMinor: bigint }>) {
  const roleOf = new Map(Object.entries(f.accounts).map(([role, id]) => [id, SHORT[role]!]));
  return lines.map((l) => `${roleOf.get(l.accountId)}|${l.lineId ?? ''}|${l.amountMinor.toString()}`).sort();
}

const sumDebits = (lines: Array<{ amountMinor: bigint }>) =>
  lines.reduce((s, l) => s + (l.amountMinor > 0n ? l.amountMinor : 0n), 0n);
const sumCredits = (lines: Array<{ amountMinor: bigint }>) =>
  lines.reduce((s, l) => s + (l.amountMinor < 0n ? -l.amountMinor : 0n), 0n);

let main: Fixture;
let mainEntity1Employees: { a: string; b: string };
let mainEntity2Employee: string;

beforeAll(async () => {
  main = await fixture(`pay-fx73-main-${RUN}`);
  mainEntity1Employees = {
    a: await employee(main.t.tenantId, main.t.entityId),
    b: await employee(main.t.tenantId, main.t.entityId),
  };
  mainEntity2Employee = await employee(main.t.tenantId, main.entity2);
});

describe('FX-73: a run posts its liabilities, once per ledger entity', () => {
  it('posts one balanced entry per entity whose payables equal the computed deductions', async () => {
    const { t } = main;
    const { a, b } = mainEntity1Employees;
    const run = await makeRun(t.tenantId, '2041-01', [
      // Division software, PF, PT and TDS deducted; PF employer side includes EPS.
      {
        employmentId: a,
        division: 'software',
        gross: '50000.00',
        pfEe: '1800.00',
        pfEr: '550.00',
        eps: '1250.00',
        pt: '200.00',
        tds: '4000.00',
      },
      // No division: the null division maps as shared. ESI and LWF in its due month.
      {
        employmentId: b,
        division: null,
        gross: '30000.00',
        pfEe: '1800.00',
        pfEr: '550.00',
        eps: '1250.00',
        esiEe: '225.00',
        esiEr: '975.00',
        pt: '200.00',
        lwfEe: '6.00',
        lwfEr: '12.00',
      },
      { employmentId: mainEntity2Employee, division: 'software', gross: '20000.00', esiEe: '150.00', esiEr: '650.00' },
    ]);
    const journal = await preparedJournal(t.tenantId, run.id, '2041-01');

    await asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId));

    const entries = await runEntries(main, run.id);
    expect(entries).toHaveLength(2);
    const e1 = entries.find((e) => e.entityId === t.entityId)!;
    const e2 = entries.find((e) => e.entityId === main.entity2)!;

    expect(summarise(main, e1.lines)).toEqual(
      [
        `SALARY|${main.lineSoftware}|5000000`,
        `SALARY|${main.lineShared}|3000000`,
        `ER|${main.lineSoftware}|180000`,
        `ER|${main.lineShared}|278700`,
        'NET||-7176900',
        'PF||-720000',
        'ESI||-120000',
        'PT||-40000',
        'LWF||-1800',
        'TDS||-400000',
      ].sort(),
    );
    expect(summarise(main, e2.lines)).toEqual(
      [`SALARY|${main.lineSoftware}|2000000`, `ER|${main.lineSoftware}|65000`, 'NET||-1985000', 'ESI||-80000'].sort(),
    );

    for (const e of [e1, e2]) {
      expect(sumDebits(e.lines)).toBe(sumCredits(e.lines));
    }
    assertTrialBalance(await asUser(t.finance, () => journalTrialBalance(ALL_TIME)));
  });

  it('refuses an unmapped division with a 422 that names it and the pay period, and writes nothing', async () => {
    const { t } = main;
    const run = await makeRun(t.tenantId, '2041-02', [
      {
        employmentId: mainEntity1Employees.a,
        division: 'ghost-division',
        gross: '10000.00',
        esiEe: '150.00',
        esiEr: '650.00',
      },
    ]);
    const journal = await preparedJournal(t.tenantId, run.id, '2041-02');

    const err = await expectReject(() => asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId)));

    expect(err.status).toBe(422);
    expect(err.message).toContain('ghost-division');
    expect(err.message).toContain('2041-02');
    expect(await runEntries(main, run.id)).toHaveLength(0);
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: t.tenantId, payrollRunId: run.id } })).toBe(0);
    expect((await unscopedPrisma.payrollJournal.findUniqueOrThrow({ where: { id: journal.id } })).status).toBe(
      'Prepared',
    );
  });

  it('refuses a run with an employee who has no ledger entity, and names how many', async () => {
    const { t } = main;
    const unmapped = await employee(t.tenantId, null);
    const run = await makeRun(t.tenantId, '2041-05', [
      {
        employmentId: mainEntity1Employees.a,
        division: 'software',
        gross: '10000.00',
        esiEe: '150.00',
        esiEr: '650.00',
      },
      { employmentId: unmapped, division: 'software', gross: '10000.00', esiEe: '150.00', esiEr: '650.00' },
    ]);
    const journal = await preparedJournal(t.tenantId, run.id, '2041-05');

    const err = await expectReject(() => asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId)));

    expect(err.status).toBe(422);
    expect(err.message).toMatch(/\b1 employee\b/);
    expect(await runEntries(main, run.id)).toHaveLength(0);
  });

  it('refuses a residual, gross less net not equal to the deductions, and does not plug it', async () => {
    const { t } = main;
    const run = await makeRun(t.tenantId, '2041-04', [
      // Net is stored one rupee low (9849.00, not 9850.00): gross less net exceeds the deductions by 100 paise.
      {
        employmentId: mainEntity1Employees.a,
        division: 'software',
        gross: '10000.00',
        esiEe: '150.00',
        esiEr: '650.00',
        netOverride: '9849.00',
      },
    ]);
    const journal = await preparedJournal(t.tenantId, run.id, '2041-04');

    const err = await expectReject(() => asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId)));

    expect(err.status).toBe(422);
    expect(err.message).toContain('100 paise');
    expect(await runEntries(main, run.id)).toHaveLength(0);
  });

  it('a March run approved in April lands on 31 March, the last IST day of its pay month', async () => {
    const { t } = main;
    const run = await makeRun(t.tenantId, '2041-03', [
      { employmentId: mainEntity1Employees.b, division: 'shared', gross: '10000.00', esiEe: '150.00', esiEr: '650.00' },
    ]);
    const journal = await preparedJournal(t.tenantId, run.id, '2041-03');

    // 10:00 IST on 2 April 2041. The entry date comes from the pay month, never from the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2041-04-02T04:30:00.000Z'));
      await asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId));
    } finally {
      vi.useRealTimers();
    }

    const entries = await runEntries(main, run.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryDate.toISOString()).toBe('2041-03-31T00:00:00.000Z');
  });

  it('a second post, by either route, posts no second entry', async () => {
    const { t } = main;
    const run = await makeRun(
      t.tenantId,
      '2041-08',
      [
        {
          employmentId: mainEntity1Employees.a,
          division: 'software',
          gross: '10000.00',
          esiEe: '150.00',
          esiEr: '650.00',
        },
        { employmentId: mainEntity2Employee, division: 'shared', gross: '5000.00', esiEe: '75.00', esiEr: '325.00' },
      ],
      'Disbursed',
    );
    const journal = await preparedJournal(t.tenantId, run.id, '2041-08');

    // The books route posts first and takes the run's lock.
    await asUser(t.finance, () => postPayrollToBooks(run.id, t.bankAccountId));
    expect(await runEntries(main, run.id)).toHaveLength(2);

    // The journal route is refused by the lock, and posts no second accrual.
    const err = await expectReject(() => asUser(t.finance, () => postPayrollJournal(journal.id, t.bankAccountId)));
    expect(err.status).toBe(409);
    expect(await runEntries(main, run.id)).toHaveLength(2);
  });
});

describe('FX-73: posting roles are resolved only for the lines a run has', () => {
  it('a run with no PF or LWF amount posts without those roles; a run with PF refuses with 422 and writes nothing', async () => {
    const gaps = await fixture(`pay-fx73-gaps-${RUN}`, ['PAYROLL_PF_PAYABLE', 'PAYROLL_LWF_PAYABLE']);
    const emp = await employee(gaps.t.tenantId, gaps.t.entityId);

    const quiet = await makeRun(gaps.t.tenantId, '2041-01', [
      { employmentId: emp, division: 'software', gross: '10000.00', esiEe: '150.00', esiEr: '650.00' },
    ]);
    const quietJournal = await preparedJournal(gaps.t.tenantId, quiet.id, '2041-01');
    await asUser(gaps.t.finance, () => postPayrollJournal(quietJournal.id, gaps.t.bankAccountId));
    expect(await runEntries(gaps, quiet.id)).toHaveLength(1);

    const pfRun = await makeRun(gaps.t.tenantId, '2041-02', [
      { employmentId: emp, division: 'software', gross: '10000.00', pfEe: '1800.00', pfEr: '550.00', eps: '1250.00' },
    ]);
    const pfJournal = await preparedJournal(gaps.t.tenantId, pfRun.id, '2041-02');
    const err = await expectReject(() =>
      asUser(gaps.t.finance, () => postPayrollJournal(pfJournal.id, gaps.t.bankAccountId)),
    );

    expect(err.status).toBe(422);
    expect(err.code).toBe('POSTING_ROLE_UNMAPPED');
    expect(await runEntries(gaps, pfRun.id)).toHaveLength(0);
    expect(
      await unscopedPrisma.transaction.count({ where: { tenantId: gaps.t.tenantId, payrollRunId: pfRun.id } }),
    ).toBe(0);
    expect((await unscopedPrisma.payrollJournal.findUniqueOrThrow({ where: { id: pfJournal.id } })).status).toBe(
      'Prepared',
    );
  });
});
