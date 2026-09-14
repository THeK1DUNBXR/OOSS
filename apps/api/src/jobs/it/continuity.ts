/**
 * Technology — continuity and operations jobs (docs/plan/cio.md, workstream H).
 *
 * Three detectors, run daily:
 *
 *  1. DR-test overdue ladder, by each plan's own cadence — rungs at -7
 *     (a week out), 0 (due today) and +30 (a month overdue) days past
 *     `lastTestedAt + testCadenceDays`. Idempotent per rung, the row itself
 *     carrying `testOverdueNotifiedRungs` the same way the compliance
 *     calendar's `notifiedRungs` does.
 *  2. Tier-1/2 application without an ACTIVE plan — two sources, deduplicated
 *     by application id so an application caught by both raises one
 *     exception, not two: every active, tier-1/2 `ItApplication`
 *     (workstream B's catalogue, `it-software.prisma`) with no matching
 *     `ItContinuityPlan` in `active` status by `applicationId`; and, for a
 *     plan whose application row does not exist in the catalogue (or the
 *     catalogue is not seeded yet), a continuity plan for a tier-1/2
 *     application sitting in `draft` or `retired` rather than `active`.
 *  3. A maintenance window starting within 24 hours that has not yet
 *     notified its owner — stamps `notifiedAt` once.
 */

import { EVENTS, IT_DOMAIN, testOverdueRung } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import { emit } from '../../platform/eventBus.js';
import { resolveOperationsHeadPartyId } from '../../domains/it/continuity.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

