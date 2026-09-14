/**
 * Invoicing — the obligation, end to end.
 *
 * What was here before could total a sale. It could not produce a document: the
 * GST fields on INVOICE existed and were left at zero, the only thing that
 * could fill them refused to run on anything but a draft, and nothing created a
 * draft. Quantity was stored and never multiplied by, so an invoice for three
 * seats at ₹20,000 totalled ₹20,000 on screen and in the ledger. There was no
 * supplier registration anywhere in the model, which is the one thing that makes
 * a piece of paper a tax invoice rather than a letter about money.
 *
 * Five things this file is built around.
 *
 * **Tax is priced at creation, from the lines.** Per line, because one invoice
 * carries an 18% service beside a 5% good and halving the total misstates both.
 * Stored, not computed at render time, because the invoice was raised under one
 * reading of the place of supply and reprinting it must not silently restate the
 * tax if that reading later changes.
 *
 * **A draft is editable and an issued invoice is not.** Correcting a typo before
 * the document leaves the building is ordinary work and used to be impossible;
 * changing the tax on an invoice a customer already holds is not a correction, it
 * is two different documents with one number, and the answer to it is a credit
 * note.
 *
 * **A draft has no invoice number.** The tax series has to be consecutive — the
 * return reports the range issued and the count cancelled within it — and a
 * number sitting on a draft somebody abandoned is a gap nothing explains. So a
 * draft carries a reference from its own series, obviously not an invoice
 * number, and the invoice number is allocated at the moment the document exists.
 *
 * **A fee line names the enrolment, not just the course.** The invoice says who,
 * the line says which course, and the enrolment is the two together — which is
 * the thing actually being billed. Without it a student on two courses has two
 * fee invoices that can only be told apart by reading the descriptions.
 *
 * **A tax invoice is final, and part payments are receipts.** The invoice states
 * the whole obligation and what was handed over at the moment it was issued —
 * total payable, amount payable now, the mode — and then never changes again. The
 * copy the customer holds has to still read the same in three years, so an
 * instalment that arrives next week does not rewrite it. Each instalment issues a
 * RECEIPT instead, which is its own numbered document carrying its own time, the
 * invoice it is against, the amount, the mode and the balance left. Once the
 * instalments are done somebody raises a FINAL_INVOICE: one statement naming
 * every receipt number, the total payable and what is left. Three documents,
 * because there are three different things a customer needs to be handed.
 *
 * **Whoever is at the counter raises it.** Employees hold `invoices:VCEF@own`, so
 * a walk-in can be enrolled and handed a tax invoice by the person in front of
 * them. The narrowing is real: `createdById` is the owner field the WHERE axis
 * reads, and an employee's list is their own invoices.
 *
 * **A filed period is closed.** Once GSTR-1 for a month is filed, an invoice
 * dated in that month cannot be edited or voided, because the figures in it have
 * been stated to the government.
 */

import {
  EVENTS,
  amountInWords,
  computeGst,
  computePaymentSchedule,
  invoicePayable,
  isInterState,
  isValidGstin,
  paymentTypeFor,
  placeOfSupplyLabel,
  round2,
  stateCodeOf,
  stateNameFor,
  supplyTypeOf,
  type GstLineInput,
  type PaymentMode,
  type RevenueTreatment,
} from '@kaizen/shared';
import { prisma, num, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { companyProfile, documentNumbering, supplyingParty } from './companyProfile.js';
import { DOCUMENT_SERIES, nextDocumentNumber } from '../platform/documentNumber.js';
import { runHooks } from '../platform/hooks.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InvoiceLineInput {
  offeringId?: string | null;
  /** A course from the catalogue. Its price, tax rate and SAC fill the line. */
  courseId?: string | null;
  /**
   * A catalogue add-on of that course — a certification exam, a kit. Its
   * price, tax rate and SAC fill the line the same way a course's do.
   */
  courseAddonId?: string | null;
  /**
   * The student's place on that course. Naming it fills the course in, so
   * billing a fee is one choice rather than two that have to agree.
   */
  enrollmentId?: string | null;
  description?: string | null;
  quantity?: number;
  /** Price of one, before tax and before any discount. Defaults to the course fee when a course is named. */
  unitPrice?: number | null;
  /**
   * The discount on this line, as rupees or as a percentage of
   * `unitPrice x quantity` — give either one, never both. Whichever is given
   * decides the other: a discount amount derives its own percentage, and a
   * percentage derives its own amount, so the two printed on the invoice can
   * never disagree with each other. Absent or zero means no discount.
   */
  discountAmount?: number | null;
  discountPercent?: number | null;
  /** Percentage. Defaults to the course's rate, else 0. */
  gstRate?: number | null;
  hsnSac?: string | null;
  /**
   * taxable | nil | exempt | non_gst (docs/plan/compliance.md, workstream B).
   * Defaults to `taxable`, or to `exempt` when the line bills a course
   * carrying an active `CourseGstExemption` and nothing else was said.
   */
  supplyType?: string | null;
  exemptionNotification?: string | null;
}

export interface CollectedPaymentInput {
  amount: number;
  mode: PaymentMode | string;
  reference?: string | null;
  receivedAt?: Date;
  note?: string | null;
  /**
   * The number this receipt already carried — from an imported register, or a
   * counterfoil the customer is holding. Kept beside the generated record code
   * rather than instead of it.
   */
  legacyReference?: string | null;
}

export interface InvoiceInput {
  accountId?: string | null;
  /** An institution or an organisation, by id. Which of the two it is comes
   *  from the row rather than from the caller. */
  organizationId?: string | null;
  /** A student, by the id of the person they are. */
  personId?: string | null;
  contractId?: string | null;
  opportunityId?: string | null;
  currency?: string;
  issuedDate?: Date;
  dueDate?: Date;
  dueInDays?: number;
  /**
   * When the student enrolled — only meaningful for a course-sale invoice.
   * Printed as a payment-due schedule on the document; stored so a reprint
   * shows the same schedule the original did.
   */
  enrollmentDate?: Date | null;
  /** State code of the place of supply. Defaults from the customer, then from us. */
  placeOfSupply?: string | null;
  customerGstin?: string | null;
  /** Override the derived reading. Almost never needed; honoured when given. */
  interState?: boolean | null;
  division?: string | null;
  notes?: string | null;
  lines: InvoiceLineInput[];
  /** False leaves it a draft, which is the only editable state. */
  issue?: boolean;
  /** Money taken across the counter as the invoice is handed over. */
  payment?: CollectedPaymentInput | null;
}

/**
 * What to call an invoice in a sentence.
 *
 * An issued one has an invoice number; a draft has a draft reference and must
 * never be described by a number it does not have. One function, because a
 * refusal message reading "undefined is still a draft" is the kind of thing
 * nobody notices until a customer is looking at it.
 */
export function invoiceLabel(invoice: { recordCode?: string | null; draftReference?: string | null }): string {
  return invoice.recordCode ?? invoice.draftReference ?? 'this draft';
}

// ---------------------------------------------------------------------------
// Totals — one reading of them, for every caller
// ---------------------------------------------------------------------------

interface WithAmount {
  amount: unknown;
}

export function lineTotalOf(lines: WithAmount[]): number {
  return round2(lines.reduce((s, l) => s + (num(l.amount as never) ?? 0), 0));
}

export interface InvoiceTotals {
  /** What the document is raised at: tax and rounding included. */
  payable: number;
  /** Sum of receipts allocated against it. */
  allocated: number;
  /** Credit notes reducing it. */
  creditNoted: number;
  outstanding: number;
}

/**
 * The three figures, from the rows rather than from a status.
 *
 * Every surface that shows money against an invoice reads this. Four
 * independently written subtractions is how a screen comes to disagree with a
 * ledger, and this used to be four.
 */
