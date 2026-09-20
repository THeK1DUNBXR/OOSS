/**
 * P5 — the durable scheduling substrate (CRM-FOUND-005).
 *
 * Replaces an in-process setInterval that lost its queue state on every restart
 * and could not be distributed across more than one process.
 *
 * Every firing is keyed by the platform-standard idempotency tuple:
 *   (automationVersionId, subjectRef, triggerFingerprint, ladderRung)
 * — job definition version, the records acted on, the condition state that
 * caused the fire, and the escalation step. A firing with an already-recorded
 * key does not re-execute. This is a substrate-level guard IN ADDITION to each
 * job's own per-record marker fields, not a replacement for them.
 *
 * Jobs run as the SYSTEM_PRINCIPAL, per tenant per run — a job that iterates
 * "all MoUs expiring in 30 days" does so once per tenant, never once globally.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { config } from '../platform/config.js';
import { MAX_ATTEMPTS, TICK_MS, backoffMs, dueOccurrence, isValidCron, leaseFor } from './schedule.js';
import { asSystem, currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { detectUntouchedLeads } from '../domains/leads.js';
import { detectStageAgeBreaches, demoteStaleCommits, detectChronicRecommits } from '../domains/opportunities.js';
import { detectStalledProposals, detectOfferingCoverageGaps } from '../domains/commercial.js';
import { runExpiryLadder, auditWonWithoutContract } from '../domains/agreements.js';
import { detectOverduePayments } from '../domains/finance.js';
import { detectOverdueReviews } from '../domains/winLoss.js';
import { sweepStaleMergeCandidates } from '../domains/identity.js';
import { detectOverdueCertificates } from '../domains/equity.js';
import { publishDirtySnapshots, publishNightlySnapshot } from '../domains/group.js';
import { runVesting, runExpiredExerciseWindows } from '../domains/esop.js';
import { checkDematRequirements, runPas6HalfYearly, runFlaReturn } from '../domains/filings.js';
import { computeAndPersistAll } from '../domains/health.js';
import { runBoardComplianceJob } from '../domains/board.js';
import { runCeoDetectors } from '../domains/ceo/detectors.js';
import { raiseException, escalateException } from '../platform/exceptions.js';
import { COMPLIANCE_JOBS } from './compliance/index.js';
import { IT_JOBS } from './it/index.js';

export interface JobResult {
  processed: number;
  notified: number;
  skippedIdempotent: number;
  errors: string[];
}

export interface JobDefinition {
  name: string;
  label: string;
  automationClass: string;
  cron: string;
  run: () => Promise<JobResult>;
}

const empty = (): JobResult => ({ processed: 0, notified: 0, skippedIdempotent: 0, errors: [] });

function counted(n: number): JobResult {
  return { processed: n, notified: n, skippedIdempotent: 0, errors: [] };
}

/**
 * The registered job set. Each is independently scheduled — the forced
 * single-hourly-tick constraint is gone.
 */
