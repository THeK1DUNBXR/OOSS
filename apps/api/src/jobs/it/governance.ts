/**
 * Technology — governance jobs (docs/plan/cio.md, workstream F).
 *
 * Five ladders/detectors, each idempotent per rung the way the compliance
 * calendar's daily job is: risk review overdue, finding overdue by severity,
 * control test overdue (by frequency), policy re-acknowledgement due (one
 * exception per policy naming the count), and access-review campaign
 * overdue.
 */

import { IT_DOMAIN } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import {
  runRiskReviewLadder,
  runFindingOverdueLadder,
  runCampaignOverdueDetector,
  publishedPolicyAudiences,
  resolveOpsHeadPartyId,
} from '../../domains/it/governance.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

export async function runRiskReviewJob(): Promise<JobResult> {
  const result = await runRiskReviewLadder();
  return { processed: result.checked, notified: result.notified, skippedIdempotent: result.skippedIdempotent, errors: [] };
}

export async function runFindingOverdueJob(): Promise<JobResult> {
  const result = await runFindingOverdueLadder();
  return { processed: result.checked, notified: result.notified, skippedIdempotent: result.skippedIdempotent, errors: [] };
}

export async function runAccessReviewOverdueJob(): Promise<JobResult> {
  const result = await runCampaignOverdueDetector();
  return { processed: result.checked, notified: result.notified, skippedIdempotent: 0, errors: [] };
}

/** A control is overdue for testing once `frequencyDays` has elapsed since
 * `lastTestedAt` (or since it was created, for a control never yet tested).
 * `testOverdueNotifiedAt` gates re-firing for the same overdue window —
 * `recordTest` clears it, so a fresh test always re-arms the detector. */
export async function runControlTestOverdueJob(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const rows = await prisma.itControl.findMany({ where: { tenantId: auth.tenantId, status: 'active' } });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const row of rows) {
    const baseline = row.lastTestedAt ?? row.createdAt;
    const dueAt = new Date(baseline.getTime() + row.frequencyDays * 86_400_000);
    if (dueAt >= now) continue;

    if (row.testOverdueNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }

    await raiseException({
      code: 'IT_CTL_TEST_OVERDUE',
      label: `${row.title} test overdue`,
      severity: 'S2_WARNING',
      subjectType: 'it_control',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: `${row.title} (${row.recordCode}) was due to be tested every ${row.frequencyDays} days and was last tested ${row.lastTestedAt ? row.lastTestedAt.toISOString().slice(0, 10) : 'never'}.`,
      ownerPartyId: row.ownerPartyId,
      slaDueAt: dueAt,
      triggerFingerprint: 'it_control_test_overdue',
    });
    notified += 1;
    await prisma.itControl.update({ where: { id: row.id }, data: { testOverdueNotifiedAt: now } });
  }

  return { processed: rows.length, notified, skippedIdempotent, errors: [] };
}

/** One exception per policy naming how many people still owe it a
 * re-acknowledgement, raised once per re-acknowledgement window — never one
 * exception per outstanding person, which would flood the queue. */
export async function runPolicyReacknowledgementJob(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const audiences = await publishedPolicyAudiences();
  const opsHead = await resolveOpsHeadPartyId();

  let notified = 0;
  let skippedIdempotent = 0;

  for (const a of audiences) {
    if (!a.policy.reacknowledgeMonths || !a.policy.publishedAt) continue;
    const windowStart = new Date(a.policy.publishedAt);
    windowStart.setUTCMonth(windowStart.getUTCMonth() + a.policy.reacknowledgeMonths);
    if (windowStart > now) continue;

    const outstanding = a.targetPartyIds.filter((id) => !a.acknowledgedPartyIds.includes(id));
    if (!outstanding.length) continue;

    const fingerprint = `it_policy_reack_${a.policy.id}_${windowStart.toISOString().slice(0, 7)}`;
    const already = await prisma.exceptionRecord.findFirst({
      where: { tenantId: auth.tenantId, subjectType: 'it_policy_document', subjectId: a.policy.id, code: 'IT_POL_REACK_DUE', triggerFingerprint: fingerprint },
    });
    if (already) {
      skippedIdempotent += 1;
      continue;
    }

    await raiseException({
      code: 'IT_POL_REACK_DUE',
      label: `${a.policy.title}: ${outstanding.length} still to re-acknowledge`,
      severity: 'S2_WARNING',
      subjectType: 'it_policy_document',
      subjectId: a.policy.id,
      subjectLabel: a.policy.recordCode,
      domain: IT_DOMAIN,
      detail: `${a.policy.title} (${a.policy.recordCode}, v${a.policy.version}) is due for re-acknowledgement every ${a.policy.reacknowledgeMonths} months. ${outstanding.length} of ${a.targetPartyIds.length} in scope have not yet re-acknowledged this window.`,
      ownerPartyId: opsHead,
      triggerFingerprint: fingerprint,
    });
    notified += 1;
  }

  return { processed: audiences.length, notified, skippedIdempotent, errors: [] };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runRiskReviewJob',
    label: 'IT governance: risk review overdue ladder (IT-RSK)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runRiskReviewJob,
  },
  {
    name: 'runFindingOverdueJob',
    label: 'IT governance: security finding remediation overdue ladder (IT-FND)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runFindingOverdueJob,
  },
  {
    name: 'runControlTestOverdueJob',
    label: 'IT governance: control test overdue (IT-CTL)',
    automationClass: 'threshold_response',
    cron: '15 6 * * *',
    run: runControlTestOverdueJob,
  },
  {
    name: 'runPolicyReacknowledgementJob',
    label: 'IT governance: policy re-acknowledgement due (IT-POL)',
    automationClass: 'threshold_response',
    cron: '30 6 * * *',
    run: runPolicyReacknowledgementJob,
  },
  {
    name: 'runAccessReviewOverdueJob',
    label: 'IT governance: access-review campaign overdue (IT-ACR)',
    automationClass: 'threshold_response',
    cron: '45 6 * * *',
    run: runAccessReviewOverdueJob,
  },
];
