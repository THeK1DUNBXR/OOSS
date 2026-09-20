/**
 * Marketing analytics (MKT-ANA-001 through MKT-ANA-008).
 *
 * Reads directly from the marketing capture surface (MarketingTouchpoint,
 * MarketingCampaign, MarketingSpend, MarketingSend) and the CRM funnel
 * (Lead -> Opportunity -> Enrollment), attributed via `Lead.campaignId` /
 * `Lead.channelKey` — the join a lead carries from the marketing capture
 * pipeline (never required, never fabricated when absent).
 *
 * Every ratio here follows the health-scoring convention used across the
 * platform (see domains/health.ts): a rate with a zero denominator is
 * reported as `null`, never as zero — a confidently-wrong 0% is worse than an
 * honestly missing number.
 */

import { ATTRIBUTION_MODELS, type AttributionModel } from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { assertCan } from '../../platform/permissions.js';

const QUALIFIED_POSITION = 30;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return lines.join('\n');
}

/** Campaign ids matching a division/campaignId filter, or `undefined` for "no filter". */
async function campaignFilterIds(division?: string, campaignId?: string): Promise<string[] | undefined> {
  const auth = currentAuth();
  if (campaignId) return [campaignId];
  if (!division) return undefined;
  const rows = await prisma.marketingCampaign.findMany({
    where: { tenantId: auth.tenantId, division, deletedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// KPI overview
// ---------------------------------------------------------------------------

export interface KpiTile {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  measured: boolean;
}

export interface MarketingOverviewView {
  kpis: KpiTile[];
  funnel: MarketingFunnelView;
  liveCampaigns: Array<{ id: string; recordCode: string; name: string; status: string; division: string; startAt: string; endAt: string }>;
  attention: Array<{ code: string; label: string; count: number }>;
}

export async function overview(): Promise<MarketingOverviewView> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();

  const from = daysAgo(30);
  const to = new Date();

  const [liveCampaigns, leadsThisMonth, spendThisMonth, sendsRecent, consented, contacted, budgetCheck, staleCampaigns] =
    await Promise.all([
      prisma.marketingCampaign.findMany({
        where: { tenantId: auth.tenantId, status: 'live', deletedAt: null },
        orderBy: { startAt: 'desc' },
        take: 20,
      }),
      prisma.lead.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to }, OR: [{ campaignId: { not: null } }, { channelKey: { not: null } }] },
        select: { id: true },
      }),
      prisma.marketingSpend.aggregate({
        where: { tenantId: auth.tenantId, deletedAt: null, spendDate: { gte: from, lte: to } },
        _sum: { amount: true },
      }),
      prisma.marketingSend.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, status: 'sent', sentAt: { gte: from, lte: to } },
        select: { recipientCount: true, deliveredCount: true, bouncedCount: true },
      }),
      prisma.consent.count({ where: { tenantId: auth.tenantId, purposeCode: 'marketing', status: 'granted' } }),
      prisma.marketingTouchpoint.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, personId: { not: null }, occurredAt: { gte: daysAgo(90) } },
        distinct: ['personId'],
        select: { personId: true },
      }),
      prisma.marketingCampaign.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null },
        select: { budgetPlanned: true, budgetActual: true },
      }),
      prisma.marketingCampaign.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, status: 'live' },
        select: { id: true, touchpoints: { where: { occurredAt: { gte: daysAgo(7) } }, take: 1, select: { id: true } } },
      }),
    ]);

  const overBudgetCount = budgetCheck.filter((c) => (num(c.budgetActual) ?? 0) > (num(c.budgetPlanned) ?? 0)).length;
  const staleCampaignCount = staleCampaigns.filter((c) => c.touchpoints.length === 0).length;

  const spend = num(spendThisMonth._sum.amount) ?? 0;
  const leadCount = leadsThisMonth.length;
  const costPerLead = leadCount > 0 ? spend / leadCount : null;

  const recipients = sendsRecent.reduce((s, r) => s + r.recipientCount, 0);
  const delivered = sendsRecent.reduce((s, r) => s + r.deliveredCount, 0);
  const bounced = sendsRecent.reduce((s, r) => s + r.bouncedCount, 0);
  const deliverable = recipients - bounced;
  const deliverability = deliverable > 0 ? delivered / deliverable : null;

  const contactedCount = contacted.length;
  const coverage = contactedCount > 0 ? Math.min(consented / contactedCount, 1) : null;

  const attributedLeadIds = leadsThisMonth.map((l) => l.id);
  const wonOpps = attributedLeadIds.length
    ? await prisma.opportunity.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: attributedLeadIds }, outcome: null },
        select: { expectedValue: true },
      })
    : [];
  const pipelineValue = wonOpps.reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0);

  const funnelView = await funnel({ from, to });

  const kpis: KpiTile[] = [
    { key: 'live_campaigns', label: 'Live campaigns', value: liveCampaigns.length, unit: 'count', measured: true },
    { key: 'leads_attributed', label: 'Leads this month (attributed)', value: leadCount, unit: 'count', measured: true },
    { key: 'cost_per_lead', label: 'Cost per lead', value: costPerLead, unit: 'currency', measured: costPerLead !== null },
    { key: 'consent_coverage', label: 'Consent coverage', value: coverage, unit: 'ratio', measured: coverage !== null },
    { key: 'send_deliverability', label: 'Send deliverability', value: deliverability, unit: 'ratio', measured: deliverability !== null },
    { key: 'pipeline_value', label: 'Pipeline value (marketing-attributed)', value: pipelineValue, unit: 'currency', measured: true },
  ];

  return {
    kpis,
    funnel: funnelView,
    liveCampaigns: liveCampaigns.map((c) => ({
      id: c.id,
      recordCode: c.recordCode,
      name: c.name,
      status: c.status,
      division: c.division,
      startAt: c.startAt.toISOString(),
      endAt: c.endAt.toISOString(),
    })),
    attention: [
      { code: 'over_budget', label: 'Campaigns over planned budget', count: overBudgetCount },
      { code: 'stale_campaign', label: 'Live campaigns with no touchpoints in 7 days', count: staleCampaignCount },
    ],
  };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export interface FunnelStage {
  key: 'touchpoints' | 'leads' | 'qualified' | 'opportunities' | 'won' | 'enrolments';
  label: string;
  count: number;
  measured: boolean;
}

