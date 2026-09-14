/**
 * The books (Canon §15).
 *
 * Every amount on these responses passes the money filter: a viewer without
 * the financial verb gets `null`, never a zero. A zero is a claim about the
 * business; a null is a claim about the reader, and conflating them is how a
 * dashboard ends up lying quietly.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  DIVISIONS,
  GST_RATES,
  GST_RETURN_TYPES,
  GST_STATE_CODES,
  monthKey,
  type Division,
  type GstReturnType,
} from '@kaizen/shared';
import { handler, str, date, numeric } from '../lib/http.js';
import { num } from '../platform/db.js';
import { assertCan, canSeeMoney } from '../platform/permissions.js';
import {
  listAccounts, createAccount, accountBalances,
  listCategories, createCategory,
  listTransactions, recordTransaction, reverseTransaction, groupCounterpartyOptions,
  listVendorBills, recordVendorBill, payVendorBill, payablesAgeing,
  priceInvoiceGst, gstSummary,
  setBudgetLine, budgetVariance,
  listAssets, createAsset, assetSchedule,
  listLoans, createLoan, loanSchedule,
  generateRecurring,
  profitAndLoss, monthlyTrend, cashPosition, cashForecast,
  postPayrollToBooks,
} from '../domains/books.js';
import {
  computeGstr1,
  computeGstr3b,
  prepareReturn,
  markReturnFiled,
  listFilings,
  filingDetail,
  filingBlockers,
  periodStatus,
  exportFilingJson,
} from '../domains/gstReturns.js';
import { companyProfile, documentNumbering, updateCompanyProfile } from '../domains/companyProfile.js';
import { DOCUMENT_SERIES, peekNextNumbers, setNextNumber, type DocumentSeries } from '../platform/documentNumber.js';

const router = Router();

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a period as YYYY-MM');
const divisionEnum = z.enum(DIVISIONS as unknown as [Division, ...Division[]]);

/** `?period=` defaulting to the month in progress. */
function periodOf(v: unknown): string {
  const s = str(v);
  return s && /^\d{4}-\d{2}$/.test(s) ? s : monthKey(new Date());
}

/** Withholds an amount rather than zeroing it. */
function amount(value: number | null | undefined, visible: boolean): number | null {
  return visible ? (value ?? 0) : null;
}

// ---------------------------------------------------------------------------
// Accounts and categories
// ---------------------------------------------------------------------------

router.get(
  '/accounts',
  handler(async () => {
    const money = await canSeeMoney('ledger_accounts');
    const rows = await accountBalances();
    return rows.map((a) => ({
      ...a,
      opening: amount(a.opening, money),
      inflow: amount(a.inflow, money),
      outflow: amount(a.outflow, money),
      balance: amount(a.balance, money),
    }));
  }),
);

router.post(
  '/accounts',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        accountType: z.enum(['bank', 'cash', 'card', 'loan', 'wallet']).optional(),
        displayReference: z.string().nullish(),
        openingBalance: z.number().optional(),
        openingDate: z.coerce.date().nullish(),
        ledgerGroup: z.enum(['asset', 'liability', 'equity']).optional(),
      })
      .parse(req.body);
    return createAccount(body);
  }),
);

router.get('/categories', handler(async () => listCategories()));

router.post(
  '/categories',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(['income', 'expense', 'asset_purchase', 'transfer', 'tax', 'drawings', 'equity']).optional(),
        behaviour: z.enum(['recurring_fixed', 'variable', 'one_time', 'annual']).optional(),
        parentId: z.string().nullish(),
        defaultDivision: divisionEnum.nullish(),
        mustPay: z.boolean().optional(),
      })
      .parse(req.body);
    return createCategory(body);
  }),
);

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

