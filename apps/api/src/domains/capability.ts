/**
 * Capability Intelligence (Canon §14.6, §14.7).
 *
 * What the company believes about what people can do, and how strongly. Held
 * against a party rather than an employment relationship, because students,
 * candidates, trainers and alumni all have capabilities and none of them are
 * employees.
 *
 * Two rules do most of the work here, and both exist because the alternative
 * is a system that quietly launders a guess into a fact:
 *
 * - Nobody verifies their own claim, and a claim that moves pay or grade needs
 *   two people. No seniority is exempt, because seniority is exactly what
 *   would make an exemption dangerous.
 * - A colleague sees the claim and its trust badge, never the confidence
 *   score. The score is a model output, and shown to a person it reads as a
 *   judgement of them.
 */

import {
  EVENTS,
  CONFIDENCE_RANK,
  ORIGINATION_FOR_TIER,
  assertVerificationAllowed,
  canEnterNonTierState,
  classifyContradiction,
  decayedConfidence,
  enterNonTierState,
  tierForLearningCompletion,
  HrRuleViolationError,
  type CapabilityTier,
  type NonTierState,
  type ContradictionType,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth, type AuthContext } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, can } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';

registerGovernedEntities('capability', ['capability_claim', 'skill', 'evidence']);

/** Domain rule violations from the shared model become 422s at the boundary. */
function asApiError(err: unknown): never {
  if (err instanceof HrRuleViolationError) throw ApiError.unprocessable(err.message);
  throw err;
}

export async function listSkills() {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'view' });
  return prisma.skill.findMany({ where: { tenantId: auth.tenantId }, orderBy: { name: 'asc' } });
}

export async function createSkill(input: { name: string; halfLifeMonths?: number; proficiencyScale?: unknown }) {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'create' });
  const skill = await prisma.skill.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      halfLifeMonths: input.halfLifeMonths ?? 24,
      proficiencyScale: (input.proficiencyScale ?? []) as never,
    },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'skill',
    subjectId: skill.id,
    after: { name: skill.name, halfLifeMonths: skill.halfLifeMonths },
  });
  await emit({
    name: EVENTS.SKILL_CREATED,
    subject: { entityType: 'skill', entityId: skill.id },
    newState: { name: skill.name, halfLifeMonths: skill.halfLifeMonths },
    impact: { domains: ['hr'] },
  });
  return skill;
}

export interface CapabilityView {
  id: string;
  partyId: string;
  skillId: string | null;
  skillName: string | null;
  tier: CapabilityTier;
  state: string;
  source: string;
  claimedProficiencyLevel: number | null;
  lastEvidencedAt: Date;
  /** Present only for a viewer who may see it. */
  confidenceScore?: number;
  decayedConfidence?: number;
}

/**
 * Claims for one party.
 *
 * The score is attached only if the viewer holds the financial-grade verb on
 * capabilities — the same gate money uses — or is looking at their own record.
 * Everybody else gets the badge, which is §14.7's flagship field rule.
 */
export async function capabilitiesForParty(partyId: string, asOf = new Date()): Promise<CapabilityView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'view' });

  const claims = await prisma.capabilityClaim.findMany({
    where: { tenantId: auth.tenantId, partyId },
    include: { skill: true },
    orderBy: [{ confidenceRank: 'desc' }, { lastEvidencedAt: 'desc' }],
  });

  const ownRecord = auth.partyId === partyId;
  const maySeeScore = ownRecord || (await can({ resource: 'capabilities', verb: 'financial' }));

  return claims.map((claim) => {
    const view: CapabilityView = {
      id: claim.id,
      partyId: claim.partyId,
      skillId: claim.skillId,
      skillName: claim.skill?.name ?? claim.vertical ?? null,
      tier: claim.tier as CapabilityTier,
      state: claim.state,
      source: claim.source,
      claimedProficiencyLevel: claim.claimedProficiencyLevel,
      lastEvidencedAt: claim.lastEvidencedAt,
    };

    if (maySeeScore) {
      const score = num(claim.confidenceScore) ?? 0;
      view.confidenceScore = score;
      // Decay is applied here, at read time, from the skill's half-life —
      // never stored, so it is never stale between nightly runs.
      view.decayedConfidence = decayedConfidence({
        confidenceScore: score,
        lastEvidencedAt: claim.lastEvidencedAt,
        halfLifeMonths: claim.skill?.halfLifeMonths ?? 24,
        asOf,
      });
    }

    return view;
  });
}

