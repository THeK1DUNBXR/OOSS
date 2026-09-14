/**
 * Technology — incidents, problems and changes jobs (docs/plan/cio.md,
 * workstream E).
 *
 * Three detectors, each a one-shot marker on the row rather than a ladder of
 * rungs — the condition each watches is binary (stale or not; overdue or
 * not; window missed or not), so idempotence is "already notified, or not":
 *   - a live sev1/sev2 with no update in `staleMinutes` raises an exception
 *     on the commander, cleared the moment a fresh update or transition
 *     lands (`staleNotifiedAt` reset to null in the domain);
 *   - a resolved sev1/sev2 with no published review after
 *     `reviewOverdueDays` raises one, cleared once the review publishes;
 *   - a change whose window has passed without reaching `implemented` (or
 *     further) raises one on the requester.
 */

import { EVENTS, type SeverityCode } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import { emit } from '../../platform/eventBus.js';
import { currentPolicy } from '../../domains/it/itsm.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

export async function runStaleIncidentJob(): Promise<JobResult> {
  const auth = currentAuth();
  const policy = await currentPolicy();
  const cutoff = new Date(Date.now() - policy.staleMinutes * 60_000);

  const candidates = await prisma.itIncident.findMany({
    where: {
      tenantId: auth.tenantId,
      severity: { in: ['sev1', 'sev2'] },
      status: { in: ['declared', 'acknowledged', 'mitigated'] },
      lastActivityAt: { lte: cutoff },
    },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  const errors: string[] = [];

  for (const inc of candidates) {
    if (inc.staleNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }
    try {
      await raiseException({
        code: 'IT_INCIDENT_STALE',
        label: `${inc.recordCode ?? inc.id} has had no update in ${policy.staleMinutes} minutes`,
        severity: inc.severity === 'sev1' ? ('S4_CRITICAL' as SeverityCode) : ('S3_HIGH_RISK' as SeverityCode),
        subjectType: 'it_incident',
        subjectId: inc.id,
        subjectLabel: inc.recordCode ?? inc.title,
        domain: 'it',
        detail: `${inc.title} (${inc.severity}) is still ${inc.status} with no update since ${inc.lastActivityAt.toISOString()}, past the ${policy.staleMinutes}-minute threshold.`,
        ownerPartyId: inc.commanderPartyId,
        triggerFingerprint: 'it_incident_stale',
      });
      await prisma.itIncident.update({ where: { id: inc.id }, data: { staleNotifiedAt: new Date() } });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: candidates.length, notified, skippedIdempotent, errors };
}

export async function runReviewOverdueJob(): Promise<JobResult> {
  const auth = currentAuth();
  const policy = await currentPolicy();
  const cutoff = new Date(Date.now() - policy.reviewOverdueDays * 86_400_000);

  const candidates = await prisma.itIncident.findMany({
    where: {
      tenantId: auth.tenantId,
      reviewRequired: true,
      reviewPublishedAt: null,
      resolvedAt: { not: null, lte: cutoff },
    },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  const errors: string[] = [];

  for (const inc of candidates) {
    if (inc.reviewOverdueNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }
    try {
      await raiseException({
        code: 'IT_INCIDENT_REVIEW_OVERDUE',
        label: `${inc.recordCode ?? inc.id}'s post-incident review is overdue`,
        severity: 'S2_WARNING' as SeverityCode,
        subjectType: 'it_incident',
        subjectId: inc.id,
        subjectLabel: inc.recordCode ?? inc.title,
        domain: 'it',
        detail: `${inc.title} (${inc.severity}) resolved on ${inc.resolvedAt!.toISOString().slice(0, 10)} and still has no published post-incident review, past the ${policy.reviewOverdueDays}-day threshold.`,
        ownerPartyId: inc.commanderPartyId,
        triggerFingerprint: 'it_incident_review_overdue',
      });
      await prisma.itIncident.update({ where: { id: inc.id }, data: { reviewOverdueNotifiedAt: new Date() } });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: candidates.length, notified, skippedIdempotent, errors };
}

export async function runChangeWindowMissedJob(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();

  const candidates = await prisma.itChange.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { in: ['approved', 'scheduled'] },
      windowEnd: { lt: now },
    },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  const errors: string[] = [];

  for (const chg of candidates) {
    if (chg.windowMissedNotifiedAt) {
      skippedIdempotent += 1;
      continue;
    }
    try {
      await raiseException({
        code: 'IT_CHANGE_WINDOW_MISSED',
        label: `${chg.recordCode ?? chg.id}'s window passed without implementation`,
        severity: 'S2_WARNING' as SeverityCode,
        subjectType: 'it_change',
        subjectId: chg.id,
        subjectLabel: chg.recordCode ?? chg.title,
        domain: 'it',
        detail: `${chg.title} was due to implement by ${chg.windowEnd.toISOString()} and is still ${chg.status}.`,
        ownerPartyId: chg.requesterPartyId,
        triggerFingerprint: 'it_change_window_missed',
      });
      await prisma.itChange.update({ where: { id: chg.id }, data: { windowMissedNotifiedAt: new Date() } });
      await emit({
        name: EVENTS.IT_CHANGE_TRANSITIONED,
        subject: { entityType: 'it_change', entityId: chg.id, recordCode: chg.recordCode },
        newState: { status: chg.status, windowMissed: true },
        owner: { partyId: chg.requesterPartyId },
        impact: { domains: ['it'], severity: 'S2_WARNING' },
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: candidates.length, notified, skippedIdempotent, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runItsmStaleIncidentJob',
    label: 'ITSM: stale sev1/sev2 incident with no recent update',
    automationClass: 'threshold_response',
    cron: '*/15 * * * *',
    run: runStaleIncidentJob,
  },
  {
    name: 'runItsmReviewOverdueJob',
    label: 'ITSM: sev1/sev2 resolved without a published review',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: runReviewOverdueJob,
  },
  {
    name: 'runItsmChangeWindowMissedJob',
    label: 'ITSM: change window passed without implementation',
    automationClass: 'threshold_response',
    cron: '0 * * * *',
    run: runChangeWindowMissedJob,
  },
];
