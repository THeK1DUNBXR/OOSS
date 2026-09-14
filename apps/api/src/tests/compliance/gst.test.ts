/**
 * Compliance — GST completion (docs/plan/compliance.md, workstream B).
 *
 * CMP-GST-001..004 plus the reconciliation and note-series mechanics behind
 * them. Runs against a real database, the same way invoicing.test.ts does —
 * each test picks an untouched tax period so a full-month figure like
 * taxable turnover can be asserted exactly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { NOTE_REASON_CODES, round2 } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from '../helpers.js';
import { num } from '../../platform/db.js';
import { createInvoice, issueInvoiceDraft } from '../../domains/invoicing.js';
import { issueCreditNote } from '../../domains/finance.js';
import { recordVendorBill } from '../../domains/books.js';
import { createCourse } from '../../domains/courses.js';
import { computeGstr1, computeGstr3b } from '../../domains/gstReturns.js';
import {
  classifyInvoiceLine,
  setCourseGstExemption,
  applyReverseCharge,
  listRcmSelfInvoices,
  issueDebitNote,
  listDebitNotes,
  setCreditNoteReason,
  requestEInvoice,
  setEInvoiceConfig,
  registerEInvoiceProvider,
  importGstr2b,
  gstr2bMatches,
  gstr2bSummary,
  gstExposure,
} from '../../domains/compliance/gst.js';
import { lateFee, interest } from '@kaizen/shared';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function aPerson() {
  const person = await unscopedPrisma.person.findFirstOrThrow({
    where: { tenantId: TENANT, deletedAt: null, source: 'admissions' },
  });
  return person.id;
}

function firstDayOf(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 5));
}

function nextMonth(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const d = new Date(Date.UTC(year, month, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** An untouched tax period, walking a range this suite does not otherwise use. */
async function openPeriod(): Promise<string> {
  for (let year = 2501; year < 2700; year += 1) {
    for (const month of ['02', '05', '08', '11']) {
      const period = `${year}-${month}`;
      const [filing, invoice] = await Promise.all([
        unscopedPrisma.gstFiling.findFirst({ where: { tenantId: TENANT, period } }),
        unscopedPrisma.invoice.findFirst({
          where: { tenantId: TENANT, issuedDate: { gte: firstDayOf(period), lt: firstDayOf(nextMonth(period)) } },
        }),
      ]);
      if (!filing && !invoice) return period;
    }
  }
  throw new Error('No untouched period left.');
}

async function setCompanyFlags(flags: { compositionScheme?: boolean; eInvoicingApplicable?: boolean }) {
  await unscopedPrisma.companyProfile.updateMany({ where: { tenantId: TENANT }, data: flags });
}

// ===========================================================================
// CMP-GST-001 — supply classification
// ===========================================================================