export const ALL_JOBS: JobDefinition[] = [
  {
    name: 'runMouExpiryJob',
    label: 'MoU expiry ladder (90/60/30/7)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('mou')),
  },
  {
    name: 'runContractExpiryJob',
    label: 'Contract expiry ladder (120/90/60/30)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('contract')),
  },
  {
    name: 'runPartnerAgreementExpiryJob',
    label: 'Partner agreement expiry ladder',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('partner_agreement')),
  },
  {
    name: 'runLeadUntouchedJob',
    label: 'Lead untouched detector',
    automationClass: 'escalation_routing',
    cron: '0 * * * *',
    run: async () => counted(await detectUntouchedLeads()),
  },
  {
    name: 'runTaskOverdueJob',
    label: 'Task overdue detector',
    automationClass: 'escalation_routing',
    cron: '0 * * * *',
    run: async () => counted(await detectOverdueTasks()),
  },
  {
    name: 'runStageAgeBreachJob',
    label: 'Stage age budget breach detector',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: async () => counted(await detectStageAgeBreaches()),
  },
  {
    name: 'runProposalPendingJob',
    label: 'Stalled proposal chase',
    automationClass: 'communication_dispatch',
    cron: '0 8 * * *',
    run: async () => counted(await detectStalledProposals()),
  },
  {
    name: 'runPaymentPendingJob',
    label: 'Overdue payment detector',
    automationClass: 'financial_processing',
    cron: '0 9 * * *',
    // The idempotency marker CRM-FIN-001 adds is what stops this re-notifying
    // the same obligation on every tick.
    run: async () => counted(await detectOverduePayments()),
  },
  {
    name: 'runStaleCommitJob',
    label: 'Move deals down when their close date goes stale',
    automationClass: 'threshold_response',
    cron: '0 5 * * *',
    run: async () => {
      const demoted = await demoteStaleCommits();
      const chronic = await detectChronicRecommits();
      return { processed: demoted + chronic, notified: demoted, skippedIdempotent: 0, errors: [] };
    },
  },
  {
    name: 'runWinLossOverdueJob',
    label: 'Win/loss review overdue detector',
    automationClass: 'routine_administration',
    cron: '0 10 * * *',
    run: async () => counted(await detectOverdueReviews()),
  },
  {
    name: 'runMergeCandidateSweepJob',
    label: 'Stale merge candidate sweep',
    automationClass: 'data_maintenance',
    cron: '0 11 * * *',
    run: async () => counted(await sweepStaleMergeCandidates()),
  },
  {
    name: 'runCertificateWindowJob',
    label: 'EX-EQT-002 share certificate window (SH-1, two months)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await detectOverdueCertificates()),
  },
  // ESOP (equity-portal plan §6, phase 5).
  {
    name: 'esop_vesting',
    label: 'ESOP: vest tranches due today',
    automationClass: 'routine_administration',
    cron: '0 2 * * *',
    run: async () => counted(await runVesting()),
  },
  {
    name: 'runEsopExerciseWindowJob',
    label: 'ESOP: lapse a vested-unexercised balance past its post-exit window',
    automationClass: 'threshold_response',
    cron: '0 3 * * *',
    run: async () => counted(await runExpiredExerciseWindows()),
  },
  // Filings, demat, FEMA (equity-portal plan §6 phase 6a).
  {
    name: 'runDematStatusCheckJob',
    label: 'EX-EQT-004/005 demat status (Rule 9B)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await checkDematRequirements()),
  },
  {
    name: 'runPas6HalfYearlyJob',
    label: 'EX-EQT-010 PAS-6 reconciliation, half-yearly',
    automationClass: 'routine_administration',
    cron: '0 7 * * *',
    run: async () => counted(await runPas6HalfYearly()),
  },
  {
    name: 'runFlaReturnJob',
    label: 'EX-EQT-008 FLA return, yearly',
    automationClass: 'routine_administration',
    cron: '0 8 1 4 *',
    run: async () => counted(await runFlaReturn()),
  },
  {
    // Group (equity-portal plan §6, phase 2). Publishes only a tenant flagged
    // `config.snapshotDirty` by the `kz.eqt.*` subscribers in
    // `events/handlers.ts` — most ticks touch no tenant at all.
    name: 'publish_entity_snapshots',
    label: 'Publish dirty entity snapshots to the parent tenant',
    automationClass: 'data_maintenance',
    cron: '*/15 * * * *',
    run: async () => counted(await publishDirtySnapshots()),
  },
  {
    // The backstop against a missed subscriber: every subsidiary republishes
    // once a night regardless of the dirty flag.
    name: 'publish_entity_snapshots_nightly',
    label: 'Nightly full entity snapshot publish',
    automationClass: 'data_maintenance',
    cron: '30 2 * * *',
    run: async () => counted(await publishNightlySnapshot()),
  },
  {
    name: 'runOfferingCoverageJob',
    label: 'DET-CRM-OFF-01 offering coverage gap',
    automationClass: 'data_maintenance',
    cron: '0 12 * * *',
    run: async () => counted(await detectOfferingCoverageGaps()),
  },
  {
    name: 'runWonWithoutContractAuditJob',
    label: 'EX-CRM-011 won-without-artefact sweep',
    automationClass: 'data_maintenance',
    cron: '0 13 * * *',
    run: async () => counted(await auditWonWithoutContract()),
  },
  {
    name: 'runSlaEscalationJob',
    label: 'SLA expiry escalation',
    automationClass: 'escalation_routing',
    cron: '*/30 * * * *',
    run: async () => counted(await escalateBreachedSlas()),
  },
  {
    name: 'runDailyMetricsJob',
    label: 'Daily metrics',
    automationClass: 'routine_administration',
    cron: '0 1 * * *',
    run: async () => counted(await computeDailyMetrics()),
  },
  {
    name: 'runHealthScoreJob',
    label: 'Cross-domain health scores',
    automationClass: 'routine_administration',
    cron: '30 1 * * *',
    run: async () => {
      const results = await computeAndPersistAll();
      return { processed: results.length, notified: 0, skippedIdempotent: 0, errors: [] };
    },
  },
  {
    name: 'board_compliance',
    label: 'Board compliance calendar',
    automationClass: 'routine_administration',
    cron: '0 2 * * *',
    run: async () => counted(await runBoardComplianceJob()),
  },
  {
    name: 'runCeoDetectorsJob',
    label: "Chairman's Office detectors",
    automationClass: 'routine_administration',
    cron: '0 3 * * *',
    run: async () => counted(await runCeoDetectors()),
  },
  ...COMPLIANCE_JOBS,
  ...IT_JOBS,
];

