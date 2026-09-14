/**
 * HCM — compensation (docs/hcm/compensation.md, workstream WS7).
 *
 * Own DB (`kaizen_test_compensation`), against the shared `kaizen` tenant's
 * demo dataset — the same fixture cast the other suites use
 * (`operations@kaizen.co.in` = hrOps, `finance@kaizen.co.in` = financeHead,
 * `chairman@kaizen.co.in` = chairman, `ravi@kaizen.co.in` = a plain employee
 * with a real EmploymentRelationship).
 *
 * The product's own four-role matrix keeps `create` and `approve` on every
 * WS7 resource on two different roles (hrOps proposes, finance approves) —
 * which is the point of the matrix, and also means no product role can
 * exercise the Self-Dealing Bar's "same person, both hats" case on its own.
 * Per `withFixtureRole`'s own rationale in `helpers.ts`, the bar tests below
 * build the narrow fixture role that holds both verbs, exactly as a tenant
 * that wanted a role like that would, and check it behaves the way the bar
 * says it should.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { emiSchedule, revisionBudgetCheck, compaRatio, computeVariablePayout } from '@kaizen/shared';
import { asUser, asPrincipal, authFor, expectReject, prisma, unscopedPrisma, tenantId, withFixtureRole, type TestPrincipal } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  createPayGrade, listPayGrades,
  createRevisionCycle, addRevisionLine, listRevisionLines, proposeCycle,
  approveRevisionLine, approveCycle, applyCycle, getRevisionCycle,
  createVariablePayPlan, computePayout, approvePayout, markPayoutPaid, listVariablePayouts,
  createBenefitPlan, enrolInBenefit, cancelBenefitEnrollment, listMyBenefitEnrollments,
  requestLoan, approveLoan, disburseLoan, recordLoanRepayment, listLoans,
  submitExpenseClaim, approveExpenseClaim, reimburseExpenseClaim, listExpenseClaims,
} from '../../domains/hcm/compensation.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function employmentFor(email: string) {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { personId: user.personId } });
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
        fullName: `Compensation Fixture ${label} ${stamp}`,
        primaryEmail: `compensation.fixture.${label}.${stamp}@example.com`,
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
    return { employment, person };
  });
}

/** Hires and activates an employment for an existing person — used to give a fixture principal their own subject row. */
async function hireEmploymentFor(personId: string, label: string) {
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
    const employment = await hire({ personId, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    void label;
    return employment;
  });
}

// ===========================================================================
// Pure logic (sanity — the shared module the domain layer calls into)
// ===========================================================================

describe('pure compensation logic', () => {
  it('HCM-COMPENSATION-001: EMI schedule closes exactly at zero and totals reconcile', () => {
    const schedule = emiSchedule(120_000, 12, 12);
    expect(schedule.instalments).toHaveLength(12);
    expect(schedule.instalments.at(-1)!.balance).toBe(0);
    const principalSum = schedule.instalments.reduce((s, i) => s + i.principalComponent, 0);
    expect(Math.round(principalSum)).toBe(120_000);
  });

  it('HCM-COMPENSATION-002: revision budget check and compa-ratio compute the plain arithmetic', () => {
    const budget = revisionBudgetCheck([{ currentCtc: 100_000, proposedCtc: 108_000 }], 10);
    expect(budget.increasePct).toBe(8);
    expect(budget.withinBudget).toBe(true);
    expect(compaRatio(95_000, 100_000)).toBeCloseTo(0.95);
    expect(computeVariablePayout(200_000, { type: 'percentage_of_base', pct: 10 })).toBe(20_000);
  });
});

// ===========================================================================
// Pay grades
// ===========================================================================

