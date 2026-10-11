import { EVENTS, formatMinor, formatRecordCode, istFinancialYear, istMonthKey } from '@kaizen/shared';
import { Prisma } from '@prisma/client';
import { prisma, type DbTx } from './db.js';
import { currentAuth } from './context.js';
import { assertCan } from './permissions.js';
import { auditWrite } from './audit.js';
import { emit } from './eventBus.js';
import { ApiError } from './errors.js';

export type SourceType =
  | 'invoice'
  | 'receipt'
  | 'payment'
  | 'payroll_run'
  | 'depreciation'
  | 'import'
  | 'manual'
  | 'opening_balance'
  | 'fx_revaluation'
  | 'accrual'
  | 'reversal';

export interface JournalLineInput {
  accountId: string;
  /** Signed paise, debit positive. A plain number is refused at runtime: money is bigint (CLAUDE.md rule 1). */
  amountMinor: bigint;
  currency?: string;
  /** The business line a P&L line is earned or spent under. Required on income and expense accounts. */
  lineId?: string;
  division?: string;
  costCentreId?: string;
  projectId?: string;
  partyId?: string;
  taxCodeId?: string;
  memo?: string;
}

export interface PostInput {
  entityId: string;
  /** An IST calendar day stored as UTC midnight (time.ts; CLAUDE.md rule 3). */
  entryDate: Date;
  narration: string;
  sourceType: SourceType;
  sourceId?: string;
  idempotencyKey: string;
  lines: JournalLineInput[];
  reversalOfId?: string;
}

/** Periods that take postings. `closing` is refused: its snapshot must not move under it. */
const POSTABLE_PERIOD_STATUSES = ['open', 'reopened'];

const ENTRY_INCLUDE = { lines: { orderBy: { lineNo: 'asc' } } } as const;

async function allocateEntryNumber(tx: DbTx, tenantId: string, entryDate: Date): Promise<string> {
  const fy = istFinancialYear(entryDate);
  const year = Number(fy.slice(2, 6));
  const sequence = await tx.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: 'JRN', year } },
    create: { tenantId, entityType: 'JRN', year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return formatRecordCode('JRN', year, sequence.nextSequence - 1);
}

/**
 * The period for an IST month, read under FOR SHARE. close takes FOR UPDATE on
 * the same row, so a posting and a close cannot both win: the close waits for
 * the posting to commit, and a posting that arrives after the close reads
 * `closed` here. Reading the status without the lock is the window this closes.
 */