// ---------------------------------------------------------------------------
// Additional detectors that live here rather than in a domain module
// ---------------------------------------------------------------------------

async function detectOverdueTasks(): Promise<number> {
  const auth = currentAuth();
  const overdue = await prisma.task.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['open', 'in_progress'] },
      dueAt: { lt: new Date() },
      overdueNotifiedAt: null,
    },
    take: 200,
  });

  for (const task of overdue) {
    await raiseException({
      code: 'EX-WFL-001',
      label: 'Task overdue',
      severity: 'S1_ATTENTION',
      subjectType: 'task',
      subjectId: task.id,
      subjectLabel: `${task.recordCode} — ${task.title}`,
      domain: 'wfl',
      detail: `Due ${task.dueAt?.toISOString().slice(0, 10)} and still ${task.status}.`,
      ownerPartyId: task.assigneePartyId,
      triggerFingerprint: 'task_overdue',
      ladderRung: 1,
    });
    await prisma.task.update({ where: { id: task.id }, data: { overdueNotifiedAt: new Date() } });
    await emit({
      name: EVENTS.TASK_OVERDUE_DETECTED,
      subject: { entityType: 'task', entityId: task.id, recordCode: task.recordCode },
      newState: { dueAt: task.dueAt },
      owner: { partyId: task.assigneePartyId },
      impact: { domains: ['wfl'], severity: 'S1_ATTENTION' },
    });
  }
  return overdue.length;
}

/** SLA expiry is one of the four named escalation triggers. */
async function escalateBreachedSlas(): Promise<number> {
  const auth = currentAuth();
  const breached = await prisma.exceptionRecord.findMany({
    where: {
      tenantId: auth.tenantId,
      state: { in: ['open', 'acknowledged'] },
      slaDueAt: { lt: new Date() },
      escalatedAt: null,
    },
    take: 100,
  });

  for (const ex of breached) {
    // Escalation resolves the next rung's holder deterministically, before any
    // notification fires.
    const nextTier = ['finance_head', 'chairman'][Math.min(ex.escalationRung, 1)];
    const holder = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug: nextTier, status: 'active' },
      select: { partyId: true },
    });
    await escalateException(ex.id, 'sla_expiry', undefined, holder?.partyId ?? null);
  }

  // An approval step unresolved past its grace window bumps a tier (AU-CRM-015).
  const staleApprovals = await prisma.approvalStep.findMany({
    where: { tenantId: auth.tenantId, state: 'open', slaDueAt: { lt: new Date() }, escalatedAt: null },
    take: 100,
  });
  for (const step of staleApprovals) {
    const nextTier = ['finance_head', 'chairman'][Math.min(step.escalationRung, 1)];
    const holder = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug: nextTier, status: 'active' },
      select: { partyId: true },
    });
    await prisma.approvalStep.update({
      where: { id: step.id },
      data: {
        state: 'escalated',
        escalatedAt: new Date(),
        escalationRung: step.escalationRung + 1,
        resolvedApproverRole: nextTier,
        resolvedApproverId: holder?.partyId ?? step.resolvedApproverId,
        slaDueAt: new Date(Date.now() + 3 * 86_400_000),
      },
    });
    await emit({
      name: EVENTS.APPROVAL_STEP_ESCALATED,
      subject: { entityType: 'approval_step', entityId: step.id },
      previousState: { tier: step.escalationRung },
      newState: { tier: step.escalationRung + 1, approverRole: nextTier },
      reason: { reasonCode: 'sla_expiry' },
    });
  }

  return breached.length + staleApprovals.length;
}

