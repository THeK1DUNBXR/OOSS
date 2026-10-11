/**
 * Interim policy, pending the accountant's confirmation, extended from money in
 * to money out and to the settlement that follows money in.
 *
 * Money that has left the bank is never refused by a closed month. A TDS challan
 * marked paid, or an advance-tax payment, dated in a closed period is recorded
 * with its real paid date (that date drives interest and the return), gets a
 * `bookedOn` in the current open period, and raises EX-FIN-008. A course-fee
 * invoice that a receipt settles gets its final invoice in the open period,
 * with EX-FIN-009. A dropout (a staff withdrawal) keeps its guard.
 *
 * Real Postgres. Periods are closed here and reopened after, as in the other
 * period suites.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { monthKey, round2 } from '@kaizen/shared';
import { asUser, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { markChallanPaid, recordAdvanceTaxPayment } from '../domains/compliance/tax.js';
import { collectInvoicePayment, createInvoice } from '../domains/invoicing.js';
import { enrolStudent } from '../domains/education.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { requestClosePeriod, closePeriod, reopenPeriod } from '../domains/compliance/books.js';
// Registers the invoice.before_issue hook the course-fee invoice needs, as courseFeeInvoice.test does.
import '../domains/compliance/gst.js';

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

/** `bookedOn` is added by this round's migration; read through a cast so the test typechecks before it exists. */
function bookedOnOf(row: object): Date | null | undefined {
  return (row as { bookedOn?: Date | null }).bookedOn;
}

async function exceptionsFor(code: string, subjectId: string): Promise<number> {
  return unscopedPrisma.exceptionRecord.count({ where: { tenantId: TENANT, code, subjectId } });
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

describe('Settlement — a receipt that settles a course-fee invoice is not blocked by a closed current month', () => {
  it('the final invoice is raised in the open period, the receipt stands, and EX-FIN-009 is raised', async () => {
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
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });
    });

    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const amount = round2(Number(invoice.grandTotal.toString()));
      // The money came in during an open month, earlier; it is the settling of
      // the invoice, today, that would have been refused.
      await asUser(FINANCE, () =>
        collectInvoicePayment(invoice.id, {
          amount,
          mode: 'bank_transfer',
          receivedAt: new Date('2026-09-15T06:00:00Z'),
        }),
      );

      const final = await unscopedPrisma.finalInvoice.findFirstOrThrow({
        where: { tenantId: TENANT, invoiceId: invoice.id },
      });
      expect(final.settled).toBe(true);
      expect(monthKey(final.issuedAt)).not.toBe(today);
      expect(await exceptionsFor('EX-FIN-009', final.id)).toBe(1);
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
  });
});

describe('Settlement — a receipt that settles a generic invoice is not blocked by a closed current month', () => {
  it('the statement is raised in the open period, the receipt stands, and EX-FIN-009 is raised', async () => {
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });
    const invoice = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: org.id,
        lines: [{ description: unique('Generic settle'), unitPrice: 2000, gstRate: 18 }],
      }),
    );

    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const amount = round2(Number(invoice.grandTotal.toString()));
      await asUser(FINANCE, () =>
        collectInvoicePayment(invoice.id, {
          amount,
          mode: 'bank_transfer',
          receivedAt: new Date('2026-09-15T06:00:00Z'),
        }),
      );

      const final = await unscopedPrisma.finalInvoice.findFirstOrThrow({
        where: { tenantId: TENANT, invoiceId: invoice.id },
      });
      expect(final.settled).toBe(true);
      expect(monthKey(final.issuedAt)).not.toBe(today);
      expect(await exceptionsFor('EX-FIN-009', final.id)).toBe(1);
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
  });
});
