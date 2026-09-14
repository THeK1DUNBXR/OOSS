/**
 * Technology — vendors and contracts jobs (docs/plan/cio.md, workstream C).
 *
 * Three idempotent detectors, each a ladder keyed the way the compliance
 * calendar and CRM expiry ladders are:
 *
 *  - the notice-period ladder on `ItVendorContract` (30/7/0 days to
 *    `endDate - noticeDays`), flipping `active/approved -> expiring ->
 *    expired` as the dates pass (IT-VCT-002);
 *  - the assessment-overdue ladder on `ItVendor` (IT_VEN_ASSESSMENT_OVERDUE,
 *    IT-VEN-001);
 *  - a single-shot detector for a high/critical vendor with no DPA signed.
 *
 * All three run once a day per tenant. `raiseException` itself de-dupes an
 * already-open exception of the same code on the same subject, and the
 * `noticeNotifiedRungs`/`assessmentNotifiedRungs` arrays on the rows record
 * every rung already crossed, so a second run in the same day produces
 * nothing new.
 */
import { EVENTS, VENDOR_LADDER_RUNGS, noticeDate, noticeRung, type SeverityCode } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { raiseException } from '../../platform/exceptions.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

function severityForRung(rung: number): SeverityCode {
  if (rung <= 0) return 'S4_CRITICAL';
  if (rung <= 7) return 'S3_HIGH_RISK';
  return 'S2_WARNING';
}

// ---------------------------------------------------------------------------
// Notice-period ladder + expiring/expired status flips
// ---------------------------------------------------------------------------

