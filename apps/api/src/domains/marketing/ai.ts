/**
 * Marketing AI touchpoints (MKT-GOV-004/005, AI-MKT-001 through AI-MKT-005).
 *
 * Every draft goes through the same governed `propose()` entry point as
 * every other agent in the platform — there is no private write path here.
 * Drafts are produced by deterministic template heuristics, never an
 * external model call, and every kind classifies at DRAFT or RECOMMEND: the
 * agent never sends a message, never approves a budget, never queues a send.
 */

import { AI_TOUCHPOINTS, type AiTierCode } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { propose } from '../../agents/index.js';

const AGENT_KEY = 'marketing-assistant';

export type DraftKind = 'campaign_brief' | 'copy' | 'subject_lines' | 'segment' | 'next_best_action';

const TOOL_BY_KIND: Record<DraftKind, string> = {
  campaign_brief: 'tool.mkt.draft_campaign_brief',
  copy: 'tool.mkt.suggest_message_copy',
  subject_lines: 'tool.mkt.suggest_message_copy',
  segment: 'tool.mkt.suggest_audience',
  next_best_action: 'tool.mkt.suggest_next_action',
};

/** The AI-MKT-* entries from the shared touchpoint catalogue, for the settings surface. */
export function listTouchpoints() {
  return AI_TOUCHPOINTS.filter((t) => t.code.startsWith('AI-MKT-'));
}

/**
 * Idempotently registers the system agent that drafts marketing content.
 * Never granted a write tool — every touchpoint it declares classifies at
 * DRAFT or RECOMMEND, both of which require a human before anything happens.
 */
async function ensureMarketingAssistant(): Promise<void> {
  const auth = currentAuth();
  const tools = Object.values(TOOL_BY_KIND).filter((v, i, arr) => arr.indexOf(v) === i);
  await prisma.agentPrincipal.upsert({
    where: { tenantId_agentKey: { tenantId: auth.tenantId, agentKey: AGENT_KEY } },
    create: {
      tenantId: auth.tenantId,
      agentKey: AGENT_KEY,
      name: 'Marketing Assistant',
      purpose:
        'Drafts campaign briefs, message copy, subject lines, audience suggestions and next-best-actions from structured data. Never sends a message, never creates or evaluates an audience, never approves a budget or a send.',
      tier: 'DRAFT',
      declaredTools: tools,
    },
    update: { declaredTools: tools },
  });
}

function currency(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

async function draftCampaignBrief(context: Record<string, unknown>): Promise<string> {
  const name = (context.name as string) ?? 'the campaign';
  const objective = (context.objective as string) ?? 'lead_gen';
  const division = (context.division as string) ?? 'shared';
  const vertical = context.vertical as string | undefined;
  const targetLeads = context.targetLeads as number | undefined;
  const channelMix = (context.channelMix as string[] | undefined) ?? [];

  const lines = [
    `Draft brief — ${name}`,
    ``,
    `Objective: ${objective.replace(/_/g, ' ')}${vertical ? ` (${vertical})` : ''}, ${division} division.`,
    channelMix.length ? `Proposed channel mix: ${channelMix.join(', ')}.` : `Channel mix: to be confirmed with the audience owner.`,
    targetLeads ? `Target: ${targetLeads} leads across the flight window.` : `Target: set once historical channel conversion is reviewed.`,
    ``,
    `This is a draft for a human to edit before the campaign leaves draft status — nothing here has been sent or scheduled.`,
  ];
  return lines.join('\n');
}

async function draftCopy(context: Record<string, unknown>): Promise<string> {
  const offering = (context.offeringName as string) ?? (context.courseName as string) ?? 'our program';
  const division = (context.division as string) ?? 'shared';
  const objective = (context.objective as string) ?? 'lead_gen';
  const channelKey = (context.channelKey as string) ?? 'email';

  if (channelKey === 'sms' || channelKey === 'whatsapp') {
    return `Hi {{firstName}}, ${offering} admissions are open now. Reply YES to learn more or call us back. (${division})`;
  }
  return [
    `Subject: Discover ${offering}`,
    ``,
    `Hi {{firstName}},`,
    ``,
    `${offering} is now open for the ${objective.replace(/_/g, ' ')} track. We'd love to walk you through what it covers and how it fits your goals.`,
    ``,
    `Reply to this email or call us back and we'll take it from there.`,
  ].join('\n');
}

async function draftSubjectLines(context: Record<string, unknown>): Promise<string[]> {
  const offering = (context.offeringName as string) ?? (context.courseName as string) ?? 'this program';
  const division = (context.division as string) ?? 'shared';
  return [
    `${offering}: admissions open now`,
    `A closer look at ${offering}`,
    `${offering} — is it right for you?`,
    `Last chance: ${offering} enrolment closing soon`,
    `${division === 'education' ? 'New batch' : 'New cohort'} starting for ${offering}`,
  ];
}

/** Suggests a segment from the highest-converting channel/vertical combinations of the last 90 days. */
async function draftSegment(): Promise<string> {
  const auth = currentAuth();
  const since = new Date(Date.now() - 90 * 86_400_000);

  const leads = await prisma.lead.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: since }, channelKey: { not: null } },
    select: { id: true, channelKey: true, vertical: true },
  });
  if (leads.length === 0) {
    return 'Not enough attributed leads in the last 90 days to suggest a segment yet. Suggests a rule tree for a human to accept; it creates nothing on its own.';
  }

  const leadIds = leads.map((l) => l.id);
  const won = await prisma.opportunity.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, leadId: { in: leadIds }, outcome: 'won' },
    select: { leadId: true },
  });
  const wonLeadIds = new Set(won.map((o) => o.leadId));

  const byCombo = new Map<string, { leads: number; won: number }>();
  for (const l of leads) {
    const key = `${l.channelKey}:${l.vertical}`;
    const bucket = byCombo.get(key) ?? { leads: 0, won: 0 };
    bucket.leads += 1;
    if (wonLeadIds.has(l.id)) bucket.won += 1;
    byCombo.set(key, bucket);
  }

  const ranked = [...byCombo.entries()]
    .map(([key, v]) => ({ key, ...v, rate: v.leads > 0 ? v.won / v.leads : 0 }))
    .filter((r) => r.leads >= 3)
    .sort((a, b) => b.rate - a.rate);

  if (ranked.length === 0) {
    return 'No channel/vertical combination has enough volume yet (3+ leads) to suggest a segment with confidence.';
  }

  const top = ranked[0];
  const [channelKey, vertical] = top.key.split(':');
  return (
    `Suggested segment: leads from channel "${channelKey}" in the "${vertical}" vertical — ` +
    `${top.won} won of ${top.leads} leads in the last 90 days (${(top.rate * 100).toFixed(1)}% win rate), ` +
    `the strongest combination observed. Proposes a rule tree ({channelKey: "${channelKey}", vertical: "${vertical}"}) ` +
    `for a human to accept; it creates or evaluates no audience on its own.`
  );
}

