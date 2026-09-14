/**
 * The books (Canon §15).
 *
 * Invoices and receipts answered what the company is owed. This answers what
 * it spent, on what, in which division, and whether that was the plan — which
 * is the question the founder's own ledger was built around and the one the
 * platform could not answer.
 *
 * Two rules shape the file:
 *
 * A mistake is reversed, never edited away. `reverseTransaction` writes a
 * second row pointing at the first, so the history keeps showing what actually
 * happened and a reconciled bank line still matches something.
 *
 * Actuals are summed from transactions at read time, never stored beside the
 * budget. A late entry then moves the variance, instead of leaving a figure
 * that was true on the day it was written.
 */

import {
  EVENTS,
  computeGst,
  round2,
  monthKey,
  monthRange,
  monthsBack,
  depreciationSchedule,
  amortisationSchedule,
  bookValueAt,
  loanBalanceAt,
  runwayMonths,
  isTrading,
  type Division,
  type GstLineInput,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, canSeeMoney, assertScopeAll } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';

/**
 * True when `candidateTenantId` is somewhere in the caller's own group —
 * parent, sibling (shares a parent), or child — walked structurally on
 * `Tenant.parentTenantId` the same way `equity.ts`'s `assertNotHoldingsAncestor`
 * does (equity-portal plan §6 phase 2 item A). The one place in this file the
 * unscoped tenant table is read, because the question is about the shape of
 * the tenant graph, never about a row this tenant owns.
 */
async function isInSameGroup(tenantId: string, candidateTenantId: string): Promise<boolean> {
  if (tenantId === candidateTenantId) return false; // a transaction cannot be intercompany with itself
  const [self, candidate] = await Promise.all([
    unscopedPrisma.tenant.findFirst({ where: { id: tenantId }, select: { id: true, parentTenantId: true } }),
    unscopedPrisma.tenant.findFirst({ where: { id: candidateTenantId }, select: { id: true, parentTenantId: true } }),
  ]);
  if (!self || !candidate) return false;
  // Parent, or child.
  if (candidate.id === self.parentTenantId || self.id === candidate.parentTenantId) return true;
  // Sibling — the same parent, when either has one.
  if (self.parentTenantId && self.parentTenantId === candidate.parentTenantId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Accounts and categories
// ---------------------------------------------------------------------------

export async function listAccounts() {
  const auth = currentAuth();
  await assertCan({ resource: 'ledger_accounts', verb: 'view' });
  return prisma.ledgerAccount.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
}

export async function createAccount(input: {
  name: string;
  accountType?: string;
  displayReference?: string | null;
  openingBalance?: number;
  openingDate?: Date | null;
  ledgerGroup?: string;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'ledger_accounts', verb: 'create' });
  return prisma.ledgerAccount.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      accountType: input.accountType ?? 'bank',
      displayReference: input.displayReference ?? null,
      openingBalance: input.openingBalance ?? 0,
      openingDate: input.openingDate ?? null,
      ledgerGroup: input.ledgerGroup ?? (input.accountType === 'loan' ? 'liability' : 'asset'),
    },
  });
}

export async function listCategories() {
  const auth = currentAuth();
  await assertCan({ resource: 'categories', verb: 'view' });
  return prisma.ledgerCategory.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
}

export async function createCategory(input: {
  name: string;
  kind?: string;
  behaviour?: string;
  parentId?: string | null;
  defaultDivision?: string | null;
  mustPay?: boolean;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'categories', verb: 'create' });
  return prisma.ledgerCategory.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      kind: input.kind ?? 'expense',
      behaviour: input.behaviour ?? 'variable',
      parentId: input.parentId ?? null,
      defaultDivision: input.defaultDivision ?? null,
      mustPay: input.mustPay ?? false,
    },
  });
}

/**
 * What is actually in each account: the opening balance plus every movement
 * since. Summed rather than kept as a running column, so a corrected or
 * back-dated entry is reflected immediately.
 */
export async function accountBalances(asOf = new Date()) {
  const auth = currentAuth();
  await assertScopeAll('ledger_accounts');

  const accounts = await prisma.ledgerAccount.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, active: true },
    orderBy: { name: 'asc' },
  });

  const movements = await prisma.transaction.groupBy({
    by: ['accountId', 'direction'],
    where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { lte: asOf } },
    _sum: { amount: true },
  });

  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const row of movements) {
    const target = row.direction === 'in' ? inflow : outflow;
    target.set(row.accountId, num(row._sum.amount) ?? 0);
  }

  return accounts.map((a) => {
    const opening = num(a.openingBalance) ?? 0;
    const inn = inflow.get(a.id) ?? 0;
    const out = outflow.get(a.id) ?? 0;
    return {
      id: a.id,
      name: a.name,
      accountType: a.accountType,
      ledgerGroup: a.ledgerGroup,
      displayReference: a.displayReference,
      opening,
      inflow: inn,
      outflow: out,
      balance: round2(opening + inn - out),
    };
  });
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface TransactionInput {
  txnDate: Date;
  direction: 'in' | 'out';
  amount: number;
  accountId: string;
  categoryId?: string | null;
  division?: string | null;
  counterparty?: string | null;
  method?: string;
  reference?: string | null;
  note?: string | null;
  source?: string;
  payrollRunId?: string | null;
  invoiceId?: string | null;
  vendorBillId?: string | null;
  fixedAssetId?: string | null;
  loanId?: string | null;
  /** Set when the counterparty IS another group entity (equity-portal plan §6, phase 2). */
  intercompanyTenantId?: string | null;
}

