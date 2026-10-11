/**
 * Wave 2 (ORDERED-PLAN 0.6 neighbours): the books write paths leave an audit
 * row each, and a dated write into a closed accounting period is refused
 * before anything is written.
 *
 * Real Postgres, real contexts. Periods here are in 2017, far from the demo
 * dataset, and are closed by this file in beforeAll; the test files run one
 * after another (vitest.config fileParallelism: false), so no other file reads
 * them while they are closed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import {
  recordTransaction,
  reverseTransaction,
  recordVendorBill,
  payVendorBill,
  createAsset,
  createLoan,
  generateRecurring,
  detectOverdueBills,
  priceInvoiceGst,
} from '../domains/books.js';
import { createInvoice } from '../domains/invoicing.js';
import {
  requestClosePeriod,
  closePeriod,
  reopenPeriod,
  importBankStatement,
  matchBankLines,
  sweepRetention,
} from '../domains/compliance/books.js';

const CLOSED = '2017-10';
const OPEN_NEXT = '2017-11';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;
let ACCOUNT_ID: string;
let CATEGORY_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  const account = await unscopedPrisma.ledgerAccount.findFirstOrThrow({
    where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
  });
  ACCOUNT_ID = account.id;
  const category = await unscopedPrisma.ledgerCategory.findFirstOrThrow({ where: { tenantId: TENANT } });
  CATEGORY_ID = category.id;

  // The database outlives a run, so a second run finds the period already closed.
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
});

/** Every audit row this subject has, oldest first. */
async function auditRows(subjectType: string, subjectId: string) {
  return unscopedPrisma.auditRecord.findMany({
    where: { tenantId: TENANT, subjectType, subjectId },
    orderBy: { timestamp: 'asc' },
  });
}

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

// ===========================================================================
// Audit gaps
// ===========================================================================

describe('Audit — each books write leaves one audit row for the change it made', () => {
  it('a recorded transaction leaves exactly one create row, not two', async () => {
    const txn = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: new Date('2016-06-15T06:00:00Z'),
        direction: 'in',
        amount: 250,
        accountId: ACCOUNT_ID,
        categoryId: CATEGORY_ID,
        note: unique('audit once'),
        source: 'manual',
      }),
    );
    const rows = await auditRows('transaction', txn.id);
    expect(rows.filter((r) => r.action === 'create')).toHaveLength(1);
  });

  it('requesting the close of a period audits the period row it creates', async () => {
    const period = '2017-05';
    const existing = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period } });
    const row = existing ?? (await asUser(FINANCE, () => requestClosePeriod(period)));
    const rows = await auditRows('accounting_period', row.id);
    expect(rows.some((r) => r.action === 'create')).toBe(true);
  });

  it('a bank statement import audits every line it creates', async () => {
    const reference = unique('W2-IMPORT');
    await asUser(FINANCE, () =>
      importBankStatement(ACCOUNT_ID, [
        { date: new Date('2016-06-20T06:00:00Z'), amount: 1111.11, direction: 'in', reference },
      ]),
    );
    const line = await unscopedPrisma.bankStatementLine.findFirstOrThrow({ where: { tenantId: TENANT, reference } });
    const rows = await auditRows('bank_statement_line', line.id);
    expect(rows.filter((r) => r.action === 'create')).toHaveLength(1);
  });

  it('matching a bank line audits the ledger entry it reconciles', async () => {
    const reference = unique('W2-MATCH');
    const date = new Date('2016-06-21T06:00:00Z');
    const txn = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: date,
        direction: 'in',
        amount: 4321.07,
        accountId: ACCOUNT_ID,
        categoryId: CATEGORY_ID,
        reference,
        note: unique('match'),
        source: 'manual',
      }),
    );
    await asUser(FINANCE, () =>
      importBankStatement(ACCOUNT_ID, [{ date, amount: 4321.07, direction: 'in', reference }]),
    );
    await asUser(FINANCE, () => matchBankLines(ACCOUNT_ID));

    const rows = await auditRows('transaction', txn.id);
    expect(rows.some((r) => r.action === 'update')).toBe(true);
  });

  it('generating a recurring entry audits the rule it advances', async () => {
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label: unique('W2 audit probe'),
        categoryId: CATEGORY_ID,
        accountId: ACCOUNT_ID,
        direction: 'out',
        amount: 100,
        cadence: 'monthly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2016, 0, 1)),
      },
    });
    await asUser(FINANCE, () => generateRecurring('2016-03'));
    const rows = await auditRows('recurring_rule', rule.id);
    expect(rows.some((r) => r.action === 'update')).toBe(true);
  });

  it('flagging a bill as overdue audits the marker it sets', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('W2 overdue vendor'),
        billDate: new Date('2019-12-01T06:00:00Z'),
        dueDate: new Date('2020-01-01T06:00:00Z'),
        subtotal: 500,
      }),
    );
    await asUser(FINANCE, () => detectOverdueBills());
    const rows = await auditRows('vendor_bill', bill.id);
    expect(rows.some((r) => r.action === 'update')).toBe(true);
  });

  it('pricing a draft invoice audits the tax split it stores', async () => {
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });
    const draft = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: org.id,
        issue: false,
        lines: [{ description: unique('W2 priced draft'), unitPrice: 1000, gstRate: 18 }],
      }),
    );
    await asUser(FINANCE, () => priceInvoiceGst(draft.id, { interState: true }));
    const rows = await auditRows('invoice', draft.id);
    expect(rows.some((r) => r.action === 'update')).toBe(true);
  });

  it('a retention flag audits the review it creates', async () => {
    // Cancelled, so it is out of every balance; old, so the sweep flags it.
    const bill = await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-RET'),
        vendorName: unique('W2 retention vendor'),
        billDate: new Date('1990-01-15T06:00:00Z'),
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        status: 'cancelled',
      },
    });
    await asUser(CHAIRMAN, () => sweepRetention());
    const review = await unscopedPrisma.retentionReview.findFirstOrThrow({
      where: { tenantId: TENANT, entityType: 'vendor_bill', entityId: bill.id },
    });
    const rows = await auditRows('retention_review', review.id);
    expect(rows.filter((r) => r.action === 'create')).toHaveLength(1);
  });
});

