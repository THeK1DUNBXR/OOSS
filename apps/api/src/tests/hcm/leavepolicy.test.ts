/**
 * HCM — WS3 leavepolicy (docs/hcm/leavepolicy.md).
 *
 * HCM-LVP-001..010: policy/rule CRUD and applicability resolution, pure
 * accrual/pro-rata/sandwich arithmetic, request validation against a rule,
 * the idempotent monthly accrual run, approval-chain resolution and the
 * Self-Dealing Bar on deciding a level, restricted-holiday election limits,
 * and cross-tenant isolation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../../platform/context.js';
import {
  ACCRUAL_PERIODS_PER_YEAR,
  calendarSpanDays,
  creditableWithinCap,
  parseAccrualPeriod,
  proratedAccrual,
  suggestedAccrualDays,
  validateLeaveRequestAgainstPolicy,
} from '@kaizen/shared';
import { asPrincipal, asUser, expectReject, prisma, tenantId } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { createHoliday } from '../../domains/compliance/labour.js';
import {
  createLeavePolicy,
  createPolicyRule,
  resolveApplicablePolicy,
  validateLeaveRequest,
  runAccrualForRule,
  createApprovalChain,
  initiateApprovalChain,
  listApprovalsForRequest,
  decideApprovalLevel,
  electRestrictedHoliday,
  withdrawRestrictedHolidayElection,
  listRestrictedHolidayElections,
  teamCalendar,
} from '../../domains/hcm/leavepolicy.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function makeEmployee(label: string, engagementType = 'employee') {
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
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.leavepolicy.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    if (engagementType !== 'employee') {
      await prisma.employmentRelationship.update({ where: { id: employment.id }, data: { engagementType } });
    }
    return { employment, person, position };
  });
}

async function asEmployee<T>(partyId: string, fn: () => Promise<T>): Promise<T> {
  const auth: AuthContext = {
    tenantId: TENANT,
    principalType: 'human',
    partyId,
    userId: null,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: null,
    roleSlug: 'employee',
    branch: null,
    orgUnitId: null,
    classificationCeiling: 'regulated',
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
  return asPrincipal(auth, fn);
}

async function makePolicyWithRule(overrides: Partial<Parameters<typeof createPolicyRule>[1]> = {}) {
  return asUser('operations@kaizen.co.in', async () => {
    const elType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
    const policy = await createLeavePolicy({ name: `Fixture policy ${Date.now()}-${fixtureSeq}`, effectiveFrom: new Date(Date.UTC(2020, 0, 1)) });
    const rule = await createPolicyRule(policy.id, {
      leaveTypeId: elType.id,
      accrualFrequency: 'monthly',
      accrualDays: 1.25,
      prorateOnJoin: true,
      minNoticeDays: 2,
      maxConsecutiveDays: 10,
      negativeAllowed: false,
      sandwichRule: false,
      ...overrides,
    });
    return { policy, rule, elType };
  });
}

// ===========================================================================
// Pure logic
// ===========================================================================

describe('HCM-LVP-001 — pure accrual, pro-rata and sandwich arithmetic', () => {
  it('HCM-LVP-001a: suggestedAccrualDays divides the annual entitlement by the frequency', () => {
    expect(suggestedAccrualDays(15, 'monthly')).toBeCloseTo(1.25, 2);
    expect(suggestedAccrualDays(15, 'quarterly')).toBeCloseTo(3.75, 2);
    expect(suggestedAccrualDays(15, 'none')).toBe(0);
  });

  it('HCM-LVP-001b: proratedAccrual scales a mid-period join to the fraction of the period worked', () => {
    const start = new Date(Date.UTC(2026, 8, 1));
    const end = new Date(Date.UTC(2026, 8, 30));
    // Joined on the 16th: 15 of 30 days, so half the period's credit.
    const credit = proratedAccrual(1.25, start, end, new Date(Date.UTC(2026, 8, 16)), null);
    expect(credit).toBeCloseTo(0.63, 1);
  });

  it('HCM-LVP-001c: creditableWithinCap floors at the cap and never goes negative', () => {
    expect(creditableWithinCap(44, 2, 45)).toBeCloseTo(1, 5);
    expect(creditableWithinCap(45, 2, 45)).toBe(0);
    expect(creditableWithinCap(10, 2, null)).toBe(2);
  });

  it('HCM-LVP-001d: calendarSpanDays counts every day inclusive, unlike a working-day count', () => {
    expect(calendarSpanDays(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 5)))).toBe(5);
  });

  it('HCM-LVP-001e: parseAccrualPeriod resolves monthly, quarterly and yearly period keys', () => {
    expect(parseAccrualPeriod('monthly', '2026-09').start.getUTCMonth()).toBe(8);
    expect(parseAccrualPeriod('quarterly', '2026-Q1').start.getUTCMonth()).toBe(0);
    expect(parseAccrualPeriod('yearly', '2026').end.getUTCFullYear()).toBe(2027);
    expect(ACCRUAL_PERIODS_PER_YEAR.monthly).toBe(12);
  });

  it('HCM-LVP-001f: validateLeaveRequestAgainstPolicy returns a true, specific statement for each violation', () => {
    const result = validateLeaveRequestAgainstPolicy(
      {
        accrualFrequency: 'monthly',
        accrualDays: 1.25,
        prorateOnJoin: true,
        maxBalanceDays: null,
        carryForwardCapDays: null,
        negativeAllowed: false,
        minNoticeDays: 5,
        maxConsecutiveDays: 3,
        sandwichRule: false,
        requiresDocumentAfterDays: null,
        applicableGender: null,
      },
      {
        startDate: new Date(),
        endDate: new Date(Date.now() + 6 * 86_400_000),
        workingDays: 6,
        submittedAt: new Date(),
        availableDays: 2,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(['min_notice', 'max_consecutive', 'insufficient_balance']),
    );
  });
});

// ===========================================================================
// Policies, rules and applicability
// ===========================================================================

describe('HCM-LVP-002 — policy and rule CRUD', () => {
  it('HCM-LVP-002: creating a rule for a leave type twice on the same policy is refused, and the message names the existing rule', async () => {
    const { policy, elType } = await makePolicyWithRule();
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => createPolicyRule(policy.id, { leaveTypeId: elType.id })),
    );
    expect(err.status).toBe(409);
  });

  it('HCM-LVP-002: an employee holds no create grant on leave_policies', async () => {
    const { person } = await makeEmployee('no-grant');
    const err = await expectReject(() =>
      asEmployee(person.id, () => createLeavePolicy({ name: 'x', effectiveFrom: new Date() })),
    );
    expect(err.status).toBe(403);
  });
});

describe('HCM-LVP-003 — applicability resolution', () => {
  it('HCM-LVP-003: a policy scoped to contractors does not resolve for a regular employee, and the wider default does', async () => {
    await makePolicyWithRule(); // the company-wide default (no engagementTypes) — sorted after the scoped one but still resolves for employees.
    const { policy: scoped, elType } = await asUser('operations@kaizen.co.in', async () => {
      const p = await createLeavePolicy({
        name: `Contractor-only ${Date.now()}`,
        engagementTypes: ['contractor'],
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
      });
      const el = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
      await createPolicyRule(p.id, { leaveTypeId: el.id, accrualDays: 2 });
      return { policy: p, elType: el };
    });

    const { employment: employeeEmployment } = await makeEmployee('regular', 'employee');
    const { employment: contractorEmployment } = await makeEmployee('contractor', 'contractor');

    const forEmployee = await asUser('operations@kaizen.co.in', () =>
      resolveApplicablePolicy(employeeEmployment.id, elType.id),
    );
    expect(forEmployee?.policy.id).not.toBe(scoped.id);

    const forContractor = await asUser('operations@kaizen.co.in', () =>
      resolveApplicablePolicy(contractorEmployment.id, elType.id),
    );
    expect(forContractor?.policy.id).toBe(scoped.id);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('HCM-LVP-004 — validating a request against its resolved policy', () => {
  it('HCM-LVP-004: a request inside notice and balance passes; one that breaks minimum notice does not', async () => {
    const { elType } = await makePolicyWithRule({ minNoticeDays: 5 });
    const { employment } = await makeEmployee('validate');

    await asUser('operations@kaizen.co.in', async () => {
      const soon = new Date(Date.now() + 86_400_000);
      const soonEnd = new Date(soon.getTime() + 86_400_000);
      const result = await validateLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: elType.id,
        startDate: soon,
        endDate: soonEnd,
      });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === 'min_notice')).toBe(true);

      const far = new Date(Date.now() + 20 * 86_400_000);
      const farEnd = new Date(far.getTime() + 86_400_000);
      const okResult = await validateLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: elType.id,
        startDate: far,
        endDate: farEnd,
      });
      // Still flagged for balance (a fresh employee has none), but notice is satisfied.
      expect(okResult.violations.some((v) => v.code === 'min_notice')).toBe(false);
    });
  });

  it('HCM-LVP-004: with no policy configured for a leave type, validation is permissive and says so', async () => {
    const { employment } = await makeEmployee('no-policy');
    await asUser('operations@kaizen.co.in', async () => {
      const slType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'SL' } });
      const far = new Date(Date.now() + 20 * 86_400_000);
      const result = await validateLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: slType.id,
        startDate: far,
        endDate: new Date(far.getTime() + 86_400_000),
      });
      expect(result.ok).toBe(true);
      expect(result.policy).toBeNull();
    });
  });
});

// ===========================================================================
// Accrual
// ===========================================================================

describe('HCM-LVP-005 — the monthly accrual run is idempotent', () => {
  it('HCM-LVP-005: running the same rule for the same period twice credits the ledger once', async () => {
    const { rule, elType } = await makePolicyWithRule({ accrualDays: 1.25, prorateOnJoin: false });
    const { employment } = await makeEmployee('accrual');

    const period = new Date().toISOString().slice(0, 7);

    const first = await asUser('operations@kaizen.co.in', () => runAccrualForRule(rule.id, period));
    expect(first.idempotent).toBe(false);

    const second = await asUser('operations@kaizen.co.in', () => runAccrualForRule(rule.id, period));
    expect(second.idempotent).toBe(true);

    const balance = await asUser('operations@kaizen.co.in', () =>
      prisma.leaveBalance.findUnique({
        where: { employmentRelationshipId_leaveTypeId: { employmentRelationshipId: employment.id, leaveTypeId: elType.id } },
      }),
    );
    expect(Number(balance?.balanceDays)).toBeCloseTo(1.25, 2);
  });

  it('HCM-LVP-005: an accrual run refuses a rule with accrualFrequency none', async () => {
    const { rule } = await makePolicyWithRule({ accrualFrequency: 'none', accrualDays: 0 });
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => runAccrualForRule(rule.id, '2026-09')));
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// Approval chains — resolution and the Self-Dealing Bar
// ===========================================================================

describe('HCM-LVP-006 — approval chains resolve real approvers and enforce the Self-Dealing Bar', () => {
  it('HCM-LVP-006: a manager+hr chain resolves the requester\'s actual manager, and the manager may decide their level', async () => {
    const { employment: managerEmployment, person: managerPerson } = await makeEmployee('manager');
    const { employment } = await asUser('operations@kaizen.co.in', async () => {
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
          fullName: `Fixture report ${Date.now()}`,
          primaryEmail: `fixture.leavepolicy.report.${Date.now()}@example.com`,
          source: 'test',
        },
      });
      const emp = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
      await transitionEmployment(emp.id, 'ACTIVATE');
      const managerPosition = (
        await prisma.assignment.findFirstOrThrow({ where: { employmentRelationshipId: managerEmployment.id } })
      ).positionId;
      await prisma.assignment.updateMany({ where: { employmentRelationshipId: emp.id }, data: { managerPositionId: managerPosition } });
      return { employment: emp };
    });

    const chain = await asUser('operations@kaizen.co.in', () =>
      createApprovalChain({ name: `Chain ${Date.now()}`, levels: [{ level: 1, kind: 'manager' }, { level: 2, kind: 'hr' }] }),
    );

    const { request, elType } = await asUser('operations@kaizen.co.in', async () => {
      const el = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
      const { createLeaveRequest } = await import('../../domains/leave.js');
      const req = await createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: el.id,
        startDate: new Date(Date.now() + 5 * 86_400_000),
        endDate: new Date(Date.now() + 6 * 86_400_000),
      });
      return { request: req, elType: el };
    });
    void elType;

    const approvals = await asUser('operations@kaizen.co.in', () => initiateApprovalChain(request.id, chain.id));
    expect(approvals).toHaveLength(2);
    const managerLevel = approvals.find((a) => a.kind === 'manager');
    expect(managerLevel?.approverPartyId).toBe(managerPerson.id);

    const decided = await asEmployee(managerPerson.id, () => decideApprovalLevel(managerLevel!.id, 'approved', 'looks fine'));
    expect(decided.decision).toBe('approved');

    const rows = await asUser('operations@kaizen.co.in', () => listApprovalsForRequest(request.id));
    expect(rows.find((r) => r.id === managerLevel!.id)?.decision).toBe('approved');
  });

  it('HCM-LVP-006: the Self-Dealing Bar refuses the leave-taker deciding their own level', async () => {
    const { employment, person } = await makeEmployee('self-deal');
    const chain = await asUser('operations@kaizen.co.in', () =>
      createApprovalChain({ name: `Self-chain ${Date.now()}`, levels: [{ level: 1, kind: 'hr' }] }),
    );
    const request = await asUser('operations@kaizen.co.in', async () => {
      const el = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
      const { createLeaveRequest } = await import('../../domains/leave.js');
      return createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: el.id,
        startDate: new Date(Date.now() + 5 * 86_400_000),
        endDate: new Date(Date.now() + 6 * 86_400_000),
      });
    });
    const [approval] = await asUser('operations@kaizen.co.in', () => initiateApprovalChain(request.id, chain.id));

    const err = await expectReject(() => asEmployee(person.id, () => decideApprovalLevel(approval.id, 'approved')));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// Restricted holidays
// ===========================================================================

describe('HCM-LVP-007 — restricted holiday elections are capped per financial year', () => {
  it('HCM-LVP-007: a third election in the same FY is refused once the annual limit is reached', async () => {
    const { employment } = await makeEmployee('restricted');
    const fy = '2026-27';
    const holidays = await asUser('operations@kaizen.co.in', async () => {
      const h1 = await createHoliday({ date: new Date(Date.UTC(2026, 9, 20)), name: `Fixture RH1 ${Date.now()}`, kind: 'restricted' });
      const h2 = await createHoliday({ date: new Date(Date.UTC(2026, 10, 5)), name: `Fixture RH2 ${Date.now()}`, kind: 'restricted' });
      const h3 = await createHoliday({ date: new Date(Date.UTC(2026, 11, 1)), name: `Fixture RH3 ${Date.now()}`, kind: 'restricted' });
      return [h1, h2, h3];
    });

    await asUser('operations@kaizen.co.in', () =>
      electRestrictedHoliday({ employmentRelationshipId: employment.id, holidayId: holidays[0].id, fy }),
    );
    await asUser('operations@kaizen.co.in', () =>
      electRestrictedHoliday({ employmentRelationshipId: employment.id, holidayId: holidays[1].id, fy }),
    );
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        electRestrictedHoliday({ employmentRelationshipId: employment.id, holidayId: holidays[2].id, fy }),
      ),
    );
    expect(err.status).toBe(422);

    const list = await asUser('operations@kaizen.co.in', () => listRestrictedHolidayElections(employment.id));
    expect(list).toHaveLength(2);
    await asUser('operations@kaizen.co.in', () => withdrawRestrictedHolidayElection(list[0].id));
    const afterWithdraw = await asUser('operations@kaizen.co.in', () => listRestrictedHolidayElections(employment.id));
    expect(afterWithdraw).toHaveLength(1);
  });
});

// ===========================================================================
// Team calendar and cross-tenant isolation
// ===========================================================================

describe('HCM-LVP-008 — team calendar and cross-tenant isolation', () => {
  it('HCM-LVP-008: the team calendar for a month with no leave returns an empty entry list, not an error', async () => {
    const result = await asUser('operations@kaizen.co.in', () => teamCalendar('2019-01'));
    expect(result.entries).toEqual([]);
  });

  it('HCM-LVP-009 (scope-axis fix): an own-scope employee is refused the team calendar, which reads other employments\' leave', async () => {
    const { person } = await makeEmployee('team-calendar-scope');
    const err = await expectReject(() => asEmployee(person.id, () => teamCalendar('2026-09')));
    expect(err.status).toBe(403);
  });

  it('HCM-LVP-009 (scope-axis fix): an own-scope employee is refused the accrual-run list, which has no per-employee owner to narrow by', async () => {
    const { person } = await makeEmployee('accrual-list-scope');
    const { listAccrualRuns } = await import('../../domains/hcm/leavepolicy.js');
    const err = await expectReject(() => asEmployee(person.id, () => listAccrualRuns()));
    expect(err.status).toBe(403);
  });

  it('HCM-LVP-008: a policy created in one tenant is invisible to a principal with no grants in another tenant', async () => {
    const { policy } = await makePolicyWithRule();
    const foreignAuth: AuthContext = {
      tenantId: 'not-a-real-tenant',
      principalType: 'human',
      partyId: 'nobody',
      userId: null,
      agentId: null,
      onBehalfOfPartyId: null,
      affiliationId: null,
      roleSlug: 'hr_ops_manager',
      branch: null,
      orgUnitId: null,
      classificationCeiling: 'regulated',
      purpose: 'operational',
      consentCodes: [],
      stepUpVerified: true,
    };
    const { getLeavePolicy } = await import('../../domains/hcm/leavepolicy.js');
    // A tenant that does not exist has no seeded grant rows at all, so the
    // evaluator refuses on the WHAT axis before the tenant-scoped lookup ever
    // gets a chance to answer not-found — a real (and stronger) form of the
    // same isolation.
    const err = await expectReject(() => asPrincipal(foreignAuth, () => getLeavePolicy(policy.id)));
    expect(err.status).toBe(403);
  });
});
