/**
 * Compliance — books and audit (docs/plan/compliance.md, D).
 *
 * The Companies (Accounts) Rules 2014 audit-trail proviso, a GL period close
 * independent of GST's own lock, an 8-year retention sweep, Schedule III's
 * statement format over the company's own chart, Schedule II/Income-tax
 * depreciation side by side, trial balance/GL/Tally exports and bank
 * reconciliation matching.
 *
 * The audit-trail proviso itself (registering the five-plus-two governed
 * entities and calling `auditWrite` on create/update/reverse/pay) lives in
 * `domains/books.ts`, which this workstream also owns — this file is
 * everything else.
 */

import { istDateKey, istFinancialYearStart } from '@kaizen/shared';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  EVENTS,
  round2,
  monthKey,
  financialYearOf,
  financialYearRange,
  monthRange,
  isTrading,
  defaultScheduleIIIHeadForCategory,
  defaultScheduleIIIHeadForLedgerGroup,
  companiesActAnnualCharge,
  incomeTaxWdvCharge,
  retentionDueDate,
  isLikelyMatch,
  toCsv,
  type ScheduleIIIStatement,
} from '@kaizen/shared';
import { prisma, num, type DbTx } from '../../platform/db.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { journalTrialBalance } from '../../platform/balances.js';
import { POSTABLE_PERIOD_STATUSES } from '../../platform/ledger.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, canSeeMoney } from '../../platform/permissions.js';
import { auditWrite, auditExport, verifyAuditChain, chainUnhashedAuditRecords } from '../../platform/audit.js';
import { registerHook } from '../../platform/hooks.js';
import { registerGovernedEntities } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { raiseException } from '../../platform/exceptions.js';

export { verifyAuditChain };

// The subjects this module writes that no other module registers. Registered here, at
// load, so auditWrite accepts them before any of the writes below runs.
registerGovernedEntities('cmp_books', ['retention_review', 'bank_statement_line']);

// ---------------------------------------------------------------------------
// Accounting periods
// ---------------------------------------------------------------------------

function periodKeyOf(d: Date): string {
  return monthKey(d);
}

function fyOf(d: Date): string {
  return financialYearOf(d);
}

/** The finance_head who is not the given party — the second party a two-step approval needs. */
async function otherFinanceHead(excludePartyId: string | null): Promise<string | null> {
  const auth = currentAuth();
  const row = await prisma.affiliation.findFirst({
    where: {
      tenantId: auth.tenantId,
      roleSlug: { in: ['finance_head', 'chairman'] },
      status: 'active',
      ...(excludePartyId ? { partyId: { not: excludePartyId } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  return row?.partyId ?? null;
}

export async function listPeriods(fy?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'view' });
  return prisma.accountingPeriod.findMany({
    where: { tenantId: auth.tenantId, ...(fy ? { fy } : {}) },
    orderBy: { period: 'desc' },
  });
}

async function ensurePeriod(period: string): Promise<{ id: string; status: string; requestedById: string | null }> {
  const auth = currentAuth();
  const [year, month] = period.split('-').map(Number);
  const existing = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  if (existing) return existing;
  // A legacy write into the same month can create the row between the read above and
  // this insert (platform/periodLock.ts). A plain create would then fail on the unique
  // key, so the insert skips a duplicate and the row is read back.
  const made = await prisma.accountingPeriod.createMany({
    data: [{ tenantId: auth.tenantId, period, fy: fyOf(new Date(Date.UTC(year, month - 1, 1))), status: 'open' }],
    skipDuplicates: true,
  });
  const created = await prisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: auth.tenantId, period } });
  if (made.count === 0) return created;
  // Opening a period is itself a books write: it is the row a close is later
  // requested against, so its creation is a fact the chain should carry.
  await emit({
    name: EVENTS.ACCOUNTING_PERIOD_OPENED,
    subject: { entityType: 'accounting_period', entityId: created.id },
    newState: { period, status: 'open' },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });
  await auditWrite({
    action: 'create',
    subjectType: 'accounting_period',
    subjectId: created.id,
    after: { period, status: 'open' },
  });
  return created;
}

/** Whether `date`'s month is closed to new or edited entries. Read by the write-path hook below. */
export async function periodStatus(date: Date): Promise<string> {
  const auth = currentAuth();
  const period = periodKeyOf(date);
  const row = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  if (row) return row.status;
  // A month with no row under a closed later month is closed, not open: the order rule
  // closes every earlier month first, and a row created here later would sit beneath a
  // closed month (platform/periodLock.ts holdPeriodRow refuses to make it).
  const laterClosed = await prisma.accountingPeriod.findFirst({
    where: { tenantId: auth.tenantId, period: { gt: period }, status: 'closed' },
    select: { id: true },
  });
  return laterClosed ? 'closed' : 'open';
}

/**
 * Whether `date`'s month takes no entries: closing or closed. The same rule the
 * ledger applies (POSTABLE_PERIOD_STATUSES), so a legacy write and a journal
 * posting refuse the same months. Money that has already moved is booked on the
 * next open date instead of being refused (openAccountingDate).
 */
export async function periodRefusesEntries(date: Date): Promise<boolean> {
  return !POSTABLE_PERIOD_STATUSES.includes(await periodStatus(date));
}

/**
 * The first instant, from `now` onwards, that falls in an open accounting period.
 * `now` itself when its month is open; otherwise the IST start of the next month
 * that is open. Used only for money that has already arrived.
 */
export async function openAccountingDate(now: Date): Promise<Date> {
  let date = now;
  for (let i = 0; i < 24; i++) {
    if (!(await periodRefusesEntries(date))) return date;
    date = monthRange(monthKey(date)).to;
  }
  throw ApiError.unprocessable('No open accounting period in the next two years to record this payment in.');
}

