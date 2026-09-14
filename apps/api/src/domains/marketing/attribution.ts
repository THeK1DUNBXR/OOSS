/**
 * Attribution & lead scoring (MKT-CAP-004 through MKT-CAP-008).
 *
 * Touchpoints are an immutable log — this file exposes no update or delete on
 * `MarketingTouchpoint`, only `recordTouchpoint` (create) and `listTouchpoints`
 * (read). A correction is a new row, the way a ledger entry would be.
 *
 * Attribution rows are computed and stored (`MarketingAttribution`), never
 * derived at render time — `computeAttribution` replaces the prior rows for a
 * subject+model rather than appending to them, so a re-run is idempotent.
 *
 * Lead scoring layers marketing's own rule set on top of CRM's `scoreLead()`
 * (`domains/leads.ts`) — marketing never overwrites or removes a CRM reason,
 * it only appends its own, each one prefixed `mkt:` so the two are always
 * told apart in `Lead.scoreReasons`.
 */

import { randomUUID } from 'node:crypto';
import {
  EVENTS,
  ATTRIBUTION_MODELS,
  type AttributionModel,
  type ChannelKey,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { scoreLead } from '../leads.js';

/** Sub-log tables never carry a human-facing record code (see RECORD_TYPE_CODES comment) — a short random one only needs to be unique per tenant. */
function internalCode(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Touchpoints — immutable
// ---------------------------------------------------------------------------

export interface TouchpointInput {
  personId?: string | null;
  organizationId?: string | null;
  leadId?: string | null;
  campaignId?: string | null;
  channelKey: string;
  touchKind: string;
  occurredAt?: Date;
  utm?: Record<string, unknown>;
  sourceRef?: string | null;
  cost?: number | null;
}

/** MKT-CAP-004: every touchpoint is immutable once recorded. No update/delete exists here, deliberately. */
export async function recordTouchpoint(input: TouchpointInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'create' });

  if (!input.personId && !input.organizationId && !input.leadId) {
    throw ApiError.badRequest('A touchpoint requires at least one of personId, organizationId or leadId.');
  }

  const touchpoint = await prisma.marketingTouchpoint.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: internalCode('TCH'),
      personId: input.personId ?? null,
      organizationId: input.organizationId ?? null,
      leadId: input.leadId ?? null,
      campaignId: input.campaignId ?? null,
      channelKey: input.channelKey,
      touchKind: input.touchKind,
      occurredAt: input.occurredAt ?? new Date(),
      utm: (input.utm ?? {}) as never,
      sourceRef: input.sourceRef ?? null,
      cost: input.cost ?? null,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_TOUCHPOINT_RECORDED,
    subject: { entityType: 'marketing_touchpoint', entityId: touchpoint.id, recordCode: touchpoint.recordCode },
    related: [
      ...(input.personId ? [{ relation: 'contact', entityType: 'person', entityId: input.personId }] : []),
      ...(input.leadId ? [{ relation: 'lead', entityType: 'lead', entityId: input.leadId }] : []),
      ...(input.campaignId ? [{ relation: 'campaign', entityType: 'marketing_campaign', entityId: input.campaignId }] : []),
    ],
    newState: { channelKey: input.channelKey, touchKind: input.touchKind },
  });

  return touchpoint;
}

export interface TouchpointFilters {
  personId?: string;
  leadId?: string;
  campaignId?: string;
  from?: Date;
  to?: Date;
}