// ===========================================================================
// Closed accounting periods veto dated writes
// ===========================================================================

describe('Closed period — a dated write inside it is refused and writes nothing', () => {
  it('a vendor bill dated in the closed period is refused, and no bill is created', async () => {
    const vendorName = unique('W2 closed bill');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordVendorBill({ vendorName, billDate: new Date('2017-10-15T06:00:00Z'), subtotal: 100 }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.vendorBill.count({ where: { tenantId: TENANT, vendorName } })).toBe(0);
  });

  it('a fixed asset with a ledger purchase in the closed period is refused, and the asset is not created', async () => {
    const name = unique('W2 closed asset');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        createAsset({
          name,
          purchaseDate: new Date('2017-10-15T06:00:00Z'),
          cost: 1000,
          usefulLifeMonths: 60,
          accountId: ACCOUNT_ID,
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.fixedAsset.count({ where: { tenantId: TENANT, name } })).toBe(0);
  });

  it('a fixed asset with no ledger purchase, dated in the closed period, is refused too', async () => {
    const name = unique('W2 closed asset, no account');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        createAsset({ name, purchaseDate: new Date('2017-10-15T06:00:00Z'), cost: 1000, usefulLifeMonths: 60 }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.fixedAsset.count({ where: { tenantId: TENANT, name } })).toBe(0);
  });

  it('a loan starting in the closed period is refused, and the loan is not created', async () => {
    const lender = unique('W2 closed lender');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        createLoan({
          lender,
          principal: 100000,
          annualRate: 9,
          tenureMonths: 12,
          startDate: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.loan.count({ where: { tenantId: TENANT, lender } })).toBe(0);
  });

  it('paying a bill on a date inside the closed period is refused, and the bill does not move', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('W2 pay vendor'),
        billDate: new Date('2016-06-01T06:00:00Z'),
        subtotal: 300,
      }),
    );
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        payVendorBill(bill.id, { amount: 100, accountId: ACCOUNT_ID, paidOn: new Date('2017-10-15T06:00:00Z') }),
      ),
    );
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.status).toBe('open');
    expect(Number(after.paidAmount)).toBe(0);
  });

  it('generating recurring entries for a closed period writes no entry and marks no rule as generated', async () => {
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label: unique('W2 closed recurring'),
        categoryId: CATEGORY_ID,
        accountId: ACCOUNT_ID,
        direction: 'out',
        amount: 100,
        cadence: 'monthly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2017, 0, 1)),
      },
    });
    const err = await expectReject(() => asUser(FINANCE, () => generateRecurring(CLOSED)));
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.lastGeneratedPeriod).toBeNull();
  });

  it('reversing an entry is refused while today falls in a closed period, and nothing is reversed', async () => {
    const original = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: new Date('2016-06-10T06:00:00Z'),
        direction: 'in',
        amount: 75,
        accountId: ACCOUNT_ID,
        categoryId: CATEGORY_ID,
        note: unique('reverse-in-closed'),
        source: 'manual',
      }),
    );
    // A reversal is stamped now, so the period it lands in is the current IST
    // month. Close that month for the probe and reopen it after; faking the
    // clock instead trips the grant validity check before the period check.
    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const err = await expectReject(() => asUser(FINANCE, () => reverseTransaction(original.id, 'W2 probe')));
      expect(err.status).toBe(422);
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
    const after = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: original.id } });
    expect(after.reversedById).toBeNull();
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, reversalOfId: original.id } })).toBe(0);
  });
});

