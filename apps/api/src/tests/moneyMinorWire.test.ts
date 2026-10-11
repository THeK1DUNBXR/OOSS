/**
 * Every money field on the invoice, payment, receipt, credit note and allocation
 * responses has a `<field>Minor` sibling: paise as a decimal string, read over
 * HTTP through the real router and the real Postgres.
 *
 * The old numeric field stays beside it for one wave, so the web keeps working.
 * The two must agree to the paisa. Odd paise and a seven-figure amount are the
 * two cases where a float on the way out would show: 1456.79 is not exact in
 * binary, and 99,999,999.99 is past what a float holds with its paise intact.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMinor } from '@kaizen/shared';
import { createApp } from '../server.js';
import { principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';

const LATHA = 'latha@kaizen.co.in';
let server: Server;
let base: string;
let TENANT: string;
let latha: TestPrincipal;

beforeAll(async () => {
  TENANT = await tenantId();
  latha = await principalFor(LATHA);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const token = await sessionToken({
    userId: latha.userId,
    tenantId: latha.tenantId,
    affiliationId: latha.affiliationId,
    stepUp: true,
  });
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

/** The old numeric or Decimal-string field, read exactly as the wire carries it. */
function paiseOfWire(value: number | string): string {
  return parseMinor(Number(value).toFixed(2)).toString();
}

async function anAccount() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