export function totalsOf(invoice: {
  grandTotal?: unknown;
  lines: WithAmount[];
  receipts: Array<{ allocatedAmount: unknown }>;
  creditNotes?: Array<{ amount: unknown }>;
}): InvoiceTotals {
  const payable = invoicePayable(num(invoice.grandTotal as never), lineTotalOf(invoice.lines));
  const allocated = round2(
    invoice.receipts.reduce((s, r) => s + (num(r.allocatedAmount as never) ?? 0), 0),
  );
  const creditNoted = round2(
    (invoice.creditNotes ?? []).reduce((s, c) => s + (num(c.amount as never) ?? 0), 0),
  );
  return {
    payable,
    allocated,
    creditNoted,
    outstanding: round2(Math.max(payable - allocated - creditNoted, 0)),
  };
}

// ---------------------------------------------------------------------------
// The period lock
// ---------------------------------------------------------------------------

/**
 * Refuses a change to an invoice whose month has been filed.
 *
 * A filed GSTR-1 is a statement of every outward supply in that month. Editing
 * one afterwards does not correct the return, it makes the books disagree with
 * it — and the disagreement is found by somebody else, later, with a notice. The
 * lawful correction after filing is a credit or debit note in the current
 * period, which this platform issues through `issueCreditNote`.
 */
export async function assertPeriodOpen(date: Date, what: string): Promise<void> {
  const auth = currentAuth();
  const period = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const filed = await prisma.gstFiling.findFirst({
    where: { tenantId: auth.tenantId, period, status: 'filed' },
    orderBy: { filedAt: 'desc' },
  });
  if (filed) {
    throw ApiError.unprocessable(
      `${what} is dated ${period}, and ${filed.returnType} for ${period} was filed as ${filed.recordCode}. ` +
        'A filed period is closed: the correction to an invoice already reported is a credit or debit note in the current period, not an edit to the original.',
      { period, filing: filed.recordCode, returnType: filed.returnType },
    );
  }
}

// ---------------------------------------------------------------------------
// Resolving the customer, the tax reading and the lines
//
// "Customer" is a role on this document, not a kind of record. Three different
// parties can hold it — a student, an institution, an organisation — and which
// one it is says what the invoice is for and how the return reports it. It is
// the one place in the platform where the three meet, and they meet as one
// field: who this obligation is owed by.
// ---------------------------------------------------------------------------