/**
 * The order rule (owner decision, 2026-10-12). A closed month's snapshot is cumulative:
 * a posting that lands in an open earlier month later changes figures that were frozen,
 * and the nightly check raises EX-LED-001 on them. So a month closes only after every
 * earlier month of the tenant is closed, and reopens only while no later month is closed
 * or closing.
 */
async function earlierPeriodsNotClosed(tenantId: string, period: string) {
  return prisma.accountingPeriod.findMany({
    where: { tenantId, period: { lt: period }, status: { not: 'closed' } },
    select: { period: true, status: true },
    orderBy: { period: 'asc' },
  });
}

function refuseEarlierOpen(period: string, blocking: ReadonlyArray<{ period: string; status: string }>): void {
  if (blocking.length === 0) return;
  const [first] = blocking;
  const message =
    blocking.length === 1 && first
      ? `${first.period} is still ${first.status}; close earlier periods first.`
      : `${blocking.map((b) => b.period).join(', ')} are still not closed; close earlier periods first.`;
  throw ApiError.unprocessable(message, {
    period,
    blockingPeriods: blocking,
    reasonCode: 'accounting_period_out_of_order',
  });
}

function refuseLaterClosed(period: string, blocking: ReadonlyArray<{ period: string; status: string }>): void {
  if (blocking.length === 0) return;
  const [first] = blocking;
  const message =
    blocking.length === 1 && first
      ? `${first.period} is still ${first.status}; reopen later periods first, latest first.`
      : `${blocking.map((b) => b.period).join(', ')} are still closed or closing; reopen later periods first, latest first.`;
  throw ApiError.unprocessable(message, {
    period,
    blockingPeriods: blocking,
    reasonCode: 'accounting_period_out_of_order',
  });
}

/** Step one of the two-party close: any accounting_periods `edit` holder asks for a period to be closed. */
export async function requestClosePeriod(period: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'edit' });
  const row = await ensurePeriod(period);
  if (row.status !== 'open' && row.status !== 'reopened') {
    throw ApiError.unprocessable(`${period} is ${row.status}, not open — nothing to request closing.`);
  }
  // Refused here as well as at approval, so the proposer learns it before an approver
  // is asked. closePeriod checks again under the period locks; this check is only advice.
  refuseEarlierOpen(period, await earlierPeriodsNotClosed(auth.tenantId, period));
  const updated = await prisma.accountingPeriod.update({
    where: { id: row.id },
    data: { status: 'closing', requestedById: auth.partyId, requestedAt: new Date() },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'accounting_period',
    subjectId: row.id,
    before: { status: row.status },
    after: { status: 'closing', requestedById: auth.partyId },
  });
  await emit({
    name: EVENTS.ACCOUNTING_PERIOD_CLOSE_REQUESTED,
    subject: { entityType: 'accounting_period', entityId: row.id },
    newState: { period, status: 'closing' },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });
  return updated;
}

/**
 * Step two: a different finance_head/chairman approves. The proposer never
 * approves — the same rule the self-dealing bar runs on MoUs and contracts.
 */