// ===========================================================================
// IST boundary — the period is the IST civil month, not the UTC one
// ===========================================================================

describe('Closed period — the IST boundary decides which month a write is in', () => {
  it('00:30 IST on 1 October is in the closed October, so a bill dated then is refused', async () => {
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordVendorBill({
          vendorName: unique('W2 ist refused'),
          billDate: new Date('2017-10-01T00:30:00+05:30'),
          subtotal: 100,
        }),
      ),
    );
    expect(err.status).toBe(422);
  });

  it('00:30 IST on 1 November is in the open November, so a bill dated then is not refused', async () => {
    // 2017-10-31T19:00Z: a UTC month would still say October and refuse it.
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('W2 ist accepted'),
        billDate: new Date(`${OPEN_NEXT}-01T00:30:00+05:30`),
        subtotal: 100,
      }),
    );
    expect(bill.billDate.toISOString()).toBe('2017-10-31T19:00:00.000Z');
  });

  it('23:30 IST on 31 October is refused, and 00:30 IST on 1 November is not, for a ledger entry', async () => {
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordTransaction({
          txnDate: new Date('2017-10-31T23:30:00+05:30'),
          direction: 'out',
          amount: 10,
          accountId: ACCOUNT_ID,
          categoryId: CATEGORY_ID,
          note: unique('ist ledger refused'),
          source: 'manual',
        }),
      ),
    );
    expect(err.status).toBe(422);

    const txn = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: new Date('2017-11-01T00:30:00+05:30'),
        direction: 'out',
        amount: 10,
        accountId: ACCOUNT_ID,
        categoryId: CATEGORY_ID,
        note: unique('ist ledger accepted'),
        source: 'manual',
      }),
    );
    expect(txn.txnDate.toISOString()).toBe('2017-10-31T19:00:00.000Z');
  });
});

// ===========================================================================
// Recurring cadence counts months in IST
// ===========================================================================

describe('Recurring cadence — months since start are counted in IST', () => {
  it('a quarterly rule starting in January fires in January, not a month late', async () => {
    // The first instant of January IST is 31 Dec 18:30 UTC, which reads as
    // December. Counted in UTC, the rule is eleven months from its start: it
    // skips its own first period and fires in February instead.
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label: unique('W2 quarterly jan'),
        categoryId: CATEGORY_ID,
        accountId: ACCOUNT_ID,
        direction: 'out',
        amount: 100,
        cadence: 'quarterly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2016, 0, 1)),
      },
    });
    await asUser(FINANCE, () => generateRecurring('2016-01'));
    const after = await unscopedPrisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.lastGeneratedPeriod).toBe('2016-01');
  });
});