export const CUSTOMER_KINDS = ['student', 'institution', 'organization'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

interface ResolvedCustomer {
  kind: CustomerKind;
  accountId: string | null;
  organizationId: string | null;
  personId: string | null;
  name: string;
  gstin: string | null;
  placeOfSupply: string | null;
  billingAddress: string | null;
  billingEmail: string | null;
}

async function resolveCustomer(input: InvoiceInput): Promise<ResolvedCustomer> {
  const auth = currentAuth();
  const orgId = input.organizationId ?? input.accountId ?? null;

  if (!orgId && !input.personId) {
    throw ApiError.badRequest(
      'An invoice needs a customer: a student, an institution, or an organisation.',
    );
  }
  // Both would be ambiguous about whose obligation it is, which is the one
  // question an invoice exists to answer.
  if (orgId && input.personId) {
    throw ApiError.badRequest(
      'An invoice is addressed to one customer. Name the student, the institution or the organisation — one of the three, not two. A contact at a company is billed through the company.',
    );
  }

  if (orgId) {
    const org = await prisma.organization.findFirst({
      where: { id: orgId, tenantId: auth.tenantId, deletedAt: null },
      include: { account: true },
    });
    if (!org) throw ApiError.notFound('Organisation');
    return {
      kind: org.kind === 'institution' ? 'institution' : 'organization',
      accountId: org.account?.id ? orgId : null,
      organizationId: org.id,
      personId: null,
      name: org.name,
      gstin: input.customerGstin ?? org.account?.gstin ?? null,
      placeOfSupply: input.placeOfSupply ?? org.account?.placeOfSupply ?? null,
      billingAddress: org.account?.billingAddress ?? null,
      billingEmail: org.account?.billingEmail ?? null,
    };
  }

  const person = await prisma.person.findFirst({
    where: { id: input.personId!, tenantId: auth.tenantId, deletedAt: null },
    include: { studentProfile: { include: { sponsor: true, institution: true } } },
  });
  if (!person) throw ApiError.notFound('Person');

  // A person billed in their own name is a student here: it is a training
  // business, and the walk-in who pays for a course is a learner. Where they do
  // not yet have a student record the invoice still goes out — refusing to bill
  // somebody until their paperwork is tidy is not a rule any counter can keep —
  // but the address, the state and any registration come from that record when
  // it exists, which is where they belong and where they are entered once.
  const student = person.studentProfile;

  // Except where somebody else is paying.
  //
  // Skill Development delivers cohorts commissioned by a scheme or a sponsor,
  // and a beneficiary of a funded cohort owes nothing. They sit in the same
  // classroom as a learner who walked in and paid, so nothing about the course
  // distinguishes them — only this. An invoice addressed to them is a document
  // that should never have existed, and it is refused here rather than
  // discovered when it is in their hands.
  if (student && student.funding !== 'self') {
    const payer =
      student.funding === 'sponsor'
        ? (student.sponsor?.name ?? 'their sponsor')
        : student.funding === 'institution'
          ? (student.institution?.name ?? 'their college')
          : `the ${student.fundingFramework?.replace(/_/g, ' ') ?? 'scheme'} framework`;
    throw ApiError.badRequest(
      `${person.fullName}'s place is paid for by ${payer}, so no invoice is addressed to them. Bill ${
        student.funding === 'scheme' ? 'the sponsoring body' : payer
      } instead, naming the learners the fee covers.`,
    );
  }
  return {
    kind: 'student',
    accountId: null,
    organizationId: null,
    personId: person.id,
    name: person.fullName,
    gstin: input.customerGstin ?? student?.gstin ?? null,
    placeOfSupply: input.placeOfSupply ?? student?.placeOfSupply ?? null,
    billingAddress: student?.address ?? null,
    billingEmail: person.primaryEmail ?? null,
  };
}

/**
 * Which tax applies, and where the supply is made to.
 *
 * The order matters and each step is a fact rather than a guess:
 *
 *   1. an explicit answer from the caller wins, because a human who says so has
 *      looked at something this code cannot see;
 *   2. two GSTINs decide it — their first two digits are the states, and that is
 *      what the law compares;
 *   3. a place of supply against our own state code decides it for an
 *      unregistered customer, which is the B2C case and the common one;
 *   4. with nothing to go on, the supply is treated as intra-state with our own
 *      state as the place of supply. Not because that is always right, but
 *      because it is the reading that does not invent a second state, and the
 *      alternative — refusing the invoice — stops a counter from working.
 */
async function resolveTaxReading(
  input: InvoiceInput,
  customer: ResolvedCustomer,
): Promise<{ interState: boolean; placeOfSupply: string | null; customerGstin: string | null }> {
  const us = await supplyingParty();
  const customerGstin = customer.gstin ? customer.gstin.trim().toUpperCase() : null;

  if (customerGstin && !isValidGstin(customerGstin)) {
    throw ApiError.badRequest(
      `${customerGstin} is not a valid GSTIN. Leave it blank for an unregistered customer — a B2C sale is a normal thing for an invoice to be, and a wrong registration on it is not.`,
    );
  }

  const placeOfSupply =
    customer.placeOfSupply ?? stateCodeOf(customerGstin) ?? us.stateCode ?? null;

  if (input.interState !== null && input.interState !== undefined) {
    return { interState: input.interState, placeOfSupply, customerGstin };
  }

  const fromGstins = isInterState(us.gstin, customerGstin);
  if (fromGstins !== null) return { interState: fromGstins, placeOfSupply, customerGstin };

  if (us.stateCode && placeOfSupply) {
    return { interState: us.stateCode !== placeOfSupply, placeOfSupply, customerGstin };
  }

  return { interState: false, placeOfSupply, customerGstin };
}

interface PricedLine {
  offeringId: string | null;
  courseId: string | null;
  courseAddonId: string | null;
  enrollmentId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  /** unitPrice x quantity, before the discount. Not stored — recovered at read time from unitPrice and quantity. */
  grossAmount: number;
  /** grossAmount less the discount. The taxable value: what GST is computed on. */
  amount: number;
  discountAmount: number;
  discountPercent: number;
  gstRate: number;
  hsnSac: string | null;
  revenueMethod: RevenueTreatment;
  position: number;
  supplyType: string;
  exemptionNotification: string | null;
}

/**
 * Resolves a line's discount from whichever side of it the caller gave.
 *
 * A discount is one fact wearing two units, and the counter should be able to
 * type either: "knock ₹2,000 off" or "give them 10% off". Whichever arrives,
 * the other is derived from it against the line's own gross value, so the
 * amount and the percentage printed on the invoice can never disagree with
 * each other — there is exactly one number here, not two that happen to
 * usually match.
 */
function resolveDiscount(
  gross: number,
  input: { discountAmount?: number | null; discountPercent?: number | null },
  description: string,
): { discountAmount: number; discountPercent: number } {
  const hasAmount = input.discountAmount !== null && input.discountAmount !== undefined;
  const hasPercent = input.discountPercent !== null && input.discountPercent !== undefined;

  if (hasAmount && hasPercent) {
    throw ApiError.badRequest(
      `"${description}" was given both a discount amount and a discount percentage. Give one — the other is worked out from it.`,
    );
  }

  if (hasAmount) {
    const discountAmount = round2(input.discountAmount!);
    if (discountAmount < 0) throw ApiError.badRequest(`The discount on "${description}" cannot be negative.`);
    if (discountAmount > gross + 0.001) {
      throw ApiError.badRequest(
        `The discount on "${description}" (₹${discountAmount.toFixed(2)}) is more than its fee of ₹${gross.toFixed(2)}.`,
      );
    }
    const discountPercent = gross > 0 ? round2((discountAmount / gross) * 100) : 0;
    return { discountAmount, discountPercent };
  }

  if (hasPercent) {
    const discountPercent = round2(input.discountPercent!);
    if (discountPercent < 0 || discountPercent > 100) {
      throw ApiError.badRequest(`The discount on "${description}" has to be a percentage between 0 and 100.`);
    }
    const discountAmount = round2((gross * discountPercent) / 100);
    return { discountAmount, discountPercent };
  }

  return { discountAmount: 0, discountPercent: 0 };
}

/**
 * Turns what the caller asked for into lines that can be priced.
 *
 * A line naming a course carries none of the numbers: the fee, the rate and the
 * SAC are facts about the course, and an employee at a counter should not have
 * to know the price list or the tax code to raise an invoice. Anything given
 * explicitly still wins, because a negotiated price is a real thing.
 */
async function priceLines(lines: InvoiceLineInput[], customer: ResolvedCustomer): Promise<PricedLine[]> {
  const auth = currentAuth();
  if (lines.length === 0) throw ApiError.badRequest('An invoice needs at least one line.');

  const out: PricedLine[] = [];
  for (const [position, line] of lines.entries()) {
    let description = line.description?.trim() || '';
    let unitPrice = line.unitPrice ?? null;
    let gstRate = line.gstRate ?? null;
    let hsnSac = line.hsnSac ?? null;
    let revenueMethod: RevenueTreatment = 'point_in_time';
    let courseId = line.courseId ?? null;
    let courseAddonId = line.courseAddonId ?? null;
    let enrollmentId: string | null = null;

    // The enrolment is the student on the course, which is the thing being
    // billed. Naming it fills the course in and is checked against the customer:
    // an invoice to one person carrying another person's enrolment would look
    // right on the page and be wrong in every report that joins the two.
    if (line.enrollmentId) {
      const enrollment = await prisma.enrollment.findFirst({
        where: { id: line.enrollmentId, tenantId: auth.tenantId },
        include: { cohort: { select: { courseId: true, name: true } } },
      });
      if (!enrollment) throw ApiError.notFound('Enrollment');
      if (customer.personId && enrollment.personId !== customer.personId) {
        throw ApiError.badRequest(
          `That enrolment belongs to somebody else. An invoice bills one customer, and a fee line has to be for their own place on the course.`,
        );
      }
      if (courseId && courseId !== enrollment.cohort.courseId) {
        throw ApiError.badRequest(
          `The course on this line is not the course that enrolment is on (${enrollment.cohort.name}).`,
        );
      }
      courseId = enrollment.cohort.courseId;
      enrollmentId = enrollment.id;
    }

    // A catalogue add-on — priced, taxed and classified the same way a course
    // is, so naming one is also one choice rather than knowing its price list.
    if (courseAddonId) {
      const addon = await prisma.courseAddon.findFirst({
        where: { id: courseAddonId, tenantId: auth.tenantId },
      });
      if (!addon) throw ApiError.notFound('Course add-on');
      if (!addon.active) {
        throw ApiError.unprocessable(`"${addon.name}" is retired and cannot be billed.`);
      }
      if (courseId && courseId !== addon.courseId) {
        throw ApiError.badRequest(`"${addon.name}" is not an add-on of the course named on this line.`);
      }
      courseId = addon.courseId;
      description = description || addon.name;
      if (unitPrice === null) unitPrice = num(addon.price);
      if (gstRate === null) gstRate = num(addon.gstRate);
      hsnSac = hsnSac ?? addon.hsnSac;
    }

    if (courseId) {
      const course = await prisma.course.findFirst({
        where: { id: courseId, tenantId: auth.tenantId },
      });
      if (!course) throw ApiError.notFound('Course');
      if (!course.active) {
        throw ApiError.unprocessable(
          `${course.name} (${course.code}) is retired and cannot be billed. Reactivate it on the course page if it is being sold again.`,
        );
      }
      description = description || `${course.name} (${course.code})`;
      if (unitPrice === null) unitPrice = num(course.feeAmount);
      if (gstRate === null) gstRate = num(course.gstRate);
      hsnSac = hsnSac ?? course.hsnSac;
      // A course sold over weeks is earned over weeks. That is the course's own
      // property, not a question for whoever raises the invoice.
      revenueMethod = 'over_time_ratable';
    }
    // An add-on is a one-time extra, not something delivered over the course's
    // own run — recognised when sold, whichever course it rides along with.
    if (courseAddonId) revenueMethod = 'point_in_time';

    if (line.offeringId) {
      const offering = await prisma.offering.findFirst({
        where: { id: line.offeringId, tenantId: auth.tenantId },
        select: { name: true, defaultRevenueTreatment: true },
      });
      if (!offering) throw ApiError.notFound('Offering');
      description = description || offering.name;
      revenueMethod = (offering.defaultRevenueTreatment as RevenueTreatment) ?? revenueMethod;
    }

    if (!description) {
      throw ApiError.badRequest('Every line needs a description, or a course or offering to take one from.');
    }
    if (unitPrice === null || Number.isNaN(unitPrice)) {
      throw ApiError.badRequest(
        `No price for "${description}". Give the line an amount, or set a fee on the course it bills.`,
      );
    }
    if (unitPrice < 0) throw ApiError.badRequest(`A line cannot have a negative price: "${description}".`);

    const quantity = line.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw ApiError.badRequest(`Quantity on "${description}" must be a whole number of one or more.`);
    }

    // The extended value, before any discount. The line used to carry one
    // figure and a quantity that nothing multiplied by, which is how three
    // seats billed as one.
    const grossAmount = round2(round2(unitPrice) * quantity);
    const { discountAmount, discountPercent } = resolveDiscount(grossAmount, line, description);

    // Supply classification (docs/plan/compliance.md, workstream B). A course
    // carrying an active exemption defaults its line to `exempt` — but only
    // when nothing was said explicitly, because an exemption asserted for the
    // course is not automatically the right reading of every fee against it
    // (an add-on billed alongside, say).
    let supplyType = (line.supplyType?.trim() || null) as string | null;
    let exemptionNotification = line.exemptionNotification?.trim() || null;
    if (!supplyType && courseId) {
      const exemption = await prisma.courseGstExemption.findFirst({
        where: { tenantId: auth.tenantId, courseId, active: true },
      });
      if (exemption) {
        supplyType = 'exempt';
        exemptionNotification = exemption.notification;
      }
    }
    supplyType = supplyType ?? 'taxable';
    const nonTaxable = supplyType === 'nil' || supplyType === 'exempt' || supplyType === 'non_gst';
    if (nonTaxable) {
      gstRate = 0;
    } else {
      exemptionNotification = null;
    }

    out.push({
      offeringId: line.offeringId ?? null,
      courseId,
      courseAddonId,
      enrollmentId,
      description,
      quantity,
      unitPrice: round2(unitPrice),
      grossAmount,
      // The taxable value: the gross fee less the discount. This, not the
      // gross figure, is what GST is computed on and what the customer owes.
      amount: round2(grossAmount - discountAmount),
      discountAmount,
      discountPercent,
      gstRate: round2(gstRate ?? 0),
      hsnSac,
      revenueMethod,
      position,
      supplyType,
      exemptionNotification,
    });
  }
  return out;
}

