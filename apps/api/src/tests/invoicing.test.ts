/**
 * Invoicing, receipts, the final invoice, the GST returns, and a student's record.
 *
 * The arithmetic first, without a database, because a GSTIN whose check digit does
 * not agree, credit set off in the wrong order and rupees spelled in millions are
 * wrong on their own terms and need no persistence to demonstrate.
 *
 * Then the wiring, and the claims worth writing down:
 *
 *   - tax is priced per line at creation and quantity is actually multiplied by;
 *   - a draft is editable and an issued tax invoice is not;
 *   - an instalment issues a receipt and never restates the invoice;
 *   - the final invoice names the receipts it consolidates;
 *   - filing a return closes its month;
 *   - an employee raising invoices sees their own and nobody else's;
 *   - a foreign tenant's invoice does not exist from here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  amountInWords,
  computeGst,
  gstinCheckDigit,
  invoicePayable,
  isValidGstin,
  paymentTypeFor,
  placeOfSupplyLabel,
  round2,
  setOffInputCredit,
  stateCodeOf,
  supplyTypeOf,
} from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';
import { num } from '../platform/db.js';
import {
  collectInvoicePayment,
  createInvoice,
  declarePaymentTerms,
  invoiceDocument,
  issueInvoiceDraft,
  totalsOf,
  updateInvoice,
  voidInvoice,
} from '../domains/invoicing.js';
import { finalInvoiceDocument, listReceipts, raiseFinalInvoice, receiptDocument } from '../domains/receipts.js';
import {
  computeGstr1,
  computeGstr3b,
  markReturnFiled,
  periodStatus,
  prepareReturn,
} from '../domains/gstReturns.js';
import { assignCourse, createCourse, listCourses, retireCourse, updateCourse } from '../domains/courses.js';
import { companyProfile, updateCompanyProfile } from '../domains/companyProfile.js';
import {
  learnerTimeline,
  openLearnerItems,
  recordDailyProgress,
  recordLearnerLog,
  resolveLearnerLog,
} from '../domains/learnerTimeline.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A customer to bill. The demo dataset's first account will do. */
async function anAccount() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

async function aPerson() {
  const person = await unscopedPrisma.person.findFirstOrThrow({
    where: { tenantId: TENANT, deletedAt: null, source: 'admissions' },
  });
  return person.id;
}

/**
 * A tax period with nothing in it: no invoices, no preparations, no filing.
 *
 * A return is a statement about a whole month, so a test that asserts totals
 * needs a month of its own — and filing closes one permanently, while the suite
 * has to pass twice against the same database. So this walks forward until it
 * finds a month nothing has touched. Deterministic, and it says what it is doing
 * rather than relying on a random stamp that collides on the second run of the
 * same second.
 */
async function openPeriod(): Promise<string> {
  for (let year = 2101; year < 2400; year += 1) {
    for (const month of ['01', '04', '07', '10']) {
      const period = `${year}-${month}`;
      const [filing, invoice] = await Promise.all([
        unscopedPrisma.gstFiling.findFirst({ where: { tenantId: TENANT, period } }),
        unscopedPrisma.invoice.findFirst({
          where: {
            tenantId: TENANT,
            issuedDate: { gte: firstDayOf(period), lt: firstDayOf(nextMonth(period)) },
          },
        }),
      ]);
      if (!filing && !invoice) return period;
    }
  }
  throw new Error('No untouched period left — the fixture needs a wider range.');
}

function nextMonth(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const d = new Date(Date.UTC(year, month, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function firstDayOf(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 5));
}

// ===========================================================================
// Registrations — the arithmetic, with no database
// ===========================================================================

describe('a GSTIN is validated rather than believed', () => {
  it('accepts a well-formed registration whose check digit agrees', () => {
    expect(isValidGstin('33AABCK1234H1Z2')).toBe(true);
    expect(isValidGstin('29AABCT1332L1ZA')).toBe(true);
  });

  it('refuses one whose check digit does not agree, which is what a typo looks like', () => {
    // Same fourteen characters, last one wrong: exactly the failure a shape-only
    // check waves through and the portal rejects three weeks later.
    expect(isValidGstin('33AABCK1234H1Z3')).toBe(false);
    expect(gstinCheckDigit('33AABCK1234H1Z')).toBe('2');
  });

  it('refuses a state code that is not a state', () => {
    expect(isValidGstin('99AABCK1234H1Z2')).toBe(false);
    expect(stateCodeOf('99AABCK1234H1Z2')).toBeNull();
    expect(stateCodeOf('33AABCK1234H1Z2')).toBe('33');
  });

  it('refuses the wrong shape without pretending to know more', () => {
    expect(isValidGstin('33AABCK1234H1Z')).toBe(false);
    expect(isValidGstin('')).toBe(false);
    expect(isValidGstin(null)).toBe(false);
  });

  it('names a place of supply the way a return wants it', () => {
    expect(placeOfSupplyLabel('33')).toBe('33-Tamil Nadu');
    expect(placeOfSupplyLabel('7')).toBe('07-Delhi');
    expect(placeOfSupplyLabel(null)).toBeNull();
  });

  it('reads B2B or B2C off the registration, not off a tick box', () => {
    expect(supplyTypeOf('33AABCK1234H1Z2')).toBe('b2b');
    expect(supplyTypeOf(null)).toBe('b2c');
    // A registration that fails validation is not a registration, so the supply
    // is B2C — which is the safe reading: the customer cannot claim credit on a
    // GSTIN that does not exist.
    expect(supplyTypeOf('33AABCK1234H1Z3')).toBe('b2c');
  });
});

// ===========================================================================
// What is actually paid
// ===========================================================================

describe('input credit is set off head by head, in the statutory order', () => {
  it('uses IGST credit against IGST first, then CGST, then SGST', () => {
    const out = setOffInputCredit({ cgst: 1000, sgst: 1000, igst: 500 }, { cgst: 0, sgst: 0, igst: 2000 });

    expect(out.utilised.igst).toBe(2000);
    expect(out.payable.igst).toBe(0);
    // 500 against IGST, then 1000 against CGST, then the remaining 500 against SGST.
    expect(out.payable.cgst).toBe(0);
    expect(out.payable.sgst).toBe(500);
    expect(out.totalPayable).toBe(500);
  });

  it('will not use CGST credit against SGST, however convenient that would be', () => {
    const out = setOffInputCredit({ cgst: 0, sgst: 900, igst: 0 }, { cgst: 900, sgst: 0, igst: 0 });

    expect(out.payable.sgst).toBe(900);
    expect(out.utilised.cgst).toBe(0);
    expect(out.carriedForward.cgst).toBe(900);
    // Netting the totals would have said nothing is due. It is 900, and the
    // difference is discovered as interest.
    expect(out.totalPayable).toBe(900);
  });

  it('carries unused credit forward rather than losing it', () => {
    const out = setOffInputCredit({ cgst: 100, sgst: 100, igst: 0 }, { cgst: 400, sgst: 400, igst: 0 });
    expect(out.totalPayable).toBe(0);
    expect(out.carriedForward).toEqual({ cgst: 300, sgst: 300, igst: 0 });
  });
});

describe('the figures a document prints', () => {
  it('derives what the invoice says about payment from the amount, not from a choice', () => {
    expect(paymentTypeFor(11800, 11800)).toBe('full');
    expect(paymentTypeFor(11800, 5000)).toBe('part');
    expect(paymentTypeFor(11800, 0)).toBe('credit');
  });

  it('reads an older invoice by its lines and a priced one by its total', () => {
    expect(invoicePayable(11800, 10000)).toBe(11800);
    // Raised before tax was priced at creation: the lines are the only figure
    // there is, and the fallback is the correct reading rather than a guess.
    expect(invoicePayable(0, 10000)).toBe(10000);
    expect(invoicePayable(null, 10000)).toBe(10000);
  });

  it('spells rupees in lakhs and crores, because that is what the reader reads', () => {
    expect(amountInWords(11800)).toBe('Rupees Eleven Thousand Eight Hundred Only');
    expect(amountInWords(70800)).toBe('Rupees Seventy Thousand Eight Hundred Only');
    expect(amountInWords(150000)).toBe('Rupees One Lakh Fifty Thousand Only');
    expect(amountInWords(12500000)).toBe('Rupees One Crore Twenty Five Lakh Only');
    expect(amountInWords(1234.5)).toBe('Rupees One Thousand Two Hundred and Thirty Four and Fifty Paise Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});

// ===========================================================================
// Raising an invoice
// ===========================================================================

describe('an invoice is priced when it is raised', () => {
  it('multiplies by the quantity, which the line used to carry and nothing used', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Three seats', quantity: 3, unitPrice: 20_000, gstRate: 18, hsnSac: '999293' }],
      });

      const line = invoice.lines[0];
      expect(Number(line.unitPrice.toString())).toBe(20_000);
      expect(Number(line.amount.toString())).toBe(60_000);
      expect(Number(invoice.taxableValue.toString())).toBe(60_000);
      expect(Number(invoice.grandTotal.toString())).toBe(70_800);
    });
  });

  it('halves the tax within the state and does not across a state line', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const orgId = await anAccount();

      const local = await createInvoice({
        organizationId: orgId,
        placeOfSupply: '33',
        lines: [{ description: 'Local', unitPrice: 10_000, gstRate: 18 }],
      });
      expect(Number(local.cgstAmount.toString())).toBe(900);
      expect(Number(local.sgstAmount.toString())).toBe(900);
      expect(Number(local.igstAmount.toString())).toBe(0);
      expect(local.interState).toBe(false);

      const away = await createInvoice({
        organizationId: orgId,
        customerGstin: '29AABCT1332L1ZA',
        lines: [{ description: 'Interstate', unitPrice: 10_000, gstRate: 18 }],
      });
      expect(Number(away.igstAmount.toString())).toBe(1800);
      expect(Number(away.cgstAmount.toString())).toBe(0);
      expect(away.interState).toBe(true);
    });
  });

  it('prices a line per rate, because one invoice can carry two', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [
          { description: 'Service at 18', unitPrice: 10_000, gstRate: 18 },
          { description: 'Goods at 5', unitPrice: 10_000, gstRate: 5 },
        ],
      });
      // 1800 + 500 = 2300, halved. Not 20,000 at one blended rate.
      expect(Number(invoice.cgstAmount.toString())).toBe(1150);
      expect(Number(invoice.sgstAmount.toString())).toBe(1150);
      expect(Number(invoice.grandTotal.toString())).toBe(22_300);
    });
  });

  it('bills a person, without inventing a company for them', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 60_000, gstRate: 18 }],
      });
      expect(invoice.personId).not.toBeNull();
      expect(invoice.organizationId).toBeNull();
      // No registration, so a B2C supply — which is the ordinary case here.
      expect(supplyTypeOf(invoice.customerGstin)).toBe('b2c');
    });
  });

  it('refuses an invoice addressed to nobody, and to two customers at once', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const noCustomer = await expectReject(() =>
        createInvoice({ lines: [{ description: 'x', unitPrice: 100 }] }),
      );
      expect(noCustomer.message).toMatch(/needs a customer/);

      const both = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          personId: await aPerson(),
          lines: [{ description: 'x', unitPrice: 100 }],
        }),
      );
      expect(both.message).toMatch(/one customer/);
    });
  });

  it('refuses a customer registration that is not one', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const err = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          customerGstin: '33AABCK1234H1Z9',
          lines: [{ description: 'x', unitPrice: 100 }],
        }),
      );
      expect(err.message).toMatch(/not a valid GSTIN/);
    });
  });
});

