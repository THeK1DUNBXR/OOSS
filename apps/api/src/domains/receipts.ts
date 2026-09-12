/**
 * Receipts, and the final invoice that consolidates them.
 *
 * Three documents, because a customer paying in instalments needs three
 * different things handed to them and the platform used to produce one.
 *
 * **The tax invoice** states the whole obligation and is final. It is raised
 * once, it says what was handed over on the day, and it never changes again —
 * the copy the customer keeps has to still read the same in three years.
 *
 * **A receipt** is what each instalment produces. Its own number, its own time,
 * the invoice it is against, the amount, how it was paid and what was left
 * afterwards. Those figures are snapshotted onto the receipt row rather than
 * recomputed, because a receipt saying "₹20,000 of ₹70,800, ₹50,800 still owed"
 * has to keep saying that after the next instalment lands. RECEIPT was always the
 * allocation join and always made part payment representable in the ledger; what
 * was missing was that it is also a document.
 *
 * **The final invoice** is raised once the instalments are done. Neither of the
 * other two can answer "what did I owe, what have I paid, and against which
 * receipts": the invoice predates the payments, and each receipt only knows about
 * itself. So this is that answer, with its own number and date, naming every
 * receipt it consolidates — raised deliberately rather than rendered on the fly,
 * because it is a thing somebody hands over.
 */

import { EVENTS, round2, type PaymentMode } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, visibilityWhere } from '../platform/permissions.js';
import { loadInvoiceForRead, totalsOf } from './invoicing.js';
import { companyProfile } from './companyProfile.js';

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * Receipts, narrowed the way invoices are.
 *
 * A receipt's owner is whoever allocated it, which for a counter collection is
 * whoever took the money — so an employee holding `payments@own` sees the
 * receipts they issued and no others.
 */
export async function listReceipts(filter: { invoiceId?: string; limit?: number } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payments', verb: 'view' });
  const scope = await visibilityWhere('payments', 'allocatedById');

  const rows = await prisma.receipt.findMany({
    where: {
      tenantId: auth.tenantId,
      ...scope,
      ...(filter.invoiceId ? { invoiceId: filter.invoiceId } : {}),
    },
    include: {
      payment: true,
      invoice: { select: { id: true, recordCode: true, organizationId: true, personId: true, currency: true } },
    },
    orderBy: { allocatedAt: 'desc' },
    take: filter.limit ?? 200,
  });

  const orgIds = [...new Set(rows.map((r) => r.invoice?.organizationId).filter(Boolean) as string[])];
  const personIds = [...new Set(rows.map((r) => r.invoice?.personId).filter(Boolean) as string[])];
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

  return rows.map((r) => ({
    id: r.id,
    recordCode: r.recordCode,
    /** The time the receipt was issued, which is the fact a receipt exists to fix. */
    issuedAt: r.allocatedAt.toISOString(),
    invoiceId: r.invoiceId,
    invoiceCode: r.invoice?.recordCode ?? null,
    feeInstalmentId: r.feeInstalmentId,
    customerName: nameOf.get(r.invoice?.organizationId ?? r.invoice?.personId ?? '') ?? null,
    amount: num(r.allocatedAmount) ?? 0,
    currency: r.invoice?.currency ?? r.payment.currency,
    subjectTotal: num(r.subjectTotal) ?? 0,
    balanceAfter: num(r.balanceAfter) ?? 0,
    paymentMode: r.paymentMode ?? r.payment.method,
    paymentReference: r.paymentReference ?? r.payment.gatewayReference,
    paymentCode: r.payment.recordCode,
    note: r.note,
    /** True when this instalment cleared the invoice. */
    settledIt: (num(r.balanceAfter) ?? 0) <= 0.001,
  }));
}

/**
 * A receipt as a document.
 *
 * The two figures live here rather than on the invoice for anything after the
 * first instalment: what the invoice is for, and what is being handed over now.
 * Read from the receipt's own snapshot, so a reprint shows the position as it was
 * when the customer was given it.
 */