describe('pay grades', () => {
  it('HCM-COMPENSATION-003: hrOps creates a pay grade and it lists in level order', async () => {
    const stamp = Date.now();
    await asUser('operations@kaizen.co.in', () =>
      createPayGrade({ code: `PG-${stamp}-A`, level: 1, minPay: 400_000, midPay: 600_000, maxPay: 800_000 }),
    );
    await asUser('operations@kaizen.co.in', () =>
      createPayGrade({ code: `PG-${stamp}-B`, level: 2, minPay: 800_000, midPay: 1_100_000, maxPay: 1_400_000 }),
    );
    const grades = await asUser('operations@kaizen.co.in', () => listPayGrades());
    const ours = grades.filter((g) => g.code.startsWith(`PG-${stamp}`));
    expect(ours.map((g) => g.level)).toEqual([1, 2]);
  });

  it('HCM-COMPENSATION-004: a grade with minPay above maxPay is refused', async () => {
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => createPayGrade({ code: `PG-BAD-${Date.now()}`, level: 1, minPay: 900_000, midPay: 600_000, maxPay: 800_000 })),
    );
    expect(err.message).toMatch(/minPay/);
  });
});

// ===========================================================================
// Salary revision cycles — create, propose, budget, apply, and the
// Self-Dealing Bar on a fixture role that (unlike the product's own roles)
// holds both create and approve.
// ===========================================================================

