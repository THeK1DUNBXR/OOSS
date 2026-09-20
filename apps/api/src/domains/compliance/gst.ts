/**
 * Compliance — GST completion (docs/plan/compliance.md, workstream B).
 *
 * Supply classification, reverse charge on inward supplies, debit notes,
 * e-invoicing's provider boundary, GSTR-2B reconciliation, and late
 * fee/interest exposure. Everything a filing/return/document is, is a
 * snapshot with a status, never edited after issue; everything statutory is
 * read from a dated rate table, never a constant here.
 */

import {
  computeGst,
  round2,
  type GstLineInput,
  EDUCATION_EXEMPTION_NOTIFICATION,
  SUPPLY_TYPES,
  isNonTaxableSupply,
  NOTE_REASON_CODES,
  type NoteReasonCode,
  type SupplyType,
  matchGstr2b,
  gstr2bEligibleItc,
  lateFee,
  interest,
  type Gstr2bB2bRow,
  type BookedBill,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { registerHook } from '../../platform/hooks.js';
import { raiseException } from '../../platform/exceptions.js';
import { DOCUMENT_SERIES, nextDocumentNumber } from '../../platform/documentNumber.js';
import { companyProfile, documentNumbering } from '../companyProfile.js';

registerGovernedEntities('cmp_gst', [
  'debit_note',
  'rcm_self_invoice',
  'einvoice_config',
  'gstr2b_import',
  'course_gst_exemption',
]);

// ---------------------------------------------------------------------------
// 1. Supply classification (CMP-GST-001)
// ---------------------------------------------------------------------------

/** The exemption a course carries, if any, and whether it is switched on. */
export async function courseGstExemptionFor(courseId: string) {
  const auth = currentAuth();
  const row = await prisma.courseGstExemption.findFirst({
    where: { tenantId: auth.tenantId, courseId, active: true },
  });
  return row;
}

export async function setCourseGstExemption(
  courseId: string,
  input: { active: boolean; notification?: string; note?: string | null },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'edit' });
  const course = await prisma.course.findFirst({ where: { id: courseId, tenantId: auth.tenantId } });
  if (!course) throw ApiError.notFound('Course');

  const row = await prisma.courseGstExemption.upsert({
    where: { tenantId_courseId: { tenantId: auth.tenantId, courseId } },
    create: {
      tenantId: auth.tenantId,
      courseId,
      active: input.active,
      notification: input.notification?.trim() || EDUCATION_EXEMPTION_NOTIFICATION,
      note: input.note ?? null,
      createdById: auth.partyId,
    },
    update: {
      active: input.active,
      notification: input.notification?.trim() || EDUCATION_EXEMPTION_NOTIFICATION,
      note: input.note ?? null,
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'course_gst_exemption',
    subjectId: row.id,
    after: { courseId, active: row.active, notification: row.notification },
  });
  return row;
}

/** Recomputes an invoice's stored totals from its current lines. Draft only. */
async function recomputeInvoiceTotals(invoiceId: string) {
  const auth = currentAuth();
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId, tenantId: auth.tenantId },
    include: { lines: true },
  });
  const gstInput: GstLineInput[] = invoice.lines.map((l) => ({
    taxableValue: num(l.amount) ?? 0,
    gstRate: num(l.gstRate) ?? 0,
  }));
  const gst = computeGst(gstInput, invoice.interState);
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      taxableValue: gst.taxableValue,
      cgstAmount: gst.cgst,
      sgstAmount: gst.sgst,
      igstAmount: gst.igst,
      roundOff: gst.roundOff,
      grandTotal: gst.grandTotal,
    },
  });
}

export interface ClassifyLineInput {
  supplyType: SupplyType;
  exemptionNotification?: string | null;
  /** Only read when switching a line back to `taxable`: what rate to charge. */
  gstRate?: number | null;
}

/**
 * Sets a line's supply classification. A nil/exempt/non-GST line always
 * carries zero rate and zero tax — enforced here, and again by the
 * `invoice.before_issue` hook below as the last check before a document
 * exists.
 */
