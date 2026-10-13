/**
 * Invoice posting (Phase 0). An invoice's issue and each receipt reach the journal,
 * in the same database transaction as the document they belong to, through postInTx
 * (ledger.ts). The pattern is payrollAccrual.ts: resolve the accounts the entry needs,
 * build it with the pure builder in @kaizen/shared, then write it.
 *
 * What the entry is built from is what the invoice already stores: the line amounts,
 * the tax and round-off on the invoice row, and the receipt's allocated amount. Nothing
 * is recomputed here, so the journal can only say what the document says.
 *
 * Every refusal happens before a row is written in the calling transaction, and names
 * what is missing. A division is never defaulted to a business line, an invoice is
 * never booked to a ledger entity it does not name, and a missing period is created
 * rather than guessed at. Those are finance's decisions, made in the mapping tables.
 */
import {
  buildInvoiceIssueEntry,
  buildReceiptAllocationEntry,
  EVENTS,
  invoiceIssueRoles,
  istCivilDay,
  istDateKey,
  postingKeys,
  PostingRuleError,
  receiptAllocationRoles,
  type PostingLine,
} from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { governedWrite } from '../platform/governedWrite.js';
import { postInTx, type JournalLineInput } from '../platform/ledger.js';
import { resolvePostingAccounts } from '../platform/postingRoles.js';

registerGovernedEntities('fin', ['invoice_division_line']);

/**
 * The ledger entity a new invoice is booked to. The tenant's one entity is taken
 * without a question; with none, or with several and none named, the creation is
 * refused and says which. A named entity must be the tenant's own.
 */
export async function ledgerEntityForNewInvoice(tenantId: string, requested?: string | null): Promise<string> {
  if (requested) {
    const named = await prisma.ledgerEntity.findFirst({ where: { tenantId, id: requested }, select: { id: true } });
    if (!named) throw ApiError.unprocessable('That ledger entity is not in this tenant. Nothing was created.');
    return named.id;
  }
  const entities = await prisma.ledgerEntity.findMany({
    where: { tenantId },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
    take: 3,
  });
  if (entities.length === 1) return entities[0]!.id;
  if (entities.length === 0) {
    throw ApiError.unprocessable(
      'This tenant has no ledger entity, so an invoice has nothing to be booked to. Create one, then raise the invoice again. Nothing was created.',
    );
  }
  const codes = entities.map((e) => e.code).join(', ');
  throw ApiError.unprocessable(
    `This tenant has several ledger entities (${codes}), so the invoice must name which one it is booked to: pass ledgerEntityId. Nothing was created.`,
  );
}

/** The customer's party on the journal: the organisation, or the student. One of them is always set (invoicing.ts resolveCustomer). */
function partyOf(invoice: { organizationId: string | null; personId: string | null }): string | null {
  return invoice.organizationId ?? invoice.personId ?? null;
}

/**
 * Posts an invoice's issue entry inside `tx`. The caller has taken the invoice's lock
 * and the period lock (lockLegacyPeriod) before its first number is issued, and writes
 * the invoice's status and number before this call. Refusals roll the caller's
 * transaction back, so a refused issue leaves no number and no status behind.
 */