export interface MarketingFunnelView {
  stages: FunnelStage[];
  conversionRates: Array<{ from: string; to: string; rate: number | null }>;
}

export interface FunnelParams {
  from?: Date;
  to?: Date;
  division?: string;
  campaignId?: string;
}

export async function funnel(params: FunnelParams = {}): Promise<MarketingFunnelView> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();
  const from = params.from ?? daysAgo(30);
  const to = params.to ?? new Date();
  const campaignIds = await campaignFilterIds(params.division, params.campaignId);

  const touchpointWhere = {
    tenantId: auth.tenantId,
    deletedAt: null,
    occurredAt: { gte: from, lte: to },
    ...(campaignIds ? { campaignId: { in: campaignIds } } : {}),
  } as const;

  const [touchpointCount, touchpointLeadRows] = await Promise.all([
    prisma.marketingTouchpoint.count({ where: touchpointWhere }),
    prisma.marketingTouchpoint.findMany({ where: { ...touchpointWhere, leadId: { not: null } }, select: { leadId: true } }),
  ]);
  const touchpointLeadIds = [...new Set(touchpointLeadRows.map((r) => r.leadId as string))];

  const leadWhereAnd: Record<string, unknown>[] = [
    { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    {
      OR: [
        { campaignId: { not: null } },
        { channelKey: { not: null } },
        ...(touchpointLeadIds.length ? [{ id: { in: touchpointLeadIds } }] : []),
      ],
    },
  ];
  if (campaignIds) leadWhereAnd.push({ campaignId: { in: campaignIds } });

  const leads = await prisma.lead.findMany({
    where: { AND: leadWhereAnd } as never,
    select: { id: true, pipelineId: true, stageKey: true, convertedOpportunityId: true },
  });
  const leadCount = leads.length;

  const stageRows = leads.length
    ? await prisma.pipelineStage.findMany({
        where: { tenantId: auth.tenantId, pipelineId: { in: [...new Set(leads.map((l) => l.pipelineId))] } },
        select: { pipelineId: true, stageKey: true, pipelinePosition: true },
      })
    : [];
  const positionOf = new Map(stageRows.map((s) => [`${s.pipelineId}:${s.stageKey}`, s.pipelinePosition]));
  const qualifiedCount = leads.filter((l) => (positionOf.get(`${l.pipelineId}:${l.stageKey}`) ?? 0) >= QUALIFIED_POSITION).length;

  const leadIds = leads.map((l) => l.id);
  const opportunities = leadIds.length
    ? await prisma.opportunity.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds } }, select: { id: true, outcome: true } })
    : [];
  const opportunityCount = opportunities.length;
  const wonCount = opportunities.filter((o) => o.outcome === 'won').length;

  const oppIds = opportunities.map((o) => o.id);
  const enrolmentCount = oppIds.length
    ? await prisma.enrollment.count({ where: { tenantId: auth.tenantId, opportunityId: { in: oppIds } } })
    : 0;

  const rate = (numerator: number, denominator: number): number | null => (denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null);

  const stages: FunnelStage[] = [
    { key: 'touchpoints', label: 'Touchpoints', count: touchpointCount, measured: true },
    { key: 'leads', label: 'Leads', count: leadCount, measured: true },
    { key: 'qualified', label: 'Qualified', count: qualifiedCount, measured: true },
    { key: 'opportunities', label: 'Opportunities', count: opportunityCount, measured: true },
    { key: 'won', label: 'Won', count: wonCount, measured: true },
    { key: 'enrolments', label: 'Enrolments', count: enrolmentCount, measured: true },
  ];

  const conversionRates = [
    { from: 'touchpoints', to: 'leads', rate: rate(leadCount, touchpointCount) },
    { from: 'leads', to: 'qualified', rate: rate(qualifiedCount, leadCount) },
    { from: 'qualified', to: 'opportunities', rate: rate(opportunityCount, qualifiedCount) },
    { from: 'opportunities', to: 'won', rate: rate(wonCount, opportunityCount) },
    { from: 'won', to: 'enrolments', rate: rate(enrolmentCount, wonCount) },
  ];

  return { stages, conversionRates };
}

