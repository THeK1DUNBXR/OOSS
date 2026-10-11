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

import { EVENTS, istDayStart } from '@kaizen/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { config } from '../platform/config.js';
import {
  CATCH_UP_MS,
  HEARTBEAT_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  TICK_MS,
  backoffMs,
  dueOccurrence,
  isValidCron,
} from './schedule.js';
import { asSystem, currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
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
import { checkAccountBalanceSnapshots } from '../platform/balances.js';
import { COMPLIANCE_JOBS } from './compliance/index.js';
import { IT_JOBS } from './it/index.js';
import { MARKETING_JOBS } from './marketing.js';
import { JOBS as COMMITMENT_JOBS } from './commitments.js';

export interface JobResult {
  processed: number;
  notified: number;
  skippedIdempotent: number;
  errors: string[];
}

/**
 * What a body does beyond this database. `external` covers anything another
 * party can observe: an email or message, a filing, a payment, a webhook.
 */
export type SideEffects = 'none' | 'internal' | 'external';

export interface JobDefinition {
  name: string;
  label: string;
  automationClass: string;
  cron: string;
  /**
   * Required on every definition, so a job cannot be added without deciding this.
   * `external` is any effect another party can observe: a message, a filing, a payment, a webhook.
   */
  sideEffects: SideEffects;
  /**
   * True only when a second run of the same occurrence changes nothing a
   * second time. Declared `false` unless the audit says `yes`. An external,
   * non-idempotent job gets one attempt, because a retry would repeat the side effect.
   */
  idempotent: boolean;
  /**
   * The signal aborts when the attempt times out or its lease is lost. A body
   * with a loop checks it between units of work; a body that ignores it keeps
   * running after the timeout, and nothing in the scheduler can stop it.
   */
  run: (signal: AbortSignal) => Promise<JobResult>;
}

/**
 * A definition declared but not registered. It has no sideEffects or idempotent
 * declaration yet, so it cannot be added to ALL_JOBS until it has one: the
 * registry's type is JobDefinition and requires both.
 */
export type PendingJobDefinition = Omit<JobDefinition, 'sideEffects' | 'idempotent'>;

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
    sideEffects: 'external',
    idempotent: false,
    label: 'MoU expiry ladder (90/60/30/7)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('mou')),
  },
  {
    name: 'runContractExpiryJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Contract expiry ladder (120/90/60/30)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('contract')),
  },
  {
    name: 'runPartnerAgreementExpiryJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Partner agreement expiry ladder',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runExpiryLadder('partner_agreement')),
  },
  {
    name: 'runLeadUntouchedJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Lead untouched detector',
    automationClass: 'escalation_routing',
    cron: '0 * * * *',
    run: async () => counted(await detectUntouchedLeads()),
  },
  {
    name: 'runTaskOverdueJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Task overdue detector',
    automationClass: 'escalation_routing',
    cron: '0 * * * *',
    run: async () => counted(await detectOverdueTasks()),
  },
  {
    name: 'runStageAgeBreachJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Stage age budget breach detector',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: async () => counted(await detectStageAgeBreaches()),
  },
  {
    name: 'runProposalPendingJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Stalled proposal chase',
    automationClass: 'communication_dispatch',
    cron: '0 8 * * *',
    run: async () => counted(await detectStalledProposals()),
  },
  {
    name: 'runPaymentPendingJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Overdue payment detector',
    automationClass: 'financial_processing',
    cron: '0 9 * * *',
    // The idempotency marker CRM-FIN-001 adds is what stops this re-notifying
    // the same obligation on every tick.
    run: async () => counted(await detectOverduePayments()),
  },
  {
    name: 'runStaleCommitJob',
    sideEffects: 'external',
    idempotent: false,
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
    sideEffects: 'external',
    idempotent: false,
    label: 'Win/loss review overdue detector',
    automationClass: 'routine_administration',
    cron: '0 10 * * *',
    run: async () => counted(await detectOverdueReviews()),
  },
  {
    name: 'runMergeCandidateSweepJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'Stale merge candidate sweep',
    automationClass: 'data_maintenance',
    cron: '0 11 * * *',
    run: async () => counted(await sweepStaleMergeCandidates()),
  },
  {
    name: 'runCertificateWindowJob',
    sideEffects: 'internal',
    idempotent: false,
    label: 'EX-EQT-002 share certificate window (SH-1, two months)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await detectOverdueCertificates()),
  },
  // ESOP (equity-portal plan §6, phase 5).
  {
    name: 'esop_vesting',
    sideEffects: 'internal',
    idempotent: false,
    label: 'ESOP: vest tranches due today',
    automationClass: 'routine_administration',
    cron: '0 2 * * *',
    run: async () => counted(await runVesting()),
  },
  {
    name: 'runEsopExerciseWindowJob',
    sideEffects: 'internal',
    idempotent: false,
    label: 'ESOP: lapse a vested-unexercised balance past its post-exit window',
    automationClass: 'threshold_response',
    cron: '0 3 * * *',
    run: async () => counted(await runExpiredExerciseWindows()),
  },
  // Filings, demat, FEMA (equity-portal plan §6 phase 6a).
  {
    name: 'runDematStatusCheckJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'EX-EQT-004/005 demat status (Rule 9B)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await checkDematRequirements()),
  },
  {
    name: 'runPas6HalfYearlyJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'EX-EQT-010 PAS-6 reconciliation, half-yearly',
    automationClass: 'routine_administration',
    cron: '0 7 * * *',
    run: async () => counted(await runPas6HalfYearly()),
  },
  {
    name: 'runFlaReturnJob',
    sideEffects: 'internal',
    idempotent: false,
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
    sideEffects: 'internal',
    idempotent: false,
    label: 'Publish dirty entity snapshots to the parent tenant',
    automationClass: 'data_maintenance',
    cron: '*/15 * * * *',
    run: async () => counted(await publishDirtySnapshots()),
  },
  {
    // The backstop against a missed subscriber: every subsidiary republishes
    // once a night regardless of the dirty flag.
    name: 'publish_entity_snapshots_nightly',
    sideEffects: 'internal',
    idempotent: false,
    label: 'Nightly full entity snapshot publish',
    automationClass: 'data_maintenance',
    cron: '30 2 * * *',
    run: async () => counted(await publishNightlySnapshot()),
  },
  {
    name: 'runOfferingCoverageJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'DET-CRM-OFF-01 offering coverage gap',
    automationClass: 'data_maintenance',
    cron: '0 12 * * *',
    run: async () => counted(await detectOfferingCoverageGaps()),
  },
  {
    name: 'runWonWithoutContractAuditJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'EX-CRM-011 won-without-artefact sweep',
    automationClass: 'data_maintenance',
    cron: '0 13 * * *',
    run: async () => counted(await auditWonWithoutContract()),
  },
  {
    name: 'runSlaEscalationJob',
    sideEffects: 'external',
    idempotent: false,
    label: 'SLA expiry escalation',
    automationClass: 'escalation_routing',
    cron: '*/30 * * * *',
    run: async () => counted(await escalateBreachedSlas()),
  },
  {
    name: 'runDailyMetricsJob',
    sideEffects: 'internal',
    idempotent: false,
    label: 'Daily metrics',
    automationClass: 'routine_administration',
    cron: '0 1 * * *',
    run: async () => counted(await computeDailyMetrics()),
  },
  {
    name: 'runHealthScoreJob',
    sideEffects: 'internal',
    idempotent: true,
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
    sideEffects: 'internal',
    idempotent: false,
    label: 'Board compliance calendar',
    automationClass: 'routine_administration',
    cron: '0 2 * * *',
    run: async () => counted(await runBoardComplianceJob()),
  },
  {
    // Nightly drift canary (MONEY-LEDGER-CONTRACT section 3). Idempotent: a rerun
    // with nothing changed inserts no snapshot row and raises nothing new, and a
    // standing disagreement reuses its open exception.
    name: 'runAccountBalanceDriftJob',
    sideEffects: 'internal',
    idempotent: true,
    label: 'Account balance snapshots: drift check and journal trial balance',
    automationClass: 'routine_administration',
    cron: '30 2 * * *',
    run: async (signal) => {
      const report = await checkAccountBalanceSnapshots(new Date(), signal);
      return {
        processed: report.processed,
        notified: report.drifted + (report.trialBalanceOk ? 0 : 1),
        skippedIdempotent: report.matched,
        errors: [],
      };
    },
  },
  {
    name: 'runCeoDetectorsJob',
    sideEffects: 'none',
    idempotent: true,
    label: "Chairman's Office detectors",
    automationClass: 'routine_administration',
    cron: '0 3 * * *',
    run: async () => counted(await runCeoDetectors()),
  },
  ...COMPLIANCE_JOBS,
  ...IT_JOBS,
  ...MARKETING_JOBS,
  ...COMMITMENT_JOBS,
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
  let escalated = 0;
  for (const step of staleApprovals) {
    if (await escalateApprovalStep(step)) escalated += 1;
  }

  return breached.length + escalated;
}

