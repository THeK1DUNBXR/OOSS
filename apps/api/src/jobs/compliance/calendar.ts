/**
 * Compliance calendar daily job (docs/plan/compliance.md, workstream A).
 *
 * Runs once a day per tenant: materialises the next three months of
 * obligations, flips `upcoming` -> `due` -> `overdue` as deadlines approach
 * and pass, and fires the 30/7/1-days-before and 1-day-after ladder.
 * Idempotent both ways — `generateObligations` never re-creates a period
 * already materialised, and a ladder rung already recorded on
 * `notifiedRungs` never re-fires, so running the job twice on the same day
 * produces one exception, not two.
 */

import { CALENDAR_LADDER_RUNGS, type SeverityCode } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import { generateObligations, resolveOwnerPartyId } from '../../domains/compliance/calendar.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

const HORIZON_MONTHS = 3;

/** Severity climbs as the runway shortens, the same shape the MoU/contract
 * expiry ladders use — widest rung mildest, overdue most severe. */
function severityFor(rung: number): SeverityCode {
  if (rung < 0) return 'S4_CRITICAL';
  if (rung <= 1) return 'S3_HIGH_RISK';
  if (rung <= 7) return 'S2_WARNING';
  return 'S1_ATTENTION';
}

export async function runComplianceCalendarJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];

  let generated = 0;
  try {
    const result = await generateObligations(HORIZON_MONTHS);
    generated = result.created;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const now = new Date();
  const rows = await prisma.complianceObligation.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['upcoming', 'due', 'overdue'] } },
    include: { type: true },
  });

  let notified = 0;
  let skippedIdempotent = 0;
  let statusFlips = 0;

  for (const row of rows) {
    const daysToDue = Math.ceil((row.dueAt.getTime() - now.getTime()) / 86_400_000);
    const newStatus = daysToDue < 0 ? 'overdue' : daysToDue <= 30 ? 'due' : 'upcoming';
    if (newStatus !== row.status) {
      await prisma.complianceObligation.update({ where: { id: row.id }, data: { status: newStatus } });
      statusFlips += 1;
    }

    // Every rung the runway has already crossed; the tightest is the one that
    // describes the situation now (the same reasoning `runExpiryLadder` uses).
    const crossed = CALENDAR_LADDER_RUNGS.filter((r) => daysToDue <= r);
    const rung = crossed.length ? crossed[crossed.length - 1] : undefined;
    if (rung === undefined) continue;

    const already = row.notifiedRungs ?? [];
    if (already.includes(rung)) {
      skippedIdempotent += 1;
      continue;
    }

    const ownerPartyId = await resolveOwnerPartyId(row.type.ownerRoleSlug);
    const overdue = rung < 0;

    try {
      await raiseException({
        code: overdue ? 'CMP_CAL_OVERDUE' : 'CMP_CAL_DUE',
        label: overdue
          ? `${row.type.label} overdue`
          : `${row.type.label} due in ${rung} day${rung === 1 ? '' : 's'}`,
        severity: severityFor(rung),
        subjectType: 'compliance_obligation',
        subjectId: row.id,
        subjectLabel: row.recordCode ?? `${row.type.code} ${row.period}`,
        domain: row.type.domain,
        detail: overdue
          ? `${row.type.label} for ${row.period} was due ${row.dueAt.toISOString().slice(0, 10)} and has not been filed or waived.`
          : `${row.type.label} for ${row.period} is due ${row.dueAt.toISOString().slice(0, 10)}, in ${rung} day${rung === 1 ? '' : 's'}.`,
        ownerPartyId,
        slaDueAt: row.dueAt,
        triggerFingerprint: 'compliance_obligation_due_ladder',
        ladderRung: rung,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    await prisma.complianceObligation.update({
      where: { id: row.id },
      data: { notifiedRungs: [...new Set([...already, ...crossed])] },
    });
  }

  return { processed: generated + statusFlips + rows.length, notified, skippedIdempotent, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runComplianceCalendarJob',
    label: 'Compliance calendar: generate, due/overdue, 30/7/1 ladder (CMP-CAL)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runComplianceCalendarJob,
  },
];
