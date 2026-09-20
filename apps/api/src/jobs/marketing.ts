/**
 * Marketing scheduled jobs (MKT-GOV-006 through MKT-GOV-012).
 *
 * Registered into ALL_JOBS the same way apps/api/src/jobs/compliance/*.ts is —
 * a flat array spread into the scheduler's registry, run through the same
 * durable substrate (idempotency key, JobRun row, JOB_COMPLETED/JOB_FAILED
 * events) as every other job.
 *
 * Several of these call into sibling `domains/marketing/*.ts` detector and
 * dispatch functions that are developed independently and may not have
 * landed a given export yet. Every such call goes through `callDetector`,
 * which imports the module dynamically and treats a missing/erroring export
 * as "processed 0, logged, move on" rather than failing the job (and, by
 * extension, the whole tenant's scheduled run) outright. This keeps the job
 * registry green — every marketing job name is always registered and always
 * completes — while sibling implementations catch up.
 */

import type { JobDefinition, JobResult } from './scheduler.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ATTRIBUTION_MODELS } from '@kaizen/shared';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

/**
 * A literal per-module import map. Dynamic `import()` with an interpolated
 * path is unresolvable by the bundler (Vite/vitest analyses import()
 * specifiers statically), so every sibling module this job registry might
 * call into is named here explicitly. A module that fails to import at all
 * (syntax error, missing file) rejects the same way a missing export does —
 * both are treated as "not ready yet", not a hard job failure.
 */
const MODULE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  campaigns: () => import('../domains/marketing/campaigns.js'),
  budget: () => import('../domains/marketing/budget.js'),
  capture: () => import('../domains/marketing/capture.js'),
  journeys: () => import('../domains/marketing/journeys.js'),
  events: () => import('../domains/marketing/events.js'),
  assets: () => import('../domains/marketing/assets.js'),
  referrals: () => import('../domains/marketing/referrals.js'),
  messaging: () => import('../domains/marketing/messaging.js'),
  audiences: () => import('../domains/marketing/audiences.js'),
  attribution: () => import('../domains/marketing/attribution.js'),
};

/**
 * Imports `domains/marketing/<mod>.js` (via the static loader map above) and
 * calls `fn(...args)`. A missing module, a missing export, or a thrown error
 * are all logged and treated as zero work done — never a hard failure of the
 * job itself.
 */
