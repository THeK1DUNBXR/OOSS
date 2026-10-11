/**
 * Every books write emits its event, in the chain, with the subject it changed.
 *
 * Asserted on EventRecord rows, which are written in the same transaction as
 * the event's outbox row (platform/eventBus.ts), so a row here is an event that
 * committed. Names are the canonical kz.fin.<object>.<verb> grammar.
 *
 * Periods are closed here as in the other period suites; the closed period is
 * reopened and closed again inside the reopen probe so the rest of the run finds
 * it as it was.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import {
  createAccount,
  createCategory,
  recordVendorBill,
  payVendorBill,
  createAsset,
  createLoan,
  setBudgetLine,
  priceInvoiceGst,
  generateRecurring,
  detectOverdueBills,
  recordTransaction,
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
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;
let ACCOUNT_ID: string;
let CATEGORY_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  ACCOUNT_ID = (
    await unscopedPrisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: TENANT, accountType: 'bank', deletedAt: null },
    })
  ).id;
  CATEGORY_ID = (await unscopedPrisma.ledgerCategory.findFirstOrThrow({ where: { tenantId: TENANT } })).id;
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

/** The events of one name about one subject, in chain order. */
async function eventsFor(eventName: string, subjectEntityId: string) {
  return unscopedPrisma.eventRecord.findMany({
    where: { tenantId: TENANT, eventName, subjectEntityId },
    orderBy: { seq: 'asc' },
  });
}

