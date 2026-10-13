import {
  EVENTS,
  formatMinor,
  formatRecordCode,
  istCivilDay,
  istFinancialYear,
  istMonthKey,
  JOURNAL_SOURCE_TYPES,
} from '@kaizen/shared';
import { Prisma } from '@prisma/client';
import { prisma, type DbTx } from './db.js';
import { currentAuth } from './context.js';
import { assertCan, assertScopeAll } from './permissions.js';
import { auditWrite } from './audit.js';
import { emit } from './eventBus.js';
import { ApiError } from './errors.js';

/** The vocabulary lives in shared postingRules.ts so both tiers name the same sources. */
export type SourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

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

/**
 * Periods that take postings. `closing` is refused: its snapshot must not move under it.
 * Exported so the legacy cashbook's period veto (domains/compliance/books.ts) applies
 * the same rule; a second copy of this list let a write into a closing month through.
 */
export const POSTABLE_PERIOD_STATUSES: readonly string[] = ['open', 'reopened'];

const ENTRY_INCLUDE = { lines: { orderBy: { lineNo: 'asc' } } } as const;

/**
 * The next journal entry number for one legal entity in one financial year.
 *
 * Numbers are gapless per entity per year (JournalEntry is unique on
 * entityId + entryNumber, so a tenant-wide series left a gap in each entity's
 * list). The sequence is keyed by entity with no schema change: the entity id
 * rides in RecordSequence.entityType as `JRN:<entityId>`. That table has no scope
 * column, and adding one would be a migration for this one caller.
 *
 * Numbers issued before this rule came from the tenant-wide 'JRN' series and
 * are not contiguous per entity. They stay as they are; the gaps in them stay
 * too. A new entity-year row starts after the highest number the entity already
 * holds, so the first post under the new rule cannot collide with one of them.
 */
