/**
 * Campaign lifecycle (MKT-CMP-001…010, MKT-GOV-002/004).
 *
 * A campaign is a unit of intent: one objective, one budget, one owner, one
 * division, moving through the fixed `CAMPAIGN_TRANSITIONS` state machine.
 * Above a configurable per-tenant threshold it needs a second person's sign-off
 * before it can run — the proposer is the campaign's `ownerPartyId` and can
 * never also be that second person, even the chairman. That bar is
 * unconditional and is re-checked at decision time, never cached from
 * submission time.
 *
 * Marketing never writes `Lead.ownerPartyId`, never routes a lead, never
 * creates a `Person` directly, and never posts money itself — spend
 * (`budget.ts`) only ever *references* a books `Transaction` or `VendorBill`.
 */

import {
  EVENTS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TRANSITIONS,
  type CampaignObjective,
  type CampaignStatus,
  type ChannelKey,
  type CampaignView,
  type CampaignDetailView,
  type CampaignApprovalView,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { timelineFor } from '../interactions.js';

// ---------------------------------------------------------------------------
// Policy — `Tenant.config.marketing`, following the documented `Tenant.config`
// convention (see main.prisma's Tenant model doc comment) rather than a new
// settings table.
// ---------------------------------------------------------------------------

export interface MarketingPolicy {
  campaignApprovalThreshold: number;
  sendApprovalThreshold: number;
  bounceAlertRate: number;
  unsubscribeAlertRate: number;
  staleCampaignDays: number;
  formConvertSlaHours: number;
}

const DEFAULT_MARKETING_POLICY: MarketingPolicy = {
  campaignApprovalThreshold: 50_000,
  sendApprovalThreshold: 5_000,
  bounceAlertRate: 0.05,
  unsubscribeAlertRate: 0.02,
  staleCampaignDays: 7,
  formConvertSlaHours: 24,
};

export async function getMarketingPolicy(tenantId?: string): Promise<MarketingPolicy> {
  const tid = tenantId ?? currentAuth().tenantId;
  const tenant = await prisma.tenant.findFirst({ where: { id: tid }, select: { config: true } });
  const config = (tenant?.config as { marketing?: Partial<MarketingPolicy> } | null) ?? {};
  return { ...DEFAULT_MARKETING_POLICY, ...(config.marketing ?? {}) };
}

export async function setMarketingPolicy(patch: Partial<MarketingPolicy>): Promise<MarketingPolicy> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const config = (tenant.config as Record<string, unknown>) ?? {};
  const current = { ...DEFAULT_MARKETING_POLICY, ...((config.marketing as Partial<MarketingPolicy>) ?? {}) };
  const next = { ...current, ...patch };
  await prisma.tenant.update({ where: { id: auth.tenantId }, data: { config: { ...config, marketing: next } as never } });
  return next;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CampaignCreateInput {
  name: string;
  objective: CampaignObjective;
  division: string;
  vertical?: string | null;
  channelMix: ChannelKey[];
  startAt: Date;
  endAt: Date;
  budgetPlanned: number;
  currency?: string;
  offeringId?: string | null;
  courseId?: string | null;
  audienceId?: string | null;
  contentBrief?: string | null;
  tags?: string[];
  targetLeads?: number | null;
  targetEnrolments?: number | null;
  targetPipelineValue?: number | null;
  utmCampaign?: string | null;
}

export type CampaignUpdateInput = Partial<Omit<CampaignCreateInput, 'utmCampaign'>>;

export interface CampaignListFilters {
  q?: string;
  status?: string;
  division?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAMPAIGN_INCLUDE = {
  offering: { select: { id: true, name: true } },
  course: { select: { id: true, name: true } },
  audience: { select: { id: true, name: true } },
} as const;

type CampaignRow = Awaited<ReturnType<typeof loadCampaignRow>>;

async function loadCampaignRow(id: string) {
  return prisma.marketingCampaign.findFirst({
    where: { id, deletedAt: null },
    include: CAMPAIGN_INCLUDE,
  });
}

async function requireCampaignRow(id: string) {
  const row = await loadCampaignRow(id);
  if (!row) throw ApiError.notFound('Campaign');
  return row;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'campaign'
  );
}

async function uniqueUtmSlug(base: string, tenantId: string): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  let n = 2;
  // Small tenants, small n — a linear probe is honest and simple.
  while (await prisma.marketingCampaign.findFirst({ where: { tenantId, utmCampaign: candidate } })) {
    candidate = `${root}-${n}`;
    n += 1;
  }
  return candidate;
}