/**
 * The parent, siblings and children of the caller's own tenant — the
 * choices for the "Group entity counterparty" picker on a transaction.
 * Structural only (name/slug), read the same way `isInSameGroup` reads it;
 * never a figure from another tenant's own books.
 */
export async function groupCounterpartyOptions(): Promise<Array<{ tenantId: string; slug: string; name: string }>> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });

  const self = await unscopedPrisma.tenant.findFirst({ where: { id: auth.tenantId }, select: { parentTenantId: true } });
  const parentId = self?.parentTenantId ?? null;

  const [parent, siblings, children] = await Promise.all([
    parentId
      ? unscopedPrisma.tenant.findFirst({ where: { id: parentId }, select: { id: true, slug: true, name: true } })
      : Promise.resolve(null),
    parentId
      ? unscopedPrisma.tenant.findMany({ where: { parentTenantId: parentId, id: { not: auth.tenantId } }, select: { id: true, slug: true, name: true } })
      : Promise.resolve([]),
    unscopedPrisma.tenant.findMany({ where: { parentTenantId: auth.tenantId }, select: { id: true, slug: true, name: true } }),
  ]);

  const out: Array<{ tenantId: string; slug: string; name: string }> = [];
  if (parent) out.push({ tenantId: parent.id, slug: parent.slug, name: parent.name });
  for (const s of siblings) out.push({ tenantId: s.id, slug: s.slug, name: s.name });
  for (const c of children) out.push({ tenantId: c.id, slug: c.slug, name: c.name });
  return out;
}

export async function recordTransaction(input: TransactionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });

  if (input.amount <= 0) {
    // The direction carries the sign, so a negative amount would be a second,
    // contradictory way of saying the same thing.
    throw ApiError.unprocessable('An amount is always positive — `direction` says which way the money went.');
  }

  const account = await prisma.ledgerAccount.findFirst({
    where: { id: input.accountId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!account) throw ApiError.notFound('Account');

  // The category's usual division applies unless the entry says otherwise: a
  // shared cost split across divisions is a judgement made at the time and
  // cannot be recovered from the category afterwards.
  let division = input.division ?? null;
  if (!division && input.categoryId) {
    const category = await prisma.ledgerCategory.findFirst({
      where: { id: input.categoryId, tenantId: auth.tenantId },
    });
    division = category?.defaultDivision ?? null;
  }

  if (input.intercompanyTenantId && !(await isInSameGroup(auth.tenantId, input.intercompanyTenantId))) {
    throw ApiError.unprocessable(
      'An inter-company counterparty must be another entity in this group — the holding, a sibling subsidiary, or a child.',
    );
  }

  const recordCode = await nextRecordCode('TXN');
  const txn = await prisma.transaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      txnDate: input.txnDate,
      direction: input.direction,
      amount: input.amount,
      accountId: input.accountId,
      categoryId: input.categoryId ?? null,
      division,
      counterparty: input.counterparty ?? null,
      method: input.method ?? 'bank_transfer',
      reference: input.reference ?? null,
      note: input.note ?? null,
      source: input.source ?? 'manual',
      payrollRunId: input.payrollRunId ?? null,
      invoiceId: input.invoiceId ?? null,
      vendorBillId: input.vendorBillId ?? null,
      fixedAssetId: input.fixedAssetId ?? null,
      loanId: input.loanId ?? null,
      intercompanyTenantId: input.intercompanyTenantId ?? null,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.TRANSACTION_RECORDED,
    subject: { entityType: 'transaction', entityId: txn.id, recordCode },
    newState: {
      direction: input.direction,
      amount: input.amount,
      division,
      categoryId: input.categoryId,
      source: txn.source,
    },
    confidentiality: 'confidential',
    impact: { domains: ['fin'] },
  });

  return txn;
}

/**
 * Reverses an entry with a second entry.
 *
 * Nothing is quietly deleted: the original stays, the reversal points at it,
 * and both stay visible. That is what keeps a reconciled bank line matched to
 * something and what stops a ledger silently disagreeing with a statement.
 */