describe('CMP-GST-001: a nil/exempt line reports as such and drops out of taxable turnover', () => {
  it('a course flagged exempt defaults its line, prints zero tax, and is excluded from turnover', async () => {
    const today = new Date();
    const currentPeriod = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

    await asUser('finance@kaizen.co.in', async () => {
      const course = await createCourse({
        name: `Community outreach ${Date.now()}`,
        code: `CMP-EXM-${Date.now()}`,
        feeAmount: 4000,
        gstRate: 18,
        hsnSac: '999293',
      });
      await setCourseGstExemption(course.id, { active: true });

      // Delta-based rather than an isolated empty month: the current tax
      // period already carries invoices from elsewhere in the suite, so what
      // is asserted is the exact increase this pair of invoices causes.
      const before3b = await computeGstr3b(currentPeriod);
      const before1 = await computeGstr1(currentPeriod);

      await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Taxable line', unitPrice: 10_000, gstRate: 18, hsnSac: '998314' }],
      });

      const exemptInvoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ courseId: course.id }],
      });

      const line = exemptInvoice.lines[0];
      expect(line.supplyType).toBe('exempt');
      expect(num(line.gstRate)).toBe(0);
      expect(num(line.taxAmount)).toBe(0);
      expect(line.exemptionNotification).toBe('12/2017-CT(R) entry 66');

      const after3b = await computeGstr3b(currentPeriod);
      const after1 = await computeGstr1(currentPeriod);

      // Only the taxable invoice's ₹10,000 counts as turnover; the exempt
      // ₹4,000 shows up in the nil/exempt row instead.
      expect(round2(after3b.outwardSupplies.taxableValue - before3b.outwardSupplies.taxableValue)).toBe(10_000);
      expect(
        round2(after3b.otherOutwardSupplies.nilRatedAndExempt.taxableValue - before3b.otherOutwardSupplies.nilRatedAndExempt.taxableValue),
      ).toBe(4000);
      expect(round2(after1.totals.taxableValue - before1.totals.taxableValue)).toBe(10_000);
      expect(round2(after1.nil.exempted - before1.nil.exempted)).toBe(4000);
    });
  });

  it('classify forces a non-taxable line to zero rate and zero tax, and a taxable one keeps its rate', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const draft = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        issue: false,
        lines: [{ description: 'To be classified', unitPrice: 2000, gstRate: 18, hsnSac: '998314' }],
      });
      const lineId = draft.lines[0].id;

      const afterClassify = await classifyInvoiceLine(draft.id, lineId, {
        supplyType: 'nil',
        exemptionNotification: null,
      } as never);
      const line = afterClassify.lines.find((l) => l.id === lineId)!;
      expect(line.supplyType).toBe('nil');
      expect(num(line.gstRate)).toBe(0);
      expect(num(line.taxAmount)).toBe(0);
      expect(num(afterClassify.grandTotal)).toBe(2000);

      const backToTaxable = await classifyInvoiceLine(draft.id, lineId, { supplyType: 'taxable', gstRate: 12 } as never);
      const line2 = backToTaxable.lines.find((l) => l.id === lineId)!;
      expect(num(line2.gstRate)).toBe(12);
      expect(num(line2.taxAmount)).toBe(240);
    });
  });

  it('a composition tenant cannot issue a tax invoice with tax, and the correction is a bill of supply', async () => {
    await setCompanyFlags({ compositionScheme: true });
    try {
      await asUser('finance@kaizen.co.in', async () => {
        const rejected = await expectReject(async () =>
          createInvoice({
            personId: await aPerson(),
            placeOfSupply: '33',
            lines: [{ description: 'Composition seller', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
          }),
        );
        expect(rejected.message).toMatch(/composition/i);

        const invoice = await createInvoice({
          personId: await aPerson(),
          placeOfSupply: '33',
          lines: [{ description: 'Composition seller', unitPrice: 1000, gstRate: 0, hsnSac: '998314', supplyType: 'exempt' as never }],
        });
        expect(invoice.invoiceType).toBe('bill_of_supply');
      });
    } finally {
      await setCompanyFlags({ compositionScheme: false });
    }
  });
});

// ===========================================================================
// CMP-GST-002 — reverse charge on inward supplies
// ===========================================================================

describe('CMP-GST-002: reverse charge populates isup_rev and the ITC is claimable in the same 3B', () => {
  it('applying RCM to a vendor bill raises a self-invoice and shows up in GSTR-3B', async () => {
    const period = await openPeriod();
    const billDate = firstDayOf(period);

    await asUser('finance@kaizen.co.in', async () => {
      const bill = await recordVendorBill({
        vendorName: 'Freelance legal counsel',
        vendorGstin: '33AAACS9101K1ZI', // same state as the company (33) — intra-state
        billDate,
        subtotal: 20_000,
      });

      const selfInvoice = await applyReverseCharge(bill.id, { ratePct: 18 });
      expect(num(selfInvoice.taxableValue)).toBe(20_000);
      expect(num(selfInvoice.cgstAmount)).toBe(1800);
      expect(num(selfInvoice.sgstAmount)).toBe(1800);
      expect(selfInvoice.number).toMatch(/^RCM-\d{4}-\d{5}$/);

      const updatedBill = await unscopedPrisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } });
      expect(updatedBill.rcmApplicable).toBe(true);
      expect(num(updatedBill.rcmTaxAmount)).toBe(3600);

      const rows = await listRcmSelfInvoices(period);
      expect(rows.some((r) => r.id === selfInvoice.id)).toBe(true);

      const gstr3b = await computeGstr3b(period);
      expect(gstr3b.otherOutwardSupplies.reverseCharge.taxableValue).toBe(20_000);
      expect(gstr3b.otherOutwardSupplies.reverseCharge.cgst).toBe(1800);
      expect(gstr3b.otherOutwardSupplies.reverseCharge.sgst).toBe(1800);
      // Claimable in the same return: input credit includes the RCM tax paid.
      expect(gstr3b.inputTaxCredit.cgst).toBeGreaterThanOrEqual(1800);
      expect(gstr3b.inputTaxCredit.sgst).toBeGreaterThanOrEqual(1800);
    });
  });

  it('the rate has to be a real percentage', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const bill = await recordVendorBill({ vendorName: 'Vendor', billDate: new Date(), subtotal: 100 });
      const rejected = await expectReject(() => applyReverseCharge(bill.id, { ratePct: 0 }));
      expect(rejected.code).toBe('BAD_REQUEST');
    });
  });
});

