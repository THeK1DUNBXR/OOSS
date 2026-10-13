/**
 * Characterisation of the GST money columns that become paise (ORDERED-PLAN 1.6,
 * slice S4: GstFiling, RcmSelfInvoice, DebitNote.amount, Gstr2bMatch.difference).
 *
 * This file pins what the API returns today, over HTTP through the real router
 * and the real Postgres, for every endpoint that reads or writes those columns.
 * It is written before the columns move and must pass unchanged after: the
 * figures, and the JSON type each one has on the wire (a Decimal goes out as a
 * string such as "1234.5"), are the contract. The `<field>Minor` siblings are
 * tested in their own file, so this one stays as it is.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { createInvoice } from '../domains/invoicing.js';
import { recordVendorBill } from '../domains/books.js';
import { importGstr2b, rcmLiabilityFor } from '../domains/compliance/gst.js';
import { interest, toMinorHalfUp } from '@kaizen/shared';

const LATHA = 'latha@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';

let server: Server;
let base: string;
let TENANT: string;
let latha: TestPrincipal;
let finance: TestPrincipal;
let ORG: string;

beforeAll(async () => {
  TENANT = await tenantId();
  latha = await principalFor(LATHA);
  finance = await principalFor(FINANCE);
  ORG = await anAccount();
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function call(who: TestPrincipal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const token = await sessionToken({
    userId: who.userId,
    tenantId: who.tenantId,
    affiliationId: who.affiliationId,
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

const GSTIN = '33AAACS9101K1ZI';

async function anAccount() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

function firstDayOf(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 5));
}

/**
 * A tax period no earlier run or suite has touched: no filing, no RCM row, no
 * GSTR-2B import, no invoice. Scanned from a range nothing else uses, so the
 * figures asserted below are this test's own.
 */
async function untouchedPeriod(): Promise<string> {
  for (let year = 1990; year < 2020; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const period = `${year}-${String(month).padStart(2, '0')}`;
      const nextStart = new Date(Date.UTC(year, month, 1));
      const [filing, rcm, imported, invoice] = await Promise.all([
        unscopedPrisma.gstFiling.findFirst({ where: { tenantId: TENANT, period } }),
        unscopedPrisma.rcmSelfInvoice.findFirst({ where: { tenantId: TENANT, period } }),
        unscopedPrisma.gstr2bImport.findFirst({ where: { tenantId: TENANT, period } }),
        unscopedPrisma.invoice.findFirst({
          where: { tenantId: TENANT, issuedDate: { gte: firstDayOf(period), lt: nextStart } },
        }),
      ]);
      if (!filing && !rcm && !imported && !invoice) return period;
    }
  }
  throw new Error('No untouched period left.');
}

function currentIstPeriod(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 7);
}