export async function reverseTransaction(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'edit' });

  const original = await prisma.transaction.findFirst({
    where: { id, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!original) throw ApiError.notFound('Transaction');
  if (original.reversedById) {
    throw ApiError.conflict('This entry has already been reversed.', { reversalId: original.reversedById });
  }
  if (original.reversalOfId) {
    throw ApiError.unprocessable('This entry is itself a reversal. Reversing it would restore the original error.');
  }

  const recordCode = await nextRecordCode('TXN');

  const reversal = await prisma.$transaction(async (tx) => {
    const created = await tx.transaction.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        txnDate: new Date(),
        direction: original.direction === 'in' ? 'out' : 'in',
        amount: original.amount,
        accountId: original.accountId,
        categoryId: original.categoryId,
        division: original.division,
        counterparty: original.counterparty,
        method: original.method,
        reference: original.reference,
        note: `Reversal of ${original.recordCode}: ${reason}`,
        source: original.source,
        reversalOfId: original.id,
        createdById: auth.partyId,
      },
    });
    await tx.transaction.update({ where: { id: original.id }, data: { reversedById: created.id } });
    return created;
  });

  await emit({
    name: EVENTS.TRANSACTION_REVERSED,
    subject: { entityType: 'transaction', entityId: reversal.id, recordCode },
    related: [{ relation: 'reverses', entityType: 'transaction', entityId: original.id }],
    previousState: { recordCode: original.recordCode },
    newState: { amount: num(original.amount), direction: reversal.direction },
    reason: { reasonCode: 'reversal', note: reason },
    confidentiality: 'confidential',
    impact: { domains: ['fin'], severity: 'S1_ATTENTION' },
  });

  return reversal;
}

export async function listTransactions(filter: {
  from?: Date;
  to?: Date;
  categoryId?: string;
  division?: string;
  accountId?: string;
  source?: string;
  take?: number;
} = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });

  return prisma.transaction.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.from || filter.to
        ? { txnDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } }
        : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.division ? { division: filter.division } : {}),
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
      ...(filter.source ? { source: filter.source } : {}),
    },
    include: { category: { select: { name: true, kind: true } }, account: { select: { name: true } } },
    orderBy: [{ txnDate: 'desc' }, { createdAt: 'desc' }],
    take: filter.take ?? 300,
  });
}

// ---------------------------------------------------------------------------
// Vendor bills — the other half of receivables
// ---------------------------------------------------------------------------

export async function listVendorBills(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'vendor_bills', verb: 'view' });
  return prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ dueDate: 'asc' }, { billDate: 'desc' }],
    take: 300,
  });
}

export async function recordVendorBill(input: {
  vendorName: string;
  vendorGstin?: string | null;
  billNumber?: string | null;
  billDate: Date;
  dueDate?: Date | null;
  categoryId?: string | null;
  division?: string | null;
  subtotal: number;
  taxAmount?: number;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'vendor_bills', verb: 'create' });

  const taxAmount = input.taxAmount ?? 0;
  const total = round2(input.subtotal + taxAmount);
  const recordCode = await nextRecordCode('BILL');

  const bill = await prisma.vendorBill.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      vendorName: input.vendorName,
      vendorGstin: input.vendorGstin ?? null,
      billNumber: input.billNumber ?? null,
      billDate: input.billDate,
      dueDate: input.dueDate ?? null,
      categoryId: input.categoryId ?? null,
      division: input.division ?? null,
      subtotal: input.subtotal,
      taxAmount,
      total,
      note: input.note ?? null,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.VENDOR_BILL_RECORDED,
    subject: { entityType: 'vendor_bill', entityId: bill.id, recordCode },
    newState: { vendorName: input.vendorName, total, dueDate: input.dueDate },
    confidentiality: 'confidential',
    impact: { domains: ['fin'] },
  });

  return bill;
}

/**
 * Pays a bill, in full or in part.
 *
 * The payment is a ledger transaction like any other — bills do not have their
 * own private notion of money — and the bill's status follows from what has
 * been paid rather than being set independently.
 */
export async function payVendorBill(id: string, input: { amount: number; accountId: string; paidOn: Date; reference?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'vendor_bills', verb: 'edit' });

  const bill = await prisma.vendorBill.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!bill) throw ApiError.notFound('Vendor bill');
  if (bill.status === 'cancelled') throw ApiError.unprocessable('This bill was cancelled.');

  const outstanding = round2((num(bill.total) ?? 0) - (num(bill.paidAmount) ?? 0));
  if (input.amount > outstanding + 0.005) {
    throw ApiError.unprocessable(
      `That is more than is outstanding on ${bill.recordCode} (₹${outstanding.toFixed(2)}). ` +
        'An overpayment needs a credit note rather than a larger payment.',
    );
  }

  const txn = await recordTransaction({
    txnDate: input.paidOn,
    direction: 'out',
    amount: input.amount,
    accountId: input.accountId,
    categoryId: bill.categoryId,
    division: bill.division,
    counterparty: bill.vendorName,
    reference: input.reference ?? bill.billNumber,
    note: `Payment against ${bill.recordCode}`,
    source: 'vendor_bill',
    vendorBillId: bill.id,
  });

  const paid = round2((num(bill.paidAmount) ?? 0) + input.amount);
  const status = paid >= (num(bill.total) ?? 0) - 0.005 ? 'paid' : 'part_paid';

  const updated = await prisma.vendorBill.update({
    where: { id },
    data: { paidAmount: paid, status },
  });

  return { bill: updated, transaction: txn };
}