export async function closePeriod(period: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'approve' });
  const row = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  if (!row) throw ApiError.notFound('Accounting period');
  if (row.status !== 'closing') {
    throw ApiError.unprocessable(`${period} has not been requested for close — request-close it first.`);
  }
  if (row.requestedById && row.requestedById === auth.partyId) {
    throw ApiError.forbidden(
      `${auth.roleSlug} requested this close and cannot also approve it — a second finance_head or the chairman closes it.`,
      [{ axis: 'WHO', passed: false, reason: 'accounting_period_self_approval' }],
    );
  }

  // The lock comes first, and the snapshot is taken under it. The old order took
  // the snapshot before the lock, so a legacy cashbook entry that committed between
  // the two landed in the closed period and was missing from its snapshot: the
  // closed figures disagreed with the books they were meant to freeze.
  //
  // What closes that window: the period is `closing` before this runs, so a legacy
  // write that checks the status now is refused (refuseClosedPeriod). A posting and
  // a legacy write each hold FOR SHARE on this row while they write
  // (platform/ledger.ts lockPostablePeriod, platform/periodLock.ts lockLegacyPeriod),
  // so this FOR UPDATE waits for them to commit first. Before the legacy lock, a write
  // whose status check passed before the close was requested could commit after the
  // figures were taken, and would then be missing from the snapshot.
  //
  // Both figures are taken: the legacy cashbook TB (it reads `Transaction`) and the
  // journal TB (it reads the ledger), so the closed period carries both and the gap
  // between them is visible (contract section 8, O11 a). The legacy TB keeps the
  // top-level shape closed periods already store (asOf, rows, totals), with the
  // journal figure beside it. Periods closed before this has no `journal` key.
  // Money is kept as decimal strings: JSON cannot hold a bigint.
  //
  // One transaction, governedWrite: the status change, the snapshot, the audit row
  // and the event commit together. A failure in any of them leaves the period
  // `closing`, not half-closed.
  // The last instant of the IST month. Taking Date.UTC(y, m, 1) - 1ms here
  // (23:59:59.999 UTC on the last day, i.e. 05:29 IST on the 1st) put the
  // first five and a half hours of the next month into the closed snapshot.
  const { to } = monthRange(period);
  const asOf = new Date(to.getTime() - 1);
  const updated = await governedWrite(async (tx) => {
    // Every row of the tenant up to this month, locked in ascending month order, so
    // the order rule is checked on rows no other transaction can change under it. A
    // reopen of an earlier month locks from its own month upward, in the same order,
    // so the two cannot wait on each other in a cycle.
    const rows = await tx.$queryRaw<Array<{ period: string; status: string }>>`
      SELECT "period", "status" FROM "cmp_accounting_periods"
      WHERE "tenantId" = ${auth.tenantId} AND "period" <= ${period}
      ORDER BY "period"
      FOR UPDATE`;
    const locked = rows.find((r) => r.period === period);
    if (locked?.status !== 'closing') {
      throw ApiError.unprocessable(`${period} changed while this close waited; it is no longer closing.`);
    }
    refuseEarlierOpen(
      period,
      rows.filter((r) => r.period < period && r.status !== 'closed'),
    );
    const legacy = await trialBalance(asOf, tx);
    const journal = await journalTrialBalance(asOf, tx);
    const snapshot = {
      ...legacy,
      journal: {
        asOf: journal.asOf,
        debitsMinor: journal.debitsMinor.toString(),
        creditsMinor: journal.creditsMinor.toString(),
        lineCount: journal.lineCount,
      },
    };
    const closed = await tx.accountingPeriod.update({
      where: { id: row.id },
      data: { status: 'closed', closedById: auth.partyId, closedAt: new Date(), snapshot: snapshot as never },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'accounting_period',
      subjectId: row.id,
      before: { status: 'closing' },
      after: { status: 'closed', closedById: auth.partyId },
      tx,
    });
    await emit({
      name: EVENTS.ACCOUNTING_PERIOD_CLOSED,
      subject: { entityType: 'accounting_period', entityId: row.id },
      newState: { period, status: 'closed' },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
    return closed;
  });
  return updated;
}

export async function reopenPeriod(period: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'approve' });
  if (!reason?.trim()) throw ApiError.badRequest('Reopening a closed period needs a reason.');
  const row = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  if (!row) throw ApiError.notFound('Accounting period');
  if (row.status !== 'closed') throw ApiError.unprocessable(`${period} is ${row.status}, not closed.`);

  // The check and the update run under the period locks, from this month upward in
  // ascending order: the order closePeriod takes its locks in. Without the lock, a
  // close of a later month could commit between this check and the update, and the
  // reopened month would sit under a closed one.
  const updated = await governedWrite(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ period: string; status: string }>>`
      SELECT "period", "status" FROM "cmp_accounting_periods"
      WHERE "tenantId" = ${auth.tenantId} AND "period" >= ${period}
      ORDER BY "period"
      FOR UPDATE`;
    const locked = rows.find((r) => r.period === period);
    if (locked?.status !== 'closed') {
      throw ApiError.unprocessable(
        `${period} changed while this reopen waited; it is ${locked?.status ?? 'missing'}, not closed.`,
      );
    }
    refuseLaterClosed(
      period,
      rows.filter((r) => r.period > period && (r.status === 'closed' || r.status === 'closing')),
    );
    return tx.accountingPeriod.update({
      where: { id: row.id },
      data: { status: 'reopened', reopenedById: auth.partyId, reopenedAt: new Date(), reopenReason: reason },
    });
  });
  await auditWrite({
    action: 'update',
    subjectType: 'accounting_period',
    subjectId: row.id,
    before: { status: 'closed' },
    after: { status: 'reopened', reopenReason: reason },
  });
  await emit({
    name: EVENTS.ACCOUNTING_PERIOD_REOPENED,
    subject: { entityType: 'accounting_period', entityId: row.id },
    newState: { status: 'reopened' },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });
  return updated;
}

/**
 * The write-path veto (CMP-AUD-003): a dated write inside a closed accounting
 * period is refused, independent of GST's own filing-based lock. The period is
 * the IST civil month of the date (`monthKey`), so 00:30 IST on the 1st belongs
 * to the new month even though it is still the last day of the old one in UTC.
 *
 * Registered under two hook points so every dated write in the books, and the
 * invoice and receipt writes that move the same figures, is vetoed the same way.
 * `reverseTransaction` stamps `new Date()` on its reversal, so it is refused
 * when today's month is closed and never backdates into a closed one.
 */
async function refuseClosedPeriod(date: Date, what: string): Promise<void> {
  // `closing` is refused as `closed` is. A close that has been requested takes its
  // snapshot under the period lock; a legacy write allowed in that state could land
  // after the figures were taken and be missing from the closed period. That is the
  // defect this guards: a write in a closed period that is not in its snapshot.
  const status = await periodStatus(date);
  if (!POSTABLE_PERIOD_STATUSES.includes(status)) {
    const period = periodKeyOf(date);
    throw ApiError.unprocessable(
      status === 'closing'
        ? `${what} is dated ${period}, which is a closing accounting period: its close has been requested and not yet approved. It takes no entries until the close completes.`
        : `${what} is dated ${period}, which is a closed accounting period. Reopen it first, with a reason, before recording or editing anything dated inside it.`,
      { period, status, reasonCode: 'accounting_period_closed' },
    );
  }
}

