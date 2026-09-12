/**
 * GST returns — GSTR-1 and GSTR-3B, prepared from the books and then filed.
 *
 * What was here before was one function returning six totals for a month. Those
 * totals are not a return, and the gap between them and a return is where the
 * work is:
 *
 * **A return has sections, and which section a sale belongs in is a fact about
 * the customer.** A registered customer is reported invoice by invoice with their
 * GSTIN, because that is what lets them claim the tax back. An unregistered one
 * is reported as a rate-wise total. Getting that from the presence of a valid
 * GSTIN rather than from somebody ticking a box is the difference between a
 * customer receiving their credit and ringing up to ask why they did not.
 *
 * **Output tax minus input tax is the wrong arithmetic.** Credit is set off head
 * by head in a statutory order — IGST credit against IGST first and only then
 * against CGST and SGST, CGST credit against CGST alone — and netting the totals
 * produces a figure that is too small whenever the mix differs. The shortfall is
 * discovered as interest. The order lives in `packages/shared` as pure
 * arithmetic, with tests that need no database.
 *
 * **Preparing and filing are different acts.** Preparing is arithmetic and can be
 * done ten times. Filing states the figures to the government, so it is recorded
 * with what was filed rather than with a query that will answer differently next
 * month, and it closes the period: an invoice dated inside a filed month can no
 * longer be edited, because the lawful correction to a reported invoice is a
 * credit or debit note in the current period.
 *
 * The platform prepares returns and does not transmit them. There is no GSP
 * integration here and pretending otherwise would be worse than the honest
 * split: the JSON this produces is the offline-utility shape, and `markFiled`
 * records the acknowledgement the portal gave back. A return with no ARN was not
 * filed, whatever anybody remembers.
 */

