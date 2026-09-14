/**
 * Budget, spend & vendors (MKT-BUD-001…005, MKT-GOV-004).
 *
 * `MarketingBudget` carries no status field of its own (see marketing.prisma):
 * "approved" is derived from the durable event log — a `kz.mkt.budget.approved`
 * event not superseded by a later `kz.mkt.budget.set` on the same subject —
 * rather than a column, the same way `verifyChain` reconstructs ledger state
 * from events rather than trusting a cached flag. `budgetVariance` reports
 * `measured: false` for a period/division with no *approved* budget, even if a
 * draft one exists.
 *
 * Marketing never posts money. `recordSpend`/`reconcileSpend` only ever
 * *reference* an existing books `Transaction` or `VendorBill` id — verified to
 * exist in this tenant, never written to.
 */

import type { Prisma } from '@prisma/client';
import { EVENTS, SPEND_STATUSES, type ChannelKey, type BudgetView, type BudgetVarianceRow, type SpendView, type VendorView } from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { recomputeCampaignActual } from './campaigns.js';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface BudgetInput {
  period: string;
  division: string;
  channelKey?: ChannelKey | null;
  campaignId?: string | null;
  planned: number;
  note?: string | null;
}

async function namesFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await prisma.person.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

async function campaignNamesFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await prisma.marketingCampaign.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * True when the most recent `kz.mkt.budget.approved` event on this budget has
 * not been superseded by a later `kz.mkt.budget.set` (an edit invalidates a
 * standing approval, the same way editing a signed MoU would).
 */
async function isBudgetApproved(tenantId: string, budgetId: string): Promise<{ approved: boolean; approvedById: string | null }> {
  const approvedEvent = await prisma.eventRecord.findFirst({
    where: { tenantId, subjectEntityType: 'marketing_budget', subjectEntityId: budgetId, eventName: EVENTS.MKT_BUDGET_APPROVED },
    orderBy: { recordedAt: 'desc' },
  });
  if (!approvedEvent) return { approved: false, approvedById: null };

  const laterEdit = await prisma.eventRecord.findFirst({
    where: {
      tenantId,
      subjectEntityType: 'marketing_budget',
      subjectEntityId: budgetId,
      eventName: EVENTS.MKT_BUDGET_SET,
      recordedAt: { gt: approvedEvent.recordedAt },
    },
  });
  return { approved: !laterEdit, approvedById: laterEdit ? null : approvedEvent.actorPartyId };
}

async function budgetSpendTotal(tenantId: string, budget: { division: string; period: string; channelKey: string | null; campaignId: string | null }): Promise<number> {
  const [yearStr, rest] = budget.period.split('-');
  const year = Number(yearStr);
  let spendDateFilter: Record<string, unknown> = {};
  if (rest?.startsWith('Q')) {
    const q = Number(rest.slice(1));
    const startMonth = (q - 1) * 3;
    spendDateFilter = { gte: new Date(Date.UTC(year, startMonth, 1)), lt: new Date(Date.UTC(year, startMonth + 3, 1)) };
  } else if (rest) {
    const month = Number(rest) - 1;
    spendDateFilter = { gte: new Date(Date.UTC(year, month, 1)), lt: new Date(Date.UTC(year, month + 1, 1)) };
  }

  const agg = await prisma.marketingSpend.aggregate({
    where: {
      tenantId,
      deletedAt: null,
      division: budget.division,
      ...(Object.keys(spendDateFilter).length ? { spendDate: spendDateFilter } : {}),
      ...(budget.channelKey ? { channelKey: budget.channelKey } : {}),
      ...(budget.campaignId ? { campaignId: budget.campaignId } : {}),
    },
    _sum: { amount: true },
  });
  return num(agg._sum.amount) ?? 0;
}

async function toBudgetView(row: {
  id: string;
  recordCode: string;
  period: string;
  division: string;
  channelKey: string | null;
  campaignId: string | null;
  planned: Prisma.Decimal | number;
  committed: Prisma.Decimal | number;
  note: string | null;
}): Promise<BudgetView> {
  const auth = currentAuth();
  const [{ approved, approvedById }, spent, campaignNames] = await Promise.all([
    isBudgetApproved(auth.tenantId, row.id),
    budgetSpendTotal(auth.tenantId, { division: row.division, period: row.period, channelKey: row.channelKey, campaignId: row.campaignId }),
    campaignNamesFor([row.campaignId]),
  ]);
  const planned = num(row.planned) ?? 0;
  return {
    id: row.id,
    recordCode: row.recordCode,
    period: row.period,
    division: row.division,
    channelKey: row.channelKey as ChannelKey | null,
    campaignId: row.campaignId,
    campaignName: row.campaignId ? (campaignNames.get(row.campaignId) ?? null) : null,
    planned,
    committed: num(row.committed) ?? 0,
    spent,
    remaining: planned - spent,
    note: row.note,
    approved,
    approvedById,
  };
}

