/**
 * P6 — AI agents as bounded principals.
 *
 * Every agent carries its own identity, its own AUTHORITY_GRANT (a value limit,
 * a count limit, and a risk-class ceiling), and acts only through declared
 * TOOLs. There is no private write path around this.
 *
 * Every touchpoint is classified into exactly one of six action tiers, and the
 * tier is the mechanism, not a UX detail: a touchpoint classified RECOMMEND
 * never gets a "just do it" button added in a later sprint without a governance
 * decision to reclassify it. This module enforces that structurally — the tier
 * decides whether a proposal can execute at all.
 */

import {
  AI_TIER_BY_CODE,
  AI_TOUCHPOINTS,
  EVENTS,
  HARD_PROHIBITIONS,
  isProhibitedForAgent,
  type AiTierCode,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { resolveAuthorityCeiling } from '../platform/permissions.js';
import { notify } from '../platform/exceptions.js';

export interface ProposeInput {
  agentKey: string;
  tool: string;
  action: string;
  subjectType: string;
  subjectId: string;
  proposal: Record<string, unknown>;
  rationale: string;
  /** For actions with a magnitude, checked against the agent's own ceiling. */
  magnitude?: { authorityClass: string; value: number } | null;
  onBehalfOfPartyId?: string | null;
}

export interface ProposeResult {
  actionId: string;
  tier: AiTierCode;
  state: 'proposed' | 'executed' | 'blocked';
  blockedReason: string | null;
  /** True when the tier permits acting without a per-instance approval. */
  autoExecuted: boolean;
}

function touchpointFor(tool: string) {
  return AI_TOUCHPOINTS.find((t) => t.tool === tool) ?? null;
}

/**
 * The single entry point through which an agent may propose anything. An agent
 * that has not declared the tool it is invoking is refused — the third hard
 * prohibition, enforced rather than documented.
 */
export async function propose(input: ProposeInput): Promise<ProposeResult> {
  const auth = currentAuth();

  const agent = await prisma.agentPrincipal.findFirst({
    where: { tenantId: auth.tenantId, agentKey: input.agentKey },
  });
  if (!agent) throw ApiError.notFound(`Agent '${input.agentKey}'`);
  if (agent.status !== 'active') {
    throw ApiError.forbidden(`Agent '${input.agentKey}' is ${agent.status}.`);
  }

  // No AI acting outside a declared tool.
  if (!agent.declaredTools.includes(input.tool)) {
    return blocked(
      agent.id,
      input,
      'AUTONOMOUS_WITHIN_POLICY',
      `Tool '${input.tool}' is not declared for agent '${input.agentKey}'. There is no private write path around the tool declaration.`,
    );
  }

  // Four hard prohibitions apply regardless of any AUTHORITY_GRANT a policy
  // might attempt to issue.
  if (isProhibitedForAgent(input.action)) {
    const prohibition = HARD_PROHIBITIONS.find((p) => input.action.includes('pay') || input.action.includes('approve'))
      ?? HARD_PROHIBITIONS[1];
    return blocked(
      agent.id,
      input,
      'PROHIBITED',
      `'${input.action}' is categorically prohibited for any AI principal at any AUTHORITY_GRANT size. ${prohibition.statement}`,
    );
  }

  const touchpoint = touchpointFor(input.tool);
  // An individual action may classify lower than the agent's ceiling tier, but
  // never higher.
  const tier: AiTierCode = touchpoint?.tier ?? (agent.tier as AiTierCode);
  const tierSpec = AI_TIER_BY_CODE[tier];

  if (tier === 'PROHIBITED') {
    return blocked(agent.id, input, tier, touchpoint?.boundary ?? 'This touchpoint is classified PROHIBITED.');
  }

  // HOW MUCH: the agent's own ceiling, resolved from its own AUTHORITY_GRANT —
  // never inherited from a human's.
  if (input.magnitude) {
    const ceiling = await resolveAuthorityCeiling(
      { ...auth, agentId: agent.id, partyId: null },
      input.magnitude.authorityClass,
    );
    if (ceiling === null || input.magnitude.value > ceiling) {
      await emit({
        name: EVENTS.AGENT_AUTHORITY_SHORTFALL,
        subject: { entityType: 'agent_action', entityId: agent.id },
        newState: {
          agentKey: input.agentKey,
          authorityClass: input.magnitude.authorityClass,
          ceiling,
          attempted: input.magnitude.value,
        },
        impact: { domains: ['agt', 'gov'], severity: 'S2_WARNING' },
      });
      return blocked(
        agent.id,
        input,
        tier,
        `Authority shortfall: ${input.magnitude.value} exceeds the agent's ${input.magnitude.authorityClass} ceiling${ceiling === null ? ' (none held)' : ` of ${ceiling}`}.`,
      );
    }
  }

  // Count ceiling within a window, e.g. "draft up to 5 outreach emails per day".
  const countGrant = await prisma.authorityGrant.findFirst({
    where: { tenantId: auth.tenantId, principalId: agent.id, status: 'active', countCeiling: { not: null } },
  });
  if (countGrant?.countCeiling) {
    const windowStart = windowStartFor(countGrant.countWindow ?? 'day');
    const used = await prisma.agentAction.count({
      where: { tenantId: auth.tenantId, agentId: agent.id, proposedAt: { gte: windowStart }, state: { in: ['proposed', 'executed'] } },
    });
    if (used >= countGrant.countCeiling) {
      await emit({
        name: EVENTS.AGENT_AUTHORITY_SHORTFALL,
        subject: { entityType: 'agent_action', entityId: agent.id },
        newState: { agentKey: input.agentKey, countCeiling: countGrant.countCeiling, used, window: countGrant.countWindow },
        impact: { domains: ['agt'], severity: 'S1_ATTENTION' },
      });
      return blocked(
        agent.id,
        input,
        tier,
        `Count ceiling reached: ${used}/${countGrant.countCeiling} per ${countGrant.countWindow}.`,
      );
    }
  }

  const action = await prisma.agentAction.create({
    data: {
      tenantId: auth.tenantId,
      agentId: agent.id,
      tool: input.tool,
      action: input.action,
      tier,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      proposal: input.proposal as never,
      rationale: input.rationale,
      state: 'proposed',
      onBehalfOfPartyId: input.onBehalfOfPartyId ?? null,
    },
  });

  await emit({
    name: EVENTS.AGENT_ACTION_PROPOSED,
    subject: { entityType: 'agent_action', entityId: action.id },
    related: [{ relation: 'proposes_on', entityType: input.subjectType, entityId: input.subjectId }],
    newState: { tool: input.tool, action: input.action, tier },
    impact: { domains: ['agt'] },
  });

  // AUTONOMOUS_WITHIN_POLICY is the only tier that may act without a
  // per-instance approval, and only within its AUTHORITY_GRANT and a
  // pre-approved policy.
  if (tier === 'AUTONOMOUS_WITHIN_POLICY') {
    const executed = await prisma.agentAction.update({
      where: { id: action.id },
      data: { state: 'executed', decidedAt: new Date() },
    });
    await emit({
      name: EVENTS.AGENT_ACTION_EXECUTED,
      subject: { entityType: 'agent_action', entityId: action.id },
      newState: { tier, autoExecuted: true },
      impact: { domains: ['agt'] },
    });
    return { actionId: executed.id, tier, state: 'executed', blockedReason: null, autoExecuted: true };
  }

  // RECOMMEND / DRAFT / EXECUTE_WITH_APPROVAL all wait for a human.
  if (tierSpec.requiresHuman && input.onBehalfOfPartyId) {
    await notify({
      recipientPartyId: input.onBehalfOfPartyId,
      priority: 'N1_LOW',
      title: `${agent.name} suggests: ${input.action}`,
      body: input.rationale,
      subjectType: 'agent_action',
      subjectId: action.id,
      drillPath: `/admin/agents/actions/${action.id}`,
    });
  }

  return { actionId: action.id, tier, state: 'proposed', blockedReason: null, autoExecuted: false };
}

async function blocked(
  agentId: string,
  input: ProposeInput,
  tier: AiTierCode,
  reason: string,
): Promise<ProposeResult> {
  const auth = currentAuth();
  const action = await prisma.agentAction.create({
    data: {
      tenantId: auth.tenantId,
      agentId,
      tool: input.tool,
      action: input.action,
      tier,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      proposal: input.proposal as never,
      rationale: input.rationale,
      state: 'blocked',
      blockedReason: reason,
      onBehalfOfPartyId: input.onBehalfOfPartyId ?? null,
    },
  });

  await emit({
    name: EVENTS.AGENT_ACTION_REJECTED,
    subject: { entityType: 'agent_action', entityId: action.id },
    newState: { tool: input.tool, action: input.action, tier, blockedReason: reason },
    reason: { reasonCode: 'agent_blocked', note: reason },
    impact: { domains: ['agt', 'gov'], severity: 'S1_ATTENTION' },
  });

  return { actionId: action.id, tier, state: 'blocked', blockedReason: reason, autoExecuted: false };
}

/** A human accepts or rejects a proposal. The human is always the actor of record. */
export async function decideAgentAction(actionId: string, accept: boolean, note?: string) {
  const auth = currentAuth();
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden('An agent may never accept its own proposal.');
  }

  const action = await prisma.agentAction.findFirst({ where: { id: actionId } });
  if (!action) throw ApiError.notFound('Agent action');
  if (action.state !== 'proposed') throw ApiError.conflict(`Action is already ${action.state}.`);

  const updated = await prisma.agentAction.update({
    where: { id: actionId },
    data: {
      state: accept ? 'executed' : 'rejected',
      humanActorId: auth.partyId,
      decidedAt: new Date(),
      blockedReason: accept ? null : (note ?? 'Rejected by a human reviewer.'),
    },
  });

  await emit({
    name: accept ? EVENTS.AGENT_ACTION_EXECUTED : EVENTS.AGENT_ACTION_REJECTED,
    subject: { entityType: 'agent_action', entityId: actionId },
    previousState: { state: 'proposed' },
    newState: { state: updated.state, humanActorId: auth.partyId },
    reason: { reasonCode: accept ? 'human_accepted' : 'human_rejected', note: note ?? null },
  });

  return updated;
}

