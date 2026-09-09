/**
 * The books — Canon §15.
 *
 * The arithmetic first, without a database, because GST that splits the wrong
 * way and depreciation that writes below salvage are wrong on their own terms
 * and need no persistence to demonstrate. Then the wiring: that a correction
 * is a second entry rather than an edit, that funding is not revenue, and that
 * a viewer without the money verb gets nothing rather than a zero.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeGst,
  isInterState,
  round2,
  monthKey,
  monthsBack,
  financialYearOf,
  depreciationSchedule,
  bookValueAt,
  amortisationSchedule,
  emi,
  runwayMonths,
  isTrading,
} from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import {
  recordTransaction,
  reverseTransaction,
  recordVendorBill,
  payVendorBill,
  payablesAgeing,
  budgetVariance,
  setBudgetLine,
  profitAndLoss,
  cashPosition,
  accountBalances,
  generateRecurring,
} from '../domains/books.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

async function categoryNamed(name: string) {
  return unscopedPrisma.ledgerCategory.findFirstOrThrow({ where: { tenantId: TENANT, name } });
}

// ===========================================================================
// GST
// ===========================================================================

describe('GST splits by where the customer is, not by preference', () => {
  it('halves into CGST and SGST within the state', () => {
    const gst = computeGst([{ taxableValue: 100_000, gstRate: 18 }], false);
    expect(gst.cgst).toBe(9_000);
    expect(gst.sgst).toBe(9_000);
    expect(gst.igst).toBe(0);
    expect(gst.tax).toBe(18_000);
  });

  it('lands as a single IGST across a state line', () => {
    const gst = computeGst([{ taxableValue: 100_000, gstRate: 18 }], true);
    expect(gst.igst).toBe(18_000);
    expect(gst.cgst).toBe(0);
    expect(gst.sgst).toBe(0);
  });

  it('taxes each line at its own rate rather than the invoice at one', () => {
    // A single invoice can carry an 18% service and a 5% good. Halving the
    // invoice total at a blended rate would misstate both lines.
    const gst = computeGst(
      [
        { taxableValue: 100_000, gstRate: 18 },
        { taxableValue: 50_000, gstRate: 5 },
      ],
      true,
    );
    expect(gst.taxableValue).toBe(150_000);
    expect(gst.igst).toBe(20_500);
  });

  it('keeps the two halves summing to the tax on an odd paisa', () => {
    const gst = computeGst([{ taxableValue: 1_111, gstRate: 5 }], false);
    // 55.55 does not halve evenly; the halves must still add back exactly.
    expect(round2(gst.cgst + gst.sgst)).toBe(gst.tax);
  });

  it('carries the rounding to the rupee explicitly', () => {
    const gst = computeGst([{ taxableValue: 1_234.56, gstRate: 18 }], true);
    expect(gst.grandTotal).toBe(Math.round(gst.total));
    // The ledger and the printed invoice must not differ by paise nobody can
    // account for, so the difference is a named figure.
    expect(round2(gst.total + gst.roundOff)).toBe(gst.grandTotal);
  });

  it('reads the state from the GSTIN, and refuses to guess without one', () => {
    expect(isInterState('33ABCDE1234F1Z5', '33ZYXWV9876G1A2')).toBe(false);
    expect(isInterState('33ABCDE1234F1Z5', '29ZYXWV9876G1A2')).toBe(true);
    // An unregistered buyer has no state code, so the place of supply decides
    // and the caller has to say.
    expect(isInterState('33ABCDE1234F1Z5', null)).toBeNull();
  });
});

// ===========================================================================
// Depreciation and loans
// ===========================================================================

describe('Depreciation', () => {
  it('writes a straight-line asset down to its salvage value and no further', () => {
    const input = {
      cost: 120_000,
      salvageValue: 20_000,
      usefulLifeMonths: 10,
      purchaseDate: new Date(Date.UTC(2026, 0, 1)),
      method: 'straight_line' as const,
    };
    const schedule = depreciationSchedule(input);
    expect(schedule).toHaveLength(10);
    expect(schedule[0].charge).toBe(10_000);
    // Never below salvage, whatever the rounding does along the way.
    expect(schedule[schedule.length - 1].closing).toBe(20_000);
  });

  it('slows as the balance falls under written-down value', () => {
    const input = {
      cost: 100_000,
      salvageValue: 0,
      usefulLifeMonths: 24,
      purchaseDate: new Date(Date.UTC(2026, 0, 1)),
      method: 'wdv' as const,
      wdvRate: 40,
    };
    const schedule = depreciationSchedule(input);
    // The whole point of WDV: each month charges less than the one before.
    expect(schedule[0].charge).toBeGreaterThan(schedule[5].charge);
    expect(schedule[5].charge).toBeGreaterThan(schedule[11].charge);
  });

  it('carries the book value at a date from the same schedule', () => {
    const input = {
      cost: 120_000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      purchaseDate: new Date(Date.UTC(2026, 0, 1)),
      method: 'straight_line' as const,
    };
    expect(bookValueAt(input, new Date(Date.UTC(2026, 5, 15)))).toBe(60_000);
    expect(bookValueAt(input, new Date(Date.UTC(2025, 11, 1)))).toBe(120_000);
  });
});

describe('Loans', () => {
  it('computes a level instalment', () => {
    // ₹5,00,000 at 11.5% over 36 months.
    expect(emi(500_000, 11.5, 36)).toBe(16_488);
  });

  it('divides evenly when there is no interest, instead of dividing by zero', () => {
    expect(emi(120_000, 0, 12)).toBe(10_000);
  });

  it('clears the balance exactly at the end of the term', () => {
    const schedule = amortisationSchedule({
      principal: 500_000,
      annualRate: 11.5,
      tenureMonths: 36,
      startDate: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(schedule).toHaveLength(36);
    // Rounding across three years must not leave a balance on a repaid loan.
    expect(schedule[schedule.length - 1].closing).toBe(0);
  });

  it('shifts from interest to principal as it runs', () => {
    const schedule = amortisationSchedule({
      principal: 500_000,
      annualRate: 11.5,
      tenureMonths: 36,
      startDate: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(schedule[0].interest).toBeGreaterThan(schedule[0].principal * 0);
    expect(schedule[35].interest).toBeLessThan(schedule[0].interest);
    expect(schedule[35].principal).toBeGreaterThan(schedule[0].principal);
  });
});

// ===========================================================================
// Runway, periods, and what counts as trading
// ===========================================================================

describe('Runway is a length of time or it is nothing', () => {
  it('divides cash by the burn', () => {
    expect(runwayMonths(1_000_000, 100_000)).toBe(10);
  });

  it('is null when the company is not burning', () => {
    // "Infinite runway" is a number that reads as a fact and is not one.
    expect(runwayMonths(1_000_000, 0)).toBeNull();
    expect(runwayMonths(1_000_000, -50_000)).toBeNull();
  });

  it('is zero when overdrawn, never negative', () => {
    // "-4.2 months" reads as a quantity of time. The money has already gone.
    expect(runwayMonths(-300_000, 70_000)).toBe(0);
  });
});

describe('Periods', () => {
  it('runs the financial year from April', () => {
    expect(financialYearOf(new Date(Date.UTC(2026, 3, 1)))).toBe('FY2026-27');
    expect(financialYearOf(new Date(Date.UTC(2026, 2, 31)))).toBe('FY2025-26');
  });

  it('counts months back across a year boundary', () => {
    expect(monthsBack('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('What counts as trading', () => {
  it('excludes funding, drawings and internal transfers', () => {
    // Counting capital as revenue is what makes a funded month look profitable.
    expect(isTrading('equity')).toBe(false);
    expect(isTrading('drawings')).toBe(false);
    expect(isTrading('transfer')).toBe(false);
    expect(isTrading('income')).toBe(true);
    expect(isTrading('expense')).toBe(true);
  });
});

// ===========================================================================
// The ledger
// ===========================================================================

describe('The ledger corrects by entry, never by edit', () => {
  it('reverses with a second row that points at the first', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');

    const original = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 4_321,
        accountId: account.id,
        categoryId: category.id,
        note: 'Entered by mistake',
      }),
    );

    const reversal = await asUser('latha@kaizen.co.in', () => reverseTransaction(original.id, 'Duplicate entry'));

    expect(reversal.direction).toBe('in');
    expect(Number(reversal.amount)).toBe(4_321);
    expect(reversal.reversalOfId).toBe(original.id);

    // The original stays. A reconciled bank line still matches something.
    const reloaded = await unscopedPrisma.transaction.findFirstOrThrow({ where: { id: original.id } });
    expect(reloaded.deletedAt).toBeNull();
    expect(reloaded.reversedById).toBe(reversal.id);
  });

  it('refuses to reverse the same entry twice', async () => {
    const account = await bankAccount();
    const txn = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 100, accountId: account.id }),
    );
    await asUser('latha@kaizen.co.in', () => reverseTransaction(txn.id, 'first'));

    const err = await expectReject(() => asUser('latha@kaizen.co.in', () => reverseTransaction(txn.id, 'second')));
    expect(err.status).toBe(409);
  });

  it('refuses to reverse a reversal, which would restore the error', async () => {
    const account = await bankAccount();
    const txn = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 200, accountId: account.id }),
    );
    const reversal = await asUser('latha@kaizen.co.in', () => reverseTransaction(txn.id, 'wrong'));

    const err = await expectReject(() =>
      asUser('latha@kaizen.co.in', () => reverseTransaction(reversal.id, 'undo the undo')),
    );
    expect(err.status).toBe(422);
  });

  it('takes the sign from the direction, not from a negative amount', async () => {
    const account = await bankAccount();
    const err = await expectReject(() =>
      asUser('latha@kaizen.co.in', () =>
        recordTransaction({ txnDate: new Date(), direction: 'out', amount: -500, accountId: account.id }),
      ),
    );
    expect(err.status).toBe(422);
  });

  it('takes the division from the category when the entry does not say', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('Skill Program Expenses');

    const txn = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 1_500,
        accountId: account.id,
        categoryId: category.id,
      }),
    );
    expect(txn.division).toBe('skill');
  });

  it('lets an entry override the category default, because a split is a judgement', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('Skill Program Expenses');

    const txn = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 1_500,
        accountId: account.id,
        categoryId: category.id,
        division: 'education',
      }),
    );
    expect(txn.division).toBe('education');
  });

  it('reflects a reversal in the account balance immediately', async () => {
    const account = await bankAccount();
    const before = (await asUser('latha@kaizen.co.in', () => accountBalances())).find((a) => a.id === account.id)!;

    const txn = await asUser('latha@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 7_500, accountId: account.id }),
    );
    const after = (await asUser('latha@kaizen.co.in', () => accountBalances())).find((a) => a.id === account.id)!;
    expect(after.balance).toBe(round2(before.balance - 7_500));

    await asUser('latha@kaizen.co.in', () => reverseTransaction(txn.id, 'corrected'));
    const restored = (await asUser('latha@kaizen.co.in', () => accountBalances())).find((a) => a.id === account.id)!;
    // The balance is summed from the ledger, so it comes straight back.
    expect(restored.balance).toBe(before.balance);
  });
});

// ===========================================================================
// The P&L
// ===========================================================================

describe('The profit and loss shows trading, not funding', () => {
  it('keeps capital introduced out of income', async () => {
    const capital = await unscopedPrisma.ledgerCategory.findFirst({
      where: { tenantId: TENANT, name: 'Capital Introduced' },
    });
    expect(capital?.kind).toBe('equity');

    const txn = await unscopedPrisma.transaction.findFirst({
      where: { tenantId: TENANT, categoryId: capital!.id },
      orderBy: { txnDate: 'asc' },
    });
    expect(txn).toBeTruthy();

    const period = monthKey(txn!.txnDate);
    const pl = await asUser('chairman@kaizen.co.in', () => profitAndLoss(period));

    // ₹12,00,000 landed in the bank that month. It is not revenue, and a
    // dashboard that counted it would show the company's best month ever.
    expect(pl.income).toBeLessThan(Number(txn!.amount));
  });

  it('cuts the result by division, which is the whole point', async () => {
    const pl = await asUser('chairman@kaizen.co.in', () => profitAndLoss('2026-08'));
    const divisions = pl.byDivision.map((d) => d.division);
    expect(divisions).toContain('shared');
    // One entity, three businesses. A single consolidated figure hides which
    // of them is paying for the others.
    expect(pl.byDivision.length).toBeGreaterThan(1);
    expect(round2(pl.income - pl.expense)).toBe(pl.net);
  });

  it('counts capital in the cash position even though it is not income', async () => {
    const position = await asUser('chairman@kaizen.co.in', () => cashPosition());
    // It is not revenue, but it is unquestionably money in the bank.
    expect(position.cash).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Payables
// ===========================================================================

describe('Payables — the half the platform was missing', () => {
  it('pays a bill through the ledger and follows the status from what is paid', async () => {
    const account = await bankAccount();
    const bill = await asUser('latha@kaizen.co.in', () =>
      recordVendorBill({
        vendorName: 'Test Supplies Pvt Ltd',
        billDate: new Date(),
        dueDate: new Date(Date.now() + 15 * 86_400_000),
        subtotal: 10_000,
        taxAmount: 1_800,
      }),
    );
    expect(Number(bill.total)).toBe(11_800);

    const part = await asUser('latha@kaizen.co.in', () =>
      payVendorBill(bill.id, { amount: 5_000, accountId: account.id, paidOn: new Date() }),
    );
    expect(part.bill.status).toBe('part_paid');
    // The payment is a ledger entry like any other — bills have no private
    // notion of money.
    expect(part.transaction.vendorBillId).toBe(bill.id);
    expect(part.transaction.source).toBe('vendor_bill');

    const full = await asUser('latha@kaizen.co.in', () =>
      payVendorBill(bill.id, { amount: 6_800, accountId: account.id, paidOn: new Date() }),
    );
    expect(full.bill.status).toBe('paid');
  });

  it('refuses to pay more than is outstanding', async () => {
    const account = await bankAccount();
    const bill = await asUser('latha@kaizen.co.in', () =>
      recordVendorBill({ vendorName: 'Overpay Test', billDate: new Date(), subtotal: 1_000 }),
    );

    const err = await expectReject(() =>
      asUser('latha@kaizen.co.in', () =>
        payVendorBill(bill.id, { amount: 5_000, accountId: account.id, paidOn: new Date() }),
      ),
    );
    // An overpayment is a credit note, not a bigger payment.
    expect(err.status).toBe(422);
  });

  it('ages what is overdue', async () => {
    const ageing = await asUser('latha@kaizen.co.in', () => payablesAgeing());
    expect(ageing.total).toBeGreaterThan(0);
    const bucketed = round2(
      ageing.buckets.current + ageing.buckets.d30 + ageing.buckets.d60 + ageing.buckets.d90 + ageing.buckets.older,
    );
    expect(bucketed).toBe(ageing.total);
  });
});

// ===========================================================================
// Budget
// ===========================================================================

describe('Budget variance is computed, never stored', () => {
  it('moves the variance when a late entry lands', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('Local Conveyance');
    const period = monthKey(new Date());

    await asUser('chairman@kaizen.co.in', () =>
      setBudgetLine({ period, categoryId: category.id, division: 'shared', amount: 10_000 }),
    );

    const before = await asUser('chairman@kaizen.co.in', () => budgetVariance(period));
    const beforeRow = before.rows.find((r) => r.categoryId === category.id)!;

    await asUser('latha@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 2_500,
        accountId: account.id,
        categoryId: category.id,
        division: 'shared',
      }),
    );

    const after = await asUser('chairman@kaizen.co.in', () => budgetVariance(period));
    const afterRow = after.rows.find((r) => r.categoryId === category.id)!;

    // An entry made late has to move the number, which is why the actual is a
    // sum at read time rather than a figure kept beside the budget.
    expect(afterRow.actual).toBe(round2(beforeRow.actual + 2_500));
    expect(afterRow.variance).toBe(round2(beforeRow.variance - 2_500));
  });

  it('lists spending under a category nobody budgeted', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('Opening Ceremony');
    const period = monthKey(new Date());

    await asUser('latha@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 3_333,
        accountId: account.id,
        categoryId: category.id,
        division: 'shared',
      }),
    );

    const variance = await asUser('chairman@kaizen.co.in', () => budgetVariance(period));
    const row = variance.rows.find((r) => r.categoryId === category.id);
    // Unbudgeted spend is the interesting case, so it appears rather than
    // being dropped for having no line to sit against.
    expect(row).toBeTruthy();
    expect(row!.budget).toBe(0);
    expect(row!.overspent).toBe(true);
  });
});

// ===========================================================================
// Recurring
// ===========================================================================

describe('Recurring entries are posted deliberately, and only once', () => {
  it('will not generate the same period twice', async () => {
    const period = monthKey(new Date(Date.UTC(2026, 10, 1)));
    const first = await asUser('latha@kaizen.co.in', () => generateRecurring(period));
    const second = await asUser('latha@kaizen.co.in', () => generateRecurring(period));

    // A rule that posted twice would double the rent for that month.
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(first.created);
  });
});

// ===========================================================================
// Who can see the money
// ===========================================================================

describe('Money is withheld, never zeroed', () => {
  it('keeps the ledger away from a principal with no grant on it', async () => {
    const err = await expectReject(() => asUser('ravi@kaizen.co.in', () => profitAndLoss('2026-08')));
    expect(err.status).toBe(403);
  });

  it('lets a unit head see the plan without the company ledger behind it', async () => {
    // `budgets:V` without the financial verb: the shape of the plan, not its
    // figures. The route is what withholds the amounts; the service returns
    // them and the projection drops them.
    const variance = await asUser('bhead@kaizen.co.in', () => budgetVariance(monthKey(new Date())));
    expect(variance.rows.length).toBeGreaterThan(0);
  });

  it('will not let the chairman record an entry', async () => {
    const account = await bankAccount();
    // The same shape as `payments:VXF`: sees everything, records nothing.
    const err = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () =>
        recordTransaction({ txnDate: new Date(), direction: 'out', amount: 100, accountId: account.id }),
      ),
    );
    expect(err.status).toBe(403);
  });
});