export async function receiptDocument(receiptId: string) {
  const auth = currentAuth();
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, tenantId: auth.tenantId },
    include: { payment: true },
  });
  if (!receipt) throw ApiError.notFound('Receipt');
  if (!receipt.invoiceId) {
    throw ApiError.unprocessable(
      `${receipt.recordCode} allocates to a fee instalment rather than an invoice, and this document is the invoice receipt.`,
    );
  }

  // Whether somebody may read the receipt is the same question as whether they
  // may read the invoice it is against.
  const invoice = await loadInvoiceForRead(receipt.invoiceId);
  const profile = await companyProfile();

  const org = invoice.organizationId
    ? await prisma.organization.findFirst({
        where: { id: invoice.organizationId },
        include: { account: true },
      })
    : null;
  const person = invoice.personId
    ? await prisma.person.findFirst({
        where: { id: invoice.personId },
        select: { fullName: true, recordCode: true, primaryPhone: true, primaryEmail: true },
      })
    : null;
  const issuedBy = receipt.allocatedById
    ? await prisma.person.findFirst({ where: { id: receipt.allocatedById }, select: { fullName: true } })
    : null;

  // Where this instalment sits in the sequence. "Receipt 2 of 3" is what a
  // customer looks for, and it cannot be worked out from one row.
  const siblings = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, invoiceId: receipt.invoiceId },
    orderBy: { allocatedAt: 'asc' },
    select: { id: true, recordCode: true, allocatedAmount: true, allocatedAt: true, paymentMode: true },
  });
  const index = siblings.findIndex((r) => r.id === receipt.id);
  const receivedToDate = round2(
    siblings.slice(0, index + 1).reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0),
  );

  const amount = num(receipt.allocatedAmount) ?? 0;
  const subjectTotal = num(receipt.subjectTotal) || totalsOf(invoice).payable;
  const balanceAfter = num(receipt.balanceAfter) ?? round2(Math.max(subjectTotal - receivedToDate, 0));

  return {
    id: receipt.id,
    recordCode: receipt.recordCode,
    /** When it was issued. A receipt without a time is not a receipt. */
    issuedAt: receipt.allocatedAt.toISOString(),
    issuedBy: issuedBy?.fullName ?? null,
    currency: invoice.currency,

    /** The invoice number this receipt is against, which is what ties the two. */
    invoice: {
      id: invoice.id,
      recordCode: invoice.recordCode,
      issuedDate: invoice.issuedDate?.toISOString() ?? null,
      dueDate: invoice.dueDate?.toISOString() ?? null,
      status: invoice.status,
    },

    supplier: {
      legalName: profile.legalName,
      tradeName: profile.tradeName,
      gstin: profile.gstin,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      city: profile.city,
      pincode: profile.pincode,
      phone: profile.phone,
      email: profile.email,
    },

    customer: {
      kind: invoice.personId ? ('person' as const) : ('organization' as const),
      name: org?.name ?? person?.fullName ?? '—',
      recordCode: org?.recordCode ?? person?.recordCode ?? null,
      gstin: invoice.customerGstin,
      address: org?.account?.billingAddress ?? null,
      phone: person?.primaryPhone ?? null,
      email: org?.account?.billingEmail ?? person?.primaryEmail ?? null,
    },

    payment: {
      /** The amount this receipt acknowledges. */
      amount,
      mode: (receipt.paymentMode ?? receipt.payment.method) as PaymentMode | string,
      reference: receipt.paymentReference ?? receipt.payment.gatewayReference,
      paymentCode: receipt.payment.recordCode,
      note: receipt.note,
    },

    /**
     * The two figures, snapshotted: the whole obligation, and what was handed
     * over now. Plus where the instalment sits in the sequence and what was left
     * after it.
     */
    position: {
      totalPayable: subjectTotal,
      amountReceivedNow: amount,
      receivedToDate,
      balanceAfter,
      isPartPayment: balanceAfter > 0.001,
      instalmentNumber: index + 1,
      instalmentsSoFar: siblings.length,
    },

    /** Every receipt against this invoice, so one document shows the sequence. */
    sequence: siblings.map((r, i) => ({
      number: i + 1,
      recordCode: r.recordCode,
      issuedAt: r.allocatedAt.toISOString(),
      amount: num(r.allocatedAmount) ?? 0,
      mode: r.paymentMode,
      isThisOne: r.id === receipt.id,
    })),

    footnote: profile.invoiceNotes,
  };
}

// ---------------------------------------------------------------------------
// The final invoice
// ---------------------------------------------------------------------------

/**
 * Raises the statement that closes out an invoice paid in instalments.
 *
 * Deliberate rather than automatic, because it is a document somebody hands over:
 * it has a number, a date and a signature line, and generating one silently every
 * time a payment landed would fill the record with statements nobody issued.
 *
 * Refused when there is nothing to consolidate. An invoice with no receipts
 * against it has a final invoice already — the tax invoice, which says the whole
 * amount is owed and is still the only true document.
 *
 * Not refused when a balance remains. A customer who has paid two of three
 * instalments can legitimately ask for a statement of where they are, and a
 * document that refuses to exist until the last rupee arrives is no use to them.
 * It prints the balance instead of pretending there is none.
 */