/**
 * Bumps one overdue approval step a tier. `step` is the scan's snapshot, which
 * may be stale: the approver can decide between the findMany and this write.
 * The write is guarded on state 'open', so a step decided in that gap is left
 * as decided, not reverted to 'escalated' with the decider's audit trail
 * pointing at a state the step no longer has. Returns false when the guard
 * refused, so the caller does not count or emit an escalation that never
 * happened.
 */
export async function escalateApprovalStep(step: {
  id: string;
  escalationRung: number;
  resolvedApproverId: string | null;
}): Promise<boolean> {
  const auth = currentAuth();
  const nextTier = ['finance_head', 'chairman'][Math.min(step.escalationRung, 1)];
  const holder = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: nextTier, status: 'active' },
    select: { partyId: true },
  });
  const { count } = await prisma.approvalStep.updateMany({
    where: { id: step.id, state: 'open' },
    data: {
      state: 'escalated',
      escalatedAt: new Date(),
      escalationRung: { increment: 1 },
      resolvedApproverRole: nextTier,
      resolvedApproverId: holder?.partyId ?? step.resolvedApproverId,
      slaDueAt: new Date(Date.now() + 3 * 86_400_000),
    },
  });
  if (count !== 1) return false;

  // The actor is the principal the tick runs under (asSystem, in the job runner
  // below), so the row records the system, not a person. Without it an
  // approval could move tiers with no trace of which automation moved it.
  await auditWrite({
    action: 'update',
    subjectType: 'approval_step',
    subjectId: step.id,
    before: { state: 'open', escalationRung: step.escalationRung },
    after: { state: 'escalated', escalationRung: step.escalationRung + 1, approverRole: nextTier },
  });

  await emit({
    name: EVENTS.APPROVAL_STEP_ESCALATED,
    subject: { entityType: 'approval_step', entityId: step.id },
    previousState: { tier: step.escalationRung },
    newState: { tier: step.escalationRung + 1, approverRole: nextTier },
    reason: { reasonCode: 'sla_expiry' },
  });
  return true;
}