router.get(
  '/transactions',
  handler(async (req) => {
    const money = await canSeeMoney('transactions');
    const rows = await listTransactions({
      from: date(req.query.from),
      to: date(req.query.to),
      categoryId: str(req.query.categoryId),
      division: str(req.query.division),
      accountId: str(req.query.accountId),
      source: str(req.query.source),
      take: numeric(req.query.take),
    });

    return rows.map((t) => ({
      id: t.id,
      recordCode: t.recordCode,
      txnDate: t.txnDate.toISOString().slice(0, 10),
      direction: t.direction,
      amount: amount(num(t.amount), money),
      accountName: t.account.name,
      categoryName: t.category?.name ?? null,
      categoryKind: t.category?.kind ?? null,
      division: t.division,
      counterparty: t.counterparty,
      method: t.method,
      reference: t.reference,
      note: t.note,
      source: t.source,
      intercompanyTenantId: t.intercompanyTenantId,
      reversalOfId: t.reversalOfId,
      reversedById: t.reversedById,
      reconciledAt: t.reconciledAt?.toISOString() ?? null,
    }));
  }),
);

router.post(
  '/transactions',
  handler(async (req) => {
    const body = z
      .object({
        txnDate: z.coerce.date(),
        direction: z.enum(['in', 'out']),
        amount: z.number().positive(),
        accountId: z.string(),
        categoryId: z.string().nullish(),
        division: divisionEnum.nullish(),
        counterparty: z.string().nullish(),
        method: z.string().optional(),
        reference: z.string().nullish(),
        note: z.string().nullish(),
        intercompanyTenantId: z.string().nullish(),
      })
      .parse(req.body);
    return recordTransaction(body);
  }),
);

router.get('/group-entities', handler(async () => ({ items: await groupCounterpartyOptions() })));

router.post(
  '/transactions/:id/reverse',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1, 'A reversal needs a reason.') }).parse(req.body);
    return reverseTransaction(req.params.id, body.reason);
  }),
);

// ---------------------------------------------------------------------------
// Vendor bills
// ---------------------------------------------------------------------------

router.get(
  '/vendor-bills',
  handler(async (req) => {
    const money = await canSeeMoney('vendor_bills');
    const rows = await listVendorBills({ status: str(req.query.status) });
    const today = new Date();

    return rows.map((b) => {
      const total = num(b.total) ?? 0;
      const paid = num(b.paidAmount) ?? 0;
      return {
        id: b.id,
        recordCode: b.recordCode,
        vendorName: b.vendorName,
        billNumber: b.billNumber,
        billDate: b.billDate.toISOString().slice(0, 10),
        dueDate: b.dueDate?.toISOString().slice(0, 10) ?? null,
        division: b.division,
        status: b.status,
        total: amount(total, money),
        paidAmount: amount(paid, money),
        outstanding: amount(total - paid, money),
        daysOverdue:
          b.dueDate && b.dueDate < today && paid < total
            ? Math.floor((today.getTime() - b.dueDate.getTime()) / 86_400_000)
            : null,
      };
    });
  }),
);

