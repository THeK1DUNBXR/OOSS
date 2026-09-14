/**
 * Technology — assets jobs (docs/plan/cio.md, workstream A).
 *
 * Three idempotent detectors, each keyed the way the compliance calendar's
 * ladder is: a rung already recorded never re-fires, and an already-open
 * exception on the same subject/code never duplicates (`raiseException`'s
 * own idempotency, keyed on `triggerFingerprint`/`ladderRung`).
 */

import { runWarrantyLadder, runInRepairTooLongDetector, runOrphanedAssetDetector } from '../../domains/it/assets.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

export async function runAssetWarrantyLadderJob(): Promise<JobResult> {
  const errors: string[] = [];
  let result: Awaited<ReturnType<typeof runWarrantyLadder>> = { checked: 0, notified: 0, skippedIdempotent: 0 };
  try {
    result = await runWarrantyLadder();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { processed: result.checked, notified: result.notified, skippedIdempotent: result.skippedIdempotent, errors };
}

export async function runAssetInRepairTooLongJob(): Promise<JobResult> {
  const errors: string[] = [];
  let result: Awaited<ReturnType<typeof runInRepairTooLongDetector>> = { checked: 0, flagged: 0 };
  try {
    result = await runInRepairTooLongDetector();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { processed: result.checked, notified: result.flagged, skippedIdempotent: result.checked - result.flagged, errors };
}

export async function runAssetOrphanedDetectorJob(): Promise<JobResult> {
  const errors: string[] = [];
  let result: Awaited<ReturnType<typeof runOrphanedAssetDetector>> = { checked: 0, flagged: 0 };
  try {
    result = await runOrphanedAssetDetector();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { processed: result.checked, notified: result.flagged, skippedIdempotent: result.checked - result.flagged, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runAssetWarrantyLadderJob',
    label: 'IT assets: warranty ladder 90/30/7/expired (IT-AST)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runAssetWarrantyLadderJob,
  },
  {
    name: 'runAssetInRepairTooLongJob',
    label: 'IT assets: in-repair-too-long detector (IT-AST)',
    automationClass: 'threshold_response',
    cron: '15 6 * * *',
    run: runAssetInRepairTooLongJob,
  },
  {
    name: 'runAssetOrphanedDetectorJob',
    label: "IT assets: orphaned asset detector — holder's affiliation ended (IT-AST-005)",
    automationClass: 'threshold_response',
    cron: '30 6 * * *',
    run: runAssetOrphanedDetectorJob,
  },
];