export async function listTouchpoints(filters: TouchpointFilters = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'campaigns', verb: 'view' });

  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.personId ? { personId: filters.personId } : {}),
    ...(filters.leadId ? { leadId: filters.leadId } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.from || filters.to
      ? { occurredAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const items = await prisma.marketingTouchpoint.findMany({ where: where as never, orderBy: { occurredAt: 'desc' }, take: 500 });
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// Attribution — computed and stored, never derived at render time
// ---------------------------------------------------------------------------

interface Touch {
  campaignId: string | null;
  channelKey: string;
  occurredAt: Date;
}

/** The sentinel used on an attribution row for a subject that reached zero touches — the "Unattributed" category. */
const UNATTRIBUTED_CHANNEL = '';

function weightsForModel(model: AttributionModel, n: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [1];
  if (model === 'first_touch') return [1, ...Array(n - 1).fill(0)];
  if (model === 'last_touch') return [...Array(n - 1).fill(0), 1];
  if (model === 'linear') return Array(n).fill(1 / n);
  // position_based: 40% first, 40% last, 20% split across the middle touches.
  if (n === 2) return [0.5, 0.5];
  const middleCount = n - 2;
  const middleWeight = 0.2 / middleCount;
  return [0.4, ...Array(middleCount).fill(middleWeight), 0.4];
}

async function touchesForPerson(personId: string, upTo: Date): Promise<Touch[]> {
  const rows = await prisma.marketingTouchpoint.findMany({
    where: { personId, occurredAt: { lte: upTo }, deletedAt: null },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((r) => ({ campaignId: r.campaignId, channelKey: r.channelKey, occurredAt: r.occurredAt }));
}

async function writeAttributionRows(
  subjectField: 'leadId' | 'opportunityId' | 'enrollmentId',
  subjectId: string,
  touches: Touch[],
): Promise<number> {
  const auth = currentAuth();
  let written = 0;

  for (const model of ATTRIBUTION_MODELS) {
    // Replaces prior rows for this subject+model — computed and stored, never
    // appended to, so a re-run is idempotent rather than duplicating history.
    await prisma.marketingAttribution.deleteMany({ where: { [subjectField]: subjectId, model } as never });

    if (touches.length === 0) {
      await prisma.marketingAttribution.create({
        data: {
          tenantId: auth.tenantId,
          recordCode: internalCode('ATB'),
          [subjectField]: subjectId,
          model,
          campaignId: null,
          channelKey: UNATTRIBUTED_CHANNEL,
          weight: 1,
          createdById: auth.partyId,
        } as never,
      });
      written += 1;
      continue;
    }

    const weights = weightsForModel(model, touches.length);
    for (let i = 0; i < touches.length; i += 1) {
      if (weights[i] <= 0) continue;
      await prisma.marketingAttribution.create({
        data: {
          tenantId: auth.tenantId,
          recordCode: internalCode('ATB'),
          [subjectField]: subjectId,
          model,
          campaignId: touches[i].campaignId,
          channelKey: touches[i].channelKey || UNATTRIBUTED_CHANNEL,
          weight: weights[i],
          createdById: auth.partyId,
        } as never,
      });
      written += 1;
    }
  }

  return written;
}

/**
 * Computes and stores attribution for every Lead created in [from, to], and
 * for its converted Opportunity and any Enrollment linked to that
 * Opportunity, when they exist. Returns the number of leads processed.
 */
export async function computeAttribution(from: Date, to: Date): Promise<number> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });

  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: from, lte: to } },
    select: { id: true, personId: true, campaignId: true, channelKey: true, createdAt: true, convertedOpportunityId: true },
  });

  let processed = 0;
  for (const lead of leads) {
    const touches: Touch[] = lead.personId ? await touchesForPerson(lead.personId, lead.createdAt) : [];
    if (lead.campaignId || lead.channelKey) {
      touches.push({ campaignId: lead.campaignId, channelKey: lead.channelKey ?? UNATTRIBUTED_CHANNEL, occurredAt: lead.createdAt });
    }
    touches.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    const rowsForLead = await writeAttributionRows('leadId', lead.id, touches);
    let rowsForOpportunity = 0;
    let rowsForEnrollment = 0;

    if (lead.convertedOpportunityId) {
      rowsForOpportunity = await writeAttributionRows('opportunityId', lead.convertedOpportunityId, touches);
      const enrollment = await prisma.enrollment.findFirst({ where: { opportunityId: lead.convertedOpportunityId } });
      if (enrollment) rowsForEnrollment = await writeAttributionRows('enrollmentId', enrollment.id, touches);
    }

    await emit({
      name: EVENTS.MKT_ATTRIBUTION_COMPUTED,
      subject: { entityType: 'lead', entityId: lead.id },
      newState: { touchCount: touches.length, rowsForLead, rowsForOpportunity, rowsForEnrollment },
    });
    processed += 1;
  }

  return processed;
}