export async function createBudget(input: BudgetInput): Promise<BudgetView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'create' });
  if (input.planned < 0) throw ApiError.badRequest('planned cannot be negative.');

  const recordCode = await nextRecordCode('BDG');
  const row = await prisma.marketingBudget.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      period: input.period,
      division: input.division,
      channelKey: input.channelKey ?? null,
      campaignId: input.campaignId ?? null,
      planned: input.planned,
      note: input.note ?? null,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_BUDGET_SET,
    subject: { entityType: 'marketing_budget', entityId: row.id, recordCode },
    newState: { period: row.period, division: row.division, planned: input.planned },
    impact: { domains: ['mkt'] },
  });

  return toBudgetView(row);
}

export async function updateBudget(id: string, patch: Partial<BudgetInput>): Promise<BudgetView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'edit' });
  const existing = await prisma.marketingBudget.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Budget');

  const row = await prisma.marketingBudget.update({
    where: { id },
    data: {
      ...(patch.period !== undefined ? { period: patch.period } : {}),
      ...(patch.division !== undefined ? { division: patch.division } : {}),
      ...(patch.channelKey !== undefined ? { channelKey: patch.channelKey } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(patch.planned !== undefined ? { planned: patch.planned } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedById: auth.partyId,
    },
  });

  // An edit invalidates a standing approval (see isBudgetApproved) — recorded
  // as another `.set`, never silently keeping the old approval alive.
  await emit({
    name: EVENTS.MKT_BUDGET_SET,
    subject: { entityType: 'marketing_budget', entityId: row.id, recordCode: row.recordCode },
    newState: { period: row.period, division: row.division, planned: num(row.planned) },
    impact: { domains: ['mkt'] },
  });

  return toBudgetView(row);
}

export async function listBudgets(filters: { period?: string; division?: string } = {}): Promise<BudgetView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'view' });
  const rows = await prisma.marketingBudget.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.period ? { period: filters.period } : {}),
      ...(filters.division ? { division: filters.division } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(rows.map(toBudgetView));
}

/**
 * Approves a budget. The Self-Dealing Bar (see `campaigns.ts` for the fuller
 * discussion of why this is replicated rather than routed through
 * `platform/approvals.ts`'s MoU-shaped gate): the budget's own `createdById`
 * may never also be its approver, unconditionally — even the chairman.
 */
export async function approveBudget(id: string): Promise<BudgetView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'approve' });
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden('An AI principal may never approve a marketing budget (AI-MKT-008 is PROHIBITED at every tier).');
  }

  const row = await prisma.marketingBudget.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Budget');

  if (row.createdById && auth.partyId && row.createdById === auth.partyId) {
    throw ApiError.forbidden(
      "The Self-Dealing Bar is unconditional: a budget's proposer may never approve it, even the chairman.",
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar' }],
    );
  }

  await emit({
    name: EVENTS.MKT_BUDGET_APPROVED,
    subject: { entityType: 'marketing_budget', entityId: row.id, recordCode: row.recordCode },
    newState: { period: row.period, division: row.division, planned: num(row.planned) },
    impact: { domains: ['mkt'] },
  });

  return toBudgetView(row);
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export interface SpendInput {
  campaignId?: string | null;
  channelKey: ChannelKey;
  division: string;
  amount: number;
  spendDate: Date;
  vendorOrganizationId?: string | null;
  description: string;
  transactionId?: string | null;
  vendorBillId?: string | null;
}

function periodFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function toSpendView(row: {
  id: string;
  recordCode: string;
  campaignId: string | null;
  channelKey: string;
  division: string;
  amount: Prisma.Decimal | number;
  spendDate: Date;
  vendorOrganizationId: string | null;
  description: string | null;
  transactionId: string | null;
  vendorBillId: string | null;
  status: string;
}): Promise<SpendView> {
  const [campaignNames, vendorNames] = await Promise.all([
    campaignNamesFor([row.campaignId]),
    row.vendorOrganizationId
      ? prisma.organization.findFirst({ where: { id: row.vendorOrganizationId }, select: { name: true } })
      : Promise.resolve(null),
  ]);
  return {
    id: row.id,
    recordCode: row.recordCode,
    campaignId: row.campaignId,
    campaignName: row.campaignId ? (campaignNames.get(row.campaignId) ?? null) : null,
    channelKey: row.channelKey as ChannelKey,
    division: row.division,
    amount: num(row.amount) ?? 0,
    spendDate: row.spendDate.toISOString(),
    vendorOrganizationId: row.vendorOrganizationId,
    vendorName: vendorNames?.name ?? null,
    description: row.description ?? '',
    transactionId: row.transactionId,
    vendorBillId: row.vendorBillId,
    status: row.status as SpendView['status'],
  };
}

