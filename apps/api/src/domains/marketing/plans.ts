/**
 * Marketing plans & calendar (MKT-GOV-002/004).
 *
 * A `MarketingPlan` is a quarterly statement of intent — a theme, goals and the
 * campaigns it names — approved the same way a campaign or budget is: the
 * proposer (`createdById`) can never also be the approver, unconditionally.
 *
 * `calendar()` is a read-only merge across four owners' tables (campaigns,
 * marketing events, sends, social posts) into one shape the web renders as a
 * single view — it writes nothing.
 */

import { EVENTS, MARKETING_PLAN_TRANSITIONS, type MarketingPlanStatus, type PlanView, type MarketingCalendarItem } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';

export interface PlanInput {
  period: string;
  division: string;
  theme?: string | null;
  goals?: Record<string, unknown>;
  campaignIds?: string[];
}

function toPlanView(row: {
  id: string;
  recordCode: string;
  period: string;
  division: string;
  theme: string | null;
  goals: unknown;
  campaignIds: string[];
  status: string;
}): PlanView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    period: row.period,
    division: row.division,
    theme: row.theme ?? '',
    goals: row.goals,
    campaignIds: row.campaignIds,
    status: row.status as MarketingPlanStatus,
  };
}

export async function createPlan(input: PlanInput): Promise<PlanView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'create' });

  const recordCode = await nextRecordCode('PLN');
  const row = await prisma.marketingPlan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      period: input.period,
      division: input.division,
      theme: input.theme ?? null,
      goals: (input.goals ?? {}) as never,
      campaignIds: input.campaignIds ?? [],
      status: 'draft',
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_PLAN_CREATED,
    subject: { entityType: 'marketing_plan', entityId: row.id, recordCode },
    newState: { status: 'draft', period: input.period, division: input.division },
    impact: { domains: ['mkt'] },
  });

  return toPlanView(row);
}

export async function listPlans(filters: { period?: string; division?: string } = {}): Promise<PlanView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'campaigns', verb: 'view' });
  const rows = await prisma.marketingPlan.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.period ? { period: filters.period } : {}),
      ...(filters.division ? { division: filters.division } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toPlanView);
}

export async function updatePlan(id: string, patch: Partial<PlanInput>): Promise<PlanView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  const existing = await prisma.marketingPlan.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Plan');
  if (existing.status === 'closed') throw ApiError.conflict('A closed plan cannot be edited.');

  const row = await prisma.marketingPlan.update({
    where: { id },
    data: {
      ...(patch.period !== undefined ? { period: patch.period } : {}),
      ...(patch.division !== undefined ? { division: patch.division } : {}),
      ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
      ...(patch.goals !== undefined ? { goals: patch.goals as never } : {}),
      ...(patch.campaignIds !== undefined ? { campaignIds: patch.campaignIds } : {}),
      updatedById: auth.partyId,
    },
  });
  return toPlanView(row);
}

/**
 * Approve a draft plan. The Self-Dealing Bar (see campaigns.ts/budget.ts):
 * the plan's own proposer (`createdById`) may never also approve it, even the
 * chairman — unconditional, no override.
 */
export async function approvePlan(id: string): Promise<PlanView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'approve' });
  if (auth.principalType === 'agent') throw ApiError.forbidden('An AI principal may never approve a marketing plan.');

  const row = await prisma.marketingPlan.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Plan');
  if (!MARKETING_PLAN_TRANSITIONS[row.status as MarketingPlanStatus]?.includes('approved')) {
    throw ApiError.conflict(`Cannot approve: plan is ${row.status}, not draft.`);
  }
  if (row.createdById && auth.partyId && row.createdById === auth.partyId) {
    throw ApiError.forbidden("The Self-Dealing Bar is unconditional: a plan's proposer may never approve it, even the chairman.");
  }

  const updated = await prisma.marketingPlan.update({ where: { id }, data: { status: 'approved', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_PLAN_APPROVED,
    subject: { entityType: 'marketing_plan', entityId: id, recordCode: row.recordCode },
    previousState: { status: row.status },
    newState: { status: 'approved' },
    impact: { domains: ['mkt'] },
  });
  return toPlanView(updated);
}