export async function attributionForLead(leadId: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  return prisma.marketingAttribution.findMany({ where: { leadId }, orderBy: [{ model: 'asc' }, { weight: 'desc' }] });
}

export interface AttributionSummaryRow {
  campaignId: string | null;
  campaignName: string | null;
  channelKey: string;
  weightedLeads: number;
  weightedWon: number;
  weightedValue: number;
}

/** Groups computed attribution rows by campaign/channel for the given model and window. */
export async function summarise(model: AttributionModel, from: Date, to: Date): Promise<AttributionSummaryRow[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });

  const rows = await prisma.marketingAttribution.findMany({
    where: { tenantId: auth.tenantId, model, computedAt: { gte: from, lte: to } },
    include: { campaign: { select: { name: true } } },
  });

  const groups = new Map<string, AttributionSummaryRow>();
  const key = (campaignId: string | null, channelKey: string) => `${campaignId ?? '-'}::${channelKey}`;

  for (const row of rows) {
    const k = key(row.campaignId, row.channelKey);
    if (!groups.has(k)) {
      groups.set(k, {
        campaignId: row.campaignId,
        campaignName: row.campaign?.name ?? (row.campaignId ? null : 'Unattributed'),
        channelKey: row.channelKey,
        weightedLeads: 0,
        weightedWon: 0,
        weightedValue: 0,
      });
    }
    const g = groups.get(k)!;
    const weight = num(row.weight) ?? 0;

    if (row.leadId) g.weightedLeads += weight;

    if (row.opportunityId) {
      const opp = await prisma.opportunity.findFirst({
        where: { id: row.opportunityId },
        select: { outcome: true, expectedValue: true },
      });
      if (opp?.outcome === 'won') {
        g.weightedWon += weight;
        g.weightedValue += weight * (num(opp.expectedValue) ?? 0);
      }
    }
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Lead score rules (MKT-CAP-007)
// ---------------------------------------------------------------------------

export interface ScoreRuleCondition {
  /** 'source' | 'channelKey' | 'touchpointCount' | 'campaignObjective' | 'formFromPaidChannel' | 'engagementOpenedAndClicked' */
  field: string;
  op: 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'in';
  value: unknown;
}

export interface ScoreRuleInput {
  name: string;
  condition: ScoreRuleCondition;
  points: number;
  active?: boolean;
  order?: number;
}

export async function createScoreRule(input: ScoreRuleInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'create' });
  return prisma.marketingLeadScoreRule.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: internalCode('SCR'),
      name: input.name,
      condition: input.condition as never,
      points: input.points,
      active: input.active ?? true,
      order: input.order ?? 0,
      createdById: auth.partyId,
    },
  });
}

export async function listScoreRules() {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  return prisma.marketingLeadScoreRule.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { order: 'asc' } });
}

export async function updateScoreRule(id: string, patch: Partial<ScoreRuleInput>) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const existing = await prisma.marketingLeadScoreRule.findFirst({ where: { id } });
  if (!existing) throw ApiError.notFound('Score rule');
  return prisma.marketingLeadScoreRule.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.condition !== undefined ? { condition: patch.condition as never } : {}),
      ...(patch.points !== undefined ? { points: patch.points } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.order !== undefined ? { order: patch.order } : {}),
    },
  });
}

export async function deleteScoreRule(id: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'delete' });
  const existing = await prisma.marketingLeadScoreRule.findFirst({ where: { id } });
  if (!existing) throw ApiError.notFound('Score rule');
  return prisma.marketingLeadScoreRule.update({ where: { id }, data: { deletedAt: new Date() } });
}

const PAID_CHANNEL_FALLBACK = new Set(['google_ads', 'social_meta', 'social_linkedin', 'social_youtube']);

async function isPaidChannel(channelKey: string | null): Promise<boolean> {
  if (!channelKey) return false;
  const channel = await prisma.marketingChannel.findFirst({ where: { key: channelKey } });
  if (channel) return channel.kind === 'paid';
  return PAID_CHANNEL_FALLBACK.has(channelKey);
}