export async function recordSpend(input: SpendInput): Promise<SpendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'create' });
  if (input.amount <= 0) throw ApiError.badRequest('amount must be positive.');

  if (input.vendorOrganizationId) {
    const vendorOrg = await prisma.organization.findFirst({ where: { id: input.vendorOrganizationId, tenantId: auth.tenantId } });
    if (!vendorOrg) throw ApiError.badRequest('vendorOrganizationId does not resolve to an organization in this tenant.');
  }
  if (input.campaignId) {
    const campaign = await prisma.marketingCampaign.findFirst({ where: { id: input.campaignId, tenantId: auth.tenantId, deletedAt: null } });
    if (!campaign) throw ApiError.badRequest('campaignId does not resolve to a campaign in this tenant.');
  }

  const recordCode = await nextRecordCode('SPN');
  const row = await prisma.marketingSpend.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      campaignId: input.campaignId ?? null,
      channelKey: input.channelKey,
      division: input.division,
      amount: input.amount,
      spendDate: input.spendDate,
      vendorOrganizationId: input.vendorOrganizationId ?? null,
      description: input.description,
      transactionId: input.transactionId ?? null,
      vendorBillId: input.vendorBillId ?? null,
      status: 'recorded',
      createdById: auth.partyId,
    },
  });

  if (input.campaignId) await recomputeCampaignActual(input.campaignId);

  await emit({
    name: EVENTS.MKT_SPEND_RECORDED,
    subject: { entityType: 'marketing_spend', entityId: row.id, recordCode },
    newState: { amount: input.amount, division: input.division, channelKey: input.channelKey, campaignId: input.campaignId ?? null },
    impact: { domains: ['mkt'] },
  });

  return toSpendView(row);
}

export async function listSpend(filters: { campaignId?: string; from?: Date; to?: Date } = {}): Promise<SpendView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'view' });
  const rows = await prisma.marketingSpend.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(filters.from || filters.to
        ? { spendDate: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
    },
    orderBy: { spendDate: 'desc' },
  });
  return Promise.all(rows.map(toSpendView));
}

/**
 * Reconciles a recorded spend against an existing books row. Marketing never
 * writes to the ledger — the referenced `Transaction`/`VendorBill` must
 * already exist in this tenant, verified here, and nothing about it is
 * touched.
 */
export async function reconcileSpend(id: string, ref: { transactionId?: string; vendorBillId?: string }): Promise<SpendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'edit' });
  if (!ref.transactionId && !ref.vendorBillId) throw ApiError.badRequest('One of transactionId or vendorBillId is required.');

  const row = await prisma.marketingSpend.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Spend');
  if (row.status !== 'recorded') throw ApiError.conflict(`Cannot reconcile: spend is already ${row.status}.`);

  if (ref.transactionId) {
    const txn = await prisma.transaction.findFirst({ where: { id: ref.transactionId, tenantId: auth.tenantId } });
    if (!txn) throw ApiError.badRequest('transactionId does not resolve to a books Transaction in this tenant.');
  }
  if (ref.vendorBillId) {
    const bill = await prisma.vendorBill.findFirst({ where: { id: ref.vendorBillId, tenantId: auth.tenantId } });
    if (!bill) throw ApiError.badRequest('vendorBillId does not resolve to a VendorBill in this tenant.');
  }

  const updated = await prisma.marketingSpend.update({
    where: { id },
    data: {
      transactionId: ref.transactionId ?? row.transactionId,
      vendorBillId: ref.vendorBillId ?? row.vendorBillId,
      status: 'reconciled',
      updatedById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_SPEND_RECONCILED,
    subject: { entityType: 'marketing_spend', entityId: id, recordCode: row.recordCode },
    previousState: { status: 'recorded' },
    newState: { status: 'reconciled', transactionId: updated.transactionId, vendorBillId: updated.vendorBillId },
    impact: { domains: ['mkt'] },
  });

  return toSpendView(updated);
}

// ---------------------------------------------------------------------------
// Variance (MKT-BUD-001)
// ---------------------------------------------------------------------------

export async function budgetVariance(filters: { period?: string; division?: string } = {}): Promise<BudgetVarianceRow[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'view' });

  const budgets = await prisma.marketingBudget.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.period ? { period: filters.period } : {}),
      ...(filters.division ? { division: filters.division } : {}),
    },
  });

  const rows: BudgetVarianceRow[] = [];
  for (const b of budgets) {
    const [{ approved }, actual] = await Promise.all([
      isBudgetApproved(auth.tenantId, b.id),
      budgetSpendTotal(auth.tenantId, { division: b.division, period: b.period, channelKey: b.channelKey, campaignId: b.campaignId }),
    ]);
    const planned = num(b.planned) ?? 0;
    rows.push({
      division: b.division,
      channelKey: b.channelKey as ChannelKey | null,
      campaignId: b.campaignId,
      planned,
      committed: num(b.committed) ?? 0,
      actual,
      variance: planned - actual,
      measured: approved,
    });
  }
  return rows;
}