// ===========================================================================
// CMP-GST-003 — debit and credit notes
// ===========================================================================

describe('CMP-GST-003: a debit note has its own gapless series and a mandatory reason, distinct from credit notes', () => {
  it('two debit notes on one invoice get consecutive numbers on the D series', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Under-billed', unitPrice: 5000, gstRate: 18, hsnSac: '998314' }],
      });

      const first = await issueDebitNote(invoice.id, { amount: 500, reasonCode: 'rate_difference' });
      const second = await issueDebitNote(invoice.id, { amount: 300, reasonCode: 'quantity_shortfall' });

      expect(first.recordCode).toMatch(/\/D\//);
      expect(second.recordCode).toMatch(/\/D\//);
      const [, , , firstSeq] = first.recordCode.split('/');
      const [, , , secondSeq] = second.recordCode.split('/');
      expect(Number(secondSeq)).toBe(Number(firstSeq) + 1);

      const notes = await listDebitNotes(invoice.id);
      expect(notes).toHaveLength(2);

      const rejected = await expectReject(() => issueDebitNote(invoice.id, { amount: 100, reasonCode: 'bogus' as never }));
      expect(rejected.code).toBe('BAD_REQUEST');
    });
  });

  it('a credit note gets the C series and a structured reason, on the same invoice reason list', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Over-billed', unitPrice: 5000, gstRate: 18, hsnSac: '998314' }],
      });
      const note = await issueCreditNote(invoice.id, 400, 'Price agreed lower after issue', 'post_supply_price_revision');
      expect(note.recordCode).toMatch(/\/C\//);

      const reason = await setCreditNoteReason(note.id, 'other');
      expect(reason.reasonCode).toBe('other');
      expect(NOTE_REASON_CODES).toContain('other');
    });
  });

  it('debit notes and credit notes both flow into GSTR-1, with their own sign', async () => {
    const today = new Date();
    const currentPeriod = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

    await asUser('finance@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Base', unitPrice: 8000, gstRate: 18, hsnSac: '998314' }],
      });
      await issueCreditNote(invoice.id, 800, 'refund of part', 'other');
      await issueDebitNote(invoice.id, { amount: 200, reasonCode: 'other' });

      const gstr1 = await computeGstr1(currentPeriod);
      expect(gstr1.creditNotes.some((c) => c.amount === 800)).toBe(true);
      expect(gstr1.debitNotes.some((d) => d.amount === 200)).toBe(true);
    });
  });
});

// ===========================================================================
// CMP-GST-004 — e-invoicing
// ===========================================================================

describe('CMP-GST-004: e-invoicing is declared not-configured rather than silently omitted', () => {
  it('a fresh tenant with e-invoicing applicable refuses to register an IRN, named', async () => {
    await setCompanyFlags({ eInvoicingApplicable: true });
    try {
      await asUser('finance@kaizen.co.in', async () => {
        const invoice = await createInvoice({
          personId: await aPerson(),
          placeOfSupply: '33',
          lines: [{ description: 'E-invoice candidate', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
        });
        expect(invoice.eInvoiceStatus).toBe('pending');

        const rejected = await expectReject(() => requestEInvoice(invoice.id));
        expect(rejected.code).toBe('EINVOICE_NOT_CONFIGURED');
      });
    } finally {
      await setCompanyFlags({ eInvoicingApplicable: false });
    }
  });

  it('an invoice on a tenant with e-invoicing not applicable is stamped not_applicable at issue', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'No e-invoicing here', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
      });
      expect(invoice.eInvoiceStatus).toBe('not_applicable');
    });
  });

  it('a configured provider registers an IRN', async () => {
    await setCompanyFlags({ eInvoicingApplicable: true });
    try {
      await asUser('finance@kaizen.co.in', async () => {
        registerEInvoiceProvider({
          name: 'fixture_irp',
          async registerIrn() {
            return { irn: 'IRN123', ackNo: 'ACK123', ackAt: new Date(), signedQr: 'QR123' };
          },
        });
        await setEInvoiceConfig({ provider: 'fixture_irp' });

        const draft = await createInvoice({
          personId: await aPerson(),
          placeOfSupply: '33',
          issue: false,
          lines: [{ description: 'Provider test', unitPrice: 1000, gstRate: 18, hsnSac: '998314' }],
        });
        const issued = await issueInvoiceDraft(draft.id);
        const updated = await requestEInvoice(issued.id);
        expect(updated.irn).toBe('IRN123');
        expect(updated.eInvoiceStatus).toBe('registered');
      });
    } finally {
      await setCompanyFlags({ eInvoicingApplicable: false });
    }
  });
});

