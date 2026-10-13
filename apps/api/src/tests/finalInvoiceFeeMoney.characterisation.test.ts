/**
 * The course catalogue, fee instalment, credit note and final invoice money as the
 * API sends it, pinned before those columns become paise (ORDERED-PLAN 1.6, slice S3
 * fees): Course.feeAmount, CourseFeePlan.monthlyFee, CourseAddon.price,
 * FeeInstalment.amount, CreditNote.amount, FinalInvoice.totalPayable, totalReceived,
 * creditNoted and balance.
 *
 * Every rupee figure here is the one the old code returns, with its old JSON type:
 * the raw-row routes print the Decimal's two-place string ("12345.67"), the mapped
 * routes print a number (12345.67). The `*Minor` assertions are new and fail on the
 * old code by design. Nothing here moves a paisa: 12345.67 at 18% is 14567.89 on
 * the old float path and on the paise path alike.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, prisma, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { enrolStudent } from '../domains/education.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

let server: Server;
let base: string;
let TENANT: string;
let chairman: TestPrincipal;
let token: string;
/** The catalogue course the first describe creates and the last one prices an invoice from. */
let catalogueCourseId: string;

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

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

async function call(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown) {
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

/** A course, a cohort and one student on it, for an instalment plan to hang off. */
async function anEnrollment() {
  return asUser(CHAIRMAN, async () => {
    const tag = stamp();
    const course = await prisma.course.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `FEE ${tag}`, code: `FEE-${tag}` },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `FEE ${tag} batch`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    return enrolStudent({
      cohortId: cohort.id,
      fullName: `FEE ${tag} student`,
      primaryPhone: `9${Date.now()}`.slice(0, 10),
      adultAttested: true,
    });
  });
}