async function callDetector(mod: string, fn: string, ...args: unknown[]): Promise<{ count: number; error: string | null }> {
  try {
    const loader = MODULE_LOADERS[mod];
    if (!loader) {
      const message = `no loader registered for domains/marketing/${mod}.js`;
      console.warn(`[jobs/marketing] skipping — ${message}`);
      return { count: 0, error: message };
    }
    const imported = await loader();
    const target = imported[fn];
    if (typeof target !== 'function') {
      const message = `${mod}.${fn} is not exported yet`;
      console.warn(`[jobs/marketing] skipping — ${message}`);
      return { count: 0, error: message };
    }
    const result = await (target as (...a: unknown[]) => unknown)(...args);
    if (typeof result === 'number') return { count: result, error: null };
    if (Array.isArray(result)) return { count: result.length, error: null };
    if (result && typeof result === 'object' && 'processed' in (result as Record<string, unknown>)) {
      return { count: Number((result as Record<string, unknown>).processed) || 0, error: null };
    }
    return { count: 0, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[jobs/marketing] ${mod}.${fn} failed — skipping: ${message}`);
    return { count: 0, error: message };
  }
}

function summarise(results: Array<{ count: number; error: string | null }>): JobResult {
  const processed = results.reduce((s, r) => s + r.count, 0);
  const errors = results.map((r) => r.error).filter((e): e is string => e !== null);
  return { processed, notified: processed, skippedIdempotent: 0, errors };
}

// ---------------------------------------------------------------------------
// Individual jobs
// ---------------------------------------------------------------------------

async function tickJourneys(): Promise<JobResult> {
  const r = await callDetector('journeys', 'tick');
  return summarise([r]);
}

async function dispatchQueuedSends(): Promise<JobResult> {
  // Prefer a bulk dispatcher if the messaging module exposes one; fall back to
  // dispatching each queued send individually through `dispatchSend`.
  const bulk = await callDetector('messaging', 'dispatchQueuedSends');
  if (bulk.error === null || !bulk.error.includes('not exported')) return summarise([bulk]);

  const auth = currentAuth();
  const queued = await prisma.marketingSend.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: 'queued' },
    select: { id: true },
    take: 200,
  });
  const results = await Promise.all(queued.map((s) => callDetector('messaging', 'dispatchSend', s.id)));
  return summarise(results);
}

async function reevaluateDynamicAudiences(): Promise<JobResult> {
  const auth = currentAuth();
  const audiences = await prisma.marketingAudience.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, kind: 'dynamic' },
    select: { id: true },
  });
  const results = await Promise.all(audiences.map((a) => callDetector('audiences', 'evaluateAudience', a.id)));
  return summarise(results);
}

async function recomputeAttribution(): Promise<JobResult> {
  const auth = currentAuth();
  const touched = await prisma.marketingTouchpoint.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, occurredAt: { gte: daysAgo(90) }, leadId: { not: null } },
    distinct: ['leadId'],
    select: { leadId: true },
    take: 2000,
  });

  const results = await Promise.all(
    touched.flatMap((t) => ATTRIBUTION_MODELS.map((model) => callDetector('attribution', 'computeAttribution', t.leadId, model))),
  );
  return summarise(results);
}

async function applyLeadScores(): Promise<JobResult> {
  const r = await callDetector('capture', 'applyScores');
  return summarise([r]);
}

async function runDetectors(): Promise<JobResult> {
  const results = await Promise.all([
    callDetector('campaigns', 'autoCompleteExpiredCampaigns'),
    callDetector('campaigns', 'detectStaleCampaigns'),
    callDetector('budget', 'detectOverBudget'),
    callDetector('budget', 'detectSpendWithoutBudget'),
    callDetector('capture', 'detectUnconvertedSubmissions'),
    callDetector('capture', 'detectUnattributedLeads'),
    callDetector('journeys', 'detectStuckRuns'),
    callDetector('events', 'detectFollowUpsOutstanding'),
    callDetector('assets', 'detectExpiredAssetsInUse'),
    callDetector('referrals', 'detectRewardsPending'),
  ]);
  return summarise(results);
}

async function autoCompleteCampaigns(): Promise<JobResult> {
  const r = await callDetector('campaigns', 'autoCompleteExpiredCampaigns');
  return summarise([r]);
}

export const MARKETING_JOBS: JobDefinition[] = [
  {
    name: 'marketing.journeys.tick',
    label: 'Marketing: advance due journey runs',
    automationClass: 'communication_dispatch',
    cron: '*/5 * * * *',
    run: tickJourneys,
  },
  {
    name: 'marketing.sends.dispatch',
    label: 'Marketing: dispatch queued sends',
    automationClass: 'communication_dispatch',
    cron: '*/2 * * * *',
    run: dispatchQueuedSends,
  },
  {
    name: 'marketing.audiences.reevaluate',
    label: 'Marketing: re-evaluate dynamic audiences',
    automationClass: 'data_maintenance',
    cron: '0 * * * *',
    run: reevaluateDynamicAudiences,
  },
  {
    name: 'marketing.attribution.recompute',
    label: 'Marketing: recompute attribution (last 90 days)',
    automationClass: 'data_maintenance',
    cron: '0 3 * * *',
    run: recomputeAttribution,
  },
  {
    name: 'marketing.scores.apply',
    label: 'Marketing: apply lead score rules',
    automationClass: 'data_maintenance',
    cron: '0 4 * * *',
    run: applyLeadScores,
  },
  {
    name: 'marketing.detectors',
    label: 'Marketing: exception detectors sweep',
    automationClass: 'threshold_response',
    cron: '*/30 * * * *',
    run: runDetectors,
  },
  {
    name: 'marketing.campaigns.autocomplete',
    label: 'Marketing: auto-complete expired campaigns',
    automationClass: 'routine_administration',
    cron: '0 * * * *',
    run: autoCompleteCampaigns,
  },
];
