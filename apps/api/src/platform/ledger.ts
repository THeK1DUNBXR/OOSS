import { EVENTS, formatRecordCode, istFinancialYear } from '@kaizen/shared';
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
  amountMinor: bigint;
  currency?: string;
  division?: string;
  costCentreId?: string;
  projectId?: string;
  partyId?: string;
  taxCodeId?: string;
  memo?: string;
}

export interface PostInput {
  entityId: string;
  entryDate: Date;
  narration: string;
  sourceType: SourceType;
  sourceId?: string;
  idempotencyKey: string;
  lines: JournalLineInput[];
  reversalOfId?: string;
}

function accountTypeFor(account: { accountClass: string; ledgerGroup: string }): string {
  return account.accountClass || account.ledgerGroup;
}

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

export async function post(input: PostInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });

  if (!input.idempotencyKey.trim()) throw ApiError.badRequest('idempotencyKey is required.');
  if (input.lines.length < 2) throw ApiError.unprocessable('A journal entry requires at least two lines.');

  const total = input.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  if (total !== 0n) {
    throw ApiError.unprocessable(`Journal lines must balance to zero; got ${total.toString()} minor units.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${auth.tenantId}, true)`;
    const existing = await tx.journalEntry.findFirst({
      where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (existing) return { entry: existing, created: false };

    const period = await tx.accountingPeriod.findFirst({
      where: {
        tenantId: auth.tenantId,
        entityId: input.entityId,
        startsOn: { lte: input.entryDate },
        endsOn: { gte: input.entryDate },
      },
    });
    if (!period) throw ApiError.unprocessable('No accounting period covers the journal entry date.');
    if (period.status === 'closed') throw ApiError.unprocessable('The accounting period is closed.');

    const accounts = await tx.ledgerAccount.findMany({
      where: { tenantId: auth.tenantId, id: { in: input.lines.map((line) => line.accountId) }, deletedAt: null },
      select: {
        id: true,
        accountClass: true,
        ledgerGroup: true,
        isPostable: true,
        requiresParty: true,
        requiresCostCentre: true,
      },
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const line of input.lines) {
      const account = byId.get(line.accountId);
      if (!account) throw ApiError.notFound('Ledger account');
      if (!account.isPostable) throw ApiError.unprocessable('Control accounts cannot receive journal lines.');
      if (account.requiresParty && !line.partyId) throw ApiError.unprocessable('This account requires a party dimension.');
      if (account.requiresCostCentre && !line.costCentreId) {
        throw ApiError.unprocessable('This account requires a cost-centre dimension.');
      }
      if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(accountTypeFor(account))) {
        throw ApiError.unprocessable(`Ledger account ${line.accountId} has no chart-of-accounts class.`);
      }
    }

    if (input.reversalOfId) {
      const original = await tx.journalEntry.findFirst({
        where: { tenantId: auth.tenantId, id: input.reversalOfId },
        select: { id: true, status: true, reversedById: true },
      });
      if (!original) throw ApiError.notFound('Journal entry to reverse');
      if (original.status === 'reversed' || original.reversedById) {
        throw ApiError.conflict('A journal entry can only be reversed once.');
      }
    }

    const created = await tx.journalEntry.create({
      data: {
        tenantId: auth.tenantId,
        entityId: input.entityId,
        periodId: period.id,
        entryNumber: await allocateEntryNumber(tx, auth.tenantId, input.entryDate),
        entryDate: input.entryDate,
        postedAt: new Date(),
        status: 'posted',
        narration: input.narration,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        reversalOfId: input.reversalOfId ?? null,
        idempotencyKey: input.idempotencyKey,
        lines: {
          create: input.lines.map((line, index) => ({
            tenantId: auth.tenantId,
            lineNo: index + 1,
            accountId: line.accountId,
            amountMinor: line.amountMinor,
            baseAmountMinor: line.amountMinor,
            currency: line.currency ?? 'INR',
            division: line.division ?? null,
            costCentreId: line.costCentreId ?? null,
            projectId: line.projectId ?? null,
            partyId: line.partyId ?? null,
            taxCodeId: line.taxCodeId ?? null,
            memo: line.memo ?? null,
          })),
        },
      },
    });

    const createdWithLines = await tx.journalEntry.findUnique({
      where: { id: created.id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });

    if (input.reversalOfId) {
      await tx.journalEntry.update({
        where: { id: input.reversalOfId },
        data: { status: 'reversed', reversedById: created.id },
      });
    }
    return { entry: createdWithLines ?? created, created: true };
  });

  if (result.created) {
    await auditWrite({
      action: 'create',
      subjectType: 'journal_entry',
      subjectId: result.entry.id,
      after: { entryNumber: result.entry.entryNumber, sourceType: result.entry.sourceType, lineCount: input.lines.length },
    });
    await emit({
      name: EVENTS.JOURNAL_POSTED,
      subject: { entityType: 'journal_entry', entityId: result.entry.id, recordCode: result.entry.entryNumber },
      newState: { status: result.entry.status, sourceType: result.entry.sourceType, lineCount: input.lines.length },
    });
  }
  return result.entry;
}

export async function reverse(entryId: string, reason: string) {
  const auth = currentAuth();
  const original = await prisma.journalEntry.findFirst({
    where: { tenantId: auth.tenantId, id: entryId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  if (!original) throw ApiError.notFound('Journal entry');
  if (original.status === 'reversed' || original.reversalOfId) {
    throw ApiError.conflict('A reversal cannot be reversed.');
  }
  if (!reason.trim()) throw ApiError.badRequest('A reversal reason is required.');

  const reversal = await post({
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
      currency: line.currency,
      division: line.division ?? undefined,
      costCentreId: line.costCentreId ?? undefined,
      projectId: line.projectId ?? undefined,
      partyId: line.partyId ?? undefined,
      taxCodeId: line.taxCodeId ?? undefined,
      memo: line.memo ?? undefined,
    })),
  });
  await auditWrite({
    action: 'update',
    subjectType: 'journal_entry',
    subjectId: original.id,
    before: { status: original.status, reversedById: original.reversedById },
    after: { status: 'reversed', reversedById: reversal.id },
  });
  await emit({
    name: EVENTS.JOURNAL_REVERSED,
    subject: { entityType: 'journal_entry', entityId: original.id, recordCode: original.entryNumber },
    related: [{ relation: 'reversed_by', entityType: 'journal_entry', entityId: reversal.id }],
    reason: { reasonCode: 'correction', note: reason },
  });
  return reversal;
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