/** Supplier ageing — what is overdue and by how long. */
export async function payablesAgeing(asOf = new Date()) {
  const auth = currentAuth();
  await assertScopeAll('vendor_bills');

  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['open', 'part_paid'] } },
  });

  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
  let total = 0;

  for (const bill of bills) {
    const outstanding = round2((num(bill.total) ?? 0) - (num(bill.paidAmount) ?? 0));
    if (outstanding <= 0) continue;
    total = round2(total + outstanding);

    if (!bill.dueDate || bill.dueDate >= asOf) {
      buckets.current = round2(buckets.current + outstanding);
      continue;
    }
    const days = Math.floor((asOf.getTime() - bill.dueDate.getTime()) / 86_400_000);
    if (days <= 30) buckets.d30 = round2(buckets.d30 + outstanding);
    else if (days <= 60) buckets.d60 = round2(buckets.d60 + outstanding);
    else if (days <= 90) buckets.d90 = round2(buckets.d90 + outstanding);
    else buckets.older = round2(buckets.older + outstanding);
  }

  return { total, buckets, count: bills.length };
}

/** A bill past its due date is chased once, not on every hourly tick. */
export async function detectOverdueBills(): Promise<number> {
  const auth = currentAuth();
  const overdue = await prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['open', 'part_paid'] },
      dueDate: { lt: new Date() },
      overdueNotifiedAt: null,
    },
    take: 200,
  });

  for (const bill of overdue) {
    const outstanding = round2((num(bill.total) ?? 0) - (num(bill.paidAmount) ?? 0));
    await raiseException({
      code: 'EX-FIN-002',
      label: 'Supplier bill overdue',
      severity: 'S2_WARNING',
      subjectType: 'vendor_bill',
      subjectId: bill.id,
      subjectLabel: `${bill.recordCode} — ${bill.vendorName}`,
      detail: `₹${outstanding.toFixed(2)} outstanding, due ${bill.dueDate?.toISOString().slice(0, 10)}.`,
      triggerFingerprint: `bill_overdue:${bill.id}`,
      ladderRung: 1,
    });
    await prisma.vendorBill.update({ where: { id: bill.id }, data: { overdueNotifiedAt: new Date() } });
  }

  return overdue.length;
}

// ---------------------------------------------------------------------------
// GST on an invoice
// ---------------------------------------------------------------------------

/**
 * Prices an invoice's tax from its lines and stores the split.
 *
 * Stored rather than computed at render time because the invoice was raised
 * under one reading of the place of supply, and reprinting it must not
 * silently restate the tax if that reading later changes.
 */
export async function priceInvoiceGst(
  invoiceId: string,
  input: { interState: boolean; placeOfSupply?: string | null; customerGstin?: string | null; division?: string | null },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'edit' });

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: auth.tenantId, deletedAt: null },
    include: { lines: true },
  });
  if (!invoice) throw ApiError.notFound('Invoice');
  if (invoice.status !== 'draft') {
    throw ApiError.unprocessable(
      `Invoice ${invoice.recordCode ?? invoice.draftReference ?? 'draft'} is ${invoice.status}. Tax is fixed once an invoice is issued — ` +
        'a correction is a credit note.',
    );
  }

  const lines: GstLineInput[] = invoice.lines.map((l) => ({
    taxableValue: num(l.amount) ?? 0,
    gstRate: num(l.gstRate) ?? 0,
  }));
  const gst = computeGst(lines, input.interState);

  const updated = await prisma.$transaction(async (tx) => {
    for (const line of invoice.lines) {
      const value = num(line.amount) ?? 0;
      const rate = num(line.gstRate) ?? 0;
      await tx.invoiceLine.update({
        where: { id: line.id },
        data: { taxAmount: round2((value * rate) / 100) },
      });
    }
    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        interState: input.interState,
        placeOfSupply: input.placeOfSupply ?? null,
        customerGstin: input.customerGstin ?? null,
        division: input.division ?? invoice.division,
        taxableValue: gst.taxableValue,
        cgstAmount: gst.cgst,
        sgstAmount: gst.sgst,
        igstAmount: gst.igst,
        roundOff: gst.roundOff,
        grandTotal: gst.grandTotal,
      },
    });
  });

  return { invoice: updated, gst };
}