describe('salary revision cycles', () => {
  it('HCM-COMPENSATION-005: hrOps proposes, finance approves and applies is refused to hrOps (no approve), applying is refused to finance (no edit) — the roles genuinely cannot move money alone', async () => {
    const { employment } = await makeEmployee('revline-roles');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Roles cycle ${Date.now()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({ cycleId: cycle.id, employmentRelationshipId: employment.id, currentCtc: 600_000, proposedPct: 10 }),
    );
    const hrOpsApprove = await expectReject(() => asUser('operations@kaizen.co.in', () => approveRevisionLine(line.id)));
    expect(hrOpsApprove.message).toMatch(/Denied on WHO axis/);

    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    await asUser('finance@kaizen.co.in', () => approveRevisionLine(line.id));
    await asUser('finance@kaizen.co.in', () => approveCycle(cycle.id));

    const financeApply = await expectReject(() => asUser('finance@kaizen.co.in', () => applyCycle(cycle.id)));
    expect(financeApply.message).toMatch(/Denied on WHO axis/);
  });

  it('HCM-COMPENSATION-006: hrOps proposes and finance approves a third employee\'s line, and applying (by hrOps, who holds edit) writes an Effective CompensationRecord', async () => {
    const { employment } = await makeEmployee('revline-apply');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Apply cycle ${Date.now()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({ cycleId: cycle.id, employmentRelationshipId: employment.id, currentCtc: 600_000, proposedPct: 10 }),
    );
    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    const lines = await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id));
    await asUser('finance@kaizen.co.in', () => approveRevisionLine(lines[0].id));
    const approved = await asUser('finance@kaizen.co.in', () => approveCycle(cycle.id));
    expect(approved.status).toBe('approved');

    const { linesApplied } = await asUser('operations@kaizen.co.in', () => applyCycle(cycle.id));
    expect(linesApplied).toBe(1);

    const record = await unscopedPrisma.compensationRecord.findFirst({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id, status: 'Effective' },
      orderBy: { createdAt: 'desc' },
    });
    expect(record).toBeTruthy();
    expect(Number(record!.amount)).toBe(660_000);
  });

  it('HCM-COMPENSATION-007: a cycle whose approved lines exceed its own budget is refused approval', async () => {
    const { employment } = await makeEmployee('revline-overbudget');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Overbudget cycle ${Date.now()}`, effectiveDate: new Date(), budgetPct: 5 }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({ cycleId: cycle.id, employmentRelationshipId: employment.id, currentCtc: 600_000, proposedPct: 50 }),
    );
    await asUser('operations@kaizen.co.in', () => proposeCycle(cycle.id));
    await asUser('finance@kaizen.co.in', () => approveRevisionLine(line.id));
    const err = await expectReject(() => asUser('finance@kaizen.co.in', () => approveCycle(cycle.id)));
    expect(err.message).toMatch(/budget/);
  });

  it('HCM-COMPENSATION-008: money on a salary revision line is withheld from a role with no `financial` verb on the resource, and visible to one that has it', async () => {
    const { employment } = await makeEmployee('revline-money');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Money cycle ${Date.now()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({ cycleId: cycle.id, employmentRelationshipId: employment.id, currentCtc: 600_000, proposedPct: 10 }),
    );
    const asHrOps = await asUser('operations@kaizen.co.in', () => listRevisionLines(cycle.id));
    expect(asHrOps[0].currentCtc).toBeNull();
    expect(asHrOps[0].moneyWithheldReason).toBe('no_permission');

    const asFinance = await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id));
    expect(asFinance[0].currentCtc).toBe(600_000);
  });

  it('a cross-tenant revision cycle id is 404', async () => {
    const otherTenant = await unscopedPrisma.tenant.findFirst({ where: { id: { not: TENANT } } });
    if (otherTenant) {
      const foreignRow = await unscopedPrisma.salaryRevisionCycle.findFirst({ where: { tenantId: otherTenant.id } });
      if (foreignRow) {
        const err = await expectReject(() => asUser('chairman@kaizen.co.in', () => getRevisionCycle(foreignRow.id)));
        expect(err.status).toBe(404);
        return;
      }
    }
    const err = await expectReject(() => asUser('chairman@kaizen.co.in', () => getRevisionCycle('does-not-exist')));
    expect(err.status).toBe(404);
  });

  it('HCM-COMPENSATION-009: the Self-Dealing Bar refuses a line\'s own proposer even when that principal holds the approve grant', async () => {
    await withFixtureRole(
      { slug: 'comp_dualhat', grants: [{ resource: 'salary_revisions', verbs: ['view', 'create', 'approve'], scope: 'all' }] },
      async (fixture) => {
        const { employment } = await makeEmployee('revline-dualhat-proposer');
        const cycle = await asUser('operations@kaizen.co.in', () =>
          createRevisionCycle({ name: `Dualhat cycle ${Date.now()}`, effectiveDate: new Date(), budgetPct: 50 }),
        );
        const created = await addRevisionLineAsFixture(fixture, cycle.id, employment.id);
        const err = await expectReject(() => addApproveAsFixture(fixture, created.id));
        expect(err.message).toMatch(/Self-Dealing Bar|proposer/);
      },
    );
  });
});

// Small adapters so the fixture principal (built by `withFixtureRole`, which
// hands back a `TestPrincipal` rather than an email) can call the same
// domain functions `asUser` calls for a named seed account.
async function addRevisionLineAsFixture(fixture: TestPrincipal, cycleId: string, employmentRelationshipId: string) {
  return asPrincipal(authFor(fixture), () =>
    addRevisionLine({ cycleId, employmentRelationshipId, currentCtc: 600_000, proposedPct: 10 }),
  );
}
async function addApproveAsFixture(fixture: TestPrincipal, lineId: string) {
  return asPrincipal(authFor(fixture), () => approveRevisionLine(lineId));
}

// ===========================================================================
// Variable pay
// ===========================================================================

describe('variable pay', () => {
  it('HCM-COMPENSATION-010: a payout is computed by hrOps, approved by finance, and marked paid by hrOps (who holds edit)', async () => {
    const { employment } = await makeEmployee('varpay');
    const plan = await asUser('operations@kaizen.co.in', () =>
      createVariablePayPlan({ name: `Bonus ${Date.now()}`, kind: 'bonus', period: 'annual', formula: { type: 'percentage_of_base', pct: 10 } }),
    );
    const payout = await asUser('operations@kaizen.co.in', () => computePayout(plan.id, employment.id, '2026', 600_000));
    expect(Number(payout.computedAmount)).toBe(60_000);

    const approved = await asUser('finance@kaizen.co.in', () => approvePayout(payout.id));
    expect(approved.status).toBe('approved');
    const paid = await asUser('operations@kaizen.co.in', () => markPayoutPaid(payout.id));
    expect(paid.status).toBe('paid');

    const list = await asUser('finance@kaizen.co.in', () => listVariablePayouts(employment.id));
    expect(list.find((p) => p.id === payout.id)?.status).toBe('paid');
  });

  it('HCM-COMPENSATION-011: the Self-Dealing Bar refuses a payout\'s own computer even when that principal holds approve', async () => {
    await withFixtureRole(
      { slug: 'comp_varpay_dualhat', grants: [{ resource: 'variable_pay', verbs: ['view', 'create', 'approve'], scope: 'all' }] },
      async (fixture) => {
        const { employment } = await makeEmployee('varpay-dualhat');
        const plan = await asUser('operations@kaizen.co.in', () =>
          createVariablePayPlan({ name: `Dualhat bonus ${Date.now()}`, kind: 'bonus', period: 'annual', formula: { type: 'fixed', amount: 5_000 } }),
        );
        const payout = await asPrincipal(authFor(fixture), () => computePayout(plan.id, employment.id, '2026', 0));
        const err = await expectReject(() => asPrincipal(authFor(fixture), () => approvePayout(payout.id)));
        expect(err.message).toMatch(/Self-Dealing Bar|approve/);
      },
    );
  });
});

// ===========================================================================
// Benefits
// ===========================================================================

describe('benefits', () => {
  it('HCM-COMPENSATION-012: an employee enrols in a benefit plan and can cancel their own enrolment', async () => {
    const { employment } = await makeEmployee('benefits');
    const plan = await asUser('operations@kaizen.co.in', () =>
      createBenefitPlan({ name: `Health ${Date.now()}`, kind: 'health', employerContribution: 500, employeeContribution: 100 }),
    );
    const enrollment = await asUser('operations@kaizen.co.in', () => enrolInBenefit(plan.id, employment.id));
    expect(enrollment.status).toBe('enrolled');

    const mine = await asUser('operations@kaizen.co.in', () => listMyBenefitEnrollments(employment.id));
    expect(mine).toHaveLength(1);

    const cancelled = await asUser('operations@kaizen.co.in', () => cancelBenefitEnrollment(enrollment.id));
    expect(cancelled.status).toBe('cancelled');
  });
});

// ===========================================================================
// Employee loans
// ===========================================================================

describe('employee loans', () => {
  it('HCM-COMPENSATION-013: ravi requests his own loan, finance approves it (never ravi, who holds no approve grant), hrOps disburses and a full repayment closes it', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const loan = await asUser('ravi@kaizen.co.in', () => requestLoan({ employmentRelationshipId: ravi.id, principal: 60_000, interestPct: 0, tenureMonths: 6 }));
    expect(Number(loan.emi)).toBe(10_000);

    const raviApprove = await expectReject(() => asUser('ravi@kaizen.co.in', () => approveLoan(loan.id)));
    expect(raviApprove.message).toMatch(/Denied on WHO axis/);

    const approved = await asUser('finance@kaizen.co.in', () => approveLoan(loan.id));
    expect(approved.status).toBe('approved');
    const disbursed = await asUser('operations@kaizen.co.in', () => disburseLoan(loan.id, new Date()));
    expect(disbursed.status).toBe('disbursed');

    const afterFirst = await asUser('operations@kaizen.co.in', () => recordLoanRepayment(loan.id, 60_000));
    expect(afterFirst.status).toBe('closed');
    expect(Number(afterFirst.outstandingPrincipal)).toBe(0);
  });

  it('HCM-COMPENSATION-014: loan principal is withheld from a viewer without the `financial` verb, and visible to finance', async () => {
    const { employment } = await makeEmployee('loan-money');
    await asUser('operations@kaizen.co.in', () => requestLoan({ employmentRelationshipId: employment.id, principal: 40_000, interestPct: 12, tenureMonths: 4 }));
    const asHrOps = await asUser('operations@kaizen.co.in', () => listLoans(employment.id));
    expect(asHrOps[0].principal).toBeNull();
    const asFinance = await asUser('finance@kaizen.co.in', () => listLoans(employment.id));
    expect(asFinance[0].principal).toBe(40_000);
  });

  it('HCM-COMPENSATION-015: the Self-Dealing Bar refuses a loan for the approver\'s own employment, even when that principal holds approve', async () => {
    await withFixtureRole(
      { slug: 'comp_loan_dualhat', grants: [{ resource: 'employee_loans', verbs: ['view', 'create', 'approve'], scope: 'all' }] },
      async (fixture) => {
        const employment = await hireEmploymentFor(fixture.partyId, 'loan-dualhat-subject');
        // Requested by hrOps for the fixture's own employment, so the subject
        // bar — not the requester bar — is what the approval attempt trips.
        const loan = await asUser('operations@kaizen.co.in', () =>
          requestLoan({ employmentRelationshipId: employment.id, principal: 20_000, interestPct: 0, tenureMonths: 4 }),
        );
        const err = await expectReject(() => asPrincipal(authFor(fixture), () => approveLoan(loan.id)));
        expect(err.message).toMatch(/cannot be approved by you/);
      },
    );
  });
});

// ===========================================================================
// Expense claims
// ===========================================================================

describe('expense claims', () => {
  it('HCM-COMPENSATION-016: ravi submits his own claim, hrOps approves it (never ravi), and hrOps marks it reimbursed', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const claim = await asUser('ravi@kaizen.co.in', () => submitExpenseClaim({ employmentRelationshipId: ravi.id, category: 'travel', amount: 2_500 }));
    expect(claim.status).toBe('submitted');

    const raviApprove = await expectReject(() => asUser('ravi@kaizen.co.in', () => approveExpenseClaim(claim.id)));
    expect(raviApprove.message).toMatch(/Denied on WHO axis/);

    const approved = await asUser('finance@kaizen.co.in', () => approveExpenseClaim(claim.id));
    expect(approved.status).toBe('approved');
    const reimbursed = await asUser('operations@kaizen.co.in', () => reimburseExpenseClaim(claim.id));
    expect(reimbursed.status).toBe('reimbursed');

    const list = await asUser('finance@kaizen.co.in', () => listExpenseClaims(ravi.id));
    expect(list.find((c) => c.id === claim.id)?.status).toBe('reimbursed');
  });

  it('HCM-COMPENSATION-017: an invalid transition (approving an already-reimbursed claim) is refused as a conflict', async () => {
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const claim = await asUser('ravi@kaizen.co.in', () => submitExpenseClaim({ employmentRelationshipId: ravi.id, category: 'food', amount: 400 }));
    await asUser('finance@kaizen.co.in', () => approveExpenseClaim(claim.id));
    await asUser('operations@kaizen.co.in', () => reimburseExpenseClaim(claim.id));
    const err = await expectReject(() => asUser('finance@kaizen.co.in', () => approveExpenseClaim(claim.id)));
    expect(err.message).toMatch(/already/);
  });

  it('HCM-COMPENSATION-018: the Self-Dealing Bar refuses a claim submitted and approved by the same dual-hatted principal', async () => {
    await withFixtureRole(
      { slug: 'comp_expense_dualhat', grants: [{ resource: 'expense_claims', verbs: ['view', 'create', 'approve'], scope: 'own' }] },
      async (fixture) => {
        const employment = await hireEmploymentFor(fixture.partyId, 'expense-dualhat');
        const claim = await asPrincipal(authFor(fixture), () =>
          submitExpenseClaim({ employmentRelationshipId: employment.id, category: 'other', amount: 999 }),
        );
        const err = await expectReject(() => asPrincipal(authFor(fixture), () => approveExpenseClaim(claim.id)));
        expect(err.message).toMatch(/Self-Dealing Bar|cannot be approved by you/);
      },
    );
  });
});
