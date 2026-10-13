/**
 * Money comparisons that used to pass through a tolerance (ORDERED-PLAN 1.6, S2).
 *
 * Each case sits on a paisa boundary: one that clears to exactly zero, one that
 * is a paisa short or a paisa over. Float-noise inputs (0.1 + 0.2, 33.33 x 3)
 * are here because they are the inputs a tolerance was written to absorb; the
 * exact paise answer is the same with or without it.
 *
 * Invoice totals are presented to the rupee (computeGst rounds grandTotal), so
 * invoice fixtures use whole-rupee totals; the paisa boundaries sit on receipts,
 * bills and fee instalments.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  isLikelyMatch,
  toMinorHalfUp,
  journalTotals,
  matchGstr2b,
  parseMinor,
  type BookedBill,
  type Gstr2bB2bRow,
  type JournalLine,
} from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma, payBillSettled } from './helpers.js';
import {
  collectInvoicePayment,
  createInvoice,
  declarePaymentTerms,
  filingPeriodOf,
  invoiceDocument,
} from '../domains/invoicing.js';
import { listReceipts, raiseFinalInvoice, receiptDocument } from '../domains/receipts.js';
import { allocatePayment, issueFeeInstalments, recordPayment } from '../domains/finance.js';
import { recordVendorBill } from '../domains/books.js';
import { trialBalance } from '../domains/compliance/books.js';
import { computeGstr1 } from '../domains/gstReturns.js';

const ACTOR = 'latha@kaizen.co.in';
let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function anAccountId() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

async function invoiceStatus(invoiceId: string) {
  return (await unscopedPrisma.invoice.findFirstOrThrow({ where: { id: invoiceId } })).status;
}

async function expectTrialBalanceToNetToZero() {
  const tb = await asUser('finance@kaizen.co.in', () => trialBalance(new Date()));
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

// ---------------------------------------------------------------------------
// Pure functions in packages/shared. There is no packages/shared test runner,
// so these run here beside the database cases.
// ---------------------------------------------------------------------------

describe('shared paise comparisons (no database)', () => {
  const day = new Date('2026-10-10T00:00:00Z');

  it('bank and ledger amounts match to the paisa; one paisa apart is not a match', () => {
    const base = {
      bankDate: day,
      bankDirection: 'in' as const,
      bankReference: null,
      txnDate: day,
      txnDirection: 'in' as const,
      txnReference: null,
    };
    expect(isLikelyMatch({ ...base, bankAmountMinor: 10000n, txnAmountMinor: 10000n })).toBe(true);
    expect(isLikelyMatch({ ...base, bankAmountMinor: 10000n, txnAmountMinor: 10001n })).toBe(false);
    // 0.1 + 0.2 is 0.30000000000000004 as a double; it is the paise 0.30.
    expect(isLikelyMatch({ ...base, bankAmountMinor: 30n, txnAmountMinor: toMinorHalfUp(0.1 + 0.2) })).toBe(true);
  });

  it('GSTR-2B: book tax equal to the portal tax to the paisa is matched, one paisa either way is not', () => {
    const bill = (taxAmount: number): BookedBill => ({
      vendorBillId: 'vb-boundary',
      vendorGstin: '29AAAAA0000A1Z5',
      billNumber: 'INV-1',
      taxableValue: 10,
      taxAmount,
    });
    const portal = (camt: number, samt: number): Gstr2bB2bRow[] => [
      {
        ctin: '29AAAAA0000A1Z5',
        inum: 'INV-1',
        idt: '2026-10-01',
        val: 10.3,
        itms: [{ txval: 10, camt, samt, iamt: 0 }],
      },
    ];
    const statusOf = (taxAmount: number, camt: number, samt: number) =>
      matchGstr2b([bill(taxAmount)], portal(camt, samt))[0]!.status;

    expect(statusOf(0.3, 0.15, 0.15)).toBe('matched');
    // The portal lines sum to 0.30000000000000004 as doubles.
    expect(statusOf(0.3, 0.1, 0.2)).toBe('matched');
    expect(statusOf(0.29, 0.15, 0.15)).toBe('mismatch');
    expect(statusOf(0.31, 0.15, 0.15)).toBe('mismatch');
  });

  it('a payroll journal balances to the paisa, and one paisa out does not balance', () => {
    const line = (debit: number, credit: number): JournalLine => ({
      ledgerAccountCode: '1000',
      label: 'boundary',
      costCentre: 'boundary',
      debit,
      credit,
    });
    expect(journalTotals([line(0.1, 0), line(0.2, 0), line(0, 0.3)]).balanced).toBe(true);
    expect(journalTotals([line(100.01, 0), line(0, 100)]).balanced).toBe(false);
    expect(journalTotals([line(100, 0), line(0, 100)]).balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Database cases. Real Postgres, real domain functions.
// ---------------------------------------------------------------------------

describe('vendor bill payments (books.ts payVendorBill)', () => {
  it('a bill of 99.99 paid in three instalments of 33.33 ends paid, and the trial balance nets to zero', async () => {
    const account = await bankAccount();
    const bill = await asUser(ACTOR, () =>
      recordVendorBill({ vendorName: `Paise ${stamp()}`, billDate: new Date(), subtotal: 99.99, taxAmount: 0 }),
    );
    const pay = (amount: number) =>
      asUser(ACTOR, () => payBillSettled(bill.id, { amount, accountId: account.id, paidOn: new Date() }));

    expect((await pay(33.33)).bill.status).toBe('part_paid');
    expect((await pay(33.33)).bill.status).toBe('part_paid');
    expect((await pay(33.33)).bill.status).toBe('paid');
    await expectTrialBalanceToNetToZero();
  });

  it('one paisa short of the bill is part paid, one paisa over the outstanding is refused, and the last paisa clears it', async () => {
    const account = await bankAccount();
    const bill = await asUser(ACTOR, () =>
      recordVendorBill({ vendorName: `Paise ${stamp()}`, billDate: new Date(), subtotal: 99.99, taxAmount: 0 }),
    );
    const pay = (amount: number) =>
      asUser(ACTOR, () => payBillSettled(bill.id, { amount, accountId: account.id, paidOn: new Date() }));

    expect((await pay(99.98)).bill.status).toBe('part_paid');
    const over = await expectReject(() => pay(0.02));
    expect(over.status).toBe(422);
    expect((await pay(0.01)).bill.status).toBe('paid');
  });
});

describe('invoice settlement to the paisa (invoicing and receipts)', () => {
  it('receipts that add to the invoice to the paisa settle it, and a paisa short does not', async () => {
    await asUser(ACTOR, async () => {
      const invoice = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
      });
      await collectInvoicePayment(invoice.id, { amount: 1179.99, mode: 'cash', reference: `C-${stamp()}` });

      const shortPosition = (await invoiceDocument(invoice.id)).position;
      expect(shortPosition.settled).toBe(false);

      const rows = await listReceipts({ invoiceId: invoice.id });
      expect(rows[0]!.settledIt).toBe(false);
      const doc = await receiptDocument(rows[0]!.id);
      expect(doc.position.isPartPayment).toBe(true);

      const last = await collectInvoicePayment(invoice.id, { amount: 0.01, mode: 'upi', reference: `U-${stamp()}` });
      expect((await invoiceDocument(invoice.id)).position.settled).toBe(true);
      const lastRow = (await listReceipts({ invoiceId: invoice.id })).find((r) => r.id === last.receipt.id)!;
      expect(lastRow.settledIt).toBe(true);
      expect((await receiptDocument(last.receipt.id)).position.isPartPayment).toBe(false);
    });
  });

  it('thirds of 393.33 plus a paisa settle 1180 exactly; the float sum is not what decides it', async () => {
    await asUser(ACTOR, async () => {
      const invoice = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
      });
      for (let i = 0; i < 3; i++) {
        await collectInvoicePayment(invoice.id, { amount: 393.33, mode: 'cash', reference: `T-${stamp()}` });
      }
      expect((await invoiceDocument(invoice.id)).position.settled).toBe(false);
      await collectInvoicePayment(invoice.id, { amount: 0.01, mode: 'cash', reference: `T-${stamp()}` });
      expect((await invoiceDocument(invoice.id)).position.settled).toBe(true);
    });
  });

  it('a payment of one paisa over the invoice total at creation is refused, and the exact total is accepted', async () => {
    await asUser(ACTOR, async () => {
      const organizationId = await anAccountId();
      const over = await expectReject(() =>
        createInvoice({
          organizationId,
          placeOfSupply: '33',
          lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
          payment: { amount: 1180.01, mode: 'cash', reference: `O-${stamp()}` },
        }),
      );
      expect(over.status).toBe(422);

      const exact = await createInvoice({
        organizationId,
        placeOfSupply: '33',
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
        payment: { amount: 1180, mode: 'cash', reference: `E-${stamp()}` },
      });
      expect(await invoiceStatus(exact.id)).toBe('settled');
      expect((await invoiceDocument(exact.id)).position.settled).toBe(true);
    });
  });

  it('a declared payment one paisa over the payable is refused, and the payable itself is accepted', async () => {
    await asUser(ACTOR, async () => {
      const draft = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        issue: false,
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
      });
      const over = await expectReject(() => declarePaymentTerms(draft.id, { amountPayableNow: 1180.01 }));
      expect(over.status).toBe(422);
      const declared = await declarePaymentTerms(draft.id, { amountPayableNow: 1180 });
      expect(declared).toBeDefined();
    });
  });

  it('a discount equal to the line gross is accepted to the paisa, and one paisa more is refused', async () => {
    await asUser(ACTOR, async () => {
      const organizationId = await anAccountId();
      // 0.1 x 3 is 0.30000000000000004 as a double; the line gross is 0.30.
      const withDiscount = (discountAmount: number) =>
        createInvoice({
          organizationId,
          placeOfSupply: '33',
          lines: [
            { description: `Paise ${stamp()}`, quantity: 3, unitPrice: 0.1, gstRate: 0, discountAmount },
            { description: `Balance ${stamp()}`, unitPrice: 999.7, gstRate: 0 },
          ],
        });
      const ok = await withDiscount(0.3);
      expect(ok.status).toBe('issued');
      const refused = await expectReject(() => withDiscount(0.31));
      expect(refused.status).toBe(400);
    });
  });

  it('final invoice: the statement is superseded only when the received total moves by a paisa', async () => {
    await asUser(ACTOR, async () => {
      const invoice = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
        payment: { amount: 1179.99, mode: 'cash', reference: `F-${stamp()}` },
      });
      const first = await raiseFinalInvoice(invoice.id);
      expect(first.settled).toBe(false);
      expect(first.balance.toString()).toBe('0.01');

      // Nothing has changed, so raising again hands back the same statement.
      const again = await raiseFinalInvoice(invoice.id);
      expect(again.id).toBe(first.id);

      await collectInvoicePayment(invoice.id, { amount: 0.01, mode: 'upi', reference: `F2-${stamp()}` });
      const settled = await raiseFinalInvoice(invoice.id);
      expect(settled.id).not.toBe(first.id);
      expect(settled.settled).toBe(true);
      expect(settled.balance.toString()).toBe('0');
    });
  });
});

describe('payment allocation to the paisa (finance.ts allocatePayment)', () => {
  it('allocations of 1179.99 and then 0.01 settle a 1180 invoice, and 1179.99 alone leaves it part paid', async () => {
    await asUser(ACTOR, async () => {
      const invoice = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        lines: [{ description: `Paise ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
      });
      const payment = await recordPayment({ amount: 1180, gatewayReference: `ALLOC-${stamp()}` });

      await allocatePayment({ paymentId: payment.id, invoiceId: invoice.id, amount: 1179.99 });
      expect(await invoiceStatus(invoice.id)).toBe('part_paid');

      await allocatePayment({ paymentId: payment.id, invoiceId: invoice.id, amount: 0.01 });
      expect(await invoiceStatus(invoice.id)).toBe('settled');
      await expectTrialBalanceToNetToZero();
    });
  });

  it('fee instalment of 99.99: 98.99 allocated is part paid, and the last 1.00 clears it exactly', async () => {
    await asUser(ACTOR, async () => {
      const enrollment = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { tenantId: TENANT } });
      const [instalment] = await issueFeeInstalments(enrollment.id, [{ amount: 99.99, dueDate: new Date() }]);
      const payment = await recordPayment({ amount: 99.99, gatewayReference: `FEE-${stamp()}` });
      const feeStatus = async () =>
        (await unscopedPrisma.feeInstalment.findFirstOrThrow({ where: { id: instalment!.id } })).status;

      await allocatePayment({ paymentId: payment.id, feeInstalmentId: instalment!.id, amount: 33.33 });
      await allocatePayment({ paymentId: payment.id, feeInstalmentId: instalment!.id, amount: 33.33 });
      await allocatePayment({ paymentId: payment.id, feeInstalmentId: instalment!.id, amount: 32.33 });
      expect(await feeStatus()).toBe('part_paid');

      await allocatePayment({ paymentId: payment.id, feeInstalmentId: instalment!.id, amount: 1 });
      expect(await feeStatus()).toBe('settled');
    });
  });
});

describe('GSTR-1 tax reconciliation (gstReturns.ts)', () => {
  // 11.89 at 18% is 2.1402, which rounds to a line tax of 2.14. Stored tax of 1.14
  // is exactly one rupee below it. As doubles, 2.14 - 1.14 is 1.0000000000000002,
  // so the old float comparison flagged a difference of exactly one rupee.
  const flagged = async (recordCode: string | null | undefined, period: string) => {
    const gstr1 = await computeGstr1(period);
    return gstr1.checks.some((c) => c.code === 'TAX_DOES_NOT_RECONCILE' && (c.invoices ?? []).includes(recordCode!));
  };

  it('a stored tax exactly one rupee below the line tax is not a mismatch; one paisa more than a rupee is', async () => {
    await asUser(ACTOR, async () => {
      const period = filingPeriodOf(new Date());
      const invoice = await createInvoice({
        organizationId: await anAccountId(),
        placeOfSupply: '33',
        lines: [{ description: `Tax ${stamp()}`, unitPrice: 11.89, gstRate: 18 }],
      });
      const store = (cgst: string, sgst: string) =>
        unscopedPrisma.invoice.update({
          where: { id: invoice.id },
          data: { cgstAmountMinor: parseMinor(cgst), sgstAmountMinor: parseMinor(sgst), igstAmountMinor: 0n },
        });

      await store('1.07', '1.07');
      expect(await flagged(invoice.recordCode, period)).toBe(false);

      await store('0.57', '0.57');
      expect(await flagged(invoice.recordCode, period)).toBe(false);

      await store('0.56', '0.57');
      expect(await flagged(invoice.recordCode, period)).toBe(true);
    });
  });
});
