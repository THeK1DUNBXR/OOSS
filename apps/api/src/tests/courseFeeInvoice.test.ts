/**
 * The course-fee lifecycle: a temp invoice tracks instalments internally,
 * receipts are the only document the student holds along the way, and a
 * single final (tax) invoice locks in automatically — either the moment the
 * balance reaches zero, or the moment the student withdraws, nil receipts
 * included. Neither is ever raised on demand.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { round2 } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { collectInvoicePayment, createInvoice, invoiceDocument } from '../domains/invoicing.js';
import { finalInvoiceDocument, finalizeCourseFeeInvoice, listFinalInvoices, raiseFinalInvoice, receiptDocument } from '../domains/receipts.js';
import { enrolStudent, setEnrollmentStatus } from '../domains/education.js';
// Registers the invoice.before_issue classification hook as a side effect —
// production loads this transitively through its server bootstrap, but a
// standalone test file has to pull it in itself.
import '../domains/compliance/gst.js';

const EMPLOYEE = 'chairman@kaizen.co.in';

describe('the course-fee invoice lifecycle', () => {
  let TENANT: string;
  beforeAll(async () => {
    TENANT = await tenantId();
  });

  async function anEnrollment(tag: string) {
    const course = await prisma.course.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `${tag} Course`, code: `${tag}-C` },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${tag} Batch`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    const enrollment = await enrolStudent({ cohortId: cohort.id, fullName: `${tag} Student`, primaryPhone: `9${Date.now()}`.slice(0, 10) });
    return { course, cohort, enrollment };
  }

  it('raises a course-fee invoice in the temp series, never the tax one', async () => {
    await asUser(EMPLOYEE, async () => {
      const { enrollment } = await anEnrollment(`TEMP${Date.now()}`);
      const invoice = await createInvoice({
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });

      expect(invoice.recordCode).toMatch(/^KIPL\/temp\/\d{2}-\d{2}\/\d{3,}$/);
      expect(invoice.invoiceType).toBe('temp');

      const doc = await invoiceDocument(invoice.id);
      expect(doc.isTempInvoice).toBe(true);
      expect(doc.position.canRaiseFinalInvoice).toBe(false);
      expect(doc.position.finalizeCourseFeeInvoiceNote).toBeTruthy();

      // Never raisable on demand — only the automatic paths reach it.
      await expectReject(() => raiseFinalInvoice(invoice.id));
    });
  });

  it('locks the final (tax) invoice the instant the last instalment settles it, in the TI series', async () => {
    await asUser(EMPLOYEE, async () => {
      const { enrollment } = await anEnrollment(`SETTLE${Date.now()}`);
      const invoice = await createInvoice({
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });
      const grandTotal = Number(invoice.grandTotal.toString());

      // Part payment: nothing finalised yet.
      const part = await collectInvoicePayment(invoice.id, { amount: 20_000, mode: 'cash', reference: `T1-${Date.now()}` });
      expect(part.finalInvoice).toBeNull();
      expect((await listFinalInvoices({ invoiceId: invoice.id })).length).toBe(0);

      // The receipt is its own document, and it says so.
      const receipt = await receiptDocument(part.receipt.id);
      expect(receipt.invoice.isTempInvoice).toBe(true);

      // The balance-clearing instalment locks the final invoice, once, in
      // the TI series, dated today.
      const rest = await collectInvoicePayment(invoice.id, {
        amount: round2(grandTotal - 20_000),
        mode: 'upi',
        reference: `T2-${Date.now()}`,
      });
      expect(rest.finalInvoice).not.toBeNull();
      expect(rest.finalInvoice!.recordCode).toMatch(/^KIPL\/TI\/\d{2}-\d{2}\/\d{3,}$/);

      const doc = await finalInvoiceDocument(rest.finalInvoice!.id);
      expect(doc.isTaxInvoice).toBe(true);
      expect(doc.triggerReason).toBe('settled');
      expect(doc.totals.settled).toBe(true);
      expect(doc.totals.instalments).toBe(2);
      expect(doc.status).toBe('issued');

      // Idempotent: nothing left to trigger a second one from, and calling
      // the finaliser directly again just hands the same one back.
      const again = await finalizeCourseFeeInvoice(invoice.id, 'settled');
      expect(again.id).toBe(rest.finalInvoice!.id);
      expect((await listFinalInvoices({ invoiceId: invoice.id })).length).toBe(1);
    });
  });

  it('withdrawal locks a final invoice naming the receipts so far, balance included', async () => {
    await asUser(EMPLOYEE, async () => {
      const { enrollment } = await anEnrollment(`DROP${Date.now()}`);
      const invoice = await createInvoice({
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });
      await collectInvoicePayment(invoice.id, { amount: 20_000, mode: 'cash', reference: `D1-${Date.now()}` });

      const updated = await setEnrollmentStatus(enrollment.id, 'withdrawn');
      expect(updated.status).toBe('withdrawn');

      const finals = await listFinalInvoices({ invoiceId: invoice.id });
      expect(finals.length).toBe(1);
      expect(finals[0]!.recordCode).toMatch(/^KIPL\/TI\/\d{2}-\d{2}\/\d{3,}$/);

      const doc = await finalInvoiceDocument(finals[0]!.id);
      expect(doc.triggerReason).toBe('dropout');
      expect(doc.totals.settled).toBe(false);
      expect(doc.totals.balance).toBeGreaterThan(0);
      expect(doc.totals.instalments).toBe(1);
    });
  });

  it('withdrawal before a single rupee is paid still raises a nil tax invoice', async () => {
    await asUser(EMPLOYEE, async () => {
      const { enrollment } = await anEnrollment(`NIL${Date.now()}`);
      const invoice = await createInvoice({
        personId: enrollment.personId,
        placeOfSupply: '33',
        enrollmentDate: new Date(),
        lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
        issue: true,
      });

      await setEnrollmentStatus(enrollment.id, 'withdrawn');

      const finals = await listFinalInvoices({ invoiceId: invoice.id });
      expect(finals.length).toBe(1);
      expect(finals[0]!.receiptCount).toBe(0);
      expect(finals[0]!.totalReceived).toBe(0);
      expect(finals[0]!.status).toBe('issued');
    });
  });

  it('a generic (non-course) invoice is untouched: still the on-demand, supersedable statement', async () => {
    await asUser(EMPLOYEE, async () => {
      const invoice = await createInvoice({
        organizationId: (
          await prisma.organization.create({
            data: { tenantId: TENANT, recordCode: await nextRecordCode('ORG'), kind: 'company', name: `Generic ${Date.now()}` },
          })
        ).id,
        placeOfSupply: '33',
        lines: [{ description: 'Consulting', unitPrice: 10_000, gstRate: 18 }],
        payment: { amount: 5_000, mode: 'cash', reference: `G1-${Date.now()}` },
        issue: true,
      });

      expect(invoice.recordCode).toMatch(/^KIPL\/I\/\d{2}-\d{2}\/\d{3,}$/);
      const doc = await invoiceDocument(invoice.id);
      expect(doc.isTempInvoice).toBe(false);
      expect(doc.position.canRaiseFinalInvoice).toBe(true);

      const statement = await raiseFinalInvoice(invoice.id);
      expect(statement.recordCode).toMatch(/^KIPL\/TI\/\d{2}-\d{2}\/\d{3,}$/);
    });
  });
});