export async function classifyInvoiceLine(invoiceId: string, lineId: string, input: ClassifyLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'edit' });

  if (!SUPPLY_TYPES.includes(input.supplyType)) {
    throw ApiError.badRequest(`"${input.supplyType}" is not a supply type. Use one of: ${SUPPLY_TYPES.join(', ')}.`);
  }

  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: auth.tenantId } });
  if (!invoice) throw ApiError.notFound('Invoice');
  if (invoice.status !== 'draft') {
    throw ApiError.unprocessable(
      `${invoice.recordCode ?? invoice.draftReference} is ${invoice.status}. A line's classification is settled before the document is issued; the correction after issue is a credit or debit note.`,
    );
  }
  const line = await prisma.invoiceLine.findFirst({ where: { id: lineId, tenantId: auth.tenantId, invoiceId } });
  if (!line) throw ApiError.notFound('Invoice line');

  const nonTaxable = isNonTaxableSupply(input.supplyType);
  const gstRate = nonTaxable ? 0 : round2(input.gstRate ?? num(line.gstRate) ?? 0);
  const taxAmount = nonTaxable ? 0 : round2(((num(line.amount) ?? 0) * gstRate) / 100);

  const updated = await prisma.invoiceLine.update({
    where: { id: lineId },
    data: {
      supplyType: input.supplyType,
      exemptionNotification: nonTaxable ? input.exemptionNotification?.trim() || null : null,
      gstRate,
      taxAmount,
    },
  });

  await recomputeInvoiceTotals(invoiceId);
  await auditWrite({
    action: 'update',
    subjectType: 'invoice_line',
    subjectId: lineId,
    before: { supplyType: line.supplyType, gstRate: num(line.gstRate) },
    after: { supplyType: updated.supplyType, gstRate: num(updated.gstRate) },
  });

  return prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { lines: { orderBy: { position: 'asc' } } },
  });
}

/**
 * Draft lines a counter should look at before issuing: a course with an
 * active exemption whose line does not yet read `exempt`. `priceLines`
 * (invoicing.ts) already defaults a fresh line correctly; this catches lines
 * added before the exemption was switched on, or entered by hand.
 */
export async function unclassifiedLines() {
  const auth = currentAuth();
  const exemptCourseIds = (
    await prisma.courseGstExemption.findMany({
      where: { tenantId: auth.tenantId, active: true },
      select: { courseId: true },
    })
  ).map((r) => r.courseId);

  if (exemptCourseIds.length === 0) return [];

  const lines = await prisma.invoiceLine.findMany({
    where: {
      tenantId: auth.tenantId,
      courseId: { in: exemptCourseIds },
      supplyType: 'taxable',
      invoice: { status: 'draft' },
    },
    include: { invoice: { select: { recordCode: true, draftReference: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return lines;
}

/**
 * Runs at issue. The last gate before a nil/exempt/non-GST line, a
 * composition tenant, or a bill-of-supply becomes a document that says the
 * wrong thing on its face.
 */
async function beforeIssueClassification(payload: Record<string, unknown>) {
  const invoice = payload.invoice as { id: string; invoiceType: string; reverseCharge: boolean; enrollmentDate: Date | string | null };
  const lines = payload.lines as Array<{ id: string; supplyType: string; gstRate: unknown; taxAmount: unknown }>;

  // A course-fee invoice is never a tax document (see the `Invoice` doc
  // comment) — it is not a bill of supply either, it is neither, so it is
  // never classified and never queued for e-invoicing.
  if (invoice.enrollmentDate) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { invoiceType: 'temp', eInvoiceStatus: 'not_applicable' },
    });
    return;
  }

  const profile = await companyProfile();

  for (const line of lines) {
    if (isNonTaxableSupply(line.supplyType) && ((num(line.gstRate as never) ?? 0) !== 0 || (num(line.taxAmount as never) ?? 0) !== 0)) {
      throw ApiError.unprocessable(
        `A ${line.supplyType} line cannot carry a tax rate or tax amount. Reclassify it before issuing.`,
      );
    }
  }

  const allNonTaxable = lines.length > 0 && lines.every((l) => isNonTaxableSupply(l.supplyType));
  const anyTax = lines.some((l) => (num(l.taxAmount as never) ?? 0) > 0);

  if (profile.compositionScheme && anyTax) {
    throw ApiError.unprocessable(
      'This company is on the composition scheme (Sec 10). A composition dealer does not charge GST — the line carrying tax has to be corrected before this invoice can be issued.',
    );
  }

  // Rule 49: a document with no tax on it — every line non-taxable, or the
  // whole registration is a composition one — is a bill of supply, not a tax
  // invoice. Derived rather than asked for, so it cannot drift from the lines.
  const invoiceType = allNonTaxable || profile.compositionScheme ? 'bill_of_supply' : 'tax_invoice';

  // E-invoicing readiness (CMP-GST-004): stamped here so a document is never
  // issued silently omitting its e-invoice status.
  const eInvoiceStatus = profile.eInvoicingApplicable ? 'pending' : 'not_applicable';

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { invoiceType, eInvoiceStatus },
  });
}