function gstInputOf(lines: PricedLine[]): GstLineInput[] {
  return lines.map((l) => ({ taxableValue: l.amount, gstRate: l.gstRate }));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Raises an invoice, priced and optionally paid, in one act.
 *
 * `issue: false` leaves it a draft, which is the editable state. `payment`
 * collects money as the document is handed over and is only accepted on an
 * invoice being issued — a draft is not a thing a customer can pay against,
 * because it is not a document yet.
 */
export async function createInvoice(input: InvoiceInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'create' });

  const customer = await resolveCustomer(input);
  const priced = await priceLines(input.lines, customer);
  const tax = await resolveTaxReading(input, customer);
  const gst = computeGst(gstInputOf(priced), tax.interState);

  const issue = input.issue !== false;
  const issuedDate = input.issuedDate ?? new Date();
  if (issue) await assertPeriodOpen(issuedDate, 'This invoice');

  const profile = await companyProfile();
  const dueDate =
    input.dueDate ??
    new Date(issuedDate.getTime() + (input.dueInDays ?? profile.defaultDueDays) * 86_400_000);
  if (dueDate < issuedDate) {
    throw ApiError.badRequest('An invoice cannot fall due before it is issued.');
  }

  // What the document will say about payment. Derived from the figure rather
  // than asked for separately: a clerk choosing "full payment" and typing a
  // smaller number produces a document that contradicts itself, and the
  // customer is the one who finds out.
  const payingNow = round2(input.payment?.amount ?? 0);
  if (payingNow < 0) throw ApiError.badRequest('An amount collected cannot be negative.');
  if (payingNow > gst.grandTotal + 0.001) {
    throw ApiError.unprocessable(
      `₹${payingNow.toFixed(2)} is more than the invoice total of ₹${gst.grandTotal.toFixed(2)}. ` +
        'Money taken beyond an invoice is an advance, not a payment against it — record it on Payments and allocate it when the next invoice is raised.',
      { payable: gst.grandTotal, offered: payingNow },
    );
  }
  if (payingNow > 0 && !issue) {
    throw ApiError.unprocessable(
      'A draft cannot be paid: it is not a document a customer has been given yet. Issue it, then collect against it.',
    );
  }
  if (payingNow > 0 && !input.payment?.mode) {
    throw ApiError.badRequest('Say how the money was taken — cash, UPI, bank transfer, cheque or card. It is printed on the invoice.');
  }

  // The invoice number is allocated only when the document exists, and it is the
  // company's own series — `KIPL/I/2026-27/001` — because that is the number the
  // customer quotes back and the number GSTR-1 reports. A draft gets a reference
  // from the platform's own series instead: the tax series has to be
  // consecutive, and a number sitting on a draft nobody issued is a gap the
  // return cannot explain.
  const numbering = await documentNumbering();
  const recordCode = issue
    ? await nextDocumentNumber(DOCUMENT_SERIES.invoice, numbering.prefix, issuedDate, numbering.yearFormat)
    : null;
  const draftReference = await nextRecordCode('DRF');

  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        draftReference,
        accountId: customer.accountId,
        organizationId: customer.organizationId,
        personId: customer.personId,
        contractId: input.contractId ?? null,
        opportunityId: input.opportunityId ?? null,
        status: issue ? 'issued' : 'draft',
        currency: input.currency ?? 'INR',
        issuedDate: issue ? issuedDate : null,
        dueDate,
        enrollmentDate: input.enrollmentDate ?? null,
        placeOfSupply: tax.placeOfSupply,
        interState: tax.interState,
        customerGstin: tax.customerGstin,
        taxableValue: gst.taxableValue,
        cgstAmount: gst.cgst,
        sgstAmount: gst.sgst,
        igstAmount: gst.igst,
        roundOff: gst.roundOff,
        grandTotal: gst.grandTotal,
        division: input.division ?? null,
        // The declaration, before any money is taken. `collectInvoicePayment`
        // moves it if a payment follows.
        paymentType: 'credit',
        amountPayableNow: 0,
        notes: input.notes ?? null,
        createdById: auth.partyId,
      },
    });
    await writeLines(tx, created.id, priced);
    return created;
  });

  // GST classification rules and e-invoicing readiness attach here too
  // (workstream B) — `createInvoice` with `issue: true` raises and issues in
  // one act, and the hook `issueInvoiceDraft` runs at its own issue point has
  // to run here as well, or a document created this way never sees it.
  if (issue) {
    const freshLines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    await runHooks('invoice.before_issue', { invoice, lines: freshLines, issuedDate });
  }

  await auditWrite({
    action: 'create',
    subjectType: 'invoice',
    subjectId: invoice.id,
    after: {
      recordCode,
      draftReference,
      payable: gst.grandTotal,
      status: invoice.status,
      customer: customer.name,
    },
  });

  await emit({
    name: issue ? EVENTS.INVOICE_ISSUED : EVENTS.INVOICE_DRAFTED,
    subject: { entityType: 'invoice', entityId: invoice.id, recordCode: recordCode ?? draftReference },
    related: input.contractId
      ? [{ relation: 'bills', entityType: 'contract', entityId: input.contractId }]
      : [],
    newState: {
      total: gst.grandTotal,
      taxableValue: gst.taxableValue,
      tax: gst.tax,
      interState: tax.interState,
      dueDate,
      customer: customer.name,
    },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  if (payingNow > 0) {
    await collectInvoicePayment(invoice.id, input.payment!, { atIssue: true });
  }

  await rehydrateReceivablesFor(invoice.organizationId ?? invoice.accountId);
  return prisma.invoice.findFirstOrThrow({
    where: { id: invoice.id },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
  });
}

async function writeLines(tx: DbTx, invoiceId: string, priced: PricedLine[]) {
  const auth = currentAuth();
  for (const line of priced) {
    await tx.invoiceLine.create({
      data: {
        tenantId: auth.tenantId,
        invoiceId,
        offeringId: line.offeringId,
        courseId: line.courseId,
        courseAddonId: line.courseAddonId,
        enrollmentId: line.enrollmentId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        discountAmount: line.discountAmount,
        discountPercent: line.discountPercent,
        gstRate: line.gstRate,
        // Per line, because an invoice carrying an 18% service and a 5% good
        // cannot be described by one rate.
        taxAmount: round2((line.amount * line.gstRate) / 100),
        hsnSac: line.hsnSac,
        position: line.position,
        revenueMethod: line.revenueMethod,
        supplyType: line.supplyType,
        exemptionNotification: line.exemptionNotification,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Edit — drafts only
// ---------------------------------------------------------------------------

/**
 * Rewrites a draft and reprices it.
 *
 * Whole-lines replacement rather than per-line patching: an invoice's tax is a
 * property of the set of lines, so a half-applied edit is an invoice with a tax
 * that belongs to neither version. Replacing them and repricing in one
 * transaction means there is no moment at which the document is wrong.
 */
export async function updateInvoice(
  invoiceId: string,
  input: Omit<InvoiceInput, 'issue' | 'payment' | 'lines'> & { lines?: InvoiceLineInput[] },
) {
  const auth = currentAuth();
  const existing = await loadForWrite(invoiceId, 'edit');

  if (existing.status !== 'draft') {
    throw ApiError.unprocessable(
      `${invoiceLabel(existing)} is ${existing.status}. An issued invoice is a document the customer holds — changing its lines or its tax would make two different invoices with one number. The correction is a credit note.`,
      { status: existing.status },
    );
  }

  const customer = await resolveCustomer({
    ...input,
    organizationId: input.organizationId ?? existing.organizationId,
    accountId: input.accountId ?? existing.accountId,
    personId:
      input.personId ??
      (input.organizationId || input.accountId ? null : existing.personId),
    customerGstin: input.customerGstin ?? existing.customerGstin,
    placeOfSupply: input.placeOfSupply ?? existing.placeOfSupply,
    lines: [],
  });

  const priced = await priceLines(
    input.lines ??
      existing.lines.map((l) => ({
        offeringId: l.offeringId,
        courseId: l.courseId,
        courseAddonId: l.courseAddonId,
        enrollmentId: l.enrollmentId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: num(l.unitPrice) || num(l.amount) || 0,
        discountAmount: num(l.discountAmount) || null,
        gstRate: num(l.gstRate),
        hsnSac: l.hsnSac,
        supplyType: l.supplyType,
        exemptionNotification: l.exemptionNotification,
      })),
    customer,
  );
  const tax = await resolveTaxReading({ ...input, lines: [] }, customer);
  const gst = computeGst(gstInputOf(priced), tax.interState);

  const before = {
    payable: num(existing.grandTotal),
    lines: existing.lines.length,
    customer: existing.organizationId ?? existing.personId,
  };

  const updated = await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.deleteMany({ where: { invoiceId } });
    await writeLines(tx, invoiceId, priced);
    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        accountId: customer.accountId,
        organizationId: customer.organizationId,
        personId: customer.personId,
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.enrollmentDate !== undefined ? { enrollmentDate: input.enrollmentDate } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.division !== undefined ? { division: input.division } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        placeOfSupply: tax.placeOfSupply,
        interState: tax.interState,
        customerGstin: tax.customerGstin,
        taxableValue: gst.taxableValue,
        cgstAmount: gst.cgst,
        sgstAmount: gst.sgst,
        igstAmount: gst.igst,
        roundOff: gst.roundOff,
        grandTotal: gst.grandTotal,
      },
    });
  });

  await auditWrite({
    action: 'update',
    subjectType: 'invoice',
    subjectId: invoiceId,
    before,
    after: { payable: gst.grandTotal, lines: priced.length, customer: customer.organizationId ?? customer.personId },
  });
  await emit({
    name: EVENTS.INVOICE_UPDATED,
    subject: { entityType: 'invoice', entityId: invoiceId, recordCode: invoiceLabel(existing) },
    previousState: before,
    newState: { payable: gst.grandTotal, lines: priced.length },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  return prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
  });
}

/** Turns a draft into the document, optionally taking money for it. */
export async function issueInvoiceDraft(
  invoiceId: string,
  options: { issuedDate?: Date; payment?: CollectedPaymentInput | null } = {},
) {
  const existing = await loadForWrite(invoiceId, 'edit');
  if (existing.status !== 'draft') {
    throw ApiError.unprocessable(`${invoiceLabel(existing)} is already ${existing.status}.`);
  }
  if (existing.lines.length === 0) {
    throw ApiError.unprocessable(
      `${invoiceLabel(existing)} has no lines. An invoice for nothing is not a document.`,
    );
  }

  const issuedDate = options.issuedDate ?? new Date();
  await assertPeriodOpen(issuedDate, 'This invoice');
  // GST classification rules and e-invoicing readiness attach here (workstream B).
  await runHooks('invoice.before_issue', { invoice: existing, lines: existing.lines, issuedDate });

  // Here is where the invoice number is allocated, and nowhere else: at the
  // moment the draft becomes a document. Allocating it inside the same update
  // as the status means the two cannot come apart.
  const numbering = await documentNumbering();
  const recordCode =
    existing.recordCode ??
    (await nextDocumentNumber(DOCUMENT_SERIES.invoice, numbering.prefix, issuedDate, numbering.yearFormat));

  const issued = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'issued', issuedDate, recordCode },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'invoice',
    subjectId: invoiceId,
    before: { status: 'draft', recordCode: existing.recordCode },
    after: { status: 'issued', issuedDate, recordCode },
  });
  await emit({
    name: EVENTS.INVOICE_ISSUED,
    subject: { entityType: 'invoice', entityId: invoiceId, recordCode },
    newState: { total: num(issued.grandTotal), dueDate: issued.dueDate, from: existing.draftReference },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  if (options.payment && options.payment.amount > 0) {
    await collectInvoicePayment(invoiceId, options.payment, { atIssue: true });
  }

  await rehydrateReceivablesFor(issued.organizationId ?? issued.accountId);
  return prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
  });
}

