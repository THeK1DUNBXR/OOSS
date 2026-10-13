/**
 * Wave 14 (ORDERED-PLAN Wave 2, "assertPeriodOpen on the remaining write paths"): a finance
 * write dated into a closed accounting period is refused, with the period's reason code, and
 * writes nothing. Covers the writes this wave put a period lock on, and one write in an open
 * month that still goes through.
 *
 * Two kinds of case, and the difference matters for reading a failure:
 *
 * - Sequential refusals (the `closed` describes). The write's pre-transaction hook
 *   (compliance/books.ts refuseClosedPeriod) refuses these, so they pass on the code as it
 *   stood before this wave too. They pin the refusal and its reason code. They do not show
 *   that the new lock is there.
 * - A race (the `close in flight` describe). A close holds the period row and has already set it
 *   `closed` in its transaction, which is not yet committed. The hook reads the committed
 *   status, so it passes. Without the in-transaction lock the write lands in the month. With it
 *   the write waits for the close and is refused on `closed`. This case fails on the code as it
 *   stood before this wave, because the write is accepted.
 *
 * Real Postgres, real contexts, no mocks. Each file in this suite uses booksTenant tenants of its
 * own, so the months closed here are not read by other files. The history tenant closes its
 * window once; the today tenant closes the current IST month, which is later than every month the
 * other files write, and reopens it when the describe ends.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financialYearOf, monthKey } from '@kaizen/shared';
import { ApiError } from '../platform/errors.js';
import { asUser, booksTenant, closeThrough, reopenLatestFirst, unscopedPrisma, type BooksTenant } from './helpers.js';
import { createAsset, createLoan, recordVendorBill } from '../domains/books.js';
import { allocatePayment, issueCreditNote, recordPayment, reversePayment } from '../domains/finance.js';
import { issueDebitNote } from '../domains/compliance/gst.js';
import { raiseFinalInvoice } from '../domains/receipts.js';

const CLOSED = '2017-10';
const RACE_MONTH = '2019-03';

let seq = 0;
function unique(label: string): string {
  seq += 1;
  return `${label} ${Date.now()}-${seq}`;
}

/** The refusal a write made, as the caller sees it. Keeps `details`, which expectReject drops. */
async function refusalOf(fn: () => Promise<unknown>): Promise<{ status: number; code: string; reasonCode?: string }> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const details = err.details as { reasonCode?: string } | undefined;
    return { status: err.status, code: err.code, reasonCode: details?.reasonCode };
  }
  throw new Error('Expected the write to be refused, but it was accepted.');
}

/** The refusal a closed period gives, in the code the rest of the books use. */
function expectClosedRefusal(refusal: { status: number; code: string; reasonCode?: string }): void {
  expect(refusal.status).toBe(422);
  expect(refusal.code).toBe('UNPROCESSABLE');
  expect(refusal.reasonCode).toBe('accounting_period_closed');
}

// ===========================================================================
// History: a window of closed months, and an open month after it
// ===========================================================================

