/**
 * Characterisation of the HCM money columns as they reach the wire today
 * (ORDERED-PLAN 1.6, MONEY-S8-HCM). Pins the TYPE and VALUE of each money field
 * on the paths that read or write Asset.cost, TravelRequest.estimatedCost and
 * advanceRequested, TrainingProgram.cost, TrainingBudget.amount,
 * CandidateProfile.currentCtc and expectedCtc, OfferLetter.ctc,
 * Referral.bonusAmount, PayGrade min/mid/max, SalaryRevisionLine currentCtc,
 * proposedCtc and approvedCtc, VariablePayout computedAmount and approvedAmount,
 * BenefitPlan employer and employee contributions, EmployeeLoan principal, emi
 * and outstandingPrincipal, and ExpenseClaim.amount.
 *
 * These assertions must pass on the Decimal and Number columns and, unchanged,
 * on the BigInt `*Minor` columns. Amounts carry real paise (x.25, x.5, x.75) and
 * the sums are exact in binary floating point, so the float arithmetic on the
 * old path and the paise arithmetic on the new one agree figure for figure.
 * The `*Minor` siblings are asserted in moneyColumns.minor.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../platform/wire.js';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import {
  createRequisition,
  transitionRequisition,
  transitionApplication,
  createApplication,
} from '../../domains/hiring.js';
import { createAsset, listAssets, createTravelRequest, listTravelRequests } from '../../domains/hcm/assets.js';
import {
  createProgram,
  listPrograms,
  createBudget,
  listBudgets,
  createSession,
  listSessions,
  nominate,
  listEnrollments,
} from '../../domains/hcm/learning.js';
import {
  createCandidate,
  listCandidates,
  createOffer,
  listOffers,
  createReferral,
  listReferrals,
} from '../../domains/hcm/recruiting.js';
import {
  createPayGrade,
  listPayGrades,
  compaRatioFor,
  createRevisionCycle,
  addRevisionLine,
  listRevisionLines,
  getRevisionCycle,
  proposeCycle,
  approveRevisionLine,
  approveCycle,
  applyCycle,
  myRevisionLines,
  createVariablePayPlan,
  computePayout,
  approvePayout,
  markPayoutPaid,
  listVariablePayouts,
  createBenefitPlan,
  listBenefitPlans,
  scheduleFor,
  requestLoan,
  approveLoan,
  disburseLoan,
  recordLoanRepayment,
  listLoans,
  submitExpenseClaim,
  approveExpenseClaim,
  reimburseExpenseClaim,
  listExpenseClaims,
} from '../../domains/hcm/compensation.js';

/** What `res.json` sends: Prisma Decimals become their JSON string, BigInt its digits. */
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