/**
 * Voids an invoice that never should have existed.
 *
 * Only while nothing has been paid against it and only before its period is
 * filed. Anything else is a credit note: books are not deleted, and an invoice
 * a customer has paid into is a fact whatever anybody wishes about it.
 */
export async function voidInvoice(invoiceId: string, reason: string) {
  const existing = await loadForWrite(invoiceId, 'edit');
  const totals = totalsOf(existing);

  if (totals.allocated > 0) {
    throw ApiError.unprocessable(
      `${invoiceLabel(existing)} has ₹${totals.allocated.toFixed(2)} allocated against it and cannot be voided. Reverse the payment and raise a credit note — the money moved, and the books have to keep saying so.`,
    );
  }
  if (existing.status === 'void') return existing;
  if (existing.issuedDate) await assertPeriodOpen(existing.issuedDate, 'This invoice');

  const voided = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'void', notes: existing.notes ? `${existing.notes}\n\nVoided: ${reason}` : `Voided: ${reason}` },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'invoice',
    subjectId: invoiceId,
    before: { status: existing.status },
    after: { status: 'void', reason },
  });
  await emit({
    name: EVENTS.INVOICE_VOIDED,
    subject: { entityType: 'invoice', entityId: invoiceId, recordCode: invoiceLabel(existing) },
    newState: { status: 'void', reason },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  await rehydrateReceivablesFor(voided.organizationId ?? voided.accountId);
  return voided;
}

// ---------------------------------------------------------------------------
// Collecting money at the counter
// ---------------------------------------------------------------------------

/**
 * Takes a payment against an invoice and issues the receipt for it.
 *
 * One call, because at a counter it is one act: the money arrives, a receipt
 * allocates it, and the customer walks away holding a document for what they
 * handed over. Doing it in three calls is what left the ledger correct and the
 * customer with nothing.
 *
 * What it does **not** do is restate the invoice. An issued tax invoice is final:
 * its declaration — full, part or credit, the amount payable now, the mode — is
 * what was true when it was handed over, and a payment arriving afterwards is a
 * new fact with its own document rather than an edit to an old one. The only
 * thing on the invoice that moves is `status`, which has always followed the
 * receipts and is not part of what is printed.
 *
 * `atIssue` is the one exception and is set only by the two paths that issue an
 * invoice: money taken as the document is handed over *is* what the document
 * says about payment.
 */
export async function collectInvoicePayment(
  invoiceId: string,
  input: CollectedPaymentInput,
  options: { atIssue?: boolean } = {},
) {
  const auth = currentAuth();
  const invoice = await loadForWrite(invoiceId, 'edit');
  await assertCan({ resource: 'payments', verb: 'create' });

  if (invoice.status === 'draft') {
    throw ApiError.unprocessable(
      `${invoiceLabel(invoice)} is still a draft, and has no invoice number yet. Issue it before taking money against it, so the customer has a document for what they paid.`,
    );
  }
  if (invoice.status === 'void') {
    throw ApiError.unprocessable(`${invoiceLabel(invoice)} is void. Nothing can be collected against it.`);
  }

  const totals = totalsOf(invoice);
  const amount = round2(input.amount);
  if (amount <= 0) throw ApiError.badRequest('A payment has to be for something.');
  if (amount > totals.outstanding + 0.001) {
    throw ApiError.unprocessable(
      `₹${amount.toFixed(2)} is more than the ₹${totals.outstanding.toFixed(2)} still outstanding on ${invoiceLabel(invoice)}. ` +
        'Take the balance, or record the excess as a payment on its own and allocate it to the next invoice.',
      { outstanding: totals.outstanding, offered: amount },
    );
  }
  if (!input.mode) {
    throw ApiError.badRequest('Say how the money was taken. It is printed on the invoice.');
  }

  const receivedAt = input.receivedAt ?? new Date();
  // A counter payment has no gateway behind it, so the reference is the
  // invoice and the moment: unique per tenant, which is what makes the
  // idempotency constraint on PAYMENT mean something for cash as well as for
  // a webhook.
  const gatewayReference =
    input.reference?.trim() || `${invoiceLabel(invoice)}/${input.mode}/${receivedAt.toISOString()}`;

  const clash = await prisma.payment.findFirst({
    where: { tenantId: auth.tenantId, gatewayReference },
  });
  if (clash) {
    throw ApiError.conflict(
      `A payment with the reference ${gatewayReference} is already on file as ${clash.recordCode}. ` +
        'Two payments with one reference cannot both be reconciled later, so this one is refused rather than accepted and left ambiguous.',
      { existing: clash.recordCode },
    );
  }

  const paymentCode = await nextRecordCode('PAY');
  // The receipt is a document the customer is handed, so it is numbered in the
  // company's series. The payment behind it is an internal fact and keeps a
  // record code.
  const numbering = await documentNumbering();
  const receiptCode = await nextDocumentNumber(
    DOCUMENT_SERIES.receipt,
    numbering.prefix,
    receivedAt,
    numbering.yearFormat,
  );
  const allocated = round2(totals.allocated + amount);
  const balanceAfter = round2(Math.max(totals.payable - allocated - totals.creditNoted, 0));
  const settled = allocated + totals.creditNoted >= totals.payable - 0.001;

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: paymentCode,
        amount,
        currency: invoice.currency,
        gatewayReference,
        receivedAt,
        status: 'received',
        method: input.mode,
        payerOrganizationId: invoice.organizationId,
        payerPersonId: invoice.personId,
        recordedById: auth.partyId,
        note: input.note ?? `Collected against ${invoiceLabel(invoice)}`,
      },
    });

    // The receipt carries its own copy of the position: what the invoice was
    // for, and what was left after this instalment. Snapshotted rather than
    // recomputed, because a receipt saying "₹20,000 of ₹70,800, ₹50,800 still
    // owed" has to keep saying that after the next instalment lands.
    const receipt = await tx.receipt.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: receiptCode,
        paymentId: payment.id,
        invoiceId: invoice.id,
        allocatedAmount: amount,
        allocatedAt: receivedAt,
        allocatedById: auth.partyId,
        subjectTotal: totals.payable,
        balanceAfter,
        paymentMode: input.mode,
        paymentReference: input.reference?.trim() || null,
        legacyReference: input.legacyReference?.trim() || null,
        note: input.note ?? null,
      },
    });

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        // `status` follows the receipts and is not part of the printed invoice.
        status: settled ? 'settled' : 'part_paid',
        // The declaration is written only when the money is taken as the
        // document is handed over. Afterwards the invoice is final and this
        // instalment's own receipt is what states it.
        ...(options.atIssue
          ? {
              paymentType: paymentTypeFor(totals.payable, amount),
              amountPayableNow: amount,
              paymentMode: input.mode,
              paymentReference: input.reference?.trim() || null,
            }
          : {}),
      },
    });
    return { payment, receipt, invoice: updated };
  });

  await auditWrite({
    action: 'create',
    subjectType: 'payment',
    subjectId: result.payment.id,
    after: { recordCode: paymentCode, amount, mode: input.mode, against: invoiceLabel(invoice) },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'receipt',
    subjectId: result.receipt.id,
    after: { recordCode: receiptCode, amount, against: invoiceLabel(invoice), balanceAfter },
  });

  await emit({
    name: EVENTS.RECEIPT_ISSUED,
    subject: { entityType: 'receipt', entityId: result.receipt.id, recordCode: receiptCode },
    related: [
      { relation: 'against', entityType: 'invoice', entityId: invoice.id },
      { relation: 'from', entityType: 'payment', entityId: result.payment.id },
    ],
    newState: { amount, mode: input.mode, subjectTotal: totals.payable, balanceAfter, settled },
    impact: {
      domains: ['fin'],
      materiality: { measure: 'payment_amount', value: amount, currency: invoice.currency },
    },
    confidentiality: 'confidential',
  });

  await emit({
    name: EVENTS.INVOICE_PAYMENT_COLLECTED,
    subject: { entityType: 'invoice', entityId: invoice.id, recordCode: invoiceLabel(invoice) },
    related: [
      { relation: 'paid_by', entityType: 'payment', entityId: result.payment.id },
      { relation: 'receipted_by', entityType: 'receipt', entityId: result.receipt.id },
    ],
    newState: {
      amount,
      mode: input.mode,
      receipt: receiptCode,
      allocated,
      outstanding: balanceAfter,
      settled,
      // The invoice itself was not restated unless this was the payment it was
      // handed over with.
      declarationWritten: Boolean(options.atIssue),
    },
    impact: {
      domains: ['fin'],
      materiality: { measure: 'payment_amount', value: amount, currency: invoice.currency },
    },
    confidentiality: 'confidential',
  });

  if (settled) {
    await emit({
      name: EVENTS.INVOICE_SETTLED,
      subject: { entityType: 'invoice', entityId: invoice.id, recordCode: invoiceLabel(invoice) },
      newState: { status: 'settled', allocated },
      impact: { domains: ['fin'] },
    });
  }

  await rehydrateReceivablesFor(invoice.organizationId ?? invoice.accountId);
  return {
    payment: result.payment,
    receipt: result.receipt,
    invoice: result.invoice,
    totals: { payable: totals.payable, allocated, outstanding: balanceAfter },
    /**
     * Whether the instalments are done, which is when somebody raises the final
     * invoice. Returned so the surface can offer it at the moment it becomes the
     * obvious next thing to do, rather than making it something you have to know
     * to go and look for.
     */
    readyForFinalInvoice: settled,
  };
}

