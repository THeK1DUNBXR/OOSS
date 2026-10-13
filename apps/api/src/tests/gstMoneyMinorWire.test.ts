/**
 * The GST money columns that became paise (ORDERED-PLAN 1.6, slice S4) carry a
 * `<field>Minor` sibling on every response that used to carry the rupee field.
 * The rupee field is unchanged (it is what the web reads); the sibling is the
 * same figure as a decimal string of paise. The two must agree to the paisa.
 *
 * gstMoneyCharacterisation.test.ts pins the rupee fields and their JSON types
 * and is not edited by this change; this file is where the siblings live.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toMinorHalfUp } from '@kaizen/shared';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { createInvoice } from '../domains/invoicing.js';
import { recordVendorBill } from '../domains/books.js';
import { importGstr2b } from '../domains/compliance/gst.js';
import { decimalWire, rupeesOf } from '../platform/wire.js';

const LATHA = 'latha@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';
const GSTIN = '33AAACS9101K1ZI';

let server: Server;
let base: string;
let TENANT: string;
let ORG: string;
let latha: TestPrincipal;
let finance: TestPrincipal;

beforeAll(async () => {
  TENANT = await tenantId();
  latha = await principalFor(LATHA);
  finance = await principalFor(FINANCE);
  const account = await unscopedPrisma.account.findFirstOrThrow({ where: { tenantId: TENANT, gstin: { not: null } } });
  ORG = account.organizationId;
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

function firstDayOf(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 5));
}

/** An untouched period in the past, so a return prepared in it is late and has an exposure. */
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

describe('the decimal and rupee helpers agree with Prisma Decimal printing', () => {
  it('decimalWire prints the digits a Decimal prints, with trailing zeros dropped', () => {
    expect(decimalWire(0n)).toBe('0');
    expect(decimalWire(1n)).toBe('0.01');
    expect(decimalWire(100n)).toBe('1');
    expect(decimalWire(123_450n)).toBe('1234.5');
    expect(decimalWire(123_456n)).toBe('1234.56');
    expect(decimalWire(-13n)).toBe('-0.13');
    expect(decimalWire(-100_000n)).toBe('-1000');
  });

  it('rupeesOf prints back as the Decimal string, so the number carries the paise exactly', () => {
    const samples: bigint[] = [0n, 1n, 5n, 10n, 99n, 100n, 180_066n, 123_456n, -13n, 99_999_999_999n];
    let seed = 20261013;
    for (let i = 0; i < 2000; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples.push(BigInt(seed) * (i % 2 === 0 ? 1n : -1n));
    }
    // The shortest decimal that reads back as the double is the Decimal string,
    // so no paisa is lost between the paise column and the rupee number.
    for (const minor of samples) {
      expect(String(rupeesOf(minor))).toBe(decimalWire(minor));
      expect(toMinorHalfUp(rupeesOf(minor))).toBe(minor);
    }
  });
});

describe('the paise siblings on the wire', () => {
  it('a debit note carries amountMinor beside its rupee amount', async () => {
    const period = await untouchedPeriod();
    const invoice = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: ORG,
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Under-billed', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
      }),
    );
    const res = await call(finance, 'POST', `/compliance/gst/invoices/${invoice.id}/debit-note`, {
      amount: 1234.56,
      reasonCode: 'other',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: '1234.56', amountMinor: '123456' });

    const list = await call(finance, 'GET', `/compliance/gst/debit-notes?invoiceId=${invoice.id}`);
    expect(list.body[0]).toMatchObject({ amount: '1234.56', amountMinor: '123456' });
  });

  it('a self-invoice and the liability carry the paise of each figure', async () => {
    const period = await untouchedPeriod();
    const bill = await asUser(FINANCE, () =>
      recordVendorBill({
        vendorName: 'Sibling Counsel',
        vendorGstin: GSTIN,
        billNumber: `${period}-SIB`,
        billDate: firstDayOf(period),
        subtotal: 1234.56,
      }),
    );
    const res = await call(finance, 'POST', `/compliance/gst/vendor-bills/${bill.id}/rcm`, { ratePct: 18 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      taxableValue: '1234.56',
      taxableValueMinor: '123456',
      cgstAmount: '111.11',
      cgstAmountMinor: '11111',
      sgstAmount: '111.11',
      sgstAmountMinor: '11111',
      igstAmount: '0',
      igstAmountMinor: '0',
    });
  });

  it('a 2B match difference carries differenceMinor, negative and fractional alike', async () => {
    const period = await untouchedPeriod();
    const billDate = firstDayOf(period);
    await asUser(FINANCE, async () => {
      await recordVendorBill({
        vendorName: 'Sibling Co',
        vendorGstin: GSTIN,
        billNumber: `${period}-S1`,
        billDate,
        subtotal: 1000,
        taxAmount: 180,
      });
      await importGstr2b({
        period,
        b2b: [
          {
            ctin: GSTIN,
            inum: `${period}-S1`,
            idt: `05-${period.slice(5)}-${period.slice(0, 4)}`,
            val: 1180,
            itms: [{ txval: 1000, camt: 89.5, samt: 90.37 }],
          },
        ],
      });
    });
    const res = await call(finance, 'GET', `/compliance/gst/gstr2b/${period}/matches`);
    const mismatch = (res.body as Array<{ status: string }>).find((m) => m.status === 'mismatch');
    expect(mismatch).toMatchObject({ difference: '-0.13', differenceMinor: '-13' });
  });

  it('a filing carries the paise of every money field, in prepare, list, detail and file', async () => {
    const period = await untouchedPeriod();
    await asUser(LATHA, () =>
      createInvoice({
        organizationId: ORG,
        placeOfSupply: '33',
        customerGstin: GSTIN,
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Sibling', unitPrice: 1000.37, gstRate: 18, hsnSac: '998314' }],
      }),
    );

    const prepared = await call(latha, 'POST', '/books/gst/filings', { returnType: 'GSTR1', period });
    expect(prepared.status).toBe(201);
    const expected = {
      taxableValue: '1000.37',
      taxableValueMinor: '100037',
      cgstAmount: '90.04',
      cgstAmountMinor: '9004',
      sgstAmount: '90.03',
      sgstAmountMinor: '9003',
      igstAmount: '0',
      igstAmountMinor: '0',
      inputTaxCredit: '0',
      inputTaxCreditMinor: '0',
      netPayable: '180.07',
      netPayableMinor: '18007',
    };
    expect(prepared.body.filing).toMatchObject(expected);

    const filingId = prepared.body.filing.id as string;
    const detail = await call(latha, 'GET', `/books/gst/filings/${filingId}`);
    expect(detail.body).toMatchObject(expected);

    const list = await call(latha, 'GET', `/books/gst/filings?returnType=GSTR1&period=${period}`);
    expect(list.body[0]).toMatchObject({
      taxableValue: 1000.37,
      taxableValueMinor: '100037',
      netPayable: 180.07,
      netPayableMinor: '18007',
    });

    const filed = await call(latha, 'POST', `/books/gst/filings/${filingId}/file`, { arn: `AA33${stamp()}` });
    expect(filed.body).toMatchObject({ status: 'filed', netPayable: '180.07', netPayableMinor: '18007' });
  });
});
