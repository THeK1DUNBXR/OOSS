/**
 * Characterisation of the payroll money columns as they reach the wire today
 * (ORDERED-PLAN 1.6, MONEY-S9). Every figure is read through a domain output,
 * an export, or a payslip snapshot, and pinned with an inline snapshot taken on
 * the Decimal columns. The same assertions must pass, unchanged, on the BigInt
 * `*Minor` columns: the rupee fields keep their type (a JSON string where the
 * raw Decimal used to print one, a JSON number where `num()` did), and the
 * statutory arithmetic keeps its rounding.
 *
 * Only the fields named below are picked out of each row, so the `*Minor`
 * siblings the conversion adds do not change the pinned shape.
 */

import { rupeesToMinor } from '../../platform/wire.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bigintReplacer, minorToDecimal } from '../../platform/wire.js';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { approvePayrollRules } from '../hcm/payrollLedgerFixture.js';
import { getEmployment, hire, transitionEmployment, transitionOffboarding } from '../../domains/employment.js';
import { getOffboardingForEmployment } from '../../domains/hcm/separations.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  proposeSalaryStructure,
  approveSalaryStructure,
  listPayslips,
  exportEcr,
  exportEsic,
  settleOffboarding,
  setEngagementType,
  setBankDetails,
  computeInstruction,
  createMinimumWageTable,
} from '../../domains/compliance/payroll.js';
import { transitionPayrollRun, getPayrollRun } from '../../domains/payroll.js';
import {
  createAdHocPayLine,
  approveAdHocPayLine,
  listAdHocPayLines,
  createArrear,
  approveArrear,
  listArrears,
  createPayItem,
  generatePayrollJournal,
  getPayrollJournal,
  generateBankAdvice,
  getBankAdvice,
  downloadBankAdvice,
  listBankAdvices,
} from '../../domains/hcm/payrollops.js';
import {
  overtimeAccruals,
  runWeeklyHoursCheck,
  encashLeave,
  createWorkingHoursRule,
} from '../../domains/compliance/labour.js';
import { accrueEntitlement, createLeaveType } from '../../domains/leave.js';
import { runGratuityAccrual } from '../../jobs/compliance/payroll.js';
import { asSystem } from '../../platform/context.js';

/**
 * What `res.json` sends: a Prisma Decimal becomes its JSON string, a BigInt its
 * digits. Generated ids and the timestamp each fixture name carries are dropped
 * or stripped, so a snapshot pins the figures and nothing else.
 */
const FIXTURE_NAME = /Payroll Money ([a-z-]+) \d+-\d+/g;
const GENERATED_KEYS = new Set([
  'id',
  'structureId',
  'pfTableId',
  'esiTableId',
  'ptTableId',
  'lwfTableId',
  'instructionId',
  'employmentRelationshipId',
  'payrollRunId',
  'payslipNumber',
  'payslipIssuedAt',
  'issuedAt',
  'number',
  'createdAt',
  'computedAt',
  'preparedById',
  'supersededById',
  'payPeriodId',
]);
const wire = <T>(value: T): any =>
  JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (GENERATED_KEYS.has(key)) return undefined;
      if (typeof v === 'string') return v.replace(FIXTURE_NAME, '$1').replace(PERIOD_YEAR, 'YYYY-$1');
      return bigintReplacer(key, v);
    }),
  );
/** Plain text output (ECR, ESIC, bank advice CSV) with the fixture names stripped the same way. */
const text = (s: string) =>
  s.replace(FIXTURE_NAME, '$1').replace(PERIOD_YEAR, 'YYYY-$1').replace(PAYMENT_REF, 'PRN-REF');
/** Rows in the order a file is built, with the header (if any) kept first. The database gives no row order. */
const rowsSorted = (s: string, headerLines = 0) => {
  const lines = text(s).split('\n');
  return [...lines.slice(0, headerLines), ...lines.slice(headerLines).sort()].join('\n');
};
/**
 * A pay period's year is chosen at run time (see RUN_YEAR), and the runs move past 2099 once the other
 * payroll suite has run here, so any year from 2000 to 2999 is masked. Its month is the fixed fact.
 */
const PERIOD_YEAR = /\b2\d{3}-(\d\d)\b/g;
/** A bank advice's reference: the run's record code and a random suffix. */
const PAYMENT_REF = /PRN-\d{4}-\d+\/[a-z0-9]+/g;