/**
 * States what the invoice will ask for now, before it is issued.
 *
 * The counter case where somebody will pay half in cash on collection and the
 * rest by transfer next week: the document has to say "part payment, ₹5,000 now"
 * even before the transfer lands, or the copy the customer keeps does not match
 * what was agreed.
 *
 * Drafts only. Once the invoice is issued it is final — the declaration on it is
 * what was true on the day, and a later instalment is a receipt rather than an
 * amendment to a document somebody is already holding.
 */
export async function declarePaymentTerms(
  invoiceId: string,
  input: { amountPayableNow: number; paymentMode?: string | null; paymentReference?: string | null },
) {
  const invoice = await loadForWrite(invoiceId, 'edit');
  if (invoice.status !== 'draft') {
    throw ApiError.unprocessable(
      `${invoiceLabel(invoice)} is ${invoice.status}. A tax invoice is final once issued: what it says about payment is what was true when the customer was handed it. Take the instalment instead — it issues its own receipt — and raise a final invoice when the instalments are done.`,
      { status: invoice.status },
    );
  }
  const totals = totalsOf(invoice);
  const now = round2(input.amountPayableNow);

  if (now < 0) throw ApiError.badRequest('An amount payable now cannot be negative.');
  if (now > totals.payable + 0.001) {
    throw ApiError.unprocessable(
      `₹${now.toFixed(2)} is more than the invoice total of ₹${totals.payable.toFixed(2)}.`,
      { payable: totals.payable },
    );
  }

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPayableNow: now,
      paymentType: paymentTypeFor(totals.payable, now),
      ...(input.paymentMode !== undefined ? { paymentMode: input.paymentMode } : {}),
      ...(input.paymentReference !== undefined ? { paymentReference: input.paymentReference } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'invoice',
    subjectId: invoiceId,
    before: { amountPayableNow: num(invoice.amountPayableNow), paymentType: invoice.paymentType },
    after: { amountPayableNow: now, paymentType: updated.paymentType },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadForWrite(invoiceId: string, verb: 'edit' | 'delete') {
  const auth = currentAuth();
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: auth.tenantId, deletedAt: null },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: true },
  });
  if (!invoice) throw ApiError.notFound('Invoice');

  // The WHERE axis, on the record. `createdById` is the owner field, which is
  // what makes `invoices:VCEF@own` on the employee row a real narrowing rather
  // than a label: an employee reaches the invoices they raised.
  await assertCan({
    resource: 'invoices',
    verb,
    record: { ownerPartyId: invoice.createdById },
    classification: 'confidential',
  });
  return invoice;
}