describe('debit notes: the amount as it goes on the wire', () => {
  it('a Decimal amount goes out as a minimal decimal string, and the list agrees', async () => {
    const period = await untouchedPeriod();
    const invoice = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: ORG,
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Under-billed', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
      }),
    );

    const amounts = [99.5, 1234.56, 0.1, 1000];
    const written: Array<Record<string, unknown>> = [];
    for (const amount of amounts) {
      const res = await call(finance, 'POST', `/compliance/gst/invoices/${invoice.id}/debit-note`, {
        amount,
        reasonCode: 'other',
        note: `probe ${stamp()}`,
      });
      expect(res.status).toBe(200);
      written.push(res.body);
    }

    expect(written.map((n) => n.amount)).toEqual(['99.5', '1234.56', '0.1', '1000']);
    expect(written.every((n) => typeof n.amount === 'string')).toBe(true);
    expect(written[0]).toMatchObject({ reasonCode: 'other', currency: 'INR' });

    // Input is a JavaScript number, rounded to two places by round2 (with an
    // EPSILON nudge) before it is stored. 1.005 comes out 1.01 today. Pinned so
    // the boundary change keeps the same answer on this tie.
    const tie = await call(finance, 'POST', `/compliance/gst/invoices/${invoice.id}/debit-note`, {
      amount: 1.005,
      reasonCode: 'other',
    });
    expect(tie.body.amount).toBe('1.01');

    const list = await call(finance, 'GET', `/compliance/gst/debit-notes?invoiceId=${invoice.id}`);
    expect(list.status).toBe(200);
    const listed = (list.body as Array<{ id: string; amount: unknown }>).map((n) => n.amount);
    expect([...listed].sort()).toEqual(['0.1', '1.01', '1000', '1234.56', '99.5']);
    const byId = new Map((list.body as Array<{ id: string; amount: unknown }>).map((n) => [n.id, n.amount]));
    expect(byId.get(written[1]!.id as string)).toBe('1234.56');
  });

  it('GSTR-1 carries each debit note as a number and totals them to the paisa', async () => {
    const res = await call(latha, 'GET', `/books/gst/gstr1?period=${currentIstPeriod()}`);
    expect(res.status).toBe(200);
    const debitNotes = res.body.debitNotes as Array<{ amount: number }>;
    expect(debitNotes.length).toBeGreaterThan(0);
    for (const note of debitNotes) expect(typeof note.amount).toBe('number');
    const sum = debitNotes.reduce((s, d) => s + d.amount, 0);
    expect(toMinorHalfUp(res.body.totals.debitNoted)).toBe(toMinorHalfUp(sum));
    expect(debitNotes.some((d) => d.amount === 1234.56)).toBe(true);
  });
});