/** Evaluates one rule's condition against a lead's derived scoring context. Unknown fields never match. */
function conditionMatches(condition: ScoreRuleCondition, ctx: Record<string, unknown>): boolean {
  const actual = ctx[condition.field];
  if (actual === undefined) return false;
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'gte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
    case 'lte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual);
    default:
      return false;
  }
}

async function scoringContextFor(lead: {
  id: string;
  personId: string | null;
  campaignId: string | null;
  channelKey: string | null;
  source: string;
}): Promise<Record<string, unknown>> {
  const touchpointCount = await prisma.marketingTouchpoint.count({
    where: lead.personId ? { personId: lead.personId } : { leadId: lead.id },
  });

  const campaign = lead.campaignId
    ? await prisma.marketingCampaign.findFirst({ where: { id: lead.campaignId }, select: { objective: true } })
    : null;

  const formFromPaidChannel = lead.source === 'form' && (await isPaidChannel(lead.channelKey));

  // "opened+clicked email": this person has at least one send recipient row
  // that reached 'opened' and at least one that reached 'clicked' — the
  // messaging domain's own delivery-event tracking, read here rather than
  // duplicated.
  let engagementOpenedAndClicked = false;
  if (lead.personId) {
    const [opened, clicked] = await Promise.all([
      prisma.marketingSendRecipient.count({ where: { personId: lead.personId, status: { in: ['opened', 'clicked'] } } }),
      prisma.marketingSendRecipient.count({ where: { personId: lead.personId, status: 'clicked' } }),
    ]);
    engagementOpenedAndClicked = opened > 0 && clicked > 0;
  }

  return {
    source: lead.source,
    channelKey: lead.channelKey,
    touchpointCount,
    campaignObjective: campaign?.objective ?? null,
    formFromPaidChannel,
    engagementOpenedAndClicked,
  };
}

/**
 * The default rule set a tenant starts with — transparent and reversible,
 * matching the marketing-skeleton's stated examples. Idempotent: re-running
 * against a tenant that already has these five (by name) is a no-op for the
 * ones that exist.
 */
export async function seedDefaultScoreRules(tenantId: string): Promise<number> {
  const existing = await prisma.marketingLeadScoreRule.findMany({ where: { tenantId }, select: { name: true } });
  const existingNames = new Set(existing.map((r) => r.name));

  const seeds: Array<{ name: string; condition: ScoreRuleCondition; points: number; order: number }> = [
    { name: 'Referral source', condition: { field: 'source', op: 'eq', value: 'referral' }, points: 20, order: 1 },
    { name: 'Event attended', condition: { field: 'source', op: 'eq', value: 'event' }, points: 15, order: 2 },
    { name: 'Form from a paid channel', condition: { field: 'formFromPaidChannel', op: 'eq', value: true }, points: 10, order: 3 },
    { name: 'Three or more touchpoints', condition: { field: 'touchpointCount', op: 'gte', value: 3 }, points: 10, order: 4 },
    { name: 'Opened and clicked an email', condition: { field: 'engagementOpenedAndClicked', op: 'eq', value: true }, points: 5, order: 5 },
  ];

  let created = 0;
  for (const seed of seeds) {
    if (existingNames.has(seed.name)) continue;
    await prisma.marketingLeadScoreRule.create({
      data: {
        tenantId,
        recordCode: internalCode('SCR'),
        name: seed.name,
        condition: seed.condition as never,
        points: seed.points,
        active: true,
        order: seed.order,
      },
    });
    created += 1;
  }
  return created;
}

export interface ScorePreview {
  score: number;
  reasons: string[];
}

/**
 * MKT-CAP-007: {score, reasons} = CRM's own scoreLead() result, plus
 * marketing's rule points — each marketing reason prefixed `mkt:` so the two
 * are never confused. Recomputes the CRM component fresh from the lead's
 * current person/organization/offering data (the same inputs `createLead`
 * used), rather than re-parsing the persisted `scoreReasons[]` text.
 */