/** Suggests the next touchpoint for a lead from its own touchpoint history. */
async function draftNextBestAction(context: Record<string, unknown>): Promise<string> {
  const leadId = context.leadId as string | undefined;
  if (!leadId) return 'No leadId supplied — cannot suggest a next-best-action without a lead to reason about.';

  const auth = currentAuth();
  const lead = await prisma.lead.findFirst({ where: { tenantId: auth.tenantId, id: leadId } });
  if (!lead) throw ApiError.notFound('Lead');

  const touchpoints = await prisma.marketingTouchpoint.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, leadId },
    orderBy: { occurredAt: 'desc' },
    take: 5,
  });

  const lastTouch = touchpoints[0];
  const daysSince = lastTouch ? Math.floor((Date.now() - lastTouch.occurredAt.getTime()) / 86_400_000) : null;

  if (!lastTouch) {
    return `No recorded touchpoint yet for ${lead.title}. Suggested next action: an initial outreach call to establish contact.`;
  }
  if (daysSince !== null && daysSince >= 5) {
    return `No touch in ${daysSince} days (last was ${lastTouch.channelKey}/${lastTouch.touchKind}). Suggested next action: call.`;
  }
  return `Last touch was ${daysSince} day${daysSince === 1 ? '' : 's'} ago via ${lastTouch.channelKey}/${lastTouch.touchKind}. Suggested next action: follow up on the same channel once the response window closes.`;
}

async function buildDraft(kind: DraftKind, context: Record<string, unknown>): Promise<string | string[]> {
  switch (kind) {
    case 'campaign_brief':
      return draftCampaignBrief(context);
    case 'copy':
      return draftCopy(context);
    case 'subject_lines':
      return draftSubjectLines(context);
    case 'segment':
      return draftSegment();
    case 'next_best_action':
      return draftNextBestAction(context);
    default:
      throw ApiError.badRequest(`Unknown draft kind '${kind as string}'.`);
  }
}

export interface DraftResult {
  actionId: string;
  tier: AiTierCode;
  draft: string | string[];
}

/**
 * POST /ai/draft. Registers an AgentAction proposal at the touchpoint's own
 * tier (DRAFT for brief/copy/subject-lines, RECOMMEND for segment/next-best-
 * action) and returns the deterministic draft alongside it. The proposal is
 * the durable, reviewable record; the draft text is never auto-applied
 * anywhere — a human reviews it from the agent action.
 */
export async function draft(kind: DraftKind, context: Record<string, unknown> = {}): Promise<DraftResult> {
  await ensureMarketingAssistant();
  const draftValue = await buildDraft(kind, context);

  const subjectId =
    (context.campaignId as string | undefined) ?? (context.leadId as string | undefined) ?? (context.templateId as string | undefined) ?? 'ad-hoc';

  const result = await propose({
    agentKey: AGENT_KEY,
    tool: TOOL_BY_KIND[kind],
    action: `mkt.draft.${kind}`,
    subjectType: kind === 'next_best_action' ? 'lead' : kind === 'segment' ? 'marketing_audience' : 'marketing_campaign',
    subjectId,
    proposal: { kind, context, draft: draftValue },
    rationale: `Deterministic template draft for '${kind}', generated for human review. Never auto-sent, never auto-applied.`,
  });

  if (result.state === 'blocked') {
    throw ApiError.forbidden(result.blockedReason ?? 'This draft touchpoint is blocked.');
  }

  return { actionId: result.actionId, tier: result.tier, draft: draftValue };
}