/** A throwaway employee, hired and activated, with a Compensation record at 600000 for the compa-ratio. */
async function makeEmployee(label: string) {
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
        fullName: `Money Characterisation ${label} ${s}`,
        primaryEmail: `money.characterisation.${label}.${s}@example.com`,
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

describe('HCM money columns: wire characterisation (pre-conversion)', () => {
  it('Asset.cost: a viewer with the financial verb sees a two-place Decimal string; hrOps sees null', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createAsset({ tag: `CHAR-${stamp()}`, category: 'laptop', cost: 45000.5 }),
    );
    expect(wire(created).cost).toBe('45000.5');

    const opsCreated = await asUser('operations@kaizen.co.in', () =>
      createAsset({ tag: `CHAR-${stamp()}`, category: 'laptop', cost: 45000.5 }),
    );
    expect(wire(opsCreated).cost).toBeNull();

    const asOps = wire(await asUser('operations@kaizen.co.in', () => listAssets({})));
    expect(asOps.every((row: any) => row.cost === null)).toBe(true);

    const asChairman = wire(await asUser('chairman@kaizen.co.in', () => listAssets({})));
    const row = asChairman.find((r: any) => r.id === created.id);
    expect(row.cost).toBe('45000.5');
  });

  it('TrainingProgram.cost on the session and enrolment includes: a Decimal string on every viewer, as the catalogue has always shown it', async () => {
    const program = await asUser('operations@kaizen.co.in', () =>
      createProgram({ title: `Char include ${stamp()}`, kind: 'classroom', cost: 1500.5 }),
    );
    const session = await asUser('operations@kaizen.co.in', () =>
      createSession({
        programId: program.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 4 * 3_600_000),
        seats: 10,
      }),
    );
    const sessions = wire(await asUser('operations@kaizen.co.in', () => listSessions(program.id)));
    expect(sessions.find((s: any) => s.id === session.id).program.cost).toBe('1500.5');

    const ravi = await employmentFor('ravi@kaizen.co.in');
    await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: ravi.id }),
    );
    const enrolments = wire(await asUser('operations@kaizen.co.in', () => listEnrollments({ sessionId: session.id })));
    expect(enrolments[0].session.program.cost).toBe('1500.5');
  });

  it('TravelRequest.estimatedCost and advanceRequested: Decimal strings to finance, null to a viewer without the money verb', async () => {
    const employment = await employmentFor('ravi@kaizen.co.in');
    const request = await asUser('operations@kaizen.co.in', () =>
      createTravelRequest({
        employmentRelationshipId: employment.id,
        purpose: `Characterisation ${stamp()}`,
        fromLocation: 'Pune',
        toLocation: 'Chennai',
        startDate: new Date(Date.now() + 5 * 86_400_000),
        endDate: new Date(Date.now() + 7 * 86_400_000),
        mode: 'flight',
        estimatedCost: 12000.25,
        advanceRequested: 3000.5,
      }),
    );
    expect(wire(request).estimatedCost).toBe('12000.25');
    expect(wire(request).advanceRequested).toBe('3000.5');

    const asChairman = wire(
      await asUser('chairman@kaizen.co.in', () => listTravelRequests({ employmentRelationshipId: employment.id })),
    );
    const row = asChairman.find((r: any) => r.id === request.id);
    expect(row.estimatedCost).toBe('12000.25');
    expect(row.advanceRequested).toBe('3000.5');

    const asOps = wire(
      await asUser('operations@kaizen.co.in', () => listTravelRequests({ employmentRelationshipId: employment.id })),
    );
    const opsRow = asOps.find((r: any) => r.id === request.id);
    expect(opsRow.estimatedCost).toBeNull();
    expect(opsRow.advanceRequested).toBeNull();
  });

  it('TrainingProgram.cost and TrainingBudget.amount: Decimal strings; utilisation of an FY with no completed spend is zero', async () => {
    const program = await asUser('operations@kaizen.co.in', () =>
      createProgram({ title: `Characterisation ${stamp()}`, kind: 'classroom', cost: 1500.5 }),
    );
    expect(wire(program).cost).toBe('1500.5');
    const listed = wire(await asUser('operations@kaizen.co.in', () => listPrograms()));
    expect(listed.find((p: any) => p.id === program.id).cost).toBe('1500.5');

    const fy = `FY${2100 + (Date.now() % 800)}-01`;
    const budget = await asUser('finance@kaizen.co.in', () => createBudget({ fy, amount: 250000.75 }));
    expect(wire(budget).amount).toBe('250000.75');
    const budgets = wire(await asUser('finance@kaizen.co.in', () => listBudgets(fy)));
    const row = budgets.find((b: any) => b.id === budget.id);
    expect(row.amount).toBe('250000.75');
    expect(row.spent).toBe(0);
    expect(row.utilisationPercent).toBe(0);
  });

  it('CandidateProfile.currentCtc and expectedCtc: Decimal strings to recruiting finance, null to hrOps', async () => {
    const s = stamp();
    const candidate = await asUser('operations@kaizen.co.in', () =>
      createCandidate({
        fullName: `Money Candidate ${s}`,
        primaryEmail: `money.candidate.${s}@example.com`,
        source: 'job_board',
        currentCtc: 1200000.5,
        expectedCtc: 1500000,
      }),
    );
    expect(wire(candidate).currentCtc).toBeNull();
    expect(wire(candidate).expectedCtc).toBeNull();

    const asChairman = wire(await asUser('chairman@kaizen.co.in', () => listCandidates({})));
    const row = asChairman.find((r: any) => r.id === candidate.id);
    expect(row.currentCtc).toBe('1200000.5');
    expect(row.expectedCtc).toBe('1500000');

    const asOps = wire(await asUser('operations@kaizen.co.in', () => listCandidates({})));
    const opsRow = asOps.find((r: any) => r.id === candidate.id);
    expect(opsRow.currentCtc).toBeNull();
    expect(opsRow.expectedCtc).toBeNull();
  });

  it('OfferLetter.ctc and Referral.bonusAmount: Decimal strings to finance, null to a viewer without the money verb', async () => {
    const requisition = await asUser('operations@kaizen.co.in', async () => {
      const position = await prisma.position.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('POS'),
          jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          status: 'Open',
        },
      });
      const r = await createRequisition({ positionId: position.id });
      await transitionRequisition(r.id, 'SUBMIT');
      await transitionRequisition(r.id, 'APPROVE');
      return transitionRequisition(r.id, 'PUBLISH');
    });
    const s = stamp();
    const application = await asUser('operations@kaizen.co.in', async () => {
      const candidate = await createCandidate({
        fullName: `Offer Candidate ${s}`,
        primaryEmail: `offer.candidate.${s}@example.com`,
        source: 'job_board',
      });
      const app = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.person.id });
      await transitionApplication(app.id, 'ADVANCE');
      await transitionApplication(app.id, 'ADVANCE');
      return transitionApplication(app.id, 'ADVANCE');
    });
    const offer = await asUser('operations@kaizen.co.in', () =>
      createOffer({
        applicationId: application.id,
        ctc: 1200000.25,
        joiningDate: new Date(Date.now() + 30 * 86_400_000),
        validUntil: new Date(Date.now() + 14 * 86_400_000),
      }),
    );
    expect(wire(offer).ctc).toBeNull();
    const asChairman = wire(await asUser('chairman@kaizen.co.in', () => listOffers({})));
    expect(asChairman.find((o: any) => o.id === offer.id).ctc).toBe('1200000.25');

    const referrer = await employmentFor('hr@kaizen.co.in');
    const referral = await asUser('operations@kaizen.co.in', () =>
      createReferral({
        referrerEmploymentId: referrer.id,
        candidate: { fullName: `Referred ${s}`, primaryEmail: `referred.${s}@example.com` },
        bonusAmount: 15000.5,
      }),
    );
    expect(wire(referral).bonusAmount).toBeNull();
    const referralsAsChairman = wire(await asUser('chairman@kaizen.co.in', () => listReferrals({})));
    expect(referralsAsChairman.find((r: any) => r.id === referral.id).bonusAmount).toBe('15000.5');
    const referralsAsOps = wire(await asUser('operations@kaizen.co.in', () => listReferrals({})));
    expect(referralsAsOps.find((r: any) => r.id === referral.id).bonusAmount).toBeNull();
  });

  it('PayGrade min, mid and max: Decimal strings on every path; compa-ratio is computed from the same figures', async () => {
    const code = `CHAR-${stamp()}`;
    const level = 800 + (seq % 90);
    const grade = await asUser('operations@kaizen.co.in', () =>
      createPayGrade({ code, level, minPay: 400000.5, midPay: 600000, maxPay: 800000.25 }),
    );
    expect(wire(grade).minPay).toBe('400000.5');
    expect(wire(grade).midPay).toBe('600000');
    expect(wire(grade).maxPay).toBe('800000.25');

    const listed = wire(await asUser('operations@kaizen.co.in', () => listPayGrades()));
    const row = listed.find((g: any) => g.id === grade.id);
    expect(row.minPay).toBe('400000.5');
    expect(row.midPay).toBe('600000');
    expect(row.maxPay).toBe('800000.25');

    const employment = await makeEmployee('compa');
    const compa = wire(await asUser('operations@kaizen.co.in', () => compaRatioFor(employment.id, grade.id)));
    expect(compa.currentCtc).toBe(600000);
    expect(compa.ratio).toBe(1);
    expect(compa.band).toBe('at_mid');
    expect(compa.grade.midPay).toBe('600000');
  });

  it('SalaryRevisionLine: currentCtc, proposedCtc and approvedCtc are Decimal strings on the row, numbers on the money-visible list, null to hrOps', async () => {
    const employment = await makeEmployee('revision');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Characterisation ${stamp()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({
        cycleId: cycle.id,
        employmentRelationshipId: employment.id,
        currentCtc: 600000.5,
        proposedPct: 10,
      }),
    );
    const addWire = wire(line);
    expect(addWire.currentCtc).toBe('600000.5');
    expect(addWire.proposedCtc).toBe('660000.55');
    expect(addWire.approvedCtc).toBeNull();

    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    const asFinance = wire(await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id)));
    expect(asFinance[0].currentCtc).toBe(600000.5);
    expect(asFinance[0].proposedCtc).toBe(660000.55);
    expect(asFinance[0].approvedCtc).toBeNull();
    expect(asFinance[0].moneyWithheldReason).toBeNull();

    const asHrOps = wire(await asUser('operations@kaizen.co.in', () => listRevisionLines(cycle.id)));
    expect(asHrOps[0].currentCtc).toBeNull();
    expect(asHrOps[0].proposedCtc).toBeNull();
    expect(asHrOps[0].moneyWithheldReason).toBe('no_permission');

    const approved = wire(await asUser('finance@kaizen.co.in', () => approveRevisionLine(line.id)));
    expect(approved.approvedCtc).toBe('660000.55');

    const budget = wire(await asUser('chairman@kaizen.co.in', () => getRevisionCycle(cycle.id))).budget;
    expect(budget.totalCurrent).toBe(600000.5);
    expect(budget.totalProposed).toBe(660000.55);
    expect(budget.increaseAmount).toBe(60000.05);
    expect(budget.withinBudget).toBe(true);
  });

  it('SalaryRevisionLine: an applied line writes its approved figure into CompensationRecord, and myRevisionLines keeps the Decimal string', async () => {
    const employment = await makeEmployee('applied');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Applied ${stamp()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({
        cycleId: cycle.id,
        employmentRelationshipId: employment.id,
        currentCtc: 600000,
        proposedPct: 10,
      }),
    );
    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    const [line] = await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id));
    await asUser('finance@kaizen.co.in', () => approveRevisionLine(line!.id));
    await asUser('finance@kaizen.co.in', () => approveCycle(cycle.id));
    const { linesApplied } = await asUser('operations@kaizen.co.in', () => applyCycle(cycle.id));
    expect(linesApplied).toBe(1);

    const record = await unscopedPrisma.compensationRecord.findFirstOrThrow({
      where: { employmentRelationshipId: employment.id, status: 'Effective' },
    });
    expect(record.amount.toFixed(2)).toBe('660000.00');

    const mine = wire(await asUser('operations@kaizen.co.in', () => myRevisionLines(employment.id)));
    expect(mine[0].currentCtc).toBe('600000');
    expect(mine[0].proposedCtc).toBe('660000');
    expect(mine[0].approvedCtc).toBe('660000');
  });

  it('VariablePayout computedAmount and approvedAmount: numbers to finance, null to hrOps; the figure rounds to two places', async () => {
    const employment = await makeEmployee('payout');
    const plan = await asUser('operations@kaizen.co.in', () =>
      createVariablePayPlan({
        name: `Characterisation plan ${stamp()}`,
        kind: 'bonus',
        period: 'annual',
        formula: { type: 'percentage_of_base', pct: 12.5 },
      }),
    );
    const payout = await asUser('operations@kaizen.co.in', () =>
      computePayout(plan.id, employment.id, `P-${stamp()}`, 500000.5),
    );
    expect(wire(payout).computedAmount).toBe('62500.06');
    expect(wire(payout).approvedAmount).toBeNull();

    const approved = wire(await asUser('finance@kaizen.co.in', () => approvePayout(payout.id)));
    expect(approved.approvedAmount).toBe('62500.06');
    const paid = wire(await asUser('operations@kaizen.co.in', () => markPayoutPaid(payout.id)));
    expect(paid.approvedAmount).toBe('62500.06');

    const asFinance = wire(await asUser('finance@kaizen.co.in', () => listVariablePayouts(employment.id)));
    expect(asFinance[0].computedAmount).toBe(62500.06);
    expect(asFinance[0].approvedAmount).toBe(62500.06);
    expect(asFinance[0].moneyWithheldReason).toBeNull();

    const asHrOps = wire(await asUser('operations@kaizen.co.in', () => listVariablePayouts(employment.id)));
    expect(asHrOps[0].computedAmount).toBeNull();
    expect(asHrOps[0].approvedAmount).toBeNull();
    expect(asHrOps[0].moneyWithheldReason).toBe('no_permission');
  });

  it('BenefitPlan employerContribution and employeeContribution: Decimal strings on create and list', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createBenefitPlan({
        name: `Characterisation health ${stamp()}`,
        kind: 'health',
        employerContribution: 1500.5,
        employeeContribution: 500.25,
      }),
    );
    expect(wire(plan).employerContribution).toBe('1500.5');
    expect(wire(plan).employeeContribution).toBe('500.25');
    const listed = wire(await asUser('operations@kaizen.co.in', () => listBenefitPlans(true)));
    const row = listed.find((p: any) => p.id === plan.id);
    expect(row.employerContribution).toBe('1500.5');
    expect(row.employeeContribution).toBe('500.25');
  });

  it('EmployeeLoan principal, emi and outstandingPrincipal: the EMI schedule and repayment arithmetic in rupees, numbers to finance, null to hrOps', async () => {
    const schedule = await scheduleFor(100000.5, 12, 12);
    expect(schedule.emi).toBe(8884.92);
    expect(schedule.totalInterest).toBe(6618.59);
    expect(schedule.totalPayable).toBe(106619.09);
    expect(schedule.instalments).toHaveLength(12);
    expect(schedule.instalments[11]!.balance).toBe(0);

    const ravi = await employmentFor('ravi@kaizen.co.in');
    const loan = await asUser('ravi@kaizen.co.in', () =>
      requestLoan({ employmentRelationshipId: ravi.id, principal: 100000.5, interestPct: 12, tenureMonths: 12 }),
    );
    expect(wire(loan).principal).toBe('100000.5');
    expect(wire(loan).emi).toBe('8884.92');
    expect(wire(loan).outstandingPrincipal).toBe('100000.5');

    await asUser('finance@kaizen.co.in', () => approveLoan(loan.id));
    await asUser('operations@kaizen.co.in', () => disburseLoan(loan.id, new Date()));
    const repaid = wire(await asUser('operations@kaizen.co.in', () => recordLoanRepayment(loan.id, 25000.25)));
    expect(repaid.outstandingPrincipal).toBe('75000.25');

    const asFinance = wire(await asUser('finance@kaizen.co.in', () => listLoans(ravi.id)));
    const row = asFinance.find((l: any) => l.id === loan.id);
    expect(row.principal).toBe(100000.5);
    expect(row.emi).toBe(8884.92);
    expect(row.outstandingPrincipal).toBe(75000.25);

    const asHrOps = wire(await asUser('operations@kaizen.co.in', () => listLoans(ravi.id)));
    const opsRow = asHrOps.find((l: any) => l.id === loan.id);
    expect(opsRow.principal).toBeNull();
    expect(opsRow.emi).toBeNull();
    expect(opsRow.outstandingPrincipal).toBeNull();
  });

  it('ExpenseClaim.amount: a Decimal string on submit, a number on the list for finance, null for hrOps', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const claim = await asUser('ravi@kaizen.co.in', () =>
      submitExpenseClaim({ employmentRelationshipId: ravi.id, category: 'travel', amount: 1234.56 }),
    );
    expect(wire(claim).amount).toBe('1234.56');
    await asUser('finance@kaizen.co.in', () => approveExpenseClaim(claim.id));
    await asUser('operations@kaizen.co.in', () => reimburseExpenseClaim(claim.id));

    const asFinance = wire(await asUser('finance@kaizen.co.in', () => listExpenseClaims(ravi.id)));
    expect(asFinance.find((c: any) => c.id === claim.id).amount).toBe(1234.56);
    const asHrOps = wire(await asUser('operations@kaizen.co.in', () => listExpenseClaims(ravi.id)));
    expect(asHrOps.find((c: any) => c.id === claim.id).amount).toBeNull();
  });
});