router.post(
  '/vendor-bills',
  handler(async (req) => {
    const body = z
      .object({
        vendorName: z.string().min(1),
        vendorGstin: z.string().nullish(),
        billNumber: z.string().nullish(),
        billDate: z.coerce.date(),
        dueDate: z.coerce.date().nullish(),
        categoryId: z.string().nullish(),
        division: divisionEnum.nullish(),
        subtotal: z.number(),
        taxAmount: z.number().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return recordVendorBill(body);
  }),
);

router.post(
  '/vendor-bills/:id/pay',
  handler(async (req) => {
    const body = z
      .object({
        amount: z.number().positive(),
        accountId: z.string(),
        paidOn: z.coerce.date(),
        reference: z.string().nullish(),
      })
      .parse(req.body);
    return payVendorBill(req.params.id, body);
  }),
);

router.get(
  '/payables/ageing',
  handler(async () => {
    const money = await canSeeMoney('vendor_bills');
    const ageing = await payablesAgeing();
    if (!money) return { count: ageing.count, total: null, buckets: null };
    return ageing;
  }),
);

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

router.post(
  '/invoices/:id/price-tax',
  handler(async (req) => {
    const body = z
      .object({
        interState: z.boolean(),
        placeOfSupply: z.string().nullish(),
        customerGstin: z.string().nullish(),
        division: divisionEnum.nullish(),
      })
      .parse(req.body);
    return priceInvoiceGst(req.params.id, body);
  }),
);

router.get(
  '/gst/summary',
  handler(async (req) => {
    const money = await canSeeMoney('invoices');
    const summary = await gstSummary(periodOf(req.query.period));
    if (!money) return { period: summary.period, invoiceCount: summary.invoiceCount, withheld: true };
    return summary;
  }),
);

router.get('/gst/rates', handler(async () => GST_RATES));

/** The state codes a place of supply is named by, for the pickers. */
router.get(
  '/gst/states',
  handler(async () =>
    Object.entries(GST_STATE_CODES).map(([code, name]) => ({ code, name })),
  ),
);

// ---------------------------------------------------------------------------
// GST returns
// ---------------------------------------------------------------------------
//
// Computing a return, preparing it (which snapshots the figures) and recording
// that it was filed are three endpoints because they are three acts. The
// platform prepares returns and does not transmit them: `POST /file` records the
// portal's acknowledgement, and a return with no ARN was not filed.

const returnTypeEnum = z.enum(GST_RETURN_TYPES as unknown as [GstReturnType, ...GstReturnType[]]);

/** GSTR-1: outward supplies, invoice by invoice for B2B and rate-wise for B2C. */
router.get(
  '/gst/gstr1',
  handler(async (req) => computeGstr1(periodOf(req.query.period))),
);

/** GSTR-3B: the monthly summary, the credit set-off and what is paid in cash. */
router.get(
  '/gst/gstr3b',
  handler(async (req) => computeGstr3b(periodOf(req.query.period))),
);

router.get(
  '/gst/filings',
  handler(async (req) => {
    const rows = await listFilings({
      returnType: str(req.query.returnType),
      period: str(req.query.period),
      status: str(req.query.status),
    });
    const money = await canSeeMoney('invoices');
    return rows.map((f) => ({
      id: f.id,
      recordCode: f.recordCode,
      returnType: f.returnType,
      period: f.period,
      gstin: f.gstin,
      status: f.status,
      taxableValue: amount(num(f.taxableValue), money),
      cgstAmount: amount(num(f.cgstAmount), money),
      sgstAmount: amount(num(f.sgstAmount), money),
      igstAmount: amount(num(f.igstAmount), money),
      inputTaxCredit: amount(num(f.inputTaxCredit), money),
      netPayable: amount(num(f.netPayable), money),
      invoiceCount: f.invoiceCount,
      preparedAt: f.preparedAt.toISOString(),
      arn: f.arn,
      filedAt: f.filedAt?.toISOString() ?? null,
      note: f.note,
    }));
  }),
);

router.get('/gst/filings/:id', handler(async (req) => filingDetail(req.params.id)));

/**
 * What stands between this prepared return and a filed one.
 *
 * Read from the snapshot, so it answers for the return as prepared rather than
 * for the books as they stand now — which is the only reading that means
 * anything to somebody about to file.
 */
router.get('/gst/filings/:id/blockers', handler(async (req) => filingBlockers(req.params.id)));

/** The return in the offline utility's shape, for upload to the portal. */
router.get('/gst/filings/:id/export', handler(async (req) => exportFilingJson(req.params.id)));

/** Whether a month is closed, and by which filing. */
router.get('/gst/period', handler(async (req) => periodStatus(periodOf(req.query.period))));

router.post(
  '/gst/filings',
  handler(async (req, res) => {
    const body = z
      .object({ returnType: returnTypeEnum, period: period, note: z.string().nullish() })
      .parse(req.body);
    const result = await prepareReturn(body.returnType, body.period, body.note);
    res.status(201).json(result);
    return undefined;
  }),
);

router.post(
  '/gst/filings/:id/file',
  handler(async (req) => {
    const body = z
      .object({ arn: z.string().min(6), filedAt: z.string().nullish(), note: z.string().nullish() })
      .parse(req.body);
    return markReturnFiled(req.params.id, {
      arn: body.arn,
      filedAt: body.filedAt ? new Date(body.filedAt) : undefined,
      note: body.note ?? null,
    });
  }),
);

// ---------------------------------------------------------------------------
// The company's own registration
// ---------------------------------------------------------------------------
//
// Every invoice is printed from this and every return is filed under it, which
// is why it is here rather than buried in an admin screen about something else.

/**
 * Gated here rather than inside `companyProfile()`, and the split is deliberate.
 *
 * The function is read internally by every invoice, receipt and statement, for
 * any viewer who may see the document — so it cannot assert `company_profile:view`
 * itself without making the supplier block on an invoice depend on a grant about
 * settings. The endpoint is a different thing: it hands over the whole row, bank
 * account number included, and that is a grant question.
 */
router.get(
  '/company-profile',
  handler(async () => {
    await assertCan({ resource: 'company_profile', verb: 'view' });
    return companyProfile();
  }),
);

/**
 * Where each document series stands.
 *
 * A company adopting this platform mid-year has already issued fifteen receipts
 * by hand, and starting again at 001 would put two documents into the world with
 * one number. So the next number in each series is visible, and settable
 * forwards.
 */
router.get(
  '/company-profile/series',
  handler(async () => {
    await assertCan({ resource: 'company_profile', verb: 'view' });
    const { prefix, yearFormat } = await documentNumbering();
    return peekNextNumbers(prefix, new Date(), yearFormat);
  }),
);

router.post(
  '/company-profile/series',
  handler(async (req) => {
    await assertCan({ resource: 'company_profile', verb: 'edit' });
    const body = z
      .object({
        series: z.enum(Object.values(DOCUMENT_SERIES) as [DocumentSeries, ...DocumentSeries[]]),
        nextNumber: z.number().int().positive(),
      })
      .parse(req.body);
    await setNextNumber(body.series, body.nextNumber);
    const { prefix, yearFormat } = await documentNumbering();
    return peekNextNumbers(prefix, new Date(), yearFormat);
  }),
);

router.patch(
  '/company-profile',
  handler(async (req) => {
    const body = z
      .object({
        legalName: z.string().min(1).optional(),
        tradeName: z.string().nullish(),
        gstin: z.string().nullish(),
        stateCode: z.string().length(2).nullish(),
        pan: z.string().nullish(),
        cin: z.string().nullish(),
        addressLine1: z.string().nullish(),
        addressLine2: z.string().nullish(),
        city: z.string().nullish(),
        pincode: z.string().nullish(),
        email: z.string().nullish(),
        phone: z.string().nullish(),
        website: z.string().nullish(),
        bankName: z.string().nullish(),
        bankAccountName: z.string().nullish(),
        bankAccountNumber: z.string().nullish(),
        bankIfsc: z.string().nullish(),
        bankBranch: z.string().nullish(),
        upiId: z.string().nullish(),
        invoiceTerms: z.string().nullish(),
        invoiceNotes: z.string().nullish(),
        defaultDueDays: z.number().int().positive().max(365).optional(),
        documentPrefix: z.string().max(8).nullish(),
        documentYearFormat: z.enum(['short', 'full']).optional(),
        incorporatedOn: z.string().nullish(),
        financialYearEndMonth: z.number().int().min(1).max(12).nullish(),
        isSmallCompany: z.boolean().nullish(),
        dematStatus: z.enum(['physical', 'demat', 'mixed']).optional(),
        isin: z.string().nullish(),
        rtaName: z.string().nullish(),
        dpiitNumber: z.string().nullish(),
        dpiitRecognisedOn: z.string().nullish(),
        certificateSignatories: z.array(z.object({ name: z.string(), designation: z.string() })).optional(),
      })
      .parse(req.body);
    return updateCompanyProfile(body);
  }),
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

router.post(
  '/budget',
  handler(async (req) => {
    const body = z
      .object({
        period: period,
        categoryId: z.string(),
        division: divisionEnum.nullish(),
        amount: z.number(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return setBudgetLine(body);
  }),
);

router.get(
  '/budget/variance',
  handler(async (req) => {
    const money = await canSeeMoney('budgets');
    const result = await budgetVariance(periodOf(req.query.period));
    if (money) return result;

    // The shape of the plan is visible without its figures: a unit head can
    // see which categories are overspent without seeing the company's ledger.
    return {
      period: result.period,
      budgetTotal: null,
      actualTotal: null,
      variance: null,
      rows: result.rows.map((r) => ({
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        division: r.division,
        budget: null,
        actual: null,
        variance: null,
        overspent: r.overspent,
      })),
    };
  }),
);

// ---------------------------------------------------------------------------
// Assets and loans
// ---------------------------------------------------------------------------

router.get(
  '/assets',
  handler(async () => {
    const money = await canSeeMoney('assets');
    const rows = await listAssets();
    return rows.map((a) => ({
      ...a,
      purchaseDate: a.purchaseDate.toISOString().slice(0, 10),
      disposedAt: a.disposedAt?.toISOString().slice(0, 10) ?? null,
      cost: amount(a.cost, money),
      bookValue: amount(a.bookValue, money),
      accumulatedDepreciation: amount(a.accumulatedDepreciation, money),
    }));
  }),
);

router.post(
  '/assets',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        purchaseDate: z.coerce.date(),
        cost: z.number().positive(),
        salvageValue: z.number().optional(),
        usefulLifeMonths: z.number().int().positive(),
        method: z.enum(['straight_line', 'wdv']).optional(),
        wdvRate: z.number().optional(),
        division: divisionEnum.nullish(),
        categoryId: z.string().nullish(),
        accountId: z.string().nullish(),
      })
      .parse(req.body);
    return createAsset(body);
  }),
);

router.get('/assets/:id/schedule', handler(async (req) => assetSchedule(req.params.id)));

router.get(
  '/loans',
  handler(async () => {
    const money = await canSeeMoney('assets');
    const rows = await listLoans();
    return rows.map((l) => ({
      ...l,
      startDate: l.startDate.toISOString().slice(0, 10),
      closedAt: l.closedAt?.toISOString().slice(0, 10) ?? null,
      principal: amount(l.principal, money),
      outstanding: amount(l.outstanding, money),
      instalment: amount(l.instalment, money),
      interestThisMonth: amount(l.interestThisMonth, money),
    }));
  }),
);

router.post(
  '/loans',
  handler(async (req) => {
    const body = z
      .object({
        lender: z.string().min(1),
        principal: z.number().positive(),
        annualRate: z.number().min(0),
        tenureMonths: z.number().int().positive(),
        startDate: z.coerce.date(),
        accountId: z.string().nullish(),
        division: divisionEnum.nullish(),
      })
      .parse(req.body);
    return createLoan(body);
  }),
);

router.get('/loans/:id/schedule', handler(async (req) => loanSchedule(req.params.id)));

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

router.post(
  '/recurring/generate',
  handler(async (req) => {
    const body = z.object({ period }).parse(req.body);
    return generateRecurring(body.period);
  }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get(
  '/reports/profit-and-loss',
  handler(async (req) => {
    const money = await canSeeMoney('transactions');
    const pl = await profitAndLoss(periodOf(req.query.period));
    if (money) return pl;
    return {
      period: pl.period,
      income: null,
      expense: null,
      net: null,
      byDivision: pl.byDivision.map((d) => ({ division: d.division, income: null, expense: null, net: null })),
      byCategory: [],
    };
  }),
);

router.get(
  '/reports/trend',
  handler(async (req) => {
    const money = await canSeeMoney('transactions');
    const rows = await monthlyTrend(numeric(req.query.months) ?? 12);
    if (money) return rows;
    return rows.map((r) => ({ period: r.period, income: null, expense: null, net: null }));
  }),
);

router.get(
  '/reports/cash',
  handler(async () => {
    const money = await canSeeMoney('ledger_accounts');
    const position = await cashPosition();
    if (money) return position;
    return {
      cash: null,
      accounts: position.accounts.map((a) => ({ ...a, opening: null, inflow: null, outflow: null, balance: null })),
      averageMonthlyNet: null,
      burning: position.burning,
      runwayMonths: null,
      basedOnMonths: position.basedOnMonths,
    };
  }),
);

router.get(
  '/reports/cash-forecast',
  handler(async (req) => {
    const money = await canSeeMoney('transactions');
    const forecast = await cashForecast(numeric(req.query.months) ?? 6);
    if (money) return forecast;
    return { openingCash: null, averageMonthlyNet: null, rows: [] };
  }),
);

router.post(
  '/payroll/:id/post',
  handler(async (req) => {
    const body = z.object({ accountId: z.string() }).parse(req.body);
    return postPayrollToBooks(req.params.id, body.accountId);
  }),
);

export default router;