/** Source prefix on the test-local gratuity factor rows, so the file removes only its own. */
const FIXTURE_SOURCE = 'fixture: S10';
let TENANT: string;
let RUN_YEAR = 2070;
/** The first day of this file's zero minimum wage floor, removed after the file. */
let FLOOR_FROM: Date;
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;
// Each run takes a pay period no earlier run in this tenant has used (a run is
// unique on (tenantId, payPeriod)), so the file can run twice on one database.
const period = (month: string) => `${RUN_YEAR}-${month}`;

beforeAll(async () => {
  TENANT = await tenantId();
  // computeInstruction reads the approved statutory rules, not the rate tables (S10).
  await approvePayrollRules(TENANT, 'chairman@kaizen.co.in');
  // No upper bound: payroll.test.ts runs its periods in 2100 and later on this same database, and a
  // year below its runs would collide with them (payrollRun is unique on tenant and pay period).
  const latest = await unscopedPrisma.payrollRun.findFirst({
    where: { tenantId: TENANT, payPeriod: { gte: '2070-01' } },
    orderBy: { payPeriod: 'desc' },
    select: { payPeriod: true },
  });
  if (latest) RUN_YEAR = parseInt(latest.payPeriod.slice(0, 4), 10) + 1;
  // A zero minimum wage floor for this file's own pay months, so the CMP-PAY-005 check cannot refuse its
  // approvals. The latest floor on or before a pay month wins, and payroll.test.ts's CMP-PAY-005 test
  // files 9,99,999 for its months, which would refuse this file's approval if it is still in the table.
  FLOOR_FROM = new Date(`${period('01')}-01T00:00:00Z`);
  await unscopedPrisma.minimumWageTable.deleteMany({
    where: { tenantId: TENANT, state: 'Tamil Nadu', category: 'general', effectiveFrom: FLOOR_FROM },
  });
  await asUser('finance@kaizen.co.in', () =>
    createMinimumWageTable({ state: 'Tamil Nadu', category: 'general', monthlyAmount: 0, effectiveFrom: FLOOR_FROM }),
  );
  await unscopedPrisma.statutoryRule.deleteMany({
    where: { tenantId: TENANT, source: { startsWith: FIXTURE_SOURCE } },
  });
  // The accrual now reads the factor from a rule (S10). These two rows are test-local:
  // 14/26 is a fixture so the 2024 test can tell which row was read, and 15/26 is the
  // cited figure, which the 2026 pins read. APPROVED rows may not overlap, so 14/26 ends
  // where 15/26 begins.
  const factorRow = {
    tenantId: TENANT,
    domain: 'gratuity',
    key: 'gratuity.factor',
    jurisdiction: 'IN',
    approvedBy: 'fixture:checker',
    approvedAt: new Date(),
    createdBy: 'fixture:maker',
    status: 'APPROVED',
  } as const;
  await unscopedPrisma.statutoryRule.create({
    data: {
      ...factorRow,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-01-01T00:00:00.000Z'),
      value: { daysPerYear: '14', daysPerMonth: '26' },
      source: `${FIXTURE_SOURCE} test-local, deliberately not the Act's figure`,
    } as never,
  });
  await unscopedPrisma.statutoryRule.create({
    data: {
      ...factorRow,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: null,
      value: { daysPerYear: '15', daysPerMonth: '26' },
      source: `${FIXTURE_SOURCE} test-local, the cited 15/26 (Payment of Gratuity Act 1972 s.4(2))`,
    } as never,
  });
});

afterAll(async () => {
  await unscopedPrisma.statutoryRule.deleteMany({
    where: { tenantId: TENANT, source: { startsWith: FIXTURE_SOURCE } },
  });
  // Only when beforeAll set the floor: an undefined date would match every Tamil Nadu floor in the tenant.
  if (FLOOR_FROM) {
    await unscopedPrisma.minimumWageTable.deleteMany({
      where: { tenantId: TENANT, state: 'Tamil Nadu', category: 'general', effectiveFrom: FLOOR_FROM },
    });
  }
});

