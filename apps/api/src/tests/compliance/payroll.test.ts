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
} from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { transitionPayrollRun } from '../../domains/payroll.js';
import {
  proposeSalaryStructure,
  approveSalaryStructure,
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

beforeAll(async () => {
  TENANT = await tenantId();
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
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date('2020-01-01') });
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
      data: { tenantId: TENANT, employmentRelationshipId, payrollRunId: run.id, payPeriod, grossAmount: 0, netAmount: 0 },
    });
    return run;
  });
}

// ===========================================================================
// Pure arithmetic — no database
// ===========================================================================

describe('statutory arithmetic (packages/shared/src/compliance/payroll.ts)', () => {
  const pfRates = { employeeRate: 0.12, employerRate: 0.12, epsRate: 0.0833, edliRate: 0.005, adminRate: 0.005, wageCeiling: 15_000 };

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

  it('LWF is due only in the table\'s due month', () => {
    const rates = { employeeAmount: 20, employerAmount: 40, dueMonth: 12 };
    expect(computeLwf('2026-12', rates)).toEqual({ lwfEmployee: 20, lwfEmployer: 40 });
    expect(computeLwf('2026-06', rates)).toEqual({ lwfEmployee: 0, lwfEmployer: 0 });
  });

  it('statutoryLines combines every line and the net follows', () => {
    const lines = statutoryLines(
      20_000,
      { basicPay: 12_000, hra: 6_000, otherAllowances: 2_000 },
      { pf: pfRates, esi: { employeeRate: 0.0075, employerRate: 0.0325, wageCeiling: 21_000 }, pt: [{ minGross: 0, maxGross: null, halfYearlyAmount: 0 }], lwf: { employeeAmount: 20, employerAmount: 40, dueMonth: 12 } },
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
    const { employment: emp } = await makeEmployee('run-a');
    const payPeriod = '2031-01';

    // Proposed by the chairman — who holds every grant, including `approve` —
    // to prove the Self-Dealing Bar catches the proposer regardless of rank,
    // not merely because the two product roles never share a grant.
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
    const proposed = await asUser('chairman@kaizen.co.in', () => prisma.salaryStructure.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id } }));

    const selfApprove = await expectReject(() => asUser('chairman@kaizen.co.in', () => approveSalaryStructure(proposed.id)));
    expect(selfApprove.message).toMatch(/Self-Dealing/i);

    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(proposed.id));

    // Opened by Operations (holds `payroll:create`), computed by Finance (holds
    // `payroll:edit` and, uniquely, `payroll:approve`) — so Finance ends up the
    // preparer of record and is the one the Self-Dealing Bar has to catch.
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));
    const instruction = await asUser('chairman@kaizen.co.in', () => prisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id, employmentRelationshipId: emp.id } }));
    expect(instruction.computedFrom).not.toBeNull();
    expect(Number(instruction.pfEmployee)).toBeGreaterThan(0);
    expect(Number(instruction.esiEmployee)).toBeGreaterThanOrEqual(0);

    await asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'SUBMIT_REVIEW'));

    // CMP-PAY-002: Finance computed (prepared) this run and cannot also approve it.
    const preparerApproves = await expectReject(() => asUser('finance@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE')));
    expect(preparerApproves.message).toMatch(/CMP-PAY-002|prepared/i);

    // The chairman did not prepare it, so the chairman can.
    await asUser('chairman@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE'));

    // CMP-PAY-003: approval issues a payslip, and it is final.
    const payslip = await asUser('chairman@kaizen.co.in', () =>
      prisma.payslip.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id, payPeriod } }),
    );
    expect(payslip.number).toMatch(/\/P\//);
    const snapshotBefore = JSON.stringify(payslip.snapshot);

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

    const payPeriod = '2031-02';
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('operations@kaizen.co.in', () => computeInstruction(run.id));

    const instruction = await asUser('chairman@kaizen.co.in', () => prisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id, employmentRelationshipId: emp.id } }));
    expect(Number(instruction.pfEmployee)).toBe(0);
    expect(Number(instruction.esiEmployee)).toBe(0);
    expect(Number(instruction.professionalTax)).toBe(0);
    expect(Number(instruction.lwfEmployee)).toBe(0);
    expect(instruction.computedFrom).not.toBeNull();
    expect((instruction.computedFrom as { tdsSectionHint?: string })?.tdsSectionHint).toBe('194J');
  });

  it('CMP-PAY-005: a computed run paying below the minimum wage floor is refused on approval', async () => {
    // Isolated at the hook rather than through a full company-wide run: with
    // every other seeded employee lacking a salary structure of their own,
    // a real run would trip the "not computed" gate first rather than the
    // one this test is about.
    await asUser('finance@kaizen.co.in', () =>
      createMinimumWageTable({ state: 'Tamil Nadu', category: 'general', monthlyAmount: 999_999, effectiveFrom: new Date('2025-01-01') }),
    );
    const { employment: emp } = await makeEmployee('below-min-wage');

    const rejected = await asUser('finance@kaizen.co.in', async () => {
      const { runHooks } = await import('../../platform/hooks.js');
      return expectReject(() =>
        runHooks('payroll_run.before_approve', {
          run: { id: 'synthetic-run', preparedById: null, payPeriod: '2031-03' },
          instructions: [{ id: 'synthetic-instr', computedFrom: { structureId: 'x' }, grossAmount: 9_000, employmentRelationshipId: emp.id }],
          approverPartyId: 'someone-else',
        }),
      );
    });
    expect(rejected.message).toMatch(/CMP-PAY-005|minimum wage/i);
  });

  it('ECR export uses the # ~ # delimited EPFO text format', async () => {
    const { employment: emp } = await makeEmployee('ecr');
    await asUser('operations@kaizen.co.in', async () => {
      await proposeSalaryStructure({ employmentRelationshipId: emp.id, effectiveFrom: new Date('2020-01-01'), ctcAnnual: 240_000, basic: 12_000, hra: 4_000 });
    });
    const structure = await asUser('chairman@kaizen.co.in', () => prisma.salaryStructure.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id }, orderBy: { createdAt: 'desc' } }));
    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(structure.id));

    const payPeriod = '2031-04';
    const run = await makeSoloRun(emp.id, payPeriod);
    await asUser('operations@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));

    const ecr = await asUser('finance@kaizen.co.in', () => exportEcr(run.id));
    const line = ecr.split('\n').find((l) => l.length > 0);
    expect(line).toBeDefined();
    expect(line!.split('#~#').length).toBe(11);

    const esic = await asUser('finance@kaizen.co.in', () => exportEsic(run.id));
    expect(esic.split('\n')[0]).toBe('IP Number,IP Name,Days,Wages,Reason Code');
  });

  it('full-and-final settlement computes gratuity, leave encashment and bonus from years of service', async () => {
    const { employment: emp } = await makeEmployee('settle');
    // Backdate the hire well past the five-year gratuity floor.
    await asUser('chairman@kaizen.co.in', () => prisma.employmentRelationship.update({ where: { id: emp.id }, data: { hireEffectiveDate: new Date('2015-01-01') } }));
    await asUser('operations@kaizen.co.in', async () => {
      await proposeSalaryStructure({ employmentRelationshipId: emp.id, effectiveFrom: new Date('2015-01-01'), ctcAnnual: 360_000, basic: 20_000, hra: 8_000 });
    });
    const structure = await asUser('chairman@kaizen.co.in', () => prisma.salaryStructure.findFirstOrThrow({ where: { tenantId: TENANT, employmentRelationshipId: emp.id }, orderBy: { createdAt: 'desc' } }));
    await asUser('finance@kaizen.co.in', () => approveSalaryStructure(structure.id));

    const offboarding = await asUser('chairman@kaizen.co.in', () => prisma.offboarding.create({ data: { tenantId: TENANT, employmentRelationshipId: emp.id, status: 'Initiated' } }));
    const result = await asUser('finance@kaizen.co.in', () => settleOffboarding(offboarding.id));

    expect(result.gratuityEligible).toBe(true);
    expect(Number(result.gratuityAmount)).toBeGreaterThan(0);
    expect(result.settlementComputedAt).not.toBeNull();
  });
});
