/**
 * Compliance — income tax and TDS (docs/plan/compliance.md, workstream C).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { computeTds, computeAnnualTax, type SlabTable } from '@kaizen/shared';
import { asUser, expectReject, unscopedPrisma, tenantId } from '../helpers.js';
import { recordVendorBill, payVendorBill, createCategory } from '../../domains/books.js';
import '../../domains/compliance/tax.js'; // registers the before-pay hook and governed entities
import {
  computeVendorTds,
  waiveVendorTds,
  setApplicabilityRule,
  setMsmeTerms,
  runMsmeLadder,
  msmeExposure,
  createChallan,
  markChallanPaid,
  runTdsDepositDueJob,
  prepareTdsReturn,
  fileTdsReturn,
  fyOf,
} from '../../domains/compliance/tax.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

const FINANCE = 'finance@kaizen.co.in';
const FINANCE_2 = 'latha@kaizen.co.in'; // same finance_head role, different party — for proposer/approver tests

// ---------------------------------------------------------------------------
// Pure arithmetic — no database
// ---------------------------------------------------------------------------

describe('computeTds — pure arithmetic', () => {
  const thresholds = { perTransaction: 30_000, perFy: 100_000 };

  it('is not applicable below both thresholds', () => {
    const result = computeTds({
      amount: 10_000,
      cumulativeFy: 0,
      section: '194C_IND',
      ratePercent: 1,
      thresholds,
      panPresent: true,
      panMissingRatePercent: 20,
    });
    expect(result.applicable).toBe(false);
    expect(result.tdsAmount).toBe(0);
  });

  it('is applicable once the single payment crosses the per-transaction threshold', () => {
    const result = computeTds({
      amount: 40_000,
      cumulativeFy: 0,
      section: '194C_IND',
      ratePercent: 1,
      thresholds,
      panPresent: true,
      panMissingRatePercent: 20,
    });
    expect(result.applicable).toBe(true);
    expect(result.tdsAmount).toBe(400);
  });

  it('is applicable once cumulative FY payments cross the per-FY threshold, even under the per-transaction line', () => {
    const result = computeTds({
      amount: 20_000,
      cumulativeFy: 85_000,
      section: '194C_IND',
      ratePercent: 1,
      thresholds,
      panPresent: true,
      panMissingRatePercent: 20,
    });
    expect(result.applicable).toBe(true);
    expect(result.tdsAmount).toBe(200);
  });

  it('applies the Sec 206AA 20% flat rate when no PAN is on file', () => {
    const result = computeTds({
      amount: 40_000,
      cumulativeFy: 0,
      section: '194C_IND',
      ratePercent: 1,
      thresholds,
      panPresent: false,
      panMissingRatePercent: 20,
    });
    expect(result.ratePercentApplied).toBe(20);
    expect(result.tdsAmount).toBe(8_000);
  });

  it('a Sec 197 certificate rate overrides the table, including a nil rate', () => {
    const nil = computeTds({
      amount: 40_000,
      cumulativeFy: 0,
      section: '194J_PROF',
      ratePercent: 10,
      thresholds,
      panPresent: true,
      panMissingRatePercent: 20,
      certificateRate: 0,
    });
    expect(nil.applicable).toBe(false);
    expect(nil.tdsAmount).toBe(0);

    const lower = computeTds({
      amount: 40_000,
      cumulativeFy: 0,
      section: '194J_PROF',
      ratePercent: 10,
      thresholds,
      panPresent: true,
      panMissingRatePercent: 20,
      certificateRate: 3,
    });
    expect(lower.tdsAmount).toBe(1_200);
  });
});

describe('computeAnnualTax — regime comparison', () => {
  const newRegime: SlabTable = {
    regime: 'new',
    slabs: [
      { upTo: 400_000, ratePercent: 0 },
      { upTo: 800_000, ratePercent: 5 },
      { upTo: 1_200_000, ratePercent: 10 },
      { upTo: null, ratePercent: 20 },
    ],
    standardDeduction: 75_000,
    rebate87ALimit: 1_200_000,
    rebate87AMaxAmount: 60_000,
    cessPercent: 4,
  };
  const oldRegime: SlabTable = {
    regime: 'old',
    slabs: [
      { upTo: 250_000, ratePercent: 0 },
      { upTo: 500_000, ratePercent: 5 },
      { upTo: 1_000_000, ratePercent: 20 },
      { upTo: null, ratePercent: 30 },
    ],
    standardDeduction: 50_000,
    rebate87ALimit: 500_000,
    rebate87AMaxAmount: 12_500,
    cessPercent: 4,
  };

  it('rebates income at or below the 87A limit to zero tax under either regime', () => {
    expect(computeAnnualTax('new', 1_000_000, newRegime)).toBe(0);
    expect(computeAnnualTax('old', 400_000, oldRegime)).toBe(0);
  });

  it('the two regimes tax the same gross income differently — neither is always cheaper', () => {
    const gross = 1_800_000;
    const newTax = computeAnnualTax('new', gross, newRegime);
    const oldTax = computeAnnualTax('old', gross, oldRegime);
    expect(newTax).not.toBe(oldTax);
    expect(newTax).toBeGreaterThan(0);
    expect(oldTax).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CMP-TDS-001 — vendor TDS blocks payment until settled
// ---------------------------------------------------------------------------

describe('CMP-TDS-001 — a bill under an applicable TDS category cannot be paid until TDS is settled', () => {
  it('refuses payment when the category defaults to a section nobody considered, and allows it once computed', async () => {
    const account = await bankAccount();
    const category = await asUser(FINANCE, () => createCategory({ name: `Contractor fees ${Date.now()}`, kind: 'expense' }));
    await asUser(FINANCE, () => setApplicabilityRule({ categoryId: category.id, section: '194C_IND' }));

    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: `Acme Contracting ${Date.now()}`,
        billDate: new Date(),
        categoryId: category.id,
        subtotal: 50_000,
      }),
    );
    await unscopedPrisma.vendorBill.update({ where: { id: bill.id }, data: { vendorPan: 'ABCDE1234F' } });

    const err = await expectReject(() =>
      asUser(FINANCE, () => payVendorBill(bill.id, { amount: 50_000, accountId: account.id, paidOn: new Date() })),
    );
    expect(err.message).toContain('CMP-TDS-001');

    const { result } = await asUser(FINANCE, () => computeVendorTds(bill.id, { section: '194C_IND' }));
    expect(result.applicable).toBe(true);
    expect(result.tdsAmount).toBe(500);

    // What reaches the vendor is net of the TDS withheld; the bill's own total
    // is unaffected — the withheld amount is a separate government remittance,
    // tracked through the challan, not a reduction of what the bill records
    // as owed.
    const paid = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 50_000, accountId: account.id, paidOn: new Date() }),
    );
    expect(paid.bill.status).toBe('paid');
  });

  it('allows payment once TDS is explicitly waived with a reason', async () => {
    const account = await bankAccount();
    const category = await asUser(FINANCE, () => createCategory({ name: `Brokerage ${Date.now()}`, kind: 'expense' }));
    await asUser(FINANCE, () => setApplicabilityRule({ categoryId: category.id, section: '194H' }));

    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: `Waived Vendor ${Date.now()}`, billDate: new Date(), categoryId: category.id, subtotal: 20_000 }),
    );

    const blocked = await expectReject(() =>
      asUser(FINANCE, () => payVendorBill(bill.id, { amount: 20_000, accountId: account.id, paidOn: new Date() })),
    );
    expect(blocked.message).toContain('CMP-TDS-001');

    await asUser(FINANCE, () => waiveVendorTds(bill.id, 'One-off referral, below the aggregate the vendor will ever cross.'));

    const paid = await asUser(FINANCE, () => payVendorBill(bill.id, { amount: 20_000, accountId: account.id, paidOn: new Date() }));
    expect(paid.bill.status).toBe('paid');
  });

  it('does not block a bill whose category has no TDS applicability rule', async () => {
    const account = await bankAccount();
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: `No Rule Vendor ${Date.now()}`, billDate: new Date(), subtotal: 5_000 }),
    );
    const paid = await asUser(FINANCE, () => payVendorBill(bill.id, { amount: 5_000, accountId: account.id, paidOn: new Date() }));
    expect(paid.bill.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// CMP-TDS-002 — challans, the deposit ladder, and proposer/approver
// ---------------------------------------------------------------------------

describe('CMP-TDS-002 — TDS challans', () => {
  it('the deposit ladder fires before the 7th, and a challan is marked paid only against BSR/challan number', async () => {
    const vendorPan = `AAAAA${Math.floor(Math.random() * 9000 + 1000)}A`;
    // A distinct, settled month each run — years back by a random amount — so a
    // rerun on a database that was not reseeded never collides with an
    // already-paid challan from a previous run.
    const yearsBack = 2 + Math.floor(Math.random() * 4); // stays well after the seeded rate table's 2020 start
    const billDate = new Date(Date.UTC(new Date().getUTCFullYear() - yearsBack, 5, 15));
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: 'Ladder Test Vendor', billDate, subtotal: 100_000 }),
    );
    await unscopedPrisma.vendorBill.update({ where: { id: bill.id }, data: { vendorPan } });
    await asUser(FINANCE, () => computeVendorTds(bill.id, { section: '194C_IND' }));

    const month = `${billDate.getUTCFullYear()}-${String(billDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const nextMonthFirst = new Date(Date.UTC(billDate.getUTCFullYear(), billDate.getUTCMonth() + 1, 5)); // 2 days before the 7th
    const raised = await asUser(FINANCE, () => runTdsDepositDueJob(nextMonthFirst));
    expect(raised).toBeGreaterThan(0);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'CMP_TDS_DEPOSIT_DUE', subjectId: `${month}:194C_IND` },
    });
    expect(exception).toBeTruthy();
    expect(exception!.reasonCode).toBe('CMP-TDS-002');

    const challan = await asUser(FINANCE_2, () => createChallan({ month, sectionGroup: '194C_IND' }));
    expect(Number(challan.amount)).toBeGreaterThan(0);

    // The proposer never approves.
    const selfPay = await expectReject(() =>
      asUser(FINANCE_2, () => markChallanPaid(challan.id, { bsrCode: '0000123', challanNo: 'CHN001', paidOn: new Date() })),
    );
    expect(selfPay.status).toBe(403);

    const paid = await asUser(FINANCE, () => markChallanPaid(challan.id, { bsrCode: '0000123', challanNo: 'CHN001', paidOn: new Date() }));
    expect(paid.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// CMP-TDS-003 — MSME 43B(h)
// ---------------------------------------------------------------------------

describe('CMP-TDS-003 — MSME 45-day payment term', () => {
  it('raises an exception once for an unpaid Udyam-registered bill past its due date, and shows the disallowance exposure', async () => {
    const billDate = new Date(Date.now() - 60 * 86_400_000); // 60 days ago
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: 'MSME Supplier', billDate, subtotal: 30_000 }),
    );
    await asUser(FINANCE, () => setMsmeTerms(bill.id, { udyamNumber: 'UDYAM-TN-00-0000001' }));

    const before = await unscopedPrisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } });
    expect(before.msmeDueAt!.getTime()).toBeLessThan(Date.now());

    const raised = await asUser(FINANCE, () => runMsmeLadder());
    expect(raised).toBeGreaterThan(0);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'CMP_MSME_45_DAY', subjectId: bill.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.reasonCode).toBe('CMP-TDS-003');

    // Idempotent — a second run does not raise it again for the same bill.
    const raisedAgain = await asUser(FINANCE, () => runMsmeLadder());
    expect(raisedAgain).toBe(0);

    const exposure = await asUser(FINANCE, () => msmeExposure());
    expect(exposure.bills.some((b) => b.id === bill.id)).toBe(true);
    expect(exposure.exposure).toBeGreaterThanOrEqual(30_000);
  });

  it('the before-pay hook does not block an MSME bill past its due date — it only appears in the exposure summary', async () => {
    const account = await bankAccount();
    const billDate = new Date(Date.now() - 60 * 86_400_000);
    const bill = await asUser(FINANCE, () => recordVendorBill({ vendorName: 'MSME Payable', billDate, subtotal: 10_000 }));
    await asUser(FINANCE, () => setMsmeTerms(bill.id, { udyamNumber: 'UDYAM-TN-00-0000002' }));
    const paid = await asUser(FINANCE, () => payVendorBill(bill.id, { amount: 10_000, accountId: account.id, paidOn: new Date() }));
    expect(paid.bill.status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// Returns — snapshot immutability
// ---------------------------------------------------------------------------

describe('Quarterly TDS returns — snapshot, superseded, never edited', () => {
  it('a second preparation for the same quarter supersedes the first rather than editing it, and a filed return cannot be re-prepared over', async () => {
    const fy = fyOf(new Date());
    const quarter = 'Q1' as const;
    // Idempotent against a rerun on a database that was not reseeded.
    await unscopedPrisma.tdsReturn.deleteMany({ where: { tenantId: TENANT, fy, quarter, form: '26Q' } });

    const first = await asUser(FINANCE, () => prepareTdsReturn(fy, quarter, '26Q'));
    expect(first.status).toBe('prepared');
    const firstSnapshot = JSON.stringify(first.snapshot);

    const second = await asUser(FINANCE, () => prepareTdsReturn(fy, quarter, '26Q'));
    const supersededFirst = await unscopedPrisma.tdsReturn.findFirstOrThrow({ where: { id: first.id } });
    expect(supersededFirst.status).toBe('superseded');
    expect(supersededFirst.supersededById).toBe(second.id);
    // The superseded row's own snapshot is untouched.
    expect(JSON.stringify(supersededFirst.snapshot)).toBe(firstSnapshot);

    const filed = await asUser(FINANCE, () => fileTdsReturn(second.id, 'ACK1234567'));
    expect(filed.status).toBe('filed');

    const err = await expectReject(() => asUser(FINANCE, () => prepareTdsReturn(fy, quarter, '26Q')));
    expect(err.status).toBe(409);
  });
});
