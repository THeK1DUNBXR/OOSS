/**
 * Characterisation of the statutory rate and slab money columns (ORDERED-PLAN 1.6,
 * the last money columns). Each figure is pinned twice: the rupee value a domain
 * function returns, which must not move by a paisa, and the `<name>Minor` paise string
 * the wire now carries beside it. A rate is a statutory parameter, so the figures here
 * are chosen to be non-round (a paisa on each side) to catch a conversion that rounds
 * to the rupee or truncates.
 *
 * Self-contained: every row is written with an effective date in 2090, so the "latest
 * row on or before the date" readers pick this test's row and no seeded or other test's
 * row. The rows are removed in afterAll. The GST row is the exception: gstExposure reads
 * at today, so its row is dated five minutes ago, and it too is removed in afterAll.
 *
 * Against the BigInt columns these pass. Against the Decimal columns they fail at the
 * `*Minor` assertions (the sibling does not exist) and at the Prisma write of the
 * `*Minor` field (an unknown argument).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import {
  createEsiRateTable,
  createLwfRateTable,
  createMinimumWageTable,
  createPfRateTable,
  currentEsiRateTable,
  currentLwfRateTable,
  currentPfRateTable,
  listMinimumWageTables,
} from '../domains/compliance/payroll.js';
import { slabTableFor, tdsSectionRates } from '../domains/compliance/tax.js';
import { gstExposure } from '../domains/compliance/gst.js';
import { listStampDutyRules } from '../domains/compliance/corporate/contracts.js';

const FINANCE = 'finance@kaizen.co.in';
// Milliseconds past 2090-01-01, so each run's effective date is distinct from every other.
const SLOT = Math.floor(Math.random() * 1_000_000);
const AT = new Date(Date.UTC(2090, 0, 1) + SLOT);
const TEST_STATE = 'XX';
const TEST_FY = `CHR-${SLOT}`;
const TEST_SECTION = '194Q';
const TEST_AGREEMENT = `characterisation-${SLOT}`;
const GST_EFFECTIVE = new Date(Date.now() - 5 * 60_000);

let TID: string;
let gstRowId: string;
const createdIds = {
  minimumWage: '',
  tds: '',
  stampWithFlat: '',
  stampNoFlat: '',
};

beforeAll(async () => {
  TID = await tenantId();
});

afterAll(async () => {
  await unscopedPrisma.pfRateTable.deleteMany({ where: { tenantId: TID, effectiveFrom: AT } });
  await unscopedPrisma.esiRateTable.deleteMany({ where: { tenantId: TID, effectiveFrom: AT } });
  await unscopedPrisma.lwfRateTable.deleteMany({ where: { tenantId: TID, state: TEST_STATE, effectiveFrom: AT } });
  await unscopedPrisma.minimumWageTable.deleteMany({ where: { tenantId: TID, state: TEST_STATE, effectiveFrom: AT } });
  await unscopedPrisma.tdsSectionRate.deleteMany({
    where: { tenantId: TID, section: TEST_SECTION, effectiveFrom: AT },
  });
  await unscopedPrisma.incomeTaxSlabTable.deleteMany({ where: { tenantId: TID, fy: TEST_FY } });
  await unscopedPrisma.stampDutyRule.deleteMany({ where: { tenantId: TID, agreementKind: TEST_AGREEMENT } });
  await unscopedPrisma.gstRateTable.deleteMany({ where: { tenantId: TID, id: gstRowId } });
});

describe('PF and ESI wage ceilings (cmp_pay_pf_rate_tables, cmp_pay_esi_rate_tables)', () => {
  it('PF: the ceiling reads back in rupees and is stored as paise', async () => {
    const created = await asUser(FINANCE, () =>
      createPfRateTable({
        effectiveFrom: AT,
        employeeRate: 0.12,
        employerRate: 0.12,
        epsRate: 0.0833,
        edliRate: 0.005,
        adminRate: 0.005,
        wageCeiling: 15000.5,
      }),
    );
    expect(created.wageCeiling!.toFixed(2)).toBe('15000.50');
    expect(created.wageCeilingMinor).toBe('1500050');

    const rates = await asUser(FINANCE, () => currentPfRateTable(AT));
    expect(rates.wageCeiling).toBe(15000.5);

    const stored = await unscopedPrisma.pfRateTable.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.wageCeilingMinor).toBe(1500050n);
  });

  it('ESI: the ceiling reads back in rupees and is stored as paise', async () => {
    const created = await asUser(FINANCE, () =>
      createEsiRateTable({
        effectiveFrom: AT,
        employeeRate: 0.0075,
        employerRate: 0.0325,
        wageCeiling: 21000.25,
      }),
    );
    expect(created.wageCeiling!.toFixed(2)).toBe('21000.25');
    expect(created.wageCeilingMinor).toBe('2100025');

    const rates = await asUser(FINANCE, () => currentEsiRateTable(AT));
    expect(rates.wageCeiling).toBe(21000.25);
  });
});

describe('LWF contribution amounts (cmp_pay_lwf_rate_tables)', () => {
  it('reads both amounts in rupees and writes them as paise', async () => {
    const created = await asUser(FINANCE, () =>
      createLwfRateTable({
        state: TEST_STATE,
        effectiveFrom: AT,
        employeeAmount: 20.5,
        employerAmount: 40.75,
        dueMonth: 12,
      }),
    );
    expect(created.employeeAmount!.toFixed(2)).toBe('20.50');
    expect(created.employeeAmountMinor).toBe('2050');
    expect(created.employerAmount!.toFixed(2)).toBe('40.75');
    expect(created.employerAmountMinor).toBe('4075');

    const rates = await asUser(FINANCE, () => currentLwfRateTable(AT, TEST_STATE));
    expect(rates).toEqual({ employeeAmount: 20.5, employerAmount: 40.75, dueMonth: 12 });
  });
});

describe('minimum wage floor (cmp_pay_minimum_wage_tables)', () => {
  it('lists the monthly floor with its paise sibling', async () => {
    const created = await asUser(FINANCE, () =>
      createMinimumWageTable({
        state: TEST_STATE,
        category: 'characterisation',
        monthlyAmount: 12345.67,
        effectiveFrom: AT,
      }),
    );
    createdIds.minimumWage = created.id;
    expect(created.monthlyAmount!.toFixed(2)).toBe('12345.67');
    expect(created.monthlyAmountMinor).toBe('1234567');

    const rows = await asUser(FINANCE, () => listMinimumWageTables());
    const row = rows.find((r) => r.id === createdIds.minimumWage);
    expect(row).toBeDefined();
    expect(row!.monthlyAmount!.toFixed(2)).toBe('12345.67');
    expect(row!.monthlyAmountMinor).toBe('1234567');
  });
});

describe('TDS thresholds (tds_section_rates)', () => {
  it('lists both thresholds in rupees with their paise siblings', async () => {
    const created = await unscopedPrisma.tdsSectionRate.create({
      data: {
        tenantId: TID,
        section: TEST_SECTION,
        label: 'characterisation row',
        ratePercent: 0.1,
        thresholdPerTransactionMinor: 3000050n,
        thresholdPerFyMinor: 10000000n,
        effectiveFrom: AT,
      },
    });
    createdIds.tds = created.id;

    const rows = await asUser(FINANCE, () => tdsSectionRates());
    const row = rows.find((r) => r.id === createdIds.tds);
    expect(row).toBeDefined();
    expect(row!.thresholdPerTransaction!.toFixed(2)).toBe('30000.50');
    expect(row!.thresholdPerTransactionMinor).toBe('3000050');
    expect(row!.thresholdPerFy!.toFixed(2)).toBe('100000.00');
    expect(row!.thresholdPerFyMinor).toBe('10000000');
  });
});

describe('income-tax slab deductions (income_tax_slab_tables)', () => {
  it('reads the standard deduction and rebate limits in rupees from their paise columns', async () => {
    await unscopedPrisma.incomeTaxSlabTable.create({
      data: {
        tenantId: TID,
        fy: TEST_FY,
        regime: 'new',
        slabs: [],
        standardDeductionMinor: 7500050n,
        rebate87ALimitMinor: 120000000n,
        rebate87AMaxAmountMinor: 6000025n,
        cessPercent: 4,
        effectiveFrom: AT,
      },
    });

    const slabs = await asUser(FINANCE, () => slabTableFor(TEST_FY, 'new'));
    expect(slabs.standardDeduction).toBe(75000.5);
    expect(slabs.rebate87ALimit).toBe(1200000);
    expect(slabs.rebate87AMaxAmount).toBe(60000.25);

    const stored = await unscopedPrisma.incomeTaxSlabTable.findFirstOrThrow({ where: { tenantId: TID, fy: TEST_FY } });
    expect(stored.standardDeductionMinor.toString()).toBe('7500050');
    expect(stored.rebate87ALimitMinor.toString()).toBe('120000000');
    expect(stored.rebate87AMaxAmountMinor.toString()).toBe('6000025');
  });
});

describe('stamp duty flat amount (compliance_stamp_duty_rules)', () => {
  it('lists a flat amount in rupees with its paise sibling, and a rule with no flat amount as null, not zero', async () => {
    const withFlat = await unscopedPrisma.stampDutyRule.create({
      data: { tenantId: TID, agreementKind: TEST_AGREEMENT, effectiveFrom: AT, flatAmountMinor: 123456n },
    });
    const withoutFlat = await unscopedPrisma.stampDutyRule.create({
      data: {
        tenantId: TID,
        agreementKind: `${TEST_AGREEMENT}-percent`,
        effectiveFrom: AT,
        percentOfValue: 0.1,
        flatAmountMinor: null,
      },
    });
    createdIds.stampWithFlat = withFlat.id;
    createdIds.stampNoFlat = withoutFlat.id;

    const rules = await asUser(FINANCE, () => listStampDutyRules());
    const flat = rules.find((r) => r.id === createdIds.stampWithFlat);
    const percent = rules.find((r) => r.id === createdIds.stampNoFlat);
    expect(flat).toBeDefined();
    expect(flat!.flatAmount!.toFixed(2)).toBe('1234.56');
    expect(flat!.flatAmountMinor).toBe('123456');
    expect(percent).toBeDefined();
    expect(percent!.flatAmount).toBeNull();
    expect(percent!.flatAmountMinor).toBeNull();
  });
});

describe('GST late fee rates and cap (gst_rate_tables)', () => {
  it('reads the per-day fees and the cap in rupees, and returns each with its paise sibling', async () => {
    const created = await unscopedPrisma.gstRateTable.create({
      data: {
        tenantId: TID,
        effectiveFrom: GST_EFFECTIVE,
        lateFeePerDayCgstMinor: 2550n,
        lateFeePerDaySgstMinor: 2525n,
        capMinor: 500075n,
        interestPct: 18,
      },
    });
    gstRowId = created.id;

    const exposure = await asUser(FINANCE, () => gstExposure('2026-08'));
    expect(exposure.rateTable).not.toBeNull();
    const rate = exposure.rateTable!;
    expect(rate.lateFeePerDayCgst!.toFixed(2)).toBe('25.50');
    expect(rate.lateFeePerDayCgstMinor).toBe('2550');
    expect(rate.lateFeePerDaySgst!.toFixed(2)).toBe('25.25');
    expect(rate.lateFeePerDaySgstMinor).toBe('2525');
    expect(rate.cap!.toFixed(2)).toBe('5000.75');
    expect(rate.capMinor).toBe('500075');
  });
});
