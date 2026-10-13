/**
 * The invoice's money as the API sends it today, pinned before the Invoice and
 * InvoiceLine money columns become paise (ORDERED-PLAN 1.6, MONEY-S3).
 *
 * The rupee fields on the raw-row wire are strings ("1234.57", "1457", "-0.44"):
 * the Decimal's own printed form, which drops trailing zeros. The summary, the
 * document and the list carry numbers. Every value here is what the old code
 * returned, checked by hand against the GST arithmetic in the comments. A paise
 * conversion that moves any of them is a change to what a customer is billed.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';

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

async function anOrganization() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

// Scenario A: one odd-paise line at 18%. 18% of 1234.57 is 222.2226, rounded to
// 222.22 and split 111.11 and 111.11. The total is 1456.79, rounded up to 1457.
async function createA(org: string) {
  return call('POST', '/finance/invoices', {
    organizationId: org,
    placeOfSupply: '33',
    lines: [{ description: 'Programme', quantity: 1, unitPrice: 1234.57, gstRate: 18 }],
  });
}

// Scenario B: a percentage discount and a flat discount on two lines. The first
// line is 2 x 99.99 = 199.98 less 7.5% (15), so 184.98 at 12% is 22.20. The
// second is 3 x 0.10 = 0.30 less 0.05, so 0.25 at 5% is 0.01. Taxable 185.23,
// tax 22.21, total 207.44, rounded to 207 with a round-off of -0.44.
async function createB(org: string) {
  return call('POST', '/finance/invoices', {
    organizationId: org,
    placeOfSupply: '27',
    lines: [
      { description: 'Seat', quantity: 2, unitPrice: 99.99, gstRate: 12, discountPercent: 7.5 },
      { description: 'Kit', quantity: 3, unitPrice: 0.1, gstRate: 5, discountAmount: 0.05 },
    ],
  });
}

// Scenario C: an exempt-rate line whose total rounds down, so the round-off is negative.
async function createC(org: string) {
  return call('POST', '/finance/invoices', {
    organizationId: org,
    placeOfSupply: '33',
    lines: [{ description: 'Exempt fee', quantity: 1, unitPrice: 1000.49, gstRate: 0 }],
  });
}

// Scenario D: a draft with a flat discount, then issued. 4 x 250.25 = 1001.00
// less 10.10 is 990.90. Tax 178.36, total 1169.26, round-off -0.26.
async function createD(org: string) {
  return call('POST', '/finance/invoices', {
    organizationId: org,
    placeOfSupply: '27',
    issue: false,
    lines: [{ description: 'Draft seat', quantity: 4, unitPrice: 250.25, gstRate: 18, discountAmount: 10.1 }],
  });
}

describe('the raw invoice on the wire keeps its rupee strings and paise siblings', () => {
  it('A: POST /finance/invoices, odd paise on one line', async () => {
    const res = await createA(await anOrganization());
    expect(res.status).toBe(201);
    const inv = res.body;
    expect(inv.taxableValue).toBe('1234.57');
    expect(inv.cgstAmount).toBe('111.11');
    expect(inv.sgstAmount).toBe('111.11');
    expect(inv.igstAmount).toBe('0');
    expect(inv.roundOff).toBe('0.21');
    expect(inv.grandTotal).toBe('1457');
    expect(inv.amountPayableNow).toBe('0');
    expect([inv.taxableValueMinor, inv.cgstAmountMinor, inv.sgstAmountMinor, inv.igstAmountMinor]).toEqual([
      '123457',
      '11111',
      '11111',
      '0',
    ]);
    expect([inv.roundOffMinor, inv.grandTotalMinor, inv.amountPayableNowMinor]).toEqual(['21', '145700', '0']);

    const line = inv.lines[0];
    expect(line.unitPrice).toBe('1234.57');
    expect(line.amount).toBe('1234.57');
    expect(line.discountAmount).toBe('0');
    expect(line.taxAmount).toBe('222.22');
    expect([line.unitPriceMinor, line.amountMinor, line.discountAmountMinor, line.taxAmountMinor]).toEqual([
      '123457',
      '123457',
      '0',
      '22222',
    ]);
  });

  it('B: inter-state, two lines with a percentage and a flat discount', async () => {
    const inv = (await createB(await anOrganization())).body;
    expect(inv.taxableValue).toBe('185.23');
    expect(inv.cgstAmount).toBe('11.11');
    expect(inv.sgstAmount).toBe('11.1');
    expect(inv.igstAmount).toBe('0');
    expect(inv.roundOff).toBe('-0.44');
    expect(inv.grandTotal).toBe('207');
    expect([
      inv.taxableValueMinor,
      inv.cgstAmountMinor,
      inv.sgstAmountMinor,
      inv.roundOffMinor,
      inv.grandTotalMinor,
    ]).toEqual(['18523', '1111', '1110', '-44', '20700']);

    const [seat, kit] = inv.lines;
    expect([seat.unitPrice, seat.amount, seat.discountAmount, seat.discountPercent, seat.taxAmount]).toEqual([
      '99.99',
      '184.98',
      '15',
      '7.5',
      '22.2',
    ]);
    expect([seat.unitPriceMinor, seat.amountMinor, seat.discountAmountMinor, seat.taxAmountMinor]).toEqual([
      '9999',
      '18498',
      '1500',
      '2220',
    ]);
    expect([kit.unitPrice, kit.amount, kit.discountAmount, kit.discountPercent, kit.taxAmount]).toEqual([
      '0.1',
      '0.25',
      '0.05',
      '16.67',
      '0.01',
    ]);
    expect([kit.unitPriceMinor, kit.amountMinor, kit.discountAmountMinor, kit.taxAmountMinor]).toEqual([
      '10',
      '25',
      '5',
      '1',
    ]);
  });

  it('C: a negative round-off and an exempt line carry no tax', async () => {
    const inv = (await createC(await anOrganization())).body;
    expect(inv.taxableValue).toBe('1000.49');
    expect([inv.cgstAmount, inv.sgstAmount, inv.igstAmount]).toEqual(['0', '0', '0']);
    expect(inv.roundOff).toBe('-0.49');
    expect(inv.grandTotal).toBe('1000');
    expect([inv.taxableValueMinor, inv.roundOffMinor, inv.grandTotalMinor]).toEqual(['100049', '-49', '100000']);
    expect(inv.lines[0].taxAmount).toBe('0');
    expect(inv.lines[0].taxAmountMinor).toBe('0');
  });

  it('D: a draft keeps its figures when issued', async () => {
    const draft = (await createD(await anOrganization())).body;
    expect(draft.status).toBe('draft');
    expect(draft.taxableValue).toBe('990.9');
    expect(draft.cgstAmount).toBe('89.18');
    expect(draft.roundOff).toBe('-0.26');
    expect(draft.grandTotal).toBe('1169');
    expect([draft.taxableValueMinor, draft.cgstAmountMinor, draft.grandTotalMinor]).toEqual([
      '99090',
      '8918',
      '116900',
    ]);
    expect(draft.lines[0].unitPrice).toBe('250.25');
    expect(draft.lines[0].amount).toBe('990.9');
    expect(draft.lines[0].discountAmount).toBe('10.1');
    expect(draft.lines[0].taxAmount).toBe('178.36');

    const issued = await call('POST', `/finance/invoices/${draft.id}/issue`, {});
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.grandTotal).toBe('1169');
    expect(issued.body.grandTotalMinor).toBe('116900');
    expect(issued.body.lines[0].amount).toBe('990.9');
    expect(issued.body.lines[0].amountMinor).toBe('99090');
  });
});

describe('the summary, the document and the list carry the same figures as numbers and paise', () => {
  it('GET /finance/invoices/:id reports payable and outstanding for A', async () => {
    const inv = (await createA(await anOrganization())).body;
    const summary = await call('GET', `/finance/invoices/${inv.id}`);
    expect(summary.status).toBe(200);
    expect([summary.body.payable, summary.body.allocated, summary.body.creditNoted, summary.body.outstanding]).toEqual([
      1457, 0, 0, 1457,
    ]);
    expect([summary.body.payableMinor, summary.body.outstandingMinor, summary.body.totalMinor]).toEqual([
      '145700',
      '145700',
      '145700',
    ]);
    expect(summary.body.invoice.grandTotal).toBe('1457');
    expect(summary.body.invoice.lines[0].unitPrice).toBe('1234.57');
  });

  it('GET /finance/invoices/:id/document prints B with numbers and the amount in words', async () => {
    const inv = (await createB(await anOrganization())).body;
    const doc = await call('GET', `/finance/invoices/${inv.id}/document`);
    expect(doc.status).toBe(200);
    const [seat, kit] = doc.body.lines;
    expect([seat.unitPrice, seat.grossAmount, seat.amount, seat.discountAmount, seat.taxAmount]).toEqual([
      99.99, 199.98, 184.98, 15, 22.2,
    ]);
    expect([kit.grossAmount, kit.amount, kit.discountAmount, kit.taxAmount]).toEqual([0.3, 0.25, 0.05, 0.01]);
    expect([
      doc.body.tax.taxableValue,
      doc.body.tax.cgst,
      doc.body.tax.sgst,
      doc.body.tax.igst,
      doc.body.tax.roundOff,
    ]).toEqual([185.23, 11.11, 11.1, 0, -0.44]);
    expect(doc.body.totals.totalPayable).toBe(207);
    expect(doc.body.totals.inWords).toBe('Rupees Two Hundred and Seven Only');
    expect(doc.body.position.outstanding).toBe(207);
  });

  it('GET /finance/invoices lists B with its headline paise and its line figures', async () => {
    const inv = (await createB(await anOrganization())).body;
    const list = await call('GET', '/finance/invoices?limit=200');
    expect(list.status).toBe(200);
    const row = list.body.find((r: { id: string }) => r.id === inv.id);
    expect(row).toBeDefined();
    expect([row.total, row.taxableValue, row.taxAmount, row.outstanding, row.amountPayableNow]).toEqual([
      207, 185.23, 22.21, 207, 0,
    ]);
    expect([row.totalMinor, row.taxableValueMinor, row.taxAmountMinor, row.outstandingMinor]).toEqual([
      '20700',
      '18523',
      '2221',
      '20700',
    ]);
    expect(row.lines[0].unitPrice).toBe(99.99);
    expect(row.lines[0].unitPriceMinor).toBe('9999');
    expect(row.lines[1].amountMinor).toBe('25');
  });
});

// The invoice path writes no journal lines today: issue and collect move the
// invoice's own figures and its receipt, and buildInvoiceIssueEntry (postingRules.ts)
// has no caller outside the ledger tests. So the trial balance cannot move, and this
// pins that: a conversion that starts posting, or posts a different amount, changes
// the line count or the balance and fails here.
describe('issuing D and collecting against it leaves the journal as it was', () => {
  it('the trial balance holds and its line count does not move', async () => {
    const trial = () => asUser(LATHA, async () => journalTrialBalance(new Date()));
    const before = await trial();
    const draft = (await createD(await anOrganization())).body;

    const issued = await call('POST', `/finance/invoices/${draft.id}/issue`, {});
    expect(issued.status).toBe(200);
    const afterIssue = await trial();
    expect(() => assertTrialBalance(afterIssue)).not.toThrow();
    expect(afterIssue.lineCount).toBe(before.lineCount);

    const collected = await call('POST', `/finance/invoices/${draft.id}/collect`, { amount: 300, mode: 'cash' });
    expect(collected.status).toBe(200);
    const afterCollect = await trial();
    expect(() => assertTrialBalance(afterCollect)).not.toThrow();
    expect(afterCollect.lineCount).toBe(before.lineCount);

    const summary = await call('GET', `/finance/invoices/${draft.id}`);
    expect(summary.body.outstanding).toBe(869);
    expect(summary.body.outstandingMinor).toBe('86900');
  });
});