// ---------------------------------------------------------------------------
// Channel performance
// ---------------------------------------------------------------------------

export interface ChannelPerformanceView {
  channelKey: string;
  label: string;
  touchpoints: number;
  leads: number;
  opportunities: number;
  won: number;
  spend: number;
  costPerLead: number | null;
  roi: number | null;
  measured: boolean;
}

export async function channels(params: { from?: Date; to?: Date } = {}): Promise<ChannelPerformanceView[]> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();
  const from = params.from ?? daysAgo(90);
  const to = params.to ?? new Date();

  const [touchpoints, leads, spends] = await Promise.all([
    prisma.marketingTouchpoint.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, occurredAt: { gte: from, lte: to } },
      select: { channelKey: true, leadId: true },
    }),
    prisma.lead.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to }, channelKey: { not: null } },
      select: { id: true, channelKey: true },
    }),
    prisma.marketingSpend.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, spendDate: { gte: from, lte: to } },
      select: { channelKey: true, amount: true },
    }),
  ]);

  const leadIdsByChannel = new Map<string, string[]>();
  for (const l of leads) {
    const key = l.channelKey as string;
    leadIdsByChannel.set(key, [...(leadIdsByChannel.get(key) ?? []), l.id]);
  }

  const allLeadIds = leads.map((l) => l.id);
  const opps = allLeadIds.length
    ? await prisma.opportunity.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: allLeadIds } }, select: { leadId: true, outcome: true, expectedValue: true } })
    : [];
  const leadToChannel = new Map(leads.map((l) => [l.id, l.channelKey as string]));

  const channelKeys = new Set<string>([
    ...touchpoints.map((t) => t.channelKey),
    ...leads.map((l) => l.channelKey as string),
    ...spends.map((s) => s.channelKey),
  ]);

  const result: ChannelPerformanceView[] = [];
  for (const key of channelKeys) {
    const tpCount = touchpoints.filter((t) => t.channelKey === key).length;
    const leadIds = leadIdsByChannel.get(key) ?? [];
    const channelOpps = opps.filter((o) => o.leadId && leadToChannel.get(o.leadId) === key);
    const wonOpps = channelOpps.filter((o) => o.outcome === 'won');
    const spend = spends.filter((s) => s.channelKey === key).reduce((s, r) => s + (num(r.amount) ?? 0), 0);
    const revenue = wonOpps.reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0);

    result.push({
      channelKey: key,
      label: key,
      touchpoints: tpCount,
      leads: leadIds.length,
      opportunities: channelOpps.length,
      won: wonOpps.length,
      spend,
      costPerLead: leadIds.length > 0 ? Number((spend / leadIds.length).toFixed(2)) : null,
      roi: spend > 0 ? Number(((revenue - spend) / spend).toFixed(4)) : null,
      measured: true,
    });
  }

  return result.sort((a, b) => b.touchpoints - a.touchpoints);
}

