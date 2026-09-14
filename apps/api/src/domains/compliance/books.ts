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

import { createHash } from 'node:crypto';
import {
  round2,
  monthKey,
  financialYearOf,
  financialYearRange,
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
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, canSeeMoney } from '../../platform/permissions.js';
import { auditWrite, auditExport, verifyAuditChain, chainUnhashedAuditRecords } from '../../platform/audit.js';
import { registerHook } from '../../platform/hooks.js';
import { raiseException } from '../../platform/exceptions.js';

export { verifyAuditChain };

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
  const fyStartYear = month >= 4 ? year : year - 1;
  return prisma.accountingPeriod.create({
    data: { tenantId: auth.tenantId, period, fy: fyOf(new Date(Date.UTC(year, month - 1, 1))), status: 'open' },
  });
}

/** Whether `date`'s month is closed to new or edited entries. Read by the write-path hook below. */
export async function periodStatus(date: Date): Promise<string> {
  const auth = currentAuth();
  const period = periodKeyOf(date);
  const row = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  return row?.status ?? 'open';
}

/** Step one of the two-party close: any accounting_periods `edit` holder asks for a period to be closed. */
export async function requestClosePeriod(period: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'edit' });
  const row = await ensurePeriod(period);
  if (row.status !== 'open' && row.status !== 'reopened') {
    throw ApiError.unprocessable(`${period} is ${row.status}, not open — nothing to request closing.`);
  }
  const updated = await prisma.accountingPeriod.update({
    where: { id: row.id },
    data: { status: 'closing', requestedById: auth.partyId, requestedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'accounting_period', subjectId: row.id, before: { status: row.status }, after: { status: 'closing', requestedById: auth.partyId }, force: true });
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

  const [year, month] = period.split('-').map(Number);
  const asOf = new Date(Date.UTC(year, month, 1));
  const snapshot = await trialBalance(new Date(asOf.getTime() - 1));

  const updated = await prisma.accountingPeriod.update({
    where: { id: row.id },
    data: { status: 'closed', closedById: auth.partyId, closedAt: new Date(), snapshot: snapshot as never },
  });
  await auditWrite({ action: 'update', subjectType: 'accounting_period', subjectId: row.id, before: { status: 'closing' }, after: { status: 'closed', closedById: auth.partyId }, force: true });
  return updated;
}

export async function reopenPeriod(period: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'accounting_periods', verb: 'approve' });
  if (!reason?.trim()) throw ApiError.badRequest('Reopening a closed period needs a reason.');
  const row = await prisma.accountingPeriod.findFirst({ where: { tenantId: auth.tenantId, period } });
  if (!row) throw ApiError.notFound('Accounting period');
  if (row.status !== 'closed') throw ApiError.unprocessable(`${period} is ${row.status}, not closed.`);

  const updated = await prisma.accountingPeriod.update({
    where: { id: row.id },
    data: { status: 'reopened', reopenedById: auth.partyId, reopenedAt: new Date(), reopenReason: reason },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'accounting_period',
    subjectId: row.id,
    before: { status: 'closed' },
    after: { status: 'reopened', reopenReason: reason },
    force: true,
  });
  return updated;
}

/**
 * The write-path veto (CMP-AUD-003): a transaction dated inside a closed
 * period cannot be recorded, independent of GST's own filing-based lock.
 * `reverseTransaction` never backdates its reversal row — it always stamps
 * `new Date()` — so a closed period's entry is still reversible, only ever as
 * of today.
 */
