/**
 * Course-sale invoices: tenure-based pricing, add-ons, and the printed
 * ledger they produce.
 *
 * The claims worth writing down:
 *
 *   - a course's tenure-based fee plans and add-ons are the catalogue's own
 *     wholesale-replaceable data, same as its flat fee;
 *   - a course line's quantity is the tenure in months, so the existing
 *     gross/discount/tax arithmetic prices one with no special case;
 *   - an add-on prices the same way, split evenly across the tenure;
 *   - an invoice raised with an enrollment date carries a payment-due
 *     schedule and a printable per-line ledger, computed once and never
 *     recomputed by the client;
 *   - the schedule's own arithmetic (enrol + 3 days, then the 1st of the
 *     month, pushed a month if that is fewer than fourteen days off) is
 *     right on its own terms, with no database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { computePaymentSchedule, round2 } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { createCourse, listCourses, updateCourse } from '../domains/courses.js';
import { createInvoice, invoiceDocument } from '../domains/invoicing.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function aPerson() {
  const person = await unscopedPrisma.person.findFirstOrThrow({
    where: { tenantId: TENANT, deletedAt: null, source: 'admissions' },
  });
  return person.id;
}

// ===========================================================================
// The schedule — pure arithmetic, no database
// ===========================================================================

describe('the payment-due schedule a course-sale invoice prints', () => {
  it('is null with no enrollment date: nothing to print a schedule from', () => {
    expect(computePaymentSchedule(null)).toBeNull();
    expect(computePaymentSchedule(undefined)).toBeNull();
  });

  it('the first instalment is due three days after enrolling', () => {
    const schedule = computePaymentSchedule('2026-09-10');
    expect(schedule?.firstPaymentDue).toBe('2026-09-13');
  });

  it('subsequent instalments fall on the 1st of the next month when that leaves at least fourteen days', () => {
    // Enrol the 10th: first payment due the 13th, the 1st of October is 18
    // days later — plenty of room, so the run starts there.
    const schedule = computePaymentSchedule('2026-09-10');
    expect(schedule?.subsequentFrom).toBe('2026-10-01');
  });

  it('pushes a further month when the 1st would land fewer than fourteen days after the first instalment', () => {
    // Enrol the 25th: first payment due the 28th, only 3 days before
    // October 1st — too close, so the run starts November 1st instead.
    const schedule = computePaymentSchedule('2026-09-25');
    expect(schedule?.firstPaymentDue).toBe('2026-09-28');
    expect(schedule?.subsequentFrom).toBe('2026-11-01');
  });
});

// ===========================================================================
// The catalogue — tenure-based fee plans and add-ons
// ===========================================================================

describe('a course carries tenure-based fee plans and add-ons, wholesale-replaceable like its flat fee', () => {
  it('creates a course with fee plans and add-ons, and lists them back', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const code = `TEN-${stamp()}`.slice(0, 16);
      const course = await createCourse({
        name: `Tenure Test ${stamp()}`,
        code,
        feeAmount: 10_000,
        gstRate: 18,
        hsnSac: '9983',
        hours: 60,
        feePlans: [
          { tenureMonths: 1, monthlyFee: 10_000 },
          { tenureMonths: 3, monthlyFee: 4_000 },
        ],
        addons: [{ name: 'Certification', price: 5_000, gstRate: 18, hsnSac: '9983', notes: 'optional' }],
      });

      const listed = await listCourses({ includeRetired: true });
      const found = listed.find((c) => c.id === course.id)!;
      expect(found.hours).toBe(60);
      expect(found.feePlans.map((p) => [p.tenureMonths, p.monthlyFee]).sort()).toEqual([
        [1, 10_000],
        [3, 4_000],
      ]);
      expect(found.addons).toHaveLength(1);
      expect(found.addons[0].name).toBe('Certification');
      expect(found.addons[0].price).toBe(5_000);
    });
  });

  it('replaces the whole list on edit, rather than accumulating rows', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const code = `TEN2-${stamp()}`.slice(0, 16);
      const course = await createCourse({
        name: `Replace Test ${stamp()}`,
        code,
        feePlans: [{ tenureMonths: 1, monthlyFee: 1_000 }],
        addons: [{ name: 'Old add-on', price: 1_000 }],
      });

      await updateCourse(course.id, {
        feePlans: [{ tenureMonths: 6, monthlyFee: 500 }],
        addons: [{ name: 'New add-on', price: 2_000 }],
      });

      const listed = await listCourses({ includeRetired: true });
      const found = listed.find((c) => c.id === course.id)!;
      expect(found.feePlans).toEqual([{ id: expect.any(String), tenureMonths: 6, monthlyFee: 500 }]);
      expect(found.addons.map((a) => a.name)).toEqual(['New add-on']);
    });
  });

  it('refuses two fee plans naming the same tenure', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const err = await expectReject(() =>
        createCourse({
          name: `Dup Tenure ${stamp()}`,
          code: `DUP-${stamp()}`.slice(0, 16),
          feePlans: [
            { tenureMonths: 3, monthlyFee: 1_000 },
            { tenureMonths: 3, monthlyFee: 2_000 },
          ],
        }),
      );
      expect(err.message).toMatch(/one rate per tenure/);
    });
  });
});

// ===========================================================================
// Pricing a course-sale invoice: tenure as quantity, add-ons split across it
// ===========================================================================

describe('a course-sale invoice prices tenure and add-ons through the ordinary line arithmetic', () => {
  async function aTenureCourse() {
    return createCourse({
      name: `Priced Course ${stamp()}`,
      code: `PRC-${stamp()}`.slice(0, 16),
      gstRate: 18,
      hsnSac: '9983',
      feePlans: [{ tenureMonths: 3, monthlyFee: 10_000 }],
      addons: [{ name: 'Exam fee', price: 6_000, gstRate: 18, hsnSac: '9983' }],
    });
  }

  it('a course line billed as quantity=tenure, unit price=monthly rate, prices exactly like any other line', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        interState: false,
        enrollmentDate: new Date('2026-09-10'),
        lines: [{ courseId: course.id, quantity: 3, unitPrice: 10_000, discountPercent: 10 }],
      });

      const line = invoice.lines[0];
      // Subtotal 30,000; 10% off is 3,000; taxable 27,000.
      expect(Number(line.amount.toString())).toBe(27_000);
      expect(Number(line.discountAmount.toString())).toBe(3_000);
      expect(Number(line.taxAmount.toString())).toBe(round2(27_000 * 0.18));
    });
  });

  it('an add-on line, priced at price/tenure with quantity=tenure, comes to the add-on’s full price before discount', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const addonId = (await listCourses({ includeRetired: true })).find((c) => c.id === course.id)!.addons[0].id;

      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        interState: false,
        enrollmentDate: new Date('2026-09-10'),
        lines: [
          { courseId: course.id, quantity: 3, unitPrice: 10_000, discountPercent: 0 },
          { courseId: course.id, courseAddonId: addonId, quantity: 3, unitPrice: 6_000 / 3, discountPercent: 0 },
        ],
      });

      const addonLine = invoice.lines[1];
      expect(addonLine.courseAddonId).toBe(addonId);
      expect(Number(addonLine.amount.toString())).toBe(6_000);
      expect(addonLine.description).toBe('Exam fee');
    });
  });

  it('refuses an add-on that is not this course’s own', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const otherCourse = await aTenureCourse();
      const otherAddonId = (await listCourses({ includeRetired: true })).find((c) => c.id === otherCourse.id)!.addons[0]
        .id;
      const personId = await aPerson();

      const err = await expectReject(() =>
        createInvoice({
          personId,
          lines: [{ courseId: course.id, courseAddonId: otherAddonId, quantity: 1, unitPrice: 1 }],
        }),
      );
      expect(err.message).toMatch(/not an add-on of the course/);
    });
  });

  it('refuses billing a retired add-on', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const addonId = (await listCourses({ includeRetired: true })).find((c) => c.id === course.id)!.addons[0].id;
      await prisma.courseAddon.update({ where: { id: addonId }, data: { active: false } });
      const personId = await aPerson();

      const err = await expectReject(() =>
        createInvoice({
          personId,
          lines: [{ courseId: course.id, courseAddonId: addonId, quantity: 1, unitPrice: 1 }],
        }),
      );
      expect(err.message).toMatch(/retired/);
    });
  });
});

// ===========================================================================
// The printed ledger
// ===========================================================================

describe('the ledger a course-sale invoice document prints', () => {
  async function aTenureCourse() {
    return createCourse({
      name: `Ledger Course ${stamp()}`,
      code: `LED-${stamp()}`.slice(0, 16),
      gstRate: 18,
      hsnSac: '9983',
      feePlans: [{ tenureMonths: 3, monthlyFee: 10_000 }],
      addons: [{ name: 'Kit fee', price: 6_000, gstRate: 18, hsnSac: '9983' }],
    });
  }

  it('is absent on a generic invoice with no enrollment date', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Consulting', unitPrice: 1000, gstRate: 18 }],
      });
      const doc = await invoiceDocument(invoice.id);
      expect(doc.ledger).toBeNull();
      expect(doc.enrollmentDate).toBeNull();
    });
  });

  it('names the schedule and splits each row’s own tax intra-state as CGST+SGST', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const addonId = (await listCourses({ includeRetired: true })).find((c) => c.id === course.id)!.addons[0].id;

      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        interState: false,
        enrollmentDate: new Date('2026-09-10'),
        lines: [
          { courseId: course.id, quantity: 3, unitPrice: 10_000, discountPercent: 10 },
          { courseId: course.id, courseAddonId: addonId, quantity: 3, unitPrice: 2_000, discountPercent: 10 },
        ],
      });

      const doc = await invoiceDocument(invoice.id);
      expect(doc.enrollmentDate).not.toBeNull();
      expect(doc.ledger?.schedule).toEqual({ firstPaymentDue: '2026-09-13', subsequentFrom: '2026-10-01' });

      const rows = doc.ledger!.rows;
      expect(rows).toHaveLength(2);

      const courseRow = rows[0];
      expect(courseRow.isCourseRow).toBe(true);
      expect(courseRow.courseName).toBe(course.name);
      expect(courseRow.tenureMonths).toBe(3);
      expect(courseRow.monthlyFee).toBe(10_000);
      expect(courseRow.subtotal).toBe(30_000);
      expect(courseRow.discountAmount).toBe(3_000);
      expect(courseRow.effectiveMonthly).toBe(9_000);
      expect(courseRow.taxable).toBe(27_000);
      // Intra-state: split evenly, nothing on IGST.
      expect(courseRow.igst).toBe(0);
      expect(round2(courseRow.cgst + courseRow.sgst)).toBe(round2(27_000 * 0.18));
      expect(courseRow.cgst).toBe(courseRow.sgst);
      expect(courseRow.total).toBe(round2(27_000 * 1.18));

      const addonRow = rows[1];
      expect(addonRow.isCourseRow).toBe(false);
      expect(addonRow.courseName).toBeNull();
      expect(addonRow.addonName).toBe('Kit fee');
    });
  });

  it('carries the whole tax as IGST and nothing on CGST/SGST when inter-state', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await aTenureCourse();
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '07',
        interState: true,
        enrollmentDate: new Date('2026-09-25'),
        lines: [{ courseId: course.id, quantity: 3, unitPrice: 10_000 }],
      });

      const doc = await invoiceDocument(invoice.id);
      // Enrolling the 25th pushes the run to November — the 14-day rule.
      expect(doc.ledger?.schedule).toEqual({ firstPaymentDue: '2026-09-28', subsequentFrom: '2026-11-01' });

      const row = doc.ledger!.rows[0];
      expect(row.cgst).toBe(0);
      expect(row.sgst).toBe(0);
      expect(row.igst).toBe(round2(30_000 * 0.18));
    });
  });
});

// ===========================================================================
// Company profile — the real registration this feature was seeded with
// ===========================================================================

describe('the seeded Kaizen Infinities company profile', () => {
  it('has a real, checksum-valid GSTIN with the state it says on the tin', async () => {
    const { isValidGstin } = await import('@kaizen/shared');
    // Not a claim about this specific tenant's row (a test run may or may not
    // have executed the course-catalogue seed) — a claim that if a tenant's
    // profile carries this exact, real GSTIN, it is genuinely valid.
    expect(isValidGstin('33AAMCK6781B1ZH')).toBe(true);
  });
});
