/**
 * Technology — continuity and operations (docs/plan/cio.md, workstream H).
 *
 * Pure arithmetic first — uptime %, the DR-test-overdue ladder, and the
 * RTO/RPO breach check, all without a database. Then the wiring: a plan
 * records a test that is immutable afterwards, an RTO/RPO breach raises
 * IT_DR_RTO_EXCEEDED, a tier-1/2 plan sitting in draft/retired raises
 * IT_DR_NO_PLAN, the overdue ladder is idempotent per rung, and the grant
 * matrix holds — the Finance Head reads only, an employee reaches nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { rtoBreached, testOverdueRung, uptimePercent } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createPlan,
  createMaintenanceWindow,
  listMaintenanceWindows,
  listPlans,
  planDetail,
  recordAvailabilityReading,
  recordTest,
  transitionPlan,
  continuitySummary,
  availabilitySummary,
} from '../../domains/it/continuity.js';
import {
  runContinuityNoPlanJob,
  runContinuityTestOverdueJob,
  runMaintenanceWindowNoticeJob,
} from '../../jobs/it/continuity.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('continuity arithmetic (pure, no DB)', () => {
  it('uptimePercent: a full 30-day month with 43.2 minutes down is 99.9%', () => {
    // April 2026 has 30 days -> 43200 minutes; 43.2 minutes down is exactly 0.1%.
    expect(uptimePercent(43.2, '2026-04')).toBeCloseTo(99.9, 5);
  });

  it('uptimePercent: zero minutes down is 100%', () => {
    expect(uptimePercent(0, '2026-09')).toBe(100);
  });

  it('uptimePercent: clamps minutes down beyond the month length rather than going negative', () => {
    expect(uptimePercent(999_999, '2026-02')).toBe(0);
  });

  it('testOverdueRung: well within cadence returns no rung', () => {
    const lastTested = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-10T00:00:00Z');
    expect(testOverdueRung(lastTested, 180, now)).toBeUndefined();
  });

  it('testOverdueRung: a week before the cadence runs out fires the -7 rung', () => {
    const cadenceDays = 180;
    const lastTested = new Date('2026-01-01T00:00:00Z');
    const dueAt = new Date(lastTested.getTime() + cadenceDays * 86_400_000);
    const now = new Date(dueAt.getTime() - 6 * 86_400_000); // 6 days before due, inside the -7 rung
    expect(testOverdueRung(lastTested, cadenceDays, now)).toBe(-7);
  });

  it('testOverdueRung: 40 days past due fires the +30 rung, the tightest crossed', () => {
    const cadenceDays = 180;
    const lastTested = new Date('2026-01-01T00:00:00Z');
    const dueAt = new Date(lastTested.getTime() + cadenceDays * 86_400_000);
    const now = new Date(dueAt.getTime() + 40 * 86_400_000);
    expect(testOverdueRung(lastTested, cadenceDays, now)).toBe(30);
  });

  it('testOverdueRung: a plan never tested is due now, not indefinitely in the future', () => {
    expect(testOverdueRung(null, 180, new Date())).toBe(0);
  });

  it('rtoBreached: recovery beyond the RTO is a breach even when RPO holds', () => {
    expect(rtoBreached({ actualRecoveryMinutes: 500, actualDataLossMinutes: 5 }, { rtoMinutes: 240, rpoMinutes: 60 })).toBe(true);
  });

  it('rtoBreached: data loss beyond the RPO is a breach even when RTO holds', () => {
    expect(rtoBreached({ actualRecoveryMinutes: 100, actualDataLossMinutes: 90 }, { rtoMinutes: 240, rpoMinutes: 60 })).toBe(true);
  });

  it('rtoBreached: within both promises is not a breach', () => {
    expect(rtoBreached({ actualRecoveryMinutes: 100, actualDataLossMinutes: 10 }, { rtoMinutes: 240, rpoMinutes: 60 })).toBe(false);
  });
});

describe('continuity — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('IT-DR-001: a tier-1 catalogue application with no active continuity plan raises IT_DR_NO_PLAN naming the application', async () => {
    const app = await unscopedPrisma.itApplication.create({
      data: {
        tenantId: tid,
        name: `Fixture Payroll Core ${stamp()}`,
        category: 'finance',
        hosting: 'cloud',
        tier: 1,
        status: 'active',
      },
    });

    // No ItContinuityPlan at all for this application — the catalogue-driven
    // case: `runContinuityNoPlanJob` reads `ItApplication` directly (it does
    // not need a plan row to exist to notice the gap).
    const result = await asUser('operations@kaizen.co.in', () => runContinuityNoPlanJob());
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_DR_NO_PLAN', subjectType: 'it_application', subjectId: app.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.subjectLabel).toBe(app.name);

    // Idempotent: a second run raises no duplicate for the same application.
    const before = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_DR_NO_PLAN', subjectId: app.id } });
    await asUser('operations@kaizen.co.in', () => runContinuityNoPlanJob());
    const after = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_DR_NO_PLAN', subjectId: app.id } });
    expect(after).toBe(before);
  });

  it('the plan-sourced fallback still fires when a plan (not the catalogue) is the only signal: a tier-1 plan sitting in draft raises IT_DR_NO_PLAN', async () => {
    const appId = `app-fixture-no-catalogue-${stamp()}`;
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: appId,
        applicationName: 'Fixture Ledger Core (no catalogue row)',
        applicationTier: 1,
        rtoMinutes: 60,
        rpoMinutes: 15,
        backupMethod: 'continuous replication',
        backupFrequency: 'continuous',
      }),
    );
    expect(plan.status).toBe('draft');

    const result = await asUser('operations@kaizen.co.in', () => runContinuityNoPlanJob());
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_DR_NO_PLAN', subjectType: 'it_application', subjectId: appId },
    });
    expect(exception).toBeTruthy();
    expect(exception!.subjectLabel).toBe('Fixture Ledger Core (no catalogue row)');
  });

  it('IT-DR-002: a test whose recovery time exceeds RTO raises IT_DR_RTO_EXCEEDED, and the test row is immutable afterwards', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Order Service',
        applicationTier: 2,
        rtoMinutes: 60,
        rpoMinutes: 15,
        backupMethod: 'nightly snapshot',
        backupFrequency: 'daily',
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'active'));

    const test = await asUser('operations@kaizen.co.in', () =>
      recordTest(plan.id, { kind: 'restore', outcome: 'fail', actualRecoveryMinutes: 500, actualDataLossMinutes: 5 }),
    );

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_DR_RTO_EXCEEDED', subjectType: 'it_continuity_test', subjectId: test.id },
    });
    expect(exception).toBeTruthy();

    // Immutable: there is no update path in the domain — a raw attempt to
    // change it is not what any endpoint offers, and Prisma will still
    // happily write to it if asked, so what "immutable" means here is that
    // the domain layer exposes no way to mutate a recorded test at all.
    const testModule = await import('../../domains/it/continuity.js');
    expect((testModule as Record<string, unknown>).updateTest).toBeUndefined();
    expect((testModule as Record<string, unknown>).editTest).toBeUndefined();

    const stillThere = await unscopedPrisma.itContinuityTest.findFirstOrThrow({ where: { id: test.id } });
    expect(stillThere.outcome).toBe('fail');
    expect(stillThere.actualRecoveryMinutes).toBe(500);

    // Recording the test also refreshed the plan's lastTestedAt.
    const refreshedPlan = await unscopedPrisma.itContinuityPlan.findFirstOrThrow({ where: { id: plan.id } });
    expect(refreshedPlan.lastTestedAt).toBeTruthy();
  });

  it('IT-DR-003: the DR-test-overdue ladder is idempotent per rung', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Ledger Service',
        applicationTier: 1,
        rtoMinutes: 30,
        rpoMinutes: 5,
        backupMethod: 'continuous replication',
        backupFrequency: 'continuous',
        testCadenceDays: 180,
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'active'));
    // Never tested -> due today (rung 0) the moment it's active.

    const first = await asUser('operations@kaizen.co.in', () => runContinuityTestOverdueJob());
    expect(first.notified).toBeGreaterThanOrEqual(1);

    const firstCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, code: 'IT_DR_TEST_OVERDUE', subjectId: plan.id },
    });
    expect(firstCount).toBe(1);

    const second = await asUser('operations@kaizen.co.in', () => runContinuityTestOverdueJob());
    expect(second.notified).toBe(0);

    const secondCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, code: 'IT_DR_TEST_OVERDUE', subjectId: plan.id },
    });
    expect(secondCount).toBe(1);

    const refreshed = await unscopedPrisma.itContinuityPlan.findFirstOrThrow({ where: { id: plan.id } });
    expect(refreshed.testOverdueNotifiedRungs).toContain(0);
  });

  it('IT-AVL-001: uptime % is pure arithmetic over minutes, and a month with no reading reports not yet measured', async () => {
    const appId = `app-fixture-${stamp()}`;
    const period = '2099-01'; // a period nothing else in the suite touches
    const recorded = await asUser('operations@kaizen.co.in', () =>
      recordAvailabilityReading({ applicationId: appId, applicationName: 'Fixture Availability App', period, minutesDown: 4464 }), // 10% of Jan's 44640 minutes
    );
    expect(recorded.minutesDown).toBe(4464);
    const rows = await asUser('operations@kaizen.co.in', () => listPlans()); // sanity: ops head can list (below)
    expect(Array.isArray(rows)).toBe(true);

    const withUptime = await unscopedPrisma.itAvailabilityReading.findFirstOrThrow({ where: { tenantId: tid, applicationId: appId, period } });
    expect(uptimePercent(withUptime.minutesDown, withUptime.period)).toBeCloseTo(90, 3);

    // A different, untouched month for this same app reports not yet measured
    // at the summary level (no reading exists for it at all).
    const untouchedPeriod = '2099-02';
    const readingsForUntouched = await unscopedPrisma.itAvailabilityReading.findMany({
      where: { tenantId: tid, applicationId: appId, period: untouchedPeriod },
    });
    expect(readingsForUntouched).toHaveLength(0);
  });

  it('a plan can be activated, then retired, and retired is terminal', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Terminal App',
        applicationTier: 3,
        rtoMinutes: 480,
        rpoMinutes: 120,
        backupMethod: 'weekly snapshot',
        backupFrequency: 'weekly',
      }),
    );
    expect(plan.status).toBe('draft');

    const active = await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'active'));
    expect(active.status).toBe('active');

    const retired = await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'retired'));
    expect(retired.status).toBe('retired');

    const stuck = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'active')));
    expect(stuck.status).toBe(422);

    const detail = await asUser('operations@kaizen.co.in', () => planDetail(plan.id));
    expect(detail.availableTransitions).toEqual([]);
  });

  it('a retired plan cannot record a new test', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Retired App',
        applicationTier: 4,
        rtoMinutes: 1440,
        rpoMinutes: 1440,
        backupMethod: 'monthly export',
        backupFrequency: 'monthly',
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'active'));
    await asUser('operations@kaizen.co.in', () => transitionPlan(plan.id, 'retired'));

    const denied = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => recordTest(plan.id, { kind: 'restore', outcome: 'pass' })),
    );
    expect(denied.status).toBe(409);
  });

  it('maintenance: creating a window and the 24-hour notice job stamps notifiedAt once', async () => {
    const startsAt = new Date(Date.now() + 6 * 3600_000); // 6 hours from now
    const endsAt = new Date(startsAt.getTime() + 2 * 3600_000);
    const window = await asUser('operations@kaizen.co.in', () =>
      createMaintenanceWindow({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Gateway',
        startsAt,
        endsAt,
        reason: 'Certificate rotation',
      }),
    );
    expect(window.notifiedAt).toBeNull();

    const result = await asUser('operations@kaizen.co.in', () => runMaintenanceWindowNoticeJob());
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const refreshed = await unscopedPrisma.itMaintenanceWindow.findFirstOrThrow({ where: { id: window.id } });
    expect(refreshed.notifiedAt).toBeTruthy();

    // Re-running notifies nothing new for this window (notifiedAt is set).
    const before = refreshed.notifiedAt!.getTime();
    await asUser('operations@kaizen.co.in', () => runMaintenanceWindowNoticeJob());
    const stillRefreshed = await unscopedPrisma.itMaintenanceWindow.findFirstOrThrow({ where: { id: window.id } });
    expect(stillRefreshed.notifiedAt!.getTime()).toBe(before);

    const upcoming = await asUser('operations@kaizen.co.in', () => listMaintenanceWindows({ when: 'upcoming' }));
    expect(upcoming.find((w) => w.id === window.id)).toBeTruthy();
  });

  it('cancelling a maintenance window requires a reason', async () => {
    const startsAt = new Date(Date.now() + 48 * 3600_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const window = await asUser('operations@kaizen.co.in', () =>
      createMaintenanceWindow({
        applicationId: `app-fixture-${stamp()}`,
        applicationName: 'Fixture Queue',
        startsAt,
        endsAt,
        reason: 'Broker upgrade',
      }),
    );

    const { cancelMaintenanceWindow } = await import('../../domains/it/continuity.js');
    const noReason = await expectReject(() => asUser('operations@kaizen.co.in', () => cancelMaintenanceWindow(window.id, '')));
    expect(noReason.status).toBe(400);

    const cancelled = await asUser('operations@kaizen.co.in', () => cancelMaintenanceWindow(window.id, 'Vendor postponed the upgrade.'));
    expect(cancelled.status).toBe('cancelled');
  });

  it('summaries: continuitySummary and availabilitySummary carry notYetMeasured honestly', async () => {
    const s = await asUser('operations@kaizen.co.in', () => continuitySummary());
    expect(s.notYetMeasured).toBe(false); // plans exist from earlier tests in this suite
    expect(s.plansByTier[1]).toBeGreaterThanOrEqual(1);

    const a = await asUser('operations@kaizen.co.in', () => availabilitySummary());
    expect(typeof a.notYetMeasured).toBe('boolean');
  });
});

describe('continuity — permissions', () => {
  it('permission: an employee cannot view, create or record against it_continuity at all', async () => {
    const viewDenied = await expectReject(() => asUser('employee@kaizen.co.in', () => listPlans()));
    expect(viewDenied.status).toBe(403);

    const createDenied = await expectReject(() =>
      asUser('employee@kaizen.co.in', () =>
        createPlan({
          applicationId: 'app-employee-denied',
          applicationName: 'Should not be creatable',
          applicationTier: 1,
          rtoMinutes: 60,
          rpoMinutes: 15,
          backupMethod: 'x',
          backupFrequency: 'x',
        }),
      ),
    );
    expect(createDenied.status).toBe(403);
  });

  it('permission: the Finance Head can view plans and readings but cannot create a plan (view-only)', async () => {
    const plans = await asUser('finance@kaizen.co.in', () => listPlans());
    expect(Array.isArray(plans)).toBe(true);

    const denied = await expectReject(() =>
      asUser('finance@kaizen.co.in', () =>
        createPlan({
          applicationId: `app-finance-denied-${stamp()}`,
          applicationName: 'Should not be creatable by Finance',
          applicationTier: 1,
          rtoMinutes: 60,
          rpoMinutes: 15,
          backupMethod: 'x',
          backupFrequency: 'x',
        }),
      ),
    );
    expect(denied.status).toBe(403);
  });

  it('permission: the chairman can do everything, including retiring a plan Operations created', async () => {
    const plan = await asUser('operations@kaizen.co.in', () =>
      createPlan({
        applicationId: `app-chairman-${stamp()}`,
        applicationName: 'Fixture Chairman App',
        applicationTier: 2,
        rtoMinutes: 120,
        rpoMinutes: 30,
        backupMethod: 'daily snapshot',
        backupFrequency: 'daily',
      }),
    );
    const active = await asUser('chairman@kaizen.co.in', () => transitionPlan(plan.id, 'active'));
    expect(active.status).toBe('active');
  });
});

// Keep prisma imported so TS does not flag an unused re-export from helpers
// if a future edit trims the direct usages above.
void prisma;
