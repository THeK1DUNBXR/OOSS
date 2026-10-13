/**
 * Compliance — payroll statutory (docs/plan/compliance.md, workstream E).
 *
 * The pure arithmetic is checked with no database; the run lifecycle,
 * self-dealing bar, contractor exclusion, minimum-wage floor and payslip
 * issuance are checked against a real one, the same way `hr.test.ts` checks
 * the rest of the employment machine.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  computePf,
  computeEsi,
  computePt,
  computeLwf,
  esiEligible,
  gratuity,
  bonus,
  statutoryLines,
  type PtSlab,
  ENCRYPTED_FIELD_PREFIX,
  decimalToMinor,
} from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { approvePayrollRules } from '../hcm/payrollLedgerFixture.js';
import {
  hire,
  transitionEmployment,
  updateEmployeeProfile,
  proposeCompensation,
  transitionCompensation,
} from '../../domains/employment.js';
import { transitionPayrollRun } from '../../domains/payroll.js';
import { minorToRupees } from '../../domains/money.js';
import {
  proposeSalaryStructure,
  approveSalaryStructure,
  listSalaryStructures,
  computeInstruction,
  listPayslips,
  exportEcr,
  exportEsic,
  settleOffboarding,
  setEngagementType,
  createMinimumWageTable,
} from '../../domains/compliance/payroll.js';
import { nextRecordCode } from '../../platform/recordCode.js';

let TENANT: string;
let fixtureSeq = 0;
// The runs below need pay periods no earlier run in this tenant has used: a
// payroll run is unique on (tenantId, payPeriod). Fixed 2031 periods made the
// file pass once per database and then collide, and CI's failing-test-first
// gate runs it twice on one database (old code, then head). Each run takes
// the year after the latest one already on file; the month stays fixed
// because PT and LWF depend on it.
let RUN_YEAR = 2100;
const period = (month: string) => `${RUN_YEAR}-${month}`;

beforeAll(async () => {
  TENANT = await tenantId();
  // computeInstruction reads the approved statutory rules, not the rate tables (S10).
  await approvePayrollRules(TENANT, 'chairman@kaizen.co.in');
  const latest = await unscopedPrisma.payrollRun.findFirst({
    where: { tenantId: TENANT, payPeriod: { gte: '2100-01' } },
    orderBy: { payPeriod: 'desc' },
    select: { payPeriod: true },
  });
  if (latest) RUN_YEAR = parseInt(latest.payPeriod.slice(0, 4), 10) + 1;
});

/** A throwaway employee, hired by Operations. Mirrors hr.test.ts's makeEmployee. */
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
        fullName: `Payroll Fixture ${label} ${stamp}`,
        primaryEmail: `payroll.fixture.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({
      personId: person.id,
      positionId: position.id,
      hireEffectiveDate: new Date('2020-01-01'),
    });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person, position };
  });
}

/**
 * A run scoped to exactly one employment, rather than `openPayrollRun`'s
 * company-wide pull — which would also draw in every other seeded employee,
 * most with no salary structure of their own, and trip the "not computed"
 * gate on somebody this test never meant to be about.
 */
async function makeSoloRun(employmentRelationshipId: string, payPeriod: string) {
  return asUser('chairman@kaizen.co.in', async () => {
    const recordCode = await nextRecordCode('PRN');
    const run = await prisma.payrollRun.create({ data: { tenantId: TENANT, recordCode, payPeriod } });
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
    return run;
  });
}

// ===========================================================================
// Pure arithmetic — no database
// ===========================================================================

describe('statutory arithmetic (packages/shared/src/compliance/payroll.ts)', () => {
  const pfRates = {
    employeeRate: 0.12,
    employerRate: 0.12,
    epsRate: 0.0833,
    edliRate: 0.005,
    adminRate: 0.005,
    wageCeiling: 15_000,
  };

  it('CMP-PAY-001: PF splits 12% employee and 12% employer (EPS + remainder) from the dated table, capped at the wage ceiling', () => {
    const result = computePf(20_000, pfRates); // above the ceiling
    expect(result.pfWage).toBe(15_000);
    expect(result.pfEmployee).toBe(1_800); // 12% of the capped wage
    expect(result.epsEmployer).toBeCloseTo(1249.5, 2); // 8.33% of 15,000
    expect(result.pfEmployer + result.epsEmployer).toBeCloseTo(1_800, 2); // employer's 12% in total
  });

  it('PF at or below the ceiling uses the actual wage, not the ceiling', () => {
    const result = computePf(10_000, pfRates);
    expect(result.pfWage).toBe(10_000);
    expect(result.pfEmployee).toBe(1_200);
  });

  it('ESI applies only at or below the wage ceiling', () => {
    const rates = { employeeRate: 0.0075, employerRate: 0.0325, wageCeiling: 21_000 };
    expect(esiEligible(21_000, rates)).toBe(true);
    expect(esiEligible(21_001, rates)).toBe(false);
    const result = computeEsi(20_000, rates, true);
    expect(result.esiEmployee).toBe(150);
    expect(result.esiEmployer).toBe(650);
    expect(computeEsi(30_000, rates, false).esiEmployee).toBe(0);
  });

  it('Professional Tax reads the applicable half-yearly slab and deducts one sixth of it monthly', () => {
    const slabs: PtSlab[] = [
      { minGross: 0, maxGross: 21_000, halfYearlyAmount: 0 },
      { minGross: 21_001, maxGross: 30_000, halfYearlyAmount: 135 },
    ];
    expect(computePt(25_000, slabs)).toBeCloseTo(22.5, 2);
    expect(computePt(10_000, slabs)).toBe(0);
  });

  it("LWF is due only in the table's due month", () => {
    const rates = { employeeAmount: 20, employerAmount: 40, dueMonth: 12 };
    expect(computeLwf('2026-12', rates)).toEqual({ lwfEmployee: 20, lwfEmployer: 40 });
    expect(computeLwf('2026-06', rates)).toEqual({ lwfEmployee: 0, lwfEmployer: 0 });
  });

  it('statutoryLines combines every line and the net follows', () => {
    const lines = statutoryLines(
      20_000,
      { basicPay: 12_000, hra: 6_000, otherAllowances: 2_000 },
      {
        pf: pfRates,
        esi: { employeeRate: 0.0075, employerRate: 0.0325, wageCeiling: 21_000 },
        pt: [{ minGross: 0, maxGross: null, halfYearlyAmount: 0 }],
        lwf: { employeeAmount: 20, employerAmount: 40, dueMonth: 12 },
      },
      { payPeriod: '2026-06' },
    );
    expect(lines.netAmount).toBe(20_000 - lines.totalDeductions);
    expect(lines.totalDeductions).toBeGreaterThan(0);
  });

  it('gratuity: 15/26 of last-drawn wage per year, eligible only at 5+ years unless the exception applies', () => {
    expect(gratuity(26_000, 53).eligible).toBe(false); // 4 years 5 months, no exception
    const eligible = gratuity(26_000, 61); // 5 years 1 month -> 5 years
    expect(eligible.eligible).toBe(true);
    expect(eligible.years).toBe(5);
    expect(eligible.amount).toBeCloseTo((15 / 26) * 26_000 * 5, 2);
    expect(gratuity(26_000, 30, true).eligible).toBe(true); // death/disablement exception
    expect(gratuity(26_000, 67).years).toBe(6); // 5y7m rounds up past 6 months
  });

  it('bonus: 8.33% of basic capped at ₹7,000, only when basic is at or below ₹21,000', () => {
    expect(bonus(25_000, false).eligible).toBe(false);
    const result = bonus(21_000, true);
    expect(result.eligible).toBe(true);
    expect(result.amount).toBeCloseTo(7_000 * 0.0833, 2); // capped at 7,000
    expect(bonus(5_000, true).amount).toBeCloseTo(5_000 * 0.0833, 2);
  });
});

// ===========================================================================
// The run: compute, the Self-Dealing Bar, contractor exclusion, minimum wage
// ===========================================================================

describe('payroll runs against the dated tables (real database)', () => {
  it('CMP-PAY-001 / CMP-PAY-002 / CMP-PAY-003: a full run — compute, self-approval refused, a different approver succeeds, a payslip is issued and final', async () => {
    const { employment: emp, person } = await makeEmployee('run-a');
    const payPeriod = period('01');
    // The floor this run is approved against, stated here rather than
    // inherited. CMP-PAY-005 below files a ₹9,99,999 floor, and the latest row
    // on or before the period wins, so on a database where that test already
    // ran this approval was refused for a floor it never set. 12,000 is the
    // seeded Tamil Nadu figure.
    await asUser('finance@kaizen.co.in', () =>
      createMinimumWageTable({
        state: 'Tamil Nadu',
        category: 'general',
        monthlyAmount: 12_000,
        effectiveFrom: new Date(`${payPeriod}-01T00:00:00Z`),
      }),
    );

    // Proposed by the chairman, who holds every grant, including `approve`. Finance then approves
    // it, a different approver from the proposer. Owner ruling 2026-10-12: the founder is exempt
    // from the Self-Dealing Bar; non-founders are covered in founderApprovals.test.ts.
    await asUser('chairman@kaizen.co.in', async () => {
      await proposeSalaryStructure({
        employmentRelationshipId: emp.id,
        effectiveFrom: new Date('2020-01-01'),
        ctcAnnual: 300_000,
        basic: 15_000,
        hra: 6_000,
        specialAllowance: 4_000,
      });
    });
    const proposed = await asUser('chairman@kaizen.co.in', () =>
      prisma.salaryStructure.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id } }),
    );

    // Owner ruling 2026-10-12: the founder is exempt from the Self-Dealing Bar; the non-founder
    // self-approval refusal is proved in founderApprovals.test.ts. Here the chairman proposes and
    // approves a structure for a second employee, and the waiver is audited.
    const { employment: founderEmp } = await makeEmployee('run-a-founder');
    await asUser('chairman@kaizen.co.in', () =>
      proposeSalaryStructure({
        employmentRelationshipId: founderEmp.id,
        effectiveFrom: new Date('2020-01-01'),
        ctcAnnual: 300_000,
        basic: 15_000,
        hra: 6_000,
        specialAllowance: 4_000,
      }),
    );
    const founderProposed = await asUser('chairman@kaizen.co.in', () =>
      prisma.salaryStructure.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: founderEmp.id } }),
    );
    const founderApproved = await asUser('chairman@kaizen.co.in', () => approveSalaryStructure(founderProposed.id));
    expect(founderApproved.status).toBe('Approved');
    const founderAudit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { subjectType: 'salary_structure', subjectId: founderProposed.id, action: 'update' },
      orderBy: { seq: 'desc' },
    });
    expect((founderAudit.meta as Record<string, unknown>).founderOverride).toEqual(['author_is_approver']);

    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(proposed.id));

    // The list carries the employee's name, not just the employment cuid.
    const structures = await asUser('finance@kaizen.co.in', () => listSalaryStructures(emp.id));
    expect(structures.find((s) => s.id === proposed.id)?.employmentFullName).toBe(person.fullName);

    // Opened by Operations (holds `payroll:create`), computed by Finance (holds
    // `payroll:edit` and, uniquely, `payroll:approve`) — so Finance ends up the
    // preparer of record and is the one the Self-Dealing Bar has to catch.
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));
    const instruction = await asUser('chairman@kaizen.co.in', () =>
      prisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id, employmentRelationshipId: emp.id } }),
    );
    expect(instruction.computedFrom).not.toBeNull();
    expect(minorToRupees(instruction.pfEmployeeMinor)).toBeGreaterThan(0);
    expect(minorToRupees(instruction.esiEmployeeMinor)).toBeGreaterThanOrEqual(0);

    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'SUBMIT_REVIEW'));

    // CMP-PAY-002: Finance computed (prepared) this run and cannot also approve it.
    const preparerApproves = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE')),
    );
    expect(preparerApproves.message).toMatch(/CMP-PAY-002|prepared/i);

    // The chairman did not prepare it, so the chairman can.
    await asUser('chairman@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE'));

    // CMP-PAY-003: approval issues a payslip, and it is final.
    const payslip = await asUser('chairman@kaizen.co.in', () =>
      prisma.payslip.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id, payPeriod } }),
    );
    expect(payslip.number).toMatch(/\/P\//);
    const snapshotBefore = JSON.stringify(payslip.snapshot);

    // Listing payslips names the employee too.
    const payslipList = await asUser('chairman@kaizen.co.in', () => listPayslips({ employmentRelationshipId: emp.id }));
    expect(payslipList.find((p) => p.id === payslip.id)?.employmentFullName).toBe(person.fullName);

    // The only lawful correction is a new payslip referencing the old — never
    // an edit. Simulated here as the domain would do it: a second row whose
    // `supersededById` points back, with the original untouched.
    const reread = await asUser('chairman@kaizen.co.in', async () => {
      const correction = await prisma.payslip.create({
        data: {
          tenantId: TENANT,
          instructionId: payslip.instructionId,
          employmentRelationshipId: payslip.employmentRelationshipId,
          payPeriod: payslip.payPeriod,
          number: `${payslip.number}-CORR`,
          snapshot: payslip.snapshot as object,
          supersededById: null,
        },
      });
      await prisma.payslip.update({ where: { id: payslip.id }, data: { supersededById: correction.id } });
      return { row: await prisma.payslip.findFirstOrThrow({ where: { id: payslip.id } }), correctionId: correction.id };
    });
    expect(JSON.stringify(reread.row.snapshot)).toBe(snapshotBefore); // the original snapshot never changed
    expect(reread.row.supersededById).toBe(reread.correctionId);

    // The employee sees their own payslip and nobody else's.
    const own = await asUser('employee@kaizen.co.in', () => listPayslips());
    expect(own.every((p) => p.employmentRelationshipId !== emp.id)).toBe(true); // the fixture employee, not the test account
  });

  it('CMP-PAY-004: a contractor computes no PF/ESI/PT/LWF, and carries a 194J hint instead', async () => {
    const { employment: emp } = await makeEmployee('contractor');
    await asUser('operations@kaizen.co.in', () => setEngagementType(emp.id, 'contractor'));

    // A contractor carries a fee like anyone else. Left with none, the company-wide
    // run that hr.test opens for the same database picks them up at zero, and
    // CMP-PAY-005 refuses that run's approval. The fee is the Tamil Nadu floor in
    // force today, read from the seed row, so it is never below the floor.
    const floor = await unscopedPrisma.minimumWageTable.findFirstOrThrow({
      where: { tenantId: TENANT, state: 'Tamil Nadu', category: 'general', effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const fee = await asUser('hr@kaizen.co.in', () =>
      proposeCompensation({
        employmentRelationshipId: emp.id,
        revisionReason: 'annual_cycle',
        amount: minorToRupees(decimalToMinor(floor.monthlyAmount)),
        effectiveFrom: new Date('2020-01-01'),
      }),
    );
    await asUser('hr@kaizen.co.in', () => transitionCompensation(fee.id, 'SUBMIT'));
    await asUser('arun@kaizen.co.in', () => transitionCompensation(fee.id, 'APPROVE'));
    // Approved is not yet in force: payroll reads only Effective pay, so the fee
    // is scheduled and activated here.
    await asUser('hr@kaizen.co.in', () => transitionCompensation(fee.id, 'SCHEDULE'));
    await asUser('hr@kaizen.co.in', () => transitionCompensation(fee.id, 'ACTIVATE'));

    const payPeriod = period('02');
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('operations@kaizen.co.in', () => computeInstruction(run.id));

    const instruction = await asUser('chairman@kaizen.co.in', () =>
      prisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id, employmentRelationshipId: emp.id } }),
    );
    expect(minorToRupees(instruction.pfEmployeeMinor)).toBe(0);
    expect(minorToRupees(instruction.esiEmployeeMinor)).toBe(0);
    expect(minorToRupees(instruction.professionalTaxMinor)).toBe(0);
    expect(minorToRupees(instruction.lwfEmployeeMinor)).toBe(0);
    expect(instruction.computedFrom).not.toBeNull();
    expect((instruction.computedFrom as { tdsSectionHint?: string })?.tdsSectionHint).toBe('194J');
  });

  it('CMP-PAY-005: a computed run paying below the minimum wage floor is refused on approval', async () => {
    // Isolated at the hook rather than through a full company-wide run: with
    // every other seeded employee lacking a salary structure of their own,
    // a real run would trip the "not computed" gate first rather than the
    // one this test is about.
    await asUser('finance@kaizen.co.in', () =>
      createMinimumWageTable({
        state: 'Tamil Nadu',
        category: 'general',
        monthlyAmount: 999_999,
        effectiveFrom: new Date(`${period('03')}-01T00:00:00Z`),
      }),
    );
    const { employment: emp } = await makeEmployee('below-min-wage');

    const rejected = await asUser('finance@kaizen.co.in', async () => {
      const { runHooks } = await import('../../platform/hooks.js');
      return expectReject(() =>
        runHooks('payroll_run.before_approve', {
          run: { id: 'synthetic-run', preparedById: null, payPeriod: period('03') },
          instructions: [
            {
              id: 'synthetic-instr',
              computedFrom: { structureId: 'x' },
              grossAmountMinor: 900_000n,
              employmentRelationshipId: emp.id,
            },
          ],
          approverPartyId: 'someone-else',
        }),
      );
    });
    expect(rejected.message).toMatch(/CMP-PAY-005|minimum wage/i);
  });

  it('ECR export uses the # ~ # delimited EPFO text format', async () => {
    const { employment: emp } = await makeEmployee('ecr');
    await asUser('operations@kaizen.co.in', async () => {
      await proposeSalaryStructure({
        employmentRelationshipId: emp.id,
        effectiveFrom: new Date('2020-01-01'),
        ctcAnnual: 240_000,
        basic: 12_000,
        hra: 4_000,
      });
    });
    const structure = await asUser('chairman@kaizen.co.in', () =>
      prisma.salaryStructure.findFirstOrThrow({
        where: { tenantId: TENANT, employmentRelationshipId: emp.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(structure.id));

    const payPeriod = period('04');
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('operations@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));

    const ecr = await asUser('finance@kaizen.co.in', () => exportEcr(run.id));
    const line = ecr.split('\n').find((l) => l.length > 0);
    expect(line).toBeDefined();
    expect(line!.split('#~#').length).toBe(11);

    const esic = await asUser('finance@kaizen.co.in', () => exportEsic(run.id));
    expect(esic.split('\n')[0]).toBe('IP Number,IP Name,Days,Wages,Reason Code');
  });

  it('UAN and ESIC number are encrypted on the way in, and the ECR and ESIC files still carry them in the clear (FX-64)', async () => {
    const { employment: emp } = await makeEmployee('uan-esic');
    const uan = '100200300400';
    const esic = '3100000000000002';
    await asUser('chairman@kaizen.co.in', () => updateEmployeeProfile(emp.id, { uanNumber: uan, esicNumber: esic }));

    const raw = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { id: emp.id } });
    expect(raw.uanNumber?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(raw.esicNumber?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);

    await asUser('operations@kaizen.co.in', () =>
      proposeSalaryStructure({
        employmentRelationshipId: emp.id,
        effectiveFrom: new Date('2020-01-01'),
        ctcAnnual: 240_000,
        basic: 12_000,
        hra: 4_000,
      }),
    );
    const structure = await asUser('chairman@kaizen.co.in', () =>
      prisma.salaryStructure.findFirstOrThrow({
        where: { tenantId: TENANT, employmentRelationshipId: emp.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(structure.id));
    const run = await makeSoloRun(emp.id, period('05'));
    await asUser('operations@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));

    const ecr = await asUser('finance@kaizen.co.in', () => exportEcr(run.id));
    expect(
      ecr
        .split('\n')
        .find((l) => l.length > 0)!
        .split('#~#')[0],
    ).toBe(uan);

    const esicFile = await asUser('finance@kaizen.co.in', () => exportEsic(run.id));
    expect(esicFile.split('\n').some((l) => l.startsWith(`${esic},`))).toBe(true);
  });

  it('full-and-final settlement computes gratuity, leave encashment and bonus from years of service', async () => {
    const { employment: emp } = await makeEmployee('settle');
    // Backdate the hire well past the five-year gratuity floor.
    await asUser('chairman@kaizen.co.in', () =>
      prisma.employmentRelationship.update({
        where: { id: emp.id },
        data: { hireEffectiveDate: new Date('2015-01-01') },
      }),
    );
    await asUser('operations@kaizen.co.in', async () => {
      await proposeSalaryStructure({
        employmentRelationshipId: emp.id,
        effectiveFrom: new Date('2015-01-01'),
        ctcAnnual: 360_000,
        basic: 20_000,
        hra: 8_000,
      });
    });
    const structure = await asUser('chairman@kaizen.co.in', () =>
      prisma.salaryStructure.findFirstOrThrow({
        where: { tenantId: TENANT, employmentRelationshipId: emp.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(structure.id));

    const offboarding = await asUser('chairman@kaizen.co.in', () =>
      prisma.offboarding.create({ data: { tenantId: TENANT, employmentRelationshipId: emp.id, status: 'Initiated' } }),
    );
    const result = await asUser('finance@kaizen.co.in', () => settleOffboarding(offboarding.id));

    expect(result.gratuityEligible).toBe(true);
    expect(Number(result.gratuityAmount)).toBeGreaterThan(0);
    expect(result.settlementComputedAt).not.toBeNull();
  });
});