// ---------------------------------------------------------------------------
// Campaign performance
// ---------------------------------------------------------------------------

export interface CampaignPerformanceView {
  campaignId: string;
  recordCode: string;
  name: string;
  status: string;
  division: string;
  leads: number;
  opportunities: number;
  won: number;
  enrolments: number;
  pipelineValue: number;
  spend: number;
  budgetPlanned: number;
  costPerLead: number | null;
  romi: number | null;
}

export async function campaigns(params: { from?: Date; to?: Date } = {}): Promise<CampaignPerformanceView[]> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();
  const from = params.from ?? daysAgo(180);
  const to = params.to ?? new Date();

  const camps = await prisma.marketingCampaign.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, startAt: { lte: to }, endAt: { gte: from } },
    orderBy: { startAt: 'desc' },
  });

  const result: CampaignPerformanceView[] = [];
  for (const c of camps) {
    const [leads, spendAgg] = await Promise.all([
      prisma.lead.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, campaignId: c.id }, select: { id: true } }),
      prisma.marketingSpend.aggregate({ where: { tenantId: auth.tenantId, deletedAt: null, campaignId: c.id }, _sum: { amount: true } }),
    ]);
    const leadIds = leads.map((l) => l.id);
    const opps = leadIds.length
      ? await prisma.opportunity.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds } }, select: { id: true, outcome: true, expectedValue: true } })
      : [];
    const won = opps.filter((o) => o.outcome === 'won');
    const oppIds = opps.map((o) => o.id);
    const enrolments = oppIds.length ? await prisma.enrollment.count({ where: { tenantId: auth.tenantId, opportunityId: { in: oppIds } } }) : 0;
    const pipelineValue = opps.filter((o) => o.outcome === null).reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0);
    const spend = num(spendAgg._sum.amount) ?? 0;

    result.push({
      campaignId: c.id,
      recordCode: c.recordCode,
      name: c.name,
      status: c.status,
      division: c.division,
      leads: leadIds.length,
      opportunities: opps.length,
      won: won.length,
      enrolments,
      pipelineValue,
      spend,
      budgetPlanned: num(c.budgetPlanned) ?? 0,
      costPerLead: leadIds.length > 0 ? Number((spend / leadIds.length).toFixed(2)) : null,
      romi: spend > 0 ? Number((pipelineValue / spend).toFixed(4)) : null,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Attribution summary
// ---------------------------------------------------------------------------

export interface AttributionRow {
  campaignId: string | null;
  campaignName: string;
  channelKey: string | null;
  weightedLeads: number;
  weightedWon: number;
  weightedValue: number;
}

export interface AttributionSummaryView {
  model: AttributionModel;
  rows: AttributionRow[];
}

/**
 * Computes weighted attribution directly from the touchpoint log — the raw
 * facts every attribution model derives from — rather than depending on
 * pre-materialised MarketingAttribution rows, so this stays correct even
 * before the attribution recompute job has run for a lead.
 */
export async function attributionSummary(model: AttributionModel, params: { from?: Date; to?: Date } = {}): Promise<AttributionSummaryView> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();
  const from = params.from ?? daysAgo(90);
  const to = params.to ?? new Date();
  const resolvedModel: AttributionModel = ATTRIBUTION_MODELS.includes(model) ? model : 'last_touch';

  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    select: { id: true },
  });
  if (leads.length === 0) return { model: resolvedModel, rows: [] };
  const leadIds = leads.map((l) => l.id);

  const [touchpoints, opps] = await Promise.all([
    prisma.marketingTouchpoint.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds } },
      orderBy: { occurredAt: 'asc' },
      select: { leadId: true, campaignId: true, channelKey: true, occurredAt: true },
    }),
    prisma.opportunity.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds } },
      select: { leadId: true, outcome: true, expectedValue: true },
    }),
  ]);

  const oppsByLead = new Map<string, { outcome: string | null; expectedValue: number | null }[]>();
  for (const o of opps) {
    if (!o.leadId) continue;
    oppsByLead.set(o.leadId, [...(oppsByLead.get(o.leadId) ?? []), { outcome: o.outcome, expectedValue: num(o.expectedValue) }]);
  }

  const touchpointsByLead = new Map<string, typeof touchpoints>();
  for (const t of touchpoints) {
    if (!t.leadId) continue;
    touchpointsByLead.set(t.leadId, [...(touchpointsByLead.get(t.leadId) ?? []), t]);
  }

  interface Weighted {
    campaignId: string | null;
    channelKey: string | null;
    weight: number;
  }

  function weightsFor(list: typeof touchpoints): Weighted[] {
    if (list.length === 0) return [];
    if (resolvedModel === 'first_touch') return [{ campaignId: list[0].campaignId, channelKey: list[0].channelKey, weight: 1 }];
    if (resolvedModel === 'last_touch') {
      const last = list[list.length - 1];
      return [{ campaignId: last.campaignId, channelKey: last.channelKey, weight: 1 }];
    }
    if (resolvedModel === 'linear') {
      const w = 1 / list.length;
      return list.map((t) => ({ campaignId: t.campaignId, channelKey: t.channelKey, weight: w }));
    }
    // position_based: 40% first, 40% last, 20% split across the middle.
    if (list.length === 1) return [{ campaignId: list[0].campaignId, channelKey: list[0].channelKey, weight: 1 }];
    if (list.length === 2) {
      return [
        { campaignId: list[0].campaignId, channelKey: list[0].channelKey, weight: 0.5 },
        { campaignId: list[1].campaignId, channelKey: list[1].channelKey, weight: 0.5 },
      ];
    }
    const middle = list.slice(1, -1);
    const middleWeight = middle.length ? 0.2 / middle.length : 0;
    return [
      { campaignId: list[0].campaignId, channelKey: list[0].channelKey, weight: 0.4 },
      ...middle.map((t) => ({ campaignId: t.campaignId, channelKey: t.channelKey, weight: middleWeight })),
      { campaignId: list[list.length - 1].campaignId, channelKey: list[list.length - 1].channelKey, weight: 0.4 },
    ];
  }

  const buckets = new Map<string, AttributionRow>();
  for (const leadId of leadIds) {
    const list = touchpointsByLead.get(leadId) ?? [];
    const weights = weightsFor(list);
    if (weights.length === 0) continue;
    const leadOpps = oppsByLead.get(leadId) ?? [];
    const wonOpps = leadOpps.filter((o) => o.outcome === 'won');
    const wonValue = wonOpps.reduce((s, o) => s + (o.expectedValue ?? 0), 0);

    for (const w of weights) {
      const bucketKey = `${w.campaignId ?? 'none'}:${w.channelKey ?? 'none'}`;
      const existing = buckets.get(bucketKey) ?? {
        campaignId: w.campaignId,
        campaignName: 'Unattributed',
        channelKey: w.channelKey,
        weightedLeads: 0,
        weightedWon: 0,
        weightedValue: 0,
      };
      existing.weightedLeads += w.weight;
      existing.weightedWon += w.weight * wonOpps.length;
      existing.weightedValue += w.weight * wonValue;
      buckets.set(bucketKey, existing);
    }
  }

  const campaignIds = [...buckets.values()].map((r) => r.campaignId).filter((id): id is string => !!id);
  const campaignNames = campaignIds.length
    ? await prisma.marketingCampaign.findMany({ where: { tenantId: auth.tenantId, id: { in: campaignIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(campaignNames.map((c) => [c.id, c.name]));

  const rows = [...buckets.values()].map((r) => ({
    ...r,
    campaignName: r.campaignId ? (nameOf.get(r.campaignId) ?? 'Unknown campaign') : 'Unattributed',
    weightedLeads: Number(r.weightedLeads.toFixed(4)),
    weightedWon: Number(r.weightedWon.toFixed(4)),
    weightedValue: Number(r.weightedValue.toFixed(2)),
  }));

  return { model: resolvedModel, rows: rows.sort((a, b) => b.weightedValue - a.weightedValue) };
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export interface CohortRow {
  cohort: string;
  leads: number;
  converted: number;
  enrolled: number;
  rate: number | null;
}

export async function cohorts(params: { by?: 'month' } = {}): Promise<CohortRow[]> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  const auth = currentAuth();

  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ campaignId: { not: null } }, { channelKey: { not: null } }] },
    select: { id: true, createdAt: true, convertedOpportunityId: true },
  });

  const leadIds = leads.map((l) => l.id);
  const opps = leadIds.length
    ? await prisma.opportunity.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds } }, select: { id: true, leadId: true } })
    : [];
  const oppIdsByLead = new Map<string, string[]>();
  for (const o of opps) {
    if (!o.leadId) continue;
    oppIdsByLead.set(o.leadId, [...(oppIdsByLead.get(o.leadId) ?? []), o.id]);
  }
  const allOppIds = opps.map((o) => o.id);
  const enrollments = allOppIds.length
    ? await prisma.enrollment.findMany({ where: { tenantId: auth.tenantId, opportunityId: { in: allOppIds } }, select: { opportunityId: true } })
    : [];
  const enrolledOppIds = new Set(enrollments.map((e) => e.opportunityId));

  const byCohort = new Map<string, { leads: number; converted: number; enrolled: number }>();
  for (const l of leads) {
    const cohort = l.createdAt.toISOString().slice(0, 7); // YYYY-MM
    const bucket = byCohort.get(cohort) ?? { leads: 0, converted: 0, enrolled: 0 };
    bucket.leads += 1;
    if (l.convertedOpportunityId) bucket.converted += 1;
    const oppIds = oppIdsByLead.get(l.id) ?? [];
    if (oppIds.some((id) => enrolledOppIds.has(id))) bucket.enrolled += 1;
    byCohort.set(cohort, bucket);
  }

  return [...byCohort.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cohort, v]) => ({ cohort, leads: v.leads, converted: v.converted, enrolled: v.enrolled, rate: v.leads > 0 ? Number((v.enrolled / v.leads).toFixed(4)) : null }));
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export type ExportKind = 'campaigns' | 'channels' | 'leads';

export async function exportCsv(kind: ExportKind, params: { from?: Date; to?: Date } = {}): Promise<string> {
  await assertCan({ resource: 'marketing_analytics', verb: 'export' });
  const auth = currentAuth();

  if (kind === 'campaigns') {
    const rows = await campaigns(params);
    return toCsv(rows as unknown as Array<Record<string, unknown>>);
  }
  if (kind === 'channels') {
    const rows = await channels(params);
    return toCsv(rows as unknown as Array<Record<string, unknown>>);
  }

  const from = params.from ?? daysAgo(90);
  const to = params.to ?? new Date();
  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    select: { recordCode: true, title: true, source: true, channelKey: true, campaignId: true, leadStatus: true, score: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  return toCsv(
    leads.map((l) => ({
      recordCode: l.recordCode,
      title: l.title,
      source: l.source,
      channelKey: l.channelKey ?? '',
      campaignId: l.campaignId ?? '',
      leadStatus: l.leadStatus,
      score: l.score,
      createdAt: l.createdAt.toISOString(),
    })),
  );
}