export async function raiseFinalInvoice(invoiceId: string, input: { note?: string | null } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'create' });

  const invoice = await loadInvoiceForRead(invoiceId);
  if (invoice.status === 'draft') {
    throw ApiError.unprocessable(
      `${invoice.recordCode} is still a draft, so there is nothing to finalise. Issue it, take the instalments, and raise this when they are done.`,
    );
  }
  if (invoice.status === 'void') {
    throw ApiError.unprocessable(`${invoice.recordCode} is void.`);
  }

  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, invoiceId },
    include: { payment: { select: { recordCode: true, method: true, gatewayReference: true } } },
    orderBy: { allocatedAt: 'asc' },
  });
  if (receipts.length === 0) {
    throw ApiError.unprocessable(
      `Nothing has been received against ${invoice.recordCode}, so there are no receipts to consolidate. The tax invoice is already the only document there is.`,
    );
  }

  const creditNotes = await prisma.creditNote.findMany({ where: { invoiceId } });
  const totals = totalsOf({ ...invoice, creditNotes });

  const rows = receipts.map((r, i) => ({
    number: i + 1,
    recordCode: r.recordCode,
    issuedAt: r.allocatedAt.toISOString(),
    amount: num(r.allocatedAmount) ?? 0,
    mode: r.paymentMode ?? r.payment.method,
    reference: r.paymentReference ?? r.payment.gatewayReference,
    paymentCode: r.payment.recordCode,
    balanceAfter: num(r.balanceAfter) ?? 0,
  }));

  const totalReceived = round2(rows.reduce((s, r) => s + r.amount, 0));
  const balance = round2(Math.max(totals.payable - totalReceived - totals.creditNoted, 0));

  // An earlier statement is superseded rather than replaced: both were true when
  // they were handed over, and a customer holding the first one is not wrong.
  const previous = await prisma.finalInvoice.findMany({
    where: { tenantId: auth.tenantId, invoiceId, status: 'issued' },
  });

  const recordCode = await nextRecordCode('FNL');
  const final = await prisma.finalInvoice.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      invoiceId,
      issuedById: auth.partyId,
      totalPayable: totals.payable,
      totalReceived,
      creditNoted: totals.creditNoted,
      balance,
      settled: balance <= 0.001,
      receiptCodes: rows.map((r) => r.recordCode),
      receiptCount: rows.length,
      snapshot: { receipts: rows, supersedes: previous.map((p) => p.recordCode) } as never,
      note: input.note ?? null,
    },
  });

  for (const old of previous) {
    await prisma.finalInvoice.update({
      where: { id: old.id },
      data: { status: 'superseded', supersededById: final.id },
    });
    await emit({
      name: EVENTS.FINAL_INVOICE_SUPERSEDED,
      subject: { entityType: 'final_invoice', entityId: old.id, recordCode: old.recordCode },
      newState: { supersededBy: recordCode },
      impact: { domains: ['fin'] },
    });
  }

  await auditWrite({
    action: 'create',
    subjectType: 'final_invoice',
    subjectId: final.id,
    after: { recordCode, against: invoice.recordCode, totalReceived, balance, receipts: rows.length },
  });
  await emit({
    name: EVENTS.FINAL_INVOICE_RAISED,
    subject: { entityType: 'final_invoice', entityId: final.id, recordCode },
    related: [{ relation: 'finalises', entityType: 'invoice', entityId: invoiceId }],
    newState: {
      totalPayable: totals.payable,
      totalReceived,
      balance,
      settled: balance <= 0.001,
      receipts: rows.map((r) => r.recordCode),
    },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  return final;
}

export async function listFinalInvoices(filter: { invoiceId?: string; limit?: number } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'view' });
  const scope = await visibilityWhere('invoices', 'createdById');

  const rows = await prisma.finalInvoice.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.invoiceId ? { invoiceId: filter.invoiceId } : {}),
      // Narrowed through the invoice, because a final invoice is a document
      // about one: whoever may read the invoice may read its statements.
      invoice: scope,
    },
    include: { invoice: { select: { recordCode: true, currency: true } } },
    orderBy: { issuedAt: 'desc' },
    take: filter.limit ?? 100,
  });

  return rows.map((f) => ({
    id: f.id,
    recordCode: f.recordCode,
    invoiceId: f.invoiceId,
    invoiceCode: f.invoice.recordCode,
    currency: f.invoice.currency,
    issuedAt: f.issuedAt.toISOString(),
    totalPayable: num(f.totalPayable) ?? 0,
    totalReceived: num(f.totalReceived) ?? 0,
    creditNoted: num(f.creditNoted) ?? 0,
    balance: num(f.balance) ?? 0,
    settled: f.settled,
    receiptCodes: f.receiptCodes,
    receiptCount: f.receiptCount,
    status: f.status,
    note: f.note,
  }));
}