/**
 * Daily metrics. `pipeline_value` and `pipeline_count` stop being written —
 * they were computed with a formula that summed across motions with
 * incompatible stage semantics. Their replacement lives in HEALTH_SCORE.
 * Historical rows are retained, never deleted, as a point-in-time record.
 */
export async function computeDailyMetrics(now: Date = new Date()): Promise<number> {
  const auth = currentAuth();
  // The bucket is the IST day of the run. UTC midnight put a 19:00Z run on the
  // previous IST day (CLAUDE.md rule 3).
  const date = istDayStart(now);
  const dayStart = date;

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

  // Upsert on the unique (tenant, IST day, metric) key: a rerun, or two runs
  // racing, leave one row per metric rather than a find-then-create gap.
  for (const m of metrics) {
    await prisma.dailyMetric.upsert({
      where: { tenantId_date_metric: { tenantId: auth.tenantId, date, metric: m.metric } },
      create: { tenantId: auth.tenantId, date, metric: m.metric, value: m.value },
      update: { value: m.value, computedAt: new Date() },
    });
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
  /** Replaces the registry. Tests use it to run a probe body in place of the real jobs. */
  jobs?: JobDefinition[];
  /** The instant a manual run claims under. Defaults to now, to the second. */
  at?: Date;
  workerId?: string;
}

function selectJobs(opts: RunOptions): JobDefinition[] {
  const pool = opts.jobs ?? ALL_JOBS;
  return opts.jobNames?.length ? pool.filter((j) => opts.jobNames!.includes(j.name)) : pool;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Concurrent firing is now genuinely safe, and it is the claim in
 * `claimAttempt` that makes it so: a unique key on `(tenantId, jobName,
 * scheduledFor)`. This remains the finer-grained guard a job body uses to avoid
 * re-notifying one record — still uncalled, because wiring it means touching
 * all sixteen job bodies, which is its own change.
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

/**
 * One execution of one job body: its JobRun record, the body, and the
 * completion or failure event. Throws when the body throws, so the claim
 * runner can record the attempt as failed and retry it. The manual path
 * catches the throw and reports it in the results instead.
 *
 * A body that settles after its attempt was abandoned (timed out, or its lease
 * was lost) records itself as `abandoned` and emits nothing. Its completion
 * would otherwise announce work that the claim has already written off.
 */
async function runJobBody(
  tenantId: string,
  job: JobDefinition,
  opts: { dryRun?: boolean; signal: AbortSignal },
): Promise<JobResult> {
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
    const result = opts.dryRun ? empty() : await job.run(opts.signal);

    if (opts.signal.aborted) {
      await prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: 'abandoned',
          finishedAt: new Date(),
          errors: ['settled after its attempt was abandoned; the claim had already moved on'],
        },
      });
      return result;
    }

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
    return result;
  } catch (err) {
    const message = messageOf(err);
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
    throw err;
  }
}