export async function runVendorContractNoticeLadder(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  let notified = 0;
  let statusFlips = 0;

  const rows = await prisma.itVendorContract.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['approved', 'active', 'expiring'] }, endDate: { not: null } },
    include: { vendor: { select: { name: true } } },
  });

  const now = new Date();

  for (const row of rows) {
    const endDate = row.endDate as Date;

    // Past the end date entirely: expired, unconditionally, whatever the
    // notice ladder had or had not fired.
    if (endDate < now) {
      if (row.status !== 'expired') {
        await prisma.itVendorContract.update({ where: { id: row.id }, data: { status: 'expired' } });
        statusFlips += 1;
        await emit({
          name: EVENTS.IT_VENDOR_CONTRACT_TRANSITIONED,
          subject: { entityType: 'it_vendor_contract', entityId: row.id, recordCode: row.recordCode },
          previousState: { status: row.status },
          newState: { status: 'expired' },
          impact: { domains: ['it'], severity: 'S3_HIGH_RISK' },
        });
      }
      continue;
    }

    const nd = noticeDate(endDate, row.noticeDays);
    const daysToNotice = Math.ceil((nd.getTime() - now.getTime()) / 86_400_000);
    const rung = noticeRung(daysToNotice);
    if (rung === null) continue;

    const already = row.noticeNotifiedRungs ?? [];
    const crossed = VENDOR_LADDER_RUNGS.filter((r) => daysToNotice <= r);

    if (row.status !== 'expiring') {
      const previousStatus = row.status;
      await prisma.itVendorContract.update({ where: { id: row.id }, data: { status: 'expiring' } });
      statusFlips += 1;
      await emit({
        name: EVENTS.IT_VENDOR_CONTRACT_EXPIRING,
        subject: { entityType: 'it_vendor_contract', entityId: row.id, recordCode: row.recordCode },
        previousState: { status: previousStatus },
        newState: { status: 'expiring', daysToNotice, rung },
        impact: { domains: ['it'], severity: severityForRung(rung) },
      });
    }

    if (already.includes(rung)) continue;

    const overdue = daysToNotice < 0;
    const renewalWording = row.autoRenew
      ? `This contract will renew unless notice is given by ${nd.toISOString().slice(0, 10)}.`
      : `This contract will lapse at ${endDate.toISOString().slice(0, 10)} unless renewed — no auto-renewal is set.`;

    try {
      await raiseException({
        code: 'IT_VCT_NOTICE',
        label: overdue
          ? `${row.vendor.name} — notice date passed`
          : `${row.vendor.name} — notice due in ${rung} day${rung === 1 ? '' : 's'}`,
        severity: severityForRung(rung),
        subjectType: 'it_vendor_contract',
        subjectId: row.id,
        subjectLabel: row.recordCode,
        domain: 'it',
        detail: `${row.recordCode} — ${row.title}. ${renewalWording}`,
        ownerPartyId: row.ownerPartyId,
        slaDueAt: nd,
        triggerFingerprint: 'it_vendor_contract_notice_ladder',
        ladderRung: rung,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    await prisma.itVendorContract.update({
      where: { id: row.id },
      data: { noticeNotifiedRungs: [...new Set([...already, ...crossed])] },
    });
  }

  return { processed: rows.length, notified, skippedIdempotent: rows.length - notified - statusFlips, errors };
}

// ---------------------------------------------------------------------------
// Assessment-overdue ladder
// ---------------------------------------------------------------------------

export async function runVendorAssessmentOverdueJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  let notified = 0;

  const vendors = await prisma.itVendor.findMany({
    where: { tenantId: auth.tenantId, status: { not: 'offboarded' }, assessmentDueAt: { not: null } },
  });

  const now = new Date();

  for (const v of vendors) {
    const daysToDue = Math.ceil(((v.assessmentDueAt as Date).getTime() - now.getTime()) / 86_400_000);
    const rung = noticeRung(daysToDue);
    if (rung === null) continue;

    const already = v.assessmentNotifiedRungs ?? [];
    const crossed = VENDOR_LADDER_RUNGS.filter((r) => daysToDue <= r);
    if (already.includes(rung)) continue;

    const overdue = daysToDue < 0;

    try {
      await raiseException({
        code: 'IT_VEN_ASSESSMENT_OVERDUE',
        label: overdue ? `${v.name} — security assessment overdue` : `${v.name} — assessment due in ${rung} day${rung === 1 ? '' : 's'}`,
        severity: overdue ? 'S3_HIGH_RISK' : severityForRung(rung),
        subjectType: 'it_vendor',
        subjectId: v.id,
        subjectLabel: v.recordCode,
        domain: 'it',
        detail: overdue
          ? `${v.recordCode} — ${v.name}'s security assessment was due ${(v.assessmentDueAt as Date).toISOString().slice(0, 10)} and has not been re-run.`
          : `${v.recordCode} — ${v.name}'s security assessment is due ${(v.assessmentDueAt as Date).toISOString().slice(0, 10)}, in ${rung} day${rung === 1 ? '' : 's'}.`,
        triggerFingerprint: 'it_vendor_assessment_ladder',
        ladderRung: rung,
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    if (overdue && v.assessmentStatus !== 'expired') {
      await prisma.itVendor.update({ where: { id: v.id }, data: { assessmentStatus: 'expired' } });
    }
    await prisma.itVendor.update({
      where: { id: v.id },
      data: { assessmentNotifiedRungs: [...new Set([...already, ...crossed])] },
    });
  }

  return { processed: vendors.length, notified, skippedIdempotent: vendors.length - notified, errors };
}

// ---------------------------------------------------------------------------
// High/critical vendor without a DPA
// ---------------------------------------------------------------------------

export async function runVendorDpaMissingJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  let notified = 0;

  const vendors = await prisma.itVendor.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'active',
      dpaSigned: false,
      riskRating: { in: ['high', 'critical'] },
    },
  });

  for (const v of vendors) {
    try {
      await raiseException({
        code: 'IT_VEN_DPA_MISSING',
        label: `${v.name} — no DPA on file`,
        severity: v.riskRating === 'critical' ? 'S3_HIGH_RISK' : 'S2_WARNING',
        subjectType: 'it_vendor',
        subjectId: v.id,
        subjectLabel: v.recordCode,
        domain: 'it',
        detail: `${v.recordCode} — ${v.name} is rated ${v.riskRating} risk and carries no signed Data Processing Agreement.`,
        triggerFingerprint: 'it_vendor_dpa_missing',
      });
      notified += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: vendors.length, notified, skippedIdempotent: 0, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runVendorContractNoticeLadder',
    label: 'Vendor contracts: notice-period ladder, expiring/expired flips (IT-VCT)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runVendorContractNoticeLadder,
  },
  {
    name: 'runVendorAssessmentOverdueJob',
    label: 'Vendors: security-assessment overdue ladder (IT_VEN_ASSESSMENT_OVERDUE)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runVendorAssessmentOverdueJob,
  },
  {
    name: 'runVendorDpaMissingJob',
    label: 'Vendors: high/critical risk with no DPA on file (IT_VEN_DPA_MISSING)',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: runVendorDpaMissingJob,
  },
];