describe('a line discount goes either way, and tax follows what it actually cost', () => {
  it('takes a rupee discount off the fee and taxes what is left', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 60_000, gstRate: 18, discountAmount: 6_000 }],
      });

      const line = invoice.lines[0];
      expect(Number(line.amount.toString())).toBe(54_000);
      expect(Number(line.discountAmount.toString())).toBe(6_000);
      // 6,000 of 60,000 — worked out from the amount, not asked for separately.
      expect(Number(line.discountPercent.toString())).toBe(10);
      expect(Number(invoice.taxableValue.toString())).toBe(54_000);
      // 18% of 54,000, halved: 4,860 each side, not 5,400 — the discount has
      // to actually reach the tax, or the customer is charged GST on money
      // they were never billed.
      expect(Number(invoice.cgstAmount.toString())).toBe(4_860);
      expect(Number(invoice.sgstAmount.toString())).toBe(4_860);
    });
  });

  it('takes a percentage off the fee and works out the same rupee figure', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 50_000, gstRate: 18, discountPercent: 20 }],
      });

      const line = invoice.lines[0];
      expect(Number(line.discountAmount.toString())).toBe(10_000);
      expect(Number(line.discountPercent.toString())).toBe(20);
      expect(Number(line.amount.toString())).toBe(40_000);
      expect(Number(invoice.taxableValue.toString())).toBe(40_000);
    });
  });

  it('refuses a line given both a discount amount and a discount percentage', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const err = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          lines: [
            { description: 'x', unitPrice: 1_000, discountAmount: 100, discountPercent: 10 },
          ],
        }),
      );
      expect(err.message).toMatch(/both a discount amount and a discount percentage/);
    });
  });

  it('refuses a discount bigger than the fee it is off', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const err = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          lines: [{ description: 'x', unitPrice: 1_000, discountAmount: 1_500 }],
        }),
      );
      expect(err.message).toMatch(/more than its fee/);
    });
  });

  it('refuses a discount percentage outside 0 to 100', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const err = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          lines: [{ description: 'x', unitPrice: 1_000, discountPercent: 150 }],
        }),
      );
      expect(err.message).toMatch(/between 0 and 100/);
    });
  });

  it('prints the fee before the discount, the discount, and what it was actually billed at', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 60_000, gstRate: 18, discountAmount: 6_000 }],
      });
      const doc = await invoiceDocument(invoice.id);
      const line = doc.lines[0];
      expect(line.grossAmount).toBe(60_000);
      expect(line.discountAmount).toBe(6_000);
      expect(line.discountPercent).toBe(10);
      expect(line.amount).toBe(54_000);
      // The gross and the discount always reconcile to what was billed, on
      // this document and on any invoice raised before the column existed.
      expect(round2(line.grossAmount - line.discountAmount)).toBe(line.amount);
    });
  });

  it('has no discount at all when none is given, on an ordinary line', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'No discount', unitPrice: 1_000, gstRate: 18 }],
      });
      const line = invoice.lines[0];
      expect(Number(line.discountAmount.toString())).toBe(0);
      expect(Number(line.discountPercent.toString())).toBe(0);
      expect(Number(line.amount.toString())).toBe(1_000);
    });
  });
});

describe('a draft is editable and an issued tax invoice is not', () => {
  it('reprices the whole invoice when a draft is rewritten', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const draft = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        issue: false,
        lines: [{ description: 'Wrong', unitPrice: 1000, gstRate: 18 }],
      });
      expect(draft.status).toBe('draft');
      expect(draft.issuedDate).toBeNull();

      const fixed = await updateInvoice(draft.id, {
        lines: [{ description: 'Right', quantity: 2, unitPrice: 5000, gstRate: 12 }],
      });
      expect(fixed.lines).toHaveLength(1);
      expect(fixed.lines[0].description).toBe('Right');
      expect(Number(fixed.taxableValue.toString())).toBe(10_000);
      expect(Number(fixed.grandTotal.toString())).toBe(11_200);
    });
  });

  it('refuses to edit one the customer is already holding', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const issued = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Issued', unitPrice: 1000, gstRate: 18 }],
      });
      expect(issued.status).toBe('issued');

      const err = await expectReject(() =>
        updateInvoice(issued.id, { lines: [{ description: 'Changed', unitPrice: 2000 }] }),
      );
      expect(err.message).toMatch(/credit note/);
    });
  });

  it('will not take money against a draft, because a draft is not a document', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const draft = await createInvoice({
        organizationId: await anAccount(),
        issue: false,
        lines: [{ description: 'Draft', unitPrice: 1000 }],
      });
      const err = await expectReject(() =>
        collectInvoicePayment(draft.id, { amount: 100, mode: 'cash' }),
      );
      expect(err.message).toMatch(/still a draft/);
    });
  });

  it('voids an unpaid invoice and refuses to void one money has landed against', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const orgId = await anAccount();

      const unpaid = await createInvoice({
        organizationId: orgId,
        lines: [{ description: 'Mistake', unitPrice: 500 }],
      });
      const voided = await voidInvoice(unpaid.id, 'Raised twice.');
      expect(voided.status).toBe('void');

      const paid = await createInvoice({
        organizationId: orgId,
        lines: [{ description: 'Real', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 1000, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const err = await expectReject(() => voidInvoice(paid.id, 'Changed my mind.'));
      expect(err.message).toMatch(/allocated against it/);
    });
  });
});

// ===========================================================================
// Receipts — where the part payments are
// ===========================================================================