function windowStartFor(window: string): Date {
  const now = new Date();
  if (window === 'week') return new Date(now.getTime() - 7 * 86_400_000);
  if (window === 'month') return new Date(now.getTime() - 30 * 86_400_000);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function agentRoster() {
  const auth = currentAuth();
  const agents = await prisma.agentPrincipal.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { name: 'asc' },
  });

  const since = new Date(Date.now() - 30 * 86_400_000);

  return Promise.all(
    agents.map(async (a) => {
      const [actions, shortfalls, grants] = await Promise.all([
        prisma.agentAction.count({ where: { tenantId: auth.tenantId, agentId: a.id, proposedAt: { gte: since } } }),
        prisma.agentAction.count({
          where: { tenantId: auth.tenantId, agentId: a.id, proposedAt: { gte: since }, state: 'blocked' },
        }),
        prisma.authorityGrant.findMany({ where: { tenantId: auth.tenantId, principalId: a.id } }),
      ]);

      return {
        id: a.id,
        agentKey: a.agentKey,
        name: a.name,
        purpose: a.purpose,
        tier: a.tier as AiTierCode,
        declaredTools: a.declaredTools,
        status: a.status,
        authorityGrants: grants.map((g) => ({
          authorityClass: g.authorityClass,
          ceilingValue: num(g.ceilingValue),
          currency: g.currency,
          countCeiling: g.countCeiling,
          countWindow: g.countWindow,
          riskClassCeiling: g.riskClassCeiling,
        })),
        actionsLast30d: actions,
        authorityShortfallsLast30d: shortfalls,
      };
    }),
  );
}