/** The GST summary a return is prepared from. */
export async function gstSummary(period: string) {
  const auth = currentAuth();
  await assertScopeAll('transactions');
  const { from, to } = monthRange(period);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { not: 'draft' },
      issuedDate: { gte: from, lt: to },
    },
  });

  // Input tax paid to suppliers, which is what makes the net liability the
  // figure that is actually remitted rather than the gross collected.
  const bills = await prisma.vendorBill.aggregate({
    where: { tenantId: auth.tenantId, deletedAt: null, billDate: { gte: from, lt: to } },
    _sum: { taxAmount: true },
  });

  const output = invoices.reduce(
    (acc, i) => ({
      taxable: round2(acc.taxable + (num(i.taxableValue) ?? 0)),
      cgst: round2(acc.cgst + (num(i.cgstAmount) ?? 0)),
      sgst: round2(acc.sgst + (num(i.sgstAmount) ?? 0)),
      igst: round2(acc.igst + (num(i.igstAmount) ?? 0)),
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  );

  const outputTax = round2(output.cgst + output.sgst + output.igst);
  const inputTax = num(bills._sum.taxAmount) ?? 0;

  return {
    period,
    invoiceCount: invoices.length,
    ...output,
    outputTax,
    inputTax,
    netPayable: round2(outputTax - inputTax),
  };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export async function setBudgetLine(input: {
  period: string;
  categoryId: string;
  division?: string | null;
  amount: number;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'budgets', verb: 'create' });

  return prisma.budgetLine.upsert({
    where: {
      tenantId_period_categoryId_division: {
        tenantId: auth.tenantId,
        period: input.period,
        categoryId: input.categoryId,
        division: input.division ?? '',
      },
    },
    create: {
      tenantId: auth.tenantId,
      period: input.period,
      categoryId: input.categoryId,
      division: input.division ?? '',
      amount: input.amount,
      note: input.note ?? null,
    },
    update: { amount: input.amount, note: input.note ?? null },
  });
}

/**
 * Budget against actual for a period.
 *
 * The actual is summed from transactions on every read rather than kept beside
 * the budget, so an entry made late moves the variance instead of leaving a
 * number that was true on the day somebody wrote it.
 */
export async function budgetVariance(period: string) {
  const auth = currentAuth();
  await assertScopeAll('budgets');
  const { from, to } = monthRange(period);

  const [lines, actuals, categories] = await Promise.all([
    prisma.budgetLine.findMany({ where: { tenantId: auth.tenantId, period }, include: { category: true } }),
    prisma.transaction.groupBy({
      by: ['categoryId', 'division'],
      where: { tenantId: auth.tenantId, deletedAt: null, direction: 'out', txnDate: { gte: from, lt: to } },
      _sum: { amount: true },
    }),
    prisma.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
  ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const actualBy = new Map<string, number>();
  for (const row of actuals) {
    const key = `${row.categoryId ?? ''}|${row.division ?? ''}`;
    actualBy.set(key, round2((actualBy.get(key) ?? 0) + (num(row._sum.amount) ?? 0)));
  }

  const rows = lines.map((line) => {
    const key = `${line.categoryId}|${line.division ?? ''}`;
    const budget = num(line.amount) ?? 0;
    const actual = actualBy.get(key) ?? 0;
    actualBy.delete(key);
    return {
      categoryId: line.categoryId,
      categoryName: line.category.name,
      division: line.division || null,
      budget,
      actual,
      variance: round2(budget - actual),
      overspent: actual > budget,
    };
  });

  // Spending under a category nobody budgeted is the interesting case, so it
  // is listed rather than dropped: a zero budget with an actual against it.
  for (const [key, actual] of actualBy) {
    const [categoryId, division] = key.split('|');
    if (!categoryId) continue;
    rows.push({
      categoryId,
      categoryName: categoryName.get(categoryId) ?? 'Uncategorised',
      division: division || null,
      budget: 0,
      actual,
      variance: round2(-actual),
      overspent: true,
    });
  }

  const budgetTotal = rows.reduce((s, r) => round2(s + r.budget), 0);
  const actualTotal = rows.reduce((s, r) => round2(s + r.actual), 0);

  return {
    period,
    rows: rows.sort((a, b) => a.variance - b.variance),
    budgetTotal,
    actualTotal,
    variance: round2(budgetTotal - actualTotal),
  };
}

// ---------------------------------------------------------------------------
// Assets and loans
// ---------------------------------------------------------------------------

export async function listAssets(asOf = new Date()) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'view' });

  const assets = await prisma.fixedAsset.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: { purchaseDate: 'desc' },
  });

  return assets.map((a) => {
    const input = {
      cost: num(a.cost) ?? 0,
      salvageValue: num(a.salvageValue) ?? 0,
      usefulLifeMonths: a.usefulLifeMonths,
      purchaseDate: a.purchaseDate,
      method: a.method as 'straight_line' | 'wdv',
      wdvRate: num(a.wdvRate) ?? 0,
    };
    return {
      id: a.id,
      recordCode: a.recordCode,
      name: a.name,
      purchaseDate: a.purchaseDate,
      cost: input.cost,
      method: a.method,
      division: a.division,
      disposedAt: a.disposedAt,
      bookValue: a.disposedAt ? 0 : bookValueAt(input, asOf),
      accumulatedDepreciation: a.disposedAt ? input.cost : round2(input.cost - bookValueAt(input, asOf)),
    };
  });
}