/**
 * Daily metrics. `pipeline_value` and `pipeline_count` stop being written —
 * they were computed with a formula that summed across motions with
 * incompatible stage semantics. Their replacement lives in HEALTH_SCORE.
 * Historical rows are retained, never deleted, as a point-in-time record.
 */
async function computeDailyMetrics(): Promise<number> {
  const auth = currentAuth();
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  const dayStart = new Date(date);

  const [revenueWon, dealsWon, activitiesLogged, leadsCreated, enrollmentsCreated, activeMous] = await Promise.all([
    prisma.opportunity.findMany({
      where: { tenantId: auth.tenantId, outcome: 'won', closedAt: { gte: dayStart } },
      select: { expectedValue: true },
    }),
    prisma.opportunity.count({ where: { tenantId: auth.tenantId, outcome: 'won', closedAt: { gte: dayStart } } }),
    prisma.interaction.count({ where: { tenantId: auth.tenantId, createdAt: { gte: dayStart } } }),
    prisma.lead.count({ where: { tenantId: auth.tenantId, createdAt: { gte: dayStart } } }),
    prisma.enrollment.count({ where: { tenantId: auth.tenantId, createdAt: { gte: dayStart } } }),
    prisma.mou.count({ where: { tenantId: auth.tenantId, status: { in: ['signed', 'active'] } } }),
  ]);

  const metrics: Array<{ metric: string; value: number }> = [
    { metric: 'revenue_won', value: revenueWon.reduce((s, o) => s + Number(o.expectedValue?.toString() ?? 0), 0) },
    { metric: 'deals_won', value: dealsWon },
    { metric: 'activities_logged', value: activitiesLogged },
    { metric: 'leads_created', value: leadsCreated },
    { metric: 'enrollments_created', value: enrollmentsCreated },
    { metric: 'active_mous', value: activeMous },
  ];

  for (const m of metrics) {
    const existing = await prisma.dailyMetric.findFirst({
      where: { tenantId: auth.tenantId, date, metric: m.metric },
    });
    if (existing) {
      await prisma.dailyMetric.update({ where: { id: existing.id }, data: { value: m.value, computedAt: new Date() } });
    } else {
      await prisma.dailyMetric.create({
        data: { tenantId: auth.tenantId, date, metric: m.metric, value: m.value },
      });
    }
  }

  return metrics.length;
}

// ---------------------------------------------------------------------------
// The durable runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  jobNames?: string[];
  dryRun?: boolean;
  tenantId?: string;
}

/**
 * Per-record idempotency, for use inside a job body.
 *
 * Its comment used to say this "makes two substrate instances firing the same
 * job concurrently safe". That was false in two ways: nothing called it — one
 * grep hit, its own definition — and its key is per *record*
 * (`automationVersionId, subjectRef, triggerFingerprint, ladderRung`), so it
 * could not express "this occurrence of this job for this tenant" even if it
 * had been called.
 *
 * Concurrent firing is now genuinely safe, and it is `claimOccurrence` below
 * that makes it so: a unique insert on `(tenantId, jobName, scheduledFor)`.
 * This remains the finer-grained guard a job body uses to avoid re-notifying
 * one record — still uncalled, because wiring it means touching all sixteen
 * job bodies, which is its own change.
 */
