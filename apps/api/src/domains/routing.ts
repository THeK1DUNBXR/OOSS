/**
 * Territory & the six-factor routing engine (CRM-LEAD-005).
 *
 * "Owner is whoever created the record" works at one branch and fails at three.
 * This replaces it with a real evaluated step.
 *
 * Hard filters run FIRST — assigning outside territory or grant is an
 * authorization error, not a preference, so a candidate failing either is never
 * scored on the soft factors at all. Relationship strength is weighted equal to
 * capacity deliberately: in the institution motion, a warm existing contact
 * beats an empty diary.
 *
 * Every evaluation is logged with the full candidate set, their per-factor
 * scores, and why the winner won — the same transparency discipline the
 * platform applies to lead scoring's score_reasons.
 */

import { EVENTS, type RoutingCandidateScore, type UnroutedReason } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { raiseException } from '../platform/exceptions.js';
import { relationshipStrengthScore } from './relationships.js';

export interface RoutingSubject {
  leadId: string;
  vertical: string;
  organizationId: string | null;
  offeringId: string | null;
  district: string | null;
  accountKind: 'organization' | 'institution' | 'individual';
}

export interface RoutingOutcome {
  winnerPartyId: string | null;
  territoryId: string | null;
  candidates: RoutingCandidateScore[];
  unroutedReason: UnroutedReason | null;
}

interface Candidate {
  partyId: string;
  name: string;
  roleSlug: string;
  branch: string | null;
  openCount: number;
  capacityCeiling: number;
  capabilityTier: string | null;
  lastAssignedAt: Date | null;
}

/** Territory is the first hard filter: geography x vertical x account kind. */
async function resolveTerritory(subject: RoutingSubject) {
  const auth = currentAuth();
  const territories = await prisma.territory.findMany({
    where: { tenantId: auth.tenantId, active: true },
  });

  return (
    territories.find(
      (t) =>
        (t.appliesToVerticals.length === 0 || t.appliesToVerticals.includes(subject.vertical)) &&
        (t.appliesToAccountKind === 'any' || t.appliesToAccountKind === subject.accountKind) &&
        (t.geoAreaRef.length === 0 || (subject.district ? t.geoAreaRef.includes(subject.district) : false)),
    ) ??
    territories.find(
      (t) =>
        (t.appliesToVerticals.length === 0 || t.appliesToVerticals.includes(subject.vertical)) &&
        t.geoAreaRef.length === 0,
    ) ??
    null
  );
}

/**
 * The vertical hard filter: does the candidate hold a grant for this pipeline's
 * vertical? Expressed as a grant lookup, never a role-slug string comparison.
 */
