/**
 * Interim policy, pending the accountant's confirmation, extended from money in
 * to money out and to the settlement that follows money in.
 *
 * Money that has left the bank is never refused by a closed month. A TDS challan
 * marked paid, or an advance-tax payment, dated in a closed period is recorded
 * with its real paid date (that date drives interest and the return), gets a
 * `bookedOn` in the current open period, and raises EX-FIN-008. A receipt dated
 * in a closed month is refused, not moved: the order rule keeps every month
 * before a closed one closed, so no open month exists to move it to (the
 * settlement tests below). A dropout (a staff withdrawal) keeps its guard.
 *
 * Real Postgres. The file runs in a books tenant of its own (booksTenant), so
 * the months it closes are not read by any other file. Its closes are windows:
 * closeThrough closes the months a probe needs in ascending order, and
 * reopenLatestFirst reopens them latest first when the window ends.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthKey, round2 } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  prisma,
  reopenLatestFirst,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { markChallanPaid, recordAdvanceTaxPayment } from '../domains/compliance/tax.js';
import { collectInvoicePayment, createInvoice, invoiceLabel } from '../domains/invoicing.js';
import { enrolStudent } from '../domains/education.js';
import { nextRecordCode } from '../platform/recordCode.js';
// Registers the invoice.before_issue hook the course-fee invoice needs, as courseFeeInvoice.test does.
import '../domains/compliance/gst.js';

const CLOSED = '2017-10';

let FIXTURE: BooksTenant;
let TENANT: string;
let FINANCE: string;
let CHAIRMAN: string;

beforeAll(async () => {
  FIXTURE = await booksTenant('money-out-settlement-period');
  TENANT = FIXTURE.tenantId;
  FINANCE = FIXTURE.finance;
  CHAIRMAN = FIXTURE.chairman;
  // A run that stopped inside a close window leaves months closed. Reopen them before this run writes.
  await reopenLatestFirst(FIXTURE, 'Test fixture reset at the start of the run');
  await closeThrough(FIXTURE, CLOSED);
});

afterAll(async () => {
  await reopenLatestFirst(FIXTURE, 'Money out and settlement period tests finished; reopening the months they closed');
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

/** `bookedOn` is added by this round's migration; read through a cast so the test typechecks before it exists. */
function bookedOnOf(row: object): Date | null | undefined {
  return (row as { bookedOn?: Date | null }).bookedOn;
}

async function exceptionsFor(code: string, subjectId: string): Promise<number> {
  return unscopedPrisma.exceptionRecord.count({ where: { tenantId: TENANT, code, subjectId } });
}

/**
 * What a refused collection leaves behind: the invoice as it was before the attempt, and no
 * receipt, payment, final invoice or EX-FIN-009 for it. The EX-FIN-009 detail names the invoice
 * id (receipts.ts issueFinalInvoice), which is how an exception for this attempt is found, since
 * a refused attempt raises no final invoice to key it by.
 */
async function expectRefusedCollectionWroteNothing(invoiceId: string, status: string, label: string): Promise<void> {
  const after = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  expect(after.status).toBe(status);
  expect(after.status).not.toBe('settled');
  expect(await unscopedPrisma.receipt.count({ where: { tenantId: TENANT, invoiceId } })).toBe(0);
  expect(await unscopedPrisma.finalInvoice.count({ where: { tenantId: TENANT, invoiceId } })).toBe(0);
  expect(
    await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: { startsWith: label } } }),
  ).toBe(0);
  expect(
    await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: TENANT, code: 'EX-FIN-009', detail: { contains: invoiceId } },
    }),
  ).toBe(0);
}

describe('Money out — a payment already made is never refused by a closed month', () => {
  it('a TDS challan marked paid with a date in the closed period keeps its real paid date, is booked in the open period, and raises EX-FIN-008', async () => {
    const challan = await unscopedPrisma.tdsChallan.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-PAID-CHALLAN'),
        month: '2026-09',
        sectionGroup: '194C_IND',
        amount: 100,
        deducteeCount: 1,
      },
    });
    const paidOn = new Date('2017-10-15T06:00:00Z');
    await asUser(CHAIRMAN, () =>
      markChallanPaid(challan.id, { bsrCode: '0000000', challanNo: unique('W2-CHL'), paidOn }),
    );

    const after = await unscopedPrisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } });
    expect(after.status).toBe('paid');
    expect(after.paidOn?.toISOString()).toBe(paidOn.toISOString());
    expect(monthKey(bookedOnOf(after) as Date)).toBe(monthKey(new Date()));
    expect(await exceptionsFor('EX-FIN-008', challan.id)).toBe(1);
  });

  it('an advance-tax payment dated in the closed period keeps its real paid date, is booked in the open period, and raises EX-FIN-008', async () => {
    const reference = unique('W2 advance tax paid late');
    await asUser(FINANCE, () =>
      recordAdvanceTaxPayment({
        fy: '2017-18',
        instalmentDate: new Date('2017-10-15T06:00:00Z'),
        amount: 5000,
        paidOn: new Date('2017-10-15T06:00:00Z'),
        reference,
      }),
    );
    const row = await unscopedPrisma.advanceTaxPayment.findFirstOrThrow({ where: { tenantId: TENANT, reference } });
    expect(row.paidOn.toISOString()).toBe('2017-10-15T06:00:00.000Z');
    expect(monthKey(bookedOnOf(row) as Date)).toBe(monthKey(new Date()));
    expect(await exceptionsFor('EX-FIN-008', row.id)).toBe(1);
  });

  it('a payment dated in an open period is booked where it is paid, with no exception', async () => {
    const challan = await unscopedPrisma.tdsChallan.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-OPEN-CHALLAN'),
        month: '2026-09',
        sectionGroup: '194C_IND',
        amount: 100,
        deducteeCount: 1,
      },
    });
    await asUser(CHAIRMAN, () =>
      markChallanPaid(challan.id, {
        bsrCode: '0000000',
        challanNo: unique('W2-OPEN'),
        paidOn: new Date('2026-09-15T06:00:00Z'),
      }),
    );
    const after = await unscopedPrisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } });
    expect(bookedOnOf(after)).toBeNull();
    expect(await exceptionsFor('EX-FIN-008', challan.id)).toBe(0);
  });
});