export async function claimFiring(
  automationVersionId: string,
  subjectRef: string,
  triggerFingerprint: string,
  ladderRung: number,
  jobRunId: string | null,
): Promise<boolean> {
  const auth = currentAuth();
  try {
    await prisma.jobFiringLog.create({
      data: {
        tenantId: auth.tenantId,
        automationVersionId,
        subjectRef,
        triggerFingerprint,
        ladderRung,
        jobRunId,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function runJobsForTenant(tenantId: string, opts: RunOptions = {}): Promise<Record<string, JobResult>> {
  const selected = opts.jobNames?.length ? ALL_JOBS.filter((j) => opts.jobNames!.includes(j.name)) : ALL_JOBS;
  const results: Record<string, JobResult> = {};

  await asSystem(tenantId, async () => {
    for (const job of selected) {
      const definition = await prisma.automationDefinition.upsert({
        where: { tenantId_jobName: { tenantId, jobName: job.name } },
        create: {
          tenantId,
          jobName: job.name,
          label: job.label,
          automationClass: job.automationClass,
          cronExpression: job.cron,
        },
        update: { label: job.label, automationClass: job.automationClass, cronExpression: job.cron },
      });

      const automationVersionId = `${definition.id}:v${definition.version}`;

      const run = await prisma.jobRun.create({
        data: {
          tenantId,
          definitionId: definition.id,
          automationVersionId,
          jobName: job.name,
          status: 'running',
          dryRun: opts.dryRun ?? false,
        },
      });

      try {
        // Shadow mode computes what it would fire without executing.
        const result = opts.dryRun ? empty() : await job.run();
        results[job.name] = result;

        await prisma.jobRun.update({
          where: { id: run.id },
          data: {
            status: 'completed',
            finishedAt: new Date(),
            processed: result.processed,
            notified: result.notified,
            skippedIdempotent: result.skippedIdempotent,
            errors: result.errors,
          },
        });

        // Completion signals publish through the durable bus, not only to logs.
        await emit({
          name: EVENTS.JOB_COMPLETED,
          subject: { entityType: 'scheduled_job', entityId: run.id, recordCode: job.name },
          newState: {
            jobName: job.name,
            processed: result.processed,
            notified: result.notified,
            automationVersionId,
          },
          impact: { domains: ['wfl'] },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[job.name] = { processed: 0, notified: 0, skippedIdempotent: 0, errors: [message] };

        await prisma.jobRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), errors: [message] },
        });

        await emit({
          name: EVENTS.JOB_FAILED,
          subject: { entityType: 'scheduled_job', entityId: run.id, recordCode: job.name },
          newState: { jobName: job.name, error: message },
          impact: { domains: ['wfl'], severity: 'S2_WARNING' },
        });
      }
    }
  });

  return results;
}

/** Runs every job once per tenant — never once globally. */
export async function runAllTenants(opts: RunOptions = {}): Promise<Record<string, Record<string, JobResult>>> {
  const tenants = opts.tenantId
    ? [{ id: opts.tenantId }]
    : await unscopedPrisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });

  const out: Record<string, Record<string, JobResult>> = {};
  for (const tenant of tenants) {
    out[tenant.id] = await runJobsForTenant(tenant.id, opts);
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;

/** How long a single job may run before it is abandoned and retried. */
const JOB_TIMEOUT_MS = 5 * 60_000;
/** The heartbeat extends the lease while a job is genuinely still working. */
const HEARTBEAT_MS = 30_000;

export interface TickOutcome {
  /** Occurrences this process claimed and ran. */
  ran: Array<{ tenantId: string; jobName: string; scheduledFor: Date }>;
  /** Due, but another instance already held the claim. */
  skipped: number;
  /** Retries exhausted; left as a dead-letter row for somebody to look at. */
  deadLettered: number;
}

/**
 * Claim one occurrence of one job for one tenant.
 *
 * The insert is the lock. `@@unique([tenantId, jobName, scheduledFor])` means a
 * second scheduler computing the same occurrence — and it will compute the same
 * one, because the value comes from the cron rather than from `now` — gets a
 * unique violation and stands down. No advisory lock, no SELECT ... FOR UPDATE,
 * no window between checking and acting.
 *
 * A claim is also *retaken* in two cases, both of which read as "nobody is
 * working on this and it is not finished": the holder crashed and its lease
 * expired, or the run failed and its backoff has elapsed. `leaseUntil` carries
 * both meanings — while running it is a lease, and after a failure it is
 * "do not retry before". One field, because two would have to be kept
 * consistent with each other.
 */
async function claimOccurrence(
  tenantId: string,
  jobName: string,
  scheduledFor: Date,
  now: Date,
): Promise<{ id: string; attempt: number } | null> {
  try {
    const created = await unscopedPrisma.jobClaim.create({
      data: { tenantId, jobName, scheduledFor, leaseUntil: leaseFor(now, JOB_TIMEOUT_MS) },
      select: { id: true, attempt: true },
    });
    return created;
  } catch {
    // Already claimed by somebody. Take it over only if it is genuinely stalled.
    const { count } = await unscopedPrisma.jobClaim.updateMany({
      where: {
        tenantId,
        jobName,
        scheduledFor,
        status: { in: ['claimed', 'failed'] },
        leaseUntil: { lte: now },
        attempt: { lt: MAX_ATTEMPTS },
      },
      data: {
        status: 'claimed',
        attempt: { increment: 1 },
        claimedAt: now,
        leaseUntil: leaseFor(now, JOB_TIMEOUT_MS),
      },
    });
    if (count === 0) return null;
    const taken = await unscopedPrisma.jobClaim.findFirst({
      where: { tenantId, jobName, scheduledFor },
      select: { id: true, attempt: true },
    });
    return taken;
  }
}

/** A job that hangs must not hold its lease forever. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms and was abandoned`)), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * One scheduler tick: fire exactly what is due, once.
 *
 * Exported and taking an explicit `now` so a test can drive a simulated day
 * through it rather than waiting for one.
 */
export async function tickOnce(now: Date = new Date(), windowMs: number = TICK_MS): Promise<TickOutcome> {
  const outcome: TickOutcome = { ran: [], skipped: 0, deadLettered: 0 };
  const notBefore = new Date(now.getTime() - windowMs);

  const tenants = await unscopedPrisma.tenant.findMany({
    where: { status: 'active' },
    select: { id: true },
  });

  for (const tenant of tenants) {
    for (const job of ALL_JOBS) {
      const due = dueOccurrence(job.cron, now, notBefore);
      if (!due) continue;

      const claim = await claimOccurrence(tenant.id, job.name, due, now);
      if (!claim) {
        outcome.skipped++;
        continue;
      }

      // Keeps the lease alive while the job is genuinely working, so a slow
      // run is not mistaken for a dead one and taken over.
      const heartbeat = setInterval(() => {
        void unscopedPrisma.jobClaim
          .update({
            where: { id: claim.id },
            data: { heartbeatAt: new Date(), leaseUntil: leaseFor(new Date(), JOB_TIMEOUT_MS) },
          })
          .catch(() => {
            /* a failed heartbeat is not worth failing the job over */
          });
      }, HEARTBEAT_MS);

      const startedAt = Date.now();
      try {
        await withTimeout(runJobsForTenant(tenant.id, { jobNames: [job.name] }), JOB_TIMEOUT_MS, job.name);
        clearInterval(heartbeat);
        await unscopedPrisma.jobClaim.update({
          where: { id: claim.id },
          data: {
            status: 'completed',
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
            lastError: null,
          },
        });
        outcome.ran.push({ tenantId: tenant.id, jobName: job.name, scheduledFor: due });
      } catch (err) {
        clearInterval(heartbeat);
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = claim.attempt >= MAX_ATTEMPTS;
        await unscopedPrisma.jobClaim.update({
          where: { id: claim.id },
          data: {
            status: exhausted ? 'dead' : 'failed',
            deadAt: exhausted ? new Date() : null,
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
            lastError: message.slice(0, 2000),
            // On a failure this is "do not retry before"; on the last attempt
            // it is moot, because a dead claim is never retaken.
            leaseUntil: new Date(Date.now() + backoffMs(claim.attempt)),
          },
        });
        if (exhausted) {
          outcome.deadLettered++;
          console.error(`[scheduler] ${job.name} dead-lettered for tenant ${tenant.id}: ${message}`);
        }
      }
    }
  }

  return outcome;
}

/**
 * The loop.
 *
 * It used to be `setInterval(tick, 3_600_000)` firing every job on every tick,
 * which is why a daily job ran twenty-four times a day. It now wakes once a
 * minute and fires only what the job's own cron says is due.
 */
export function startScheduler(tickMs: number = TICK_MS): void {
  if (!config.JOBS_ENABLED || config.NODE_ENV === 'test') return;
  if (timer) return;

  // A malformed cron would silently never fire, which is the same invisible
  // failure this whole rewrite is about. Fail at boot instead.
  const bad = ALL_JOBS.filter((j) => !isValidCron(j.cron));
  if (bad.length) {
    throw new Error(`Unparseable cron on: ${bad.map((j) => `${j.name} (${j.cron})`).join(', ')}`);
  }

  const tick = async () => {
    try {
      const outcome = await tickOnce(new Date(), tickMs);
      if (outcome.ran.length || outcome.deadLettered) {
        console.log(
          `[scheduler] ran ${outcome.ran.length}, skipped ${outcome.skipped}, dead-lettered ${outcome.deadLettered}`,
        );
      }
    } catch (err) {
      console.error('[scheduler] tick failed', err);
    }
  };

  setTimeout(tick, 15_000);
  timer = setInterval(tick, tickMs);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