describe('reverse charge: the self-invoice as it goes on the wire', () => {
  it('a self-invoice and the period list carry Decimal strings, and the liability sums to the paisa', async () => {
    const period = await untouchedPeriod();
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: 'Probe Counsel',
        vendorGstin: GSTIN,
        billNumber: `${period}-RCM`,
        billDate: firstDayOf(period),
        subtotal: 1234.56,
      }),
    );

    const res = await call(finance, 'POST', `/compliance/gst/vendor-bills/${bill.id}/rcm`, { ratePct: 18 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ period, taxableValue: '1234.56', cgstAmount: '111.11', sgstAmount: '111.11' });
    expect(res.body.igstAmount).toBe('0');
    expect(res.body.number).toMatch(/^RCM-\d{4}-\d{5}$/);

    const list = await call(finance, 'GET', `/compliance/gst/rcm/self-invoices?period=${period}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ taxableValue: '1234.56', cgstAmount: '111.11', sgstAmount: '111.11' });

    const liability = await asUser(FINANCE, () => rcmLiabilityFor(period));
    expect(liability).toEqual({ taxableValue: 1234.56, cgst: 111.11, sgst: 111.11, igst: 0 });
  });
});

describe('GSTR-2B match: the difference as it goes on the wire', () => {
  it('a fractional and a negative difference cross as Decimal strings', async () => {
    const period = await untouchedPeriod();
    const billDate = firstDayOf(period);
    await asUser(FINANCE, async () => {
      for (const n of [1, 2, 3]) {
        await recordVendorBill({
          vendorName: `Recon Co ${n}`,
          vendorGstin: GSTIN,
          billNumber: `${period}-R${n}`,
          billDate,
          subtotal: 1000,
          taxAmount: 180,
        });
      }
    });
    const row = (inum: string, camt: number, samt: number) => ({
      ctin: GSTIN,
      inum,
      idt: `05-${period.slice(5)}-${period.slice(0, 4)}`,
      val: camt + samt + 1000,
      itms: [{ txval: 1000, camt, samt }],
    });
    await asUser(FINANCE, () =>
      importGstr2b({
        period,
        b2b: [
          row(`${period}-R1`, 90.37, 90.37), // 180.74 against 180.00 on the books
          row(`${period}-R2`, 89.5, 90.37), // 179.87 against 180.00: negative
          // R3 is absent from 2B: missing_in_2b, the books' 180.00 is the difference.
        ],
      }),
    );

    const res = await call(finance, 'GET', `/compliance/gst/gstr2b/${period}/matches`);
    expect(res.status).toBe(200);
    const diffs = (res.body as Array<{ status: string; difference: unknown }>).map((m) => [m.status, m.difference]);
    expect(
      diffs
        .filter(([s]) => s === 'mismatch')
        .map(([, d]) => d)
        .sort(),
    ).toEqual(['-0.13', '0.74']);
    expect(diffs.filter(([s]) => s === 'missing_in_2b').map(([, d]) => d)).toEqual(['-180']);
    for (const [, d] of diffs) expect(typeof d).toBe('string');
  });
});

describe('GST filings: the figures as they go on the wire', () => {
  it('prepare, list, detail and file carry the same totals, and the exposure reads the net payable', async () => {
    const period = await untouchedPeriod();
    await asUser(LATHA, () =>
      createInvoice({
        organizationId: ORG,
        placeOfSupply: '33',
        customerGstin: GSTIN,
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Reported', unitPrice: 1000.37, gstRate: 18, hsnSac: '998314' }],
      }),
    );

    const prepared = await call(latha, 'POST', '/books/gst/filings', { returnType: 'GSTR1', period });
    expect(prepared.status).toBe(201);
    const filing = prepared.body.filing;
    expect(filing).toMatchObject({
      status: 'prepared',
      returnType: 'GSTR1',
      period,
      taxableValue: '1000.37',
      cgstAmount: '90.04',
      sgstAmount: '90.03',
      igstAmount: '0',
      inputTaxCredit: '0',
      netPayable: '180.07',
      invoiceCount: 1,
    });
    expect(typeof filing.taxableValue).toBe('string');
    expect(typeof filing.netPayable).toBe('string');

    const list = await call(latha, 'GET', `/books/gst/filings?returnType=GSTR1&period=${period}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      taxableValue: 1000.37,
      cgstAmount: 90.04,
      sgstAmount: 90.03,
      igstAmount: 0,
      inputTaxCredit: 0,
      netPayable: 180.07,
      invoiceCount: 1,
    });
    expect(typeof list.body[0].netPayable).toBe('number');

    const detail = await call(latha, 'GET', `/books/gst/filings/${filing.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ taxableValue: '1000.37', netPayable: '180.07', status: 'prepared' });

    const filed = await call(latha, 'POST', `/books/gst/filings/${filing.id}/file`, { arn: `AA33${stamp()}` });
    expect(filed.status).toBe(200);
    expect(filed.body).toMatchObject({ status: 'filed', taxableValue: '1000.37', netPayable: '180.07' });
  });

  it('the exposure reads the prepared GSTR-3B net payable, and the cash interest follows from it', async () => {
    const period = await untouchedPeriod();
    const billDate = firstDayOf(period);
    await asUser(LATHA, () =>
      createInvoice({
        organizationId: ORG,
        placeOfSupply: '33',
        customerGstin: GSTIN,
        issuedDate: billDate,
        lines: [{ description: 'Outward', unitPrice: 1000.37, gstRate: 18, hsnSac: '998314' }],
      }),
    );

    const prepared = await call(latha, 'POST', '/books/gst/filings', { returnType: 'GSTR3B', period });
    expect(prepared.status).toBe(201);
    expect(prepared.body.filing).toMatchObject({
      returnType: 'GSTR3B',
      taxableValue: '1000.37',
      inputTaxCredit: '0',
      netPayable: '180.07',
    });

    const exposure = await call(latha, 'GET', `/compliance/gst/exposure/${period}`);
    expect(exposure.status).toBe(200);
    const gstr3b = (exposure.body.returns as Array<Record<string, unknown>>).find((r) => r.returnType === 'GSTR3B');
    expect(gstr3b).toBeDefined();
    expect(gstr3b).toMatchObject({ filed: false, nil: false });
    // Net payable is 180.07 and the period is years late: the late fee is at the
    // cap, and the interest is the shared interest() on the paise-exact net cash.
    expect(gstr3b!.lateFee).toBe(5000);
    expect(typeof gstr3b!.interest).toBe('number');
    expect(gstr3b!.interest).toBe(interest(180.07, gstr3b!.daysLate as number, 18));
    expect(gstr3b!.interest as number).toBeGreaterThan(0);
  });
});