/**
 * Asserts a claim at a tier. A claim does not climb: it enters at the tier its
 * origin justifies, so `source` is derived from the tier rather than supplied.
 */
export async function assertClaim(input: {
  partyId: string;
  skillId?: string | null;
  vertical?: string | null;
  tier: CapabilityTier;
  confidenceScore?: number;
  claimedProficiencyLevel?: number | null;
  evidence?: string | null;
}) {
  const auth = currentAuth();
  // Bound to the party the claim is about. Reading a capability profile is
  // deliberately open — §14.7 makes the badge public — but asserting one is
  // not, and the `own` scope on that grant is only enforced when the record is
  // passed. Without it anyone could plant a `demonstrated` claim on a
  // colleague, which then surfaces them in the staffing search.
  await assertCan({ resource: 'capabilities', verb: 'create', record: { ownerPartyId: input.partyId } });

  if (input.tier === 'verified') {
    throw ApiError.unprocessable(
      'A claim cannot be asserted directly as Verified. Assert it at its origin tier and verify it, ' +
        'so the verification carries a verifier and a time.',
    );
  }

  const claim = await prisma.capabilityClaim.create({
    data: {
      tenantId: auth.tenantId,
      partyId: input.partyId,
      skillId: input.skillId ?? null,
      vertical: input.vertical ?? null,
      tier: input.tier,
      confidenceRank: CONFIDENCE_RANK[input.tier],
      confidenceScore: input.confidenceScore ?? 0.5,
      claimedProficiencyLevel: input.claimedProficiencyLevel ?? null,
      source: ORIGINATION_FOR_TIER[input.tier],
      evidence: input.evidence ?? null,
      assertedById: auth.partyId,
      lastEvidencedAt: new Date(),
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'capability_claim',
    subjectId: claim.id,
    after: { partyId: input.partyId, skillId: input.skillId ?? null, tier: input.tier, source: claim.source },
  });

  await emit({
    name: EVENTS.CAPABILITY_CLAIM_ASSERTED,
    subject: { entityType: 'capability_claim', entityId: claim.id },
    related: [{ relation: 'about', entityType: 'person', entityId: input.partyId }],
    newState: { tier: input.tier, source: claim.source, skillId: input.skillId },
    owner: { partyId: input.partyId },
    impact: { domains: ['hr'] },
  });

  return claim;
}

export async function addEvidence(claimId: string, input: { description: string; sourceRef?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'edit' });

  const claim = await prisma.capabilityClaim.findFirst({ where: { id: claimId, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Capability claim');

  const evidence = await prisma.evidence.create({
    data: {
      tenantId: auth.tenantId,
      capabilityClaimId: claimId,
      description: input.description,
      sourceRef: input.sourceRef ?? null,
    },
  });

  // Fresh evidence resets the decay clock — that is the whole point of
  // recording it.
  await prisma.capabilityClaim.update({ where: { id: claimId }, data: { lastEvidencedAt: new Date() } });

  await auditWrite({
    action: 'create',
    subjectType: 'evidence',
    subjectId: evidence.id,
    after: { capabilityClaimId: claimId, sourceRef: evidence.sourceRef },
  });

  await emit({
    name: EVENTS.EVIDENCE_ADDED,
    subject: { entityType: 'evidence', entityId: evidence.id },
    related: [{ relation: 'supports', entityType: 'capability_claim', entityId: claimId }],
    newState: { capabilityClaimId: claimId, sourceRef: evidence.sourceRef },
    impact: { domains: ['hr'] },
  });

  return evidence;
}

/**
 * The two-person rule's inputs are derived here, never taken from the caller.
 * A flag the caller can send is a flag the caller can send as false: that was
 * the bypass (routes/hr.routes.ts:844-856 before FX-02). The skill's
 * classification decides whether the claim feeds pay; the reporting line
 * decides whether the verifier is only the claimant's manager.
 */
async function verifierIsClaimantsManager(claimantPartyId: string, verifierPartyId: string): Promise<boolean> {
  const [claimantEmployments, verifierEmployments] = await Promise.all([
    prisma.employmentRelationship.findMany({ where: { personId: claimantPartyId }, select: { id: true } }),
    prisma.employmentRelationship.findMany({ where: { personId: verifierPartyId }, select: { id: true } }),
  ]);
  if (claimantEmployments.length === 0 || verifierEmployments.length === 0) return false;
  const line = await prisma.reportingLine.findFirst({
    where: {
      effectiveTo: null,
      employmentRelationshipId: { in: claimantEmployments.map((e) => e.id) },
      managerEmploymentRelationshipId: { in: verifierEmployments.map((e) => e.id) },
    },
    select: { id: true },
  });
  return Boolean(line);
}

/**
 * The second verifier is a person whose verify right is checked, not a string
 * the caller supplies. Before this, any cuid satisfied the two-person rule on
 * paper, so a pay-feeding skill verified with a second signature from nobody.
 *
 * The right is evaluated through the same evaluator as the first verifier's,
 * under the second person's own affiliation, so a change to the matrix moves
 * both checks together. Refused before anything is written: a rejected second
 * verifier leaves no verificationEvent behind.
 */
async function assertSecondVerifierQualified(secondPartyId: string): Promise<void> {
  const auth = currentAuth();
  const now = new Date();
  const affiliations = await prisma.affiliation.findMany({
    where: {
      tenantId: auth.tenantId,
      partyId: secondPartyId,
      status: 'active',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
  });
  if (affiliations.length === 0) {
    throw ApiError.unprocessable('The second verifier must be an active person in this tenant [Canon §14.6.4].');
  }

  for (const affiliation of affiliations) {
    if (!affiliation.roleSlug) continue;
    const role = await prisma.accessRole.findFirst({
      where: { tenantId: auth.tenantId, slug: affiliation.roleSlug },
      select: { classificationCeiling: true },
    });
    const candidate: AuthContext = {
      ...auth,
      principalType: 'human',
      partyId: secondPartyId,
      userId: null,
      agentId: null,
      onBehalfOfPartyId: null,
      affiliationId: affiliation.id,
      roleSlug: affiliation.roleSlug,
      branch: affiliation.branch,
      orgUnitId: affiliation.orgUnitId,
      classificationCeiling: (role?.classificationCeiling ?? 'internal') as AuthContext['classificationCeiling'],
      purpose: null,
      consentCodes: [],
      stepUpVerified: false,
    };
    if (await can({ resource: 'capabilities', verb: 'approve', auth: candidate })) return;
  }

  throw ApiError.forbidden('The second verifier does not hold capabilities:approve in this tenant [Canon §14.6.4].');
}

/**
 * Verification is server-validated end to end. The request supplies only a
 * second verifier's id and a note: the two-person inputs (pay-feeding and
 * manager-only) are derived above, and the second verifier's `approve` right is
 * checked by assertSecondVerifierQualified before any verificationEvent is
 * written, so a refused attempt leaves no trace.
 */
export async function verifyClaim(
  claimId: string,
  input: {
    secondVerifierPartyId?: string | null;
    note?: string | null;
  },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'approve' });

  const claim = await prisma.capabilityClaim.findFirst({
    where: { id: claimId, tenantId: auth.tenantId },
    include: { skill: { select: { feedsCompensationOrPromotionOrMobility: true } } },
  });
  if (!claim) throw ApiError.notFound('Capability claim');
  if (!auth.partyId) throw ApiError.forbidden('Verification requires a human principal.');

  // A claim with no skill has nothing to say it is harmless, so it is treated
  // as pay-feeding.
  const feedsPay = claim.skill?.feedsCompensationOrPromotionOrMobility ?? true;
  const verifierIsManagerOnly = await verifierIsClaimantsManager(claim.partyId, auth.partyId);

  try {
    assertVerificationAllowed({
      claimantPartyId: claim.partyId,
      verifierPartyId: auth.partyId,
      secondVerifierPartyId: input.secondVerifierPartyId ?? null,
      targetTier: 'verified',
      feedsCompensationOrPromotionOrMobility: feedsPay,
      verifierIsManagerOnly,
    });
  } catch (err) {
    asApiError(err);
  }
  if (input.secondVerifierPartyId) await assertSecondVerifierQualified(input.secondVerifierPartyId);

  // The verification row, the claim's new tier, the audit row and the event
  // commit together. Audit still comes before emit, so a subscriber never acts
  // on a verification the register does not show; both now sit inside the
  // transaction, so a failed audit leaves the claim unverified, not verified
  // with no record.
  return governedWrite(async (tx) => {
    await tx.verificationEvent.create({
      data: {
        tenantId: auth.tenantId,
        capabilityClaimId: claimId,
        verifierPartyId: auth.partyId!,
        secondVerifierPartyId: input.secondVerifierPartyId ?? null,
        note: input.note ?? null,
      },
    });

    const updated = await tx.capabilityClaim.update({
      where: { id: claimId },
      data: {
        tier: 'verified',
        confidenceRank: CONFIDENCE_RANK.verified,
        source: ORIGINATION_FOR_TIER.verified,
        state: 'active',
        lastEvidencedAt: new Date(),
      },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'capability_claim',
      subjectId: claimId,
      before: { tier: claim.tier },
      after: { tier: 'verified' },
      meta: { verifierPartyId: auth.partyId, secondVerifierPartyId: input.secondVerifierPartyId ?? null },
      tx,
    });

    await emit({
      name: EVENTS.CAPABILITY_CLAIM_VERIFIED,
      subject: { entityType: 'capability_claim', entityId: claimId },
      related: [{ relation: 'about', entityType: 'person', entityId: claim.partyId }],
      previousState: { tier: claim.tier },
      newState: { tier: 'verified', twoPerson: Boolean(input.secondVerifierPartyId) },
      owner: { partyId: claim.partyId },
      impact: { domains: ['hr'] },
      tx,
    });

    return updated;
  });
}

/**
 * Records a contradiction and decides what happens to the claim.
 *
 * The bands are per contradiction type rather than one global threshold: two
 * sources disagreeing about a proficiency level is ordinary and tolerable,
 * two sources disagreeing about who the person is never is — which is why an
 * identity conflict always goes to a human, whatever it scores.
 */
export async function recordContradiction(
  claimId: string,
  input: { type: ContradictionType; score: number; detail?: string },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'edit' });

  const claim = await prisma.capabilityClaim.findFirst({ where: { id: claimId, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Capability claim');

  const region = classifyContradiction(input.type, input.score);
  const fromTier = claim.tier as CapabilityTier;

  let newState = claim.state;
  if (region === 'auto_reject') {
    // An issuer saying no revokes; anything else at reject strength
    // contradicts — and only from a tier where that transition is defined.
    const target: NonTierState = input.type === 'issuer_conflict' ? 'revoked' : 'contradicted';
    if (canEnterNonTierState(fromTier, target)) {
      try {
        newState = enterNonTierState(fromTier, target);
      } catch (err) {
        asApiError(err);
      }
    }
  }

  const updated =
    newState === claim.state
      ? claim
      : await prisma.capabilityClaim.update({ where: { id: claimId }, data: { state: newState } });

  // Audited even when the state does not change: a contradiction recorded and
  // left for a human is still a decision about the claim, and the register
  // should show it was made.
  await auditWrite({
    action: 'update',
    subjectType: 'capability_claim',
    subjectId: claimId,
    before: { state: claim.state },
    after: { state: newState, contradictionType: input.type, score: input.score, region },
  });

  await emit({
    name: EVENTS.CAPABILITY_CLAIM_CONTRADICTED,
    subject: { entityType: 'capability_claim', entityId: claimId },
    previousState: { state: claim.state, tier: claim.tier },
    newState: { state: newState, contradictionType: input.type, score: input.score, region },
    reason: input.detail ? { reasonCode: input.type, note: input.detail } : null,
    owner: { partyId: claim.partyId },
    impact: { domains: ['hr'] },
  });

  return { claim: updated, region, resolvedAutomatically: region !== 'human_review' };
}

export async function changeClaimState(claimId: string, target: NonTierState, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'edit' });

  const claim = await prisma.capabilityClaim.findFirst({ where: { id: claimId, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Capability claim');

  let state: string;
  try {
    state = enterNonTierState(claim.tier as CapabilityTier, target);
  } catch (err) {
    asApiError(err);
  }

  const updated = await prisma.capabilityClaim.update({ where: { id: claimId }, data: { state: state! } });

  await auditWrite({
    action: 'update',
    subjectType: 'capability_claim',
    subjectId: claimId,
    before: { state: claim.state },
    after: { state: state! },
    meta: note ? { note } : undefined,
  });

  await emit({
    name: EVENTS.CAPABILITY_CLAIM_STATE_CHANGED,
    subject: { entityType: 'capability_claim', entityId: claimId },
    previousState: { state: claim.state },
    newState: { state: state! },
    reason: note ? { reasonCode: target, note } : null,
    owner: { partyId: claim.partyId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

/**
 * Completing a course asserts at Assessed and stops there. Sitting through
 * training is evidence that somebody was taught, not that they can do it, so
 * it never auto-advances to Demonstrated or Verified.
 */
export async function claimFromLearningCompletion(input: {
  partyId: string;
  skillId: string;
  learningRecordId: string;
}) {
  const tier = tierForLearningCompletion();
  const claim = await assertClaim({
    partyId: input.partyId,
    skillId: input.skillId,
    tier,
    confidenceScore: 0.6,
  });

  await addEvidence(claim.id, {
    description: 'Learning activity completed',
    sourceRef: `learning_record:${input.learningRecordId}`,
  });

  return claim;
}

/**
 * Who in the company can do a thing, ranked. Used for staffing a project and
 * for routing. Scores are withheld from the ranking output for the same reason
 * they are withheld from a profile.
 */
export async function findCapableParties(skillId: string, minTier: CapabilityTier = 'assessed') {
  const auth = currentAuth();
  await assertCan({ resource: 'capabilities', verb: 'view' });

  const claims = await prisma.capabilityClaim.findMany({
    where: {
      tenantId: auth.tenantId,
      skillId,
      state: 'active',
      confidenceRank: { gte: CONFIDENCE_RANK[minTier] },
    },
    include: { skill: true },
    orderBy: [{ confidenceRank: 'desc' }, { lastEvidencedAt: 'desc' }],
    take: 50,
  });

  const people = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, id: { in: claims.map((c) => c.partyId) } },
    select: { id: true, fullName: true },
  });
  const byId = new Map(people.map((p) => [p.id, p.fullName]));

  return claims.map((claim) => ({
    partyId: claim.partyId,
    fullName: byId.get(claim.partyId) ?? 'Unknown',
    skillName: claim.skill?.name ?? null,
    tier: claim.tier as CapabilityTier,
    lastEvidencedAt: claim.lastEvidencedAt,
  }));
}