async function allocateEntryNumber(tx: DbTx, tenantId: string, entityId: string, entryDate: Date): Promise<string> {
  const fy = istFinancialYear(entryDate);
  const year = Number(fy.slice(2, 6));
  const key = { tenantId, entityType: `JRN:${entityId}`, year };

  // The common case: the row exists, and one UPDATE takes the next number. The read
  // only decides whether the create path below needs the highest-number floor.
  const existing = await tx.recordSequence.findUnique({
    where: { tenantId_entityType_year: key },
    select: { nextSequence: true },
  });
  if (existing) {
    const row = await tx.recordSequence.update({
      where: { tenantId_entityType_year: key },
      data: { nextSequence: { increment: 1 } },
      select: { nextSequence: true },
    });
    return formatRecordCode('JRN', year, row.nextSequence - 1);
  }

  // Create-if-missing, as before: two first-of-year posts for one entity race on
  // the unique key, and the second one's upsert takes the update branch on the
  // row the first one wrote. The create value below is only used by the winner.
  // The row stores the next number plus one, so creating it at max + 2 issues max + 1.
  const floor = await highestEntryNumber(tx, tenantId, entityId, year);
  const row = await tx.recordSequence.upsert({
    where: { tenantId_entityType_year: key },
    create: { ...key, nextSequence: floor + 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return formatRecordCode('JRN', year, row.nextSequence - 1);
}

/**
 * The largest sequence number the entity already holds in the year, 0 when none.
 * Read from the entries, one read per entity per year, and only on the first post
 * of that year. A numeric tail that does not parse is skipped: it cannot equal a
 * number this allocator issues, so it cannot collide.
 */
async function highestEntryNumber(tx: DbTx, tenantId: string, entityId: string, year: number): Promise<number> {
  const prefix = `JRN-${year}-`;
  const rows = await tx.journalEntry.findMany({
    where: { tenantId, entityId, entryNumber: { startsWith: prefix } },
    select: { entryNumber: true },
  });
  let highest = 0;
  for (const row of rows) {
    const tail = row.entryNumber.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    highest = Math.max(highest, Number.parseInt(tail, 10));
  }
  return highest;
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
 * Why a line may not name a cost centre. `missing` covers an unknown id and
 * another tenant's centre alike: the lookup is tenant-scoped, so both come back
 * absent, and the composite foreign key refuses the same two cases in the
 * database (journal_line_cost_centre_fk).
 */
export type CostCentreRefusalReason = 'missing' | 'inactive' | 'mismatched';

export class CostCentreRefusedError extends ApiError {
  constructor(
    readonly reason: CostCentreRefusalReason,
    costCentreId: string,
  ) {
    super(422, 'COST_CENTRE_REFUSED', `Cost centre ${costCentreId} cannot take this line (${reason}).`, {
      reason,
      costCentreId,
    });
    this.name = 'CostCentreRefusedError';
  }
}

/**
 * A reversal mirrors the lines it reverses (reverse() copies each one with its
 * amount negated), so a reversal line is accepted for a centre only when the
 * original carries the same account, centre and opposite amount. That is what
 * lets a correction name a centre retired after the original was posted, since
 * a correction must always be possible (CLAUDE.md rule 2), and it stops a
 * reversal from attaching a centre its original never had.
 */
async function assertCostCentres(tx: DbTx, tenantId: string, input: PostInput) {
  const named = input.lines.filter((line): line is JournalLineInput & { costCentreId: string } => !!line.costCentreId);
  if (named.length === 0) return;

  const centres = await tx.costCentre.findMany({
    where: { tenantId, id: { in: [...new Set(named.map((line) => line.costCentreId))] } },
    select: { id: true, deletedAt: true },
  });
  const byId = new Map(centres.map((centre) => [centre.id, centre]));
  const original = input.reversalOfId
    ? await tx.journalLine.findMany({
        where: { tenantId, entryId: input.reversalOfId },
        select: { accountId: true, amountMinor: true, costCentreId: true },
      })
    : [];

  for (const line of named) {
    const centre = byId.get(line.costCentreId);
    if (!centre) throw new CostCentreRefusedError('missing', line.costCentreId);
    const mirrors =
      !!input.reversalOfId &&
      original.some(
        (o) =>
          o.accountId === line.accountId && o.costCentreId === line.costCentreId && o.amountMinor === -line.amountMinor,
      );
    if (centre.deletedAt && !mirrors) throw new CostCentreRefusedError('inactive', line.costCentreId);
    if (input.reversalOfId && !mirrors) throw new CostCentreRefusedError('mismatched', line.costCentreId);
  }
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

  await assertCostCentres(tx, tenantId, input);

  const created = await tx.journalEntry.create({
    data: {
      tenantId,
      entityId: input.entityId,
      periodId: period.id,
      entryNumber: await allocateEntryNumber(tx, tenantId, input.entityId, input.entryDate),
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
  // A journal write carries no record to narrow against, so assertCan alone admits every
  // holder of `transactions:create`, `@own` included. Every caller here is a company-wide
  // write (cashbook drafts, reversals), so it needs all scope. The invoice paths use postInTx,
  // which the invoice's own record guards (invoicing.ts loadForWrite).
  await assertScopeAll('transactions', 'create');
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

/**
 * The same write as post(), inside the caller's transaction (contract FX-70,
 * D1 and O1). The entry commits with its source document or not at all: a
 * fault after this call takes the entry back with the invoice, so neither is
 * left without the other. An outbox consumer could not give that.
 *
 * Lock order (contract D6), so that no two writers wait on each other in a
 * cycle: the source row FOR UPDATE first, then the period FOR SHARE in
 * lockPostablePeriod, then the ledger rows. A close takes only the period, FOR
 * UPDATE, so it never holds a source row and waits on a posting.
 *
 * Callers, in this order:
 *   1. assertScopeAll('transactions', 'create') (postInTx's callers check their own record) before they open
 *      their transaction. Permission evaluation reads through the scoped client,
 *      which refuses inside a transaction (db.ts refuseOuterClientInTransaction),
 *      so this function cannot run the check.
 *   2. The source row FOR UPDATE, then this call. Two posts with one key then
 *      wait on the source row rather than on the unique index. If they race
 *      anyway, the index refuses the second insert and the caller's transaction
 *      aborts with it. Nothing is written twice. Unlike post(), there is no
 *      retry, because a failed statement ends the Postgres transaction it is in.
 *   3. `tx` for every statement, never the outer client.
 */
export async function postInTx(tx: DbTx, input: PostInput) {
  const auth = currentAuth();
  validatePostInput(input);
  const result = await writeEntry(tx, input, auth.tenantId, auth.partyId);
  return result.entry;
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

/**
 * The balance of an account on and before an IST civil day. `asOf` may be an
 * instant: it is read as the IST day it falls on, so 00:10 IST on 1 April
 * includes the entries of 1 April, not those of 31 March (CLAUDE.md rule 3).
 */
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
      entry: { entryDate: { lte: istCivilDay(asOf) }, status: { in: ['posted', 'reversed'] } },
      ...(dimensions.division ? { division: dimensions.division } : {}),
      ...(dimensions.partyId ? { partyId: dimensions.partyId } : {}),
      ...(dimensions.costCentreId ? { costCentreId: dimensions.costCentreId } : {}),
    },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}