async function candidatesHoldingLeadGrant(vertical: string): Promise<Candidate[]> {
  const auth = currentAuth();

  const roles = await prisma.accessRole.findMany({ where: { tenantId: auth.tenantId } });
  const grants = await prisma.grant.findMany({
    where: { tenantId: auth.tenantId, resource: 'leads', verbs: { has: 'assign' } },
  });
  const eligibleRoleIds = new Set(grants.map((g) => g.roleId).filter(Boolean) as string[]);
  const eligibleRoleSlugs = new Set(
    roles.filter((r) => eligibleRoleIds.has(r.id)).map((r) => r.slug),
  );

  // A vertical-specific narrowing lives on the grant's conditions, as data.
  const verticalNarrowed = new Set<string>();
  for (const g of grants) {
    const conditions = (g.conditions ?? {}) as { verticals?: string[] };
    if (conditions.verticals && !conditions.verticals.includes(vertical)) {
      const role = roles.find((r) => r.id === g.roleId);
      if (role) verticalNarrowed.add(role.slug);
    }
  }

  const affiliations = await prisma.affiliation.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'active',
      roleSlug: { in: [...eligibleRoleSlugs].filter((s) => !verticalNarrowed.has(s)) },
    },
    include: { party: { select: { fullName: true } } },
  });

  const out: Candidate[] = [];
  for (const a of affiliations) {
    const [openCount, capability, lastAssigned] = await Promise.all([
      prisma.lead.count({
        where: { tenantId: auth.tenantId, ownerPartyId: a.partyId, leadStatus: 'open', deletedAt: null },
      }),
      prisma.capabilityClaim.findFirst({
        where: { tenantId: auth.tenantId, partyId: a.partyId, vertical },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.lead.findFirst({
        where: { tenantId: auth.tenantId, ownerPartyId: a.partyId },
        orderBy: { routedAt: 'desc' },
        select: { routedAt: true },
      }),
    ]);

    out.push({
      partyId: a.partyId,
      name: a.party.fullName,
      roleSlug: a.roleSlug ?? 'unknown',
      branch: a.branch,
      openCount,
      capacityCeiling: 50,
      capabilityTier: capability?.tier ?? null,
      lastAssignedAt: lastAssigned?.routedAt ?? null,
    });
  }
  return out;
}

export async function routeLead(subject: RoutingSubject): Promise<RoutingOutcome> {
  const auth = currentAuth();
  const rule = await prisma.routingRule.findFirst({
    where: { tenantId: auth.tenantId, active: true },
    orderBy: { priority: 'asc' },
  });
  const weights = (rule?.factorWeights ?? {
    capacity: 30,
    capability: 25,
    relationship_strength: 30,
    round_robin: 15,
  }) as Record<string, number>;
  const tieMargin = rule?.tieBreakMarginPoints ?? 5;

  const territory = await resolveTerritory(subject);
  const capacityCeiling = territory?.capacityCeiling ?? 50;
  const pool = await candidatesHoldingLeadGrant(subject.vertical);

  const scored: RoutingCandidateScore[] = [];
  const survivors: Array<{ candidate: Candidate; total: number; factors: RoutingCandidateScore['factors'] }> = [];

  for (const candidate of pool) {
    // ---- Hard filter 1: territory --------------------------------------
    if (territory && territory.geoAreaRef.length > 0 && candidate.branch && !territory.geoAreaRef.includes(candidate.branch)) {
      scored.push({
        candidateId: candidate.partyId,
        candidateName: candidate.name,
        passedHardFilters: false,
        hardFilterFailure: 'territory',
        factors: [],
        total: 0,
        won: false,
        tieBreakApplied: false,
      });
      continue;
    }

    // ---- Soft factors ---------------------------------------------------
    const capacityRaw = Math.max(0, 1 - candidate.openCount / Math.max(capacityCeiling, 1));
    const capabilityRaw = tierScore(candidate.capabilityTier);
    const relationshipRaw = await relationshipStrengthScore(candidate.partyId, subject.organizationId);
    const recencyRaw = recencyScore(candidate.lastAssignedAt);

    const factors = [
      { factor: 'capacity', weight: weights.capacity ?? 30, raw: capacityRaw, weighted: capacityRaw * (weights.capacity ?? 30) },
      { factor: 'capability', weight: weights.capability ?? 25, raw: capabilityRaw, weighted: capabilityRaw * (weights.capability ?? 25) },
      {
        factor: 'relationship_strength',
        weight: weights.relationship_strength ?? 30,
        raw: relationshipRaw,
        weighted: relationshipRaw * (weights.relationship_strength ?? 30),
      },
    ];
    const total = factors.reduce((sum, f) => sum + f.weighted, 0);

    // Round-robin is a tie-break only, never a fourth independent scoring
    // factor — it is carried so the audit view can show it, but it does not
    // enter the sum.
    factors.push({
      factor: 'round_robin (tie-break only)',
      weight: weights.round_robin ?? 15,
      raw: recencyRaw,
      weighted: 0,
    });

    survivors.push({ candidate, total, factors });
    scored.push({
      candidateId: candidate.partyId,
      candidateName: candidate.name,
      passedHardFilters: true,
      hardFilterFailure: null,
      factors,
      total: Number(total.toFixed(2)),
      won: false,
      tieBreakApplied: false,
    });
  }

  if (survivors.length === 0) {
    // The two unrouted causes need different remedies, so they carry different
    // reason codes: a genuine coverage gap versus a capacity problem.
    const reason: UnroutedReason = pool.length === 0
      ? 'no_vertical_coverage'
      : territory === null
        ? 'no_territory_match'
        : 'all_candidates_over_capacity';
    await persistAudit(subject.leadId, territory?.id ?? null, scored, null, reason);
    return { winnerPartyId: null, territoryId: territory?.id ?? null, candidates: scored, unroutedReason: reason };
  }

  const allOverCapacity = survivors.every((s) => s.candidate.openCount >= capacityCeiling);
  if (allOverCapacity) {
    await persistAudit(subject.leadId, territory?.id ?? null, scored, null, 'all_candidates_over_capacity');
    return {
      winnerPartyId: null,
      territoryId: territory?.id ?? null,
      candidates: scored,
      unroutedReason: 'all_candidates_over_capacity',
    };
  }

  survivors.sort((a, b) => b.total - a.total);
  const top = survivors[0];
  const withinMargin = survivors.filter((s) => top.total - s.total <= tieMargin);

  let winner = top;
  let tieBreakApplied = false;
  if (withinMargin.length > 1) {
    // Least-recently-assigned among the tied survivors.
    tieBreakApplied = true;
    winner = withinMargin.reduce((a, b) => {
      const at = a.candidate.lastAssignedAt?.getTime() ?? 0;
      const bt = b.candidate.lastAssignedAt?.getTime() ?? 0;
      return bt < at ? b : a;
    });
  }

  for (const s of scored) {
    if (s.candidateId === winner.candidate.partyId) {
      s.won = true;
      s.tieBreakApplied = tieBreakApplied;
    }
  }

  await persistAudit(subject.leadId, territory?.id ?? null, scored, winner.candidate.partyId, null);

  return {
    winnerPartyId: winner.candidate.partyId,
    territoryId: territory?.id ?? null,
    candidates: scored,
    unroutedReason: null,
  };
}

function tierScore(tier: string | null): number {
  switch (tier) {
    case 'verified':
      return 1;
    case 'demonstrated':
      return 0.85;
    case 'assessed':
      return 0.6;
    case 'claimed':
      // The Capability factor requires tier Assessed+ to contribute meaningfully.
      return 0.2;
    default:
      return 0;
  }
}

function recencyScore(lastAssignedAt: Date | null): number {
  if (!lastAssignedAt) return 1;
  const days = (Date.now() - lastAssignedAt.getTime()) / 86_400_000;
  return Math.min(days / 14, 1);
}

async function persistAudit(
  leadId: string,
  territoryId: string | null,
  candidates: RoutingCandidateScore[],
  winnerPartyId: string | null,
  unroutedReason: string | null,
) {
  const auth = currentAuth();
  await prisma.routingAudit.create({
    data: {
      tenantId: auth.tenantId,
      leadId,
      territoryId,
      candidates: candidates as never,
      winnerPartyId,
      unroutedReason,
    },
  });
}

/**
 * Ownership-before-escalation: an unrouted lead has an owner — the territory
 * holder — BEFORE anyone downstream is notified. It is never simply unowned in
 * the interim.
 */
export async function raiseUnroutedException(
  leadId: string,
  leadLabel: string,
  territoryId: string | null,
  reason: UnroutedReason,
) {
  const territory = territoryId ? await prisma.territory.findFirst({ where: { id: territoryId } }) : null;

  const detail =
    reason === 'no_vertical_coverage'
      ? 'No candidate in this territory holds a grant for the lead\'s vertical — a genuine coverage gap. The remedy is a grant change, not a capacity change.'
      : reason === 'all_candidates_over_capacity'
        ? 'Every eligible candidate is at or over their declared capacity ceiling. The remedy is capacity, not coverage.'
        : 'No active territory matches this lead\'s geography, vertical and account kind.';

  await raiseException({
    code: 'EX-CRM-004',
    label: 'Unrouted lead',
    severity: 'S2_WARNING',
    subjectType: 'lead',
    subjectId: leadId,
    subjectLabel: leadLabel,
    domain: 'crm',
    detail,
    reasonCode: reason,
    ownerPartyId: territory?.ownerPartyId ?? null,
    accountablePositionId: territory?.ownerPositionId ?? null,
    // Escalates to finance_head if unresolved after 4 business hours.
    slaDueAt: new Date(Date.now() + 4 * 3_600_000),
  });

  await emit({
    name: EVENTS.LEAD_UNROUTED,
    subject: { entityType: 'lead', entityId: leadId },
    newState: { territoryId, unroutedReason: reason },
    reason: { reasonCode: reason },
    impact: { domains: ['crm'], severity: 'S2_WARNING' },
  });
}

export async function routingAuditFor(leadId: string) {
  const auth = currentAuth();
  return prisma.routingAudit.findFirst({
    where: { tenantId: auth.tenantId, leadId },
    orderBy: { evaluatedAt: 'desc' },
  });
}