describe('an instalment issues a receipt and never restates the invoice', () => {
  it('writes the declaration when the money is taken as the invoice is handed over', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Programme', unitPrice: 60_000, gstRate: 18 }],
        payment: { amount: 20_000, mode: 'cash', reference: `CASH-${stamp()}` },
      });

      const row = await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } });
      expect(row.paymentType).toBe('part');
      expect(Number(row.amountPayableNow!.toString())).toBe(20_000);
      expect(row.paymentMode).toBe('cash');
      expect(row.status).toBe('part_paid');
    });
  });

  it('leaves the invoice alone when a later instalment arrives', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Programme', unitPrice: 60_000, gstRate: 18 }],
        payment: { amount: 20_000, mode: 'cash', reference: `CASH-${stamp()}` },
      });

      const second = await collectInvoicePayment(invoice.id, {
        amount: 15_000,
        mode: 'upi',
        reference: `UPI-${stamp()}`,
      });

      const row = await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } });
      // The declaration is still what the customer was told on the day. This is
      // the whole point: a tax invoice is final.
      expect(Number(row.amountPayableNow!.toString())).toBe(20_000);
      expect(row.paymentMode).toBe('cash');
      // Status follows the receipts, and is not part of what is printed.
      expect(row.status).toBe('part_paid');

      // The receipt is the document that says what just happened.
      expect(Number(second.receipt.allocatedAmount.toString())).toBe(15_000);
      expect(Number(second.receipt.subjectTotal!.toString())).toBe(70_800);
      expect(Number(second.receipt.balanceAfter!.toString())).toBe(35_800);
      expect(second.receipt.paymentMode).toBe('upi');
      expect(second.readyForFinalInvoice).toBe(false);
    });
  });

  it('settles the invoice when the last instalment lands, and says so', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Small', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const rest = await collectInvoicePayment(invoice.id, {
        amount: 600,
        mode: 'bank_transfer',
        reference: `NEFT-${stamp()}`,
      });

      expect(rest.readyForFinalInvoice).toBe(true);
      expect(Number(rest.receipt.balanceAfter!.toString())).toBe(0);
      const row = await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } });
      expect(row.status).toBe('settled');
    });
  });

  it('refuses more than is outstanding rather than accepting an advance quietly', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Small', unitPrice: 1000, gstRate: 0 }],
      });
      const err = await expectReject(() =>
        collectInvoicePayment(invoice.id, { amount: 5000, mode: 'cash', reference: `CASH-${stamp()}` }),
      );
      expect(err.message).toMatch(/more than the/);
    });
  });

  it('refuses two payments under one reference, which could never both be reconciled', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const reference = `DUP-${stamp()}`;
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Small', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cheque', reference },
      });
      const err = await expectReject(() =>
        collectInvoicePayment(invoice.id, { amount: 100, mode: 'cheque', reference }),
      );
      expect(err.message).toMatch(/already on file/);
    });
  });

  it('refuses to restate the terms of an invoice that has been issued', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Issued', unitPrice: 1000, gstRate: 0 }],
      });
      const err = await expectReject(() => declarePaymentTerms(invoice.id, { amountPayableNow: 500 }));
      expect(err.message).toMatch(/final once issued/);
    });
  });

  it('states the terms on a draft, and carries them onto the issued document', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const draft = await createInvoice({
        organizationId: await anAccount(),
        issue: false,
        lines: [{ description: 'Half now', unitPrice: 1000, gstRate: 0 }],
      });
      const declared = await declarePaymentTerms(draft.id, { amountPayableNow: 400, paymentMode: 'upi' });
      expect(declared.paymentType).toBe('part');

      const issued = await issueInvoiceDraft(draft.id);
      expect(issued.status).toBe('issued');
      expect(Number(issued.amountPayableNow.toString())).toBe(400);
    });
  });

  it('gives the receipt its own document, naming the invoice and the instalment', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 60_000, gstRate: 18 }],
        payment: { amount: 20_000, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const second = await collectInvoicePayment(invoice.id, {
        amount: 15_000,
        mode: 'upi',
        reference: `UPI-${stamp()}`,
      });

      const doc = await receiptDocument(second.receipt.id);
      expect(doc.invoice.recordCode).toBe(invoice.recordCode);
      expect(doc.position.totalPayable).toBe(70_800);
      expect(doc.position.amountReceivedNow).toBe(15_000);
      expect(doc.position.receivedToDate).toBe(35_000);
      expect(doc.position.balanceAfter).toBe(35_800);
      expect(doc.position.isPartPayment).toBe(true);
      expect(doc.position.instalmentNumber).toBe(2);
      expect(doc.position.instalmentsSoFar).toBe(2);
      expect(doc.sequence.filter((r) => r.isThisOne)).toHaveLength(1);
      // The time it was issued, which is the fact a receipt exists to fix.
      expect(doc.issuedAt).toBeTruthy();
    });
  });

  it('lists receipts with the balance each one left behind', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Two halves', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      await collectInvoicePayment(invoice.id, { amount: 600, mode: 'upi', reference: `UPI-${stamp()}` });

      const rows = await listReceipts({ invoiceId: invoice.id });
      expect(rows).toHaveLength(2);
      const [newest, oldest] = rows;
      expect(oldest.balanceAfter).toBe(600);
      expect(newest.balanceAfter).toBe(0);
      expect(newest.settledIt).toBe(true);
      expect(oldest.invoiceCode).toBe(invoice.recordCode);
    });
  });
});

// ===========================================================================
// The final invoice
// ===========================================================================

describe('the final invoice names the receipts it consolidates', () => {
  it('lists every instalment, the total payable and what is left', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ description: 'Course fee', unitPrice: 60_000, gstRate: 18 }],
        payment: { amount: 20_000, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const second = await collectInvoicePayment(invoice.id, {
        amount: 50_800,
        mode: 'upi',
        reference: `UPI-${stamp()}`,
      });

      const final = await raiseFinalInvoice(invoice.id, { note: 'Fee settled.' });
      expect(final.receiptCount).toBe(2);
      expect(final.receiptCodes).toContain(second.receipt.recordCode);
      expect(Number(final.totalPayable.toString())).toBe(70_800);
      expect(Number(final.totalReceived.toString())).toBe(70_800);
      expect(Number(final.balance.toString())).toBe(0);
      expect(final.settled).toBe(true);

      const doc = await finalInvoiceDocument(final.id);
      expect(doc.invoice.recordCode).toBe(invoice.recordCode);
      expect(doc.receipts).toHaveLength(2);
      expect(doc.receipts[0].number).toBe(1);
      expect(doc.totals.instalments).toBe(2);
      // It restates the lines so it stands on its own, without the invoice beside it.
      expect(doc.invoice.lines[0].description).toMatch(/Course fee/);
    });
  });

  it('prints the balance rather than refusing to exist while one remains', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Partly paid', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const final = await raiseFinalInvoice(invoice.id);
      expect(final.settled).toBe(false);
      expect(Number(final.balance.toString())).toBe(600);
    });
  });

  it('refuses when there are no receipts, because the tax invoice already says everything', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Nothing paid', unitPrice: 1000, gstRate: 0 }],
      });
      const err = await expectReject(() => raiseFinalInvoice(invoice.id));
      expect(err.message).toMatch(/no receipts to consolidate/);
    });
  });

  it('supersedes an earlier statement rather than replacing it', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Two statements', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const first = await raiseFinalInvoice(invoice.id);
      await collectInvoicePayment(invoice.id, { amount: 600, mode: 'upi', reference: `UPI-${stamp()}` });
      const second = await raiseFinalInvoice(invoice.id);

      const reread = await prisma.finalInvoice.findFirstOrThrow({ where: { id: first.id } });
      expect(reread.status).toBe('superseded');
      expect(reread.supersededById).toBe(second.id);
      // The first is still readable and still says what it said.
      expect(Number(reread.totalReceived.toString())).toBe(400);
      expect(Number(second.totalReceived.toString())).toBe(1000);
    });
  });
});

// ===========================================================================
// The document
// ===========================================================================