async function namesFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const people = await prisma.person.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(people.map((p) => [p.id, p.fullName]));
}

function toCampaignView(row: NonNullable<CampaignRow>, names: Map<string, string>): CampaignView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    name: row.name,
    objective: row.objective as CampaignObjective,
    channelMix: row.channelMix as ChannelKey[],
    division: row.division,
    vertical: row.vertical,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status as CampaignStatus,
    budgetPlanned: num(row.budgetPlanned) ?? 0,
    budgetCommitted: num(row.budgetCommitted) ?? 0,
    budgetActual: num(row.budgetActual) ?? 0,
    currency: row.currency,
    ownerPartyId: row.ownerPartyId ?? '',
    ownerName: row.ownerPartyId ? (names.get(row.ownerPartyId) ?? 'Unknown') : '',
    approvedById: row.approvedById,
    approvedByName: row.approvedById ? (names.get(row.approvedById) ?? 'Unknown') : null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvalRequired: row.approvalRequired,
    utmCampaign: row.utmCampaign,
    targetLeads: row.targetLeads,
    targetEnrolments: row.targetEnrolments,
    targetPipelineValue: num(row.targetPipelineValue),
    offeringId: row.offeringId,
    offeringName: row.offering?.name ?? null,
    courseId: row.courseId,
    courseName: row.course?.name ?? null,
    audienceId: row.audienceId,
    audienceName: row.audience?.name ?? null,
    contentBrief: row.contentBrief,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toCampaignViewSingle(row: NonNullable<CampaignRow>): Promise<CampaignView> {
  const names = await namesFor([row.ownerPartyId, row.approvedById]);
  return toCampaignView(row, names);
}

/** Sum of every non-deleted MarketingSpend row against this campaign. */
async function campaignSpendTotal(tenantId: string, campaignId: string): Promise<number> {
  const agg = await prisma.marketingSpend.aggregate({
    where: { tenantId, campaignId, deletedAt: null },
    _sum: { amount: true },
  });
  return num(agg._sum.amount) ?? 0;
}

/**
 * `budgetActual` is computed from `MarketingSpend`, never hand-edited
 * (MKT-CMP-005) — this is the one place that writes it.
 */
export async function recomputeCampaignActual(campaignId: string): Promise<number> {
  const auth = currentAuth();
  const total = await campaignSpendTotal(auth.tenantId, campaignId);
  await prisma.marketingCampaign.update({ where: { id: campaignId }, data: { budgetActual: total } });
  return total;
}

async function emitCampaignEvent(
  name: string,
  row: { id: string; recordCode: string; ownerPartyId: string | null },
  previousState: Record<string, unknown> | null,
  newState: Record<string, unknown>,
) {
  await emit({
    name,
    subject: { entityType: 'marketing_campaign', entityId: row.id, recordCode: row.recordCode },
    previousState,
    newState,
    owner: { partyId: row.ownerPartyId },
    impact: { domains: ['mkt'] },
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createCampaign(input: CampaignCreateInput): Promise<CampaignDetailView> {
  const auth = currentAuth();
  await assertCan({ resource: 'campaigns', verb: 'create' });

  if (input.endAt <= input.startAt) throw ApiError.badRequest('endAt must be after startAt.');
  if (input.budgetPlanned < 0) throw ApiError.badRequest('budgetPlanned cannot be negative.');
  if (input.offeringId && input.courseId) {
    throw ApiError.badRequest('A campaign links at most one of offeringId/courseId, never both.');
  }

  const recordCode = await nextRecordCode('CPG');
  const utmCampaign = await uniqueUtmSlug(input.utmCampaign ?? input.name, auth.tenantId);

  const row = await prisma.marketingCampaign.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      objective: input.objective,
      channelMix: input.channelMix,
      division: input.division,
      vertical: input.vertical ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      status: 'draft',
      budgetPlanned: input.budgetPlanned,
      currency: input.currency ?? 'INR',
      // The creator is the campaign's owner/proposer — the party the
      // Self-Dealing Bar checks against at approval time.
      ownerPartyId: auth.partyId,
      approvalRequired: false,
      utmCampaign,
      targetLeads: input.targetLeads ?? null,
      targetEnrolments: input.targetEnrolments ?? null,
      targetPipelineValue: input.targetPipelineValue ?? undefined,
      offeringId: input.offeringId ?? null,
      courseId: input.courseId ?? null,
      audienceId: input.audienceId ?? null,
      contentBrief: input.contentBrief ?? null,
      tags: input.tags ?? [],
      createdById: auth.partyId,
    },
    include: CAMPAIGN_INCLUDE,
  });

  await emitCampaignEvent(EVENTS.MKT_CAMPAIGN_CREATED, row, null, { status: 'draft' });

  return getCampaign(row.id);
}

