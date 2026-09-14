/**
 * Compliance — tax. Seeds the dated rate tables workstream C's arithmetic
 * reads from: TDS section rates, both regimes' income-tax slabs, and the
 * corporate advance-tax rate.
 *
 * Every figure here is this platform's best-known rate at the time it was
 * written. Confirm each one against the Finance Act in force before relying
 * on it for a live filing — a dated table makes a rate change a new row, not
 * a code change, but it still has to be told what the new rate is.
 */
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { fyOf } from '../../domains/compliance/tax.js';

const RATE_EFFECTIVE_FROM = new Date(Date.UTC(2020, 3, 1));

const SECTION_RATES: Array<{
  section: string;
  label: string;
  ratePercent: number;
  thresholdPerTransaction: number;
  thresholdPerFy: number;
  panMissingRatePercent?: number;
}> = [
  { section: '194C_IND', label: '194C — contractor, individual/HUF', ratePercent: 1, thresholdPerTransaction: 30_000, thresholdPerFy: 100_000 },
  { section: '194C_COMP', label: '194C — contractor, other than individual/HUF', ratePercent: 2, thresholdPerTransaction: 30_000, thresholdPerFy: 100_000 },
  { section: '194J_PROF', label: '194J — professional fees', ratePercent: 10, thresholdPerTransaction: 30_000, thresholdPerFy: 30_000 },
  { section: '194J_TECH', label: '194J — technical services/royalty', ratePercent: 2, thresholdPerTransaction: 30_000, thresholdPerFy: 30_000 },
  { section: '194H', label: '194H — commission or brokerage', ratePercent: 5, thresholdPerTransaction: 15_000, thresholdPerFy: 15_000 },
  { section: '194I_LAND', label: '194I — rent of land, building, furniture', ratePercent: 10, thresholdPerTransaction: 240_000, thresholdPerFy: 240_000 },
  { section: '194I_PLANT', label: '194I — rent of plant or machinery', ratePercent: 2, thresholdPerTransaction: 240_000, thresholdPerFy: 240_000 },
  { section: '194Q', label: '194Q — purchase of goods', ratePercent: 0.1, thresholdPerTransaction: 0, thresholdPerFy: 5_000_000, panMissingRatePercent: 5 },
  { section: '192', label: '192 — salary (computed from the slab table, not this rate)', ratePercent: 0, thresholdPerTransaction: 0, thresholdPerFy: 0 },
];

const NEW_REGIME_SLABS = [
  { upTo: 400_000, ratePercent: 0 },
  { upTo: 800_000, ratePercent: 5 },
  { upTo: 1_200_000, ratePercent: 10 },
  { upTo: 1_600_000, ratePercent: 15 },
  { upTo: 2_000_000, ratePercent: 20 },
  { upTo: 2_400_000, ratePercent: 25 },
  { upTo: null, ratePercent: 30 },
];

const OLD_REGIME_SLABS = [
  { upTo: 250_000, ratePercent: 0 },
  { upTo: 500_000, ratePercent: 5 },
  { upTo: 1_000_000, ratePercent: 20 },
  { upTo: null, ratePercent: 30 },
];

export async function seedTax(): Promise<void> {
  const auth = currentAuth();
  const tenantId = auth.tenantId;

  for (const row of SECTION_RATES) {
    await prisma.tdsSectionRate.upsert({
      where: { tenantId_section_effectiveFrom: { tenantId, section: row.section, effectiveFrom: RATE_EFFECTIVE_FROM } },
      create: {
        tenantId,
        section: row.section,
        label: row.label,
        ratePercent: row.ratePercent,
        thresholdPerTransaction: row.thresholdPerTransaction,
        thresholdPerFy: row.thresholdPerFy,
        panMissingRatePercent: row.panMissingRatePercent ?? 20,
        effectiveFrom: RATE_EFFECTIVE_FROM,
        note: 'Confirm against the Finance Act in force before relying on this for a live filing.',
      },
      update: {},
    });
  }

  // Both current and next FY, so a test or a screen that reads a few weeks
  // ahead of a FY boundary is never left without a table.
  const now = new Date();
  const fys = [fyOf(now), fyOf(new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1)))];

  for (const fy of fys) {
    const startYear = Number(fy.split('-')[0]);
    const effectiveFrom = new Date(Date.UTC(startYear, 3, 1));

    await prisma.incomeTaxSlabTable.upsert({
      where: { tenantId_fy_regime: { tenantId, fy, regime: 'new' } },
      create: {
        tenantId,
        fy,
        regime: 'new',
        slabs: NEW_REGIME_SLABS,
        standardDeduction: 75_000,
        rebate87ALimit: 1_200_000,
        rebate87AMaxAmount: 60_000,
        cessPercent: 4,
        effectiveFrom,
      },
      update: {},
    });

    await prisma.incomeTaxSlabTable.upsert({
      where: { tenantId_fy_regime: { tenantId, fy, regime: 'old' } },
      create: {
        tenantId,
        fy,
        regime: 'old',
        slabs: OLD_REGIME_SLABS,
        standardDeduction: 50_000,
        rebate87ALimit: 500_000,
        rebate87AMaxAmount: 12_500,
        cessPercent: 4,
        effectiveFrom,
      },
      update: {},
    });
  }

  await prisma.corporateTaxRate.upsert({
    where: { tenantId_regime_effectiveFrom: { tenantId, regime: '115BAA', effectiveFrom: RATE_EFFECTIVE_FROM } },
    create: {
      tenantId,
      regime: '115BAA',
      effectiveRatePercent: 25.17,
      effectiveFrom: RATE_EFFECTIVE_FROM,
      note: '22% base + 10% surcharge + 4% cess under Sec 115BAA. Confirm against the Finance Act in force.',
    },
    update: {},
  });
}
