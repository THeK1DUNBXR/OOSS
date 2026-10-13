/**
 * Characterisation of the books money columns (ORDERED-PLAN 1.6, MONEY-S5): the
 * budget line amount, the fixed asset cost, salvage and disposal value, the loan
 * principal, and the recurring rule amount. These assertions pass on the Decimal
 * columns and, unchanged, on the BigInt `*Minor` columns, so no figure moves by a
 * paisa and no client sees a field change type or lose a field.
 *
 * The schedules are pinned against the shared arithmetic fed the same rupee
 * numbers, so a change in how the column is read shows up as a changed schedule.
 */

import { describe, expect, it } from 'vitest';
import { amortisationSchedule, depreciationSchedule, monthKey } from '@kaizen/shared';
import { asSystem } from '../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { bigintReplacer } from '../platform/wire.js';
import {
  assetSchedule,
  createAsset,
  createLoan,
  generateRecurring,
  listAssets,
  listLoans,
  loanSchedule,
  setBudgetLine,
  budgetVariance,
} from '../domains/books.js';

/** What `res.json` would send: Prisma Decimals become their two-place string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ALL_TIME = new Date('2100-01-01T00:00:00Z');
const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';

describe('S5 books money columns: budget line, asset, loan and recurring rule', () => {
  it('a budget line keeps its two-place amount on the row and in the variance, as a number', async () => {
    const TID = await tenantId();
    const category = await unscopedPrisma.ledgerCategory.findFirstOrThrow({
      where: { tenantId: TID, name: 'Local Conveyance' },
    });
    const period = '2031-02';
    const division = `S5-${stamp()}`;

    const line = await asUser(CHAIRMAN, () =>
      setBudgetLine({ period, categoryId: category.id, division, amount: 12345.67 }),
    );
    expect(wire(line).amount).toBe('12345.67');

    const variance = await asUser(CHAIRMAN, () => budgetVariance(period));
    const row = variance.rows.find((r) => r.categoryId === category.id && r.division === division)!;
    expect(typeof row.budget).toBe('number');
    expect(row.budget).toBe(12345.67);
    expect(row.variance).toBe(12345.67);
  });

  it('an asset keeps cost, salvage and disposal value as two-place figures, and its schedule is the shared arithmetic on them', async () => {
    const asset = await asUser(FINANCE, () =>
      createAsset({
        name: `S5 asset ${stamp()}`,
        purchaseDate: new Date('2030-04-01T00:00:00Z'),
        cost: 1234567.89,
        salvageValue: 100.25,
        usefulLifeMonths: 60,
      }),
    );
    expect(wire(asset).cost).toBe('1234567.89');
    expect(wire(asset).salvageValue).toBe('100.25');
    expect(wire(asset).disposalValue).toBeNull();
    expect(wire(asset).wdvRate).toBe('0');

    const listed = await asUser(FINANCE, () => listAssets(new Date('2031-01-01T00:00:00Z')));
    const row = listed.find((a) => a.id === asset.id)!;
    expect(typeof row.cost).toBe('number');
    expect(row.cost).toBe(1234567.89);
    expect(row.disposedAt).toBeNull();

    const schedule = await asUser(FINANCE, () => assetSchedule(asset.id));
    expect(schedule).toEqual(
      depreciationSchedule({
        cost: 1234567.89,
        salvageValue: 100.25,
        usefulLifeMonths: 60,
        purchaseDate: new Date('2030-04-01T00:00:00Z'),
        method: 'straight_line',
        wdvRate: 0,
      }),
    );
  });

  it('a loan keeps its principal as a two-place figure, and its schedule is the shared arithmetic on it', async () => {
    const startDate = new Date('2030-06-01T00:00:00Z');
    const loan = await asUser(FINANCE, () =>
      createLoan({
        lender: `S5 lender ${stamp()}`,
        principal: 250000.75,
        annualRate: 9.5,
        tenureMonths: 36,
        startDate,
      }),
    );
    expect(wire(loan).principal).toBe('250000.75');
    expect(wire(loan).annualRate).toBe('9.5');

    const listed = await asUser(FINANCE, () => listLoans(new Date('2031-01-15T00:00:00Z')));
    const row = listed.find((l) => l.id === loan.id)!;
    expect(typeof row.principal).toBe('number');
    expect(row.principal).toBe(250000.75);

    const schedule = await asUser(FINANCE, () => loanSchedule(loan.id));
    expect(schedule).toEqual(
      amortisationSchedule({ principal: 250000.75, annualRate: 9.5, tenureMonths: 36, startDate }),
    );
  });

  it('a recurring rule posts its amount as a two-place transaction and keeps the trial balance', async () => {
    const TID = await tenantId();
    const category = await unscopedPrisma.ledgerCategory.findFirstOrThrow({
      where: { tenantId: TID, name: 'Local Conveyance' },
    });
    const account = await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TID, accountType: 'bank' },
    });
    const label = `S5 rule ${stamp()}`;
    await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TID,
        label,
        categoryId: category.id,
        accountId: account.id,
        direction: 'out',
        amountMinor: 123450n,
        cadence: 'monthly',
        dayOfMonth: 5,
        startDate: new Date(Date.UTC(2031, 0, 1)),
      },
    });

    const period = '2031-03';
    await asUser(FINANCE, () => generateRecurring(period));

    const txn = await unscopedPrisma.transaction.findFirstOrThrow({
      where: { tenantId: TID, note: label, source: 'recurring' },
    });
    expect(txn.amount.toFixed(2)).toBe('1234.50');
    expect(txn.direction).toBe('out');
    expect(monthKey(txn.txnDate)).toBe(period);

    assertTrialBalance(await asSystem(TID, () => journalTrialBalance(ALL_TIME)));
  });
});
