import type { JobDefinition, JobResult } from '../scheduler.js';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Monthly gratuity accrual, on the 1st. One row per active employee
 * (`engagementType: 'employee'`) spreading the eventual 15/26-of-basic-per-
 * year liability across twelve months, from whatever salary structure or
 * compensation record is in force. Idempotent against a re-run in the same
 * month via the (tenant, employment, asOfDate) unique key.
 */
export async function runGratuityAccrual(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const asOfDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, engagementType: 'employee', status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
  });

  let processed = 0;
  const errors: string[] = [];

  for (const employment of employments) {
    try {
      const structure = await prisma.salaryStructure.findFirst({
        where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, status: 'Approved', effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
      });
      const basicMonthly = structure
        ? num(structure.basic)!
        : num(
            (await prisma.compensationRecord.findFirst({
              where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, status: 'Effective' },
              orderBy: { effectiveFrom: 'desc' },
            }))?.basicPay,
          ) ?? 0;
      if (basicMonthly <= 0) continue;

      const monthlyAccrual = round2(((15 / 26) * basicMonthly) / 12);

      const existing = await prisma.gratuityAccrual.findFirst({ where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, asOfDate } });
      if (existing) continue; // idempotent: already accrued this month

      await prisma.gratuityAccrual.create({
        data: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, asOfDate, accrued: monthlyAccrual },
      });
      processed += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed, notified: 0, skippedIdempotent: employments.length - processed - errors.length, errors };
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runGratuityAccrualJob',
    label: 'Gratuity accrual (monthly, 1st)',
    automationClass: 'scheduled_computation',
    cron: '0 3 1 * *',
    run: runGratuityAccrual,
  },
];