export async function postInvoiceIssue(
  tx: DbTx,
  invoiceId: string,
  issuedDate: Date,
): Promise<{ id: string; entryNumber: string } | null> {
  const auth = currentAuth();
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, tenantId: auth.tenantId },
    select: {
      recordCode: true,
      draftReference: true,
      enrollmentDate: true,
      ledgerEntityId: true,
      division: true,
      organizationId: true,
      personId: true,
      grandTotalMinor: true,
      cgstAmountMinor: true,
      sgstAmountMinor: true,
      igstAmountMinor: true,
      roundOffMinor: true,
    },
  });
  if (!invoice) throw ApiError.notFound('Invoice');
  // Owner decision, 2026-10-13: the temporary course-fee scheme is being replaced by receipts
  // leading to a final invoice, and nothing posts until that lands. A course-fee invoice is the
  // one with an enrolment date (isCourseFeeInvoice, invoicing.ts), the same predicate that picks
  // the temp series and that gst.ts's beforeIssue hook forces to `temp`. It issues with no entry.
  if (invoice.enrollmentDate) return null;
  const label = invoice.recordCode ?? invoice.draftReference ?? invoiceId;

  if (!invoice.ledgerEntityId) {
    throw ApiError.unprocessable(
      `${label} has no ledger entity, so it cannot be booked and cannot be issued. Set the entity it is booked to, then issue again. Nothing was issued.`,
    );
  }
  const partyId = partyOf(invoice);
  if (!partyId) {
    throw ApiError.unprocessable(`${label} names no customer, so its receivable has no party. Nothing was issued.`);
  }
  if (!invoice.division) {
    throw ApiError.unprocessable(
      `${label} has no division, so its revenue has no business line. Set a division on the invoice, then issue again. Nothing was issued.`,
    );
  }

  const entryDate = istCivilDay(issuedDate);
  const mapping = await tx.invoiceDivisionLine.findFirst({
    where: {
      tenantId: auth.tenantId,
      division: invoice.division,
      effectiveFrom: { lte: entryDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: entryDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { lineId: true },
  });
  if (!mapping) {
    throw ApiError.unprocessable(
      `Division "${invoice.division}" has no business line on ${istDateKey(entryDate)}. Map it under invoice division lines, then issue again. Nothing was issued.`,
    );
  }

  const lines = await tx.invoiceLine.findMany({
    where: { tenantId: auth.tenantId, invoiceId },
    select: { amountMinor: true },
    orderBy: { position: 'asc' },
  });
  const source = {
    partyId,
    grandTotalMinor: invoice.grandTotalMinor,
    revenue: lines.map((line) => ({ lineId: mapping.lineId, taxableMinor: line.amountMinor })),
    cgstMinor: invoice.cgstAmountMinor,
    sgstMinor: invoice.sgstAmountMinor,
    igstMinor: invoice.igstAmountMinor,
    roundOffMinor: invoice.roundOffMinor,
    roundOffLineId: mapping.lineId,
  };
  const accounts = await resolvePostingAccounts(tx, invoiceIssueRoles(source), entryDate);
  let entryLines: PostingLine[];
  try {
    entryLines = buildInvoiceIssueEntry(source, accounts);
  } catch (err) {
    if (err instanceof PostingRuleError) throw ApiError.unprocessable(`${err.message} Nothing was issued.`);
    throw err;
  }

  const entry = await postInTx(tx, {
    entityId: invoice.ledgerEntityId,
    entryDate,
    narration: `Invoice ${label}`,
    sourceType: 'invoice',
    sourceId: invoiceId,
    idempotencyKey: postingKeys.invoiceIssue(invoiceId),
    lines: entryLines as JournalLineInput[],
  });
  return { id: entry.id, entryNumber: entry.entryNumber };
}

/**
 * Posts a receipt's allocation inside `tx`: the bank for its payment mode is debited
 * and the customer's receivable credited. The amount is the receipt row's own
 * allocatedAmountMinor, so the journal is the receipt's own paise.
 */
export async function postReceiptAllocation(
  tx: DbTx,
  input: {
    receiptId: string;
    receiptCode: string;
    allocatedAmountMinor: bigint;
    paymentMode: string;
    invoice: {
      recordCode: string | null;
      draftReference: string | null;
      ledgerEntityId: string | null;
      organizationId: string | null;
      personId: string | null;
    };
    receivedAt: Date;
  },
): Promise<{ id: string; entryNumber: string }> {
  const label = input.invoice.recordCode ?? input.invoice.draftReference ?? 'the invoice';
  if (!input.invoice.ledgerEntityId) {
    throw ApiError.unprocessable(
      `${label} has no ledger entity, so a payment against it cannot be booked. Set the entity it is booked to, then collect again. Nothing was recorded.`,
    );
  }
  const partyId = partyOf(input.invoice);
  if (!partyId) {
    throw ApiError.unprocessable(
      `${label} names no customer, so the receipt has no receivable party. Nothing was recorded.`,
    );
  }

  const entryDate = istCivilDay(input.receivedAt);
  const accounts = await resolvePostingAccounts(tx, receiptAllocationRoles(input.paymentMode), entryDate);
  let entryLines: PostingLine[];
  try {
    entryLines = buildReceiptAllocationEntry(
      {
        partyId,
        amountMinor: input.allocatedAmountMinor,
        paymentMode: input.paymentMode,
      },
      accounts,
    );
  } catch (err) {
    if (err instanceof PostingRuleError) throw ApiError.unprocessable(`${err.message} Nothing was recorded.`);
    throw err;
  }

  const entry = await postInTx(tx, {
    entityId: input.invoice.ledgerEntityId,
    entryDate,
    narration: `Receipt ${input.receiptCode} against ${label}`,
    sourceType: 'receipt',
    sourceId: input.receiptId,
    idempotencyKey: postingKeys.receiptAllocated(input.receiptId),
    lines: entryLines as JournalLineInput[],
  });
  return { id: entry.id, entryNumber: entry.entryNumber };
}

/** Whether the invoice's issue has an entry in the journal. Read before a transaction opens, so the permission check can run. */
export async function issueEntryExists(invoiceId: string): Promise<boolean> {
  const auth = currentAuth();
  const entry = await prisma.journalEntry.findFirst({
    where: { tenantId: auth.tenantId, idempotencyKey: postingKeys.invoiceIssue(invoiceId) },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * Whether the invoice's issue has an entry, read inside `tx`. A receipt against an
 * invoice with no issue entry posts nothing (see `receiptPostsFor`).
 */
export async function issueEntryIn(tx: DbTx, invoiceId: string): Promise<boolean> {
  const auth = currentAuth();
  const entry = await tx.journalEntry.findFirst({
    where: { tenantId: auth.tenantId, idempotencyKey: postingKeys.invoiceIssue(invoiceId) },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * Whether a receipt against this invoice posts to the journal. Owner decision, 2026-10-13:
 * an invoice issued before posting was wired has no issue entry, and it stays outside the
 * journal for now (the backfill question is open). A receipt against it therefore posts
 * nothing, so the receivable is never credited with no debit behind it. The receipt row
 * itself is still written; only its journal entry is withheld. Collection refuses drafts
 * (collectInvoicePayment), so in practice this is the issued-without-entry case.
 */
export async function receiptPostsFor(tx: DbTx, invoiceId: string): Promise<boolean> {
  // The temporary course-fee scheme posts nothing (owner decision, 2026-10-13; see postInvoiceIssue).
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, tenantId: currentAuth().tenantId },
    select: { enrollmentDate: true },
  });
  if (invoice?.enrollmentDate) return false;
  return issueEntryIn(tx, invoiceId);
}

/**
 * Reverses one journal entry inside `tx`, through postInTx's reversal (the same write
 * reverse() makes outside a transaction). The reversal is dated with the original, so
 * it lands in the original's period, and a closed period refuses it.
 */
export async function reverseEntryIn(tx: DbTx, entryId: string, reason: string): Promise<string> {
  const original = await tx.journalEntry.findFirst({
    where: { tenantId: currentAuth().tenantId, id: entryId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  if (!original) throw ApiError.notFound('Journal entry');
  const reversal = await postInTx(tx, {
    entityId: original.entityId,
    entryDate: original.entryDate,
    narration: reason,
    sourceType: 'reversal',
    sourceId: original.id,
    idempotencyKey: `reversal:${original.id}`,
    reversalOfId: original.id,
    lines: original.lines.map((line) => ({
      accountId: line.accountId,
      amountMinor: -line.amountMinor,
      lineId: line.lineId ?? undefined,
      division: line.division ?? undefined,
      costCentreId: line.costCentreId ?? undefined,
      projectId: line.projectId ?? undefined,
      partyId: line.partyId ?? undefined,
      taxCodeId: line.taxCodeId ?? undefined,
      memo: line.memo ?? undefined,
    })),
  });
  return reversal.id;
}

/**
 * Reverses an invoice's issue entry inside `tx`, when there is one. A voided invoice
 * keeps no receivable: the correction is a reversal (CLAUDE.md rule 2). An invoice issued
 * before posting was wired has no entry, and nothing is reversed.
 */
export async function reverseInvoiceIssue(tx: DbTx, invoiceId: string, reason: string): Promise<string | null> {
  const entry = await tx.journalEntry.findFirst({
    where: { tenantId: currentAuth().tenantId, idempotencyKey: postingKeys.invoiceIssue(invoiceId) },
    select: { id: true },
  });
  if (!entry) return null;
  return reverseEntryIn(tx, entry.id, reason);
}

/** Whether any receipt of this payment has a journal entry to reverse. Read before a transaction opens, for the permission check. */
export async function paymentHasReceiptEntries(paymentId: string): Promise<boolean> {
  const auth = currentAuth();
  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, paymentId },
    select: { id: true },
  });
  if (receipts.length === 0) return false;
  const entry = await prisma.journalEntry.findFirst({
    where: {
      tenantId: auth.tenantId,
      idempotencyKey: { in: receipts.map((r) => postingKeys.receiptAllocated(r.id)) },
    },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * Reverses the journal entries of every receipt a payment allocated, inside `tx`. A
 * payment reversal undoes the money the receipts carried, so their entries reverse with
 * it. A receipt with no entry (against an invoice issued before posting was wired) has
 * nothing to reverse. Returns how many entries were reversed.
 */
export async function reverseReceiptEntries(tx: DbTx, paymentId: string, reason: string): Promise<number> {
  const auth = currentAuth();
  const receipts = await tx.receipt.findMany({
    where: { tenantId: auth.tenantId, paymentId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let reversed = 0;
  for (const receipt of receipts) {
    const entry = await tx.journalEntry.findFirst({
      where: { tenantId: auth.tenantId, idempotencyKey: postingKeys.receiptAllocated(receipt.id) },
      select: { id: true },
    });
    if (!entry) continue;
    await reverseEntryIn(tx, entry.id, reason);
    reversed += 1;
  }
  return reversed;
}

// ---------------------------------------------------------------------------
// The mapping: invoice division to business line
// ---------------------------------------------------------------------------

export async function listInvoiceDivisionLines() {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });
  return prisma.invoiceDivisionLine.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ division: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export interface InvoiceDivisionLineInput {
  division: string;
  lineId: string;
  /** The first IST day the mapping applies, YYYY-MM-DD. */
  effectiveFrom: string;
}

/**
 * Maps an invoice division to a business line from `effectiveFrom`. The open mapping
 * it replaces, if there is one, is ended the day before in the same write, so a division
 * never has two open mappings. A new mapping must start after the open one.
 */
export async function setInvoiceDivisionLine(input: InvoiceDivisionLineInput) {
  const auth = currentAuth();
  await assertScopeAll('transactions', 'create');
  const division = input.division.trim();
  if (!division) throw ApiError.badRequest('A division is required.');
  const effectiveFrom = dayOf(input.effectiveFrom);
  if (!auth.partyId) {
    throw ApiError.forbidden('An invoice division line is recorded against a person, and this session has none.');
  }
  const createdById = auth.partyId;

  return governedWrite(async (tx) => {
    const line = await tx.businessLine.findFirst({
      where: { tenantId: auth.tenantId, id: input.lineId },
      select: { id: true },
    });
    if (!line) throw ApiError.unprocessable('That business line is not in the tenant registry.');

    const open = await tx.invoiceDivisionLine.findFirst({
      where: { tenantId: auth.tenantId, division, effectiveTo: null },
    });
    if (open && open.effectiveFrom >= effectiveFrom) {
      throw ApiError.unprocessable(
        `${division} already has a mapping from ${istDateKey(open.effectiveFrom)}. A new mapping must start after it.`,
      );
    }
    const superseded = open
      ? await tx.invoiceDivisionLine.update({ where: { id: open.id }, data: { effectiveTo: effectiveFrom } })
      : null;

    const row = await tx.invoiceDivisionLine.create({
      data: { tenantId: auth.tenantId, division, lineId: input.lineId, effectiveFrom, createdById },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'invoice_division_line',
      subjectId: row.id,
      after: row as never,
      tx,
    });
    if (superseded) {
      await auditWrite({
        action: 'update',
        subjectType: 'invoice_division_line',
        subjectId: superseded.id,
        before: open as never,
        after: superseded as never,
        tx,
      });
    }
    await emit({
      name: EVENTS.INVOICE_DIVISION_LINE_MAPPED,
      subject: { entityType: 'invoice_division_line', entityId: row.id },
      newState: { division, lineId: input.lineId, effectiveFrom: input.effectiveFrom },
      confidentiality: 'confidential',
      impact: { domains: ['fin'] },
      tx,
    });
    return row;
  });
}

function dayOf(key: string): Date {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== key) {
    throw ApiError.badRequest(`"${key}" is not a calendar day (YYYY-MM-DD).`);
  }
  return day;
}
