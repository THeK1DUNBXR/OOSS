/**
 * Technology — continuity and operations (docs/plan/cio.md, workstream H).
 *
 * `BackupRun` (main.prisma) is the platform's own backup log. This is the
 * business's: which application must be back in how long (RTO/RPO), whether
 * the last drill actually hit that number, how reliable an application has
 * been this month, and when it next goes dark for maintenance.
 *
 * The application catalogue (workstream B's `ItApplication`) lives in
 * another schema file this file cannot see or join at query time (the
 * builder brief: cross-workstream references are bare ids, relations only
 * within a workstream's own file, and this file must compile whether or not
 * `it-applications.prisma` exists yet). `applicationName`/`applicationTier`
 * are therefore typed in and snapshotted on the plan at creation, so tier-1
 * detection (`IT_DR_NO_PLAN`) and every screen work standalone. Resolving a
 * plan's application against the live catalogue — to pick up a renamed
 * application or a tier that changed after the plan was written — is
 * integration work for workstream I (the overview) or a later pass; this
 * file only ever reads its own snapshot.
 */

import {
  EVENTS,
  IT_DOMAIN,
  defaultTestCadenceDays,
  itContinuityPlanMachine,
  rtoBreached,
  testOverdueRung,
  uptimePercent,
  type ContinuityPlanEvent,
  type ContinuityPlanStatus,
  type ContinuitySummary,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { availableTransitions, transition as lifecycleTransition } from '../../platform/lifecycle.js';

registerGovernedEntities('it_continuity', [
  'it_continuity_plan',
  'it_continuity_test',
  'it_availability_reading',
  'it_maintenance_window',
]);

const RESOURCE = 'it_continuity' as const;

/** Resolves the Operations Head — the desk that owns maintenance windows and
 * continuity plans generally — by looking up the active affiliation carrying
 * that role. Data, never a role-slug branch in a conditional (the brief's
 * "no role-slug comparisons" rule): this is the same lookup-by-role-slug
 * shape `resolveOwnerPartyId` uses in `domains/compliance/calendar.ts`. */
async function resolveOperationsHeadPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

// ---------------------------------------------------------------------------
// Continuity plans
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  applicationId: string;
  applicationName: string;
  applicationTier: number;
  rtoMinutes: number;
  rpoMinutes: number;
  backupMethod: string;
  backupFrequency: string;
  restoreProcedureDocumentId?: string | null;
  ownerPartyId?: string | null;
  testCadenceDays?: number | null;
  note?: string | null;
}

function validatePlanInput(input: CreatePlanInput) {
  if (!input.applicationId?.trim()) throw ApiError.badRequest('A continuity plan needs an applicationId.');
  if (!input.applicationName?.trim()) throw ApiError.badRequest('A continuity plan needs the application\'s name — this file cannot look it up from the catalogue.');
  if (!Number.isInteger(input.applicationTier) || input.applicationTier < 1 || input.applicationTier > 4) {
    throw ApiError.badRequest('applicationTier must be 1 (critical) through 4 (low).');
  }
  if (!Number.isInteger(input.rtoMinutes) || input.rtoMinutes <= 0) throw ApiError.badRequest('rtoMinutes must be a positive number of minutes.');
  if (!Number.isInteger(input.rpoMinutes) || input.rpoMinutes <= 0) throw ApiError.badRequest('rpoMinutes must be a positive number of minutes.');
  if (!input.backupMethod?.trim()) throw ApiError.badRequest('A continuity plan needs a backup method.');
  if (!input.backupFrequency?.trim()) throw ApiError.badRequest('A continuity plan needs a backup frequency.');
}