export async function previewScore(leadId: string): Promise<ScorePreview> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });

  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: auth.tenantId } });
  if (!lead) throw ApiError.notFound('Lead');

  const person = lead.personId ? await prisma.person.findFirst({ where: { id: lead.personId } }) : null;

  const crm = scoreLead({
    hasEmail: Boolean(person?.primaryEmail),
    hasPhone: Boolean(person?.primaryPhone),
    hasOrganization: Boolean(lead.organizationId),
    hasOffering: Boolean(lead.offeringId),
    estimatedValue: num(lead.estimatedValue),
    source: lead.source,
  });

  const rules = await prisma.marketingLeadScoreRule.findMany({
    where: { tenantId: auth.tenantId, active: true, deletedAt: null },
    orderBy: { order: 'asc' },
  });
  const ctx = await scoringContextFor(lead);

  let mktPoints = 0;
  const mktReasons: string[] = [];
  for (const rule of rules) {
    if (conditionMatches(rule.condition as unknown as ScoreRuleCondition, ctx)) {
      mktPoints += rule.points;
      mktReasons.push(`mkt:+${rule.points} ${rule.name}`);
    }
  }

  const score = Math.max(0, Math.min(100, crm.score + mktPoints));
  return { score, reasons: [...crm.reasons, ...mktReasons] };
}

/**
 * Recomputes score + reasons for every open lead and writes them back.
 * Marketing reasons are always freshly regenerated (never re-read from the
 * prior write), so a stale `mkt:` reason from an earlier run is replaced, not
 * accumulated — and CRM's own reasons, recomputed identically from the same
 * pure function, are never altered by this pass.
 */
export async function applyScores(): Promise<number> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });

  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, leadStatus: 'open', deletedAt: null },
    select: { id: true },
  });

  for (const { id } of leads) {
    const { score, reasons } = await previewScore(id);
    await prisma.lead.update({ where: { id }, data: { score, scoreReasons: reasons } });
  }

  return leads.length;
}

// ---------------------------------------------------------------------------
// Detector: unattributed leads (EX-MKT-001 / MKT-CAP-006)
// ---------------------------------------------------------------------------

const UNATTRIBUTED_ELIGIBLE_SOURCES = ['manual', 'web_enquiry', 'inbound_website', 'campaign'];

/**
 * Open leads created in the last 30 days with no campaign, no channel, and a
 * source that should normally have carried one. Idempotent via
 * `raiseException`'s own trigger-fingerprint lookup — no separate "notified"
 * marker is needed on Lead for this.
 */
export async function detectUnattributedLeads(): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - 30 * 86_400_000);

  const leads = await prisma.lead.findMany({
    where: {
      tenantId: auth.tenantId,
      leadStatus: 'open',
      deletedAt: null,
      campaignId: null,
      channelKey: null,
      createdAt: { gte: cutoff },
      source: { in: UNATTRIBUTED_ELIGIBLE_SOURCES },
    },
    take: 200,
  });

  for (const lead of leads) {
    await raiseException({
      code: 'EX-MKT-001',
      label: 'Lead created with no attributable source',
      severity: 'S1_ATTENTION',
      domain: 'mkt',
      subjectType: 'lead',
      subjectId: lead.id,
      subjectLabel: `${lead.recordCode} — ${lead.title}`,
      detail: `Created via source '${lead.source}' with no campaign or channel attribution.`,
      ownerPartyId: lead.ownerPartyId,
      triggerFingerprint: 'lead_unattributed',
      ladderRung: 0,
    });
  }

  return leads.length;
}

// ---------------------------------------------------------------------------
// Legacy-named aliases — kept so `domains/marketing/index.ts`'s barrel export
// (`recordTouchpoint, computeAttribution, updateLeadScoreRule,
// listLeadScoreRules, scoreLeadNow`) keeps resolving.
// ---------------------------------------------------------------------------

export const listLeadScoreRules = listScoreRules;

export async function updateLeadScoreRule(data: { name: string; condition: object; points: number; active: boolean }) {
  return createScoreRule({ ...data, condition: data.condition as ScoreRuleCondition });
}

export async function scoreLeadNow(leadId: string): Promise<{ score: number }> {
  const { score } = await previewScore(leadId);
  return { score };
}

export type { ChannelKey };
