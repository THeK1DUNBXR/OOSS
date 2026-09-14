/**
 * Technology — portfolio jobs (docs/plan/cio.md, workstream G).
 *
 * Two idempotent detectors:
 *   - a stale in-flight initiative — no update within `stale_initiative_days`
 *     — raises an exception on its owner, once, cleared the moment a fresh
 *     update lands (`postInitiativeUpdate` resets `staleNotifiedAt`).
 *   - a budget line burning ahead of the FY elapsed fraction by more than
 *     `budget_burn_margin_pct` raises `IT_BUDGET_BURN`, once per FY per line
 *     (a line covers exactly one FY, so `burnNotifiedAt` alone is enough).
 */

import { IT_DOMAIN, burnAhead, fyElapsedFraction } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import { computeBudgetActual, getSetting } from '../../domains/it/portfolio.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

async function resolveOperationsHeadPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

export async function runStaleInitiativeJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  const staleDays = await getSetting<number>('stale_initiative_days', 21);

  const initiatives = await prisma.itInitiative.findMany({
    where: { tenantId: auth.tenantId, stage: 'in_flight' },
    include: { updates: { orderBy: { at: 'desc' }, take: 1 } },
  });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const initiative of initiatives) {
    const lastActivity = initiative.updates[0]?.at ?? initiative.createdAt;
    const daysQuiet = Math.floor((Date.now() - lastActivity.getTime()) / 86_400_000);
    if (daysQuiet < staleDays) continue;

    if (initiative.staleNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }

    try {
      await raiseException({
        code: 'IT_INITIATIVE_STALE',
        label: `${initiative.recordCode} has had no update in ${daysQuiet} days`,
        severity: daysQuiet >= staleDays * 2 ? 'S3_HIGH_RISK' : 'S2_WARNING',
        subjectType: 'it_initiative',
        subjectId: initiative.id,
        subjectLabel: initiative.recordCode,
        domain: IT_DOMAIN,
        detail: `${initiative.title} is in flight and has had no status update in ${daysQuiet} days (threshold ${staleDays}). Post an update, or it will keep escalating.`,
        ownerPartyId: initiative.ownerPartyId,
        triggerFingerprint: 'it_initiative_stale',
        ladderRung: 0,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    await prisma.itInitiative.update({ where: { id: initiative.id }, data: { staleNotifiedAt: new Date() } });
  }

  return { processed: initiatives.length, notified, skippedIdempotent, errors };
}

export async function runBudgetBurnJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  const marginPct = await getSetting<number>('budget_burn_margin_pct', 15);

  const lines = await prisma.itBudgetLine.findMany({
    where: { tenantId: auth.tenantId, status: 'approved', burnNotifiedAt: null },
  });

  let notified = 0;
  const now = new Date();

  for (const line of lines) {
    const planned = Number(line.planned);
    const actual = await computeBudgetActual(line);
    const elapsed = fyElapsedFraction(line.fy, now);
    const result = burnAhead(planned, actual, elapsed, marginPct);
    if (!result.exceeds) continue;

    const ownerPartyId = line.createdById ?? (await resolveOperationsHeadPartyId());

    try {
      await raiseException({
        code: 'IT_BUDGET_BURN',
        label: `${line.fy} ${line.category} is burning ahead of the year`,
        severity: 'S2_WARNING',
        subjectType: 'it_budget_line',
        subjectId: line.id,
        subjectLabel: `${line.fy} — ${line.category}${line.division ? ` (${line.division})` : ''}`,
        domain: IT_DOMAIN,
        detail: `${Math.round(elapsed * 100)}% of ${line.fy} has elapsed but ${planned > 0 ? Math.round((actual / planned) * 100) : 0}% of the planned ${planned} has been spent — ${Math.round(result.aheadBy * 100)} points ahead of a ${marginPct}% margin.`,
        ownerPartyId,
        triggerFingerprint: 'it_budget_burn',
        ladderRung: 0,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    await prisma.itBudgetLine.update({ where: { id: line.id }, data: { burnNotifiedAt: new Date() } });
  }

  return { processed: lines.length, notified, skippedIdempotent: 0, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runStaleInitiativeJob',
    label: 'Portfolio: stale in-flight initiatives (IT_INITIATIVE_STALE)',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: runStaleInitiativeJob,
  },
  {
    name: 'runBudgetBurnJob',
    label: 'Portfolio: budget burn ahead of the FY elapsed fraction (IT_BUDGET_BURN)',
    automationClass: 'threshold_response',
    cron: '30 7 * * *',
    run: runBudgetBurnJob,
  },
];
