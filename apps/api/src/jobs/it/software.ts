/**
 * Technology — applications, licences and subscriptions daily job
 * (docs/plan/cio.md, workstream B).
 *
 * Three detectors, each idempotent on its own terms: the renewal ladder
 * (90/60/30/7 days out and expired) fires once per rung via
 * `renewalNotifiedRungs` on the row and `raiseException`'s own
 * triggerFingerprint+ladderRung dedupe; the seat over-allocation and
 * under-use sweeps rely on `raiseException`'s open-exception dedupe (the
 * condition is a standing fact, not a discrete rung, so a second run while
 * it still holds returns the already-open exception rather than raising a
 * second one); the unowned-application sweep is the same shape as
 * `CMP_CAL_UNOWNED` in the compliance calendar.
 */

import { asSystem } from '../../platform/context.js';
import { runRenewalLadder, runSeatExceptionSweep, flagUnownedApplications } from '../../domains/it/software.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

export async function runItSoftwareJob(): Promise<JobResult> {
  const errors: string[] = [];

  let renewal = { notified: 0, flippedToExpiring: 0, flippedToExpired: 0 };
  let seats = { overAllocated: 0, underUsed: 0 };
  let unowned = 0;

  try {
    renewal = await runRenewalLadder();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    seats = await runSeatExceptionSweep();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    unowned = await flagUnownedApplications();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    processed: renewal.notified + renewal.flippedToExpiring + renewal.flippedToExpired + seats.overAllocated + seats.underUsed + unowned,
    notified: renewal.notified + seats.overAllocated + seats.underUsed + unowned,
    skippedIdempotent: 0,
    errors,
  };
}

/** Runs the job as SYSTEM_PRINCIPAL for every tenant — the scheduler's own
 * per-tenant loop pattern, mirrored here so this file is self-contained and
 * callable directly in tests without a caller building tenant fan-out. */
export async function runItSoftwareJobForTenant(tenantId: string): Promise<JobResult> {
  return asSystem(tenantId, () => runItSoftwareJob());
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runItSoftwareJob',
    label: 'Technology — applications & licences: renewal ladder, seat exceptions, unowned applications (IT-LIC/IT-APP)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runItSoftwareJob,
  },
];