describe('Closed period — a dated write into it is refused with the period reason code', () => {
  let HISTORY: BooksTenant;
  let TENANT: string;

  beforeAll(async () => {
    HISTORY = await booksTenant('books-closed-writes-history');
    TENANT = HISTORY.tenantId;
    await closeThrough(HISTORY, CLOSED);
  });

  afterAll(async () => {
    await reopenLatestFirst(HISTORY, 'Closed-period write tests finished; reopening the months they closed');
  });

  it('a vendor bill dated in the closed month is refused, and no bill is created', async () => {
    const vendorName = unique('W14 closed bill');
    const refusal = await refusalOf(() =>
      asUser(HISTORY.finance, () =>
        recordVendorBill({ vendorName, billDate: new Date('2017-10-15T06:00:00Z'), subtotal: 100 }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.vendorBill.count({ where: { tenantId: TENANT, vendorName } })).toBe(0);
  });

  it('a fixed asset dated in the closed month is refused, and the asset is not created', async () => {
    const name = unique('W14 closed asset');
    const refusal = await refusalOf(() =>
      asUser(HISTORY.finance, () =>
        createAsset({ name, purchaseDate: new Date('2017-10-15T06:00:00Z'), cost: 1000, usefulLifeMonths: 60 }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.fixedAsset.count({ where: { tenantId: TENANT, name } })).toBe(0);
  });

  it('a loan starting in the closed month is refused, and the loan is not created', async () => {
    const lender = unique('W14 closed lender');
    const refusal = await refusalOf(() =>
      asUser(HISTORY.finance, () =>
        createLoan({
          lender,
          principal: 100000,
          annualRate: 9,
          tenureMonths: 12,
          startDate: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.loan.count({ where: { tenantId: TENANT, lender } })).toBe(0);
  });

  it('a payment a staff member enters with a received date in the closed month is refused, and no payment is created', async () => {
    const gatewayReference = unique('W14 closed payment');
    const refusal = await refusalOf(() =>
      asUser(HISTORY.finance, () =>
        recordPayment({
          amount: 250,
          gatewayReference,
          receivedAt: new Date('2017-10-15T06:00:00Z'),
          payerOrganizationId: HISTORY.organizationId,
        }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference } })).toBe(0);
  });

  it('a vendor bill dated in the open month after the closed one is accepted', async () => {
    const vendorName = unique('W14 open-month bill');
    const bill = await asUser(HISTORY.finance, () =>
      recordVendorBill({ vendorName, billDate: new Date('2017-11-15T06:00:00Z'), subtotal: 100 }),
    );
    expect(bill.id).toBeTruthy();
    expect(await unscopedPrisma.vendorBill.count({ where: { tenantId: TENANT, vendorName } })).toBe(1);
  });

  it('a fixed asset dated in the open month after the closed one is accepted', async () => {
    const name = unique('W14 open-month asset');
    const asset = await asUser(HISTORY.finance, () =>
      createAsset({ name, purchaseDate: new Date('2017-11-15T06:00:00Z'), cost: 1000, usefulLifeMonths: 60 }),
    );
    expect(asset.id).toBeTruthy();
    expect(await unscopedPrisma.fixedAsset.count({ where: { tenantId: TENANT, name } })).toBe(1);
  });
});

// ===========================================================================
// Today: the current IST month is closed, so writes dated now are refused
// ===========================================================================

describe('Closed current month — writes dated now are refused, and nothing is reversed or allocated', () => {
  let TODAY_TENANT: BooksTenant;
  let TENANT: string;
  let payment: { id: string };
  const today = monthKey(new Date());

  beforeAll(async () => {
    TODAY_TENANT = await booksTenant('books-closed-writes-today');
    TENANT = TODAY_TENANT.tenantId;
    // Taken while the month is open: the payment the refused reversal and allocation point at.
    payment = await asUser(TODAY_TENANT.finance, () =>
      recordPayment({
        amount: 500,
        gatewayReference: unique('W14 today payment'),
        payerOrganizationId: TODAY_TENANT.organizationId,
      }),
    );
    await closeThrough(TODAY_TENANT, today);
  });

  afterAll(async () => {
    await reopenLatestFirst(TODAY_TENANT, 'Closed-current-month write tests finished; reopening the current month');
  });

  it('a credit note dated now is refused, and no credit note is written', async () => {
    const reason = unique('W14 refused credit note');
    const refusal = await refusalOf(() =>
      asUser(TODAY_TENANT.finance, () => issueCreditNote('w14-no-such-invoice', 100, reason)),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, reason } })).toBe(0);
  });

  it('a debit note dated now is refused, and no debit note is written', async () => {
    const note = unique('W14 refused debit note');
    const refusal = await refusalOf(() =>
      asUser(TODAY_TENANT.finance, () =>
        issueDebitNote('w14-no-such-invoice', { amount: 100, reasonCode: 'other', note }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.debitNote.count({ where: { tenantId: TENANT, note } })).toBe(0);
  });

  it('reversing a payment is refused while today is closed, and the payment is not reversed', async () => {
    const refusal = await refusalOf(() => asUser(TODAY_TENANT.finance, () => reversePayment(payment.id, 'W14 probe')));
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, reversalOfPaymentId: payment.id } })).toBe(
      0,
    );
  });

  it('allocating a payment to a fee instalment is refused while today is closed, and no receipt is written', async () => {
    const refusal = await refusalOf(() =>
      asUser(TODAY_TENANT.finance, () =>
        allocatePayment({
          paymentId: payment.id,
          feeInstalmentId: 'w14-no-such-instalment',
          amount: 100,
        }),
      ),
    );
    expectClosedRefusal(refusal);
    expect(await unscopedPrisma.receipt.count({ where: { tenantId: TENANT, paymentId: payment.id } })).toBe(0);
  });

  it('a final invoice dated now is refused, and no final invoice is written', async () => {
    const refusal = await refusalOf(() =>
      asUser(TODAY_TENANT.finance, () => raiseFinalInvoice('w14-no-such-invoice', {})),
    );
    expectClosedRefusal(refusal);
    expect(
      await unscopedPrisma.finalInvoice.count({ where: { tenantId: TENANT, invoiceId: 'w14-no-such-invoice' } }),
    ).toBe(0);
  });
});

// ===========================================================================
// Race: a close has set the period closed in an uncommitted transaction
// ===========================================================================

describe('Close in flight — a vendor bill that reaches the period lock during a close is refused', () => {
  let RACE: BooksTenant;
  let TENANT: string;
  let periodId: string;

  beforeAll(async () => {
    RACE = await booksTenant('books-closed-writes-race');
    TENANT = RACE.tenantId;
    // A fresh row for the month, open. Made here, not by the write under test, so the race
    // holds whether or not that write creates the row.
    const existing = await unscopedPrisma.accountingPeriod.findFirst({
      where: { tenantId: TENANT, period: RACE_MONTH },
    });
    const row = existing
      ? await unscopedPrisma.accountingPeriod.update({ where: { id: existing.id }, data: { status: 'open' } })
      : await unscopedPrisma.accountingPeriod.create({
          data: {
            tenantId: TENANT,
            period: RACE_MONTH,
            fy: financialYearOf(new Date(`${RACE_MONTH}-15T06:00:00Z`)),
            status: 'open',
          },
        });
    periodId = row.id;
  });

  afterAll(async () => {
    // The race leaves the month closed when its close commits. Reopen it directly: this file
    // closes nothing else in the tenant, so no order rule applies.
    await unscopedPrisma.accountingPeriod.update({ where: { id: periodId }, data: { status: 'open' } });
  });

  it('a bill whose write reaches the lock after a close has set the month closed is refused, and no bill is created', async () => {
    const vendorName = unique('W14 race bill');
    // A close, in its own transaction: it takes the period row and sets it closed, and holds the
    // transaction open. Nothing has committed, so the hook's plain read still sees `open`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    const closing = unscopedPrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "cmp_accounting_periods" WHERE "id" = ${periodId} FOR UPDATE`;
        await tx.$executeRaw`UPDATE "cmp_accounting_periods" SET "status" = 'closed' WHERE "id" = ${periodId}`;
        signalHeld();
        await gate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await held;

    const attempt = settle(
      asUser(RACE.finance, () =>
        recordVendorBill({ vendorName, billDate: new Date('2019-03-20T06:00:00Z'), subtotal: 100 }),
      ),
    );

    // The write either blocks on the period row (with the lock) or finishes at once (without it).
    const outcome = await Promise.race([
      waitForWaiter().then((blocked) => (blocked ? 'blocked' : 'timeout')),
      attempt.then(() => 'finished'),
    ]);

    release();
    await closing;
    const settled = await attempt;

    expect(outcome, 'the write should wait for the close, not finish while the close is open').toBe('blocked');
    expect(settled.status).toBe('rejected');
    const err = (settled as PromiseRejectedResult).reason as ApiError;
    expect(err.status).toBe(422);
    expect(err.code).toBe('UNPROCESSABLE');
    expect((err.details as { reasonCode?: string } | undefined)?.reasonCode).toBe('accounting_period_closed');
    expect(await unscopedPrisma.vendorBill.count({ where: { tenantId: TENANT, vendorName } })).toBe(0);
  });
});

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

/**
 * Whether some session in this database is waiting on a lock, polled for up to 20 s. Resolves
 * with `false` on the timeout rather than rejecting, so a race that is already settled does not
 * leave an error behind it.
 *
 * A write that waits on a row (the period row's FOR SHARE behind the close's FOR UPDATE) waits
 * on the holder's transaction ID, and a transactionid lock has no database of its own in pg_locks
 * (database IS NULL). A pg_locks filter on the database never sees that wait, so the write read
 * as not blocked and the race looked like it finished. The database is taken from pg_stat_activity
 * instead, as handoverGate.test.ts does: the application role's sessions hide their wait event
 * from this client, but their datname is visible.
 */
async function waitForWaiter(): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await unscopedPrisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`;
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
