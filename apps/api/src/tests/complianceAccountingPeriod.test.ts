/**
 * Closed accounting periods, the compliance and receipt writes that carry a book
 * date. Each refusal is a 422 that names the closed period, and writes nothing.
 *
 * Not guarded, and so not tested here: challan creation, certificate issue, TDS
 * return preparation and filing, GST return preparation and filing, e-invoice
 * requests, FEMA receipt details, applying TDS to a payroll run and variable
 * pay payouts. Their dates are statutory filing or certificate dates, not the
 * date a ledger entry takes, and the GST and TDS return locks are their own
 * (see the review notes on the PR).
 *
 * Periods are closed here as in the other period suites. Writes stamped with
 * the current instant are probed with the current IST month closed, and that
 * month reopened afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  reopenLatestFirst,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { applyReverseCharge, issueDebitNote } from '../domains/compliance/gst.js';
import { computeVendorTds, waiveVendorTds } from '../domains/compliance/tax.js';
import { raiseFinalInvoice, finalizeCourseFeeInvoice } from '../domains/receipts.js';
import { createInvoice } from '../domains/invoicing.js';

const CLOSED = '2017-10';

// A tenant of its own (booksTenant): the month this file closes is not read by any
// other file, and a close here does not freeze months that other files write into.
let FIXTURE: BooksTenant;
let TENANT: string;
let FINANCE: string;
// An issued invoice of this tenant's own. The tenant has none of the demo dataset's.
let INVOICE: { id: string };

beforeAll(async () => {
  FIXTURE = await booksTenant('compliance-accounting-period-test');
  TENANT = FIXTURE.tenantId;
  FINANCE = FIXTURE.finance;
  // A run that stopped inside a close window leaves months closed. Reopen them before this run writes.
  await reopenLatestFirst(FIXTURE, 'Test fixture reset at the start of the run');
  INVOICE = await asUser(FINANCE, () =>
    createInvoice({
      division: 'education',
      organizationId: FIXTURE.organizationId,
      lines: [{ description: 'Compliance period fixture', unitPrice: 1000, gstRate: 18 }],
    }),
  );
  await closeThrough(FIXTURE, CLOSED);
});

afterAll(async () => {
  await reopenLatestFirst(FIXTURE, 'Compliance accounting period tests finished; reopening the months they closed');
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

/** An open bill dated inside the closed period. Set directly: the platform refuses to create one there. */
async function billInClosedPeriod(vendorGstin: string | null = null) {
  return unscopedPrisma.vendorBill.create({
    data: {
      tenantId: TENANT,
      recordCode: unique('W2-CMP-BILL'),
      vendorName: unique('W2 compliance vendor'),
      vendorGstin,
      billDate: new Date('2017-10-15T06:00:00Z'),
      subtotal: 1000,
      taxAmount: 0,
      total: 1000,
      status: 'open',
    },
  });
}

function expectClosedRefusal(err: { status?: number; message: string }) {
  expect(err.status).toBe(422);
  expect(err.message).toContain('closed accounting period');
}

describe('Closed period — a bill-dated TDS or reverse-charge write is refused and writes nothing', () => {
  it('computing TDS on a bill in the closed period is refused, and no decision is recorded', async () => {
    const bill = await billInClosedPeriod();
    const err = await expectReject(() => asUser(FINANCE, () => computeVendorTds(bill.id, { section: '194C_IND' })));
    expectClosedRefusal(err);
    expect(await unscopedPrisma.tdsDecision.count({ where: { tenantId: TENANT, billId: bill.id } })).toBe(0);
  });

  it('waiving TDS on a bill in the closed period is refused, and no decision is recorded', async () => {
    const bill = await billInClosedPeriod();
    const err = await expectReject(() => asUser(FINANCE, () => waiveVendorTds(bill.id, 'W2 probe')));
    expectClosedRefusal(err);
    expect(await unscopedPrisma.tdsDecision.count({ where: { tenantId: TENANT, billId: bill.id } })).toBe(0);
  });

  it('applying reverse charge to a bill in the closed period is refused, and no self-invoice is written', async () => {
    const bill = await billInClosedPeriod('29AABCT1332L1ZA');
    const err = await expectReject(() => asUser(FINANCE, () => applyReverseCharge(bill.id, { ratePct: 18 })));
    expectClosedRefusal(err);
    expect(await unscopedPrisma.rcmSelfInvoice.count({ where: { tenantId: TENANT, billId: bill.id } })).toBe(0);
  });
});

// Money out (a challan marked paid, an advance-tax payment) is no longer refused by a
// closed month: it is booked in the open period and EX-FIN-008 is raised. See
// moneyOutAndSettlementPeriod.test.ts.

describe('Closed period — a write stamped today is refused while the current month is closed', () => {
  it('a debit note, a final invoice and a course-fee final invoice are each refused; nothing is written', async () => {
    const invoice = INVOICE;
    const today = monthKey(new Date());
    await closeThrough(FIXTURE, today);
    const debitsBefore = await unscopedPrisma.debitNote.count({ where: { tenantId: TENANT, invoiceId: invoice.id } });
    try {
      const debit = await expectReject(() =>
        asUser(FINANCE, () => issueDebitNote(invoice.id, { amount: 100, reasonCode: 'other', note: 'W2 probe' })),
      );
      expectClosedRefusal(debit);
      expect(await unscopedPrisma.debitNote.count({ where: { tenantId: TENANT, invoiceId: invoice.id } })).toBe(
        debitsBefore,
      );

      const final = await expectReject(() => asUser(FINANCE, () => raiseFinalInvoice(invoice.id, {})));
      expectClosedRefusal(final);

      const courseFinal = await expectReject(() =>
        asUser(FINANCE, () => finalizeCourseFeeInvoice(invoice.id, 'dropout')),
      );
      expectClosedRefusal(courseFinal);
    } finally {
      await reopenLatestFirst(FIXTURE, 'W2 probe finished; reopening the months it closed');
    }
  });
});