async function lockPostablePeriod(tx: DbTx, tenantId: string, entryDate: Date): Promise<{ id: string }> {
  const month = istMonthKey(entryDate);
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "cmp_accounting_periods"
    WHERE "tenantId" = ${tenantId} AND "period" = ${month}
    FOR SHARE`;
  const period = rows[0];
  if (!period) throw ApiError.unprocessable(`No accounting period is open for ${month}.`);
  if (!POSTABLE_PERIOD_STATUSES.includes(period.status)) {
    const why =
      period.status === 'closing'
        ? `${month} is being closed and takes no postings until the close completes or is reopened.`
        : `The accounting period ${month} is ${period.status}.`;
    throw ApiError.unprocessable(why);
  }
  return { id: period.id };
}

/**
 * A unique-constraint refusal. Prisma does not always name the constraint on
 * this path (meta.target is absent inside an interactive transaction), so the
 * caller checks the idempotency key itself rather than trusting the target.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** The reversal link for an entry, either direction. Status is derived from it: posted entries are never UPDATEd. */
export async function reversalLinkFor(entryId: string, tenantId: string) {
  return prisma.journalReversal.findFirst({
    where: { tenantId, OR: [{ reversedEntryId: entryId }, { reversalEntryId: entryId }] },
  });
}

function validatePostInput(input: PostInput): bigint {
  if (!input.idempotencyKey.trim()) throw ApiError.badRequest('idempotencyKey is required.');
  if (input.lines.length < 2) throw ApiError.unprocessable('A journal entry requires at least two lines.');
  if (input.entryDate.getTime() % 86_400_000 !== 0) {
    throw ApiError.badRequest('entryDate must be an IST calendar day stored as UTC midnight (time.ts).');
  }
  let total = 0n;
  for (const line of input.lines) {
    if (typeof line.amountMinor !== 'bigint') {
      throw ApiError.badRequest('Journal line amounts are bigint paise; a JavaScript number is refused.');
    }
    if (line.currency && line.currency !== 'INR') {
      throw ApiError.unprocessable('Only INR lines are posted until the foreign-amount pair lands (decision 17).');
    }
    total += line.amountMinor;
  }
  if (total !== 0n) {
    throw ApiError.unprocessable(`Journal lines must balance to zero; they are out by ₹${formatMinor(total)}.`);
  }
  return total;
}

/**
 * Writes one entry inside the caller's transaction, in the order CLAUDE.md
 * rule 5 names: the rows, then the audit record, then the event. A reversal
 * also writes its link row and the original's audit line, in the same unit.
 */
async function writeEntry(tx: DbTx, input: PostInput, tenantId: string, partyId: string | null) {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

  const existing = await tx.journalEntry.findFirst({
    where: { tenantId, idempotencyKey: input.idempotencyKey },
    include: ENTRY_INCLUDE,
  });
  if (existing) return { entry: existing, created: false };

  const entity = await tx.ledgerEntity.findFirst({ where: { tenantId, id: input.entityId }, select: { id: true } });
  if (!entity) throw ApiError.notFound('Ledger entity');
  const period = await lockPostablePeriod(tx, tenantId, input.entryDate);

  const accounts = await tx.ledgerAccount.findMany({
    where: { tenantId, id: { in: input.lines.map((line) => line.accountId) }, deletedAt: null },
    select: {
      id: true,
      accountClass: true,
      active: true,
      isPostable: true,
      requiresParty: true,
      requiresCostCentre: true,
    },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const line of input.lines) {
    const account = byId.get(line.accountId);
    if (!account) throw ApiError.notFound('Ledger account');
    if (!account.active) throw ApiError.unprocessable('A retired ledger account cannot receive journal lines.');
    if (!account.isPostable) throw ApiError.unprocessable('Control accounts cannot receive journal lines.');
    if (account.requiresParty && !line.partyId)
      throw ApiError.unprocessable('This account requires a party dimension.');
    if (account.requiresCostCentre && !line.costCentreId) {
      throw ApiError.unprocessable('This account requires a cost-centre dimension.');
    }
    const isPnl = account.accountClass === 'income' || account.accountClass === 'expense';
    if (isPnl && !line.lineId) {
      throw ApiError.unprocessable('An income or expense line needs its business line (lineId).');
    }
  }

  const lineIds = [...new Set(input.lines.map((line) => line.lineId).filter((id): id is string => !!id))];
  if (lineIds.length > 0) {
    const found = await tx.businessLine.findMany({ where: { tenantId, id: { in: lineIds } }, select: { id: true } });
    if (found.length !== lineIds.length) {
      throw ApiError.unprocessable('A business line on this entry is not in the tenant registry.');
    }
  }

  if (input.reversalOfId) {
    if (input.sourceType !== 'reversal') {
      throw ApiError.unprocessable('A reversal must carry the reversal source type.');
    }
    const original = await tx.journalEntry.findFirst({
      where: { tenantId, id: input.reversalOfId },
      select: { id: true, sourceType: true },
    });
    if (!original) throw ApiError.notFound('Journal entry to reverse');
    if (original.sourceType === 'reversal') throw ApiError.conflict('A reversal cannot be reversed.');
    const link = await tx.journalReversal.findFirst({
      where: { tenantId, reversedEntryId: original.id },
      select: { id: true },
    });
    if (link) throw ApiError.conflict('A journal entry can only be reversed once.');
  }

  const created = await tx.journalEntry.create({
    data: {
      tenantId,
      entityId: input.entityId,
      periodId: period.id,
      entryNumber: await allocateEntryNumber(tx, tenantId, input.entryDate),
      entryDate: input.entryDate,
      postedAt: new Date(),
      status: 'posted',
      narration: input.narration,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await tx.journalLine.createMany({
    data: input.lines.map((line, index) => ({
      tenantId,
      entryId: created.id,
      lineNo: index + 1,
      accountId: line.accountId,
      amountMinor: line.amountMinor,
      baseAmountMinor: line.amountMinor,
      currency: 'INR',
      lineId: line.lineId ?? null,
      division: line.division ?? null,
      costCentreId: line.costCentreId ?? null,
      projectId: line.projectId ?? null,
      partyId: line.partyId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      memo: line.memo ?? null,
    })),
  });
  if (input.reversalOfId) {
    await tx.journalReversal.create({
      data: {
        tenantId,
        reversedEntryId: input.reversalOfId,
        reversalEntryId: created.id,
        reason: input.narration,
        createdById: partyId,
      },
    });
  }

  const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: created.id }, include: ENTRY_INCLUDE });

  await auditWrite({
    action: 'create',
    subjectType: 'journal_entry',
    subjectId: entry.id,
    after: { entryNumber: entry.entryNumber, sourceType: entry.sourceType, lineCount: input.lines.length },
    tx,
  });
  await emit({
    name: EVENTS.JOURNAL_POSTED,
    subject: { entityType: 'journal_entry', entityId: entry.id, recordCode: entry.entryNumber },
    newState: { status: entry.status, sourceType: entry.sourceType, lineCount: input.lines.length },
    tx,
  });
  if (input.reversalOfId) {
    await auditWrite({
      action: 'update',
      subjectType: 'journal_entry',
      subjectId: input.reversalOfId,
      after: { reversedById: entry.id },
      tx,
    });
    await emit({
      name: EVENTS.JOURNAL_REVERSED,
      subject: { entityType: 'journal_entry', entityId: input.reversalOfId },
      related: [{ relation: 'reversed_by', entityType: 'journal_entry', entityId: entry.id }],
      reason: { reasonCode: 'correction', note: input.narration },
      tx,
    });
  }
  return { entry, created: true };
}

/**
 * The only writer of journal_entries and journal_lines (CLAUDE.md rule 2; the
 * ESLint rule in eslint.config.js enforces it). When a concurrent caller with
 * the same key commits first, the unique index refuses this insert; the entry
 * that caller wrote is returned, so both callers get one entry and no second
 * row. The lookup is what decides it: a refusal with no entry under the key is
 * rethrown, never swallowed.
 */
export async function post(input: PostInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });
  validatePostInput(input);

  try {
    const result = await prisma.$transaction((tx) => writeEntry(tx, input, auth.tenantId, auth.partyId));
    return result.entry;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.journalEntry.findFirst({
        where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
        include: ENTRY_INCLUDE,
      });
      if (existing) return existing;
    }
    throw err;
  }
}

export async function reverse(entryId: string, reason: string) {
  const auth = currentAuth();
  const original = await prisma.journalEntry.findFirst({
    where: { tenantId: auth.tenantId, id: entryId },
    include: ENTRY_INCLUDE,
  });
  if (!original) throw ApiError.notFound('Journal entry');
  if (original.sourceType === 'reversal') throw ApiError.conflict('A reversal cannot be reversed.');
  if (!reason.trim()) throw ApiError.badRequest('A reversal reason is required.');
  const link = await reversalLinkFor(original.id, auth.tenantId);
  if (link) {
    throw ApiError.conflict(
      link.reversedEntryId === original.id
        ? 'A journal entry can only be reversed once.'
        : 'A reversal cannot be reversed.',
    );
  }

  return post({
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
}

export async function balanceOf(
  accountId: string,
  asOf: Date,
  dimensions: { division?: string; partyId?: string; costCentreId?: string } = {},
): Promise<bigint> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });
  const result = await prisma.journalLine.aggregate({
    where: {
      tenantId: auth.tenantId,
      accountId,
      entry: { entryDate: { lte: asOf }, status: { in: ['posted', 'reversed'] } },
      ...(dimensions.division ? { division: dimensions.division } : {}),
      ...(dimensions.partyId ? { partyId: dimensions.partyId } : {}),
      ...(dimensions.costCentreId ? { costCentreId: dimensions.costCentreId } : {}),
    },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}