describe('Books writes emit their event', () => {
  it('a ledger account created emits kz.fin.ledger_account.created', async () => {
    const account = await asUser(FINANCE, () => createAccount({ name: unique('W2 event account') }));
    expect(await eventsFor('kz.fin.ledger_account.created', account.id)).toHaveLength(1);
  });

  it('a ledger category created emits kz.fin.ledger_category.created', async () => {
    const category = await asUser(FINANCE, () =>
      createCategory({ name: unique('W2 event category'), kind: 'expense' }),
    );
    expect(await eventsFor('kz.fin.ledger_category.created', category.id)).toHaveLength(1);
  });

  it('a vendor bill paid emits kz.fin.vendor_bill.paid', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('W2 event vendor'),
        billDate: new Date('2016-06-01T06:00:00Z'),
        subtotal: 200,
      }),
    );
    await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 50, accountId: ACCOUNT_ID, paidOn: new Date('2016-06-02T06:00:00Z') }),
    );
    expect(await eventsFor('kz.fin.vendor_bill.paid', bill.id)).toHaveLength(1);
  });

  it('an overdue vendor bill flagged emits kz.fin.vendor_bill.overdue_flagged', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('W2 event overdue'),
        billDate: new Date('2019-12-01T06:00:00Z'),
        dueDate: new Date('2020-01-01T06:00:00Z'),
        subtotal: 500,
      }),
    );
    await asUser(FINANCE, () => detectOverdueBills());
    expect(await eventsFor('kz.fin.vendor_bill.overdue_flagged', bill.id)).toHaveLength(1);
  });

  it('a fixed asset created emits kz.fin.fixed_asset.recorded', async () => {
    const asset = await asUser(FINANCE, () =>
      createAsset({
        name: unique('W2 event asset'),
        purchaseDate: new Date('2016-06-05T06:00:00Z'),
        cost: 1000,
        usefulLifeMonths: 60,
      }),
    );
    expect(await eventsFor('kz.fin.fixed_asset.recorded', asset.id)).toHaveLength(1);
  });

  it('a loan created emits kz.fin.loan.recorded', async () => {
    const loan = await asUser(FINANCE, () =>
      createLoan({
        lender: unique('W2 event lender'),
        principal: 10000,
        annualRate: 9,
        tenureMonths: 12,
        startDate: new Date('2016-06-05T06:00:00Z'),
      }),
    );
    expect(await eventsFor('kz.fin.loan.recorded', loan.id)).toHaveLength(1);
  });

  it('a budget line set emits kz.fin.budget_line.set', async () => {
    const line = await asUser(FINANCE, () =>
      setBudgetLine({ period: '2016-06', categoryId: CATEGORY_ID, division: null, amount: 1000 }),
    );
    expect(await eventsFor('kz.fin.budget_line.set', line.id)).toHaveLength(1);
  });

  it('a draft invoice priced for GST emits kz.fin.invoice.tax_priced', async () => {
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });
    const draft = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: org.id,
        issue: false,
        lines: [{ description: unique('W2 event draft'), unitPrice: 1000, gstRate: 18 }],
      }),
    );
    await asUser(FINANCE, () => priceInvoiceGst(draft.id, { interState: false }));
    expect(await eventsFor('kz.fin.invoice.tax_priced', draft.id)).toHaveLength(1);
  });

  it('a recurring rule generating its entry emits kz.fin.recurring.generated', async () => {
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label: unique('W2 event rule'),
        categoryId: CATEGORY_ID,
        accountId: ACCOUNT_ID,
        direction: 'out',
        amount: 100,
        cadence: 'monthly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2016, 0, 1)),
      },
    });
    await asUser(FINANCE, () => generateRecurring('2016-05'));
    expect(await eventsFor('kz.fin.recurring.generated', rule.id)).toHaveLength(1);
  });

  it('a period requested for close emits kz.fin.accounting_period.close_requested', async () => {
    const period = '2016-08';
    const existing = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period } });
    const row = existing ?? (await asUser(FINANCE, () => requestClosePeriod(period)));
    expect((await eventsFor('kz.fin.accounting_period.opened', row.id)).length).toBeGreaterThanOrEqual(1);
    expect((await eventsFor('kz.fin.accounting_period.close_requested', row.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('a period closed and reopened emit kz.fin.accounting_period.closed and .reopened', async () => {
    const row = await unscopedPrisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: TENANT, period: CLOSED } });
    await asUser(CHAIRMAN, () => reopenPeriod(CLOSED, 'W2 event probe; closing again straight away'));
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
    expect((await eventsFor('kz.fin.accounting_period.reopened', row.id)).length).toBeGreaterThanOrEqual(1);
    expect((await eventsFor('kz.fin.accounting_period.closed', row.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('a bank statement imported emits kz.fin.bank_statement.imported on the account', async () => {
    await asUser(FINANCE, () =>
      importBankStatement(ACCOUNT_ID, [
        { date: new Date('2016-06-20T06:00:00Z'), amount: 77.5, direction: 'in', reference: unique('W2 event line') },
      ]),
    );
    expect((await eventsFor('kz.fin.bank_statement.imported', ACCOUNT_ID)).length).toBeGreaterThanOrEqual(1);
  });

  it('a bank line matched emits kz.fin.bank_statement_line.matched and the entry emits kz.fin.transaction.reconciled', async () => {
    const reference = unique('W2 event match');
    const date = new Date('2016-06-21T06:00:00Z');
    const txn = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: date,
        direction: 'in',
        amount: 8765.43,
        accountId: ACCOUNT_ID,
        categoryId: CATEGORY_ID,
        reference,
        note: unique('event match'),
        source: 'manual',
      }),
    );
    await asUser(FINANCE, () =>
      importBankStatement(ACCOUNT_ID, [{ date, amount: 8765.43, direction: 'in', reference }]),
    );
    await asUser(FINANCE, () => matchBankLines(ACCOUNT_ID));
    const line = await unscopedPrisma.bankStatementLine.findFirstOrThrow({ where: { tenantId: TENANT, reference } });
    expect(await eventsFor('kz.fin.bank_statement_line.matched', line.id)).toHaveLength(1);
    expect(await eventsFor('kz.fin.transaction.reconciled', txn.id)).toHaveLength(1);
  });

  it('a retention review flagged emits kz.fin.retention_review.recorded', async () => {
    const bill = await unscopedPrisma.vendorBill.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-EVT-RET'),
        vendorName: unique('W2 event retention'),
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
    expect(await eventsFor('kz.fin.retention_review.recorded', review.id)).toHaveLength(1);
  });
});