async function makeEmployee(label: string, hireDate = '2020-01-01') {
  const s = stamp();
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
        fullName: `Payroll Money ${label} ${s}`,
        primaryEmail: `payroll.money.${label}.${s}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({
      personId: person.id,
      positionId: position.id,
      hireEffectiveDate: new Date(hireDate),
    });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** A salary structure proposed by Operations and approved by Finance (the Self-Dealing Bar keeps them apart). */
async function structureFor(
  employmentId: string,
  fields: { basic: number; hra: number; specialAllowance?: number; conveyance?: number },
  effectiveFrom = '2020-01-01',
) {
  const gross = fields.basic + fields.hra + (fields.specialAllowance ?? 0) + (fields.conveyance ?? 0);
  await asUser('operations@kaizen.co.in', () =>
    proposeSalaryStructure({
      employmentRelationshipId: employmentId,
      effectiveFrom: new Date(effectiveFrom),
      ctcAnnual: gross * 12,
      ...fields,
    }),
  );
  const row = await asUser('chairman@kaizen.co.in', () =>
    prisma.salaryStructure.findFirstOrThrow({
      where: { tenantId: TENANT, employmentRelationshipId: employmentId },
      orderBy: { createdAt: 'desc' },
    }),
  );
  await asUser('finance@kaizen.co.in', () => approveSalaryStructure(row.id));
}

/** The compensation record overtime and leave encashment read basic pay from (labour.ts basicPayFor). */
async function compensationFor(
  employmentId: string,
  basic: number,
  effectiveFrom = new Date(Date.now() - 30 * 86_400_000),
) {
  await asUser('chairman@kaizen.co.in', () =>
    prisma.compensationRecord.create({
      data: {
        tenantId: TENANT,
        employmentRelationshipId: employmentId,
        revisionReason: 'initial',
        amountMinor: rupeesToMinor(basic),
        basicPayMinor: rupeesToMinor(basic),
        status: 'Effective',
        effectiveFrom,
      },
    }),
  );
}

/** One run holding exactly the given employments: a pay period, one instruction each. */
async function runFor(payPeriod: string, employmentIds: string[]) {
  return asUser('chairman@kaizen.co.in', async () => {
    const run = await prisma.payrollRun.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('PRN'), payPeriod },
    });
    for (const employmentRelationshipId of employmentIds) {
      await prisma.payrollInstruction.create({
        data: {
          tenantId: TENANT,
          employmentRelationshipId,
          payrollRunId: run.id,
          payPeriod,
          grossAmountMinor: 0n,
          netAmountMinor: 0n,
        },
      });
    }
    return run;
  });
}

/** The instruction fields a payslip, ECR, ESIC or bank advice is built from, as the run returns them. */
const INSTRUCTION_KEYS = [
  'grossAmount',
  'deductions',
  'netAmount',
  'basicPay',
  'hra',
  'otherAllowances',
  'pfEmployee',
  'pfEmployer',
  'epsEmployer',
  'esiEmployee',
  'esiEmployer',
  'professionalTax',
  'tdsAmount',
  'lwfEmployee',
  'lwfEmployer',
  'computedFrom',
] as const;

function instructionsOf(run: { instructions: Array<Record<string, unknown>> }) {
  return run.instructions
    .map((i) => ({
      employee: (i.employmentRelationship as { person: { fullName: string } }).person.fullName,
      ...pick(i, INSTRUCTION_KEYS),
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee));
}

/**
 * The rule ids a computed instruction records in computedFrom (FX-73) are random per database, so the
 * snapshot leaves them out. The batch test checks them against the APPROVED rules in force instead.
 */
function withoutRuleIds(row: Record<string, unknown>) {
  const {
    pfRuleId: _pf,
    esiRuleId: _esi,
    ptRuleId: _pt,
    lwfRuleId: _lwf,
    ...computedFrom
  } = (row.computedFrom ?? {}) as Record<string, unknown>;
  return { ...row, computedFrom };
}

function pick(row: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k] ?? null;
  return wire(out);
}

describe('payroll money: the statutory run, exports, payslips, journal and bank advice', () => {
  it('a batch run: compute, approve, then every output built from it', async () => {
    const period06 = period('06');
    // A: the PF ceiling (basic above 15,000) and a Professional Tax slab.
    const a = await makeEmployee('ceiling');
    await structureFor(a.employment.id, { basic: 15_000, hra: 6_000, specialAllowance: 4_000 });
    // B: exactly at the ESI threshold (gross 21,000 is still eligible).
    const b = await makeEmployee('esi-threshold');
    await structureFor(b.employment.id, { basic: 12_000, hra: 6_000, specialAllowance: 3_000 });
    // C: paise that do not divide cleanly (PF on 10,001.01 is 1,200.1212).
    const c = await makeEmployee('paise');
    await structureFor(c.employment.id, {
      basic: 10_001.01,
      hra: 3_333.33,
      specialAllowance: 1_111.11,
      conveyance: 0.07,
    });

    for (const [who, bank] of [
      [a, '111100001111'],
      [b, '222200002222'],
      [c, '333300003333'],
    ] as const) {
      await asUser('chairman@kaizen.co.in', () =>
        setBankDetails(who.employment.id, {
          bankAccountNumber: bank,
          bankIfsc: 'SBIN0000001',
          bankAccountName: who.person.fullName,
        }),
      );
    }

    const run = await runFor(period06, [a.employment.id, b.employment.id, c.employment.id]);
    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));
    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'SUBMIT_REVIEW'));
    await asUser('chairman@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE'));

    const view = await asUser('chairman@kaizen.co.in', () => getPayrollRun(run.id));
    // Each instruction names the APPROVED rule it was computed from, the one in force for the pay month
    // (the open-ended row, since this file's months are after every bounded history row).
    const ruleIdOf = async (key: string) =>
      (
        await unscopedPrisma.statutoryRule.findFirstOrThrow({
          where: { tenantId: TENANT, key, status: 'APPROVED', effectiveTo: null },
        })
      ).id;
    const expectedRuleIds = {
      pfRuleId: await ruleIdOf('pf.rates'),
      esiRuleId: await ruleIdOf('esi.rates'),
      ptRuleId: await ruleIdOf('pt.tn_slabs'),
      lwfRuleId: await ruleIdOf('lwf.tn_contribution'),
    };
    for (const i of instructionsOf(view as never)) expect(i.computedFrom).toMatchObject(expectedRuleIds);
    expect(
      wire({
        status: view.status,
        grossTotal: wire(view.grossTotal),
        netTotal: wire(view.netTotal),
        instructions: instructionsOf(view as never).map(withoutRuleIds),
      }),
    ).toMatchInlineSnapshot(`
      {
        "grossTotal": "60445.52",
        "instructions": [
          {
            "basicPay": "15000",
            "computedFrom": {},
            "deductions": "1822.5",
            "employee": "ceiling",
            "epsEmployer": "1249.5",
            "esiEmployee": "0",
            "esiEmployer": "0",
            "grossAmount": "25000",
            "hra": "6000",
            "lwfEmployee": "0",
            "lwfEmployer": "0",
            "netAmount": "23177.5",
            "otherAllowances": "4000",
            "pfEmployee": "1800",
            "pfEmployer": "550.5",
            "professionalTax": "22.5",
            "tdsAmount": "0",
          },
          {
            "basicPay": "12000",
            "computedFrom": {},
            "deductions": "1597.5",
            "employee": "esi-threshold",
            "epsEmployer": "999.6",
            "esiEmployee": "157.5",
            "esiEmployer": "682.5",
            "grossAmount": "21000",
            "hra": "6000",
            "lwfEmployee": "0",
            "lwfEmployer": "0",
            "netAmount": "19402.5",
            "otherAllowances": "3000",
            "pfEmployee": "1440",
            "pfEmployer": "440.4",
            "professionalTax": "0",
            "tdsAmount": "0",
          },
          {
            "basicPay": "10001.01",
            "computedFrom": {},
            "deductions": "1308.46",
            "employee": "paise",
            "epsEmployer": "833.08",
            "esiEmployee": "108.34",
            "esiEmployer": "469.48",
            "grossAmount": "14445.52",
            "hra": "3333.33",
            "lwfEmployee": "0",
            "lwfEmployer": "0",
            "netAmount": "13137.06",
            "otherAllowances": "1111.18",
            "pfEmployee": "1200.12",
            "pfEmployer": "367.04",
            "professionalTax": "0",
            "tdsAmount": "0",
          },
        ],
        "netTotal": "55717.06",
        "status": "Approved",
      }
    `);

    const ecr = await asUser('chairman@kaizen.co.in', () => exportEcr(run.id));
    expect(rowsSorted(ecr)).toMatchInlineSnapshot(`
      "#~#ceiling#~#25000#~#15000#~#15000#~#15000#~#1800#~#1249.5#~#550.5#~#0#~#0
      #~#esi-threshold#~#21000#~#12000#~#12000#~#12000#~#1440#~#999.6#~#440.4#~#0#~#0
      #~#paise#~#14445.52#~#10001.01#~#10001.01#~#10001.01#~#1200.12#~#833.08#~#367.04#~#0#~#0"
    `);
    const esic = await asUser('chairman@kaizen.co.in', () => exportEsic(run.id));
    expect(rowsSorted(esic, 1)).toMatchInlineSnapshot(`
      "IP Number,IP Name,Days,Wages,Reason Code
      ,esi-threshold,26,21000,
      ,paise,26,14445.52,"
    `);

    const payslips = await asUser('chairman@kaizen.co.in', () => listPayslips({ payPeriod: period06 }));
    expect(
      wire(
        payslips
          .map((p) => ({ employee: p.employmentFullName, snapshot: p.snapshot }))
          .sort((x, y) => String(x.employee).localeCompare(String(y.employee))),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "employee": "ceiling",
          "snapshot": {
            "bankLast4": "1111",
            "deductions": {
              "esi": 0,
              "lwf": 0,
              "pf": 1800,
              "professionalTax": 22.5,
              "tds": 0,
              "total": 1822.5,
            },
            "earnings": {
              "basic": 15000,
              "gross": 25000,
              "hra": 6000,
              "otherAllowances": 4000,
            },
            "employee": {
              "designation": "Education Counsellor",
              "esicNumber": null,
              "name": "ceiling",
              "uan": null,
            },
            "employer": {
              "address": "No. 12, Second Floor, Gandhi Road, Tambaram, Chennai, 600045",
              "esiEmployerCode": null,
              "name": "Kaizen Infinities Private Limited",
              "pfEstablishmentCode": null,
            },
            "net": 23177.5,
            "payPeriod": "YYYY-06",
          },
        },
        {
          "employee": "esi-threshold",
          "snapshot": {
            "bankLast4": "2222",
            "deductions": {
              "esi": 157.5,
              "lwf": 0,
              "pf": 1440,
              "professionalTax": 0,
              "tds": 0,
              "total": 1597.5,
            },
            "earnings": {
              "basic": 12000,
              "gross": 21000,
              "hra": 6000,
              "otherAllowances": 3000,
            },
            "employee": {
              "designation": "Education Counsellor",
              "esicNumber": null,
              "name": "esi-threshold",
              "uan": null,
            },
            "employer": {
              "address": "No. 12, Second Floor, Gandhi Road, Tambaram, Chennai, 600045",
              "esiEmployerCode": null,
              "name": "Kaizen Infinities Private Limited",
              "pfEstablishmentCode": null,
            },
            "net": 19402.5,
            "payPeriod": "YYYY-06",
          },
        },
        {
          "employee": "paise",
          "snapshot": {
            "bankLast4": "3333",
            "deductions": {
              "esi": 108.34,
              "lwf": 0,
              "pf": 1200.12,
              "professionalTax": 0,
              "tds": 0,
              "total": 1308.46,
            },
            "earnings": {
              "basic": 10001.01,
              "gross": 14445.52,
              "hra": 3333.33,
              "otherAllowances": 1111.18,
            },
            "employee": {
              "designation": "Education Counsellor",
              "esicNumber": null,
              "name": "paise",
              "uan": null,
            },
            "employer": {
              "address": "No. 12, Second Floor, Gandhi Road, Tambaram, Chennai, 600045",
              "esiEmployerCode": null,
              "name": "Kaizen Infinities Private Limited",
              "pfEstablishmentCode": null,
            },
            "net": 13137.06,
            "payPeriod": "YYYY-06",
          },
        },
      ]
    `);

    const journal = await asUser('chairman@kaizen.co.in', () => generatePayrollJournal(run.id));
    const journalView = await asUser('chairman@kaizen.co.in', () => getPayrollJournal(journal.id));
    expect(wire({ totalDebit: journalView.totalDebit, totalCredit: journalView.totalCredit, lines: journalView.lines }))
      .toMatchInlineSnapshot(`
      {
        "lines": [
          {
            "costCentre": "shared",
            "credit": 0,
            "debit": 60445.52,
            "label": "Salaries & wages — shared",
            "ledgerAccountCode": "6010-SALARIES",
          },
          {
            "costCentre": "shared",
            "credit": 55717.06,
            "debit": 0,
            "label": "Net pay payable — shared",
            "ledgerAccountCode": "2410-SALARIES-PAYABLE",
          },
          {
            "costCentre": "shared",
            "credit": 4728.46,
            "debit": 0,
            "label": "Statutory & other deductions payable — shared",
            "ledgerAccountCode": "2420-STATUTORY-DEDUCTIONS-PAYABLE",
          },
        ],
        "totalCredit": 60445.52,
        "totalDebit": 60445.52,
      }
    `);

    const advice = await asUser('chairman@kaizen.co.in', () => generateBankAdvice(run.id));
    const adviceView = await asUser('chairman@kaizen.co.in', () => getBankAdvice(advice.id));
    expect(wire({ total: adviceView.total, count: adviceView.count })).toMatchInlineSnapshot(`
      {
        "count": 3,
        "total": 55717.06,
      }
    `);
    const csv = await asUser('chairman@kaizen.co.in', () => downloadBankAdvice(advice.id));
    expect(rowsSorted(csv.csv, 1)).toMatchInlineSnapshot(`
      "Beneficiary Name,Account Number,IFSC,Amount,Reference

      ceiling,111100001111,SBIN0000001,23177.5,PRN-REF
      esi-threshold,222200002222,SBIN0000001,19402.5,PRN-REF
      paise,333300003333,SBIN0000001,13137.06,PRN-REF
      "
    `);
    expect(
      wire(
        (await asUser('chairman@kaizen.co.in', () => listBankAdvices()))
          .filter((r) => r.payPeriod === period06)
          .map((r) => ({ total: r.total, count: r.count })),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "count": 3,
          "total": 55717.06,
        },
      ]
    `);
  });

  it('a contractor computes no PF, ESI, PT or LWF, and the run carries the 194J hint', async () => {
    const { employment } = await makeEmployee('contractor');
    await asUser('operations@kaizen.co.in', () => setEngagementType(employment.id, 'contractor'));
    // A contractor's fee is on file, so a run opened over this employee (the HR run
    // of the same database) carries a gross at or above the wage floor, and this
    // employee does not refuse that run's approval (CMP-PAY-005 reads computed rows).
    await compensationFor(employment.id, 20_000, new Date('2020-01-01'));
    const run = await runFor(period('02'), [employment.id]);
    await asUser('operations@kaizen.co.in', () => computeInstruction(run.id));
    const view = await asUser('chairman@kaizen.co.in', () => getPayrollRun(run.id));
    expect(wire(instructionsOf(view as never))).toMatchInlineSnapshot(`
      [
        {
          "basicPay": "0",
          "computedFrom": {
            "engagementType": "contractor",
            "tdsSectionHint": "194J",
          },
          "deductions": "0",
          "employee": "contractor",
          "epsEmployer": "0",
          "esiEmployee": "0",
          "esiEmployer": "0",
          "grossAmount": "0",
          "hra": "0",
          "lwfEmployee": "0",
          "lwfEmployer": "0",
          "netAmount": "0",
          "otherAllowances": "0",
          "pfEmployee": "0",
          "pfEmployer": "0",
          "professionalTax": "0",
          "tdsAmount": "0",
        },
      ]
    `);
  });

  it('full-and-final: gratuity, leave encashment, bonus and notice recovery', async () => {
    const { employment } = await makeEmployee('settle', '2015-01-01');
    await structureFor(employment.id, { basic: 20_000, hra: 8_000 }, '2015-01-01');
    const offboarding = await asUser('chairman@kaizen.co.in', () =>
      prisma.offboarding.create({
        data: { tenantId: TENANT, employmentRelationshipId: employment.id, status: 'Initiated' },
      }),
    );
    const result = await asUser('finance@kaizen.co.in', () => settleOffboarding(offboarding.id));
    expect(
      wire({
        gratuityAmount: result.gratuityAmount,
        leaveEncashmentAmount: result.leaveEncashmentAmount,
        bonusAmount: result.bonusAmount,
        noticeRecoveryAmount: result.noticeRecoveryAmount,
        settlementAmount: result.settlementAmount,
        gratuityYears: result.gratuityYears,
        gratuityEligible: result.gratuityEligible,
        encashDays: result.encashDays,
      }),
    ).toMatchInlineSnapshot(`
      {
        "bonusAmount": "583.1",
        "encashDays": 0,
        "gratuityAmount": "138461.54",
        "gratuityEligible": true,
        "gratuityYears": 12,
        "leaveEncashmentAmount": "0",
        "noticeRecoveryAmount": "0",
        "settlementAmount": "139044.64",
      }
    `);
  });

  it('gratuity accrual: 15/26 of basic a year, rounded to paise each month', async () => {
    const { employment } = await makeEmployee('accrual');
    await structureFor(employment.id, { basic: 20_000, hra: 8_000 });
    await asSystem(TENANT, () => runGratuityAccrual(), 'characterisation');
    const accrued = await unscopedPrisma.gratuityAccrual.findMany({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
      select: { accruedMinor: true },
    });
    expect(wire(accrued.map((r) => minorToDecimal(r.accruedMinor)))).toMatchInlineSnapshot(`
      [
        "961.54",
      ]
    `);
  });

  it('gratuity accrual reads the factor row in force on the run date: 15 June 2024 is the 14/26 fixture row', async () => {
    const { employment } = await makeEmployee('factor-2024');
    await structureFor(employment.id, { basic: 20_000, hra: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2024-06-15T06:00:00.000Z'));
    try {
      await asSystem(TENANT, () => runGratuityAccrual(), 'characterisation');
    } finally {
      vi.useRealTimers();
    }
    const accrued = await unscopedPrisma.gratuityAccrual.findMany({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
      select: { accruedMinor: true },
    });
    // 2000000 paise x 14 / (26 x 12) = 89743.59 paise, so 89744 paise.
    expect(wire(accrued.map((r) => minorToDecimal(r.accruedMinor)))).toEqual(['897.44']);
  });

  it('a basic of 20,007 rupees accrues 961.88: the exact 961.875 rounds half up (the old float formula gave 961.87)', async () => {
    const { employment } = await makeEmployee('tie');
    await structureFor(employment.id, { basic: 20_007, hra: 0 });
    await asSystem(TENANT, () => runGratuityAccrual(), 'characterisation');
    const accrued = await unscopedPrisma.gratuityAccrual.findMany({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
      select: { accruedMinor: true },
    });
    // 2000700 paise x 15 / 312 = 96187.5 paise exactly. The float (15/26) was a hair under the
    // tie and rounded down, which is the defect this pins.
    expect(wire(accrued.map((r) => minorToDecimal(r.accruedMinor)))).toEqual(['961.88']);
  });

  it('a date with no approved factor row refuses the accrual: the reason is recorded and nothing is written', async () => {
    const { employment } = await makeEmployee('no-rule-2019');
    await structureFor(employment.id, { basic: 20_000, hra: 0 }, '2018-01-01');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2019-06-15T06:00:00.000Z'));
    let result;
    try {
      result = await asSystem(TENANT, () => runGratuityAccrual(), 'characterisation');
    } finally {
      vi.useRealTimers();
    }
    expect(result.errors.join(' | ')).toMatch(
      /No APPROVED statutory rule for gratuity\.factor in IN covers 2019-06-15/,
    );
    const accrued = await unscopedPrisma.gratuityAccrual.findMany({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
    });
    expect(accrued).toHaveLength(0);
  });

  it('overtime: basic over 208 has more than two decimals, the rate is stored in paise and the amount is not recomputed from it', async () => {
    const { employment } = await makeEmployee('overtime');
    await structureFor(employment.id, { basic: 20_000, hra: 0 });
    await compensationFor(employment.id, 20_000);
    await asUser('operations@kaizen.co.in', async () => {
      await createWorkingHoursRule({
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        dailyCapHours: 8,
        weeklyCapHours: 48,
        spreadOverHours: 12,
        otMultiplier: 2,
        otCapPerQuarterHours: 50,
      });
      const anchor = new Date(Date.now() - 7 * 86_400_000);
      const { isoWeekLabel, isoWeekRange } = await import('@kaizen/shared');
      const { start } = isoWeekRange(isoWeekLabel(anchor));
      for (let i = 0; i < 6; i += 1) {
        await prisma.workAttendance.create({
          data: {
            tenantId: TENANT,
            employmentRelationshipId: employment.id,
            workDate: new Date(start.getTime() + i * 86_400_000),
            workedMinutes: 10 * 60,
            overtimeMinutes: 60,
          },
        });
      }
      await runWeeklyHoursCheck();
    });
    const accruals = await asUser('operations@kaizen.co.in', () => overtimeAccruals(employment.id));
    expect(accruals.map((r) => ({ hours: wire(r.hours), rate: wire(r.rate), amount: wire(r.amount) })))
      .toMatchInlineSnapshot(`
      [
        {
          "amount": "1153.85",
          "hours": "6",
          "rate": "192.31",
        },
      ]
    `);
  });

  it('leave encashment at basic over 26 for the days encashed', async () => {
    const { employment } = await makeEmployee('encash');
    await structureFor(employment.id, { basic: 26_001, hra: 0 });
    await compensationFor(employment.id, 26_001);
    await asUser('operations@kaizen.co.in', async () => {
      const leaveType = await createLeaveType({
        code: `S9EN${stamp()}`,
        name: 'S9 encashable',
        annualEntitlementDays: 15,
      });
      await prisma.leaveType.update({ where: { id: leaveType.id }, data: { encashable: true, maxEncashDays: 10 } });
      await accrueEntitlement({ employmentRelationshipId: employment.id, leaveTypeId: leaveType.id, days: 15 });
      const { encashment } = await encashLeave(employment.id, { leaveTypeId: leaveType.id, days: 3 });
      expect(wire({ days: encashment.days, amount: encashment.amount })).toMatchInlineSnapshot(`
        {
          "amount": "3000.12",
          "days": "3",
        }
      `);
    });
  });

  it('ad hoc pay lines and arrears: amounts as the list returns them after approval', async () => {
    const { employment } = await makeEmployee('adhoc');
    const code = `S9-${stamp()}`;
    const item = await asUser('chairman@kaizen.co.in', () =>
      createPayItem({ code, name: `S9 earning ${code}`, kind: 'earning', glAccountCode: '5000' }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      createAdHocPayLine({
        employmentRelationshipId: employment.id,
        payItemId: item.id,
        payPeriod: period('08'),
        amount: 1234.5,
        reason: 'characterisation',
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveAdHocPayLine(line.id));
    const arrear = await asUser('operations@kaizen.co.in', () =>
      createArrear({
        employmentRelationshipId: employment.id,
        fromPeriod: period('01'),
        amount: 4321.25,
        reason: 'characterisation',
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveArrear(arrear.id));
    const adhoc = await asUser('finance@kaizen.co.in', () =>
      listAdHocPayLines({ employmentRelationshipId: employment.id }),
    );
    const arrears = await asUser('finance@kaizen.co.in', () =>
      listArrears({ employmentRelationshipId: employment.id }),
    );
    expect(
      wire({
        adhoc: adhoc.map((r) => ({ status: r.status, amount: r.amount })),
        arrears: arrears.map((r) => ({ status: r.status, amount: r.amount })),
      }),
    ).toMatchInlineSnapshot(`
      {
        "adhoc": [
          {
            "amount": 1234.5,
            "status": "Approved",
          },
        ],
        "arrears": [
          {
            "amount": 4321.25,
            "status": "Approved",
          },
        ],
      }
    `);
  });

  // Each of these returned a raw Offboarding before the paise conversion. Once the
  // columns became `<name>Minor`, the rupee fields a screen reads were gone from
  // these responses unless the row went through withDecimalMinor.
  it('an offboarding keeps its rupee fields on the employee record, the exit view and the transition', async () => {
    const { employment } = await makeEmployee('offwire', '2015-01-01');
    await structureFor(employment.id, { basic: 20_000, hra: 8_000 }, '2015-01-01');
    const offboarding = await asUser('chairman@kaizen.co.in', () =>
      prisma.offboarding.create({
        data: { tenantId: TENANT, employmentRelationshipId: employment.id, status: 'Initiated' },
      }),
    );
    await asUser('finance@kaizen.co.in', () => settleOffboarding(offboarding.id));

    const expected = {
      settlementAmount: '139044.64',
      settlementAmountMinor: '13904464',
      gratuityAmount: '138461.54',
      gratuityAmountMinor: '13846154',
    };
    const employee = wire(await asUser('chairman@kaizen.co.in', () => getEmployment(employment.id)));
    expect(employee.offboarding).toMatchObject(expected);
    const exitView = wire(await asUser('chairman@kaizen.co.in', () => getOffboardingForEmployment(employment.id)));
    expect(exitView).toMatchObject(expected);
    const moved = wire(
      await asUser('chairman@kaizen.co.in', () => transitionOffboarding(offboarding.id, 'START_NOTICE')),
    );
    expect(moved).toMatchObject({ ...expected, status: 'NoticePeriodActive' });
  });
});