/**
 * Readable by anyone who may see the invoice, with the same scope narrowing.
 *
 * Exported because the receipt and the final invoice are documents *about* an
 * invoice: whether somebody may read them is the same question as whether they
 * may read the invoice, and asking it twice in two files is how the two answers
 * come to differ.
 */
export async function loadInvoiceForRead(invoiceId: string) {
  const auth = currentAuth();
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: auth.tenantId, deletedAt: null },
    include: { lines: { orderBy: { position: 'asc' } }, receipts: { include: { payment: true } } },
  });
  if (!invoice) throw ApiError.notFound('Invoice');
  await assertCan({
    resource: 'invoices',
    verb: 'view',
    record: { ownerPartyId: invoice.createdById },
    classification: 'confidential',
  });
  return invoice;
}

export async function invoiceSummary(invoiceId: string) {
  const invoice = await loadInvoiceForRead(invoiceId);
  const creditNotes = await prisma.creditNote.findMany({ where: { invoiceId } });
  const totals = totalsOf({ ...invoice, creditNotes });
  return { invoice, ...totals, total: totals.payable };
}

/**
 * The invoice as a document.
 *
 * Everything a printed tax invoice needs, resolved once on the server: who is
 * supplying, who is being billed, the lines with their own tax, the split that
 * applies, both totals, what was taken and how, and the amount in words. The
 * client renders it and computes nothing — a screen that recomputes a total is a
 * screen that can disagree with the ledger, and the version the customer holds
 * is the one that has to be right.
 *
 * Two blocks, and the split matters. `totals` is what the tax invoice says, fixed
 * at issue: the whole obligation and the amount payable then. `position` is where
 * the account stands today, which is a different fact and belongs beside the
 * document rather than on it — an issued invoice is final, and printing today's
 * balance on it would make a reprint disagree with the copy in the customer's
 * file. The instalments since are receipts, listed here by number, each its own
 * document.
 */