describe('the course catalogue keeps its rupee figures and gains paise siblings', () => {
  const code = `MNY${stamp()}`;

  it('POST /education/courses: the raw row prints its Decimal fee as a string', async () => {
    const res = await call('POST', '/education/courses', {
      name: 'Money course',
      code,
      feeAmount: 12345.67,
      gstRate: 18,
    });
    expect(res.status).toBe(201);
    catalogueCourseId = res.body.id;
    expect(res.body.feeAmount).toBe('12345.67');
    expect(res.body.gstRate).toBe('18');
    expect.soft(res.body.feeAmountMinor).toBe('1234567');
  });

  it('GET /education/courses: numbers, with the plan and add-on prices alongside', async () => {
    // Plans and add-ons are written on the catalogue edit, which replaces both lists.
    const edit = await call('PATCH', `/education/courses/${catalogueCourseId}`, {
      feeAmount: 12345.67,
      feePlans: [{ tenureMonths: 3, monthlyFee: 4115.22 }],
      addons: [{ name: 'Exam kit', price: 999.99, gstRate: 18 }],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.feeAmount).toBe('12345.67');
    expect.soft(edit.body.feeAmountMinor).toBe('1234567');

    const list = await call('GET', '/education/courses');
    expect(list.status).toBe(200);
    const course = list.body.find((c: { id: string }) => c.id === catalogueCourseId);
    expect(course.feeAmount).toBe(12345.67);
    expect.soft(course.feeAmountMinor).toBe('1234567');
    // 12345.67 at 18% is 14567.89, the same on the float path and the paise path.
    expect(course.feeWithTax).toBe(14567.89);
    expect(course.feePlans[0].monthlyFee).toBe(4115.22);
    expect.soft(course.feePlans[0].monthlyFeeMinor).toBe('411522');
    expect(course.addons[0].price).toBe(999.99);
    expect.soft(course.addons[0].priceMinor).toBe('99999');
  });

  it('PATCH /education/courses/:id: a paisa-bearing fee is stored and echoed exactly', async () => {
    const res = await call('PATCH', `/education/courses/${catalogueCourseId}`, { feeAmount: 2345.67 });
    expect(res.status).toBe(200);
    expect(res.body.feeAmount).toBe('2345.67');
    expect.soft(res.body.feeAmountMinor).toBe('234567');
  });
});

describe('fee instalments and credit notes keep their rupee strings and paise siblings', () => {
  it('POST and GET /finance/fee-instalments: the Decimal amount is a string', async () => {
    const enrollment = await anEnrollment();
    const created = await call('POST', '/finance/fee-instalments', {
      enrollmentId: enrollment.id,
      plan: [{ amount: 12345.67, dueDate: '2026-12-01' }],
    });
    expect(created.status).toBe(201);
    expect(created.body[0].amount).toBe('12345.67');
    expect.soft(created.body[0].amountMinor).toBe('1234567');

    const listed = await call('GET', `/finance/fee-instalments?enrollmentId=${enrollment.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].amount).toBe('12345.67');
    expect.soft(listed.body[0].amountMinor).toBe('1234567');
  });
});

describe('an invoice, its credit note, its receipt and its final invoice', () => {
  let invoiceId: string;
  let creditNoteId: string;

  it('POST /finance/invoices: an issued invoice with a course fee, a paise line and add-on', async () => {
    const org = await anOrganization();
    const res = await call('POST', '/finance/invoices', {
      organizationId: org,
      division: 'education',
      placeOfSupply: '33',
      lines: [{ description: 'Programme', quantity: 1, unitPrice: 1234.57, gstRate: 18 }],
    });
    expect(res.status).toBe(201);
    invoiceId = res.body.id;
    expect(res.body.grandTotal).toBe('1457');
    expect.soft(res.body.grandTotalMinor).toBe('145700');
  });

  it('POST /finance/invoices/:id/credit-note: the raw note prints its amount as a string', async () => {
    const res = await call('POST', `/finance/invoices/${invoiceId}/credit-note`, {
      amount: 12.34,
      reason: 'Goodwill',
    });
    expect(res.status).toBeLessThan(300);
    creditNoteId = res.body.id;
    expect(res.body.amount).toBe('12.34');
    expect.soft(res.body.amountMinor).toBe('1234');

    // The audit diff carries the paise sibling beside the rupee figure.
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'credit_note', subjectId: creditNoteId, action: 'create' },
    });
    // A create's diff is the `after` object as written.
    const diff = audit.diff as Record<string, unknown>;
    expect(diff.amount).toBe(12.34);
    expect.soft(diff.amountMinor).toBe('1234');
  });

  it('GET /finance/invoices/:id/document: the credit note and the position are numbers', async () => {
    const res = await call('GET', `/finance/invoices/${invoiceId}/document`);
    expect(res.status).toBe(200);
    expect(res.body.position.creditNoted).toBe(12.34);
    expect(res.body.position.outstanding).toBe(1444.66);
    expect(res.body.creditNotes[0].amount).toBe(12.34);
    expect.soft(res.body.creditNotes[0].amountMinor).toBe('1234');
  });

  it('POST /finance/invoices/:id/collect, then POST /final-invoice: the statement is in strings', async () => {
    const paid = await call('POST', `/finance/invoices/${invoiceId}/collect`, {
      amount: 1000.25,
      mode: 'upi',
      reference: `UPI-${stamp()}`,
    });
    expect(paid.status).toBeLessThan(300);

    const final = await call('POST', `/finance/invoices/${invoiceId}/final-invoice`, {});
    expect(final.status).toBe(201);
    expect(final.body.totalPayable).toBe('1457');
    expect(final.body.totalReceived).toBe('1000.25');
    expect(final.body.creditNoted).toBe('12.34');
    expect(final.body.balance).toBe('444.41');
    expect
      .soft([
        final.body.totalPayableMinor,
        final.body.totalReceivedMinor,
        final.body.creditNotedMinor,
        final.body.balanceMinor,
      ])
      .toEqual(['145700', '100025', '1234', '44441']);
  });

  it('GET /finance/final-invoices: the list is numbers', async () => {
    const res = await call('GET', `/finance/final-invoices?invoiceId=${invoiceId}`);
    expect(res.status).toBe(200);
    const [row] = res.body;
    expect([row.totalPayable, row.totalReceived, row.creditNoted, row.balance]).toEqual([1457, 1000.25, 12.34, 444.41]);
    expect
      .soft([row.totalPayableMinor, row.totalReceivedMinor, row.creditNotedMinor, row.balanceMinor])
      .toEqual(['145700', '100025', '1234', '44441']);
  });

  it('POST /finance/invoices: a line priced from the catalogue takes the course fee and add-on price', async () => {
    const org = await anOrganization();
    const addon = await unscopedPrisma.courseAddon.findFirstOrThrow({
      where: { courseId: catalogueCourseId, name: 'Exam kit' },
    });

    const res = await call('POST', '/finance/invoices', {
      organizationId: org,
      division: 'education',
      placeOfSupply: '33',
      lines: [
        { courseId: catalogueCourseId, quantity: 1, gstRate: 18 },
        { courseAddonId: addon.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.lines[0].unitPrice).toBe('2345.67');
    expect.soft(res.body.lines[0].unitPriceMinor).toBe('234567');
    expect(res.body.lines[1].unitPrice).toBe('999.99');
    expect.soft(res.body.lines[1].unitPriceMinor).toBe('99999');
  });
});