export async function listCampaigns(
  filters: CampaignListFilters,
): Promise<{ items: CampaignView[]; total: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'campaigns', verb: 'view' });

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);

  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.division ? { division: filters.division } : {}),
    ...(filters.q ? { OR: [{ name: { contains: filters.q, mode: 'insensitive' } }, { recordCode: { contains: filters.q, mode: 'insensitive' } }] } : {}),
    ...(filters.from || filters.to
      ? {
          AND: [
            ...(filters.from ? [{ endAt: { gte: filters.from } }] : []),
            ...(filters.to ? [{ startAt: { lte: filters.to } }] : []),
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.marketingCampaign.findMany({
      where: where as never,
      include: CAMPAIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.marketingCampaign.count({ where: where as never }),
  ]);

  const names = await namesFor(rows.flatMap((r) => [r.ownerPartyId, r.approvedById]));
  return { items: rows.map((r) => toCampaignView(r, names)), total };
}

export async function getCampaign(id: string): Promise<CampaignDetailView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });
  const auth = currentAuth();
  const row = await requireCampaignRow(id);

  const [view, approvalsRaw, spendTotal, touchpointCount, leadCount, events] = await Promise.all([
    toCampaignViewSingle(row),
    prisma.marketingCampaignApproval.findMany({ where: { tenantId: auth.tenantId, campaignId: id }, orderBy: { createdAt: 'desc' } }),
    campaignSpendTotal(auth.tenantId, id),
    prisma.marketingTouchpoint.count({ where: { tenantId: auth.tenantId, campaignId: id, deletedAt: null } }),
    prisma.lead.count({ where: { tenantId: auth.tenantId, campaignId: id, deletedAt: null } as never }).catch(() => 0),
    prisma.marketingEvent.findMany({
      where: { tenantId: auth.tenantId, campaignId: id, deletedAt: null },
      select: { id: true, recordCode: true, name: true, status: true, startAt: true },
      orderBy: { startAt: 'desc' },
      take: 20,
    }),
  ]);

  const approvals: CampaignApprovalView[] = approvalsRaw.map((a) => ({
    id: a.id,
    recordCode: a.recordCode,
    requestedById: a.requestedById,
    decidedById: a.decidedById,
    decision: a.decision as CampaignApprovalView['decision'],
    reason: a.reason,
    thresholdAmount: num(a.thresholdAmount),
    createdAt: a.createdAt.toISOString(),
  }));

  return {
    ...view,
    approvals,
    spendTotal,
    touchpointCount,
    leadCount,
    events: events.map((e) => ({ id: e.id, recordCode: e.recordCode, name: e.name, status: e.status as never, startAt: e.startAt.toISOString() })),
  };
}