import {
  EVENTS,
  GST_RETURN_TYPES,
  monthRange,
  placeOfSupplyLabel,
  round2,
  setOffInputCredit,
  supplyTypeOf,
  type GstReturnType,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { assertRegistered, supplyingParty } from './companyProfile.js';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertPeriodShape(period: string): string {
  if (!PERIOD_PATTERN.test(period)) {
    throw ApiError.badRequest(`'${period}' is not a tax period. Give it as YYYY-MM, the month the supplies were made in.`);
  }
  return period;
}

/** `082026`, which is how the portal names a month. */
function portalPeriod(period: string): string {
  const [year, month] = period.split('-');
  return `${month}${year}`;
}

// ---------------------------------------------------------------------------
// GSTR-1 — outward supplies
// ---------------------------------------------------------------------------

export interface Gstr1B2bInvoice {
  invoiceId: string;
  invoiceNumber: string;
  issuedDate: string;
  customerGstin: string;
  customerName: string;
  placeOfSupply: string | null;
  reverseCharge: 'N';
  invoiceValue: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  rates: number[];
}

export interface Gstr1RateLine {
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface Gstr1HsnLine {
  hsnSac: string;
  description: string;
  quantity: number;
  taxableValue: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * The return, computed from the books.
 *
 * Draft and void invoices are excluded: a draft is not a supply and a void
 * invoice is one that never happened. Both still appear in the document summary,
 * because the portal asks for the number range issued and the count cancelled
 * within it — a gap in an invoice series that the return does not explain is
 * exactly what an audit asks about.
 */
export async function computeGstr1(period: string) {
  const auth = currentAuth();
  await assertPeriodShape(period);
  await assertScopeAll('gst_filings');
  const us = await supplyingParty();
  const { from, to } = monthRange(period);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      issuedDate: { gte: from, lt: to },
      status: { notIn: ['draft'] },
    },
    include: { lines: { orderBy: { position: 'asc' } } },
    orderBy: { recordCode: 'asc' },
  });

  const live = invoices.filter((i) => i.status !== 'void');
  const cancelled = invoices.filter((i) => i.status === 'void');

  const orgIds = [...new Set(live.map((i) => i.organizationId).filter(Boolean) as string[])];
  const personIds = [...new Set(live.map((i) => i.personId).filter(Boolean) as string[])];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
    : [];
  const people = personIds.length
    ? await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map<string, string>([
    ...orgs.map((o) => [o.id, o.name] as [string, string]),
    ...people.map((p) => [p.id, p.fullName] as [string, string]),
  ]);

  const b2b: Gstr1B2bInvoice[] = [];
  const b2cRates = new Map<string, Gstr1RateLine>();
  const hsn = new Map<string, Gstr1HsnLine>();
  const creditNoteRows: Array<{ recordCode: string; invoiceNumber: string; amount: number; reason: string; issuedAt: string }> = [];

  let taxableValue = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  for (const inv of live) {
    const invTaxable = num(inv.taxableValue) ?? 0;
    const invCgst = num(inv.cgstAmount) ?? 0;
    const invSgst = num(inv.sgstAmount) ?? 0;
    const invIgst = num(inv.igstAmount) ?? 0;

    taxableValue = round2(taxableValue + invTaxable);
    cgst = round2(cgst + invCgst);
    sgst = round2(sgst + invSgst);
    igst = round2(igst + invIgst);

    // B2B or B2C, from whether the customer's registration is a real one.
    if (supplyTypeOf(inv.customerGstin) === 'b2b') {
      b2b.push({
        invoiceId: inv.id,
        invoiceNumber: inv.recordCode,
        issuedDate: inv.issuedDate!.toISOString().slice(0, 10),
        customerGstin: inv.customerGstin!,
        customerName: nameOf.get(inv.organizationId ?? inv.personId ?? '') ?? '—',
        placeOfSupply: placeOfSupplyLabel(inv.placeOfSupply),
        reverseCharge: 'N',
        invoiceValue: num(inv.grandTotal) ?? 0,
        taxableValue: invTaxable,
        cgst: invCgst,
        sgst: invSgst,
        igst: invIgst,
        rates: [...new Set(inv.lines.map((l) => num(l.gstRate) ?? 0))].sort((a, b) => a - b),
      });
    } else {
      // B2C is rate-wise, and the rate lives on the line rather than on the
      // invoice, so the invoice is split across as many buckets as it has rates.
      for (const line of inv.lines) {
        const rate = num(line.gstRate) ?? 0;
        const value = num(line.amount) ?? 0;
        const tax = round2((value * rate) / 100);
        const key = `${inv.placeOfSupply ?? '-'}:${rate}`;
        const bucket = b2cRates.get(key) ?? {
          gstRate: rate,
          taxableValue: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
        };
        bucket.taxableValue = round2(bucket.taxableValue + value);
        if (inv.interState) {
          bucket.igst = round2(bucket.igst + tax);
        } else {
          const half = round2(tax / 2);
          bucket.cgst = round2(bucket.cgst + half);
          bucket.sgst = round2(bucket.sgst + round2(tax - half));
        }
        b2cRates.set(key, bucket);
      }
    }

    // The HSN/SAC summary. Every line contributes, B2B and B2C alike, because
    // the table is a statement about what was supplied rather than about to whom.
    for (const line of inv.lines) {
      const code = line.hsnSac?.trim() || 'UNCLASSIFIED';
      const rate = num(line.gstRate) ?? 0;
      const value = num(line.amount) ?? 0;
      const tax = round2((value * rate) / 100);
      const key = `${code}:${rate}`;
      const row = hsn.get(key) ?? {
        hsnSac: code,
        description: line.description,
        quantity: 0,
        taxableValue: 0,
        gstRate: rate,
        cgst: 0,
        sgst: 0,
        igst: 0,
      };
      row.quantity += line.quantity;
      row.taxableValue = round2(row.taxableValue + value);
      if (inv.interState) {
        row.igst = round2(row.igst + tax);
      } else {
        const half = round2(tax / 2);
        row.cgst = round2(row.cgst + half);
        row.sgst = round2(row.sgst + round2(tax - half));
      }
      hsn.set(key, row);
    }
  }

  // Credit notes raised in the month reduce what was supplied, and are their own
  // table rather than a negative invoice.
  const notes = await prisma.creditNote.findMany({
    where: { tenantId: auth.tenantId, issuedAt: { gte: from, lt: to } },
  });
  if (notes.length) {
    const noteInvoices = await prisma.invoice.findMany({
      where: { id: { in: notes.map((n) => n.invoiceId) } },
      select: { id: true, recordCode: true },
    });
    const codeOf = new Map(noteInvoices.map((i) => [i.id, i.recordCode]));
    for (const note of notes) {
      creditNoteRows.push({
        recordCode: note.recordCode,
        invoiceNumber: codeOf.get(note.invoiceId) ?? note.invoiceId,
        amount: num(note.amount) ?? 0,
        reason: note.reason,
        issuedAt: note.issuedAt.toISOString().slice(0, 10),
      });
    }
  }

  const unclassified = [...hsn.values()].filter((h) => h.hsnSac === 'UNCLASSIFIED');

  return {
    returnType: 'GSTR1' as const,
    period,
    portalPeriod: portalPeriod(period),
    gstin: us.gstin,
    supplierLegalName: us.legalName,
    b2b,
    b2cs: [...b2cRates.values()].sort((a, b) => a.gstRate - b.gstRate),
    hsn: [...hsn.values()].sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.gstRate - b.gstRate),
    creditNotes: creditNoteRows,
    documentSummary: {
      from: invoices[0]?.recordCode ?? null,
      to: invoices[invoices.length - 1]?.recordCode ?? null,
      issued: invoices.length,
      reported: live.length,
      cancelled: cancelled.length,
    },
    totals: {
      invoiceCount: live.length,
      taxableValue,
      cgst,
      sgst,
      igst,
      tax: round2(cgst + sgst + igst),
      invoiceValue: round2(live.reduce((s, i) => s + (num(i.grandTotal) ?? 0), 0)),
      creditNoted: round2(creditNoteRows.reduce((s, c) => s + c.amount, 0)),
    },
    /**
     * What would make this return wrong if it were filed as it stands. Surfaced
     * rather than swallowed: a line with no HSN is accepted by the books and
     * rejected by the portal, and finding that out at the filing deadline is the
     * worst possible moment.
     */
    warnings: [
      ...(us.gstin ? [] : ['The company profile carries no GSTIN. A return cannot be filed without one.']),
      ...(unclassified.length
        ? [
            `${unclassified.length} line group${unclassified.length === 1 ? '' : 's'} carry no HSN/SAC code. The portal requires one on every line; set it on the course or offering being billed.`,
          ]
        : []),
      ...(live.some((i) => !i.placeOfSupply)
        ? ['Some invoices have no place of supply, so the tax on them could not be attributed to a state.']
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// GSTR-3B — the monthly summary, and the payment
// ---------------------------------------------------------------------------

/**
 * The summary the tax is actually paid from.
 *
 * Output tax comes from the same invoices GSTR-1 reports, so the two agree by
 * construction rather than by luck — a discrepancy between them is precisely
 * what a notice asks about. Input credit comes from supplier bills, split across
 * the heads the same way the supply was: a bill from within the state carried
 * CGST and SGST, and claiming it as IGST credit would be wrong in a way the
 * set-off order then compounds.
 */
export async function computeGstr3b(period: string) {
  const auth = currentAuth();
  assertPeriodShape(period);
  await assertScopeAll('gst_filings');
  const us = await supplyingParty();
  const { from, to } = monthRange(period);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      issuedDate: { gte: from, lt: to },
      status: { notIn: ['draft', 'void'] },
    },
    select: {
      taxableValue: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      interState: true,
      customerGstin: true,
      grandTotal: true,
    },
  });

  const output = invoices.reduce(
    (acc, i) => ({
      taxableValue: round2(acc.taxableValue + (num(i.taxableValue) ?? 0)),
      cgst: round2(acc.cgst + (num(i.cgstAmount) ?? 0)),
      sgst: round2(acc.sgst + (num(i.sgstAmount) ?? 0)),
      igst: round2(acc.igst + (num(i.igstAmount) ?? 0)),
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 },
  );

  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, billDate: { gte: from, lt: to } },
    select: { subtotal: true, taxAmount: true, vendorGstin: true, vendorName: true },
  });

  // Which heads a bill's tax sits in follows from where the supplier is: a
  // supplier registered in our own state charged CGST and SGST, one outside it
  // charged IGST. An unregistered supplier charged no GST at all and there is
  // nothing to claim.
  const credit = { cgst: 0, sgst: 0, igst: 0 };
  let creditableBase = 0;
  let unregisteredInputs = 0;
  for (const bill of bills) {
    const tax = num(bill.taxAmount) ?? 0;
    if (tax <= 0) continue;
    if (!bill.vendorGstin) {
      unregisteredInputs = round2(unregisteredInputs + tax);
      continue;
    }
    creditableBase = round2(creditableBase + (num(bill.subtotal) ?? 0));
    const supplierState = bill.vendorGstin.slice(0, 2);
    if (us.stateCode && supplierState !== us.stateCode) {
      credit.igst = round2(credit.igst + tax);
    } else {
      const half = round2(tax / 2);
      credit.cgst = round2(credit.cgst + half);
      credit.sgst = round2(credit.sgst + round2(tax - half));
    }
  }

  const setOff = setOffInputCredit(
    { cgst: output.cgst, sgst: output.sgst, igst: output.igst },
    credit,
  );

  return {
    returnType: 'GSTR3B' as const,
    period,
    portalPeriod: portalPeriod(period),
    gstin: us.gstin,
    supplierLegalName: us.legalName,

    /** 3.1(a) — outward taxable supplies other than zero rated, nil and exempted. */
    outwardSupplies: {
      taxableValue: output.taxableValue,
      cgst: output.cgst,
      sgst: output.sgst,
      igst: output.igst,
      tax: round2(output.cgst + output.sgst + output.igst),
      invoiceCount: invoices.length,
      invoiceValue: round2(invoices.reduce((s, i) => s + (num(i.grandTotal) ?? 0), 0)),
      b2bCount: invoices.filter((i) => supplyTypeOf(i.customerGstin) === 'b2b').length,
    },

    /** 4(A) — input tax credit available, from supplier bills in the period. */
    inputTaxCredit: {
      cgst: credit.cgst,
      sgst: credit.sgst,
      igst: credit.igst,
      total: round2(credit.cgst + credit.sgst + credit.igst),
      billCount: bills.length,
      creditableBase,
      /** Tax on bills from unregistered suppliers: paid, and not claimable. */
      notClaimable: unregisteredInputs,
    },

    /** 6.1 — what is set off, and what is paid in cash. */
    payment: {
      utilised: setOff.utilised,
      payableInCash: setOff.payable,
      totalPayableInCash: setOff.totalPayable,
      totalUtilised: setOff.totalUtilised,
      creditCarriedForward: setOff.carriedForward,
    },

    warnings: [
      ...(us.gstin ? [] : ['The company profile carries no GSTIN. A return cannot be filed without one.']),
      ...(us.stateCode
        ? []
        : ['Without our own state code, a supplier bill cannot be classed as intra-state or inter-state, so the credit split below is a guess.']),
      ...(unregisteredInputs > 0
        ? [`₹${unregisteredInputs.toFixed(2)} of tax on bills from suppliers with no GSTIN on file is not claimable as credit. Add their GSTINs if they are registered.`]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Preparing and filing
// ---------------------------------------------------------------------------

export async function computeReturn(returnType: GstReturnType, period: string) {
  return returnType === 'GSTR1' ? computeGstr1(period) : computeGstr3b(period);
}

/**
 * Snapshots a return so it can be filed.
 *
 * A previous preparation for the same type and period is superseded rather than
 * overwritten: "what did we think the liability was last week" stays answerable,
 * which matters when the answer changed because somebody back-dated a bill.
 */
export async function prepareReturn(returnType: GstReturnType, period: string, note?: string | null) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'create' });
  assertPeriodShape(period);
  if (!GST_RETURN_TYPES.includes(returnType)) {
    throw ApiError.badRequest(`${returnType} is not a return this platform prepares.`);
  }

  const alreadyFiled = await prisma.gstFiling.findFirst({
    where: { tenantId: auth.tenantId, returnType, period, status: 'filed' },
  });
  if (alreadyFiled) {
    throw ApiError.conflict(
      `${returnType} for ${period} was already filed as ${alreadyFiled.recordCode}${alreadyFiled.arn ? ` (ARN ${alreadyFiled.arn})` : ''}. ` +
        'A filed return is not re-prepared: an error in it is corrected by amending the next period, which is how the law works and not a limitation of this screen.',
      { filing: alreadyFiled.recordCode },
    );
  }

  const computed = await computeReturn(returnType, period);
  const totals =
    computed.returnType === 'GSTR1'
      ? {
          taxableValue: computed.totals.taxableValue,
          cgst: computed.totals.cgst,
          sgst: computed.totals.sgst,
          igst: computed.totals.igst,
          inputTaxCredit: 0,
          netPayable: computed.totals.tax,
          invoiceCount: computed.totals.invoiceCount,
        }
      : {
          taxableValue: computed.outwardSupplies.taxableValue,
          cgst: computed.outwardSupplies.cgst,
          sgst: computed.outwardSupplies.sgst,
          igst: computed.outwardSupplies.igst,
          inputTaxCredit: computed.inputTaxCredit.total,
          netPayable: computed.payment.totalPayableInCash,
          invoiceCount: computed.outwardSupplies.invoiceCount,
        };

  const superseded = await prisma.gstFiling.findMany({
    where: { tenantId: auth.tenantId, returnType, period, status: 'prepared' },
  });

  const recordCode = await nextRecordCode('GST');
  const filing = await prisma.gstFiling.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      returnType,
      period,
      gstin: computed.gstin,
      status: 'prepared',
      snapshot: computed as never,
      taxableValue: totals.taxableValue,
      cgstAmount: totals.cgst,
      sgstAmount: totals.sgst,
      igstAmount: totals.igst,
      inputTaxCredit: totals.inputTaxCredit,
      netPayable: totals.netPayable,
      invoiceCount: totals.invoiceCount,
      preparedById: auth.partyId,
      note: note ?? null,
    },
  });

  for (const old of superseded) {
    await prisma.gstFiling.update({
      where: { id: old.id },
      data: { status: 'superseded', supersededById: filing.id },
    });
    await emit({
      name: EVENTS.GST_RETURN_SUPERSEDED,
      subject: { entityType: 'gst_filing', entityId: old.id, recordCode: old.recordCode },
      newState: { supersededBy: filing.recordCode },
      impact: { domains: ['fin'] },
    });
  }

  await auditWrite({
    action: 'create',
    subjectType: 'gst_filing',
    subjectId: filing.id,
    after: { recordCode, returnType, period, netPayable: totals.netPayable },
  });
  await emit({
    name: EVENTS.GST_RETURN_PREPARED,
    subject: { entityType: 'gst_filing', entityId: filing.id, recordCode },
    newState: { returnType, period, netPayable: totals.netPayable, warnings: computed.warnings.length },
    impact: {
      domains: ['fin'],
      materiality: { measure: 'gst_net_payable', value: totals.netPayable, currency: 'INR' },
    },
    confidentiality: 'confidential',
  });

  return { filing, computed };
}