export async function createPlan(input: CreatePlanInput) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'create' });
  validatePlanInput(input);

  const cadence = input.testCadenceDays && input.testCadenceDays > 0 ? input.testCadenceDays : defaultTestCadenceDays(input.applicationTier);
  const recordCode = await nextRecordCode('DRP');

  const plan = await prisma.itContinuityPlan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      applicationId: input.applicationId.trim(),
      applicationName: input.applicationName.trim(),
      applicationTier: input.applicationTier,
      rtoMinutes: input.rtoMinutes,
      rpoMinutes: input.rpoMinutes,
      backupMethod: input.backupMethod.trim(),
      backupFrequency: input.backupFrequency.trim(),
      restoreProcedureDocumentId: input.restoreProcedureDocumentId ?? null,
      ownerPartyId: input.ownerPartyId ?? null,
      testCadenceDays: cadence,
      status: 'draft',
      note: input.note ?? null,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_continuity_plan',
    subjectId: plan.id,
    after: { recordCode, applicationId: plan.applicationId, applicationTier: plan.applicationTier, status: plan.status },
  });
  await emit({
    name: EVENTS.IT_CONTINUITY_PLAN_SET,
    subject: { entityType: 'it_continuity_plan', entityId: plan.id, recordCode },
    newState: { status: plan.status, applicationId: plan.applicationId, rtoMinutes: plan.rtoMinutes, rpoMinutes: plan.rpoMinutes },
    impact: { domains: [IT_DOMAIN] },
  });

  return plan;
}

export interface UpdatePlanInput {
  rtoMinutes?: number;
  rpoMinutes?: number;
  backupMethod?: string;
  backupFrequency?: string;
  restoreProcedureDocumentId?: string | null;
  ownerPartyId?: string | null;
  testCadenceDays?: number;
  note?: string | null;
}

export async function updatePlan(id: string, input: UpdatePlanInput) {
  const auth = currentAuth();
  const plan = await prisma.itContinuityPlan.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!plan) throw ApiError.notFound('Continuity plan');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: plan.ownerPartyId } });

  if (input.rtoMinutes !== undefined && (!Number.isInteger(input.rtoMinutes) || input.rtoMinutes <= 0)) {
    throw ApiError.badRequest('rtoMinutes must be a positive number of minutes.');
  }
  if (input.rpoMinutes !== undefined && (!Number.isInteger(input.rpoMinutes) || input.rpoMinutes <= 0)) {
    throw ApiError.badRequest('rpoMinutes must be a positive number of minutes.');
  }

  const updated = await prisma.itContinuityPlan.update({
    where: { id },
    data: {
      ...(input.rtoMinutes !== undefined ? { rtoMinutes: input.rtoMinutes } : {}),
      ...(input.rpoMinutes !== undefined ? { rpoMinutes: input.rpoMinutes } : {}),
      ...(input.backupMethod !== undefined ? { backupMethod: input.backupMethod } : {}),
      ...(input.backupFrequency !== undefined ? { backupFrequency: input.backupFrequency } : {}),
      ...(input.restoreProcedureDocumentId !== undefined ? { restoreProcedureDocumentId: input.restoreProcedureDocumentId } : {}),
      ...(input.ownerPartyId !== undefined ? { ownerPartyId: input.ownerPartyId } : {}),
      ...(input.testCadenceDays !== undefined ? { testCadenceDays: input.testCadenceDays } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_continuity_plan', subjectId: id, before: plan, after: updated });
  await emit({
    name: EVENTS.IT_CONTINUITY_PLAN_SET,
    subject: { entityType: 'it_continuity_plan', entityId: id, recordCode: plan.recordCode },
    newState: { status: updated.status, rtoMinutes: updated.rtoMinutes, rpoMinutes: updated.rpoMinutes },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

/** Past-tense verb per event, for the event name `kz.it.continuity_plan.<verb>`
 * `transition` (platform/lifecycle.ts) builds from `itContinuityPlanMachine`. */
const PLAN_EVENT_VERBS: Record<ContinuityPlanEvent, string> = {
  ACTIVATE: 'activated',
  RETIRE: 'retired',
};

const EVENT_FOR_STATUS: Record<'active' | 'retired', ContinuityPlanEvent> = {
  active: 'ACTIVATE',
  retired: 'RETIRE',
};

/** The statuses `plan.status` may legally move to next — the same
 * `itContinuityPlanMachine` the transition itself is checked against, so a
 * screen can never render a button for a move the machine would refuse. */
export function availablePlanTransitions(status: ContinuityPlanStatus): ContinuityPlanStatus[] {
  return availableTransitions(itContinuityPlanMachine, status).map((event) => itContinuityPlanMachine.apply(status, event));
}

export async function transitionPlan(id: string, toStatus: 'active' | 'retired') {
  const auth = currentAuth();
  const plan = await prisma.itContinuityPlan.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!plan) throw ApiError.notFound('Continuity plan');

  const result = await lifecycleTransition({
    machine: itContinuityPlanMachine,
    eventObject: 'continuity_plan',
    eventPrefix: 'kz.it',
    impactDomain: IT_DOMAIN,
    verbs: PLAN_EVENT_VERBS,
    resource: RESOURCE,
    subjectType: 'it_continuity_plan',
    subjectId: id,
    recordCode: plan.recordCode,
    ownerPartyId: plan.ownerPartyId,
    from: plan.status as ContinuityPlanStatus,
    event: EVENT_FOR_STATUS[toStatus],
  });

  return prisma.itContinuityPlan.update({ where: { id }, data: { status: result.to } });
}

export interface PlanFilter {
  tier?: number;
  status?: string;
}

export async function listPlans(filter: PlanFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  return prisma.itContinuityPlan.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.tier ? { applicationTier: filter.tier } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ applicationTier: 'asc' }, { applicationName: 'asc' }],
  });
}

export async function planDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const plan = await prisma.itContinuityPlan.findFirst({
    where: { id, tenantId: auth.tenantId, deletedAt: null },
    include: { tests: { orderBy: { testedAt: 'desc' } } },
  });
  if (!plan) throw ApiError.notFound('Continuity plan');
  return { ...plan, availableTransitions: availablePlanTransitions(plan.status as ContinuityPlanStatus) };
}

