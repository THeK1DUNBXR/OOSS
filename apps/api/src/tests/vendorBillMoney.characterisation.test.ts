/**
 * Characterisation of the VendorBill money figures (ORDERED-PLAN 1.6, slice S5): subtotal,
 * taxAmount, total, paidAmount, rcmTaxAmount and tdsAmount.
 *
 * Each column is pinned where it leaves the server: the raw Prisma rows the create,
 * approve, TDS and reverse-charge paths return (a Decimal, which the wire prints as a
 * two-place string with trailing zeros dropped), the mapped list route (a JavaScript
 * number), the event payload and the audit diff. The `*Minor` siblings are new and only
 * asserted here; they fail on the old code, which is the point of them.
 *
 * The TDS case is a half paisa: 30000.50 at 1% is 300.005. The old float path already
 * gives 300.01 (round2 in packages/shared/src/finance.ts), which is the half-up figure, so
 * the paise column stores the same value and no figure moves.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { unscopedPrisma } from '../platform/db.js';
import { asUser, approvePayoutAs, principalFor, sessionToken, tenantId, type TestPrincipal } from './helpers.js';
import { recordVendorBill, payVendorBill, payablesAgeing, gstSummary } from '../domains/books.js';
import { istMonthKey, parseMinor } from '@kaizen/shared';
import { applyReverseCharge, flaggedRcmBills } from '../domains/compliance/gst.js';
import { computeVendorTds } from '../domains/compliance/tax.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';

let server: Server;
let base: string;
let TENANT: string;
let token: string;
let chairman: TestPrincipal;

beforeAll(async () => {
  TENANT = await tenantId();
  chairman = await principalFor(CHAIRMAN);
  token = await sessionToken({
    userId: chairman.userId,
    tenantId: chairman.tenantId,
    affiliationId: chairman.affiliationId,
    stepUp: true,
  });
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let uniq = 0;
function unique(label: string): string {
  uniq += 1;
  return `${label} ${Date.now()}-${uniq}`;
}

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

describe('POST /books/vendor-bills returns the raw row, paise beside each Decimal', () => {
  it('a bill with paise keeps each Decimal as a two-place string and adds its paise string', async () => {
    const res = await call('POST', '/books/vendor-bills', {
      vendorName: unique('Wire Vendor'),
      billDate: new Date().toISOString(),
      subtotal: 12345.67,
      taxAmount: 2222.22,
    });
    expect(res.status).toBe(200);
    const body = res.body;

    // Old wire: Prisma Decimal JSON, a string with trailing zeros dropped.
    expect(body.subtotal).toBe('12345.67');
    expect(body.taxAmount).toBe('2222.22');
    expect(body.total).toBe('14567.89');
    expect(body.paidAmount).toBe('0');
    expect(body.rcmTaxAmount).toBe('0');
    expect(body.tdsAmount).toBe('0');

    // New: the paise siblings, as strings.
    expect(body.subtotalMinor).toBe('1234567');
    expect(body.taxAmountMinor).toBe('222222');
    expect(body.totalMinor).toBe('1456789');
    expect(body.paidAmountMinor).toBe('0');
    expect(body.rcmTaxAmountMinor).toBe('0');
    expect(body.tdsAmountMinor).toBe('0');
  });

  it('a trailing-zero figure keeps the Decimal normalisation (1000.60 is "1000.6")', async () => {
    const res = await call('POST', '/books/vendor-bills', {
      vendorName: unique('Trailing Zero Vendor'),
      billDate: new Date().toISOString(),
      subtotal: 1000.6,
    });
    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe('1000.6');
    expect(res.body.total).toBe('1000.6');
    expect(res.body.subtotalMinor).toBe('100060');
    expect(res.body.totalMinor).toBe('100060');
  });
});

describe('GET /books/vendor-bills maps the figures to rupee numbers', () => {
  it('total, paidAmount and outstanding stay JavaScript numbers; the paise siblings are added', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('List Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );
    // Old-dated, so it sorts to the front of the list (orderBy dueDate asc) and the take of 300 holds it.
    await unscopedPrisma.vendorBill.update({
      where: { id: bill.id },
      data: { dueDate: new Date('2001-01-01T00:00:00Z') },
    });

    const res = await call('GET', '/books/vendor-bills?status=open');
    expect(res.status).toBe(200);
    const row = res.body.find((r: { id: string }) => r.id === bill.id);
    expect(row).toBeDefined();

    expect(row.total).toBe(14567.89);
    expect(row.paidAmount).toBe(0);
    expect(row.outstanding).toBe(14567.89);
    expect(row.daysOverdue).toBeGreaterThan(0);

    expect(row.totalMinor).toBe('1456789');
    expect(row.paidAmountMinor).toBe('0');
  });
});

describe('payVendorBill snapshots the paise, and approval settles the bill exactly', () => {
  it('the request carries the paise amount, and the approved bill keeps its Decimal paidAmount', async () => {
    const account = await bankAccount();
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('Pay Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );
    const request = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 12345.67, accountId: account.id, paidOn: new Date() }),
    );
    // A bigint: the payout request was written in paise before this slice.
    expect(request.amountMinor).toBe(1234567n);

    const settled = await approvePayoutAs(CHAIRMAN, request.id);
    expect(settled.request.state).toBe('approved');
    expect(settled.bill?.status).toBe('part_paid');
    // Old: the raw bill row, paidAmount as a Decimal.
    expect(settled.bill?.paidAmount?.toString()).toBe('12345.67');
    expect(settled.bill?.total?.toString()).toBe('14567.89');
    // New: the paise sibling.
    expect(settled.bill?.paidAmountMinor).toBe('1234567');
    expect(settled.bill?.totalMinor).toBe('1456789');
  });
});

describe('the event payload and the audit diff carry the figures as before, with the paise beside', () => {
  it('kz.fin.vendor_bill.recorded keeps newState.total as a number', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('Event Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );

    const event = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: TENANT, eventName: 'kz.fin.vendor_bill.recorded', subjectEntityId: bill.id },
    });
    const newState = event.newState as Record<string, unknown>;
    expect(newState.total).toBe(14567.89);
    expect(newState.totalMinor).toBe('1456789');
  });

  it('the create audit row keeps the total diff as a number', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('Audit Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'vendor_bill', subjectId: bill.id, action: 'create' },
    });
    // A create's diff is the written row flat, not a from/to pair.
    const diff = audit.diff as Record<string, unknown>;
    expect(diff.total).toBe(14567.89);
    expect(diff.totalMinor).toBe('1456789');
  });
});

describe('the aggregates read the same figures', () => {
  it('payablesAgeing total rises by exactly the bill outstanding', async () => {
    const before = (await asUser(CHAIRMAN, () => payablesAgeing())).total;
    await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('Ageing Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );
    const after = (await asUser(CHAIRMAN, () => payablesAgeing())).total;
    // Compared in paise: the two rupee figures are read back as their two-place strings.
    expect(parseMinor(after.toFixed(2)) - parseMinor(before.toFixed(2))).toBe(1456789n);
  });

  it('gstSummary inputTax rises by exactly the bill tax in its month', async () => {
    const period = istMonthKey(new Date());
    const before = (await asUser(CHAIRMAN, () => gstSummary(period))).inputTax;
    await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: unique('Input Tax Vendor'),
        billDate: new Date(),
        subtotal: 12345.67,
        taxAmount: 2222.22,
      }),
    );
    const after = (await asUser(CHAIRMAN, () => gstSummary(period))).inputTax;
    expect(parseMinor(after.toFixed(2)) - parseMinor(before.toFixed(2))).toBe(222222n);
  });
});

describe('TDS and reverse charge write their figures to the bill', () => {
  it('computeVendorTds at 1% on 30000.50 is 300.01, the half paisa rounded up as before', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: unique('TDS Vendor'), billDate: new Date(), subtotal: 30000.5 }),
    );
    await unscopedPrisma.vendorBill.update({ where: { id: bill.id }, data: { vendorPan: 'ABCDE1234F' } });

    const { result, bill: updated } = await asUser(FINANCE, () => computeVendorTds(bill.id, { section: '194C_IND' }));
    expect(result.applicable).toBe(true);
    expect(result.tdsAmount).toBe(300.01);
    // Old: the raw bill row's tdsAmount as a Decimal.
    expect(updated.tdsAmount?.toString()).toBe('300.01');
    // New: the paise sibling, the same figure in paise.
    expect(updated.tdsAmountMinor).toBe('30001');
  });

  it('applyReverseCharge at 18% on 12345.67 writes rcmTaxAmount 2222.22 on the bill', async () => {
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({ vendorName: unique('RCM Vendor'), billDate: new Date(), subtotal: 12345.67 }),
    );
    await asUser(CHAIRMAN, () => applyReverseCharge(bill.id, { ratePct: 18 }));

    const flagged = await asUser(FINANCE, () => flaggedRcmBills());
    const row = flagged.find((b) => b.id === bill.id);
    expect(row).toBeDefined();
    // Old: rcmTaxAmount as a Decimal.
    expect(row!.rcmTaxAmount?.toString()).toBe('2222.22');
    // New: the paise sibling.
    expect(row!.rcmTaxAmountMinor).toBe('222222');
  });
});
