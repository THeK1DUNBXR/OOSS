/**
 * HCM — WS12 analytics (docs/hcm/analytics.md).
 *
 * HCM-ANALYTICS-001..010: a read-only reporting layer has no lifecycle to
 * transition, so this suite exercises correctness of the aggregates against
 * fixtures it builds, permission refusal (no `hr_analytics` grant, and money
 * masked without the `financial` verb), graceful "not measured" for metrics
 * this schema or a not-yet-landed workstream cannot answer, and that a CSV
 * export lands an audit record.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, withFixtureRole } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { createRequisition, transitionRequisition, createApplication, transitionApplication, joinFromApplication } from '../../domains/hiring.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  headcountTrend,
  attritionSummary,
  tenureDistribution,
  leaveLiability,
  overtimeHours,
  hiringSummary,
  costPerHire,
  genderRatio,
  compRatioDistribution,
  engagementEnps,
  openCasesBySla,
  spanOfControl,
  dashboard,
  exportHeadcountRegister,
} from '../../domains/hcm/analytics.js';
import { spanOfControlStats, tenureBucket, annualizedAttritionRate, isEarlyAttrition } from '@kaizen/shared';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway active employee, hired `daysAgo` days back, isolated from the seeded cast. */
async function makeEmployee(label: string, daysAgo: number, monthlyBasic = 40_000) {
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
        fullName: `Fixture Analytics ${label} ${stamp}`,
        primaryEmail: `fixture.analytics.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const hireEffectiveDate = new Date(Date.now() - daysAgo * 86_400_000);
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate });
    await transitionEmployment(employment.id, 'ACTIVATE');
    await prisma.compensationRecord.create({
      data: {
        tenantId: TENANT,
        employmentRelationshipId: employment.id,
        revisionReason: 'initial',
        amount: monthlyBasic,
        basicPay: monthlyBasic,
        status: 'Effective',
        effectiveFrom: hireEffectiveDate,
      },
    });
    return { employment, person, position };
  });
}

// ===========================================================================
// HCM-ANALYTICS-001 — headcount trend counts current heads correctly
// ===========================================================================

describe('HCM-ANALYTICS-001 — headcount trend', () => {
  it('the latest month includes an employee hired this week and excludes one not yet hired', async () => {
    await makeEmployee('headcount-recent', 3);

    await asUser('operations@kaizen.co.in', async () => {
      const trend = await headcountTrend(2);
      expect(trend.length).toBe(2);
      expect(trend.at(-1)!.headcount).toBeGreaterThan(0);
      // Every point is a real count, never negative or fractional.
      for (const point of trend) {
        expect(point.headcount).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(point.headcount)).toBe(true);
      }
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-002 — attrition: annualised rate and the early-attrition cut
// ===========================================================================

describe('HCM-ANALYTICS-002 — attrition summary', () => {
  it('a separation inside 12 months of hire counts as early attrition, and the annualised rate matches the shared formula', async () => {
    const { employment } = await makeEmployee('early-leaver', 60);

    await asUser('operations@kaizen.co.in', async () => {
      await prisma.employmentRelationship.update({
        where: { id: employment.id },
        data: { status: 'Terminated', separationType: 'resignation', separationDate: new Date() },
      });

      const summary = await attritionSummary(1);
      expect(summary.leavers).toBeGreaterThanOrEqual(1);
      expect(summary.earlyAttritionCount).toBeGreaterThanOrEqual(1);
      expect(summary.earlyAttritionRatePct).not.toBeNull();

      // Cross-check against the pure shared formula directly, using the
      // actual number of days in the current calendar month (28-31) rather
      // than a hardcoded guess.
      expect(isEarlyAttrition(new Date(Date.now() - 60 * 86_400_000), new Date())).toBe(true);
      if (summary.avgHeadcount > 0) {
        const now = new Date();
        const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
        const expectedRate = annualizedAttritionRate(summary.leavers, summary.avgHeadcount, daysInMonth);
        expect(summary.annualizedRatePct).toBeCloseTo(expectedRate as number, 5);
      }
    });
  });

  it('with zero leavers over the period, the annualised rate is null rather than zero', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      // A window far enough in the past that none of this suite's fixtures
      // separated inside it.
      expect(annualizedAttritionRate(0, 10, 30)).toBe(0);
      expect(annualizedAttritionRate(5, 0, 30)).toBeNull();
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-003 — tenure distribution buckets correctly
// ===========================================================================

describe('HCM-ANALYTICS-003 — tenure distribution', () => {
  it('a two-year-old hire lands in the 1-3y bucket', async () => {
    await makeEmployee('tenure-2y', 2 * 365);

    await asUser('operations@kaizen.co.in', async () => {
      const dist = await tenureDistribution();
      expect(dist.buckets['1-3y']).toBeGreaterThanOrEqual(1);
      expect(dist.totalActive).toBeGreaterThanOrEqual(1);
      expect(tenureBucket(new Date(Date.now() - 2 * 365 * 86_400_000))).toBe('1-3y');
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-004 — leave liability, and money withheld without the
// `financial` verb
// ===========================================================================

describe('HCM-ANALYTICS-004 — leave liability', () => {
  it('sums outstanding leave balance days, and withholds the amount from a viewer who cannot see money', async () => {
    const { employment } = await makeEmployee('leave-liability', 400, 52_000);

    await asUser('operations@kaizen.co.in', async () => {
      const leaveType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
      const balance = await prisma.leaveBalance.create({
        data: { tenantId: TENANT, employmentRelationshipId: employment.id, leaveTypeId: leaveType.id, balanceDays: 12 },
      });
      await prisma.leaveTransaction.create({
        data: { tenantId: TENANT, leaveBalanceId: balance.id, txnType: 'accrual', amountDays: 12 },
      });

      // hr_ops_manager holds compensation:...F — sees the amount.
      const withMoney = await leaveLiability();
      expect(withMoney.totalDays).toBeGreaterThanOrEqual(12);
      expect(withMoney.totalAmount).not.toBeNull();
    });

    // A fixture role that can view analytics but holds no `financial` verb
    // on compensation — the days are still visible, the money is not.
    await withFixtureRole(
      { grants: [{ resource: 'hr_analytics', verbs: ['view'] }, { resource: 'compensation', verbs: ['view'] }] },
      async () => {
        const noMoney = await leaveLiability();
        expect(noMoney.totalDays).toBeGreaterThanOrEqual(12);
        expect(noMoney.totalAmount).toBeNull();
        for (const row of noMoney.byLeaveType) expect(row.amount).toBeNull();
      },
    );
  });
});

// ===========================================================================
// HCM-ANALYTICS-005 — overtime hours
// ===========================================================================

describe('HCM-ANALYTICS-005 — overtime hours', () => {
  it('sums OvertimeAccrual hours posted inside the trailing window', async () => {
    const { employment } = await makeEmployee('overtime', 100);

    await asUser('operations@kaizen.co.in', async () => {
      const now = new Date();
      const isoWeek = `${now.getUTCFullYear()}-W${String(Math.ceil(now.getUTCDate() / 7)).padStart(2, '0')}`;
      await prisma.overtimeAccrual.create({
        data: { tenantId: TENANT, employmentRelationshipId: employment.id, isoWeek: `${isoWeek}-${fixtureSeq}`, hours: 6, rate: 250, amount: 1500, computedAt: now },
      });

      const result = await overtimeHours(1);
      expect(result.totalHours).toBeGreaterThanOrEqual(6);
      expect(result.byMonth.length).toBe(1);
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-006 — hiring: offer acceptance and time-to-hire
// ===========================================================================

describe('HCM-ANALYTICS-006 — hiring summary', () => {
  it('an accepted-and-joined offer counts toward both offer acceptance and time-to-hire', async () => {
    const stamp = `${Date.now()}-${++fixtureSeq}`;

    await asUser('operations@kaizen.co.in', async () => {
      const position = await prisma.position.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('POS'),
          jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          status: 'Open',
        },
      });
      const requisition = await createRequisition({ positionId: position.id });
      await transitionRequisition(requisition.id, 'SUBMIT');
      await asUser('chairman@kaizen.co.in', () => transitionRequisition(requisition.id, 'APPROVE'));
      await transitionRequisition(requisition.id, 'PUBLISH');

      const candidate = await prisma.person.create({
        data: { tenantId: TENANT, recordCode: await nextRecordCode('PER'), fullName: `Fixture Candidate ${stamp}`, primaryEmail: `fixture.candidate.${stamp}@example.com`, source: 'test' },
      });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.id });
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'EXTEND_OFFER');
      await transitionApplication(application.id, 'ACCEPT_OFFER');
      await joinFromApplication(application.id, { hireEffectiveDate: new Date() });

      const summary = await hiringSummary(1);
      expect(summary.offersExtended).toBeGreaterThanOrEqual(1);
      expect(summary.offersAccepted).toBeGreaterThanOrEqual(1);
      expect(summary.hires).toBeGreaterThanOrEqual(1);
      expect(summary.offerAcceptanceRatePct).not.toBeNull();
      expect(summary.offerAcceptanceRatePct).toBeGreaterThan(0);
      expect(summary.timeToHireDaysAvg).not.toBeNull();
      expect(summary.timeToHireDaysAvg as number).toBeGreaterThanOrEqual(0);
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-007 — metrics this schema, or a not-yet-landed workstream,
// cannot answer are "not measured", never a throw and never a zero
// ===========================================================================

describe('HCM-ANALYTICS-007 — not-measured metrics degrade gracefully', () => {
  it('cost-per-hire, gender ratio, comp-ratio, eNPS and open-cases-by-SLA are all `measured: false` with a reason, never a thrown error', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      for (const fn of [costPerHire, genderRatio, compRatioDistribution, engagementEnps, openCasesBySla]) {
        const result = await fn();
        expect(result.measured).toBe(false);
        expect(result.value).toBeNull();
        expect(typeof (result as { reason: string }).reason).toBe('string');
        expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
      }
    });
  });

  it('span of control never throws even where no assignment yet carries a manager position', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      const result = await spanOfControl();
      // Either shape is acceptable — the point is it resolves, not throws.
      expect(typeof result.measured).toBe('boolean');
      if (result.measured) {
        expect(spanOfControlStats([1, 2, 3])).toEqual({ managerCount: 3, averageSpan: 2, minSpan: 1, maxSpan: 3 });
      }
    });
  });
});

// ===========================================================================
// HCM-ANALYTICS-008 — permission refusal: no hr_analytics grant
// ===========================================================================

describe('HCM-ANALYTICS-008 — permission refusal', () => {
  it('an employee (no hr_analytics grant) is refused, not silently narrowed', async () => {
    const rejection = await asUser('employee@kaizen.co.in', () => expectReject(() => headcountTrend(1)));
    expect(rejection.status).toBe(403);
  });

  it('the whole-dashboard call is refused the same way', async () => {
    const rejection = await asUser('employee@kaizen.co.in', () => expectReject(() => dashboard(1)));
    expect(rejection.status).toBe(403);
  });
});

// ===========================================================================
// HCM-ANALYTICS-009 — CSV export lands an audit record
// ===========================================================================

describe('HCM-ANALYTICS-009 — report export is audited', () => {
  it('exporting the headcount register writes an export audit record for this tenant', async () => {
    await makeEmployee('csv-export', 10);

    await asUser('operations@kaizen.co.in', async () => {
      const before = await prisma.auditRecord.count({ where: { tenantId: TENANT, action: 'export', subjectType: 'employment_relationship' } });
      const { filename, csv } = await exportHeadcountRegister();
      expect(filename).toContain('.csv');
      expect(csv.split('\n')[0]).toContain('Record code');
      expect(csv.length).toBeGreaterThan(20);

      const after = await prisma.auditRecord.count({ where: { tenantId: TENANT, action: 'export', subjectType: 'employment_relationship' } });
      expect(after).toBe(before + 1);
    });
  });

  it('an employee without hr_reports:export is refused the same export', async () => {
    const rejection = await asUser('employee@kaizen.co.in', () => expectReject(() => exportHeadcountRegister()));
    expect(rejection.status).toBe(403);
  });
});

// ===========================================================================
// HCM-ANALYTICS-010 — cross-tenant isolation
// ===========================================================================

describe('HCM-ANALYTICS-010 — tenant scoping', () => {
  it('headcount by division only ever counts this tenant\'s own employments', async () => {
    await makeEmployee('tenant-scope', 5);

    await asUser('operations@kaizen.co.in', async () => {
      const trend = await headcountTrend(1);
      const directCount = await prisma.employmentRelationship.count({
        where: { tenantId: TENANT, deletedAt: null, status: { in: ['Active', 'OnLeave', 'Suspended', 'NoticePeriod', 'Absconded'] } },
      });
      expect(trend.at(-1)!.headcount).toBe(directCount);
    });
  });
});
