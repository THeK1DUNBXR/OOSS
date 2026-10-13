/**
 * The receipt, payment and receivables money as the API sends it today, pinned before
 * Payment.amount, Receipt.allocatedAmount / subjectTotal / balanceAfter and
 * ReceivablesProjection.amountOutstanding become paise (ORDERED-PLAN 1.6, slice S3).
 *
 * Every figure here has paise in it, so a conversion that drops or moves one shows.
 * The rupee fields keep their old type and value: a raw-row Decimal is a string on the
 * wire ("300.45", "1457"), a mapped field is a number (300.45). The `*Minor` assertions
 * name columns that exist only after the conversion, so they fail on the old code;
 * that is the point of them.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { reversePayment } from '../domains/finance.js';

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

/** The first object with this id anywhere in a response, however it is nested. */
function findById(node: unknown, id: string): any {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findById(item, id);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    if ((node as { id?: unknown }).id === id) return node;
    for (const value of Object.values(node)) {
      const hit = findById(value, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

// One invoice with paise in it: 1234.57 at 18% is 1456.79 before the round-off, so the
// invoice is payable 1457.00 (the same arithmetic as invoiceMoneyCharacterisation scenario A).
async function anInvoice(org: string) {
  const res = await call('POST', '/finance/invoices', {
    organizationId: org,
    division: 'education',
    placeOfSupply: '33',
    lines: [{ description: 'Programme', quantity: 1, unitPrice: 1234.57, gstRate: 18 }],
  });
  expect(res.status).toBe(201);
  return res.body;
}

// The collection and the allocation are the two writes that make receipts. They share one
// invoice, so the second one reads the position the first left.
describe('a receipt on the wire keeps its rupee figures and gains paise siblings', () => {
  it('A: POST /finance/invoices/:id/collect takes 300.45, the receipt snapshots 1457 and 1156.55', async () => {
    const invoice = await anInvoice(await anOrganization());
    expect(invoice.grandTotal).toBe('1457');
    const collected = await call('POST', `/finance/invoices/${invoice.id}/collect`, { amount: 300.45, mode: 'cash' });
    expect(collected.status).toBe(200);

    // Raw rows are Decimal strings, as the wire always had them.
    expect(collected.body.payment.amount).toBe('300.45');
    expect(collected.body.payment.amountMinor).toBe('30045');
    expect(collected.body.receipt.allocatedAmount).toBe('300.45');
    expect(collected.body.receipt.allocatedAmountMinor).toBe('30045');
    expect(collected.body.receipt.subjectTotal).toBe('1457');
    expect(collected.body.receipt.subjectTotalMinor).toBe('145700');
    expect(collected.body.receipt.balanceAfter).toBe('1156.55');
    expect(collected.body.receipt.balanceAfterMinor).toBe('115655');

    // The mapped totals are numbers, with the paise strings beside them.
    expect(collected.body.totals).toMatchObject({
      payable: 1457,
      allocated: 300.45,
      outstanding: 1156.55,
      payableMinor: '145700',
      allocatedMinor: '30045',
      outstandingMinor: '115655',
    });
  });

  it('A-row: the receipt row holds paise in its own columns', async () => {
    const invoice = await anInvoice(await anOrganization());
    const collected = await call('POST', `/finance/invoices/${invoice.id}/collect`, { amount: 300.45, mode: 'cash' });
    // Fails on the old code: the row has no paise columns yet.
    const row = await unscopedPrisma.receipt.findFirstOrThrow({ where: { id: collected.body.receipt.id } });
    expect(row.allocatedAmountMinor).toBe(30045n);
    expect(row.balanceAfterMinor).toBe(115655n);
    expect(row.subjectTotalMinor).toBe(145700n);
  });

  it('A-audit: the receipt audit diff carries the figure in paise', async () => {
    const invoice = await anInvoice(await anOrganization());
    const collected = await call('POST', `/finance/invoices/${invoice.id}/collect`, { amount: 300.45, mode: 'cash' });
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { subjectType: 'receipt', subjectId: collected.body.receipt.id, action: 'create' },
    });
    expect((audit.diff as any).amount).toBe(300.45);
    // Fails on the old code: the diff has no paise sibling yet.
    expect((audit.diff as any).amountMinor).toBe('30045');
  });

  it('B: POST /finance/payments/:id/allocate of 200.10 against the same invoice', async () => {
    const org = await anOrganization();
    const invoice = await anInvoice(org);
    // Same invoice, same figures as A: 300.45 collected first so the position is 1156.55.
    await call('POST', `/finance/invoices/${invoice.id}/collect`, { amount: 300.45, mode: 'cash' });

    const payment = await call('POST', '/finance/payments', {
      amount: 500.25,
      gatewayReference: `RCV-S3-B-${Date.now()}`,
      payerOrganizationId: org,
    });
    expect(payment.status).toBe(201);
    expect(payment.body.amount).toBe('500.25');
    expect(payment.body.amountMinor).toBe('50025');

    const allocated = await call('POST', `/finance/payments/${payment.body.id}/allocate`, {
      invoiceId: invoice.id,
      amount: 200.1,
    });
    expect(allocated.status).toBe(200);
    expect(allocated.body.allocatedAmount).toBe('200.1');
    expect(allocated.body.allocatedAmountMinor).toBe('20010');
    expect(allocated.body.subjectTotal).toBe('1457');
    expect(allocated.body.balanceAfter).toBe('956.45');
    expect(allocated.body.balanceAfterMinor).toBe('95645');

    // The payment list: numbers for the screen, paise beside each, and the unallocated balance.
    const list = await call('GET', '/finance/payments');
    const row = findById(list.body, payment.body.id);
    expect(row.amount).toBe(500.25);
    expect(row.amountMinor).toBe('50025');
    expect(row.allocated).toBe(200.1);
    expect(row.allocatedMinor).toBe('20010');
    expect(row.unallocated).toBe(300.15);
    expect(row.unallocatedMinor).toBe('30015');
    expect(row.receipts[0].allocatedAmount).toBe(200.1);
    expect(row.receipts[0].allocatedAmountMinor).toBe('20010');
    expect(row.receipts[0].balanceAfter).toBe(956.45);
    expect(row.receipts[0].balanceAfterMinor).toBe('95645');

    // The receipt list and the receipt as a document.
    const receipts = await call('GET', '/finance/receipts');
    const receipt = findById(receipts.body, allocated.body.id);
    expect(receipt.amount).toBe(200.1);
    expect(receipt.amountMinor).toBe('20010');
    expect(receipt.subjectTotal).toBe(1457);
    expect(receipt.subjectTotalMinor).toBe('145700');
    expect(receipt.balanceAfter).toBe(956.45);
    expect(receipt.balanceAfterMinor).toBe('95645');
    expect(receipt.settledIt).toBe(false);

    const doc = await call('GET', `/finance/receipts/${allocated.body.id}/document`);
    expect(doc.status).toBe(200);
    expect(doc.body.payment.amount).toBe(200.1);
    expect(doc.body.position).toMatchObject({
      amountReceivedNow: 200.1,
      totalPayable: 1457,
      balanceAfter: 956.45,
      receivedToDate: 500.55,
    });
    expect(doc.body.sequence.map((s: { amount: number }) => s.amount)).toEqual([300.45, 200.1]);
  });
});

describe('the payment as it is recorded, and the rupee it is recorded at', () => {
  it('C: POST /finance/payments of 12345.675 (three places), as the route accepts a number', async () => {
    // Recorded through the route's number. What Prisma stored for a number with a third place is
    // the figure the paise conversion has to reproduce, so it is pinned here rather than assumed.
    const res = await call('POST', '/finance/payments', {
      amount: 12345.675,
      gatewayReference: `RCV-S3-C-${Date.now()}`,
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe('12345.68');
    expect(res.body.amountMinor).toBe('1234568');
  });
});

describe('a reversal writes the negative of its payment, and the journal reversal still balances', () => {
  it('D: reversePayment writes -500.25 against the payment of 500.25', async () => {
    const payment = await unscopedPrisma.payment.create({
      data: {
        tenantId: TENANT,
        recordCode: `PAY-S3-D-${Date.now()}`,
        amountMinor: 50_025n,
        gatewayReference: `RCV-S3-D-${Date.now()}`,
        receivedAt: new Date(),
      },
    });
    const reversal = await asUser(LATHA, () => reversePayment(payment.id, 'characterisation'));
    // The wire shape the reversal returns: the rupee Decimal, then its paise string.
    expect(String(reversal.amount)).toBe('-500.25');
    expect(reversal.amountMinor).toBe('-50025');
    const row = await unscopedPrisma.payment.findFirstOrThrow({ where: { id: reversal.id } });
    expect(row.reversalOfPaymentId).toBe(payment.id);
    expect(row.amountMinor).toBe(-50_025n);
  });
});

describe('the receivables projection holds what the account still owes, in paise', () => {
  it('E: GET /finance/receivables shows the amount outstanding, with its paise sibling', async () => {
    const org = await anOrganization();
    const invoice = await anInvoice(org);
    await call('POST', `/finance/invoices/${invoice.id}/collect`, { amount: 300.45, mode: 'cash' });

    const list = await call('GET', '/finance/receivables');
    const row = list.body.find((r: { subjectId: string }) => r.subjectId === org);
    expect(row).toBeDefined();
    expect(typeof row.amountOutstanding).toBe('number');
    // The paise sibling exists after the conversion. Fails on the old code.
    expect(typeof row.amountOutstandingMinor).toBe('string');

    const projection = await unscopedPrisma.receivablesProjection.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'account', subjectId: org },
    });
    // The projection row holds paise. Fails on the old code.
    expect(projection.amountOutstandingMinor).toBe(BigInt(row.amountOutstandingMinor));
  });
});