// ---------------------------------------------------------------------------
// Continuity tests (append-only)
// ---------------------------------------------------------------------------

export interface RecordTestInput {
  testedAt?: Date;
  kind: 'restore' | 'failover' | 'tabletop';
  outcome: 'pass' | 'fail' | 'partial';
  actualRecoveryMinutes?: number | null;
  actualDataLossMinutes?: number | null;
  notes?: string | null;
  evidenceDocumentId?: string | null;
}

export async function recordTest(planId: string, input: RecordTestInput) {
  const auth = currentAuth();
  const plan = await prisma.itContinuityPlan.findFirst({ where: { id: planId, tenantId: auth.tenantId, deletedAt: null } });
  if (!plan) throw ApiError.notFound('Continuity plan');
  await assertCan({ resource: RESOURCE, verb: 'create', record: { ownerPartyId: plan.ownerPartyId } });

  if (plan.status === 'retired') {
    throw ApiError.conflict(`${plan.recordCode} is retired; a retired plan cannot record a new test.`);
  }
  if (!['restore', 'failover', 'tabletop'].includes(input.kind)) throw ApiError.badRequest('kind must be restore, failover or tabletop.');
  if (!['pass', 'fail', 'partial'].includes(input.outcome)) throw ApiError.badRequest('outcome must be pass, fail or partial.');

  const testedAt = input.testedAt ?? new Date();
  const recordCode = await nextRecordCode('DRT');

  const test = await prisma.itContinuityTest.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      planId: plan.id,
      testedAt,
      kind: input.kind,
      outcome: input.outcome,
      actualRecoveryMinutes: input.actualRecoveryMinutes ?? null,
      actualDataLossMinutes: input.actualDataLossMinutes ?? null,
      notes: input.notes ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      recordedById: auth.partyId ?? null,
    },
  });

  // A new test restarts the overdue clock, whatever it found.
  await prisma.itContinuityPlan.update({
    where: { id: plan.id },
    data: { lastTestedAt: testedAt, testOverdueNotifiedRungs: [] },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_continuity_test',
    subjectId: test.id,
    after: { recordCode, planId: plan.id, kind: test.kind, outcome: test.outcome },
  });
  await emit({
    name: EVENTS.IT_CONTINUITY_TESTED,
    subject: { entityType: 'it_continuity_test', entityId: test.id, recordCode },
    related: [{ relation: 'plan', entityType: 'it_continuity_plan', entityId: plan.id }],
    newState: { kind: test.kind, outcome: test.outcome, actualRecoveryMinutes: test.actualRecoveryMinutes },
    impact: { domains: [IT_DOMAIN] },
  });

  if (rtoBreached(test, plan)) {
    await raiseException({
      code: 'IT_DR_RTO_EXCEEDED',
      label: `${plan.applicationName} DR test exceeded its RTO/RPO`,
      severity: 'S3_HIGH_RISK',
      subjectType: 'it_continuity_test',
      subjectId: test.id,
      subjectLabel: recordCode,
      domain: IT_DOMAIN,
      detail:
        `${plan.recordCode} promises RTO ${plan.rtoMinutes}m / RPO ${plan.rpoMinutes}m for ${plan.applicationName}. ` +
        `The ${test.kind} test on ${testedAt.toISOString().slice(0, 10)} recorded ` +
        `${test.actualRecoveryMinutes ?? '—'}m recovery and ${test.actualDataLossMinutes ?? '—'}m of data loss.`,
      ownerPartyId: plan.ownerPartyId,
      triggerFingerprint: 'it_continuity_test_rto_exceeded',
    });
  }

  return test;
}