let hooksRegistered = false;
export function registerGstComplianceHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHook('invoice.before_issue', 'cmp_gst.classification', beforeIssueClassification);
}

// ---------------------------------------------------------------------------
// 2. Reverse charge on inward supplies (CMP-GST-002)
// ---------------------------------------------------------------------------

async function nextRcmNumber(at: Date): Promise<string> {
  const tenantId = currentAuth().tenantId;
  const year = at.getUTCFullYear();
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: 'CMP:RCM', year } },
    create: { tenantId, entityType: 'CMP:RCM', year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  const seq = row.nextSequence - 1;
  return `RCM-${year}-${String(seq).padStart(5, '0')}`;
}

export interface RcmInput {
  ratePct: number;
  /** Defaults to the bill's own subtotal. */
  taxableValue?: number;
}

/**
 * Marks a vendor bill reverse-charged and raises the self-invoice Sec
 * 31(3)(f) requires. The tax split follows from where the supplier sits
 * relative to us, the same reading an inward credit already uses.
 */
export async function applyReverseCharge(billId: string, input: RcmInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'edit' });

  if (!input.ratePct || input.ratePct < 0 || input.ratePct > 100) {
    throw ApiError.badRequest('The reverse-charge rate has to be a percentage between 0 and 100.');
  }

  const bill = await prisma.vendorBill.findFirst({ where: { id: billId, tenantId: auth.tenantId } });
  if (!bill) throw ApiError.notFound('Vendor bill');

  const taxableValue = round2(input.taxableValue ?? num(bill.subtotal) ?? 0);
  const profile = await companyProfile();
  const supplierState = bill.vendorGstin?.slice(0, 2) ?? null;
  const interState = Boolean(profile.stateCode && supplierState && supplierState !== profile.stateCode);
  const gst = computeGst([{ taxableValue, gstRate: input.ratePct }], interState);

  const period = `${bill.billDate.getUTCFullYear()}-${String(bill.billDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const number = await nextRcmNumber(bill.billDate);

  const [, selfInvoice] = await prisma.$transaction([
    prisma.vendorBill.update({
      where: { id: billId },
      data: { rcmApplicable: true, rcmTaxAmount: gst.tax },
    }),
    prisma.rcmSelfInvoice.create({
      data: {
        tenantId: auth.tenantId,
        billId,
        number,
        period,
        taxableValue,
        cgstAmount: gst.cgst,
        sgstAmount: gst.sgst,
        igstAmount: gst.igst,
        createdById: auth.partyId,
      },
    }),
  ]);

  await auditWrite({
    action: 'create',
    subjectType: 'rcm_self_invoice',
    subjectId: selfInvoice.id,
    after: { billId, number, taxableValue, tax: gst.tax, period },
  });

  return selfInvoice;
}

export async function listRcmSelfInvoices(period?: string) {
  const auth = currentAuth();
  return prisma.rcmSelfInvoice.findMany({
    where: { tenantId: auth.tenantId, ...(period ? { period } : {}) },
    orderBy: { number: 'asc' },
  });
}

export async function flaggedRcmBills() {
  const auth = currentAuth();
  return prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, rcmApplicable: true, deletedAt: null },
    orderBy: { billDate: 'desc' },
  });
}

/**
 * What GSTR-3B's `isup_rev` block and 3.1(d) read for a period: the tax
 * payable under reverse charge, and the same figure again as ITC — claimable
 * in the same return, because Sec 16 makes tax actually paid under RCM
 * immediately eligible, not deferred to the following month.
 */
export async function rcmLiabilityFor(period: string) {
  const auth = currentAuth();
  const rows = await prisma.rcmSelfInvoice.findMany({ where: { tenantId: auth.tenantId, period } });
  return rows.reduce(
    (acc, r) => ({
      taxableValue: round2(acc.taxableValue + (num(r.taxableValue) ?? 0)),
      cgst: round2(acc.cgst + (num(r.cgstAmount) ?? 0)),
      sgst: round2(acc.sgst + (num(r.sgstAmount) ?? 0)),
      igst: round2(acc.igst + (num(r.igstAmount) ?? 0)),
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 },
  );
}

// ---------------------------------------------------------------------------
// 3. Debit notes and credit-note reasons (CMP-GST-003)
// ---------------------------------------------------------------------------

export interface DebitNoteInput {
  amount: number;
  reasonCode: NoteReasonCode;
  note?: string | null;
}

/** Raises a debit note (Sec 34): what was billed understates what was owed. */
export async function issueDebitNote(invoiceId: string, input: DebitNoteInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'debit_notes', verb: 'create' });

  if (!NOTE_REASON_CODES.includes(input.reasonCode)) {
    throw ApiError.badRequest(`"${input.reasonCode}" is not a reason code. Use one of: ${NOTE_REASON_CODES.join(', ')}.`);
  }
  if (!(input.amount > 0)) throw ApiError.badRequest('A debit note has to raise the invoice by a positive amount.');

  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: auth.tenantId } });
  if (!invoice) throw ApiError.notFound('Invoice');
  if (invoice.status === 'draft' || invoice.status === 'void') {
    throw ApiError.unprocessable('A debit note corrects an issued invoice, not a draft or a voided one.');
  }

  const numbering = await documentNumbering();
  const recordCode = await nextDocumentNumber(DOCUMENT_SERIES.debitNote, numbering.prefix, new Date(), numbering.yearFormat);

  const note = await prisma.debitNote.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      invoiceId,
      amount: round2(input.amount),
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      issuedById: auth.partyId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'debit_note',
    subjectId: note.id,
    after: { recordCode, invoiceId, amount: note.amount, reasonCode: input.reasonCode },
  });

  return note;
}

export async function listDebitNotes(invoiceId?: string) {
  const auth = currentAuth();
  return prisma.debitNote.findMany({
    where: { tenantId: auth.tenantId, ...(invoiceId ? { invoiceId } : {}) },
    orderBy: { issuedAt: 'desc' },
  });
}

export async function listCreditNotesWithReason() {
  const auth = currentAuth();
  const notes = await prisma.creditNote.findMany({ where: { tenantId: auth.tenantId }, orderBy: { issuedAt: 'desc' } });
  const reasons = await prisma.creditNoteReason.findMany({
    where: { tenantId: auth.tenantId, creditNoteId: { in: notes.map((n) => n.id) } },
  });
  const reasonOf = new Map(reasons.map((r) => [r.creditNoteId, r.reasonCode]));
  return notes.map((n) => ({ ...n, reasonCode: reasonOf.get(n.id) ?? null }));
}

/** Sets or replaces the structured reason code on a credit note already issued. */
export async function setCreditNoteReason(creditNoteId: string, reasonCode: NoteReasonCode) {
  const auth = currentAuth();
  await assertCan({ resource: 'debit_notes', verb: 'edit' });
  if (!NOTE_REASON_CODES.includes(reasonCode)) {
    throw ApiError.badRequest(`"${reasonCode}" is not a reason code. Use one of: ${NOTE_REASON_CODES.join(', ')}.`);
  }
  const note = await prisma.creditNote.findFirst({ where: { id: creditNoteId, tenantId: auth.tenantId } });
  if (!note) throw ApiError.notFound('Credit note');

  const row = await prisma.creditNoteReason.upsert({
    where: { creditNoteId },
    create: { tenantId: auth.tenantId, creditNoteId, reasonCode },
    update: { reasonCode },
  });
  await auditWrite({ action: 'update', subjectType: 'credit_note', subjectId: creditNoteId, after: { reasonCode } });
  return row;
}

// ---------------------------------------------------------------------------
// 4. E-invoicing (CMP-GST-004)
// ---------------------------------------------------------------------------

export interface EInvoiceRegistration {
  irn: string;
  ackNo: string;
  ackAt: Date;
  signedQr: string;
}

/** The boundary any real IRP integration implements. Nothing here calls out. */
export interface EInvoiceProvider {
  name: string;
  registerIrn(invoice: { id: string; recordCode: string | null }): Promise<EInvoiceRegistration>;
}

/** What every fresh tenant has: no provider, stated rather than pretended. */
export class NotConfiguredProvider implements EInvoiceProvider {
  name = 'not_configured';
  async registerIrn(): Promise<EInvoiceRegistration> {
    throw new ApiError(422, 'EINVOICE_NOT_CONFIGURED', 'E-invoicing has no provider configured for this tenant.');
  }
}

const providers = new Map<string, EInvoiceProvider>();

/** Test/deployment seam: swap in a real adapter without touching callers. */
export function registerEInvoiceProvider(provider: EInvoiceProvider): void {
  providers.set(provider.name, provider);
}

async function resolveProvider(): Promise<EInvoiceProvider> {
  const auth = currentAuth();
  const config = await prisma.eInvoiceConfig.findFirst({ where: { tenantId: auth.tenantId, active: true } });
  if (!config) return new NotConfiguredProvider();
  return providers.get(config.provider) ?? new NotConfiguredProvider();
}

export async function setEInvoiceConfig(input: { provider: string; credentialsRef?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'einvoicing', verb: 'edit' });
  const row = await prisma.eInvoiceConfig.upsert({
    where: { tenantId: auth.tenantId },
    create: { tenantId: auth.tenantId, provider: input.provider, credentialsRef: input.credentialsRef ?? null },
    update: { provider: input.provider, credentialsRef: input.credentialsRef ?? null, active: true },
  });
  await auditWrite({ action: 'update', subjectType: 'einvoice_config', subjectId: row.id, after: { provider: row.provider } });
  return row;
}

export async function eInvoiceConfig() {
  const auth = currentAuth();
  return prisma.eInvoiceConfig.findFirst({ where: { tenantId: auth.tenantId } });
}

/**
 * Requests an IRN for an issued invoice. Named error when nothing is
 * configured — CMP-GST-004's whole point is that this never quietly leaves
 * IRN/QR blank without saying why.
 */
export async function requestEInvoice(invoiceId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'einvoicing', verb: 'create' });

  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: auth.tenantId } });
  if (!invoice) throw ApiError.notFound('Invoice');
  if (invoice.status !== 'issued' && invoice.status !== 'part_paid' && invoice.status !== 'paid') {
    throw ApiError.unprocessable('E-invoicing registers an issued document; this one has not been issued yet.');
  }
  if (invoice.eInvoiceStatus === 'not_applicable') {
    throw ApiError.unprocessable('E-invoicing does not apply to this tenant (Company details → e-invoicing applicable).');
  }

  const provider = await resolveProvider();
  try {
    const reg = await provider.registerIrn({ id: invoice.id, recordCode: invoice.recordCode });
    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        irn: reg.irn,
        irnAckNo: reg.ackNo,
        irnAckAt: reg.ackAt,
        signedQrCode: reg.signedQr,
        eInvoiceStatus: 'registered',
      },
    });
    await auditWrite({ action: 'update', subjectType: 'invoice', subjectId: invoiceId, after: { eInvoiceStatus: 'registered' } });
    return updated;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'EINVOICE_NOT_CONFIGURED') {
      // Not actually a failed call — nothing to retry — so the status stays
      // `pending`, and the error carries its own named code.
      await prisma.invoice.update({ where: { id: invoiceId }, data: { eInvoiceStatus: 'pending' } });
      throw err;
    }
    await prisma.invoice.update({ where: { id: invoiceId }, data: { eInvoiceStatus: 'failed' } });
    throw err;
  }
}

export async function eInvoiceStatusList() {
  const auth = currentAuth();
  return prisma.invoice.findMany({
    where: { tenantId: auth.tenantId, status: { notIn: ['draft'] }, deletedAt: null },
    select: {
      id: true,
      recordCode: true,
      grandTotal: true,
      eInvoiceStatus: true,
      irn: true,
      irnAckAt: true,
      issuedDate: true,
    },
    orderBy: { issuedDate: 'desc' },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// 5. GSTR-2B reconciliation
// ---------------------------------------------------------------------------

export interface Gstr2bImportInput {
  period: string;
  b2b: Gstr2bB2bRow[];
}

/** Imports the offline-utility JSON's b2b rows for a period and matches them. */
export async function importGstr2b(input: Gstr2bImportInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'create' });

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw ApiError.badRequest('Period has to be YYYY-MM.');
  }

  const importRow = await prisma.gstr2bImport.upsert({
    where: { tenantId_period: { tenantId: auth.tenantId, period: input.period } },
    create: { tenantId: auth.tenantId, period: input.period, rows: input.b2b as unknown as object, importedById: auth.partyId },
    update: { rows: input.b2b as unknown as object, importedById: auth.partyId, importedAt: new Date() },
  });

  await recomputeGstr2bMatches(input.period, input.b2b);

  await auditWrite({
    action: 'create',
    subjectType: 'gstr2b_import',
    subjectId: importRow.id,
    after: { period: input.period, rows: input.b2b.length },
  });

  return importRow;
}

async function billsForPeriod(period: string): Promise<BookedBill[]> {
  const auth = currentAuth();
  const [year, month] = period.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, billDate: { gte: from, lt: to } },
    select: { id: true, vendorGstin: true, billNumber: true, subtotal: true, taxAmount: true },
  });
  return bills.map((b) => ({
    vendorBillId: b.id,
    vendorGstin: b.vendorGstin,
    billNumber: b.billNumber,
    taxableValue: num(b.subtotal) ?? 0,
    taxAmount: num(b.taxAmount) ?? 0,
  }));
}

async function recomputeGstr2bMatches(period: string, rows: Gstr2bB2bRow[]) {
  const auth = currentAuth();
  const bills = await billsForPeriod(period);
  const results = matchGstr2b(bills, rows);

  await prisma.gstr2bMatch.deleteMany({ where: { tenantId: auth.tenantId, period } });
  if (results.length) {
    await prisma.gstr2bMatch.createMany({
      data: results.map((r) => ({
        tenantId: auth.tenantId,
        period,
        vendorBillId: r.vendorBillId,
        status: r.status,
        difference: r.difference,
        ctin: r.ctin,
        inum: r.inum,
      })),
    });
  }
  return results;
}

export async function gstr2bMatches(period: string) {
  const auth = currentAuth();
  return prisma.gstr2bMatch.findMany({ where: { tenantId: auth.tenantId, period }, orderBy: { status: 'asc' } });
}

/** Eligible ITC per the 2B upload against what the books have claimed. */
export async function gstr2bSummary(period: string) {
  const auth = currentAuth();
  const importRow = await prisma.gstr2bImport.findFirst({ where: { tenantId: auth.tenantId, period } });
  const rows = (importRow?.rows as unknown as Gstr2bB2bRow[]) ?? [];
  const eligibleItc = gstr2bEligibleItc(rows);

  const bills = await billsForPeriod(period);
  const claimedInBooks = round2(bills.reduce((s, b) => s + b.taxAmount, 0));

  const matches = await prisma.gstr2bMatch.findMany({ where: { tenantId: auth.tenantId, period } });
  const byStatus = { matched: 0, missing_in_2b: 0, missing_in_books: 0, mismatch: 0 } as Record<string, number>;
  for (const m of matches) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

  return {
    period,
    imported: Boolean(importRow),
    eligibleItc,
    claimedInBooks,
    difference: round2(eligibleItc - claimedInBooks),
    counts: byStatus,
  };
}

// ---------------------------------------------------------------------------
// 6. Late fee and interest exposure
// ---------------------------------------------------------------------------

async function currentRateTable(at: Date) {
  const auth = currentAuth();
  return prisma.gstRateTable.findFirst({
    where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

function dueDateFor(period: string, returnType: 'GSTR1' | 'GSTR3B', dueDay: number): Date {
  const [year, month] = period.split('-').map(Number);
  // The due date falls in the month after the period: August's GSTR-1 is due
  // in September.
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, dueDay));
}

/** What filing `period` late would cost, read against today and the current rate table. */
export async function gstExposure(period: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'view' });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw ApiError.badRequest('Period has to be YYYY-MM.');

  const today = new Date();
  const rates = await currentRateTable(today);
  if (!rates) {
    return { period, rateTable: null, returns: [] as ReturnExposure[] };
  }

  const filings = await prisma.gstFiling.findMany({
    where: { tenantId: auth.tenantId, period, status: { in: ['filed', 'prepared'] } },
    orderBy: { preparedAt: 'desc' },
  });

  const returns: ReturnExposure[] = [];
  for (const returnType of ['GSTR1', 'GSTR3B'] as const) {
    const filing = filings.find((f) => f.returnType === returnType && f.status === 'filed');
    const prepared = filings.find((f) => f.returnType === returnType);
    const dueDay = returnType === 'GSTR1' ? rates.gstr1DueDay : rates.gstr3bDueDay;
    const dueDate = dueDateFor(period, returnType, dueDay);
    const filedAt = filing?.filedAt ?? null;
    const asOf = filedAt ?? today;
    const daysLate = Math.max(0, Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000));
    const nil = returnType === 'GSTR3B' && (num(prepared?.netPayable) ?? 0) === 0;
    const fee = lateFee(daysLate, {
      lateFeePerDayCgst: num(rates.lateFeePerDayCgst) ?? 0,
      lateFeePerDaySgst: num(rates.lateFeePerDaySgst) ?? 0,
      cap: num(rates.cap) ?? 0,
      interestPct: num(rates.interestPct) ?? 0,
    });
    const netCash = returnType === 'GSTR3B' ? num(prepared?.netPayable) ?? 0 : 0;
    const interestDue =
      returnType === 'GSTR3B' ? interest(netCash, daysLate, num(rates.interestPct) ?? 0) : 0;

    returns.push({
      returnType,
      dueDate: dueDate.toISOString().slice(0, 10),
      filed: Boolean(filing),
      filedAt: filedAt?.toISOString() ?? null,
      daysLate,
      nil,
      lateFee: nil ? 0 : fee,
      interest: interestDue,
    });
  }

  return { period, rateTable: rates, returns };
}

interface ReturnExposure {
  returnType: 'GSTR1' | 'GSTR3B';
  dueDate: string;
  filed: boolean;
  filedAt: string | null;
  daysLate: number;
  nil: boolean;
  lateFee: number;
  interest: number;
}

/**
 * The accountable owner for a GST exception: the finance_head affiliation,
 * looked up by role slug — data, not a role check in business logic — falling
 * back to the chairman when nobody holds the role.
 */
async function financeHeadOwner(): Promise<string | null> {
  const auth = currentAuth();
  for (const roleSlug of ['finance_head', 'chairman']) {
    const holder = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug, status: 'active' },
      select: { partyId: true },
    });
    if (holder) return holder.partyId;
  }
  return null;
}

/**
 * Raises an exception for every unfiled GST return past its due date this
 * tenant carries, one per period/return-type, idempotent on that pair. What
 * `jobs/compliance/gst.ts`'s daily job calls.
 */
export async function detectLateGstFilings() {
  const auth = currentAuth();
  const today = new Date();
  const periods = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    periods.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  const owner = await financeHeadOwner();
  let raised = 0;
  for (const period of periods) {
    const exposure = await gstExposure(period);
    for (const r of exposure.returns) {
      if (r.filed || r.daysLate <= 0) continue;
      await raiseException({
        code: `CMP_GST_LATE_${r.returnType}`,
        label: `${r.returnType} for ${period} is overdue`,
        severity: r.daysLate > 15 ? 'S3_HIGH_RISK' : 'S2_WARNING',
        subjectType: 'gst_filing',
        subjectId: `${auth.tenantId}:${period}:${r.returnType}`,
        subjectLabel: `${r.returnType} — ${period}`,
        domain: 'fin',
        detail: `${r.daysLate} day(s) past due (${r.dueDate}). Estimated late fee ₹${r.lateFee.toFixed(2)}${r.interest ? `, interest ₹${r.interest.toFixed(2)}` : ''}.`,
        ownerPartyId: owner,
        triggerFingerprint: `cmp_gst_late:${period}:${r.returnType}`,
        ladderRung: r.daysLate > 30 ? 3 : r.daysLate > 15 ? 2 : 1,
      });
      raised += 1;
    }
  }
  return raised;
}

registerGstComplianceHooks();
