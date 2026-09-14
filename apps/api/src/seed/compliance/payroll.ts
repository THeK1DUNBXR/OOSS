import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';

const EFFECTIVE_FROM = new Date('2024-04-01T00:00:00.000Z');

/** Compliance — payroll. Rate tables and other structure the tenant needs before use. Safe to re-run. */
export async function seedPayroll(): Promise<void> {
  const tenantId = currentAuth().tenantId;

  const pf = await prisma.pfRateTable.findFirst({ where: { tenantId } });
  if (!pf) {
    await prisma.pfRateTable.create({
      data: {
        tenantId,
        effectiveFrom: EFFECTIVE_FROM,
        employeeRate: 0.12,
        employerRate: 0.12,
        epsRate: 0.0833,
        edliRate: 0.005,
        adminRate: 0.005,
        wageCeiling: 15_000,
      },
    });
  }

  const esi = await prisma.esiRateTable.findFirst({ where: { tenantId } });
  if (!esi) {
    await prisma.esiRateTable.create({
      data: { tenantId, effectiveFrom: EFFECTIVE_FROM, employeeRate: 0.0075, employerRate: 0.0325, wageCeiling: 21_000 },
    });
  }

  const pt = await prisma.professionalTaxSlabTable.findFirst({ where: { tenantId, state: 'TN' } });
  if (!pt) {
    // Tamil Nadu Professional Tax — half-yearly slabs as currently known.
    // Confirm against the corporation's own schedule before relying on this
    // for a filing; rates and bands have moved by notification before.
    await prisma.professionalTaxSlabTable.create({
      data: {
        tenantId,
        state: 'TN',
        effectiveFrom: EFFECTIVE_FROM,
        slabs: [
          { minGross: 0, maxGross: 21_000, halfYearlyAmount: 0 },
          { minGross: 21_001, maxGross: 30_000, halfYearlyAmount: 135 },
          { minGross: 30_001, maxGross: 45_000, halfYearlyAmount: 315 },
          { minGross: 45_001, maxGross: 60_000, halfYearlyAmount: 690 },
          { minGross: 60_001, maxGross: 75_000, halfYearlyAmount: 1025 },
          { minGross: 75_001, maxGross: null, halfYearlyAmount: 1250 },
        ],
        confirmNote: 'Confirm against the Greater Chennai Corporation (or the applicable local body) professional tax schedule currently in force.',
      },
    });
  }

  const lwf = await prisma.lwfRateTable.findFirst({ where: { tenantId, state: 'TN' } });
  if (!lwf) {
    await prisma.lwfRateTable.create({
      data: {
        tenantId,
        state: 'TN',
        effectiveFrom: EFFECTIVE_FROM,
        employeeAmount: 20,
        employerAmount: 40,
        dueMonth: 12,
        confirmNote: 'Confirm the current Tamil Nadu Labour Welfare Fund Act contribution against the latest notification.',
      },
    });
  }

  const mw = await prisma.minimumWageTable.findFirst({ where: { tenantId, state: 'Tamil Nadu', category: 'general' } });
  if (!mw) {
    await prisma.minimumWageTable.create({
      data: { tenantId, state: 'Tamil Nadu', category: 'general', monthlyAmount: 12_000, effectiveFrom: EFFECTIVE_FROM },
    });
  }
}
