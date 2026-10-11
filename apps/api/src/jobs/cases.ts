/**
 * Cases: an open case past its response due instant is flagged overdue (OP:116).
 *
 * The job flags. It never acknowledges, resolves or closes: a case nobody has
 * acknowledged stays open, with the flag saying the company is late. Only `open`
 * rows without a flag are candidates, so a rerun finds nothing to change. The
 * write itself is conditional on the state, the flag and the due instant
 * (domains/cases.ts flagCaseOverdue), so a second pass writes nothing.
 *
 * The scheduler runs this inside the tenant's system context, so every read and
 * write here is scoped to the tenant the job is for.
 */

import { prisma } from '../platform/db.js';
import { flagCaseOverdue } from '../domains/cases.js';
import type { JobDefinition, JobResult } from './scheduler.js';

export async function runCaseOverdueJob(): Promise<JobResult> {
  const now = new Date();
  const due = await prisma.case.findMany({
    where: { state: 'open', overdueFlaggedAt: null, responseDueAt: { lt: now } },
    select: { id: true },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  const errors: string[] = [];

  for (const { id } of due) {
    try {
      if (await flagCaseOverdue(id, now)) notified += 1;
      else skippedIdempotent += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: due.length, notified, skippedIdempotent, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runCaseOverdueJob',
    sideEffects: 'internal',
    idempotent: true,
    label: 'Cases: open and past the response due instant, flagged overdue (never acknowledged)',
    automationClass: 'threshold_response',
    cron: '*/15 * * * *',
    run: runCaseOverdueJob,
  },
];