registerHook('transaction.before_record', 'compliance.books.period_lock', async (payload) => {
  await refuseClosedPeriod(payload.txnDate as Date, 'This entry');
});
registerHook('accounting_document.before_write', 'compliance.books.period_lock', async (payload) => {
  await refuseClosedPeriod(payload.date as Date, payload.what as string);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const RETENTION_ENTITIES: Array<{
  entityType: string;
  model: 'transaction' | 'vendorBill' | 'fixedAsset' | 'loan' | 'auditRecord' | 'eventRecord';
  dateField: string;
}> = [
  { entityType: 'transaction', model: 'transaction', dateField: 'txnDate' },
  { entityType: 'vendor_bill', model: 'vendorBill', dateField: 'billDate' },
  { entityType: 'fixed_asset', model: 'fixedAsset', dateField: 'purchaseDate' },
  { entityType: 'loan', model: 'loan', dateField: 'startDate' },
  { entityType: 'audit_record', model: 'auditRecord', dateField: 'timestamp' },
  { entityType: 'event_record', model: 'eventRecord', dateField: 'occurredAt' },
];

/**
 * The monthly retention sweep. Flags, never deletes: a record past its floor
 * goes onto the review list, and a person decides what happens to it.
 */
export async function sweepRetention(): Promise<number> {
  const auth = currentAuth();
  const policies = await prisma.retentionPolicy.findMany({ where: { tenantId: auth.tenantId } });
  const byType = new Map(policies.map((p) => [p.entityType, p]));

  let flagged = 0;
  for (const spec of RETENTION_ENTITIES) {
    const policy = byType.get(spec.entityType);
    if (!policy) continue;
    const cutoff = retentionDueDate(new Date(), -policy.years);

    const rows = await (
      prisma[spec.model] as { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> }
    ).findMany({
      where: { tenantId: auth.tenantId, [spec.dateField]: { lt: cutoff } },
      select: { id: true, [spec.dateField]: true },
      take: 500,
    });

    for (const row of rows) {
      const recordDate = row[spec.dateField] as Date;
      const existing = await prisma.retentionReview.findFirst({
        where: { tenantId: auth.tenantId, entityType: spec.entityType, entityId: row.id as string },
      });
      if (existing) continue;
      const review = await prisma.retentionReview.create({
        data: {
          tenantId: auth.tenantId,
          entityType: spec.entityType,
          entityId: row.id as string,
          recordDate,
          dueAt: retentionDueDate(recordDate, policy.years),
          status: 'flagged',
        },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'retention_review',
        subjectId: review.id,
        after: { entityType: spec.entityType, entityId: row.id as string, status: 'flagged' },
      });
      await emit({
        name: EVENTS.RETENTION_REVIEW_RECORDED,
        subject: { entityType: 'retention_review', entityId: review.id },
        newState: { entityType: spec.entityType, entityId: row.id as string, status: 'flagged' },
        impact: { domains: ['fin'] },
      });
      flagged += 1;
    }
  }

  if (flagged > 0) {
    const financeHead = await otherFinanceHead(null);
    await raiseException({
      code: 'CMP_RETENTION_REVIEW',
      label: 'Records past their retention floor',
      severity: 'S1_ATTENTION',
      subjectType: 'retention_sweep',
      subjectId: monthKey(new Date()),
      domain: 'fin',
      detail: `${flagged} record(s) newly flagged past their statutory retention floor. Review before any deletion or erasure request.`,
      ownerPartyId: financeHead,
      triggerFingerprint: `retention_sweep:${monthKey(new Date())}`,
      ladderRung: 1,
    });
  }

  return flagged;
}

export async function retentionReport() {
  const auth = currentAuth();
  await assertCan({ resource: 'audit', verb: 'view' });
  const [policies, flagged] = await Promise.all([
    prisma.retentionPolicy.findMany({ where: { tenantId: auth.tenantId }, orderBy: { entityType: 'asc' } }),
    prisma.retentionReview.findMany({
      where: { tenantId: auth.tenantId, status: 'flagged' },
      orderBy: { dueAt: 'asc' },
      take: 500,
    }),
  ]);
  const byType = new Map<string, number>();
  for (const r of flagged) byType.set(r.entityType, (byType.get(r.entityType) ?? 0) + 1);

  return {
    policies,
    flaggedCount: flagged.length,
    byType: [...byType.entries()].map(([entityType, count]) => ({ entityType, count })),
    flagged: flagged.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      recordDate: r.recordDate.toISOString().slice(0, 10),
      dueAt: r.dueAt.toISOString().slice(0, 10),
      status: r.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Schedule III — the statement format
// ---------------------------------------------------------------------------

interface ScheduleIIIRow {
  head: string;
  amount: number;
}
interface UnmappedRow {
  name: string;
  amount: number;
}

async function resolveCategoryMapping(categoryId: string, kind: string, direction: 'in' | 'out') {
  const auth = currentAuth();
  const explicit = await prisma.scheduleIIIMapping.findFirst({ where: { tenantId: auth.tenantId, categoryId } });
  if (explicit) return { statement: explicit.statement as ScheduleIIIStatement, head: explicit.scheduleHead };
  return defaultScheduleIIIHeadForCategory(kind, direction);
}

async function resolveAccountMapping(accountId: string, ledgerGroup: string) {
  const auth = currentAuth();
  const explicit = await prisma.scheduleIIIMapping.findFirst({ where: { tenantId: auth.tenantId, accountId } });
  if (explicit) return { statement: explicit.statement as ScheduleIIIStatement, head: explicit.scheduleHead };
  return defaultScheduleIIIHeadForLedgerGroup(ledgerGroup);
}

/**
 * The P&L and balance sheet in Schedule III's format, for a financial year.
 * Every category and account with movement in the year lands somewhere:
 * explicit `ScheduleIIIMapping`, the kind/ledgerGroup default, or — if
 * neither resolves anything — the "not yet mapped" bucket. Nothing is
 * dropped.
 */
export async function statementForFy(fyStartYear: number) {
  const auth = currentAuth();
  await assertScopeAll('transactions');
  const { from, to } = financialYearRange(fyStartYear);

  const [categoryRows, categories, accounts] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['categoryId', 'direction'],
      where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { gte: from, lt: to } },
      _sum: { amount: true },
    }),
    prisma.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
    prisma.ledgerAccount.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
  ]);

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const plHeads = new Map<string, number>();
  const plUnmapped = new Map<string, number>();
  let income = 0;
  let expense = 0;

  for (const row of categoryRows) {
    const amount = num(row._sum.amount) ?? 0;
    const category = row.categoryId ? categoryById.get(row.categoryId) : null;
    if (!isTrading(category?.kind)) continue;

    if (row.direction === 'in') income = round2(income + amount);
    else expense = round2(expense + amount);

    const label = category?.name ?? 'Uncategorised';
    if (!category) {
      plUnmapped.set(label, round2((plUnmapped.get(label) ?? 0) + amount));
      continue;
    }
    const mapping = await resolveCategoryMapping(category.id, category.kind, row.direction as 'in' | 'out');
    if (!mapping || mapping.statement !== 'profit_and_loss') {
      plUnmapped.set(label, round2((plUnmapped.get(label) ?? 0) + amount));
      continue;
    }
    plHeads.set(mapping.head, round2((plHeads.get(mapping.head) ?? 0) + amount));
  }

  const balances = await prisma.transaction.groupBy({
    by: ['accountId', 'direction'],
    where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { lt: to } },
    _sum: { amount: true },
  });
  const inflowByAccount = new Map<string, number>();
  const outflowByAccount = new Map<string, number>();
  for (const row of balances) {
    const target = row.direction === 'in' ? inflowByAccount : outflowByAccount;
    target.set(row.accountId, num(row._sum.amount) ?? 0);
  }

  const bsHeads = new Map<string, number>();
  const bsUnmapped = new Map<string, number>();
  for (const account of accounts) {
    const balance = round2(
      (num(account.openingBalance) ?? 0) +
        (inflowByAccount.get(account.id) ?? 0) -
        (outflowByAccount.get(account.id) ?? 0),
    );
    const mapping = await resolveAccountMapping(account.id, account.ledgerGroup);
    if (!mapping || mapping.statement !== 'balance_sheet') {
      bsUnmapped.set(account.name, round2((bsUnmapped.get(account.name) ?? 0) + balance));
      continue;
    }
    bsHeads.set(mapping.head, round2((bsHeads.get(mapping.head) ?? 0) + balance));
  }

  const toRows = (m: Map<string, number>): ScheduleIIIRow[] =>
    [...m.entries()].map(([head, amount]) => ({ head, amount }));
  const toUnmapped = (m: Map<string, number>): UnmappedRow[] =>
    [...m.entries()].map(([name, amount]) => ({ name, amount }));

  return {
    fy: fyOf(from),
    profitAndLoss: {
      heads: toRows(plHeads),
      unmapped: toUnmapped(plUnmapped),
      income,
      expense,
      net: round2(income - expense),
    },
    balanceSheet: {
      heads: toRows(bsHeads),
      unmapped: toUnmapped(bsUnmapped),
      total: round2([...bsHeads.values(), ...bsUnmapped.values()].reduce((s, v) => s + v, 0)),
    },
  };
}