async function issueOne(unitPrice: number, gstRate: number) {
  const res = await call('POST', '/finance/invoices', {
    organizationId: await anAccount(),
    placeOfSupply: '33',
    lines: [{ description: 'Programme', quantity: 1, unitPrice, gstRate }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe('an invoice on the wire carries its paise beside each money field', () => {
  it('odd paise: POST /invoices returns Minor for the header and the line', async () => {
    const inv = await issueOne(1234.57, 18);

    // 18% of 1234.57 is 222.2226, rounded per line to 222.22, split 111.11 + 111.11.
    expect(inv.taxableValue).toBe('1234.57');
    expect(inv.taxableValueMinor).toBe('123457');
    expect(inv.cgstAmountMinor).toBe(paiseOfWire(inv.cgstAmount));
    expect(inv.sgstAmountMinor).toBe(paiseOfWire(inv.sgstAmount));
    expect(inv.igstAmountMinor).toBe(paiseOfWire(inv.igstAmount));
    expect(inv.roundOffMinor).toBe(paiseOfWire(inv.roundOff));
    expect(inv.grandTotalMinor).toBe(paiseOfWire(inv.grandTotal));
    expect(inv.grandTotalMinor).toBe('145679');
    expect(inv.amountPayableNowMinor).toBe(paiseOfWire(inv.amountPayableNow));

    const line = inv.lines[0];
    expect(line.unitPriceMinor).toBe('123457');
    expect(line.amountMinor).toBe(paiseOfWire(line.amount));
    expect(line.discountAmountMinor).toBe(paiseOfWire(line.discountAmount));
    expect(line.taxAmountMinor).toBe(paiseOfWire(line.taxAmount));
  });

  it('a large amount: 99,99,99,999.99 survives the wire without a float', async () => {
    const inv = await issueOne(99_999_999.99, 0);
    expect(inv.grandTotalMinor).toBe('9999999999');
    expect(inv.lines[0].amountMinor).toBe('9999999999');
    expect(inv.lines[0].unitPriceMinor).toBe('9999999999');
  });
});

describe('the invoice summary and list carry paise for the header figures', () => {
  it('GET /invoices/:id reports payable, allocated and outstanding in paise after a part payment', async () => {
    const inv = await issueOne(1234.57, 18);

    const collected = await call('POST', `/finance/invoices/${inv.id}/collect`, {
      amount: 500.01,
      mode: 'cash',
      reference: `CASH-${stamp()}`,
    });
    expect(collected.status).toBe(200);
    expect(collected.body.payment.amountMinor).toBe('50001');
    expect(collected.body.receipt.allocatedAmountMinor).toBe('50001');
    expect(collected.body.receipt.subjectTotalMinor).toBe('145679');
    expect(collected.body.receipt.balanceAfterMinor).toBe(paiseOfWire(collected.body.receipt.balanceAfter));
    expect(collected.body.totals.payableMinor).toBe('145679');
    expect(collected.body.totals.allocatedMinor).toBe('50001');
    expect(collected.body.totals.outstandingMinor).toBe('95678');
    expect(collected.body.invoice.grandTotalMinor).toBe('145679');

    const summary = await call('GET', `/finance/invoices/${inv.id}`);
    expect(summary.status).toBe(200);
    expect(summary.body.payableMinor).toBe(paiseOfWire(summary.body.payable));
    expect(summary.body.allocatedMinor).toBe('50001');
    expect(summary.body.outstandingMinor).toBe('95678');
    expect(summary.body.totalMinor).toBe('145679');
    expect(summary.body.invoice.grandTotalMinor).toBe('145679');
    expect(summary.body.invoice.lines[0].unitPriceMinor).toBe('123457');
    expect(summary.body.invoice.receipts[0].allocatedAmountMinor).toBe('50001');
    expect(summary.body.invoice.receipts[0].payment.amountMinor).toBe('50001');
    expect(summary.body.invoice.receipts[0].payment.foreignAmountMinor).toBeNull();
  });

  it('GET /invoices lists each row with its headline paise and its lines', async () => {
    const inv = await issueOne(99_999_999.99, 0);
    await call('POST', `/finance/invoices/${inv.id}/collect`, {
      amount: 99_999_999.98,
      mode: 'cash',
      reference: `CASH-${stamp()}`,
    });

    const list = await call('GET', '/finance/invoices?limit=200');
    expect(list.status).toBe(200);
    const row = list.body.find((r: { id: string }) => r.id === inv.id);
    expect(row).toBeDefined();
    expect(row.totalMinor).toBe('9999999999');
    expect(row.taxableValueMinor).toBe(paiseOfWire(row.taxableValue));
    expect(row.taxAmountMinor).toBe('0');
    expect(row.allocatedMinor).toBe('9999999998');
    expect(row.outstandingMinor).toBe('1');
    expect(row.amountPayableNowMinor).toBe(paiseOfWire(row.amountPayableNow ?? 0));
    expect(row.lines[0].unitPriceMinor).toBe('9999999999');
    expect(row.lines[0].amountMinor).toBe('9999999999');
    expect(row.lines[0].taxAmountMinor).toBe('0');
    expect(row.lines[0].discountAmountMinor).toBe('0');
  });
});

describe('payments, allocations, receipts and credit notes carry paise', () => {
  it('POST /payments, POST /payments/:id/allocate, GET /payments and GET /receipts', async () => {
    const inv = await issueOne(1234.57, 18);

    const created = await call('POST', '/finance/payments', {
      amount: 1000.03,
      gatewayReference: `ALLOC-${stamp()}`,
    });
    expect(created.status).toBe(201);
    expect(created.body.amountMinor).toBe('100003');
    expect(created.body.foreignAmountMinor).toBeNull();

    const allocated = await call('POST', `/finance/payments/${created.body.id}/allocate`, {
      invoiceId: inv.id,
      amount: 300.01,
    });
    expect(allocated.status).toBe(200);
    expect(allocated.body.allocatedAmountMinor).toBe('30001');
    expect(allocated.body.subjectTotalMinor).toBe('145679');
    expect(allocated.body.balanceAfterMinor).toBe(paiseOfWire(allocated.body.balanceAfter));
    expect(allocated.body.balanceAfterMinor).toBe('115678');

    const payments = await call('GET', '/finance/payments');
    const pay = payments.body.find((p: { id: string }) => p.id === created.body.id);
    expect(pay).toBeDefined();
    expect(pay.amountMinor).toBe('100003');
    expect(pay.allocatedMinor).toBe('30001');
    expect(pay.unallocatedMinor).toBe('70002');
    expect(pay.receipts[0].allocatedAmountMinor).toBe('30001');
    expect(pay.receipts[0].balanceAfterMinor).toBe('115678');

    const receipts = await call('GET', `/finance/receipts?invoiceId=${inv.id}`);
    expect(receipts.status).toBe(200);
    const rec = receipts.body.find((r: { id: string }) => r.id === allocated.body.id);
    expect(rec).toBeDefined();
    expect(rec.amountMinor).toBe('30001');
    expect(rec.subjectTotalMinor).toBe('145679');
    expect(rec.balanceAfterMinor).toBe('115678');
  });

  it('POST /invoices/:id/credit-note returns the note with its paise', async () => {
    const inv = await issueOne(1234.57, 18);

    const note = await call('POST', `/finance/invoices/${inv.id}/credit-note`, {
      amount: 100.01,
      reason: 'Rate correction',
    });
    expect(note.status).toBe(200);
    expect(note.body.amountMinor).toBe('10001');
    expect(note.body.amountMinor).toBe(paiseOfWire(note.body.amount));
  });
});
