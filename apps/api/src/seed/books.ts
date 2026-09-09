/**
 * The books dataset.
 *
 * The chart of accounts, the cost behaviours and the seven months of history
 * below are the company's own, taken from the ledger the founder actually
 * keeps — down to the ₹32,000 rent that starts in the second month and the
 * three income lines that begin at different times as each division opens.
 *
 * That matters more than it looks. A finance module seeded with round
 * invented numbers demonstrates that the arithmetic runs; seeded with these,
 * it shows the thing the founder wants to see — that Software carries Skill
 * Development and Education while they build, and by how much.
 */

import { round2 } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { nextRecordCode } from '../platform/recordCode.js';

/** The mock's division names, mapped onto the platform's codes. */
const DIVISION_OF: Record<string, string> = {
  'Software': 'software',
  'Skill Development': 'skill',
  'Education': 'education',
  'Shared / Corporate': 'shared',
};

/** And its cost-nature labels onto the behaviours a forecast can use. */
const BEHAVIOUR_OF: Record<string, string> = {
  'Recurring Fixed': 'recurring_fixed',
  'Variable / Program-linked': 'variable',
  'One-time / Setup': 'one_time',
  'Annual / Periodic': 'annual',
  '—': 'variable',
};

interface CategorySpec {
  name: string;
  type: 'Income' | 'Expense';
  division: string;
  costNature: string;
  /** Seven months of actuals, oldest first. */
  baseline: number[];
}

const CATEGORIES: CategorySpec[] = [
  { name: 'Income - Internship', type: 'Income', division: 'Education', costNature: '—', baseline: [0, 0, 0, 0, 17500, 0, 0] },
  { name: 'Income - Short Term Courses', type: 'Income', division: 'Education', costNature: '—', baseline: [0, 0, 0, 0, 0, 10000, 20700] },
  { name: 'Income - Skill Programs', type: 'Income', division: 'Skill Development', costNature: '—', baseline: [0, 0, 0, 0, 0, 0, 49728] },
  { name: 'Income - Software Service', type: 'Income', division: 'Software', costNature: '—', baseline: [0, 0, 0, 50000, 130000, 50000, 100000] },
  { name: 'Miscellaneous Income', type: 'Income', division: 'Shared / Corporate', costNature: '—', baseline: [0, 0, 0, 0, 2, 0, 0] },

  { name: 'Advertisements - Social Media', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 0, 0, 0, 0, 0, 5778] },
  { name: 'Registration - Skill Programs', type: 'Expense', division: 'Skill Development', costNature: 'Variable / Program-linked', baseline: [0, 0, 0, 0, 0, 0, 2100] },
  { name: 'Skill Program Expenses', type: 'Expense', division: 'Skill Development', costNature: 'Variable / Program-linked', baseline: [0, 0, 0, 0, 0, 7000, 0] },
  { name: 'Salary & Wages', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 24000, 31000, 57500, 66600, 106166, 195291] },
  { name: 'Auditor Fees', type: 'Expense', division: 'Shared / Corporate', costNature: 'Annual / Periodic', baseline: [5000, 15000, 0, 0, 0, 0, 0] },
  { name: 'Bank Charges', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 0, 0, 118, 23.6, 405.01, 402.03] },
  { name: 'Building Rent', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 32000, 32000, 32000, 32000, 32000, 32000] },
  { name: 'Consultation Fees', type: 'Expense', division: 'Shared / Corporate', costNature: 'Annual / Periodic', baseline: [0, 0, 0, 0, 0, 0, 20000] },
  { name: 'Electrical Charges', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 195, 0, 2629, 0, 16649, 0] },
  { name: 'General Expenses', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 2002, 14033, 17030, 12500, 5000, 0] },
  { name: 'Incorporation Expenses', type: 'Expense', division: 'Shared / Corporate', costNature: 'One-time / Setup', baseline: [13100, 1363, 3953, 400, 0, 1000, 0] },
  { name: 'Installation of Equipments', type: 'Expense', division: 'Shared / Corporate', costNature: 'One-time / Setup', baseline: [12400, 16146, 3115, 0, 3000, 0, 0] },
  { name: 'Local Conveyance', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [2803, 2600, 2000, 3000, 3200, 2000, 7500] },
  { name: 'Office Maintenance', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 3010, 0, 1000, 0, 0, 800] },
  { name: 'Opening Ceremony', type: 'Expense', division: 'Shared / Corporate', costNature: 'One-time / Setup', baseline: [0, 12712, 0, 0, 0, 0, 0] },
  { name: 'Printing & Stationery', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [370, 11042.02, 8889, 0, 190, 0, 1565] },
  { name: 'Software Subscription - Google Workspace', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [500, 0, 280, 6762.55, 5477, 4543, 24437.14] },
  { name: 'Staff Welfare Expenses', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [4031, 2880, 906, 3024, 625, 0, 0] },
  { name: 'Telephone & Internet Expenses', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 173.2, 2777, 429.84, 3429.82, 1062.04, 1886.82] },
  { name: 'Travelling Expenses - Marketing', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 1512, 0, 0, 0, 0, 0] },
  { name: 'Water Charges', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 0, 0, 0, 0, 0, 2000] },
  { name: 'Website/Domain Expenses', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 0, 18000, 0, 0, 0, 1744] },
  { name: 'Interest Expense', type: 'Expense', division: 'Shared / Corporate', costNature: 'Recurring Fixed', baseline: [0, 0, 0, 0, 0, 0, 0] },
  { name: 'Fixed Asset Purchase', type: 'Expense', division: 'Shared / Corporate', costNature: 'One-time / Setup', baseline: [0, 0, 0, 0, 0, 0, 0] },

  // The company was funded before it earned anything, and the ledger has to
  // say so: without this the bank account runs overdrawn from the second month,
  // which is not what happened and not something a bank would have allowed.
  { name: 'Capital Introduced', type: 'Income', division: 'Shared / Corporate', costNature: 'One-time / Setup', baseline: [1_200_000, 0, 0, 0, 400_000, 0, 0] },
];