// ---------------------------------------------------------------------------
// Depreciation — Schedule II vs the Income-tax Act block
// ---------------------------------------------------------------------------

/** A rough, deterministic keyword classifier onto the seeded asset classes. Never invented at report time — only used to pick a seeded row. */
export function classifyAssetClass(name: string, categoryName?: string | null): string {
  const s = `${name} ${categoryName ?? ''}`.toLowerCase();
  if (/(laptop|computer|desktop|server|workstation)/.test(s)) return 'computers';
  if (/(software|licen[cs]e|intangible)/.test(s)) return 'intangibles';
  if (/(vehicle|car|bike|scooter|van)/.test(s)) return 'vehicles';
  if (/(furniture|fitting|chair|desk|cabinet)/.test(s)) return 'furniture';
  if (/(building|premises|property)/.test(s)) return 'buildings';
  if (/(plant|machinery|equipment|printer|projector|camera|appliance)/.test(s)) return 'plant';
  return 'office_equipment';
}

async function latestUsefulLife(assetClass: string, asOf: Date) {
  const auth = currentAuth();
  return prisma.scheduleIIUsefulLife.findFirst({
    where: { tenantId: auth.tenantId, assetClass, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

async function latestItBlock(blockName: string, asOf: Date) {
  const auth = currentAuth();
  return prisma.incomeTaxDepreciationBlock.findFirst({
    where: { tenantId: auth.tenantId, blockName, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * For every fixed asset, the Companies Act (Schedule II) charge for the
 * financial year against the Income-tax Act's block WDV charge — computed
 * independently, on purpose, because they are answers to different questions
 * and are not supposed to agree.
 */
export async function depreciationReport(fyStartYear: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'assets', verb: 'view' });
  const { from, to } = financialYearRange(fyStartYear);
  const fyEnd = new Date(to.getTime() - 86_400_000);

  const assets = await prisma.fixedAsset.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      purchaseDate: { lt: to },
      OR: [{ disposedAt: null }, { disposedAt: { gte: from } }],
    },
    orderBy: { purchaseDate: 'asc' },
  });
  const categoryIds = [...new Set(assets.map((a) => a.categoryId).filter((id): id is string => Boolean(id)))];
  const assetCategories = categoryIds.length
    ? await prisma.ledgerCategory.findMany({
        where: { tenantId: auth.tenantId, id: { in: categoryIds } },
        select: { id: true, name: true },
      })
    : [];
  const categoryNameById = new Map(assetCategories.map((c) => [c.id, c.name]));

  const rows: Array<Record<string, unknown>> = [];
  for (const asset of assets) {
    const assetClass = classifyAssetClass(asset.name, asset.categoryId ? categoryNameById.get(asset.categoryId) : null);
    const life = await latestUsefulLife(assetClass, fyEnd);
    const block = await latestItBlock(assetClass, fyEnd);

    const cost = num(asset.cost) ?? 0;
    let companiesAct: ReturnType<typeof companiesActAnnualCharge> | null = null;
    let mismatch = false;
    if (life) {
      companiesAct = companiesActAnnualCharge({
        cost,
        usefulLifeYears: life.usefulLifeYears,
        residualPercent: num(life.residualPercent) ?? 5,
        purchaseDate: asset.purchaseDate,
        fyStart: from,
        fyEnd,
      });
      const assetYears = round2(asset.usefulLifeMonths / 12);
      mismatch = Math.abs(assetYears - life.usefulLifeYears) > 0.01;
    }

    // The IT block WDV, walked year by year from acquisition to this FY —
    // each year's own charge reduces the balance the next year's is taken on.
    let itCharge: number | null = null;
    let itOpeningWdv: number | null = null;
    if (block) {
      const acquisitionFyStart = istFinancialYearStart(asset.purchaseDate);
      let wdv = cost;
      for (let y = acquisitionFyStart; y <= fyStartYear; y += 1) {
        const { to: yearTo } = financialYearRange(y);
        const yearFyEnd = new Date(yearTo.getTime() - 86_400_000);
        const heldFrom =
          asset.purchaseDate > financialYearRange(y).from ? asset.purchaseDate : financialYearRange(y).from;
        const daysHeld = Math.max(0, Math.round((yearFyEnd.getTime() - heldFrom.getTime()) / 86_400_000) + 1);
        const usedLessThan180 = y === acquisitionFyStart && daysHeld < 180;
        if (y === fyStartYear) itOpeningWdv = round2(wdv);
        const charge = incomeTaxWdvCharge({
          openingWdv: wdv,
          ratePercent: num(block.ratePercent) ?? 0,
          usedLessThan180Days: usedLessThan180,
        });
        if (y === fyStartYear) itCharge = charge;
        wdv = round2(Math.max(0, wdv - charge));
      }
    }

    rows.push({
      id: asset.id,
      recordCode: asset.recordCode,
      name: asset.name,
      assetClass,
      purchaseDate: asset.purchaseDate.toISOString().slice(0, 10),
      cost,
      companiesAct: companiesAct
        ? {
            usefulLifeYears: life!.usefulLifeYears,
            residualPercent: num(life!.residualPercent),
            charge: companiesAct.charge,
            mismatch,
            assetUsefulLifeYears: round2(asset.usefulLifeMonths / 12),
          }
        : { note: 'No Schedule II useful-life row for this asset class yet.' },
      incomeTax: block
        ? {
            blockName: block.blockName,
            ratePercent: num(block.ratePercent),
            openingWdv: itOpeningWdv,
            charge: itCharge,
          }
        : { note: 'No Income-tax block rate for this asset class yet.' },
    });
  }

  return { fy: fyOf(from), rows };
}

// ---------------------------------------------------------------------------
// Exports: trial balance, general ledger, Tally
// ---------------------------------------------------------------------------

/**
 * A trial balance as of a date. This ledger is single-entry (one account, one
 * category per transaction) rather than a statutory double-entry chart — see
 * `LedgerCategory`'s own note — so the two sides are brought to balance with
 * an explicit "Opening balances" plug rather than pretending the underlying
 * data is something it is not.
 *
 * A caller inside an interactive transaction passes its `tx` (the close does, under
 * the period lock): the scoped client throws there, and the figures must be read in
 * the same transaction as the lock.
 */
export async function trialBalance(asOf: Date, tx?: DbTx) {
  const db = tx ?? (prisma as unknown as DbTx);
  const auth = currentAuth();
  const [accounts, categoryRows, categories] = await Promise.all([
    db.ledgerAccount.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
    db.transaction.groupBy({
      by: ['categoryId', 'direction'],
      where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { lte: asOf } },
      _sum: { amount: true },
    }),
    db.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const movementsByAccount = await db.transaction.groupBy({
    by: ['accountId', 'direction'],
    where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { lte: asOf } },
    _sum: { amount: true },
  });
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const row of movementsByAccount) {
    const target = row.direction === 'in' ? inflow : outflow;
    target.set(row.accountId, num(row._sum.amount) ?? 0);
  }

  const rows: Array<{ name: string; debit: number; credit: number }> = [];
  let openingSum = 0;
  for (const account of accounts) {
    const opening = num(account.openingBalance) ?? 0;
    openingSum = round2(openingSum + opening);
    const balance = round2(opening + (inflow.get(account.id) ?? 0) - (outflow.get(account.id) ?? 0));
    rows.push({ name: account.name, debit: balance >= 0 ? balance : 0, credit: balance < 0 ? -balance : 0 });
  }

  const net = new Map<string, number>();
  for (const row of categoryRows) {
    const amount = num(row._sum.amount) ?? 0;
    const category = row.categoryId ? categoryById.get(row.categoryId) : null;
    const key = category?.name ?? 'Uncategorised';
    const signed = row.direction === 'in' ? amount : -amount;
    net.set(key, round2((net.get(key) ?? 0) + signed));
  }
  for (const category of categories) {
    const movement = net.get(category.name) ?? 0;
    const income = category.kind === 'income';
    // Income/credit-natured kinds show a credit for a net inflow; everything
    // else (expense, asset purchase, tax, transfer, drawings) shows a debit
    // for a net outflow.
    const value = income ? movement : -movement;
    rows.push({
      name: category.name,
      debit: !income && value > 0 ? value : income && value < 0 ? -value : 0,
      credit: income && value > 0 ? value : !income && value < 0 ? -value : 0,
    });
  }

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  const plug = round2(totalDebit - totalCredit);
  if (Math.abs(plug) > 0.005) {
    rows.push({ name: 'Opening balances / equity', debit: plug < 0 ? -plug : 0, credit: plug > 0 ? plug : 0 });
  }

  return {
    asOf: asOf.toISOString().slice(0, 10),
    rows,
    totalDebit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    totalCredit: round2(rows.reduce((s, r) => s + r.credit, 0)),
  };
}

export async function trialBalanceCsv(asOf: Date): Promise<string> {
  const tb = await trialBalance(asOf);
  return toCsv(
    ['Ledger', 'Debit', 'Credit'],
    tb.rows.map((r) => [r.name, r.debit || '', r.credit || '']),
  );
}

export async function generalLedgerCsv(input: { from: Date; to: Date; accountId?: string }): Promise<string> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });
  const rows = await prisma.transaction.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      txnDate: { gte: input.from, lte: input.to },
      ...(input.accountId ? { accountId: input.accountId } : {}),
    },
    include: { account: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: [{ txnDate: 'asc' }, { createdAt: 'asc' }],
  });

  return toCsv(
    ['Date', 'Record', 'Account', 'Category', 'Direction', 'Amount', 'Counterparty', 'Reference', 'Note'],
    rows.map((t) => [
      t.txnDate.toISOString().slice(0, 10),
      t.recordCode,
      t.account.name,
      t.category?.name ?? '',
      t.direction,
      num(t.amount) ?? 0,
      t.counterparty ?? '',
      t.reference ?? '',
      t.note ?? '',
    ]),
  );
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The Tally export, in the shape `imports/tallyXml.ts` parses back: an
 * ENVELOPE/BODY/IMPORTDATA/REQUESTDATA of TALLYMESSAGE/VOUCHER rows, one per
 * transaction, with the ledger and the account/category as its two ledger
 * entries. Tally's sign convention is honoured: negative is a debit.
 */