export async function listTests(planId: string) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const plan = await prisma.itContinuityPlan.findFirst({ where: { id: planId, tenantId: auth.tenantId, deletedAt: null } });
  if (!plan) throw ApiError.notFound('Continuity plan');
  return prisma.itContinuityTest.findMany({ where: { tenantId: auth.tenantId, planId }, orderBy: { testedAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Availability readings
// ---------------------------------------------------------------------------

export interface RecordAvailabilityInput {
  applicationId: string;
  applicationName: string;
  period: string;
  minutesDown: number;
  incidentCount?: number;
  source?: 'typed' | 'incidents';
  note?: string | null;
}

export async function recordAvailabilityReading(input: RecordAvailabilityInput) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'create' });

  if (!/^\d{4}-\d{2}$/.test(input.period)) throw ApiError.badRequest('period must be YYYY-MM.');
  if (!Number.isInteger(input.minutesDown) || input.minutesDown < 0) throw ApiError.badRequest('minutesDown must be zero or a positive number of minutes.');
  if (!input.applicationId?.trim()) throw ApiError.badRequest('An availability reading needs an applicationId.');
  if (!input.applicationName?.trim()) throw ApiError.badRequest('An availability reading needs the application\'s name.');

  const existing = await prisma.itAvailabilityReading.findFirst({
    where: { tenantId: auth.tenantId, applicationId: input.applicationId, period: input.period },
  });

  const data = {
    applicationName: input.applicationName.trim(),
    minutesDown: input.minutesDown,
    incidentCount: input.incidentCount ?? 0,
    source: input.source ?? 'typed',
    note: input.note ?? null,
  };

  const reading = existing
    ? await prisma.itAvailabilityReading.update({ where: { id: existing.id }, data })
    : await prisma.itAvailabilityReading.create({
        data: { tenantId: auth.tenantId, applicationId: input.applicationId.trim(), period: input.period, ...data },
      });

  await auditWrite({
    action: existing ? 'update' : 'create',
    subjectType: 'it_availability_reading',
    subjectId: reading.id,
    before: existing ?? undefined,
    after: reading,
  });
  await emit({
    name: EVENTS.IT_AVAILABILITY_RECORDED,
    subject: { entityType: 'it_availability_reading', entityId: reading.id, recordCode: null },
    newState: { applicationId: reading.applicationId, period: reading.period, minutesDown: reading.minutesDown },
    impact: { domains: [IT_DOMAIN] },
  });

  return reading;
}