/**
 * Closes a plan. Reachable from `approved` or `active` — the API contract
 * exposes no separate "activate" step, so a plan quietly becomes `active`
 * (MARKETING_PLAN_TRANSITIONS' intermediate state) the moment its period is under way,
 * and `close` accepts either as its starting point.
 */
export async function closePlan(id: string): Promise<PlanView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  const row = await prisma.marketingPlan.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Plan');
  if (!['approved', 'active'].includes(row.status)) {
    throw ApiError.conflict(`Cannot close: plan is ${row.status}, must be approved or active.`);
  }

  const updated = await prisma.marketingPlan.update({ where: { id }, data: { status: 'closed', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_PLAN_CLOSED,
    subject: { entityType: 'marketing_plan', entityId: id, recordCode: row.recordCode },
    previousState: { status: row.status },
    newState: { status: 'closed' },
    impact: { domains: ['mkt'] },
  });
  return toPlanView(updated);
}

// ---------------------------------------------------------------------------
// Calendar — read-only merge, writes nothing.
// ---------------------------------------------------------------------------

export async function calendar(from: Date, to: Date): Promise<MarketingCalendarItem[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'campaigns', verb: 'view' });

  const [campaigns, events, sends, posts] = await Promise.all([
    prisma.marketingCampaign.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, startAt: { lte: to }, endAt: { gte: from } },
      select: { id: true, recordCode: true, name: true, startAt: true, endAt: true, status: true, division: true },
    }),
    prisma.marketingEvent.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, startAt: { lte: to }, OR: [{ endAt: { gte: from } }, { endAt: null }] },
      select: { id: true, recordCode: true, name: true, startAt: true, endAt: true, status: true, division: true },
    }),
    prisma.marketingSend.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, scheduledAt: { gte: from, lte: to } },
      select: { id: true, recordCode: true, channelKey: true, scheduledAt: true, status: true, campaignId: true },
    }),
    prisma.marketingSocialPost.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, scheduledAt: { gte: from, lte: to } },
      select: { id: true, channelKey: true, scheduledAt: true, status: true, campaignId: true },
    }),
  ]);

  const campaignDivisionById = new Map(campaigns.map((c) => [c.id, c.division]));

  const items: MarketingCalendarItem[] = [
    ...campaigns.map((c) => ({
      id: c.id,
      kind: 'campaign' as const,
      label: `${c.recordCode} — ${c.name}`,
      startAt: c.startAt.toISOString(),
      endAt: c.endAt.toISOString(),
      status: c.status,
      division: c.division,
    })),
    ...events.map((e) => ({
      id: e.id,
      kind: 'event' as const,
      label: `${e.recordCode} — ${e.name}`,
      startAt: e.startAt.toISOString(),
      endAt: e.endAt ? e.endAt.toISOString() : null,
      status: e.status,
      division: e.division,
    })),
    ...sends.map((s) => ({
      id: s.id,
      kind: 'send' as const,
      label: `${s.recordCode} — ${s.channelKey}`,
      startAt: (s.scheduledAt ?? new Date()).toISOString(),
      endAt: null,
      status: s.status,
      division: s.campaignId ? (campaignDivisionById.get(s.campaignId) ?? null) : null,
    })),
    ...posts.map((p) => ({
      id: p.id,
      kind: 'social_post' as const,
      label: `${p.channelKey} post`,
      startAt: p.scheduledAt.toISOString(),
      endAt: null,
      status: p.status,
      division: p.campaignId ? (campaignDivisionById.get(p.campaignId) ?? null) : null,
    })),
  ];

  return items.sort((a, b) => a.startAt.localeCompare(b.startAt));
}