export async function updateCampaign(id: string, patch: CampaignUpdateInput): Promise<CampaignDetailView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });
  const row = await requireCampaignRow(id);

  if (!['draft', 'paused', 'scheduled'].includes(row.status)) {
    throw ApiError.conflict(`Campaign cannot be edited while ${row.status}. Only draft, paused or scheduled campaigns may change.`);
  }
  if ((patch.offeringId && patch.courseId) || (patch.offeringId && row.courseId && patch.courseId !== null) || (patch.courseId && row.offeringId && patch.offeringId !== null)) {
    throw ApiError.badRequest('A campaign links at most one of offeringId/courseId, never both.');
  }
  if (patch.startAt && patch.endAt && patch.endAt <= patch.startAt) throw ApiError.badRequest('endAt must be after startAt.');

  const updated = await prisma.marketingCampaign.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      ...(patch.division !== undefined ? { division: patch.division } : {}),
      ...(patch.vertical !== undefined ? { vertical: patch.vertical } : {}),
      ...(patch.channelMix !== undefined ? { channelMix: patch.channelMix } : {}),
      ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
      ...(patch.endAt !== undefined ? { endAt: patch.endAt } : {}),
      ...(patch.budgetPlanned !== undefined ? { budgetPlanned: patch.budgetPlanned } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.offeringId !== undefined ? { offeringId: patch.offeringId } : {}),
      ...(patch.courseId !== undefined ? { courseId: patch.courseId } : {}),
      ...(patch.audienceId !== undefined ? { audienceId: patch.audienceId } : {}),
      ...(patch.contentBrief !== undefined ? { contentBrief: patch.contentBrief } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.targetLeads !== undefined ? { targetLeads: patch.targetLeads } : {}),
      ...(patch.targetEnrolments !== undefined ? { targetEnrolments: patch.targetEnrolments } : {}),
      ...(patch.targetPipelineValue !== undefined ? { targetPipelineValue: patch.targetPipelineValue } : {}),
      updatedById: currentAuth().partyId,
    },
    include: CAMPAIGN_INCLUDE,
  });
  void updated;

  return getCampaign(id);
}

export async function deleteCampaign(id: string): Promise<{ ok: true }> {
  await assertCan({ resource: 'campaigns', verb: 'delete' });
  const row = await requireCampaignRow(id);
  if (row.status !== 'draft') throw ApiError.conflict('Only a draft campaign may be deleted.');

  await prisma.marketingCampaign.update({ where: { id }, data: { deletedAt: new Date(), updatedById: currentAuth().partyId } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approval workflow (MKT-CMP-002/003, MKT-GOV-004)
// ---------------------------------------------------------------------------

/**
 * The Self-Dealing Bar, replicated from `platform/approvals.ts`
 * `evaluateApprovalGate` rather than called through it: that gate is shaped
 * for the MoU/Contract/PartnerAgreement/Quote/equity family (a `GateSubject`
 * with a `commercialValue`/`strategicValue`/`termMonths` authority-ceiling
 * resolution and its own `ApprovalStep` table) and campaigns are approved
 * through their own `MarketingCampaignApproval` row instead — the schema the
 * marketing skeleton fixes. The rule itself is copied verbatim: an AI
 * principal may never decide, and the requester or the subject's owner may
 * never also be the approver, unconditionally, with no override path — this
 * holds even for the chairman.
 */
function assertNotSelfDealing(action: string, requestedById: string, ownerPartyId: string | null): void {
  const auth = currentAuth();
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden(`An AI principal may never execute ${action}. A named human role sits at every value tier.`, [
      { axis: 'WHO', passed: false, reason: 'agent_principal_excluded' },
    ]);
  }
  if (auth.partyId && (auth.partyId === requestedById || (ownerPartyId && auth.partyId === ownerPartyId))) {
    throw ApiError.forbidden(
      `The Self-Dealing Bar is unconditional: a campaign's proposer or owner may never execute ${action} on it, even the chairman.`,
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar' }],
    );
  }
}

export async function submitCampaign(id: string): Promise<CampaignDetailView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });
  const auth = currentAuth();
  const row = await requireCampaignRow(id);

  if (!CAMPAIGN_TRANSITIONS[row.status as CampaignStatus]?.some((s) => s === 'pending_approval' || s === 'scheduled')) {
    throw ApiError.conflict(`Cannot submit: ${row.status} -> pending_approval/scheduled is not a valid transition.`);
  }
  if (row.status !== 'draft') throw ApiError.conflict(`Cannot submit a campaign that is ${row.status}.`);

  const policy = await getMarketingPolicy(auth.tenantId);
  const budgetPlanned = num(row.budgetPlanned) ?? 0;
  const approvalRequired = budgetPlanned > policy.campaignApprovalThreshold;

  if (approvalRequired) {
    const approvalCode = await nextRecordCode('CAA');
    await prisma.marketingCampaignApproval.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: approvalCode,
        campaignId: id,
        requestedById: auth.partyId ?? 'system',
        decision: 'pending',
        thresholdAmount: policy.campaignApprovalThreshold,
        createdById: auth.partyId,
      },
    });
    const updated = await prisma.marketingCampaign.update({
      where: { id },
      data: { status: 'pending_approval', approvalRequired: true, updatedById: auth.partyId },
      include: CAMPAIGN_INCLUDE,
    });
    await emitCampaignEvent(EVENTS.MKT_CAMPAIGN_SUBMITTED, updated, { status: 'draft' }, { status: 'pending_approval', budgetPlanned });
  } else {
    const updated = await prisma.marketingCampaign.update({
      where: { id },
      data: { status: 'scheduled', approvalRequired: false, updatedById: auth.partyId },
      include: CAMPAIGN_INCLUDE,
    });
    await emitCampaignEvent(EVENTS.MKT_CAMPAIGN_SCHEDULED, updated, { status: 'draft' }, { status: 'scheduled', budgetPlanned });
  }

  return getCampaign(id);
}