/**
 * Records that a prepared return was filed.
 *
 * The ARN is required, and that is the point of the endpoint: filing happens on
 * the portal, and what this platform can honestly record is the acknowledgement
 * that came back. Accepting a filing with no ARN would let the period be closed
 * on somebody's recollection.
 */
export async function markReturnFiled(filingId: string, input: { arn: string; filedAt?: Date; note?: string | null }) {
  const auth = currentAuth();
  // Filing is the irreversible half, so it asks for `approve` rather than
  // `edit`: preparing a return is arithmetic and filing it closes a period.
  await assertCan({ resource: 'gst_filings', verb: 'approve' });
  await assertRegistered('Filing a return');

  const filing = await prisma.gstFiling.findFirst({ where: { id: filingId, tenantId: auth.tenantId } });
  if (!filing) throw ApiError.notFound('GST filing');
  if (filing.status === 'filed') {
    throw ApiError.conflict(`${filing.recordCode} is already filed${filing.arn ? ` under ARN ${filing.arn}` : ''}.`);
  }
  if (filing.status === 'superseded') {
    throw ApiError.unprocessable(
      `${filing.recordCode} was superseded by a later preparation and is not the return to file. Prepare ${filing.returnType} for ${filing.period} again and file that.`,
    );
  }

  const arn = input.arn.trim();
  if (arn.length < 6) {
    throw ApiError.badRequest('The ARN is the portal’s acknowledgement number for the filing. A return with no ARN was not filed.');
  }

  const filed = await prisma.gstFiling.update({
    where: { id: filingId },
    data: {
      status: 'filed',
      arn,
      filedAt: input.filedAt ?? new Date(),
      filedById: auth.partyId,
      ...(input.note ? { note: input.note } : {}),
    },
  });

  // Stamping the invoices is what makes "which return was this reported in" a
  // question the invoice itself can answer, which is the first thing asked when
  // a customer says the credit never arrived.
  if (filed.returnType === 'GSTR1') {
    const { from, to } = monthRange(filed.period);
    await prisma.invoice.updateMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        issuedDate: { gte: from, lt: to },
        status: { notIn: ['draft'] },
      },
      data: { gstFilingId: filed.id },
    });
  }

  await auditWrite({
    action: 'update',
    subjectType: 'gst_filing',
    subjectId: filed.id,
    before: { status: 'prepared' },
    after: { status: 'filed', arn, period: filed.period, returnType: filed.returnType },
  });
  await emit({
    name: EVENTS.GST_RETURN_FILED,
    subject: { entityType: 'gst_filing', entityId: filed.id, recordCode: filed.recordCode },
    newState: {
      returnType: filed.returnType,
      period: filed.period,
      arn,
      netPayable: num(filed.netPayable),
    },
    impact: {
      domains: ['fin'],
      severity: 'S1_ATTENTION',
      materiality: { measure: 'gst_net_payable', value: num(filed.netPayable) ?? 0, currency: 'INR' },
    },
    confidentiality: 'confidential',
  });

  return filed;
}

