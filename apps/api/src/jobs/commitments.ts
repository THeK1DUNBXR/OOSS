/**
 * Commitments: a confirmed promise whose due instant has passed is marked missed
 * (OP:115; the due check is an instant comparison, not an IST day).
 *
 * Only `confirmed` rows are candidates. A `proposed` row was never a promise the
 * company made, so its lateness is not a fact to record; a `met` or `cancelled`
 * row is closed. The write itself is conditional on the state and the due
 * instant (domains/commitments.ts markCommitmentMissedIfDue), so a second pass
 * over the same rows finds nothing to change and writes nothing.
 *
 * The scheduler runs this inside the tenant's system context, so every read and
 * write here is scoped to the tenant the job is for.
 */

import { prisma } from '../platform/db.js';
import { markCommitmentMissedIfDue } from '../domains/commitments.js';
import type { JobDefinition, JobResult } from './scheduler.js';

export async function runCommitmentMissedJob(): Promise<JobResult> {
  const now = new Date();
  const due = await prisma.commitment.findMany({
    where: { state: 'confirmed', dueAt: { lt: now } },
    select: { id: true },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  const errors: string[] = [];

  for (const { id } of due) {
    try {
      if (await markCommitmentMissedIfDue(id, now)) notified += 1;
      else skippedIdempotent += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: due.length, notified, skippedIdempotent, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runCommitmentMissedJob',
    sideEffects: 'internal',
    idempotent: true,
    label: 'Commitments: confirmed and past its due instant, marked missed',
    automationClass: 'threshold_response',
    cron: '*/15 * * * *',
    run: runCommitmentMissedJob,
  },
];