/**
 * The final invoice as a document.
 *
 * Read from the snapshot, not from the live receipts. A statement handed over on
 * the 12th must still say what it said on the 12th, and an instalment arriving on
 * the 19th produces a new statement rather than editing the old one.
 */
export async function finalInvoiceDocument(finalInvoiceId: string) {
  const auth = currentAuth();
  const final = await prisma.finalInvoice.findFirst({
    where: { id: finalInvoiceId, tenantId: auth.tenantId },
  });
  if (!final) throw ApiError.notFound('Final invoice');

  const invoice = await loadInvoiceForRead(final.invoiceId);
  const profile = await companyProfile();

  const org = invoice.organizationId
    ? await prisma.organization.findFirst({
        where: { id: invoice.organizationId },
        include: { account: true },
      })
    : null;
  const person = invoice.personId
    ? await prisma.person.findFirst({
        where: { id: invoice.personId },
        select: { fullName: true, recordCode: true, primaryPhone: true, primaryEmail: true },
      })
    : null;
  const issuedBy = final.issuedById
    ? await prisma.person.findFirst({ where: { id: final.issuedById }, select: { fullName: true } })
    : null;

  const snapshot = final.snapshot as {
    receipts: Array<{
      number: number;
      recordCode: string;
      issuedAt: string;
      amount: number;
      mode: string | null;
      reference: string | null;
      balanceAfter: number;
    }>;
    supersedes?: string[];
  };

  const courseIds = [...new Set(invoice.lines.map((l) => l.courseId).filter(Boolean) as string[])];
  const courses = courseIds.length
    ? await prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, name: true, code: true } })
    : [];
  const courseMap = new Map(courses.map((c) => [c.id, c]));

  return {
    id: final.id,
    recordCode: final.recordCode,
    issuedAt: final.issuedAt.toISOString(),
    issuedBy: issuedBy?.fullName ?? null,
    status: final.status,
    currency: invoice.currency,
    note: final.note,
    supersedes: snapshot.supersedes ?? [],

    supplier: {
      legalName: profile.legalName,
      tradeName: profile.tradeName,
      gstin: profile.gstin,
      stateName: profile.stateName,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      city: profile.city,
      pincode: profile.pincode,
      phone: profile.phone,
      email: profile.email,
      terms: profile.invoiceTerms,
      footnote: profile.invoiceNotes,
    },

    customer: {
      kind: invoice.personId ? ('person' as const) : ('organization' as const),
      name: org?.name ?? person?.fullName ?? '—',
      recordCode: org?.recordCode ?? person?.recordCode ?? null,
      gstin: invoice.customerGstin,
      address: org?.account?.billingAddress ?? null,
      phone: person?.primaryPhone ?? null,
      email: org?.account?.billingEmail ?? person?.primaryEmail ?? null,
    },

    /** The tax invoice this finalises, named by number as a customer would. */
    invoice: {
      id: invoice.id,
      recordCode: invoice.recordCode,
      issuedDate: invoice.issuedDate?.toISOString() ?? null,
      dueDate: invoice.dueDate?.toISOString() ?? null,
      placeOfSupply: invoice.placeOfSupply,
      interState: invoice.interState,
      taxableValue: num(invoice.taxableValue) ?? 0,
      cgst: num(invoice.cgstAmount) ?? 0,
      sgst: num(invoice.sgstAmount) ?? 0,
      igst: num(invoice.igstAmount) ?? 0,
      roundOff: num(invoice.roundOff) ?? 0,
      lines: invoice.lines.map((l) => ({
        description: l.description,
        courseName: l.courseId ? (courseMap.get(l.courseId)?.name ?? null) : null,
        hsnSac: l.hsnSac,
        quantity: l.quantity,
        unitPrice: num(l.unitPrice) ?? 0,
        amount: num(l.amount) ?? 0,
        gstRate: num(l.gstRate) ?? 0,
        taxAmount: num(l.taxAmount) ?? 0,
      })),
    },

    /** Every instalment, with its receipt number — the point of the document. */
    receipts: snapshot.receipts,

    totals: {
      totalPayable: num(final.totalPayable) ?? 0,
      totalReceived: num(final.totalReceived) ?? 0,
      creditNoted: num(final.creditNoted) ?? 0,
      balance: num(final.balance) ?? 0,
      settled: final.settled,
      instalments: final.receiptCount,
    },
  };
}