export async function listFilings(filter: { returnType?: string; period?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'view' });
  return prisma.gstFiling.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.returnType ? { returnType: filter.returnType } : {}),
      ...(filter.period ? { period: filter.period } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ period: 'desc' }, { preparedAt: 'desc' }],
    take: 100,
  });
}

export async function filingDetail(filingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'gst_filings', verb: 'view' });
  const filing = await prisma.gstFiling.findFirst({ where: { id: filingId, tenantId: auth.tenantId } });
  if (!filing) throw ApiError.notFound('GST filing');
  return filing;
}

/**
 * Whether a period is closed, and by what.
 *
 * Read by the invoice write path and by the returns screen, which is why it is
 * one function: the screen saying a period is open while the write path refuses
 * an edit is the kind of disagreement nobody can debug from the outside.
 */
export async function periodStatus(period: string) {
  const auth = currentAuth();
  assertPeriodShape(period);
  const filings = await prisma.gstFiling.findMany({
    where: { tenantId: auth.tenantId, period, status: { in: ['prepared', 'filed'] } },
    orderBy: { preparedAt: 'desc' },
  });
  const filed = filings.filter((f) => f.status === 'filed');
  return {
    period,
    closed: filed.length > 0,
    filed: filed.map((f) => ({
      recordCode: f.recordCode,
      returnType: f.returnType,
      arn: f.arn,
      filedAt: f.filedAt?.toISOString() ?? null,
    })),
    prepared: filings
      .filter((f) => f.status === 'prepared')
      .map((f) => ({ id: f.id, recordCode: f.recordCode, returnType: f.returnType, preparedAt: f.preparedAt.toISOString() })),
  };
}

