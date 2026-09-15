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
 * receipt it consolidates — a real document, stored and numbered, rather than
 * rendered on the fly. Raised automatically the instant a receipt brings an
 * invoice's balance to zero, so a customer paying in full does not need anybody
 * to remember a second step; also callable on demand mid-way, for the customer
 * who wants a statement of where they stand before the instalments are done.
 */

import { EVENTS, round2, type PaymentMode } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, visibilityWhere } from '../platform/permissions.js';
import { invoiceLabel, isCourseFeeInvoice, loadInvoiceForRead, totalsOf } from './invoicing.js';
import { companyProfile, documentNumbering } from './companyProfile.js';
import { DOCUMENT_SERIES, nextDocumentNumber } from '../platform/documentNumber.js';

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
      invoice: {
        select: { id: true, recordCode: true, draftReference: true, organizationId: true, personId: true, currency: true },
      },
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
    invoiceCode: r.invoice ? invoiceLabel(r.invoice) : null,
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
      recordCode: invoiceLabel(invoice),
      issuedDate: invoice.issuedDate?.toISOString() ?? null,
      dueDate: invoice.dueDate?.toISOString() ?? null,
      status: invoice.status,
      /** True when this is the internal course-fee working invoice, never a tax document itself. */
      isTempInvoice: isCourseFeeInvoice(invoice),
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

    // Deliberately not the invoice footnote. A company's is usually worded for
    // an invoice — "this is a computer-generated invoice" — and printing it at
    // the bottom of a receipt says the wrong thing about the document somebody
    // is holding.
    footnote: null as string | null,
  };
}

// ---------------------------------------------------------------------------
// The final invoice
// ---------------------------------------------------------------------------

/**
 * Raises the statement that closes out an invoice paid in instalments.
 *
 * Callable on demand — a customer who has paid two of three instalments can
 * legitimately ask for a statement of where they are, and this does not refuse
 * just because a balance remains; it prints the balance instead of pretending
 * there is none. And called automatically by `collectInvoicePayment` the moment
 * a receipt brings an invoice's balance to zero, so the customer leaves the
 * counter with the invoice, the receipt, and the statement that closes it out,
 * without anybody having to remember a second step. The idempotency check above
 * is what makes that safe: calling this again with nothing new to consolidate
 * hands back the statement that already stands rather than raising a duplicate.
 *
 * Refused when there is nothing to consolidate at all. An invoice with no
 * receipts against it has a final invoice already — the tax invoice, which says
 * the whole amount is owed and is still the only true document.
 *
 * Refused outright against a course-fee invoice: that one's final (tax)
 * invoice is never raised on demand, only automatically — see
 * `finalizeCourseFeeInvoice` below.
 */