describe('the invoice says which of the three it is addressed to', () => {
  it('names a student, an institution and an organisation as what each is', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const { createOrganization } = await import('../domains/organizations.js');
      const { createStudent } = await import('../domains/students.js');
      const tag = stamp();

      const college = await createOrganization({ kind: 'institution', name: `Billed Polytechnic ${tag}` });
      const firm = await createOrganization({ kind: 'organization', name: `Billed Traders ${tag}` });
      const student = await createStudent({
        fullName: `Billed Learner ${tag}`,
        primaryPhone: `92${tag.slice(-8)}`,
        registrationNumber: `KI-BILL/${tag}`,
      });

      const line = [{ description: 'A course', unitPrice: 10_000, gstRate: 18, hsnSac: '999293' }];
      const forStudent = await createInvoice({ personId: student.personId, placeOfSupply: '33', lines: line });
      const forCollege = await createInvoice({ organizationId: college.id, placeOfSupply: '33', lines: line });
      const forFirm = await createInvoice({ organizationId: firm.id, placeOfSupply: '33', lines: line });

      const [a, b, c] = await Promise.all([
        invoiceDocument(forStudent.id),
        invoiceDocument(forCollege.id),
        invoiceDocument(forFirm.id),
      ]);

      expect(a.customer.kind).toBe('student');
      expect(a.customer.kindLabel).toBe('Student');
      // The learner's own number, which is what they and the company both quote.
      expect(a.customer.registrationNumber).toBe(`KI-BILL/${tag}`);

      expect(b.customer.kind).toBe('institution');
      expect(b.customer.kindLabel).toBe('Institution');
      expect(c.customer.kind).toBe('organization');
      expect(c.customer.kindLabel).toBe('Organisation');
    });
  });

  it('takes the student\u2019s state from their own record rather than asking again', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const { createStudent } = await import('../domains/students.js');
      const tag = stamp();
      const student = await createStudent({
        fullName: `Kerala Learner ${tag}`,
        primaryPhone: `91${tag.slice(-8)}`,
        // Ours is Tamil Nadu, so this one is an inter-state supply and carries
        // IGST rather than the CGST/SGST pair.
        placeOfSupply: '32',
      });

      const invoice = await createInvoice({
        personId: student.personId,
        lines: [{ description: 'A course', unitPrice: 10_000, gstRate: 18, hsnSac: '999293' }],
      });

      expect(invoice.placeOfSupply).toBe('32');
      expect(invoice.interState).toBe(true);
      expect(Number(invoice.igstAmount)).toBe(1_800);
      expect(Number(invoice.cgstAmount)).toBe(0);
    });
  });
});