/** EX-MKT-002 — campaign spend exceeds its planned budget. */
export async function detectOverBudget(): Promise<number> {
  const auth = currentAuth();
  const campaigns = await prisma.marketingCampaign.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['live', 'paused', 'scheduled', 'completed'] } },
    select: { id: true, recordCode: true, name: true, budgetPlanned: true, ownerPartyId: true },
  });

  let count = 0;
  for (const c of campaigns) {
    const spent = await recomputeCampaignActual(c.id);
    const planned = num(c.budgetPlanned) ?? 0;
    if (spent > planned) {
      count += 1;
      await raiseException({
        code: 'EX-MKT-002',
        label: 'Campaign spend exceeds planned budget',
        severity: 'S2_WARNING',
        subjectType: 'marketing_campaign',
        subjectId: c.id,
        subjectLabel: `${c.recordCode} — ${c.name}`,
        domain: 'mkt',
        detail: `Spend ${spent} exceeds planned budget ${planned}.`,
        ownerPartyId: c.ownerPartyId,
        triggerFingerprint: `mkt_over_budget:${c.id}`,
        ladderRung: 0,
      });
    }
  }
  return count;
}

/** EX-MKT-014 — spend recorded against a period/division with no approved budget. */
export async function detectSpendWithoutBudget(): Promise<number> {
  const auth = currentAuth();
  const spends = await prisma.marketingSpend.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    take: 500,
    orderBy: { createdAt: 'desc' },
  });

  let count = 0;
  for (const s of spends) {
    const period = periodFor(s.spendDate);
    const candidates = await prisma.marketingBudget.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        division: s.division,
        period,
        OR: [{ campaignId: s.campaignId }, { campaignId: null }],
      },
    });
    let anyApproved = false;
    for (const b of candidates) {
      if (b.channelKey && b.channelKey !== s.channelKey) continue;
      const { approved } = await isBudgetApproved(auth.tenantId, b.id);
      if (approved) {
        anyApproved = true;
        break;
      }
    }
    if (!anyApproved) {
      count += 1;
      await raiseException({
        code: 'EX-MKT-014',
        label: 'Budget period has no approved budget while spend recorded',
        severity: 'S2_WARNING',
        subjectType: 'marketing_spend',
        subjectId: s.id,
        subjectLabel: `${s.recordCode} — ${period} ${s.division}`,
        domain: 'mkt',
        detail: `Spend of ${num(s.amount)} recorded against ${period}/${s.division} with no approved budget.`,
        ownerPartyId: s.createdById,
        triggerFingerprint: `mkt_spend_no_budget:${s.id}`,
        ladderRung: 0,
      });
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export interface VendorInput {
  organizationId: string;
  services?: string[];
  contractRef?: string | null;
}

async function toVendorView(row: { id: string; organizationId: string; services: string[]; contractRef: string | null; active: boolean; rating: Prisma.Decimal | number | null }): Promise<VendorView> {
  const org = await prisma.organization.findFirst({ where: { id: row.organizationId }, select: { name: true } });
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: org?.name ?? 'Unknown',
    services: row.services,
    contractRef: row.contractRef,
    active: row.active,
    rating: num(row.rating),
  };
}

export async function createVendor(input: VendorInput): Promise<VendorView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'create' });

  const org = await prisma.organization.findFirst({ where: { id: input.organizationId, tenantId: auth.tenantId } });
  if (!org) throw ApiError.badRequest('organizationId does not resolve to an organization in this tenant.');

  const recordCode = await nextRecordCode('VND');
  const row = await prisma.marketingVendor.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      organizationId: input.organizationId,
      services: input.services ?? [],
      contractRef: input.contractRef ?? null,
      createdById: auth.partyId,
    },
  });
  return toVendorView(row);
}

export async function updateVendor(id: string, patch: Partial<VendorInput> & { active?: boolean }): Promise<VendorView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'edit' });
  const existing = await prisma.marketingVendor.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Vendor');

  const row = await prisma.marketingVendor.update({
    where: { id },
    data: {
      ...(patch.services !== undefined ? { services: patch.services } : {}),
      ...(patch.contractRef !== undefined ? { contractRef: patch.contractRef } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedById: auth.partyId,
    },
  });
  return toVendorView(row);
}

export async function listVendors(): Promise<VendorView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_budgets', verb: 'view' });
  const rows = await prisma.marketingVendor.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  return Promise.all(rows.map(toVendorView));
}

export { SPEND_STATUSES };