export async function raiseFinalInvoice(invoiceId: string, input: { note?: string | null } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'create' });

  const invoice = await loadInvoiceForRead(invoiceId);
  if (isCourseFeeInvoice(invoice)) {
    throw ApiError.unprocessable(
      `${invoiceLabel(invoice)} is a course-fee invoice. Its final (tax) invoice is raised automatically — the moment it is fully paid, or the moment the student withdraws — never on demand.`,
    );
  }
  if (invoice.status === 'draft') {
    throw ApiError.unprocessable(
      `${invoiceLabel(invoice)} is still a draft, so there is nothing to finalise — it does not have an invoice number yet. Issue it, take the instalments, and raise this when they are done.`,
    );
  }
  if (invoice.status === 'void') {
    throw ApiError.unprocessable(`${invoiceLabel(invoice)} is void.`);
  }

  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, invoiceId },
    include: { payment: { select: { recordCode: true, method: true, gatewayReference: true } } },
    orderBy: { allocatedAt: 'asc' },
  });
  if (receipts.length === 0) {
    throw ApiError.unprocessable(
      `Nothing has been received against ${invoiceLabel(invoice)}, so there are no receipts to consolidate. The tax invoice is already the only document there is.`,
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

  // Nothing has changed since the last one — same receipts, same total, same
  // credit notes — so raising again would only produce a duplicate that
  // supersedes nothing new. This is what makes it safe to call automatically
  // every time an instalment settles an invoice: the deliberate act still
  // belongs to whoever asked for a statement mid-way, and this just hands back
  // what already stands rather than starting a pointless supersession chain.
  const current = previous.find(
    (p) =>
      p.receiptCount === rows.length &&
      Math.abs((num(p.totalReceived) ?? 0) - totalReceived) < 0.001 &&
      Math.abs((num(p.creditNoted) ?? 0) - totals.creditNoted) < 0.001,
  );
  if (current) return current;

  const numbering = await documentNumbering();
  const recordCode = await nextDocumentNumber(
    DOCUMENT_SERIES.finalInvoice,
    numbering.prefix,
    new Date(),
    numbering.yearFormat,
  );
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
    after: { recordCode, against: invoiceLabel(invoice), totalReceived, balance, receipts: rows.length },
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

/**
 * Raises the one and only final (tax) invoice a course-fee invoice ever
 * gets, and locks it there — the document that closes the course out, the
 * only one the student ever receives that is actually a tax invoice.
 *
 * Called from exactly two places: `collectInvoicePayment`, the instant a
 * receipt brings the temp invoice's balance to zero (`trigger: 'settled'`),
 * and the enrolment-withdrawal handler in `education.routes.ts`, the instant
 * a student's enrolment is marked withdrawn (`trigger: 'dropout'`). The
 * dropout path can fire with zero receipts against it — a student who leaves
 * having paid nothing still gets a nil tax invoice for the record, dated the
 * day they left, rather than no document at all.
 *
 * Idempotent by construction rather than by matching figures the way
 * `raiseFinalInvoice` does: a course-fee invoice gets exactly one of these,
 * ever, so if one already exists it is simply handed back rather than
 * compared against. Nothing calls this a second time with something new to
 * say — settlement and withdrawal are each a one-time event, and settlement
 * can only happen once, since there is nothing further to collect once the
 * balance is at zero.
 */
export async function finalizeCourseFeeInvoice(invoiceId: string, trigger: 'settled' | 'dropout') {
  const auth = currentAuth();
  await assertCan({ resource: 'invoices', verb: 'create' });

  const invoice = await loadInvoiceForRead(invoiceId);
  if (!isCourseFeeInvoice(invoice)) {
    throw ApiError.unprocessable(`${invoiceLabel(invoice)} is not a course-fee invoice.`);
  }
  if (invoice.status === 'void') {
    throw ApiError.unprocessable(`${invoiceLabel(invoice)} is void.`);
  }

  const existing = await prisma.finalInvoice.findFirst({ where: { tenantId: auth.tenantId, invoiceId } });
  if (existing) return existing;

  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, invoiceId },
    include: { payment: { select: { recordCode: true, method: true, gatewayReference: true } } },
    orderBy: { allocatedAt: 'asc' },
  });

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

  const numbering = await documentNumbering();
  const recordCode = await nextDocumentNumber(
    DOCUMENT_SERIES.finalInvoice,
    numbering.prefix,
    new Date(),
    numbering.yearFormat,
  );
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
      snapshot: { receipts: rows, supersedes: [] } as never,
      triggerReason: trigger,
      note:
        trigger === 'dropout'
          ? rows.length === 0
            ? 'The student withdrew having paid nothing against this course.'
            : 'The student withdrew before the instalments were complete.'
          : null,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'final_invoice',
    subjectId: final.id,
    after: { recordCode, against: invoiceLabel(invoice), totalReceived, balance, receipts: rows.length, trigger },
  });
  await emit({
    name: EVENTS.FINAL_INVOICE_RAISED,
    subject: { entityType: 'final_invoice', entityId: final.id, recordCode },
    related: [{ relation: 'finalises', entityType: 'invoice', entityId: invoiceId }],
    newState: {
      trigger,
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
    include: { invoice: { select: { recordCode: true, draftReference: true, currency: true } } },
    orderBy: { issuedAt: 'desc' },
    take: filter.limit ?? 100,
  });

  return rows.map((f) => ({
    id: f.id,
    recordCode: f.recordCode,
    invoiceId: f.invoiceId,
    invoiceCode: f.invoice.recordCode ?? f.invoice.draftReference ?? f.invoiceId,
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
    /** settled | dropout | null — why this was raised. See `finalizeCourseFeeInvoice`. */
    triggerReason: final.triggerReason,
    /**
     * True when this final invoice is itself the tax invoice — raised
     * against a course-fee invoice, which is never a tax document on its
     * own. False against a generic invoice, where this is a statement about
     * a tax invoice raised separately.
     */
    isTaxInvoice: isCourseFeeInvoice(invoice),

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
      recordCode: invoiceLabel(invoice),
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