export async function createAsset(input: {
  name: string;
  purchaseDate: Date;
  cost: number;
  salvageValue?: number;
  usefulLifeMonths: number;
  method?: 'straight_line' | 'wdv';
  wdvRate?: number;
  division?: string | null;
  categoryId?: string | null;
  /** Post the purchase to the ledger at the same time. */
  accountId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'create' });

  const recordCode = await nextRecordCode('FA');
  const asset = await prisma.fixedAsset.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      purchaseDate: input.purchaseDate,
      cost: input.cost,
      salvageValue: input.salvageValue ?? 0,
      usefulLifeMonths: input.usefulLifeMonths,
      method: input.method ?? 'straight_line',
      wdvRate: input.wdvRate ?? 0,
      division: input.division ?? null,
      categoryId: input.categoryId ?? null,
    },
  });

  // A capital purchase is money leaving an account like any other, so it lands
  // in the ledger rather than existing only on an asset register.
  if (input.accountId) {
    await recordTransaction({
      txnDate: input.purchaseDate,
      direction: 'out',
      amount: input.cost,
      accountId: input.accountId,
      categoryId: input.categoryId ?? null,
      division: input.division ?? null,
      counterparty: input.name,
      note: `Purchase of ${recordCode}`,
      source: 'asset',
      fixedAssetId: asset.id,
    });
  }

  return asset;
}

export async function assetSchedule(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'view' });

  const asset = await prisma.fixedAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');

  return depreciationSchedule({
    cost: num(asset.cost) ?? 0,
    salvageValue: num(asset.salvageValue) ?? 0,
    usefulLifeMonths: asset.usefulLifeMonths,
    purchaseDate: asset.purchaseDate,
    method: asset.method as 'straight_line' | 'wdv',
    wdvRate: num(asset.wdvRate) ?? 0,
  });
}

export async function listLoans(asOf = new Date()) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'view' });

  const loans = await prisma.loan.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: { startDate: 'desc' },
  });

  return loans.map((l) => {
    const input = {
      principal: num(l.principal) ?? 0,
      annualRate: num(l.annualRate) ?? 0,
      tenureMonths: l.tenureMonths,
      startDate: l.startDate,
    };
    const schedule = amortisationSchedule(input);
    const thisMonth = schedule.find((r) => r.period === monthKey(asOf));
    return {
      id: l.id,
      recordCode: l.recordCode,
      lender: l.lender,
      principal: input.principal,
      annualRate: input.annualRate,
      tenureMonths: l.tenureMonths,
      startDate: l.startDate,
      closedAt: l.closedAt,
      outstanding: l.closedAt ? 0 : loanBalanceAt(input, asOf),
      instalment: schedule[0]?.instalment ?? 0,
      interestThisMonth: thisMonth?.interest ?? 0,
    };
  });
}

export async function createLoan(input: {
  lender: string;
  principal: number;
  annualRate: number;
  tenureMonths: number;
  startDate: Date;
  accountId?: string | null;
  division?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'create' });

  const recordCode = await nextRecordCode('LN');
  return prisma.loan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      lender: input.lender,
      principal: input.principal,
      annualRate: input.annualRate,
      tenureMonths: input.tenureMonths,
      startDate: input.startDate,
      accountId: input.accountId ?? null,
      division: input.division ?? null,
    },
  });
}

export async function loanSchedule(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'view' });

  const loan = await prisma.loan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!loan) throw ApiError.notFound('Loan');

  return amortisationSchedule({
    principal: num(loan.principal) ?? 0,
    annualRate: num(loan.annualRate) ?? 0,
    tenureMonths: loan.tenureMonths,
    startDate: loan.startDate,
  });
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

/**
 * Posts the entries a period's recurring rules call for.
 *
 * Deliberate rather than automatic, and idempotent per period: a rule that
 * posted silently every night is how a ledger fills with entries nobody
 * checked, and `lastGeneratedPeriod` makes posting a month twice impossible
 * rather than merely unlikely.
 */