describe('the invoice document separates what it says from where the account stands', () => {
  it('prints the declaration made at issue, and keeps today’s balance beside it', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Programme', unitPrice: 60_000, gstRate: 18, hsnSac: '999293' }],
        payment: { amount: 20_000, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      await collectInvoicePayment(invoice.id, { amount: 15_000, mode: 'upi', reference: `UPI-${stamp()}` });

      const doc = await invoiceDocument(invoice.id);

      // Fixed at issue: both figures, and the second is not today's balance.
      expect(doc.totals.totalPayable).toBe(70_800);
      expect(doc.totals.amountPayableNow).toBe(20_000);
      expect(doc.totals.balanceAtIssue).toBe(50_800);
      expect(doc.payment.type).toBe('part');
      expect(doc.payment.mode).toBe('cash');

      // Live, and separate.
      expect(doc.position.received).toBe(35_000);
      expect(doc.position.outstanding).toBe(35_800);
      expect(doc.position.instalments).toBe(2);
      expect(doc.position.canRaiseFinalInvoice).toBe(true);
      expect(doc.receipts).toHaveLength(2);

      expect(doc.taxHeads).toEqual(['cgst', 'sgst']);
      expect(doc.totals.inWords).toMatch(/Seventy Thousand Eight Hundred/);
      expect(doc.supplier.gstin).toBeTruthy();
    });
  });

  it('prints the whole amount as payable now on a credit invoice, not today’s balance', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'On credit', unitPrice: 1000, gstRate: 0 }],
      });
      const before = await invoiceDocument(invoice.id);
      expect(before.payment.type).toBe('credit');
      expect(before.totals.amountPayableNow).toBe(1000);

      await collectInvoicePayment(invoice.id, { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` });
      const after = await invoiceDocument(invoice.id);

      // The document did not change. Only the position beside it did.
      expect(after.totals.amountPayableNow).toBe(1000);
      expect(after.payment.type).toBe('credit');
      expect(after.position.outstanding).toBe(600);
    });
  });
});

// ===========================================================================
// Who may raise one
// ===========================================================================

describe('an employee raises invoices and sees their own', () => {
  it('lets an employee raise one and read it back', async () => {
    const raised = await asUser('priya@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Counter sale', unitPrice: 2000, gstRate: 18 }],
        payment: { amount: 2360, mode: 'upi', reference: `UPI-${stamp()}` },
      });
      const doc = await invoiceDocument(invoice.id);
      expect(doc.totals.totalPayable).toBe(2360);
      expect(doc.payment.type).toBe('full');
      return invoice;
    });

    expect(raised.createdById).toBeTruthy();
  });

  it('narrows the list to the invoices that employee raised', async () => {
    // Somebody else's invoice, raised by the finance head.
    const theirs = await asUser('latha@kaizen.co.in', async () =>
      createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Not the employee’s', unitPrice: 100, gstRate: 0 }],
      }),
    );

    await asUser('priya@kaizen.co.in', async () => {
      const mine = await createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Mine', unitPrice: 100, gstRate: 0 }],
      });

      const { visibilityWhere } = await import('../platform/permissions.js');
      const scope = await visibilityWhere('invoices', 'createdById');
      const visible = await prisma.invoice.findMany({ where: { deletedAt: null, ...scope } });
      const ids = visible.map((i) => i.id);

      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });
  });

  it('refuses an employee the invoice somebody else raised, on the WHERE axis', async () => {
    const theirs = await asUser('latha@kaizen.co.in', async () =>
      createInvoice({
        organizationId: await anAccount(),
        lines: [{ description: 'Finance head’s', unitPrice: 100, gstRate: 0 }],
      }),
    );

    await asUser('priya@kaizen.co.in', async () => {
      const err = await expectReject(() => invoiceDocument(theirs.id));
      expect(err.message).toMatch(/WHERE/);
    });
  });

  it('does not let an employee near the returns', async () => {
    await asUser('priya@kaizen.co.in', async () => {
      const err = await expectReject(() => computeGstr1('2026-04'));
      expect(err.message).toMatch(/gst_filings/);
    });
  });
});

describe('tenancy is the gate before the axes', () => {
  it('a foreign tenant’s invoice does not exist from here', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'other-tenant' },
      create: { slug: 'other-tenant', name: 'Other Tenant' },
      update: {},
    });
    const foreign = await unscopedPrisma.invoice.create({
      data: {
        tenantId: other.id,
        recordCode: `INV-2026-9${String(Date.now()).slice(-4)}`,
        status: 'issued',
        currency: 'INR',
        grandTotal: 5000,
      },
    });

    await asUser('chairman@kaizen.co.in', async () => {
      const found = await prisma.invoice.findFirst({ where: { id: foreign.id } });
      // Not a 403. It does not exist from this vantage point.
      expect(found).toBeNull();
      const err = await expectReject(() => invoiceDocument(foreign.id));
      expect(err.message).toMatch(/not found|Invoice/i);
    });
  });
});

// ===========================================================================
// GST returns
// ===========================================================================

describe('GSTR-1 reports a registered customer by invoice and an unregistered one by rate', () => {
  it('splits B2B from B2C on the registration, and summarises by HSN', async () => {
    const period = await openPeriod();
    const issuedDate = firstDayOf(period);

    await asUser('latha@kaizen.co.in', async () => {
      await createInvoice({
        organizationId: await anAccount(),
        customerGstin: '33AAACS9101K1ZI',
        placeOfSupply: '33',
        issuedDate,
        lines: [{ description: 'Registered customer', unitPrice: 10_000, gstRate: 18, hsnSac: '998314' }],
      });
      await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        issuedDate,
        lines: [{ description: 'Walk-in', unitPrice: 5000, gstRate: 18, hsnSac: '999293' }],
      });

      const gstr1 = await computeGstr1(period);

      expect(gstr1.b2b).toHaveLength(1);
      expect(gstr1.b2b[0].customerGstin).toBe('33AAACS9101K1ZI');
      expect(gstr1.b2b[0].placeOfSupply).toBe('33-Tamil Nadu');
      expect(gstr1.b2cs).toHaveLength(1);
      expect(gstr1.b2cs[0].gstRate).toBe(18);
      expect(gstr1.b2cs[0].taxableValue).toBe(5000);

      expect(gstr1.totals.taxableValue).toBe(15_000);
      expect(gstr1.totals.tax).toBe(2700);
      expect(gstr1.hsn.map((h) => h.hsnSac).sort()).toEqual(['998314', '999293']);
      expect(gstr1.documentSummary.reported).toBe(2);
      // Nothing the portal would reject.
      expect(gstr1.checks.filter((c) => c.severity === 'blocking')).toEqual([]);
    });
  });

  it('numbers an issued invoice in the company’s own series, and a draft not at all', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const draft = await createInvoice({
        organizationId: await anAccount(),
        issue: false,
        lines: [{ description: 'Unissued', unitPrice: 100 }],
      });
      // A draft takes no invoice number: the tax series has to stay consecutive,
      // and a number on a draft nobody issued is a gap nothing explains.
      expect(draft.recordCode).toBeNull();
      expect(draft.draftReference).toMatch(/^DRF-/);

      const issued = await issueInvoiceDraft(draft.id);
      expect(issued.recordCode).toMatch(/^KIPL\/I\/\d{2}-\d{2}\/\d{3,}$/);
      // And it still fits what the portal accepts.
      expect(issued.recordCode!.length).toBeLessThanOrEqual(16);
      // The draft reference is kept, so which draft became which invoice stays
      // answerable.
      expect(issued.draftReference).toBe(draft.draftReference);
    });
  });

  it('numbers a receipt in the same series, under its own letter', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        lines: [{ description: 'Numbered', unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });
      const receipt = await prisma.receipt.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(receipt.recordCode).toMatch(/^KIPL\/R\/\d{2}-\d{2}\/\d{3,}$/);

      const final = await raiseFinalInvoice(invoice.id);
      expect(final.recordCode).toMatch(/^KIPL\/F\/\d{2}-\d{2}\/\d{3,}$/);
    });
  });

  it('refuses to file a return the portal would reject, and says which invoices', async () => {
    const period = await openPeriod();
    await asUser('latha@kaizen.co.in', async () => {
      // An invoice with no HSN on its line: accepted by the books, rejected by
      // the portal.
      const bad = await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'No code', unitPrice: 1000, gstRate: 18 }],
      });

      const { filing, blocking } = await prepareReturn('GSTR1', period);
      // Preparing is arithmetic and is allowed to produce a return that could
      // not be filed — seeing the blockers is the reason to prepare it.
      expect(filing.status).toBe('prepared');
      expect(blocking.map((c) => c.code)).toContain('MISSING_HSN');
      expect(blocking.find((c) => c.code === 'MISSING_HSN')?.invoices).toContain(bad.recordCode);

      const refused = await expectReject(() => markReturnFiled(filing.id, { arn: `AA33${stamp()}` }));
      expect(refused.message).toMatch(/HSN/);

      // Recording it as filed would have closed the month, and a closed month on
      // a return that never went through is the worst of both.
      const state = await periodStatus(period);
      expect(state.closed).toBe(false);
    });
  });

  it('warns about a line with no HSN rather than letting the portal find it', async () => {
    const period = await openPeriod();
    await asUser('latha@kaizen.co.in', async () => {
      await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'No code', unitPrice: 1000, gstRate: 18 }],
      });
      const gstr1 = await computeGstr1(period);
      expect(gstr1.checks.some((c) => c.code === 'MISSING_HSN' && c.severity === 'blocking')).toBe(true);
      expect(gstr1.hsn.some((h) => h.hsnSac === 'UNCLASSIFIED')).toBe(true);
    });
  });

  it('leaves a draft out of the return and counts a void invoice as cancelled', async () => {
    const period = await openPeriod();
    await asUser('latha@kaizen.co.in', async () => {
      const orgId = await anAccount();
      await createInvoice({
        organizationId: orgId,
        issue: false,
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Draft', unitPrice: 1000, gstRate: 18 }],
      });
      const voided = await createInvoice({
        organizationId: orgId,
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Cancelled', unitPrice: 1000, gstRate: 18 }],
      });
      await voidInvoice(voided.id, 'Duplicate.');

      const gstr1 = await computeGstr1(period);
      // A draft is not a supply. A void invoice is one that never happened, and
      // still has to be explained: the portal asks for the count cancelled.
      expect(gstr1.totals.invoiceCount).toBe(0);
      expect(gstr1.documentSummary.cancelled).toBe(1);
    });
  });
});

describe('GSTR-3B says what is actually paid in cash', () => {
  it('agrees with GSTR-1 on output tax and sets credit off in order', async () => {
    const period = await openPeriod();
    await asUser('latha@kaizen.co.in', async () => {
      await createInvoice({
        organizationId: await anAccount(),
        placeOfSupply: '33',
        issuedDate: firstDayOf(period),
        lines: [{ description: 'Sale', unitPrice: 10_000, gstRate: 18 }],
      });

      const gstr1 = await computeGstr1(period);
      const gstr3b = await computeGstr3b(period);

      // The two are computed from the same invoices, so they agree by
      // construction — a discrepancy between them is what a notice asks about.
      expect(gstr3b.outwardSupplies.taxableValue).toBe(gstr1.totals.taxableValue);
      expect(gstr3b.outwardSupplies.tax).toBe(gstr1.totals.tax);
      expect(gstr3b.outwardSupplies.cgst).toBe(900);
      expect(gstr3b.payment.totalPayableInCash).toBe(
        round2(gstr3b.outwardSupplies.tax - gstr3b.payment.totalUtilised),
      );
    });
  });
});

describe('filing a return closes its month', () => {
  it('prepares, files with an ARN, and then refuses an invoice dated inside it', async () => {
    const period = await openPeriod();
    const issuedDate = firstDayOf(period);

    await asUser('latha@kaizen.co.in', async () => {
      const billed = await createInvoice({
        organizationId: await anAccount(),
        customerGstin: '33AAACS9101K1ZI',
        placeOfSupply: '33',
        issuedDate,
        lines: [{ description: 'Reported', unitPrice: 10_000, gstRate: 18, hsnSac: '998314' }],
      });

      const { filing } = await prepareReturn('GSTR1', period);
      expect(filing.status).toBe('prepared');
      expect(filing.arn).toBeNull();
      expect(Number(filing.taxableValue.toString())).toBe(10_000);

      const noArn = await expectReject(() => markReturnFiled(filing.id, { arn: 'x' }));
      expect(noArn.message).toMatch(/acknowledgement/);

      const filed = await markReturnFiled(filing.id, { arn: `AA33${stamp()}` });
      expect(filed.status).toBe('filed');
      expect(filed.filedAt).not.toBeNull();

      // The invoice now knows which return it was reported in.
      const stamped = await prisma.invoice.findFirstOrThrow({ where: { id: billed.id } });
      expect(stamped.gstFilingId).toBe(filed.id);

      const state = await periodStatus(period);
      expect(state.closed).toBe(true);

      // And the month is shut: a new invoice dated inside it is refused, and so
      // is an edit to one already in it.
      const late = await expectReject(async () =>
        createInvoice({
          organizationId: await anAccount(),
          issuedDate,
          lines: [{ description: 'Too late', unitPrice: 100 }],
        }),
      );
      expect(late.message).toMatch(/filed/);

      const reprepare = await expectReject(() => prepareReturn('GSTR1', period));
      expect(reprepare.message).toMatch(/already filed/);
    });
  });

  it('supersedes an earlier preparation rather than overwriting it', async () => {
    const period = await openPeriod();
    await asUser('latha@kaizen.co.in', async () => {
      const first = await prepareReturn('GSTR3B', period);
      const second = await prepareReturn('GSTR3B', period);
      const reread = await prisma.gstFiling.findFirstOrThrow({ where: { id: first.filing.id } });
      expect(reread.status).toBe('superseded');
      expect(reread.supersededById).toBe(second.filing.id);
    });
  });
});

// ===========================================================================
// The company's own registration
// ===========================================================================

describe('the company profile is validated, because every document is printed from it', () => {
  it('refuses a GSTIN that is not one, and derives the state from a good one', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const before = await companyProfile();

      const err = await expectReject(() => updateCompanyProfile({ gstin: '33AABCK1234H1Z9' }));
      expect(err.message).toMatch(/not a valid GSTIN/);

      const updated = await updateCompanyProfile({ gstin: '33AABCK1234H1Z2' });
      expect(updated.gstin).toBe('33AABCK1234H1Z2');
      expect(updated.stateCode).toBe('33');
      expect(updated.stateName).toBe('Tamil Nadu');

      // Put it back the way the fixture had it.
      await updateCompanyProfile({ gstin: before.gstin ?? '33AABCK1234H1Z2' });
    });
  });
});

// ===========================================================================
// The catalogue
// ===========================================================================

describe('the course catalogue is editable and carries its price', () => {
  it('creates, edits and retires — never deletes', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const code = `TST-${stamp()}`.slice(0, 16);
      const course = await createCourse({
        name: 'Test Programme',
        code,
        durationWeeks: 8,
        feeAmount: 30_000,
        gstRate: 18,
        hsnSac: '999293',
      });
      expect(Number(course.feeAmount!.toString())).toBe(30_000);

      const raised = await updateCourse(course.id, { feeAmount: 35_000, durationWeeks: 10 });
      expect(Number(raised.feeAmount!.toString())).toBe(35_000);
      expect(raised.durationWeeks).toBe(10);

      const retired = await updateCourse(course.id, { active: false });
      expect(retired.active).toBe(false);
      // Still there, still readable, just not on offer.
      const stillThere = await prisma.course.findFirst({ where: { id: course.id } });
      expect(stillThere).not.toBeNull();

      const listed = await listCourses();
      expect(listed.map((c) => c.id)).not.toContain(course.id);
      const all = await listCourses({ includeRetired: true });
      expect(all.map((c) => c.id)).toContain(course.id);
      expect(all.find((c) => c.id === course.id)?.feeWithTax).toBe(41_300);
    });
  });

  it('refuses a code that already belongs to another course', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const existing = await prisma.course.findFirstOrThrow({});
      const err = await expectReject(() =>
        createCourse({ name: 'Clash', code: existing.code, feeAmount: 1 }),
      );
      expect(err.message).toMatch(/already exists/);
    });
  });

  it('refuses to retire a course with a batch still running', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const live = await prisma.cohort.findFirstOrThrow({ where: { status: 'active' } });
      const err = await expectReject(() => retireCourse(live.courseId));
      expect(err.message).toMatch(/still planned or running/);
    });
  });

  it('fills an invoice line from the course, so nobody has to know the price list', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await prisma.course.findFirstOrThrow({ where: { feeAmount: { not: null }, active: true } });
      const invoice = await createInvoice({
        personId: await aPerson(),
        placeOfSupply: '33',
        lines: [{ courseId: course.id }],
      });

      const line = invoice.lines[0];
      expect(line.description).toContain(course.name);
      expect(Number(line.unitPrice.toString())).toBe(Number(course.feeAmount!.toString()));
      expect(Number(line.gstRate.toString())).toBe(Number(course.gstRate.toString()));
      expect(line.hsnSac).toBe(course.hsnSac);
      // A course sold over weeks is earned over weeks, and that is the course's
      // property rather than a question for whoever raises the invoice.
      expect(line.revenueMethod).toBe('over_time_ratable');
    });
  });

  it('refuses to bill a retired course', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const code = `RET-${stamp()}`.slice(0, 16);
      const course = await createCourse({ name: 'Withdrawn', code, feeAmount: 1000 });
      await updateCourse(course.id, { active: false });

      const err = await expectReject(async () =>
        createInvoice({ personId: await aPerson(), lines: [{ courseId: course.id }] }),
      );
      expect(err.message).toMatch(/retired/);
    });
  });
});

describe('a course can be assigned to a customer', () => {
  it('uses the course’s rolling intake when no batch is named', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const code = `ROLL-${stamp()}`.slice(0, 16);
      const course = await createCourse({ name: 'Rolling Programme', code, feeAmount: 5000 });

      const enrollment = await assignCourse({
        courseId: course.id,
        fullName: `Walk In ${stamp()}`,
        primaryPhone: `98${String(Date.now()).slice(-8)}`,
      });

      const cohort = await prisma.cohort.findFirstOrThrow({ where: { id: enrollment.cohortId } });
      expect(cohort.name).toContain('rolling');
      expect(cohort.courseId).toBe(course.id);
      expect(cohort.endDate).toBeNull();

      // A second walk-in joins the same rolling batch rather than producing a
      // second batch of one.
      const second = await assignCourse({
        courseId: course.id,
        fullName: `Walk In Two ${stamp()}`,
        primaryPhone: `97${String(Date.now()).slice(-8)}`,
      });
      expect(second.cohortId).toBe(enrollment.cohortId);
    });
  });

  it('refuses a batch that belongs to a different course', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const cohort = await prisma.cohort.findFirstOrThrow({});
      const other = await prisma.course.findFirstOrThrow({ where: { id: { not: cohort.courseId }, active: true } });
      const err = await expectReject(() =>
        assignCourse({ courseId: other.id, cohortId: cohort.id, fullName: 'Nobody' }),
      );
      expect(err.message).toMatch(/not a batch of the course/);
    });
  });

  it('refuses the same person on the same course twice', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const code = `TWICE-${stamp()}`.slice(0, 16);
      const course = await createCourse({ name: 'Twice', code, feeAmount: 100 });
      const phone = `96${String(Date.now()).slice(-8)}`;
      const first = await assignCourse({ courseId: course.id, fullName: 'Repeat Student', primaryPhone: phone });
      expect(first.id).toBeTruthy();

      const err = await expectReject(() =>
        assignCourse({ courseId: course.id, fullName: 'Repeat Student', primaryPhone: phone }),
      );
      expect(err.message).toMatch(/already on/);
    });
  });
});

// ===========================================================================
// A student's record
// ===========================================================================

describe('a student’s timeline is one record made of four kinds of day', () => {
  async function anEnrollment() {
    const enrollment = await unscopedPrisma.enrollment.findFirstOrThrow({
      where: { tenantId: TENANT, isMinor: false },
      orderBy: { recordCode: 'asc' },
    });
    return enrollment.id;
  }

  it('opens a query and an issue, and closes feedback and a note as written', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();

      const query = await recordLearnerLog(enrollmentId, { kind: 'query', title: 'When is the exam?' });
      expect(query.status).toBe('open');

      const issue = await recordLearnerLog(enrollmentId, {
        kind: 'issue',
        title: 'Lab will not start',
        severity: 'high',
      });
      expect(issue.status).toBe('open');
      expect(issue.severity).toBe('high');

      const feedback = await recordLearnerLog(enrollmentId, { kind: 'feedback', title: 'Good pace', rating: 5 });
      expect(feedback.status).toBe('resolved');
      expect(feedback.rating).toBe(5);

      const note = await recordLearnerLog(enrollmentId, { kind: 'note', title: 'Works evenings' });
      expect(note.status).toBe('resolved');

      const closed = await resolveLearnerLog(query.id, { resolutionNote: 'Told them the date.' });
      expect(closed.status).toBe('resolved');
      expect(closed.resolvedAt).not.toBeNull();
    });
  });

  it('raises a high-severity issue into the attention queue', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();
      await recordLearnerLog(enrollmentId, {
        kind: 'issue',
        title: `Serious problem ${stamp()}`,
        severity: 'high',
      });

      // Asserted on the subject and the code rather than on the fingerprint: the
      // exception ladder escalates an open exception of the same code on the same
      // subject instead of opening a second one, which is the platform's own
      // behaviour and the right one — a student with two live complaints is one
      // thing to go and deal with.
      const raised = await prisma.exceptionRecord.findFirst({
        where: { code: 'EX-EDU-002', subjectType: 'enrollment', subjectId: enrollmentId },
      });
      expect(raised).not.toBeNull();
      expect(raised?.domain).toBe('edu');
    });
  });

  it('does not raise one for a complaint that is not serious', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      // A different student, so an escalation on the first one cannot be mistaken
      // for a new exception on this one.
      const quiet = await unscopedPrisma.enrollment.findFirstOrThrow({
        where: { tenantId: TENANT, isMinor: false },
        orderBy: { recordCode: 'desc' },
      });
      const before = await prisma.exceptionRecord.count({
        where: { code: 'EX-EDU-002', subjectId: quiet.id },
      });
      await recordLearnerLog(quiet.id, { kind: 'issue', title: `Minor niggle ${stamp()}`, severity: 'low' });
      const after = await prisma.exceptionRecord.count({
        where: { code: 'EX-EDU-002', subjectId: quiet.id },
      });
      expect(after).toBe(before);
    });
  });

  it('refuses a rating on anything but feedback, and an entry dated next week', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();

      const misplaced = await expectReject(() =>
        recordLearnerLog(enrollmentId, { kind: 'query', title: 'Scored?', rating: 4 }),
      );
      expect(misplaced.message).toMatch(/rating belongs to feedback/);

      const future = await expectReject(() =>
        recordLearnerLog(enrollmentId, {
          kind: 'note',
          title: 'Next week',
          entryDate: new Date(Date.now() + 7 * 86_400_000),
        }),
      );
      expect(future.message).toMatch(/future/);
    });
  });

  it('recomputes progress from the scores recorded, never a hand-kept field', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();
      const day = new Date(Date.now() - 3 * 86_400_000);

      await recordDailyProgress(enrollmentId, { progressDate: day, score: 80, note: 'Weekly test.' });
      // The same day again is a correction, not a second row.
      await recordDailyProgress(enrollmentId, { progressDate: day, score: 90 });

      const rows = await prisma.dailyProgress.findMany({
        where: { enrollmentId, progressDate: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())) },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(90);

      const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { id: enrollmentId } });
      const scored = await prisma.dailyProgress.findMany({ where: { enrollmentId, score: { not: null } } });
      const mean = Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length);
      expect(enrollment.progressPct).toBe(mean);
    });
  });

  it('merges attendance, progress and the log into one record, newest first', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();
      await recordLearnerLog(enrollmentId, { kind: 'note', title: `Merged ${stamp()}` });
      await recordDailyProgress(enrollmentId, { score: 70 });

      const timeline = await learnerTimeline(enrollmentId);

      expect(timeline.entries.length).toBeGreaterThan(1);
      const kinds = new Set(timeline.entries.map((e) => e.kind));
      expect(kinds.has('note')).toBe(true);
      expect(kinds.has('progress')).toBe(true);

      // Ordered, and grouped by day, which is how the record is read.
      for (let i = 1; i < timeline.entries.length; i += 1) {
        expect(timeline.entries[i - 1].at >= timeline.entries[i].at).toBe(true);
      }
      expect(timeline.days.length).toBeGreaterThan(0);
      expect(timeline.counts.entries).toBe(timeline.entries.length);
    });
  });

  it('shows what a student has been invoiced on the same page as whether they turn up', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const enrollment = await prisma.enrollment.findFirstOrThrow({
        where: { isMinor: false },
        orderBy: { recordCode: 'asc' },
      });
      await createInvoice({
        personId: enrollment.personId,
        placeOfSupply: '33',
        lines: [{ description: `Fee ${stamp()}`, unitPrice: 1000, gstRate: 0 }],
        payment: { amount: 400, mode: 'cash', reference: `CASH-${stamp()}` },
      });

      const timeline = await learnerTimeline(enrollment.id);
      expect(timeline.invoices.length).toBeGreaterThan(0);
      const part = timeline.invoices.find((i) => i.paymentType === 'part');
      expect(part).toBeTruthy();
      expect(part?.paymentMode).toBe('cash');
    });
  });

  it('finds every open item without knowing which student to look at', async () => {
    await asUser('hr@kaizen.co.in', async () => {
      const enrollmentId = await anEnrollment();
      const title = `Unanswered ${stamp()}`;
      await recordLearnerLog(enrollmentId, { kind: 'query', title, severity: 'low' });

      const open = await openLearnerItems({ kind: 'query' });
      const found = open.find((r) => r.title === title);
      expect(found).toBeTruthy();
      expect(found?.enrollmentId).toBe(enrollmentId);
      expect(found?.studentName).toBeTruthy();
      expect(found?.ageDays).toBeGreaterThanOrEqual(0);
    });
  });

  it('narrows a trainer to the batches they teach, from the grant rather than a role check', async () => {
    const cohort = await unscopedPrisma.cohort.findFirstOrThrow({
      where: { tenantId: TENANT, trainerPartyId: { not: null } },
    });
    const enrollment = await unscopedPrisma.enrollment.findFirstOrThrow({
      where: { tenantId: TENANT, cohortId: cohort.id },
    });

    // A role holding education at `own` scope with the batch_member resolver:
    // it reaches the timelines of the batches it trains and no others.
    await withFixtureRole(
      {
        slug: 'trainer_scope',
        classificationCeiling: 'restricted',
        grants: [{ resource: 'education', verbs: ['view'], scope: 'own', scopeResolver: 'batch_member' }],
      },
      async () => {
        const err = await expectReject(() => learnerTimeline(enrollment.id));
        expect(err.message).toMatch(/WHERE/);
      },
    );
  });
});

// ===========================================================================
// The totals helper every surface shares
// ===========================================================================

describe('one reading of what an invoice is for', () => {
  it('prefers the priced total and falls back to the lines', () => {
    const priced = totalsOf({
      grandTotal: 11_800,
      lines: [{ amount: 10_000 }],
      receipts: [{ allocatedAmount: 5000 }],
      creditNotes: [{ amount: 800 }],
    });
    expect(priced.payable).toBe(11_800);
    expect(priced.allocated).toBe(5000);
    expect(priced.creditNoted).toBe(800);
    expect(priced.outstanding).toBe(6000);

    const legacy = totalsOf({ grandTotal: 0, lines: [{ amount: 10_000 }], receipts: [] });
    expect(legacy.payable).toBe(10_000);
    expect(legacy.outstanding).toBe(10_000);
  });

  it('never reports a negative amount outstanding', () => {
    const over = totalsOf({
      grandTotal: 1000,
      lines: [{ amount: 1000 }],
      receipts: [{ allocatedAmount: 1000 }],
      creditNotes: [{ amount: 500 }],
    });
    expect(over.outstanding).toBe(0);
  });
});

describe('computeGst, on the arithmetic this all rests on', () => {
  it('carries the rounding explicitly rather than absorbing it', () => {
    const gst = computeGst([{ taxableValue: 999.5, gstRate: 18 }], false);
    expect(gst.grandTotal).toBe(Math.round(gst.total));
    expect(round2(gst.total + gst.roundOff)).toBe(gst.grandTotal);
  });
});

// ===========================================================================
// The company's own student register
// ===========================================================================

describe('the student register reads what a company already keeps', () => {
  /** The register's own headings, verbatim, including the American spelling. */
  const HEADER = [
    'NAME', 'REGISTRATION NUMBER', 'CONTACT', 'MAIL-ID', 'COURSE', 'ACTUAL FEES', 'Excluding GST', 'GST',
    'Discount of Rs', 'DISCOUNT', 'Including GST', 'REGISTRATION DATE', 'COURSE START DATE', 'COURSE END DATE',
    'IST INSTALLMENT', 'DATE', 'Receipt NUMBER', '2ND INSTALLMENT', 'DATE', 'Receipt NUMBER',
    '3RD  INSTALLMENT', 'DATE', 'Receipt NUMBER',
  ];

  function grid(...rows: string[][]) {
    return [HEADER, ...rows];
  }

  it('recognises the register rather than reading it as a bank statement', async () => {
    const { detectGrid } = await import('../imports/detect.js');
    const detection = detectGrid(
      grid(['Balaji', 'KI-2026/07-FS/1101', '6385469666', '', 'Full Stack Development', '24000', '15000', '2700', '6300', '26.25%', '17700', '7/8/26', '7/8/26', '9/9/26', '10000', '7/8/26', 'KIPL/R/2026-27/002', '', '', '', '', '', '']),
    );
    // A register carries a date column and an amount column, which is all the
    // bank sniffer needs — so it has to be recognised first.
    expect(detection.kind).toBe('student_register');
    expect(detection.confidence).toBe('high');
  });

  it('reads the instalments, their dates and their receipt numbers', async () => {
    const { extractStudentRegister } = await import('../imports/extract.js');
    const out = extractStudentRegister(
      grid(
        [
          'Balaji', 'KI-2026/07-FS/1101', '6385469666', '', 'Full Stack Development',
          '24000', '15000', '2700', '6300', '26.25%', '17700',
          '7/8/26', '7/8/26', '9/9/26',
          '10000', '7/8/26', 'KIPL/R/2026-27/002',
          '7700', '8/5/26', 'KIPL/R/2026-27/007',
          '', '', '',
        ],
        // The second row is what settles how the first one reads: `6/29/26` can
        // only be a month followed by a day, so the whole file is month-first and
        // Balaji registered in July rather than in August. That inference is the
        // reason this register imports with the right dates, so the row that
        // makes it possible belongs in the test.
        [
          'V.Swetha', 'KI-2026/07-FS/1102', '7305133996', '', 'C.C++ & Java',
          '24000', '15000', '2700', '6300', '26.25%', '17700',
          '7/13/26', '6/29/26', '10/31/26',
          '2000', '7/13/26', 'KIPL/R/2026-27/001',
          '', '', '', '', '', '',
        ],
      ),
      0,
    );

    expect(out.rows).toHaveLength(2);
    const row = out.rows[0];
    expect(row.status).toBe('ready');
    const n = row.normalised as Record<string, unknown>;
    expect(n.fullName).toBe('Balaji');
    expect(n.registrationNumber).toBe('KI-2026/07-FS/1101');
    expect(n.primaryPhone).toBe('6385469666');
    expect(n.courseName).toBe('Full Stack Development');
    expect(n.total).toBe(17_700);
    expect(n.received).toBe(17_700);
    expect(String(n.registeredOn).slice(0, 10)).toBe('2026-07-08');

    const instalments = n.instalments as Array<Record<string, unknown>>;
    expect(instalments).toHaveLength(2);
    expect(instalments[0]).toMatchObject({ amount: 10_000, receiptNumber: 'KIPL/R/2026-27/002' });
    expect(instalments[1]).toMatchObject({ amount: 7700, receiptNumber: 'KIPL/R/2026-27/007' });
    expect(row.message).toBeUndefined();

    // And the row that settled it reads the way it has to.
    const second = out.rows[1].normalised as Record<string, unknown>;
    expect(String(second.startsOn).slice(0, 10)).toBe('2026-06-29');
  });

  it('says so when the register does not add up, and imports the row anyway', async () => {
    const { extractStudentRegister } = await import('../imports/extract.js');
    const out = extractStudentRegister(
      grid(
        // The taxable value plus GST does not come to the total: the GST was
        // struck on the gross figure and the "Excluding GST" cell holds it too.
        ['Vaishnavi', 'KI-2026/09-SAP/1107', '8754238004', '', 'SAP-MM module', '32999', '38939', '7009.02', '0', '0.00%', '38939', '9/3/26', '9/3/26', '11/13/26', '38939', '9/7/26', 'KIPL/R/2026-27/013', '', '', '', '', '', ''],
        // The instalments come to a rupee more than is owed.
        ['M.Ravichandran', 'KI-2026/08-TLY/1105', '9342462210', '', 'Basic Microsoft & Tally with Gst', '12999', '6779', '1220', '5000', '38.46%', '7999', '8/12/26', '8/12/26', '11/12/26', '3500', '8/12/26', 'KIPL/R/2026-27/004', '4500', '9/7/26', 'KIPL/R/2026-27/011', '', '', ''],
      ),
      0,
    );

    expect(out.rows).toHaveLength(2);
    // Both import. The note is about the register, not about what is written —
    // refusing the row would lose a real student over a spreadsheet error.
    expect(out.rows.every((r) => r.status === 'ready')).toBe(true);
    expect(out.rows[0].message).toMatch(/not the 38939/);
    // Every amount in the register is tax-inclusive, so the total is the fee and
    // the split comes back out of it at the rate the row implies.
    expect(out.rows[0].message).toMatch(/tax-inclusive/);
    const vaishnavi = out.rows[0].normalised as Record<string, unknown>;
    expect(vaishnavi.total).toBe(38939);
    expect(vaishnavi.taxable).toBe(32999.15);
    expect(vaishnavi.gst).toBe(5939.85);
    expect(vaishnavi.gstRate).toBe(18);
    expect(out.rows[1].message).toMatch(/1 more than the 7999/);
  });

  it('does not mistake the trailing rows of a spreadsheet for students', async () => {
    const { extractStudentRegister } = await import('../imports/extract.js');
    const blank = HEADER.map(() => '');
    blank[8] = '0'; // the stray zero a formula leaves in the discount column
    const out = extractStudentRegister(grid(blank, blank), 0);
    expect(out.rows).toHaveLength(0);
  });

  it('refuses a row with a student and no course, and says which', async () => {
    const { extractStudentRegister } = await import('../imports/extract.js');
    const out = extractStudentRegister(
      grid(['Nobody', '', '', '', '', '', '', '', '', '', '9999', '', '', '', '', '', '', '', '', '', '', '', '']),
      0,
    );
    expect(out.rows[0].status).toBe('error');
    expect(out.rows[0].message).toMatch(/no course/);
  });

  it('dedupes on the registration number, so a corrected file does not import twice', async () => {
    const { extractStudentRegister } = await import('../imports/extract.js');
    const row = (fee: string) => [
      'Balaji', 'KI-2026/07-FS/1101', '6385469666', '', 'Full Stack Development', '24000', '15000', '2700', '6300',
      '26.25%', fee, '7/8/26', '7/8/26', '9/9/26', '10000', '7/8/26', 'KIPL/R/2026-27/002', '', '', '', '', '', '',
    ];
    const first = extractStudentRegister(grid(row('17700')), 0);
    const corrected = extractStudentRegister(grid(row('17701')), 0);
    // The fee changed and the student did not. The same enrolment, not a second.
    expect(corrected.rows[0].dedupeKey).toBe(first.rows[0].dedupeKey);
  });

  it('enrols the students and leaves the course prices alone', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { commitImport } = await import('../imports/commit.js');
      const { stageImport } = await import('../imports/service.js');
      const XLSX = await import('xlsx');

      const tag = stamp();
      const sheet = XLSX.utils.aoa_to_sheet(
        grid(
          ['Register Student One', `KI-TEST/${tag}/1`, `98${tag.slice(-8)}`, '', `Register Course ${tag}`, '24000', '15000', '2700', '6300', '26.25%', '17700', '7/8/26', '7/8/26', '9/9/26', '10000', '7/8/26', `KIPL/T/${tag}/1`, '', '', '', '', '', ''],
          ['Register Student Two', `KI-TEST/${tag}/2`, `97${tag.slice(-8)}`, '', `Register Course ${tag}`, '24000', '15000', '2700', '6300', '26.25%', '17700', '7/9/26', '7/9/26', '9/9/26', '2000', '7/9/26', `KIPL/T/${tag}/2`, '', '', '', '', '', ''],
        ),
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
      const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer);

      const staged = await stageImport({ fileName: `register-${tag}.xlsx`, buffer });
      expect(staged.kind).toBe('student_register');
      expect(staged.stats.ready).toBe(2);
      // The preview says what it is not going to do.
      expect(staged.notes.join(' ')).toMatch(/writes the enrolment only/);
      expect(staged.notes.join(' ')).toMatch(/Read and not written/);

      const result = await commitImport(staged.batchId);
      expect(result.created.enrollment).toBe(2);

      // Two students, on one rolling intake of one new course.
      const course = await prisma.course.findFirstOrThrow({ where: { name: `Register Course ${tag}` } });
      // Unpriced on purpose: a discounted figure from one student's row is not
      // what the course sells for.
      expect(course.feeAmount).toBeNull();

      const cohorts = await prisma.cohort.findMany({ where: { courseId: course.id } });
      expect(cohorts).toHaveLength(1);
      expect(cohorts[0].name).toContain('rolling');

      const enrolments = await prisma.enrollment.findMany({ where: { cohortId: cohorts[0].id } });
      expect(enrolments).toHaveLength(2);
      expect(enrolments.map((e) => e.legacyReference).sort()).toEqual([
        `KI-TEST/${tag}/1`,
        `KI-TEST/${tag}/2`,
      ]);
      expect(enrolments.every((e) => e.status === 'active')).toBe(true);
      expect(enrolments.every((e) => e.enrolledAt !== null)).toBe(true);

      // And nothing was billed.
      const people = enrolments.map((e) => e.personId);
      const invoices = await prisma.invoice.findMany({ where: { personId: { in: people } } });
      expect(invoices).toHaveLength(0);
    });
  });

  it('leaves an existing course’s price exactly as it was', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const { commitImport } = await import('../imports/commit.js');
      const { stageImport } = await import('../imports/service.js');
      const XLSX = await import('xlsx');

      const priced = await prisma.course.findFirstOrThrow({ where: { feeAmount: { not: null }, active: true } });
      const feeBefore = num(priced.feeAmount);
      const tag = stamp();

      const sheet = XLSX.utils.aoa_to_sheet(
        grid([
          'Register Student Three', `KI-TEST/${tag}/3`, `96${tag.slice(-8)}`, '', priced.name,
          '99999', '11111', '2000', '0', '0%', '13111', '7/8/26', '7/8/26', '9/9/26',
          '1000', '7/8/26', `KIPL/T/${tag}/3`, '', '', '', '', '', '',
        ]),
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
      const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer);

      const staged = await stageImport({ fileName: `register-existing-${tag}.xlsx`, buffer });
      await commitImport(staged.batchId);

      const after = await prisma.course.findFirstOrThrow({ where: { id: priced.id } });
      expect(num(after.feeAmount)).toBe(feeBefore);
    });
  });
});