export async function approveCampaign(id: string, reason?: string): Promise<CampaignDetailView> {
  await assertCan({ resource: 'campaigns', verb: 'approve' });
  const auth = currentAuth();
  const row = await requireCampaignRow(id);
  if (row.status !== 'pending_approval') throw ApiError.conflict(`Cannot approve: campaign is ${row.status}, not pending_approval.`);

  const approval = await prisma.marketingCampaignApproval.findFirst({
    where: { tenantId: auth.tenantId, campaignId: id, decision: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  if (!approval) throw ApiError.conflict('No pending approval request found for this campaign.');

  assertNotSelfDealing('campaigns:approve', approval.requestedById, row.ownerPartyId);

  await prisma.marketingCampaignApproval.update({
    where: { id: approval.id },
    data: { decision: 'approved', decidedById: auth.partyId, reason: reason ?? null },
  });

  const updated = await prisma.marketingCampaign.update({
    where: { id },
    data: { status: 'scheduled', approvedById: auth.partyId, approvedAt: new Date(), updatedById: auth.partyId },
    include: CAMPAIGN_INCLUDE,
  });

  await emitCampaignEvent(EVENTS.MKT_CAMPAIGN_APPROVED, updated, { status: 'pending_approval' }, { status: 'scheduled' });
  return getCampaign(id);
}

export async function rejectCampaign(id: string, reason: string): Promise<CampaignDetailView> {
  if (!reason?.trim()) throw ApiError.badRequest('A reason is required to reject a campaign.');
  await assertCan({ resource: 'campaigns', verb: 'approve' });
  const auth = currentAuth();
  const row = await requireCampaignRow(id);
  if (row.status !== 'pending_approval') throw ApiError.conflict(`Cannot reject: campaign is ${row.status}, not pending_approval.`);

  const approval = await prisma.marketingCampaignApproval.findFirst({
    where: { tenantId: auth.tenantId, campaignId: id, decision: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  if (!approval) throw ApiError.conflict('No pending approval request found for this campaign.');

  assertNotSelfDealing('campaigns:reject', approval.requestedById, row.ownerPartyId);

  await prisma.marketingCampaignApproval.update({
    where: { id: approval.id },
    data: { decision: 'rejected', decidedById: auth.partyId, reason },
  });

  const updated = await prisma.marketingCampaign.update({
    where: { id },
    data: { status: 'draft', updatedById: auth.partyId },
    include: CAMPAIGN_INCLUDE,
  });

  await emitCampaignEvent(EVENTS.MKT_CAMPAIGN_REJECTED, updated, { status: 'pending_approval' }, { status: 'draft', reason });
  return getCampaign(id);
}

// ---------------------------------------------------------------------------
// State machine (MKT-CMP-004, MKT-GOV-002)
// ---------------------------------------------------------------------------

async function transition(id: string, target: CampaignStatus, action: string, eventName: string, extraState?: Record<string, unknown>): Promise<CampaignDetailView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });
  const auth = currentAuth();
  const row = await requireCampaignRow(id);
  const from = row.status as CampaignStatus;

  const allowed = CAMPAIGN_TRANSITIONS[from] ?? [];
  if (!allowed.includes(target)) {
    throw ApiError.conflict(`Invalid transition: cannot ${action} a campaign from '${from}' to '${target}'.`, {
      from,
      to: target,
      allowed,
    });
  }

  const updated = await prisma.marketingCampaign.update({
    where: { id },
    data: { status: target, updatedById: auth.partyId },
    include: CAMPAIGN_INCLUDE,
  });

  await emitCampaignEvent(eventName, updated, { status: from }, { status: target, ...extraState });
  return getCampaign(id);
}

export async function launchCampaign(id: string): Promise<CampaignDetailView> {
  return transition(id, 'live', 'launch', EVENTS.MKT_CAMPAIGN_LAUNCHED);
}

export async function pauseCampaign(id: string): Promise<CampaignDetailView> {
  return transition(id, 'paused', 'pause', EVENTS.MKT_CAMPAIGN_PAUSED);
}

export async function resumeCampaign(id: string): Promise<CampaignDetailView> {
  return transition(id, 'live', 'resume', EVENTS.MKT_CAMPAIGN_RESUMED);
}

export async function completeCampaign(id: string): Promise<CampaignDetailView> {
  return transition(id, 'completed', 'complete', EVENTS.MKT_CAMPAIGN_COMPLETED);
}

export async function archiveCampaign(id: string): Promise<CampaignDetailView> {
  return transition(id, 'archived', 'archive', EVENTS.MKT_CAMPAIGN_ARCHIVED);
}

export async function cancelCampaign(id: string, reason: string): Promise<CampaignDetailView> {
  if (!reason?.trim()) throw ApiError.badRequest('A reason is required to cancel a campaign.');
  const result = await transition(id, 'cancelled', 'cancel', EVENTS.MKT_CAMPAIGN_CANCELLED, { reason });

  // Cancelling a campaign cancels its queued sends and pauses its journeys
  // (MKT-CMP-008) — best-effort within this module's own tables; sends and
  // journeys are owned by messaging.ts/journeys.ts, so this only touches the
  // rows those domains will themselves read next.
  await prisma.marketingSend.updateMany({
    where: { tenantId: currentAuth().tenantId, campaignId: id, status: { in: ['draft', 'queued'] } },
    data: { status: 'cancelled' },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Timeline & UTM
// ---------------------------------------------------------------------------

export interface CampaignTimelineEntry {
  at: string;
  kind: string;
  label: string;
  ref: { entityType: string; entityId: string };
}

export async function campaignTimeline(id: string): Promise<CampaignTimelineEntry[]> {
  await assertCan({ resource: 'campaigns', verb: 'view' });
  const auth = currentAuth();
  await requireCampaignRow(id);

  const [interactions, touchpoints] = await Promise.all([
    timelineFor('marketing_campaign', id, { limit: 100 }),
    prisma.marketingTouchpoint.findMany({
      where: { tenantId: auth.tenantId, campaignId: id, deletedAt: null },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    }),
  ]);

  const fromInteractions: CampaignTimelineEntry[] = interactions.items.map((i) => ({
    at: i.occurredAt.toISOString(),
    kind: i.interactionType,
    label: i.subject ?? i.interactionType,
    ref: { entityType: 'interaction', entityId: i.id },
  }));

  const fromTouchpoints: CampaignTimelineEntry[] = touchpoints.map((t) => ({
    at: t.occurredAt.toISOString(),
    kind: `touchpoint:${t.touchKind}`,
    label: `${t.touchKind} via ${t.channelKey}`,
    ref: { entityType: 'marketing_touchpoint', entityId: t.id },
  }));

  return [...fromInteractions, ...fromTouchpoints].sort((a, b) => b.at.localeCompare(a.at));
}

const UTM_MEDIUM_BY_CHANNEL: Partial<Record<ChannelKey, string>> = {
  email: 'email',
  sms: 'sms',
  whatsapp: 'whatsapp',
  social_meta: 'social',
  social_linkedin: 'social',
  social_youtube: 'social',
  google_ads: 'cpc',
  website: 'organic',
  event: 'event',
  referral: 'referral',
  partner: 'partner',
  print: 'print',
  walk_in: 'offline',
  phone: 'offline',
  other: 'other',
};

export interface CampaignUtmView {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string;
  links: Array<{ channelKey: ChannelKey; url: string }>;
}

export async function campaignUtm(id: string): Promise<CampaignUtmView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });
  const row = await requireCampaignRow(id);
  const channels = (row.channelMix as ChannelKey[]).length ? (row.channelMix as ChannelKey[]) : (['other'] as ChannelKey[]);

  const links = channels.map((channelKey) => {
    const utmMedium = UTM_MEDIUM_BY_CHANNEL[channelKey] ?? 'other';
    const url = `https://kaizen.example/?utm_source=${encodeURIComponent(channelKey)}&utm_medium=${encodeURIComponent(utmMedium)}&utm_campaign=${encodeURIComponent(row.utmCampaign)}`;
    return { channelKey, url };
  });

  return {
    utmSource: channels[0] ?? null,
    utmMedium: links[0] ? UTM_MEDIUM_BY_CHANNEL[links[0].channelKey] ?? 'other' : null,
    utmCampaign: row.utmCampaign,
    links,
  };
}

// ---------------------------------------------------------------------------
// Detectors (jobs/scheduler.ts calls these under a system context, per tenant)
// ---------------------------------------------------------------------------

/** EX-MKT-010 — a live campaign past its own endAt. Raises and leaves it live; it never auto-completes a campaign nobody decided to end. */
export async function autoCompleteExpiredCampaigns(): Promise<number> {
  const auth = currentAuth();
  const now = new Date();

  const expired = await prisma.marketingCampaign.findMany({
    where: { tenantId: auth.tenantId, status: 'live', deletedAt: null, endAt: { lt: now } },
    take: 200,
  });

  for (const row of expired) {
    await raiseException({
      code: 'EX-MKT-010',
      label: 'Campaign live past endAt',
      severity: 'S1_ATTENTION',
      subjectType: 'marketing_campaign',
      subjectId: row.id,
      subjectLabel: `${row.recordCode} — ${row.name}`,
      domain: 'mkt',
      detail: `Campaign end date ${row.endAt.toISOString()} has passed but the campaign is still live.`,
      ownerPartyId: row.ownerPartyId,
      triggerFingerprint: `mkt_campaign_expired:${row.id}`,
      ladderRung: 0,
    });
  }

  return expired.length;
}

/** EX-MKT-004 — a live campaign with no touchpoint recorded in the policy's stale-campaign window. */
export async function detectStaleCampaigns(): Promise<number> {
  const auth = currentAuth();
  const policy = await getMarketingPolicy(auth.tenantId);
  const cutoff = new Date(Date.now() - policy.staleCampaignDays * 86_400_000);

  const live = await prisma.marketingCampaign.findMany({
    where: { tenantId: auth.tenantId, status: 'live', deletedAt: null, startAt: { lt: cutoff } },
    take: 200,
  });

  let count = 0;
  for (const row of live) {
    const lastTouch = await prisma.marketingTouchpoint.findFirst({
      where: { tenantId: auth.tenantId, campaignId: row.id, deletedAt: null },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    const lastActivity = lastTouch?.occurredAt ?? row.startAt;
    if (lastActivity < cutoff) {
      count += 1;
      await raiseException({
        code: 'EX-MKT-004',
        label: 'Live campaign with no touchpoints',
        severity: 'S1_ATTENTION',
        subjectType: 'marketing_campaign',
        subjectId: row.id,
        subjectLabel: `${row.recordCode} — ${row.name}`,
        domain: 'mkt',
        detail: `No touchpoint recorded in the last ${policy.staleCampaignDays} days.`,
        ownerPartyId: row.ownerPartyId,
        triggerFingerprint: `mkt_campaign_stale:${policy.staleCampaignDays}:${row.id}`,
        ladderRung: 0,
      });
    }
  }
  return count;
}

export { CAMPAIGN_STATUSES, CAMPAIGN_TRANSITIONS };