export async function generateRecurring(period: string): Promise<{ created: number; skipped: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });

  const { from } = monthRange(period);
  const rules = await prisma.recurringRule.findMany({
    where: { tenantId: auth.tenantId, active: true, startDate: { lte: from } },
  });

  let created = 0;
  let skipped = 0;

  for (const rule of rules) {
    if (rule.lastGeneratedPeriod && rule.lastGeneratedPeriod >= period) {
      skipped += 1;
      continue;
    }
    if (rule.endDate && rule.endDate < from) {
      skipped += 1;
      continue;
    }
    // A quarterly rule fires on the months its cadence lands on, counted from
    // the month it started rather than from January.
    if (rule.cadence !== 'monthly') {
      const step = rule.cadence === 'quarterly' ? 3 : 12;
      const monthsSinceStart =
        (from.getUTCFullYear() - rule.startDate.getUTCFullYear()) * 12 +
        (from.getUTCMonth() - rule.startDate.getUTCMonth());
      if (monthsSinceStart % step !== 0) {
        skipped += 1;
        continue;
      }
    }

    const [year, month] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(rule.dayOfMonth, lastDay);

    await recordTransaction({
      txnDate: new Date(Date.UTC(year, month - 1, day)),
      direction: rule.direction as 'in' | 'out',
      amount: num(rule.amount) ?? 0,
      accountId: rule.accountId,
      categoryId: rule.categoryId,
      division: rule.division,
      note: rule.label,
      source: 'recurring',
    });

    await prisma.recurringRule.update({ where: { id: rule.id }, data: { lastGeneratedPeriod: period } });
    created += 1;
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ProfitAndLoss {
  period: string;
  income: number;
  expense: number;
  net: number;
  byDivision: Array<{ division: string; income: number; expense: number; net: number }>;
  byCategory: Array<{ categoryId: string | null; categoryName: string; kind: string; amount: number }>;
}

/**
 * Income and expenditure for a period, cut by division.
 *
 * The division cut is the point of it: this company runs three businesses out
 * of one entity, and a single consolidated figure hides which of them is
 * paying for the others.
 */
export async function profitAndLoss(period: string): Promise<ProfitAndLoss> {
  const auth = currentAuth();
  await assertScopeAll('transactions');
  const { from, to } = monthRange(period);

  const [rows, categories] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['categoryId', 'division', 'direction'],
      where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { gte: from, lt: to } },
      _sum: { amount: true },
    }),
    prisma.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
  ]);

  const byId = new Map(categories.map((c) => [c.id, c]));
  const divisions = new Map<string, { division: string; income: number; expense: number; net: number }>();
  const byCategory = new Map<string, { categoryId: string | null; categoryName: string; kind: string; amount: number }>();

  let income = 0;
  let expense = 0;

  for (const row of rows) {
    const amount = num(row._sum.amount) ?? 0;
    const category = row.categoryId ? byId.get(row.categoryId) : null;

    // Funding, drawings and transfers between the company's own accounts move
    // cash without being trading performance. Counting capital as revenue is
    // what makes a funded month look profitable.
    if (!isTrading(category?.kind)) continue;

    const isIncome = row.direction === 'in';
    if (isIncome) income = round2(income + amount);
    else expense = round2(expense + amount);

    const key = row.division ?? 'shared';
    const d = divisions.get(key) ?? { division: key, income: 0, expense: 0, net: 0 };
    if (isIncome) d.income = round2(d.income + amount);
    else d.expense = round2(d.expense + amount);
    d.net = round2(d.income - d.expense);
    divisions.set(key, d);

    const ckey = row.categoryId ?? 'uncategorised';
    const c = byCategory.get(ckey) ?? {
      categoryId: row.categoryId,
      categoryName: category?.name ?? 'Uncategorised',
      kind: category?.kind ?? (isIncome ? 'income' : 'expense'),
      amount: 0,
    };
    c.amount = round2(c.amount + amount);
    byCategory.set(ckey, c);
  }

  return {
    period,
    income,
    expense,
    net: round2(income - expense),
    byDivision: [...divisions.values()].sort((a, b) => b.net - a.net),
    byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
  };
}

/** The income and expenditure trend, month by month. */
export async function monthlyTrend(months = 12) {
  const auth = currentAuth();
  await assertScopeAll('transactions');

  const periods = monthsBack(monthKey(new Date()), months);
  const { from } = monthRange(periods[0]);
  const { to } = monthRange(periods[periods.length - 1]);

  const rows = await prisma.transaction.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { gte: from, lt: to } },
    select: { txnDate: true, direction: true, amount: true, division: true, category: { select: { kind: true } } },
  });

  const byPeriod = new Map(periods.map((p) => [p, { period: p, income: 0, expense: 0, net: 0 }]));
  for (const row of rows) {
    if (!isTrading(row.category?.kind)) continue;
    const bucket = byPeriod.get(monthKey(row.txnDate));
    if (!bucket) continue;
    const amount = num(row.amount) ?? 0;
    if (row.direction === 'in') bucket.income = round2(bucket.income + amount);
    else bucket.expense = round2(bucket.expense + amount);
    bucket.net = round2(bucket.income - bucket.expense);
  }

  return [...byPeriod.values()];
}

