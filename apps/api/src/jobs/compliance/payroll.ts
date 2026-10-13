import type { JobDefinition, JobResult } from '../scheduler.js';
import { istYearMonth, mulRatio } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ruleAt, ruleIntegerField } from '../../domains/statutory.js';

const GRATUITY_KEY = 'gratuity.factor';

/**
 * The Act's factor, as an APPROVED rule in force on `at`: days' wages a completed year
 * (15) over a month taken as 26 days (Payment of Gratuity Act 1972, s.4(2)). A rule, not
 * a constant, so an approved change moves accruals from its effective date. A missing or
 * unapproved row refuses the employee's accrual (see the catch below).
 */
async function gratuityFactor(at: Date): Promise<{ daysPerYear: bigint; daysPerMonth: bigint }> {
  const row = await ruleAt('gratuity', GRATUITY_KEY, 'IN', at);
  const daysPerMonth = ruleIntegerField(row.value, 'daysPerMonth', GRATUITY_KEY);
  if (daysPerMonth === 0n) {
    throw new RangeError(`Statutory rule ${GRATUITY_KEY} has a zero daysPerMonth.`);
  }
  return { daysPerYear: ruleIntegerField(row.value, 'daysPerYear', GRATUITY_KEY), daysPerMonth };
}

/**
 * Monthly gratuity accrual, on the 1st. One row per active employee
 * (`engagementType: 'employee'`) spreading the eventual liability, the approved factor
 * (daysPerYear over daysPerMonth) of basic per year, across twelve months, from whatever
 * salary structure or compensation record is in force. Idempotent against a re-run in the same month via the
 * (tenant, employment, asOfDate) unique key.
 *
 * Exact in paise: basic is a bigint, and the accrual is mulRatio over the factor. The old
 * code multiplied 15/26 in floating point, which lands a hair under a half paisa and rounds
 * down when the exact figure is a tie (basic 20,007 rupees: exact 961.875, old 961.87).
 */
export async function runGratuityAccrual(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const { year, month } = istYearMonth(now);
  const asOfDate = new Date(Date.UTC(year, month - 1, 1));

  const employments = await prisma.employmentRelationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      engagementType: 'employee',
      status: { in: ['Active', 'OnLeave', 'NoticePeriod'] },
    },
  });

  let processed = 0;
  const errors: string[] = [];

  for (const employment of employments) {
    try {
      const structure = await prisma.salaryStructure.findFirst({
        where: {
          tenantId: auth.tenantId,
          employmentRelationshipId: employment.id,
          status: 'Approved',
          effectiveFrom: { lte: now },
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      // The compensation record is read only when no structure is in force. Its basicPay is
      // paise, so it is taken as it is stored; there is no rupee figure to round.
      const compensation = structure
        ? null
        : await prisma.compensationRecord.findFirst({
            where: {
              tenantId: auth.tenantId,
              employmentRelationshipId: employment.id,
              status: 'Effective',
              voidedAt: null,
            },
            orderBy: { effectiveFrom: 'desc' },
          });
      const basicMinor = structure ? structure.basicMinor : (compensation?.basicPayMinor ?? 0n);
      if (basicMinor <= 0n) continue;

      const existing = await prisma.gratuityAccrual.findFirst({
        where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, asOfDate },
      });
      if (existing) continue; // idempotent: already accrued this month

      // Read after the idempotency check, so a month already accrued is never refused for want
      // of a rule it no longer needs. A refusal here lands in `errors` for this employee only.
      const factor = await gratuityFactor(now);
      const monthlyAccrualMinor = mulRatio(basicMinor, factor.daysPerYear, factor.daysPerMonth * 12n);

      await prisma.gratuityAccrual.create({
        data: {
          tenantId: auth.tenantId,
          employmentRelationshipId: employment.id,
          asOfDate,
          accruedMinor: monthlyAccrualMinor,
        },
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
    sideEffects: 'internal',
    idempotent: false,
    label: 'Gratuity accrual (monthly, 1st)',
    automationClass: 'scheduled_computation',
    cron: '0 3 1 * *',
    run: runGratuityAccrual,
  },
];