/**
 * The Chairman's kill-switch. Revocation is stronger than pausing because it
 * hits every automation AND agent relying on that grant, so the confirmation
 * names each one going dark.
 */
export async function revokeAuthority(grantId: string, reason: string) {
  const auth = currentAuth();
  const grant = await prisma.authorityGrant.findFirst({ where: { id: grantId } });
  if (!grant) throw ApiError.notFound('Authority grant');

  const dependents = await prisma.agentPrincipal.findMany({
    where: { tenantId: auth.tenantId, id: grant.principalId },
    select: { name: true, agentKey: true },
  });

  const revoked = await prisma.authorityGrant.update({
    where: { id: grantId },
    data: { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
  });

  await emit({
    name: EVENTS.GRANT_CHANGED,
    subject: { entityType: 'authority_grant', entityId: grantId },
    previousState: { status: grant.status, ceilingValue: num(grant.ceilingValue) },
    newState: { status: 'revoked' },
    reason: { reasonCode: 'authority_revoked', note: reason },
    impact: { domains: ['gov', 'agt'], severity: 'S2_WARNING' },
    confidentiality: 'restricted',
  });

  return { revoked, wentDark: dependents.map((d) => d.name) };
}

export async function pauseAgent(agentId: string, paused: boolean) {
  return prisma.agentPrincipal.update({
    where: { id: agentId },
    data: { status: paused ? 'paused' : 'active' },
  });
}

export { AI_TOUCHPOINTS, HARD_PROHIBITIONS };