// ===========================================================================
// GSTR-2B reconciliation
// ===========================================================================

describe('GSTR-2B reconciliation matches on vendor GSTIN and bill number', () => {
  it('produces matched, missing-in-2b, missing-in-books and mismatch outcomes', async () => {
    const period = await openPeriod();
    const billDate = firstDayOf(period);
    const gstin = '33AAACS9101K1ZI';

    await asUser('finance@kaizen.co.in', async () => {
      const matchedBill = await recordVendorBill({
        vendorName: 'Matched Co', vendorGstin: gstin, billNumber: 'INV-1', billDate, subtotal: 1000, taxAmount: 180,
      });
      const mismatchBill = await recordVendorBill({
        vendorName: 'Mismatch Co', vendorGstin: gstin, billNumber: 'INV-2', billDate, subtotal: 1000, taxAmount: 100,
      });
      const unmatchedBill = await recordVendorBill({
        vendorName: 'Missing in 2B', vendorGstin: gstin, billNumber: 'INV-3', billDate, subtotal: 500, taxAmount: 90,
      });
      void unmatchedBill;

      await importGstr2b({
        period,
        b2b: [
          { ctin: gstin, inum: 'INV-1', idt: '05-01-2026', val: 1180, itms: [{ txval: 1000, camt: 90, samt: 90 }] },
          { ctin: gstin, inum: 'INV-2', idt: '05-01-2026', val: 1180, itms: [{ txval: 1000, camt: 90, samt: 90 }] },
          { ctin: gstin, inum: 'INV-9', idt: '05-01-2026', val: 590, itms: [{ txval: 500, camt: 45, samt: 45 }] },
        ],
      });

      const matches = await gstr2bMatches(period);
      const byBill = new Map(matches.filter((m) => m.vendorBillId).map((m) => [m.vendorBillId, m.status]));
      expect(byBill.get(matchedBill.id)).toBe('matched');
      expect(byBill.get(mismatchBill.id)).toBe('mismatch');
      expect(matches.some((m) => m.status === 'missing_in_2b')).toBe(true);
      expect(matches.some((m) => m.status === 'missing_in_books')).toBe(true);

      const summary = await gstr2bSummary(period);
      expect(summary.imported).toBe(true);
      expect(summary.eligibleItc).toBe(round2(90 + 90 + 90 + 90 + 45 + 45));
    });
  });
});

// ===========================================================================
// Late fee and interest exposure
// ===========================================================================

describe('late fee and interest are read from a dated rate table, not a constant', () => {
  it('lateFee caps at the table value and interest accrues on the net cash tax', () => {
    const rates = { lateFeePerDayCgst: 25, lateFeePerDaySgst: 25, cap: 5000, interestPct: 18 };
    expect(lateFee(0, rates)).toBe(0);
    expect(lateFee(10, rates)).toBe(500);
    expect(lateFee(1000, rates)).toBe(5000); // capped
    expect(interest(0, 10, 18)).toBe(0);
    expect(interest(10_000, 0, 18)).toBe(0);
    expect(interest(10_000, 365, 18)).toBe(1800);
  });

  it('exposure reads the current rate table and today against the filing', async () => {
    const period = await openPeriod();
    await asUser('finance@kaizen.co.in', async () => {
      const exposure = await gstExposure(period);
      expect(exposure.rateTable).not.toBeNull();
      expect(exposure.returns).toHaveLength(2);
      for (const r of exposure.returns) {
        expect(r.filed).toBe(false);
      }
    });
  });
});