describe('Settlement — a receipt dated in a closed month is refused, and the course-fee invoice it would settle does not move', () => {
  it('the receipt is refused with 422, and the invoice stays unsettled with no receipt, payment, final invoice or EX-FIN-009', async () => {
    // Set up as the finance principal, so every write runs in a request context.
    const invoice = await asUser(FINANCE, async () => {
      const course = await prisma.course.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('CRS'),
          name: unique('Settle Course'),
          code: unique('SC'),
        },
      });
      const cohort = await prisma.cohort.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('COH'),
          courseId: course.id,
          name: unique('Settle Batch'),
          startDate: new Date(),
          capacity: 30,
        },
      });
      const enrollment = await enrolStudent({
        cohortId: cohort.id,
        fullName: unique('Settle Student'),
        primaryPhone: `9${Date.now()}`.slice(0, 10),
        adultAttested: true,
      });
      // Raised while the current month is still open: a platform invoice cannot be
      // issued into a closed month, and that is not what this probe is about.
      return createInvoice({
        division: 'education',
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });
    });

    const today = monthKey(new Date());
    await closeThrough(FIXTURE, today);
    try {
      const amount = round2(Number(invoice.grandTotal.toString()));
      const before = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      // Closing today's month closes every earlier month too (the order rule, books.ts
      // requestClosePeriod), so 2026-09 is closed and cannot be left open beneath it. A receipt
      // dated into it is refused by the period hook: collectInvoicePayment runs
      // accounting_document.before_write on the receipt date (invoicing.ts:1290), and
      // refuseClosedPeriod throws for a closed month (compliance/books.ts:442). Nothing before
      // that hook can refuse this call: the invoice is issued, the balance is the full amount, and
      // the mode is given. Money that has already moved is rolled forward for gateway payments,
      // which gatewayPaymentPeriod.test.ts covers; a collected invoice payment is not rolled
      // forward, it is refused.
      const refusal = await expectReject(() =>
        asUser(FINANCE, () =>
          collectInvoicePayment(invoice.id, {
            amount,
            mode: 'bank_transfer',
            receivedAt: new Date('2026-09-15T06:00:00Z'),
          }),
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.message).toContain('closed accounting period');
      await expectRefusedCollectionWroteNothing(invoice.id, before.status, invoiceLabel(invoice));
    } finally {
      await reopenLatestFirst(FIXTURE, 'W2 probe finished; reopening the months it closed');
    }
  });
});

describe('Settlement — a receipt dated in a closed month is refused, and the generic invoice it would settle does not move', () => {
  it('the receipt is refused with 422, and the invoice stays unsettled with no receipt, payment, final invoice or EX-FIN-009', async () => {
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });
    const invoice = await asUser(FINANCE, () =>
      createInvoice({
        division: 'education',
        organizationId: org.id,
        lines: [{ description: unique('Generic settle'), unitPrice: 2000, gstRate: 18 }],
      }),
    );

    const today = monthKey(new Date());
    await closeThrough(FIXTURE, today);
    try {
      const amount = round2(Number(invoice.grandTotal.toString()));
      const before = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      // The same refusal as the course-fee case above: 2026-09 is closed by the order rule, and
      // the period hook refuses a receipt dated into it before anything is written.
      const refusal = await expectReject(() =>
        asUser(FINANCE, () =>
          collectInvoicePayment(invoice.id, {
            amount,
            mode: 'bank_transfer',
            receivedAt: new Date('2026-09-15T06:00:00Z'),
          }),
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.message).toContain('closed accounting period');
      await expectRefusedCollectionWroteNothing(invoice.id, before.status, invoiceLabel(invoice));
    } finally {
      await reopenLatestFirst(FIXTURE, 'W2 probe finished; reopening the months it closed');
    }
  });
});
