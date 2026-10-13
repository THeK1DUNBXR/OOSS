/**
 * The `<name>Minor` paise siblings of the HCM money columns (MONEY-S8-HCM). The
 * characterisation file pins the rupee wire, unchanged; this file pins the paise
 * strings beside it, and that a viewer who cannot see a figure cannot see its
 * paise either. Pure helpers are tested without the database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../platform/wire.js';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { createAsset, listAssets, createTravelRequest, listTravelRequests } from '../../domains/hcm/assets.js';
import { createProgram, createBudget, listBudgets } from '../../domains/hcm/learning.js';
import { createCandidate, listCandidates, createReferral, listReferrals } from '../../domains/hcm/recruiting.js';
import {
  createPayGrade,
  listPayGrades,
  createRevisionCycle,
  addRevisionLine,
  listRevisionLines,
  proposeCycle,
  approveRevisionLine,
  createVariablePayPlan,
  computePayout,
  listVariablePayouts,
  createBenefitPlan,
  requestLoan,
  approveLoan,
  disburseLoan,
  recordLoanRepayment,
  listLoans,
  submitExpenseClaim,
  listExpenseClaims,
} from '../../domains/hcm/compensation.js';
import { grownByPercent, fractionOf, maskMoney } from '../../domains/money.js';

const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
let TENANT: string;
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function employmentFor(email: string) {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { personId: user.personId } });
}

async function freshEmployment(label: string) {
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
        fullName: `Money Minor ${label} ${s}`,
        primaryEmail: `money.minor.${label}.${s}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    await prisma.compensationRecord.create({
      data: {
        tenantId: TENANT,
        employmentRelationshipId: employment.id,
        revisionReason: 'hire',
        amount: 600_000,
        status: 'Effective',
        effectiveFrom: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    return employment;
  });
}

describe('HCM money paise siblings', () => {
  it('Asset.costMinor and TravelRequest paise: the paise string beside the rupee figure, both null for a viewer without the money verb', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createAsset({ tag: `MINOR-${stamp()}`, category: 'laptop', cost: 45000.5 }),
    );
    expect(wire(created).costMinor).toBe('4500050');
    const asChairman = wire(await asUser('chairman@kaizen.co.in', () => listAssets({})));
    expect(asChairman.find((r: any) => r.id === created.id).costMinor).toBe('4500050');
    const asOps = wire(await asUser('operations@kaizen.co.in', () => listAssets({})));
    expect(asOps.every((r: any) => r.cost === null && r.costMinor === null)).toBe(true);

    const employment = await employmentFor('ravi@kaizen.co.in');
    const request = await asUser('operations@kaizen.co.in', () =>
      createTravelRequest({
        employmentRelationshipId: employment.id,
        purpose: `Minor ${stamp()}`,
        fromLocation: 'Pune',
        toLocation: 'Chennai',
        startDate: new Date(Date.now() + 5 * 86_400_000),
        endDate: new Date(Date.now() + 7 * 86_400_000),
        mode: 'flight',
        estimatedCost: 12000.25,
        advanceRequested: 3000.5,
      }),
    );
    expect(wire(request).estimatedCostMinor).toBe('1200025');
    expect(wire(request).advanceRequestedMinor).toBe('300050');
    const chairmanTravel = wire(
      await asUser('chairman@kaizen.co.in', () => listTravelRequests({ employmentRelationshipId: employment.id })),
    );
    const row = chairmanTravel.find((r: any) => r.id === request.id);
    expect(row.estimatedCostMinor).toBe('1200025');
    expect(row.advanceRequestedMinor).toBe('300050');
    const opsTravel = wire(
      await asUser('operations@kaizen.co.in', () => listTravelRequests({ employmentRelationshipId: employment.id })),
    );
    const opsRow = opsTravel.find((r: any) => r.id === request.id);
    expect(opsRow.estimatedCostMinor).toBeNull();
    expect(opsRow.advanceRequestedMinor).toBeNull();
  });

  it('TrainingProgram and TrainingBudget paise', async () => {
    const program = await asUser('operations@kaizen.co.in', () =>
      createProgram({ title: `Minor program ${stamp()}`, kind: 'classroom', cost: 1500.5 }),
    );
    expect(wire(program).costMinor).toBe('150050');
    const fy = `FY${2100 + (Date.now() % 800)}-01`;
    const budget = await asUser('finance@kaizen.co.in', () => createBudget({ fy, amount: 250000.75 }));
    expect(wire(budget).amountMinor).toBe('25000075');
    const budgets = wire(await asUser('finance@kaizen.co.in', () => listBudgets(fy)));
    const row = budgets.find((b: any) => b.id === budget.id);
    expect(row.amountMinor).toBe('25000075');
    expect(row.spentMinor).toBe('0');
  });

  it('CandidateProfile, OfferLetter and Referral paise, masked with their figures', async () => {
    const s = stamp();
    const candidate = await asUser('operations@kaizen.co.in', () =>
      createCandidate({
        fullName: `Minor Candidate ${s}`,
        primaryEmail: `minor.candidate.${s}@example.com`,
        source: 'job_board',
        currentCtc: 1200000.5,
        expectedCtc: 1500000,
      }),
    );
    expect(wire(candidate).currentCtcMinor).toBe('120000050');
    expect(wire(candidate).expectedCtcMinor).toBe('150000000');
    const chairman = wire(await asUser('chairman@kaizen.co.in', () => listCandidates({})));
    const row = chairman.find((r: any) => r.id === candidate.id);
    expect(row.currentCtcMinor).toBe('120000050');
    expect(row.expectedCtcMinor).toBe('150000000');
    const ops = wire(await asUser('operations@kaizen.co.in', () => listCandidates({})));
    const opsRow = ops.find((r: any) => r.id === candidate.id);
    expect(opsRow.currentCtcMinor).toBeNull();
    expect(opsRow.expectedCtcMinor).toBeNull();

    const referrer = await employmentFor('hr@kaizen.co.in');
    const referral = await asUser('operations@kaizen.co.in', () =>
      createReferral({
        referrerEmploymentId: referrer.id,
        candidate: { fullName: `Minor Referred ${s}`, primaryEmail: `minor.referred.${s}@example.com` },
        bonusAmount: 15000.5,
      }),
    );
    expect(wire(referral).bonusAmountMinor).toBe('1500050');
    const chairmanReferrals = wire(await asUser('chairman@kaizen.co.in', () => listReferrals({})));
    expect(chairmanReferrals.find((r: any) => r.id === referral.id).bonusAmountMinor).toBe('1500050');
    const opsReferrals = wire(await asUser('operations@kaizen.co.in', () => listReferrals({})));
    const opsReferral = opsReferrals.find((r: any) => r.id === referral.id);
    expect(opsReferral.bonusAmount).toBeNull();
    expect(opsReferral.bonusAmountMinor).toBeNull();
  });

  it('PayGrade paise on every path', async () => {
    const grade = await asUser('operations@kaizen.co.in', () =>
      createPayGrade({
        code: `MINOR-${stamp()}`,
        level: 900 + (seq % 90),
        minPay: 400000.5,
        midPay: 600000,
        maxPay: 800000.25,
      }),
    );
    expect(wire(grade).minPayMinor).toBe('40000050');
    expect(wire(grade).midPayMinor).toBe('60000000');
    expect(wire(grade).maxPayMinor).toBe('80000025');
    const listed = wire(await asUser('operations@kaizen.co.in', () => listPayGrades()));
    const row = listed.find((g: any) => g.id === grade.id);
    expect(row.minPayMinor).toBe('40000050');
    expect(row.maxPayMinor).toBe('80000025');
  });

  it('SalaryRevisionLine paise: the proposal is exact, and hrOps sees neither the figure nor its paise', async () => {
    const employment = await freshEmployment('line');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Minor cycle ${stamp()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({
        cycleId: cycle.id,
        employmentRelationshipId: employment.id,
        currentCtc: 600000.5,
        proposedPct: 10,
      }),
    );
    expect(wire(line).currentCtcMinor).toBe('60000050');
    expect(wire(line).proposedCtcMinor).toBe('66000055');
    expect(wire(line).approvedCtcMinor).toBeNull();
    const approved = wire(await asUser('finance@kaizen.co.in', () => approveRevisionLine(line.id)));
    expect(approved.approvedCtcMinor).toBe('66000055');

    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    const finance = wire(await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id)));
    expect(finance[0].currentCtcMinor).toBe('60000050');
    expect(finance[0].proposedCtcMinor).toBe('66000055');
    const hrOps = wire(await asUser('operations@kaizen.co.in', () => listRevisionLines(cycle.id)));
    expect(hrOps[0].currentCtcMinor).toBeNull();
    expect(hrOps[0].proposedCtcMinor).toBeNull();
    expect(hrOps[0].approvedCtcMinor).toBeNull();
  });

  it('VariablePayout paise: the computed figure is rounded to the paisa and hrOps sees no paise', async () => {
    const employment = await freshEmployment('payout');
    const plan = await asUser('operations@kaizen.co.in', () =>
      createVariablePayPlan({
        name: `Minor plan ${stamp()}`,
        kind: 'bonus',
        period: 'annual',
        formula: { type: 'percentage_of_base', pct: 12.5 },
      }),
    );
    const payout = await asUser('operations@kaizen.co.in', () =>
      computePayout(plan.id, employment.id, `MINOR-${stamp()}`, 500000.5),
    );
    expect(wire(payout).computedAmountMinor).toBe('6250006');
    expect(wire(payout).approvedAmountMinor).toBeNull();
    const finance = wire(await asUser('finance@kaizen.co.in', () => listVariablePayouts(employment.id)));
    expect(finance[0].computedAmountMinor).toBe('6250006');
    const hrOps = wire(await asUser('operations@kaizen.co.in', () => listVariablePayouts(employment.id)));
    expect(hrOps[0].computedAmountMinor).toBeNull();
    expect(hrOps[0].approvedAmountMinor).toBeNull();
  });

  it('BenefitPlan paise', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createBenefitPlan({
        name: `Minor health ${stamp()}`,
        kind: 'health',
        employerContribution: 1500.5,
        employeeContribution: 500.25,
      }),
    );
    expect(wire(plan).employerContributionMinor).toBe('150050');
    expect(wire(plan).employeeContributionMinor).toBe('50025');
  });

  it('EmployeeLoan paise: principal, EMI and the balance after a repayment, with hrOps seeing none of them', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const loan = await asUser('ravi@kaizen.co.in', () =>
      requestLoan({ employmentRelationshipId: ravi.id, principal: 100000.5, interestPct: 12, tenureMonths: 12 }),
    );
    expect(wire(loan).principalMinor).toBe('10000050');
    expect(wire(loan).emiMinor).toBe('888492');
    expect(wire(loan).outstandingPrincipalMinor).toBe('10000050');
    await asUser('finance@kaizen.co.in', () => approveLoan(loan.id));
    await asUser('operations@kaizen.co.in', () => disburseLoan(loan.id, new Date()));
    const repaid = wire(await asUser('operations@kaizen.co.in', () => recordLoanRepayment(loan.id, 25000.25)));
    expect(repaid.outstandingPrincipalMinor).toBe('7500025');

    const finance = wire(await asUser('finance@kaizen.co.in', () => listLoans(ravi.id)));
    const row = finance.find((l: any) => l.id === loan.id);
    expect(row.principalMinor).toBe('10000050');
    expect(row.emiMinor).toBe('888492');
    expect(row.outstandingPrincipalMinor).toBe('7500025');
    const hrOps = wire(await asUser('operations@kaizen.co.in', () => listLoans(ravi.id)));
    const opsRow = hrOps.find((l: any) => l.id === loan.id);
    expect(opsRow.principalMinor).toBeNull();
    expect(opsRow.emiMinor).toBeNull();
    expect(opsRow.outstandingPrincipalMinor).toBeNull();
  });

  it('ExpenseClaim paise', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const claim = await asUser('ravi@kaizen.co.in', () =>
      submitExpenseClaim({ employmentRelationshipId: ravi.id, category: 'travel', amount: 1234.56 }),
    );
    expect(wire(claim).amountMinor).toBe('123456');
    const own = wire(await asUser('ravi@kaizen.co.in', () => listExpenseClaims(ravi.id)));
    expect(own.find((c: any) => c.id === claim.id).amountMinor).toBe('123456');
    const hrOps = wire(await asUser('operations@kaizen.co.in', () => listExpenseClaims(ravi.id)));
    expect(hrOps.find((c: any) => c.id === claim.id).amountMinor).toBeNull();
  });
});

describe('the paise helpers', () => {
  it('grownByPercent adds the percentage in exact paise, rounding a half paisa up in magnitude', () => {
    expect(grownByPercent(60000050n, 10)).toBe(66000055n);
    // 250090 at +0.25% is 250715.225: the tie rounds up to 250715.23, not down.
    expect(grownByPercent(25009000n, 0.25)).toBe(25071523n);
    expect(grownByPercent(25009000n, 0)).toBe(25009000n);
  });

  it('fractionOf reads a number as the decimal a person typed', () => {
    expect(fractionOf(0.25)).toEqual({ num: 25n, den: 100n });
    expect(fractionOf(12.5)).toEqual({ num: 125n, den: 10n });
    expect(fractionOf(1e21)).toEqual({ num: 1000000000000000000000n, den: 1n });
  });

  it('maskMoney nulls a field and its paise sibling together, and passes the row through for a viewer who can see it', () => {
    const row = { cost: '45000.5', costMinor: '4500050', name: 'x' };
    expect(maskMoney(row, true, ['cost'])).toBe(row);
    expect(maskMoney(row, false, ['cost'])).toEqual({ cost: null, costMinor: null, name: 'x' });
  });
});