export async function tallyExportXml(input: { from: Date; to: Date }): Promise<{ xml: string; count: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });
  const rows = await prisma.transaction.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { gte: input.from, lte: input.to } },
    include: { account: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: [{ txnDate: 'asc' }, { createdAt: 'asc' }],
  });

  const vouchers = rows.map((t) => {
    const amount = num(t.amount) ?? 0;
    const dateStr = t.txnDate.toISOString().slice(0, 10).replace(/-/g, '');
    const categoryName = t.category?.name ?? 'Suspense';
    // Payment: Dr expense/category (negative), Cr bank (positive). Receipt: Dr
    // bank (negative), Cr income/category (positive).
    const accountAmount = t.direction === 'out' ? amount : -amount;
    const categoryAmount = t.direction === 'out' ? -amount : amount;
    const vchType = t.direction === 'out' ? 'Payment' : 'Receipt';
    const narration = xmlEscape(t.note || t.counterparty || t.recordCode);

    return (
      `<TALLYMESSAGE>` +
      `<VOUCHER VCHTYPE="${vchType}" ACTION="Create">` +
      `<DATE>${dateStr}</DATE>` +
      `<VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${xmlEscape(t.recordCode)}</VOUCHERNUMBER>` +
      `<PARTYLEDGERNAME>${xmlEscape(t.counterparty ?? '')}</PARTYLEDGERNAME>` +
      `<NARRATION>${narration}</NARRATION>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(t.account.name)}</LEDGERNAME><AMOUNT>${accountAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(categoryName)}</LEDGERNAME><AMOUNT>${categoryAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>` +
      `</VOUCHER>` +
      `</TALLYMESSAGE>`
    );
  });

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>` +
    `<REQUESTDATA>${vouchers.join('')}</REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;

  return { xml, count: rows.length };
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