export async function invoiceDocument(invoiceId: string) {
  const invoice = await loadInvoiceForRead(invoiceId);
  const profile = await companyProfile();
  const creditNotes = await prisma.creditNote.findMany({ where: { invoiceId } });
  const totals = totalsOf({ ...invoice, creditNotes });

  const org = invoice.organizationId
    ? await prisma.organization.findFirst({
        where: { id: invoice.organizationId },
        include: { account: true },
      })
    : null;
  const person = invoice.personId
    ? await prisma.person.findFirst({
        where: { id: invoice.personId },
        select: {
          fullName: true,
          recordCode: true,
          primaryEmail: true,
          primaryPhone: true,
          studentProfile: { select: { registrationNumber: true, address: true } },
        },
      })
    : null;

  const raisedBy = invoice.createdById
    ? await prisma.person.findFirst({ where: { id: invoice.createdById }, select: { fullName: true } })
    : null;

  const courseIds = [...new Set(invoice.lines.map((l) => l.courseId).filter(Boolean) as string[])];
  const courses = courseIds.length
    ? await prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, name: true, code: true } })
    : [];
  const courseMap = new Map(courses.map((c) => [c.id, c]));

  // What the invoice says, fixed at issue. On a credit invoice nothing was
  // collected and the whole amount was payable then, which is what is printed —
  // never today's balance, because the document is final.
  const declaredNow = round2(num(invoice.amountPayableNow) ?? 0);
  const payableNow = invoice.paymentType === 'credit' ? totals.payable : declaredNow;

  const receipts = await prisma.receipt.findMany({
    where: { invoiceId, tenantId: invoice.tenantId },
    include: { payment: { select: { method: true, gatewayReference: true, recordCode: true } } },
    orderBy: { allocatedAt: 'asc' },
  });

  const statements = await prisma.finalInvoice.findMany({
    where: { invoiceId, tenantId: invoice.tenantId },
    orderBy: { issuedAt: 'desc' },
  });

  return {
    id: invoice.id,
    /** Null while it is a draft: the number is allocated when it is issued. */
    recordCode: invoice.recordCode,
    draftReference: invoice.draftReference,
    label: invoiceLabel(invoice),
    status: invoice.status,
    currency: invoice.currency,
    issuedDate: invoice.issuedDate?.toISOString() ?? null,
    dueDate: invoice.dueDate?.toISOString() ?? null,
    enrollmentDate: invoice.enrollmentDate?.toISOString() ?? null,
    notes: invoice.notes,
    division: invoice.division,
    raisedBy: raisedBy?.fullName ?? null,
    // ---- Compliance (workstream B) ----
    /** tax_invoice | bill_of_supply — Rule 49: a bill of supply carries no tax. */
    invoiceType: invoice.invoiceType,
    /** Rule 46(p): printed when tax on this supply is payable by the recipient. */
    reverseCharge: invoice.reverseCharge,
    irn: invoice.irn,
    signedQrCode: invoice.signedQrCode,

    supplier: {
      legalName: profile.legalName,
      tradeName: profile.tradeName,
      gstin: profile.gstin,
      stateCode: profile.stateCode,
      stateName: profile.stateName ?? stateNameFor(profile.stateCode),
      pan: profile.pan,
      cin: profile.cin,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      city: profile.city,
      pincode: profile.pincode,
      email: profile.email,
      phone: profile.phone,
      website: profile.website,
      // Printed so the customer can pay it. That is the whole point of putting
      // it on an invoice.
      bank: profile.bankAccountNumber
        ? {
            name: profile.bankName,
            accountName: profile.bankAccountName,
            accountNumber: profile.bankAccountNumber,
            ifsc: profile.bankIfsc,
            branch: profile.bankBranch,
            upiId: profile.upiId,
          }
        : null,
      terms: profile.invoiceTerms,
      footnote: profile.invoiceNotes,
    },

    customer: {
      // Which of the three this document is addressed to. It is printed, because
      // "Student" over a name and "Institution" over a college's name are
      // different documents to anybody filing them, and because an invoice that
      // does not say who it is to is the thing this product used to produce.
      kind: invoice.personId ? ('student' as const) : org?.kind === 'institution' ? ('institution' as const) : ('organization' as const),
      kindLabel: invoice.personId ? 'Student' : org?.kind === 'institution' ? 'Institution' : 'Organisation',
      name: org?.name ?? person?.fullName ?? '—',
      recordCode: org?.recordCode ?? person?.recordCode ?? null,
      /// The learner's own registration number, where they have one. It is what
      /// they and the company both quote, so it belongs on the document.
      registrationNumber: person?.studentProfile?.registrationNumber ?? null,
      gstin: invoice.customerGstin,
      // B2B or B2C, from whether the registration is real rather than from a
      // tick box: it decides whether the customer can claim this tax back.
      supplyType: supplyTypeOf(invoice.customerGstin),
      address: org?.account?.billingAddress ?? person?.studentProfile?.address ?? null,
      email: org?.account?.billingEmail ?? person?.primaryEmail ?? null,
      phone: person?.primaryPhone ?? null,
    },

    placeOfSupply: placeOfSupplyLabel(invoice.placeOfSupply),
    interState: invoice.interState,
    /** Which pair of taxes this invoice carries. Not cosmetic: they are different taxes. */
    taxHeads: invoice.interState ? (['igst'] as const) : (['cgst', 'sgst'] as const),

    lines: invoice.lines.map((l) => ({
      id: l.id,
      description: l.description,
      courseName: l.courseId ? (courseMap.get(l.courseId)?.name ?? null) : null,
      courseCode: l.courseId ? (courseMap.get(l.courseId)?.code ?? null) : null,
      // The add-on's own name, where this line is one. Read from the line's
      // own description rather than a live join to CourseAddon: an add-on can
      // be edited or removed from the catalogue later, and a printed document
      // must keep reading the way it did the day it was issued.
      addonName: l.courseAddonId ? l.description : null,
      hsnSac: l.hsnSac,
      quantity: l.quantity,
      unitPrice: num(l.unitPrice) || round2((num(l.amount) ?? 0) / Math.max(l.quantity, 1)),
      // The taxable value, after the line's own discount — what tax is charged
      // on and what this line is actually billed at.
      amount: num(l.amount) ?? 0,
      // What it cost before the discount. Recovered as amount + discount
      // rather than unitPrice x quantity, so the three figures printed on the
      // invoice — fee, discount, payable — always add up on rows raised
      // before this column existed too (discountAmount defaults to 0 there).
      grossAmount: round2((num(l.amount) ?? 0) + (num(l.discountAmount) ?? 0)),
      discountAmount: num(l.discountAmount) ?? 0,
      discountPercent: num(l.discountPercent) ?? 0,
      gstRate: num(l.gstRate) ?? 0,
      taxAmount: num(l.taxAmount) ?? 0,
      supplyType: l.supplyType,
      exemptionNotification: l.exemptionNotification,
      revenueMethod: l.revenueMethod,
    })),

    tax: {
      taxableValue: num(invoice.taxableValue) ?? 0,
      cgst: num(invoice.cgstAmount) ?? 0,
      sgst: num(invoice.sgstAmount) ?? 0,
      igst: num(invoice.igstAmount) ?? 0,
      roundOff: num(invoice.roundOff) ?? 0,
    },

    // The Kaizen course-ledger view: present only where an enrollment date was
    // given, i.e. a course-sale invoice. Every figure here is read off `lines`
    // above (never a second computation), so the printed ledger table can show
    // the monthly fee, the tenure, the effective-monthly-after-discount and a
    // per-line CGST/SGST/IGST split without the client working any of it out
    // itself — each row's tax split is computed on that row's own tax alone,
    // the same way the figures on either side of it were.
    ledger: invoice.enrollmentDate
      ? {
          schedule: computePaymentSchedule(invoice.enrollmentDate.toISOString().slice(0, 10)),
          rows: invoice.lines.map((l) => {
            const isCourseRow = !l.courseAddonId;
            const unitPrice = num(l.unitPrice) || round2((num(l.amount) ?? 0) / Math.max(l.quantity, 1));
            const discountPercent = num(l.discountPercent) ?? 0;
            const taxAmount = num(l.taxAmount) ?? 0;
            const amount = num(l.amount) ?? 0;
            return {
              lineId: l.id,
              hsnSac: l.hsnSac,
              courseName: isCourseRow ? (l.courseId ? (courseMap.get(l.courseId)?.name ?? l.description) : l.description) : null,
              addonName: isCourseRow ? null : l.description,
              monthlyFee: unitPrice,
              tenureMonths: l.quantity,
              subtotal: round2(unitPrice * l.quantity),
              discountPercent,
              discountAmount: num(l.discountAmount) ?? 0,
              effectiveMonthly: round2(unitPrice * (1 - discountPercent / 100)),
              taxable: amount,
              cgst: invoice.interState ? 0 : round2(taxAmount / 2),
              sgst: invoice.interState ? 0 : round2(taxAmount / 2),
              igst: invoice.interState ? taxAmount : 0,
              total: round2(amount + taxAmount),
              isCourseRow,
            };
          }),
        }
      : null,

    /**
     * What the tax invoice says. Both figures, side by side, and both printed
     * even on a full payment where they are the same number — a customer should
     * not have to work out which of the two they are looking at. Fixed at issue.
     */
    totals: {
      totalPayable: totals.payable,
      amountPayableNow: payableNow,
      balanceAtIssue: round2(Math.max(totals.payable - payableNow, 0)),
      inWords: amountInWords(totals.payable),
      payableNowInWords: amountInWords(payableNow),
    },

    /** What the invoice said about payment on the day. Never restated. */
    payment: {
      type: invoice.paymentType,
      mode: invoice.paymentMode,
      reference: invoice.paymentReference,
      isPartPayment: invoice.paymentType === 'part',
    },

    /**
     * Where the account stands today. Deliberately separate from `totals` and
     * deliberately not printed on the tax invoice: it moves, and the document
     * does not.
     */
    position: {
      received: totals.allocated,
      creditNoted: totals.creditNoted,
      outstanding: totals.outstanding,
      settled: totals.outstanding <= 0.001,
      instalments: receipts.length,
      /** True once there is something for a final invoice to consolidate. */
      canRaiseFinalInvoice: receipts.length > 0 && invoice.status !== 'draft' && invoice.status !== 'void',
    },

    /**
     * The instalments since, each a numbered document of its own. Part payments
     * live here rather than on the invoice.
     */
    receipts: receipts.map((r, i) => ({
      id: r.id,
      number: i + 1,
      recordCode: r.recordCode,
      issuedAt: r.allocatedAt.toISOString(),
      amount: num(r.allocatedAmount) ?? 0,
      mode: r.paymentMode ?? r.payment.method,
      reference: r.paymentReference ?? r.payment.gatewayReference,
      balanceAfter: num(r.balanceAfter) ?? 0,
    })),

    /** Final invoices raised against it, newest first. */
    statements: statements.map((f) => ({
      id: f.id,
      recordCode: f.recordCode,
      issuedAt: f.issuedAt.toISOString(),
      totalReceived: num(f.totalReceived) ?? 0,
      balance: num(f.balance) ?? 0,
      settled: f.settled,
      status: f.status,
      receiptCount: f.receiptCount,
    })),

    creditNotes: creditNotes.map((c) => ({
      recordCode: c.recordCode,
      amount: num(c.amount) ?? 0,
      reason: c.reason,
      issuedAt: c.issuedAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// The receivables projection, which is a statement about invoices
// ---------------------------------------------------------------------------

/**
 * Rebuilds what an account still owes.
 *
 * Kept here rather than in the payments file because it is computed entirely
 * from invoices: a projection of the obligation, hydrated after anything that
 * changes one. Explicitly non-authoritative and safe to discard.
 */
export async function rehydrateReceivablesFor(
  subjectId: string | null,
  subjectType: 'account' | 'opportunity' = 'account',
) {
  if (!subjectId) return null;
  const auth = currentAuth();

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['issued', 'part_paid', 'overdue'] },
      ...(subjectType === 'account'
        ? { OR: [{ accountId: subjectId }, { organizationId: subjectId }] }
        : { opportunityId: subjectId }),
    },
    include: { lines: true, receipts: true },
  });

  let outstanding = 0;
  let nextDue: Date | null = null;
  for (const inv of invoices) {
    outstanding = round2(outstanding + totalsOf(inv).outstanding);
    if (inv.dueDate && (!nextDue || inv.dueDate < nextDue)) nextDue = inv.dueDate;
  }

  const overdueDays = nextDue ? Math.floor((Date.now() - nextDue.getTime()) / 86_400_000) : 0;
  const dunningStage =
    overdueDays <= 0 ? null : overdueDays < 15 ? 'reminder' : overdueDays < 45 ? 'chase' : 'escalated';

  const label =
    subjectType === 'account'
      ? ((await prisma.organization.findFirst({ where: { id: subjectId }, select: { name: true } }))?.name ??
        subjectId)
      : subjectId;

  return prisma.receivablesProjection.upsert({
    where: { tenantId_subjectType_subjectId: { tenantId: auth.tenantId, subjectType, subjectId } },
    create: {
      tenantId: auth.tenantId,
      subjectType,
      subjectId,
      subjectLabel: label,
      amountOutstanding: outstanding,
      nextDueDate: nextDue,
      dunningStage,
    },
    update: {
      subjectLabel: label,
      amountOutstanding: outstanding,
      nextDueDate: nextDue,
      dunningStage,
      hydratedAt: new Date(),
    },
  });
}