/**
 * The return in the offline utility's shape.
 *
 * Deliberately the offline shape rather than a claim to file directly: there is
 * no GSP integration in this platform, and a JSON that looks like an API payload
 * would imply one. This is the file a preparer uploads.
 */
export async function exportFilingJson(filingId: string) {
  const filing = await filingDetail(filingId);
  const snapshot = filing.snapshot as Record<string, unknown>;

  if (filing.returnType === 'GSTR1') {
    const snap = snapshot as unknown as Awaited<ReturnType<typeof computeGstr1>>;
    return {
      gstin: filing.gstin,
      fp: portalPeriod(filing.period),
      gt: snap.totals.invoiceValue,
      cur_gt: snap.totals.invoiceValue,
      b2b: snap.b2b.map((i) => ({
        ctin: i.customerGstin,
        inv: [
          {
            inum: i.invoiceNumber,
            idt: i.issuedDate.split('-').reverse().join('-'),
            val: i.invoiceValue,
            pos: i.placeOfSupply?.slice(0, 2) ?? null,
            rchrg: i.reverseCharge,
            inv_typ: 'R',
            itms: i.rates.map((rate, index) => ({
              num: index + 1,
              itm_det: {
                rt: rate,
                txval: i.taxableValue,
                camt: i.cgst,
                samt: i.sgst,
                iamt: i.igst,
              },
            })),
          },
        ],
      })),
      b2cs: snap.b2cs.map((r) => ({
        sply_ty: r.igst > 0 ? 'INTER' : 'INTRA',
        rt: r.gstRate,
        txval: r.taxableValue,
        iamt: r.igst,
        camt: r.cgst,
        samt: r.sgst,
      })),
      hsn: {
        data: snap.hsn.map((h, index) => ({
          num: index + 1,
          hsn_sc: h.hsnSac,
          desc: h.description,
          qty: h.quantity,
          rt: h.gstRate,
          txval: h.taxableValue,
          camt: h.cgst,
          samt: h.sgst,
          iamt: h.igst,
        })),
      },
      doc_issue: {
        doc_det: [
          {
            doc_num: 1,
            docs: [
              {
                num: 1,
                from: snap.documentSummary.from,
                to: snap.documentSummary.to,
                totnum: snap.documentSummary.issued,
                cancel: snap.documentSummary.cancelled,
                net_issue: snap.documentSummary.reported,
              },
            ],
          },
        ],
      },
    };
  }

  const snap = snapshot as unknown as Awaited<ReturnType<typeof computeGstr3b>>;
  return {
    gstin: filing.gstin,
    ret_period: portalPeriod(filing.period),
    sup_details: {
      osup_det: {
        txval: snap.outwardSupplies.taxableValue,
        iamt: snap.outwardSupplies.igst,
        camt: snap.outwardSupplies.cgst,
        samt: snap.outwardSupplies.sgst,
        csamt: 0,
      },
    },
    itc_elg: {
      itc_avl: [
        {
          ty: 'OTH',
          iamt: snap.inputTaxCredit.igst,
          camt: snap.inputTaxCredit.cgst,
          samt: snap.inputTaxCredit.sgst,
          csamt: 0,
        },
      ],
    },
    tx_pmt: {
      cash: {
        iamt: snap.payment.payableInCash.igst,
        camt: snap.payment.payableInCash.cgst,
        samt: snap.payment.payableInCash.sgst,
      },
      credit: {
        iamt: snap.payment.utilised.igst,
        camt: snap.payment.utilised.cgst,
        samt: snap.payment.utilised.sgst,
      },
    },
  };
}