export async function runContinuityTestOverdueJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  const now = new Date();

  const plans = await prisma.itContinuityPlan.findMany({ where: { tenantId: auth.tenantId, status: 'active', deletedAt: null } });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const plan of plans) {
    const rung = testOverdueRung(plan.lastTestedAt, plan.testCadenceDays, now);
    if (rung === undefined) continue;

    const already = plan.testOverdueNotifiedRungs ?? [];
    if (already.includes(rung)) {
      skippedIdempotent += 1;
      continue;
    }

    try {
      await raiseException({
        code: 'IT_DR_TEST_OVERDUE',
        label: rung >= 0 ? `${plan.applicationName} DR test overdue` : `${plan.applicationName} DR test due soon`,
        severity: rung >= 30 ? 'S4_CRITICAL' : rung >= 0 ? 'S3_HIGH_RISK' : 'S2_WARNING',
        subjectType: 'it_continuity_plan',
        subjectId: plan.id,
        subjectLabel: plan.recordCode,
        domain: IT_DOMAIN,
        detail: plan.lastTestedAt
          ? `${plan.recordCode} (${plan.applicationName}) was last tested ${plan.lastTestedAt.toISOString().slice(0, 10)} on a ${plan.testCadenceDays}-day cadence.`
          : `${plan.recordCode} (${plan.applicationName}) has never recorded a DR test.`,
        ownerPartyId: plan.ownerPartyId,
        triggerFingerprint: 'it_continuity_test_overdue',
        ladderRung: rung,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    await prisma.itContinuityPlan.update({
      where: { id: plan.id },
      data: { testOverdueNotifiedRungs: [...new Set([...already, rung])] },
    });
  }

  return { processed: plans.length, notified, skippedIdempotent, errors };
}

interface NoPlanTarget {
  applicationId: string;
  applicationName: string;
  applicationTier: number;
  ownerPartyId: string | null;
  detail: string;
}

export async function runContinuityNoPlanJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];

  const [applications, activePlans, unhealthyPlans] = await Promise.all([
    prisma.itApplication.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, status: 'active', tier: { lte: 2 } },
    }),
    prisma.itContinuityPlan.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, status: 'active' },
      select: { applicationId: true },
    }),
    // The plan-sourced case: a plan exists but sits in draft/retired rather
    // than active — kept alongside the catalogue-driven case above for an
    // application whose catalogue row does not exist (or is not yet seeded).
    prisma.itContinuityPlan.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, applicationTier: { lte: 2 }, status: { in: ['draft', 'retired'] } },
    }),
  ]);

  const activePlanAppIds = new Set(activePlans.map((p) => p.applicationId));
  const targets = new Map<string, NoPlanTarget>();

  for (const app of applications) {
    if (activePlanAppIds.has(app.id)) continue;
    targets.set(app.id, {
      applicationId: app.id,
      applicationName: app.name,
      applicationTier: app.tier,
      ownerPartyId: app.ownerPartyId,
      detail: `${app.recordCode ?? app.name} (tier ${app.tier}) is active in the application catalogue but has no active continuity plan.`,
    });
  }
  for (const plan of unhealthyPlans) {
    if (activePlanAppIds.has(plan.applicationId) || targets.has(plan.applicationId)) continue;
    targets.set(plan.applicationId, {
      applicationId: plan.applicationId,
      applicationName: plan.applicationName,
      applicationTier: plan.applicationTier,
      ownerPartyId: plan.ownerPartyId,
      detail: `${plan.recordCode} names ${plan.applicationName} (tier ${plan.applicationTier}) but is ${plan.status}, not active. A tier-1/2 application needs a tested, active continuity plan.`,
    });
  }

  let notified = 0;
  for (const target of targets.values()) {
    try {
      await raiseException({
        code: 'IT_DR_NO_PLAN',
        label: `${target.applicationName} (tier ${target.applicationTier}) has no active continuity plan`,
        severity: target.applicationTier === 1 ? 'S3_HIGH_RISK' : 'S2_WARNING',
        subjectType: 'it_application',
        subjectId: target.applicationId,
        subjectLabel: target.applicationName,
        domain: IT_DOMAIN,
        detail: target.detail,
        ownerPartyId: target.ownerPartyId,
        triggerFingerprint: 'it_continuity_no_active_plan',
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: targets.size, notified, skippedIdempotent: 0, errors };
}

export async function runMaintenanceWindowNoticeJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const windows = await prisma.itMaintenanceWindow.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'planned',
      notifiedAt: null,
      startsAt: { gte: now, lte: horizon },
    },
  });

  let notified = 0;
  const ownerPartyId = await resolveOperationsHeadPartyId();

  for (const window of windows) {
    try {
      await raiseException({
        code: 'IT_MAINTENANCE_WINDOW_SOON',
        label: `${window.applicationName} maintenance window starts within 24 hours`,
        severity: 'S1_ATTENTION',
        subjectType: 'it_maintenance_window',
        subjectId: window.id,
        subjectLabel: window.recordCode,
        domain: IT_DOMAIN,
        detail: `${window.recordCode}: ${window.applicationName} goes into maintenance at ${window.startsAt.toISOString()} — ${window.reason}.`,
        ownerPartyId,
        triggerFingerprint: 'it_maintenance_window_notice',
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    const stamped = await prisma.itMaintenanceWindow.update({ where: { id: window.id }, data: { notifiedAt: now } });
    await emit({
      name: EVENTS.IT_MAINTENANCE_SCHEDULED,
      subject: { entityType: 'it_maintenance_window', entityId: window.id, recordCode: window.recordCode },
      newState: { notifiedAt: stamped.notifiedAt },
      impact: { domains: [IT_DOMAIN] },
    });
  }

  return { processed: windows.length, notified, skippedIdempotent: 0, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runContinuityTestOverdueJob',
    label: 'Continuity: DR-test overdue ladder (-7/0/+30 days) (IT-DR)',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: runContinuityTestOverdueJob,
  },
  {
    name: 'runContinuityNoPlanJob',
    label: 'Continuity: tier-1/2 application without an active plan (IT-DR)',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: runContinuityNoPlanJob,
  },
  {
    name: 'runMaintenanceWindowNoticeJob',
    label: 'Continuity: maintenance window starting within 24h, owner not yet notified',
    automationClass: 'threshold_response',
    cron: '*/30 * * * *',
    run: runMaintenanceWindowNoticeJob,
  },
];