export interface BankLineInput {
  date: Date;
  amount: number;
  direction: 'in' | 'out';
  reference?: string | null;
  narration?: string | null;
}

/**
 * What makes a statement line the same line on a re-import. The day is the IST
 * day, so a line dated 00:30 IST is the day it names.
 */
function statementLineContent(line: BankLineInput): string {
  return [
    istDateKey(line.date),
    Number(line.amount).toFixed(2),
    line.direction,
    (line.reference ?? '').trim(),
    (line.narration ?? '').trim(),
  ].join('|');
}

/**
 * The key a statement line is stored under. The occurrence counts identical lines
 * within one file, so two real identical charges are two lines and a re-import
 * of the same file gives each of them the same key again.
 */
function statementLineKey(accountId: string, content: string, occurrence: number): string {
  return createHash('sha256').update(`${accountId}|${content}|${occurrence}`).digest('hex');
}

export async function importBankStatement(
  accountId: string,
  lines: BankLineInput[],
): Promise<{ imported: number; skipped: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'edit' });
  const account = await prisma.ledgerAccount.findFirst({
    where: { id: accountId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!account) throw ApiError.notFound('Account');

  const seenInFile = new Map<string, number>();
  const keyed = lines.map((line) => {
    const content = statementLineContent(line);
    const occurrence = seenInFile.get(content) ?? 0;
    seenInFile.set(content, occurrence + 1);
    return { line, key: statementLineKey(accountId, content, occurrence) };
  });
  const known = new Set(
    (
      await prisma.bankStatementLine.findMany({
        where: { tenantId: auth.tenantId, accountId, fingerprint: { in: keyed.map((k) => k.key) } },
        select: { fingerprint: true },
      })
    ).map((r) => r.fingerprint),
  );

  let imported = 0;
  let skipped = 0;
  for (const { line, key } of keyed) {
    if (known.has(key)) {
      skipped += 1;
      continue;
    }
    let row;
    try {
      row = await prisma.bankStatementLine.create({
        data: {
          tenantId: auth.tenantId,
          accountId,
          date: line.date,
          amount: line.amount,
          direction: line.direction,
          reference: line.reference ?? null,
          narration: line.narration ?? null,
          fingerprint: key,
        },
      });
    } catch (err) {
      // A line from a concurrent import of the same statement got there first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        skipped += 1;
        continue;
      }
      throw err;
    }
    imported += 1;
    await auditWrite({
      action: 'create',
      subjectType: 'bank_statement_line',
      subjectId: row.id,
      after: {
        accountId,
        date: line.date,
        amount: line.amount,
        direction: line.direction,
        reference: line.reference ?? null,
      },
    });
  }
  await auditExport('bank_statement_line', `import:${accountId}`, imported);
  await emit({
    name: EVENTS.BANK_STATEMENT_IMPORTED,
    subject: { entityType: 'ledger_account', entityId: accountId },
    newState: { lines: imported, skipped },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });
  return { imported, skipped };
}