/**
 * The cash position, and how long it lasts.
 *
 * Runway is null when the company is not burning, rather than infinity — an ∞
 * on a dashboard reads as a fact about the business and is not one.
 */
export async function cashPosition(months = 3) {
  const auth = currentAuth();
  await assertScopeAll('ledger_accounts');

  const balances = await accountBalances();
  const cash = balances
    .filter((a) => ['bank', 'cash', 'wallet'].includes(a.accountType))
    .reduce((s, a) => round2(s + a.balance), 0);

  const trend = await monthlyTrend(months + 1);
  // The current month is still running, so averaging it in would understate
  // the burn every time this is read before month end.
  const complete = trend.slice(0, -1).slice(-months);
  const averageNet = complete.length
    ? round2(complete.reduce((s, m) => s + m.net, 0) / complete.length)
    : 0;

  return {
    cash,
    accounts: balances,
    averageMonthlyNet: averageNet,
    burning: averageNet < 0,
    runwayMonths: runwayMonths(cash, -averageNet),
    basedOnMonths: complete.map((m) => m.period),
  };
}

/**
 * What the next few months look like if nothing changes: the committed
 * recurring costs and the bills already due, against the cash on hand.
 */
export async function cashForecast(months = 6) {
  const auth = currentAuth();
  await assertScopeAll('transactions');

  const position = await cashPosition();
  const rules = await prisma.recurringRule.findMany({ where: { tenantId: auth.tenantId, active: true } });
  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['open', 'part_paid'] } },
  });

  const committedMonthly = rules
    .filter((r) => r.cadence === 'monthly' && r.direction === 'out')
    .reduce((s, r) => round2(s + (num(r.amount) ?? 0)), 0);

  const periods = monthsBack(monthKey(new Date()), 1).concat(
    Array.from({ length: months }, (_, i) => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + i + 1);
      return monthKey(d);
    }),
  );

  let balance = position.cash;
  const rows = periods.slice(1).map((period) => {
    const dueThisMonth = bills
      .filter((b) => b.dueDate && monthKey(b.dueDate) === period)
      .reduce((s, b) => round2(s + ((num(b.total) ?? 0) - (num(b.paidAmount) ?? 0))), 0);

    // The projection carries the observed net plus anything already committed
    // that the net has not seen yet.
    const projectedNet = round2(position.averageMonthlyNet - dueThisMonth);
    balance = round2(balance + projectedNet);
    return { period, committedOut: committedMonthly, billsDue: dueThisMonth, projectedNet, closingCash: balance };
  });

  return { openingCash: position.cash, averageMonthlyNet: position.averageMonthlyNet, rows };
}

/**
 * Posts a disbursed payroll run to the books.
 *
 * This is the join between People and Finance. Without it, salaries are the
 * largest cost the company has and the ledger never sees them — which is
 * precisely how a division P&L comes out looking profitable.
 */
export async function postPayrollToBooks(payrollRunId: string, accountId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });
  await assertCan({ resource: 'payroll', verb: 'view' });

  const run = await prisma.payrollRun.findFirst({
    where: { id: payrollRunId, tenantId: auth.tenantId },
    include: { instructions: true },
  });
  if (!run) throw ApiError.notFound('Payroll run');
  if (run.status !== 'Disbursed' && run.status !== 'Locked') {
    throw ApiError.unprocessable(
      `Run ${run.recordCode} is ${run.status}. Only a disbursed run is posted — the books record money that moved.`,
    );
  }

  const already = await prisma.transaction.findFirst({
    where: { tenantId: auth.tenantId, payrollRunId, deletedAt: null },
  });
  if (already) {
    throw ApiError.conflict(`${run.recordCode} has already been posted.`, { transactionId: already.id });
  }

  const salaryCategory = await prisma.ledgerCategory.findFirst({
    where: { tenantId: auth.tenantId, name: 'Salary & Wages', deletedAt: null },
  });

  // One entry per division rather than one per employee: the ledger records
  // what the company spent on payroll, and what each person was paid is the
  // payroll run's business, not the general ledger's.
  const byDivision = new Map<string, number>();
  for (const i of run.instructions) {
    const key = i.division ?? 'shared';
    byDivision.set(key, round2((byDivision.get(key) ?? 0) + (num(i.netAmount) ?? 0)));
  }

  const created: Awaited<ReturnType<typeof recordTransaction>>[] = [];
  for (const [division, amount] of byDivision) {
    if (amount <= 0) continue;
    created.push(
      await recordTransaction({
        txnDate: run.disbursedAt ?? new Date(),
        direction: 'out',
        amount,
        accountId,
        categoryId: salaryCategory?.id ?? null,
        division,
        counterparty: 'Payroll',
        reference: run.recordCode,
        note: `Payroll ${run.payPeriod} — ${division}`,
        source: 'payroll',
        payrollRunId: run.id,
      }),
    );
  }

  return { posted: created.length, transactions: created };
}