/** Runs the selected jobs for one tenant, with no claim. Used by the admin route and the test fixtures. */
export async function runJobsForTenant(tenantId: string, opts: RunOptions = {}): Promise<Record<string, JobResult>> {
  const results: Record<string, JobResult> = {};
  const signal = new AbortController().signal;

  await asSystem(tenantId, async () => {
    for (const job of selectJobs(opts)) {
      try {
        results[job.name] = await runJobBody(tenantId, job, { dryRun: opts.dryRun, signal });
      } catch (err) {
        results[job.name] = { processed: 0, notified: 0, skippedIdempotent: 0, errors: [messageOf(err)] };
      }
    }
  });

  return results;
}

/**
 * Runs the selected jobs once per tenant, each through a claim on the instant
 * given (default: now, to the second). A repeat of the same instant is skipped,
 * so two `jobs:run` invocations cannot both run one job for one tenant.
 *
 * A manual instant is not a scheduled occurrence: a daily job that already ran
 * at 06:00 is not blocked from a manual run at 14:00. Forcing a re-run of a
 * completed scheduled occurrence is not offered here.
 */
export async function runAllTenants(opts: RunOptions = {}): Promise<Record<string, Record<string, JobResult>>> {
  const tenants = opts.tenantId
    ? [{ id: opts.tenantId }]
    : await unscopedPrisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });

  const at = opts.at ?? new Date(Math.floor(Date.now() / 1000) * 1000);
  const out: Record<string, Record<string, JobResult>> = {};

  for (const tenant of tenants) {
    if (opts.dryRun) {
      out[tenant.id] = await runJobsForTenant(tenant.id, opts);
      continue;
    }
    const results: Record<string, JobResult> = {};
    for (const job of selectJobs(opts)) {
      const claim = await runClaimedOccurrence(tenant.id, job, at, { workerId: opts.workerId });
      if (claim.result) results[job.name] = claim.result;
      else if (claim.error) {
        results[job.name] = { processed: 0, notified: 0, skippedIdempotent: 0, errors: [claim.error] };
      }
      // Skipped: another run already holds this instant, so it is absent from the results.
    }
    out[tenant.id] = results;
  }
  return out;
}