/**
 * Pairs unmatched bank lines with unreconciled transactions on the same
 * account by amount, direction and a ±3-day date window (a reference match
 * corroborates when both sides carry one). Sets `Transaction.reconciledAt` on
 * a match and returns what is left over on each side.
 */
export async function matchBankLines(accountId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'edit' });

  const [bankLines, transactions] = await Promise.all([
    prisma.bankStatementLine.findMany({ where: { tenantId: auth.tenantId, accountId, matchedAt: null } }),
    prisma.transaction.findMany({ where: { tenantId: auth.tenantId, accountId, deletedAt: null, reconciledAt: null } }),
  ]);

  const usedTxnIds = new Set<string>();
  let matched = 0;
  let ambiguous = 0;

  for (const line of bankLines) {
    const fits = transactions.filter((t) => {
      if (usedTxnIds.has(t.id)) return false;
      return isLikelyMatch({
        bankAmount: num(line.amount) ?? 0,
        bankDate: line.date,
        bankDirection: line.direction as 'in' | 'out',
        bankReference: line.reference,
        txnAmount: num(t.amount) ?? 0,
        txnDate: t.txnDate,
        txnDirection: t.direction as 'in' | 'out',
        txnReference: t.reference,
      });
    });
    // Two entries that fit one line are a question for a person. Committing the
    // first would be a guess, and the other entry would then look unreconciled
    // for no reason the books can show.
    if (fits.length > 1) ambiguous += 1;
    if (fits.length !== 1) continue;
    const candidate = fits[0]!;

    usedTxnIds.add(candidate.id);
    const now = new Date();
    await prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { matchedTransactionId: candidate.id, matchedAt: now },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'bank_statement_line',
      subjectId: line.id,
      before: { matchedTransactionId: null, matchedAt: null },
      after: { matchedTransactionId: candidate.id, matchedAt: now },
    });
    await prisma.transaction.update({ where: { id: candidate.id }, data: { reconciledAt: now } });
    await auditWrite({
      action: 'update',
      subjectType: 'transaction',
      subjectId: candidate.id,
      before: { reconciledAt: null },
      after: { reconciledAt: now },
    });
    await emit({
      name: EVENTS.BANK_STATEMENT_LINE_MATCHED,
      subject: { entityType: 'bank_statement_line', entityId: line.id },
      related: [{ relation: 'matched_to', entityType: 'transaction', entityId: candidate.id }],
      newState: { matchedAt: now },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
    });
    await emit({
      name: EVENTS.TRANSACTION_RECONCILED,
      subject: { entityType: 'transaction', entityId: candidate.id },
      related: [{ relation: 'matched_by', entityType: 'bank_statement_line', entityId: line.id }],
      newState: { reconciledAt: now },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
    });
    matched += 1;
  }

  const unmatchedBank = bankLines.length - matched;
  const unmatchedLedger = transactions.filter((t) => !usedTxnIds.has(t.id)).length;
  return { matched, unmatchedBank, unmatchedLedger, ambiguous };
}

export async function reconciliationReport(accountId: string) {
  const auth = currentAuth();
  const money = await canSeeMoney('transactions');
  await assertCan({ resource: 'transactions', verb: 'view' });

  const [unmatchedBank, unmatchedLedger, matchedCount] = await Promise.all([
    prisma.bankStatementLine.findMany({
      where: { tenantId: auth.tenantId, accountId, matchedAt: null },
      orderBy: { date: 'desc' },
      take: 200,
    }),
    prisma.transaction.findMany({
      where: { tenantId: auth.tenantId, accountId, deletedAt: null, reconciledAt: null },
      orderBy: { txnDate: 'desc' },
      take: 200,
    }),
    prisma.bankStatementLine.count({ where: { tenantId: auth.tenantId, accountId, matchedAt: { not: null } } }),
  ]);

  return {
    accountId,
    matchedCount,
    unmatchedBankCount: unmatchedBank.length,
    unmatchedLedgerCount: unmatchedLedger.length,
    unmatchedBank: unmatchedBank.map((l) => ({
      id: l.id,
      date: l.date.toISOString().slice(0, 10),
      amount: money ? num(l.amount) : null,
      direction: l.direction,
      reference: l.reference,
      narration: l.narration,
    })),
    unmatchedLedger: unmatchedLedger.map((t) => ({
      id: t.id,
      recordCode: t.recordCode,
      date: t.txnDate.toISOString().slice(0, 10),
      amount: money ? num(t.amount) : null,
      direction: t.direction,
      reference: t.reference,
    })),
  };
}

// ---------------------------------------------------------------------------
// Backfill entrypoint, called once from the seed
// ---------------------------------------------------------------------------

export { chainUnhashedAuditRecords };

/** Just enough of a stable hash to key a CSV filename — not part of the tamper-evidence chain. */
export function fingerprint(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}