/** Costs the company cannot defer — the ones a cash plan must clear first. */
const MUST_PAY = new Set(['Building Rent', 'Salary & Wages', 'Auditor Fees', 'Electrical Charges', 'Water Charges']);

/** The `n`th of the seven baseline months, counting back from last month. */
function baselineMonth(index: number): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (7 - index));
  return d;
}

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function seedBooks() {
  const tenantId = currentAuth().tenantId;

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  const accountSpecs = [
    { name: 'Current Account — HDFC', accountType: 'bank', displayReference: '••4821', openingBalance: 250_000, ledgerGroup: 'asset' },
    { name: 'Cash in Hand', accountType: 'cash', displayReference: null, openingBalance: 15_000, ledgerGroup: 'asset' },
    { name: 'Corporate Card', accountType: 'card', displayReference: '••7702', openingBalance: 0, ledgerGroup: 'liability' },
  ];

  const accounts = new Map<string, string>();
  for (const spec of accountSpecs) {
    const existing = await prisma.ledgerAccount.findFirst({ where: { tenantId, name: spec.name } });
    const account =
      existing ??
      (await prisma.ledgerAccount.create({
        data: {
          tenantId,
          name: spec.name,
          accountType: spec.accountType,
          displayReference: spec.displayReference,
          openingBalance: spec.openingBalance,
          openingDate: baselineMonth(0),
          ledgerGroup: spec.ledgerGroup,
        },
      }));
    accounts.set(spec.name, account.id);
  }
  const bank = accounts.get('Current Account — HDFC')!;

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------
  const categories = new Map<string, string>();
  for (const spec of CATEGORIES) {
    const existing = await prisma.ledgerCategory.findFirst({ where: { tenantId, name: spec.name } });
    const category =
      existing ??
      (await prisma.ledgerCategory.create({
        data: {
          tenantId,
          name: spec.name,
          // Capital introduced is funding, not trading income — it is money in
          // that must not appear as revenue. `equity` keeps it out of the P&L
          // while still moving the bank balance.
          kind:
            spec.name === 'Capital Introduced'
              ? 'equity'
              : spec.type === 'Income'
                ? 'income'
                : spec.name === 'Fixed Asset Purchase'
                  ? 'asset_purchase'
                  : 'expense',
          behaviour: BEHAVIOUR_OF[spec.costNature] ?? 'variable',
          defaultDivision: DIVISION_OF[spec.division] ?? 'shared',
          mustPay: MUST_PAY.has(spec.name),
        },
      }));
    categories.set(spec.name, category.id);
  }

  // -------------------------------------------------------------------------
  // Seven months of actuals.
  //
  // One transaction per category per month it had a figure — the monthly total
  // rather than each individual receipt, which is the grain the founder's own
  // ledger keeps and enough for every rollup the platform draws.
  // -------------------------------------------------------------------------
  const already = await prisma.transaction.count({ where: { tenantId, source: 'manual' } });
  if (already === 0) {
    for (const spec of CATEGORIES) {
      for (let i = 0; i < spec.baseline.length; i += 1) {
        const value = spec.baseline[i];
        if (!value) continue;

        const month = baselineMonth(i);
        // Income tends to land late in the month, costs through it. The exact
        // day is invented; the month and the amount are not.
        const day = spec.type === 'Income' ? 25 : 5 + (i % 20);

        await prisma.transaction.create({
          data: {
            tenantId,
            recordCode: await nextRecordCode('TXN'),
            txnDate: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day)),
            direction: spec.type === 'Income' ? 'in' : 'out',
            amount: round2(value),
            accountId: bank,
            categoryId: categories.get(spec.name)!,
            division: DIVISION_OF[spec.division] ?? 'shared',
            counterparty: spec.type === 'Income' ? 'Customer receipts' : spec.name,
            note: `${spec.name} — ${monthOf(month)}`,
            source: 'manual',
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The standing commitments, from the founder's own list.
  // -------------------------------------------------------------------------
  const recurringSpecs = [
    { label: 'Building Rent', category: 'Building Rent', amount: 32_000, cadence: 'monthly', dayOfMonth: 1, monthsAgo: 6 },
    { label: 'Google Workspace subscription', category: 'Software Subscription - Google Workspace', amount: 3_500, cadence: 'monthly', dayOfMonth: 5, monthsAgo: 1 },
    { label: 'Auditor Fees', category: 'Auditor Fees', amount: 20_000, cadence: 'annual', dayOfMonth: 1, monthsAgo: 0 },
  ];

  for (const spec of recurringSpecs) {
    const existing = await prisma.recurringRule.findFirst({ where: { tenantId, label: spec.label } });
    if (existing) continue;
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - spec.monthsAgo);
    await prisma.recurringRule.create({
      data: {
        tenantId,
        label: spec.label,
        categoryId: categories.get(spec.category)!,
        accountId: bank,
        division: 'shared',
        direction: 'out',
        amount: spec.amount,
        cadence: spec.cadence,
        dayOfMonth: spec.dayOfMonth,
        startDate: start,
        // Already reflected in the actuals above, so generating this month
        // would double-count it.
        lastGeneratedPeriod: monthOf(baselineMonth(6)),
      },
    });
  }

  // -------------------------------------------------------------------------
  // A budget for the month in progress, set at the trailing three-month
  // average — which is what a first budget usually is.
  // -------------------------------------------------------------------------
  const thisPeriod = monthOf(new Date());
  const budgetCount = await prisma.budgetLine.count({ where: { tenantId, period: thisPeriod } });
  if (budgetCount === 0) {
    for (const spec of CATEGORIES) {
      if (spec.type !== 'Expense') continue;
      const recent = spec.baseline.slice(-3);
      const average = round2(recent.reduce((s, v) => s + v, 0) / recent.length);
      if (average <= 0) continue;
      await prisma.budgetLine.create({
        data: {
          tenantId,
          period: thisPeriod,
          categoryId: categories.get(spec.name)!,
          division: DIVISION_OF[spec.division] ?? 'shared',
          amount: average,
          note: 'Trailing three-month average',
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Supplier bills, one already overdue so the ageing report and the detector
  // both have something real.
  // -------------------------------------------------------------------------
  const billSpecs = [
    { vendorName: 'Sundaram Property Services', billNumber: 'SPS/26/1180', daysAgo: 40, dueInDays: -10, subtotal: 32_000, taxAmount: 0, category: 'Building Rent' },
    { vendorName: 'Chennai Power Distribution', billNumber: 'CPD-88213', daysAgo: 12, dueInDays: 6, subtotal: 16_649, taxAmount: 0, category: 'Electrical Charges' },
    { vendorName: 'Vaidyanathan & Co, Chartered Accountants', billNumber: 'VC/2026/044', daysAgo: 5, dueInDays: 25, subtotal: 20_000, taxAmount: 3_600, category: 'Auditor Fees' },
  ];

  for (const spec of billSpecs) {
    const existing = await prisma.vendorBill.findFirst({ where: { tenantId, billNumber: spec.billNumber } });
    if (existing) continue;
    const total = round2(spec.subtotal + spec.taxAmount);
    await prisma.vendorBill.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('BILL'),
        vendorName: spec.vendorName,
        billNumber: spec.billNumber,
        billDate: new Date(Date.now() - spec.daysAgo * 86_400_000),
        dueDate: new Date(Date.now() + spec.dueInDays * 86_400_000),
        categoryId: categories.get(spec.category) ?? null,
        division: 'shared',
        subtotal: spec.subtotal,
        taxAmount: spec.taxAmount,
        total,
        status: 'open',
      },
    });
  }

  // -------------------------------------------------------------------------
  // Capital and borrowing
  // -------------------------------------------------------------------------
  const assetSpecs = [
    { name: 'Classroom projectors and screens', cost: 168_000, usefulLifeMonths: 60, monthsAgo: 6, division: 'education' },
    { name: 'Developer workstations (4)', cost: 312_000, usefulLifeMonths: 48, monthsAgo: 5, division: 'software' },
    { name: 'Office furniture and fit-out', cost: 224_000, usefulLifeMonths: 120, monthsAgo: 7, division: 'shared' },
  ];

  for (const spec of assetSpecs) {
    const existing = await prisma.fixedAsset.findFirst({ where: { tenantId, name: spec.name } });
    if (existing) continue;
    const purchaseDate = new Date();
    purchaseDate.setUTCDate(1);
    purchaseDate.setUTCMonth(purchaseDate.getUTCMonth() - spec.monthsAgo);
    await prisma.fixedAsset.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('FA'),
        name: spec.name,
        purchaseDate,
        cost: spec.cost,
        salvageValue: round2(spec.cost * 0.05),
        usefulLifeMonths: spec.usefulLifeMonths,
        method: 'straight_line',
        division: spec.division,
        categoryId: categories.get('Fixed Asset Purchase') ?? null,
      },
    });
  }

  const loanExists = await prisma.loan.findFirst({ where: { tenantId } });
  if (!loanExists) {
    const startDate = new Date();
    startDate.setUTCDate(1);
    startDate.setUTCMonth(startDate.getUTCMonth() - 6);
    await prisma.loan.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('LN'),
        lender: 'Tamil Nadu Mercantile Bank — equipment loan',
        principal: 500_000,
        annualRate: 11.5,
        tenureMonths: 36,
        startDate,
        accountId: bank,
        division: 'shared',
      },
    });
  }

  const txns = await prisma.transaction.count({ where: { tenantId } });
  console.log(`books   ${categories.size} categories, ${accounts.size} accounts, ${txns} transactions, budget ${thisPeriod}`);
}