/**
 * The manual entry point for one tenant: the admin route and anything else
 * that runs jobs on request. It goes through the same claims as the scheduler,
 * so a manual run and a concurrent manual run of the same instant cannot both
 * execute a job.
 */
export async function runManualJobs(tenantId: string, opts: RunOptions = {}): Promise<Record<string, JobResult>> {
  const all = await runAllTenants({ ...opts, tenantId });
  return all[tenantId] ?? {};
}

let timer: NodeJS.Timeout | null = null;

/**
 * How long one attempt may run before it is abandoned. Five minutes is well
 * past any healthy run in this registry; a body that exceeds it is hung, not
 * slow.
 */
const JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * Identifies one claim attempt. Unique per attempt, not per process, so two
 * claims made by the same process cannot pass each other's fence.
 */
const newWorkerId = (): string => `${hostname()}:${process.pid}:${randomUUID()}`;

/**
 * Attempts a job may make. An external, non-idempotent body gets one: a retry
 * would send the email or take the payment again, and a timeout or a crash is
 * not evidence that the side effect did not happen. Those go to the
 * dead-letter, where somebody can see what happened before anything repeats.
 */
export function retryLimit(job: JobDefinition): number {
  return job.sideEffects === 'external' && !job.idempotent ? 1 : MAX_ATTEMPTS;
}

export type ClaimStatus = 'completed' | 'failed' | 'timed_out' | 'dead' | 'skipped' | 'lease_lost' | 'stale';

export interface ClaimResult {
  status: ClaimStatus;
  result?: JobResult;
  error?: string;
}

/**
 * The fence an attempt carries into every write it makes. A write matches only
 * while the row still names this worker and this attempt, so a holder whose
 * lease was taken over cannot record anything afterwards.
 */
export interface AttemptFence {
  id: string;
  workerId: string;
  attempt: number;
}

/**
 * Claim one occurrence of one job for one tenant.
 *
 * One statement: insert the claim, or, on conflict, take the existing row over
 * if it is abandoned (lease expired) or backed off (`runAfter` passed), and
 * attempts remain. Postgres evaluates the conflict's WHERE after it has locked
 * the row, so two workers cannot both win one takeover, and it stays a single
 * round trip. `dead` and completed rows match nothing.
 *
 * The clocks are the database's. A worker whose clock is wrong cannot take a
 * live lease, and cannot hold one past its expiry.
 *
 * Timestamps are written as naive UTC (`now() AT TIME ZONE 'UTC'`): the columns
 * are `timestamp(3)`, and a session in a non-UTC zone would otherwise store
 * wall-clock time that Prisma reads back as UTC.
 */