export interface AvailabilityFilter {
  period?: string;
  applicationId?: string;
}

export async function listAvailabilityReadings(filter: AvailabilityFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const rows = await prisma.itAvailabilityReading.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.period ? { period: filter.period } : {}),
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
    },
    orderBy: [{ period: 'desc' }, { applicationName: 'asc' }],
  });
  return rows.map((r) => ({ ...r, uptimePercent: uptimePercent(r.minutesDown, r.period) }));
}

// ---------------------------------------------------------------------------
// Maintenance windows
// ---------------------------------------------------------------------------

export interface CreateMaintenanceWindowInput {
  applicationId: string;
  applicationName: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  changeId?: string | null;
}

export async function createMaintenanceWindow(input: CreateMaintenanceWindowInput) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'create' });

  if (!input.applicationId?.trim()) throw ApiError.badRequest('A maintenance window needs an applicationId.');
  if (!input.applicationName?.trim()) throw ApiError.badRequest('A maintenance window needs the application\'s name.');
  if (!input.reason?.trim()) throw ApiError.badRequest('A maintenance window needs a reason.');
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) throw ApiError.badRequest('startsAt is required.');
  if (!(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) throw ApiError.badRequest('endsAt is required.');
  if (input.endsAt <= input.startsAt) throw ApiError.badRequest('endsAt must be after startsAt.');

  const recordCode = await nextRecordCode('MWN');
  const window = await prisma.itMaintenanceWindow.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      applicationId: input.applicationId.trim(),
      applicationName: input.applicationName.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason.trim(),
      changeId: input.changeId ?? null,
      status: 'planned',
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_maintenance_window',
    subjectId: window.id,
    after: { recordCode, applicationId: window.applicationId, startsAt: window.startsAt, endsAt: window.endsAt },
  });
  await emit({
    name: EVENTS.IT_MAINTENANCE_SCHEDULED,
    subject: { entityType: 'it_maintenance_window', entityId: window.id, recordCode },
    newState: { status: window.status, startsAt: window.startsAt, endsAt: window.endsAt },
    impact: { domains: [IT_DOMAIN] },
  });

  return window;
}

export interface MaintenanceFilter {
  when?: 'upcoming' | 'past' | 'all';
  status?: string;
}

export async function listMaintenanceWindows(filter: MaintenanceFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const now = new Date();
  return prisma.itMaintenanceWindow.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.when === 'upcoming' ? { endsAt: { gte: now } } : {}),
      ...(filter.when === 'past' ? { endsAt: { lt: now } } : {}),
    },
    orderBy: { startsAt: filter.when === 'past' ? 'desc' : 'asc' },
  });
}

export async function maintenanceWindowDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const window = await prisma.itMaintenanceWindow.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!window) throw ApiError.notFound('Maintenance window');
  return window;
}

/** Cancelling asks for a reason — a deliberate decision, not a status flip
 * with nothing behind it (the same discipline `waive` keeps for the
 * compliance calendar). */
