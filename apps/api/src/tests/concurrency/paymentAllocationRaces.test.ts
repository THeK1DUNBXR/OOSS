/**
 * Payment allocation under concurrency, and document numbers across a rollback.
 *
 * Real Postgres and the real paths throughout. The races are fired with
 * Promise.allSettled so that every attempt reads the balance before any of them
 * writes it, which is the window the old code left open: each call checked the
 * outstanding amount outside any transaction and then wrote, so N parallel
 * collections against one invoice all passed the check.
 */
import { describe, expect, it } from 'vitest';
import { formatMinor } from '@kaizen/shared';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { createInvoice, collectInvoicePayment, totalsOf } from '../../domains/invoicing.js';
import { allocatePayment, issueFeeInstalments, recordPayment } from '../../domains/finance.js';
import { DOCUMENT_SERIES, nextDocumentNumber } from '../../platform/documentNumber.js';

let TENANT: string;

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function anAccount() {
  TENANT = TENANT ?? (await tenantId());
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

/** An issued invoice for 10,000 plus 18% GST: 11,800.00 payable. */
async function anIssuedInvoice() {
  return createInvoice({
    division: 'education',
    organizationId: await anAccount(),
    placeOfSupply: '33',
    lines: [{ description: 'Programme', unitPrice: 10_000, gstRate: 18 }],
  });
}

/** Sums what the invoice has been allocated, from its receipts, in paise-exact pounds. */
async function allocatedTo(invoiceId: string): Promise<number> {
  const receipts = await prisma.receipt.findMany({ where: { invoiceId } });
  return Number(formatMinor(receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n)));
}

describe('concurrent collections against one invoice', () => {
  it('eight parallel collections of 2,000 against 11,800 payable: exactly five succeed, and no more than the balance is taken', async () => {
    const outcome = await asUser('latha@kaizen.co.in', async () => {
      const invoice = await anIssuedInvoice();
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          asUser('latha@kaizen.co.in', () =>
            collectInvoicePayment(invoice.id, { amount: 2_000, mode: 'cash', reference: `RACE-${stamp()}-${i}` }),
          ),
        ),
      );
      const row = await prisma.invoice.findFirstOrThrow({
        where: { id: invoice.id },
        include: { lines: true, receipts: true },
      });
      return { payable: totalsOf(row).payable, settled, taken: await allocatedTo(invoice.id) };
    });

    expect(outcome.payable).toBe(11_800);
    // 5 * 2,000 = 10,000 fits in 11,800; the sixth would take it to 12,000.
    expect(outcome.taken).toBeLessThanOrEqual(outcome.payable);
    expect(outcome.settled.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(outcome.taken).toBe(10_000);
  });
});

describe('concurrent allocations of one payment', () => {
  it('parallel allocations to one invoice never exceed its balance', async () => {
    const outcome = await asUser('latha@kaizen.co.in', async () => {
      // A payment large enough that only the invoice's balance can bind.
      const payment = await recordPayment({ amount: 100_000, gatewayReference: `ALLOC-INV-${stamp()}` });
      const invoice = await anIssuedInvoice();
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          asUser('latha@kaizen.co.in', () =>
            allocatePayment({ paymentId: payment.id, invoiceId: invoice.id, amount: 3_000 }),
          ),
        ),
      );
      return { invoiceId: invoice.id, settled, taken: await allocatedTo(invoice.id) };
    });

    // 3 * 3,000 = 9,000 fits in 11,800; the fourth would take it to 12,000.
    expect(outcome.taken).toBeLessThanOrEqual(11_800);
    expect(outcome.settled.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });

  it('parallel allocations never exceed the unallocated amount of the payment', async () => {
    const outcome = await asUser('latha@kaizen.co.in', async () => {
      // A payment that only 3 of 8 attempts of 2,000 can cover; the invoice is
      // large enough that only the payment's own balance can bind.
      const payment = await recordPayment({ amount: 7_000, gatewayReference: `ALLOC-PAY-${stamp()}` });
      const invoice = await anIssuedInvoice();
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          asUser('latha@kaizen.co.in', () =>
            allocatePayment({ paymentId: payment.id, invoiceId: invoice.id, amount: 2_000 }),
          ),
        ),
      );
      const receipts = await prisma.receipt.findMany({ where: { paymentId: payment.id } });
      const allocated = Number(formatMinor(receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n)));
      return { settled, allocated };
    });

    expect(outcome.allocated).toBeLessThanOrEqual(7_000);
    expect(outcome.settled.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });
});

describe('concurrent allocations to one fee instalment', () => {
  it('parallel allocations never take more than the instalment is for', async () => {
    const outcome = await asUser('latha@kaizen.co.in', async () => {
      const enrollment = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { tenantId: await tenantId() } });
      const [instalment] = await issueFeeInstalments(enrollment.id, [{ amount: 10_000, dueDate: new Date() }]);
      const payment = await recordPayment({ amount: 100_000, gatewayReference: `ALLOC-FEE-${stamp()}` });
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          asUser('latha@kaizen.co.in', () =>
            allocatePayment({ paymentId: payment.id, feeInstalmentId: instalment!.id, amount: 3_000 }),
          ),
        ),
      );
      const receipts = await prisma.receipt.findMany({ where: { feeInstalmentId: instalment!.id } });
      const taken = Number(formatMinor(receipts.reduce((s, r) => s + r.allocatedAmountMinor, 0n)));
      return { settled, taken };
    });

    // 3 * 3,000 = 9,000 fits in 10,000; the fourth would take it to 12,000.
    expect(outcome.taken).toBeLessThanOrEqual(10_000);
    expect(outcome.settled.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });
});

describe('document numbers across a rolled-back transaction', () => {
  // A year nothing else has touched, so the first insert of its sequence row is
  // the one that races. The year is taken from the stamp so a second run of the
  // suite against the same database starts a fresh sequence too.
  const freshYear = () => new Date(Date.UTC(2200 + (Number(stamp()) % 500), 6, 15));

  it('a number taken in a transaction that then rolls back is handed out again', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const at = freshYear();
      const series = DOCUMENT_SERIES.receipt;

      let burned = '';
      await expect(
        prisma.$transaction(async (tx) => {
          burned = await nextDocumentNumber(tx, series, 'TST', at);
          throw new Error('forced after numbering');
        }),
      ).rejects.toThrow('forced after numbering');

      // The rolled-back number was never issued, so the next document takes it.
      const reused = await prisma.$transaction((tx) => nextDocumentNumber(tx, series, 'TST', at));
      expect(burned.endsWith('/001')).toBe(true);
      expect(reused).toBe(burned);
    });
  });

  it('fifty parallel numbers in fifty transactions are consecutive and distinct', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const at = freshYear();
      const series = DOCUMENT_SERIES.receipt;

      const numbers = await Promise.all(
        Array.from({ length: 50 }, () => prisma.$transaction((tx) => nextDocumentNumber(tx, series, 'TST', at))),
      );

      expect(new Set(numbers).size).toBe(50);
      const seqs = numbers.map((n) => Number(n.split('/').pop())).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    });
  });
});