export async function claimAttempt(
  tenantId: string,
  jobName: string,
  scheduledFor: Date,
  workerId: string,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<{ id: string; attempt: number } | null> {
  const leaseSecs = LEASE_MS / 1000;
  const rows = await unscopedPrisma.$queryRaw<Array<{ id: string; attempt: number }>>`
    INSERT INTO job_claims (id, "tenantId", "jobName", "scheduledFor", status, attempt, "claimedAt", "leaseUntil", "workerId")
    VALUES (${randomUUID()}, ${tenantId}, ${jobName}, ${scheduledFor.toISOString()}::timestamp, 'running', 1,
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSecs}), ${workerId})
    ON CONFLICT ("tenantId", "jobName", "scheduledFor") DO UPDATE
    SET status = 'running',
        attempt = job_claims.attempt + 1,
        "workerId" = EXCLUDED."workerId",
        "claimedAt" = (now() AT TIME ZONE 'UTC'),
        "leaseUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSecs}),
        "heartbeatAt" = NULL,
        "runAfter" = NULL
    WHERE job_claims.attempt < ${maxAttempts}
      AND ((job_claims.status IN ('claimed', 'running') AND job_claims."leaseUntil" <= (now() AT TIME ZONE 'UTC'))
        OR (job_claims.status IN ('failed', 'timed_out') AND job_claims."runAfter" <= (now() AT TIME ZONE 'UTC')))
    RETURNING id, attempt`;
  return rows[0] ?? null;
}

/**
 * Renews the lease. Returns false when the fence no longer matches, which means
 * another attempt holds the claim and this one must stop.
 */
export async function heartbeatAttempt(f: AttemptFence): Promise<boolean> {
  const leaseSecs = LEASE_MS / 1000;
  const n = await unscopedPrisma.$executeRaw`
    UPDATE job_claims
    SET "heartbeatAt" = (now() AT TIME ZONE 'UTC'),
        "leaseUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSecs})
    WHERE id = ${f.id} AND "workerId" = ${f.workerId} AND attempt = ${f.attempt} AND status = 'running'`;
  return n === 1;
}

/** Records success. A stale attempt matches no rows and writes nothing. */
export async function finishAttempt(f: AttemptFence, durationMs: number): Promise<boolean> {
  const { count } = await unscopedPrisma.jobClaim.updateMany({
    where: { id: f.id, workerId: f.workerId, attempt: f.attempt, status: 'running' },
    data: {
      status: 'completed',
      finishedAt: new Date(),
      durationMs,
      lastError: null,
      leaseUntil: new Date(),
    },
  });
  return count === 1;
}

/**
 * Records a failure, or a timeout, and the backoff before the next attempt.
 * On the last attempt the claim is dead-lettered: kept, never retried.
 */
export async function failAttempt(
  f: AttemptFence,
  error: string,
  timedOut: boolean,
  durationMs: number,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<'failed' | 'timed_out' | 'dead' | 'stale'> {
  const exhausted = f.attempt >= maxAttempts;
  const status = exhausted ? 'dead' : timedOut ? 'timed_out' : 'failed';
  const backoffSecs = backoffMs(f.attempt) / 1000;
  const n = await unscopedPrisma.$executeRaw`
    UPDATE job_claims
    SET status = ${status},
        "deadAt" = CASE WHEN ${exhausted} THEN (now() AT TIME ZONE 'UTC') ELSE NULL END,
        "runAfter" = CASE WHEN ${exhausted} THEN NULL
                          ELSE (now() AT TIME ZONE 'UTC') + make_interval(secs => ${backoffSecs}) END,
        "leaseUntil" = (now() AT TIME ZONE 'UTC'),
        "finishedAt" = (now() AT TIME ZONE 'UTC'),
        "durationMs" = ${durationMs},
        "lastError" = ${error.slice(0, 2000)}
    WHERE id = ${f.id} AND "workerId" = ${f.workerId} AND attempt = ${f.attempt} AND status = 'running'`;
  return n === 1 ? status : 'stale';
}

async function emitJobFailed(
  tenantId: string,
  jobName: string,
  scheduledFor: Date,
  attempt: number,
  error: string,
  deadLettered: boolean,
): Promise<void> {
  try {
    await asSystem(tenantId, () =>
      emit({
        name: EVENTS.JOB_FAILED,
        subject: {
          entityType: 'scheduled_job',
          entityId: `${jobName}@${scheduledFor.toISOString()}`,
          recordCode: jobName,
        },
        newState: { jobName, scheduledFor: scheduledFor.toISOString(), attempt, error, deadLettered },
        impact: { domains: ['wfl'], severity: deadLettered ? 'S1_ATTENTION' : 'S2_WARNING' },
      }),
    );
  } catch (err) {
    // Losing the event must not fail the tick; the claim row already holds the state.
    console.error(`[scheduler] could not record failure of ${jobName}`, err);
  }
}

/**
 * Two things that would otherwise sit forever, and so would be invisible:
 * an attempt on its last try whose lease lapsed (nothing will retake it, so it
 * is dead), and a failure whose occurrence has left the catch-up window (nothing
 * will retry it, so it is dead). Both are dead-lettered and announced.
 */
async function sweepTenant(tenantId: string, notBefore: Date, oneShotJobs: string[]): Promise<void> {
  const swept = await unscopedPrisma.$queryRaw<
    Array<{ jobName: string; scheduledFor: Date; attempt: number; lastError: string | null }>
  >`
    UPDATE job_claims
    SET status = 'dead',
        "deadAt" = (now() AT TIME ZONE 'UTC'),
        "runAfter" = NULL,
        "leaseUntil" = (now() AT TIME ZONE 'UTC'),
        "lastError" = COALESCE("lastError", 'abandoned')
    WHERE "tenantId" = ${tenantId}
      AND ((status IN ('claimed', 'running') AND "leaseUntil" <= (now() AT TIME ZONE 'UTC')
            AND ("jobName" = ANY(${oneShotJobs}::text[]) OR attempt >= ${MAX_ATTEMPTS}))
        OR (status IN ('failed', 'timed_out') AND "scheduledFor" < ${notBefore.toISOString()}::timestamp))
    RETURNING "jobName", "scheduledFor", attempt, "lastError"`;

  for (const row of swept) {
    await emitJobFailed(tenantId, row.jobName, row.scheduledFor, row.attempt, row.lastError ?? 'abandoned', true);
    console.error(`[scheduler] ${row.jobName} dead-lettered for tenant ${tenantId}: ${row.lastError ?? 'abandoned'}`);
  }
}

/**
 * Runs one occurrence of one job for one tenant under a claim.
 *
 * The lifecycle, in order: claim (or stand down), heartbeat while the body
 * runs, race the body against the timeout, then record success or failure
 * under the fence. A lost lease stops the body by aborting its signal, and
 * writes nothing: the holder that took the claim owns the outcome.
 *
 * On timeout the heartbeat stops first, so the lease lapses within one lease
 * period and the claim can be taken over. The body is not killed, because
 * nothing in Node can kill a promise. A body that ignores its signal can still
 * be running when its successor starts. That is the residual double-run risk,
 * and it is why job bodies must check the signal between units of work.
 */
export async function runClaimedOccurrence(
  tenantId: string,
  job: JobDefinition,
  scheduledFor: Date,
  opts: { timeoutMs?: number; workerId?: string } = {},
): Promise<ClaimResult> {
  const workerId = opts.workerId ?? newWorkerId();
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;

  const limit = retryLimit(job);
  const claim = await claimAttempt(tenantId, job.name, scheduledFor, workerId, limit);
  if (!claim) return { status: 'skipped' };
  const fence: AttemptFence = { id: claim.id, workerId, attempt: claim.attempt };

  const controller = new AbortController();
  let leaseLost = false;
  const beat = setInterval(() => {
    heartbeatAttempt(fence).then(
      (held) => {
        if (held || leaseLost) return;
        leaseLost = true;
        clearInterval(beat);
        controller.abort(new Error(`lease lost on attempt ${fence.attempt}`));
      },
      () => {
        // A missed beat is retried on the next interval. The lease covers
        // three beats, so one transient database error does not cost the claim.
      },
    );
  }, HEARTBEAT_MS);

  const startedAt = Date.now();
  const attemptRun = await new Promise<
    { ok: true; result: JobResult } | { ok: false; error: string; timedOut: boolean }
  >((resolve) => {
    const limit = setTimeout(() => {
      controller.abort(new Error(`${job.name} exceeded ${timeoutMs}ms`));
      clearInterval(beat);
      resolve({ ok: false, error: `${job.name} exceeded ${timeoutMs}ms and was abandoned`, timedOut: true });
    }, timeoutMs);
    asSystem(tenantId, () => runJobBody(tenantId, job, { signal: controller.signal })).then(
      (result) => {
        clearTimeout(limit);
        resolve({ ok: true, result });
      },
      (err) => {
        clearTimeout(limit);
        resolve({ ok: false, error: messageOf(err), timedOut: false });
      },
    );
  });
  clearInterval(beat);

  if (leaseLost) return { status: 'lease_lost' };

  const durationMs = Date.now() - startedAt;
  if (attemptRun.ok) {
    const done = await finishAttempt(fence, durationMs);
    return done ? { status: 'completed', result: attemptRun.result } : { status: 'stale' };
  }

  const outcome = await failAttempt(fence, attemptRun.error, attemptRun.timedOut, durationMs, limit);
  if (outcome === 'stale') return { status: 'stale', error: attemptRun.error };
  await emitJobFailed(tenantId, job.name, scheduledFor, fence.attempt, attemptRun.error, outcome === 'dead');
  return { status: outcome, error: attemptRun.error };
}

export interface TickOutcome {
  /** Occurrences this process claimed and completed. */
  ran: Array<{ tenantId: string; jobName: string; scheduledFor: Date }>;
  /** Due, but held by another worker, not yet due for retry, or already done. */
  skipped: number;
  /** Failed or timed out this tick; retried after backoff. */
  failed: number;
  /** Retries exhausted; left as a dead-letter row for somebody to look at. */
  deadLettered: number;
}

export interface TickOptions {
  /** Defaults to the registry. */
  jobs?: JobDefinition[];
  /** Defaults to every active tenant. */
  tenantIds?: string[];
  timeoutMs?: number;
  workerId?: string;
}

/**
 * One scheduler tick: run each job's latest occurrence in the catch-up window,
 * plus any earlier occurrence of it that is waiting on a retry, once each.
 *
 * Exported and taking an explicit `now` so a test can drive a simulated day
 * through it rather than waiting for one.
 */
export async function tickOnce(now: Date = new Date(), opts: TickOptions = {}): Promise<TickOutcome> {
  const outcome: TickOutcome = { ran: [], skipped: 0, failed: 0, deadLettered: 0 };
  const notBefore = new Date(now.getTime() - CATCH_UP_MS);
  const jobs = opts.jobs ?? ALL_JOBS;

  const tenants = opts.tenantIds
    ? opts.tenantIds.map((id) => ({ id }))
    : await unscopedPrisma.tenant.findMany({ where: { status: 'active' }, select: { id: true } });

  for (const tenant of tenants) {
    await sweepTenant(
      tenant.id,
      notBefore,
      jobs.filter((j) => retryLimit(j) === 1).map((j) => j.name),
    );

    const retriable = await unscopedPrisma.jobClaim.findMany({
      where: { tenantId: tenant.id, status: { in: ['failed', 'timed_out'] }, scheduledFor: { gte: notBefore } },
      select: { jobName: true, scheduledFor: true },
    });

    for (const job of jobs) {
      const occurrences = new Map<number, Date>();
      const due = dueOccurrence(job.cron, now, notBefore);
      if (due) occurrences.set(due.getTime(), due);
      for (const r of retriable) {
        if (r.jobName === job.name) occurrences.set(r.scheduledFor.getTime(), r.scheduledFor);
      }

      for (const occurrence of occurrences.values()) {
        const r = await runClaimedOccurrence(tenant.id, job, occurrence, {
          timeoutMs: opts.timeoutMs,
          workerId: opts.workerId,
        });
        switch (r.status) {
          case 'completed':
            outcome.ran.push({ tenantId: tenant.id, jobName: job.name, scheduledFor: occurrence });
            break;
          case 'failed':
          case 'timed_out':
            outcome.failed++;
            break;
          case 'dead':
            outcome.deadLettered++;
            console.error(`[scheduler] ${job.name} dead-lettered for tenant ${tenant.id}: ${r.error}`);
            break;
          default:
            outcome.skipped++;
        }
      }
    }
  }

  return outcome;
}

/**
 * Refuses to start on a job whose cron does not parse. Such a job would never
 * fire, which is the invisible failure this scheduler exists to remove.
 */
export function assertSchedulable(jobs: JobDefinition[]): void {
  const bad = jobs.filter((j) => !isValidCron(j.cron));
  if (bad.length) {
    throw new Error(`Unparseable cron on: ${bad.map((j) => `${j.name} (${j.cron})`).join(', ')}`);
  }
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

  assertSchedulable(ALL_JOBS);

  const tick = async () => {
    try {
      const outcome = await tickOnce(new Date());
      if (outcome.ran.length || outcome.deadLettered || outcome.failed) {
        console.log(
          `[scheduler] ran ${outcome.ran.length}, failed ${outcome.failed}, skipped ${outcome.skipped}, dead-lettered ${outcome.deadLettered}`,
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