registerHook('transaction.before_record', 'compliance.books.period_lock', async (payload) => {
  const txnDate = payload.txnDate as Date;
  const status = await periodStatus(txnDate);
  if (status === 'closed') {
    throw ApiError.unprocessable(
      `${periodKeyOf(txnDate)} is a closed accounting period. Reopen it first, with a reason, before recording or editing an entry dated inside it.`,
      { period: periodKeyOf(txnDate), reasonCode: 'accounting_period_closed' },
    );
  }
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const RETENTION_ENTITIES: Array<{ entityType: string; model: 'transaction' | 'vendorBill' | 'fixedAsset' | 'loan' | 'auditRecord' | 'eventRecord'; dateField: string }> = [
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

    const rows = await (prisma[spec.model] as { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> }).findMany({
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
      await prisma.retentionReview.create({
        data: {
          tenantId: auth.tenantId,
          entityType: spec.entityType,
          entityId: row.id as string,
          recordDate,
          dueAt: retentionDueDate(recordDate, policy.years),
          status: 'flagged',
        },
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
      (num(account.openingBalance) ?? 0) + (inflowByAccount.get(account.id) ?? 0) - (outflowByAccount.get(account.id) ?? 0),
    );
    const mapping = await resolveAccountMapping(account.id, account.ledgerGroup);
    if (!mapping || mapping.statement !== 'balance_sheet') {
      bsUnmapped.set(account.name, round2((bsUnmapped.get(account.name) ?? 0) + balance));
      continue;
    }
    bsHeads.set(mapping.head, round2((bsHeads.get(mapping.head) ?? 0) + balance));
  }

  const toRows = (m: Map<string, number>): ScheduleIIIRow[] => [...m.entries()].map(([head, amount]) => ({ head, amount }));
  const toUnmapped = (m: Map<string, number>): UnmappedRow[] => [...m.entries()].map(([name, amount]) => ({ name, amount }));

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
    ? await prisma.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, id: { in: categoryIds } }, select: { id: true, name: true } })
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
      const acquisitionFyStart = asset.purchaseDate.getUTCMonth() >= 3 ? asset.purchaseDate.getUTCFullYear() : asset.purchaseDate.getUTCFullYear() - 1;
      let wdv = cost;
      for (let y = acquisitionFyStart; y <= fyStartYear; y += 1) {
        const { to: yearTo } = financialYearRange(y);
        const yearFyEnd = new Date(yearTo.getTime() - 86_400_000);
        const heldFrom = asset.purchaseDate > financialYearRange(y).from ? asset.purchaseDate : financialYearRange(y).from;
        const daysHeld = Math.max(0, Math.round((yearFyEnd.getTime() - heldFrom.getTime()) / 86_400_000) + 1);
        const usedLessThan180 = y === acquisitionFyStart && daysHeld < 180;
        if (y === fyStartYear) itOpeningWdv = round2(wdv);
        const charge = incomeTaxWdvCharge({ openingWdv: wdv, ratePercent: num(block.ratePercent) ?? 0, usedLessThan180Days: usedLessThan180 });
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
        ? { usefulLifeYears: life!.usefulLifeYears, residualPercent: num(life!.residualPercent), charge: companiesAct.charge, mismatch, assetUsefulLifeYears: round2(asset.usefulLifeMonths / 12) }
        : { note: 'No Schedule II useful-life row for this asset class yet.' },
      incomeTax: block
        ? { blockName: block.blockName, ratePercent: num(block.ratePercent), openingWdv: itOpeningWdv, charge: itCharge }
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
 */
export async function trialBalance(asOf: Date) {
  const auth = currentAuth();
  const [accounts, categoryRows, categories] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
    prisma.transaction.groupBy({
      by: ['categoryId', 'direction'],
      where: { tenantId: auth.tenantId, deletedAt: null, txnDate: { lte: asOf } },
      _sum: { amount: true },
    }),
    prisma.ledgerCategory.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } }),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const movementsByAccount = await prisma.transaction.groupBy({
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
    rows.push({ name: category.name, debit: !income && value > 0 ? value : income && value < 0 ? -value : 0, credit: income && value > 0 ? value : !income && value < 0 ? -value : 0 });
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

export async function importBankStatement(accountId: string, lines: BankLineInput[]): Promise<{ imported: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'edit' });
  const account = await prisma.ledgerAccount.findFirst({ where: { id: accountId, tenantId: auth.tenantId, deletedAt: null } });
  if (!account) throw ApiError.notFound('Account');

  for (const line of lines) {
    await prisma.bankStatementLine.create({
      data: {
        tenantId: auth.tenantId,
        accountId,
        date: line.date,
        amount: line.amount,
        direction: line.direction,
        reference: line.reference ?? null,
        narration: line.narration ?? null,
      },
    });
  }
  await auditExport('bank_statement_line', `import:${accountId}`, lines.length);
  return { imported: lines.length };
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

  for (const line of bankLines) {
    const candidate = transactions.find((t) => {
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
    if (!candidate) continue;

    usedTxnIds.add(candidate.id);
    const now = new Date();
    await prisma.bankStatementLine.update({ where: { id: line.id }, data: { matchedTransactionId: candidate.id, matchedAt: now } });
    await prisma.transaction.update({ where: { id: candidate.id }, data: { reconciledAt: now } });
    matched += 1;
  }

  const unmatchedBank = bankLines.length - matched;
  const unmatchedLedger = transactions.filter((t) => !usedTxnIds.has(t.id)).length;
  return { matched, unmatchedBank, unmatchedLedger };
}

export async function reconciliationReport(accountId: string) {
  const auth = currentAuth();
  const money = await canSeeMoney('transactions');
  await assertCan({ resource: 'transactions', verb: 'view' });

  const [unmatchedBank, unmatchedLedger, matchedCount] = await Promise.all([
    prisma.bankStatementLine.findMany({ where: { tenantId: auth.tenantId, accountId, matchedAt: null }, orderBy: { date: 'desc' }, take: 200 }),
    prisma.transaction.findMany({ where: { tenantId: auth.tenantId, accountId, deletedAt: null, reconciledAt: null }, orderBy: { txnDate: 'desc' }, take: 200 }),
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
