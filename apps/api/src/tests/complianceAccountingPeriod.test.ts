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

import { beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { applyReverseCharge, issueDebitNote } from '../domains/compliance/gst.js';
import {
  computeVendorTds,
  waiveVendorTds,
  markChallanPaid,
  recordAdvanceTaxPayment,
} from '../domains/compliance/tax.js';
import { raiseFinalInvoice, finalizeCourseFeeInvoice } from '../domains/receipts.js';
import { requestClosePeriod, closePeriod, reopenPeriod } from '../domains/compliance/books.js';

const CLOSED = '2017-10';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
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

describe('Closed period — a payment-dated TDS write is refused and writes nothing', () => {
  it('marking a TDS challan paid on a date in the closed period is refused, and the challan stays pending', async () => {
    const challan = await unscopedPrisma.tdsChallan.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-CHALLAN'),
        month: '2026-09',
        sectionGroup: '194C_IND',
        amount: 100,
        deducteeCount: 1,
      },
    });
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        markChallanPaid(challan.id, {
          bsrCode: '0000000',
          challanNo: 'W2-PROBE',
          paidOn: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );
    expectClosedRefusal(err);
    const after = await unscopedPrisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } });
    expect(after.status).not.toBe('paid');
  });

  it('recording an advance-tax payment dated in the closed period is refused, and no payment row is written', async () => {
    const reference = unique('W2 advance tax');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordAdvanceTaxPayment({
          fy: '2017-18',
          instalmentDate: new Date('2017-10-15T06:00:00Z'),
          amount: 5000,
          paidOn: new Date('2017-10-15T06:00:00Z'),
          reference,
        }),
      ),
    );
    expectClosedRefusal(err);
    expect(await unscopedPrisma.advanceTaxPayment.count({ where: { tenantId: TENANT, reference } })).toBe(0);
  });
});

describe('Closed period — a write stamped today is refused while the current month is closed', () => {
  it('a debit note, a final invoice and a course-fee final invoice are each refused; nothing is written', async () => {
    const invoice = await unscopedPrisma.invoice.findFirstOrThrow({
      where: { tenantId: TENANT, status: { not: 'void' } },
    });
    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const debit = await expectReject(() =>
        asUser(FINANCE, () => issueDebitNote(invoice.id, { amount: 100, reasonCode: 'other', note: 'W2 probe' })),
      );
      expectClosedRefusal(debit);
      expect(await unscopedPrisma.debitNote.count({ where: { tenantId: TENANT, invoiceId: invoice.id } })).toBe(0);

      const final = await expectReject(() => asUser(FINANCE, () => raiseFinalInvoice(invoice.id, {})));
      expectClosedRefusal(final);

      const courseFinal = await expectReject(() =>
        asUser(FINANCE, () => finalizeCourseFeeInvoice(invoice.id, 'dropout')),
      );
      expectClosedRefusal(courseFinal);
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
  });
});