export async function cancelMaintenanceWindow(id: string, reason: string) {
  const auth = currentAuth();
  const window = await prisma.itMaintenanceWindow.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!window) throw ApiError.notFound('Maintenance window');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  const trimmed = reason?.trim();
  if (!trimmed) throw ApiError.badRequest('Cancelling a maintenance window needs a reason.');
  if (window.status === 'done' || window.status === 'cancelled') {
    throw ApiError.conflict(`${window.recordCode} is already ${window.status} and cannot be cancelled.`);
  }

  const updated = await prisma.itMaintenanceWindow.update({
    where: { id },
    data: { status: 'cancelled', cancelReason: trimmed },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'it_maintenance_window',
    subjectId: id,
    before: { status: window.status },
    after: { status: 'cancelled', cancelReason: trimmed },
  });
  // No dedicated "cancelled" event is declared for workstream H — reusing
  // IT_MAINTENANCE_SCHEDULED for every state change on the window, per the
  // brief's "emit an existing close one and note it".
  await emit({
    name: EVENTS.IT_MAINTENANCE_SCHEDULED,
    subject: { entityType: 'it_maintenance_window', entityId: id, recordCode: window.recordCode },
    previousState: { status: window.status },
    newState: { status: 'cancelled', reason: trimmed },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Jobs use these too
// ---------------------------------------------------------------------------

export { resolveOperationsHeadPartyId };

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export async function continuitySummary(): Promise<ContinuitySummary> {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });

  const plans = await prisma.itContinuityPlan.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });

  const plansByTier: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const plansByStatus: Record<string, number> = { draft: 0, active: 0, retired: 0 };
  for (const p of plans) {
    plansByTier[p.applicationTier] = (plansByTier[p.applicationTier] ?? 0) + 1;
    plansByStatus[p.status] = (plansByStatus[p.status] ?? 0) + 1;
  }

  const tier1Plans = plans.filter((p) => p.applicationTier === 1 && p.status === 'active');
  const now = new Date();
  const tier1TestedWithinCadence = tier1Plans.filter((p) => {
    const rung = testOverdueRung(p.lastTestedAt, p.testCadenceDays, now);
    return rung === undefined;
  });

  const testsOverdue = plans.filter((p) => p.status === 'active' && testOverdueRung(p.lastTestedAt, p.testCadenceDays, now) !== undefined).length;

  const nextMaintenanceWindows = await prisma.itMaintenanceWindow.count({
    where: { tenantId: auth.tenantId, status: { in: ['planned', 'in_progress'] }, endsAt: { gte: now } },
  });

  const availability = await availabilitySummaryInternal(auth.tenantId, now);

  const notYetMeasured = plans.length === 0;

  return {
    notYetMeasured,
    plansByTier,
    plansByStatus: plansByStatus as ContinuitySummary['plansByStatus'],
    tier1Tested: {
      count: tier1TestedWithinCadence.length,
      total: tier1Plans.length,
      fraction: tier1Plans.length > 0 ? Math.round((tier1TestedWithinCadence.length / tier1Plans.length) * 10000) / 10000 : null,
    },
    testsOverdue,
    availabilityLastMonth: availability,
    nextMaintenanceWindows,
  };
}

function lastFullMonthPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; previous month index
  const prevMonth = m === 0 ? 12 : m;
  const prevYear = m === 0 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

async function availabilitySummaryInternal(tenantId: string, now: Date): Promise<ContinuitySummary['availabilityLastMonth']> {
  const period = lastFullMonthPeriod(now);
  const rows = await prisma.itAvailabilityReading.findMany({ where: { tenantId, period } });
  if (rows.length === 0) {
    return { notYetMeasured: true, period, meanUptimePercent: null, worstApplication: null };
  }
  const withUptime = rows.map((r) => ({ ...r, uptime: uptimePercent(r.minutesDown, r.period) }));
  const mean = withUptime.reduce((sum, r) => sum + r.uptime, 0) / withUptime.length;
  const worst = withUptime.reduce((min, r) => (r.uptime < min.uptime ? r : min), withUptime[0]);
  return {
    notYetMeasured: false,
    period,
    meanUptimePercent: Math.round(mean * 100) / 100,
    worstApplication: { applicationId: worst.applicationId, applicationName: worst.applicationName, uptimePercent: worst.uptime },
  };
}

export async function availabilitySummary() {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  return availabilitySummaryInternal(auth.tenantId, new Date());
}
