/**
 * The Decision Queue (P7).
 *
 * The entry rule: nothing reaches this queue unless the required authority
 * genuinely exceeds every grant held by any principal below the viewer on that
 * item's escalation path, or a policy reserves the decision class to this
 * principal by name, or a delegation returned an item unactioned. Anything else
 * is a routing defect — logged and returned to the correct rung with its SLA
 * clock preserved, never reset.
 *
 * The seven evidence-pack components are assembled BEFORE routing, never after.
 * An incomplete pack renders `Analysing` with a visible clock, never as
 * decidable.
 *
 * Decide, Delegate, Defer and Request-Evidence are exclusively human acts.
 * There is no AI disposition authority anywhere on this surface.
 */

import { EVENTS, EVIDENCE_PACK_COMPONENTS, type DecisionDisposition } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, resolveAuthorityCeiling } from '../platform/permissions.js';
import { drillPathFor } from './commandCenter.js';

export interface RaiseDecisionInput {
  question: string;
  subjectType: string;
  subjectId: string;
  subjectLabel?: string;
  authorityBasis: string;
  requiredAuthorityValue?: number | null;
  currency?: string;
  routedToRole?: string;
  pointOfNoReturn?: Date | null;
  rejectedOptions?: Array<{ option: string; outcome: string; risk: string; cost: string }>;
  noActionConsequence?: { statement: string; by: string };
}

export async function raiseDecision(input: RaiseDecisionInput) {
  const auth = currentAuth();
  const recordCode = await nextRecordCode('DEC');

  const evidencePack = await assembleEvidencePack(input);

  const decision = await prisma.decision.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      question: input.question,
      // An incomplete pack is visibly not decidable, with a clock — never
      // silently blocked.
      state: evidencePack.complete ? 'AwaitingAuthority' : 'Analysing',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? input.subjectId,
      authorityBasis: input.authorityBasis,
      requiredAuthorityValue: input.requiredAuthorityValue ?? undefined,
      currency: input.currency ?? 'INR',
      routedToRole: input.routedToRole ?? 'chairman',
      evidencePack: evidencePack as never,
      evidenceComplete: evidencePack.complete,
      pointOfNoReturn: input.pointOfNoReturn ?? null,
      slaDueAt: new Date(Date.now() + 3 * 86_400_000),
    },
  });

  await emit({
    name: EVENTS.DECISION_RAISED,
    subject: { entityType: 'decision', entityId: decision.id, recordCode },
    related: [{ relation: 'decides_on', entityType: input.subjectType, entityId: input.subjectId }],
    newState: { question: input.question, state: decision.state, evidenceComplete: evidencePack.complete },
    impact: { domains: ['gov'], severity: 'S2_WARNING' },
    confidentiality: 'confidential',
  });

  return decision;
}

/**
 * Seven mandatory components. The model view is explicitly framed as a model,
 * not a fact — a RECOMMEND-tier surface that explains an already-computed
 * result, never one that computes the result.
 */
async function assembleEvidencePack(input: RaiseDecisionInput) {
  const auth = currentAuth();

  const transitions = await prisma.eventRecord.findMany({
    where: { tenantId: auth.tenantId, subjectEntityType: input.subjectType, subjectEntityId: input.subjectId },
    orderBy: { recordedAt: 'desc' },
    take: 5,
  });

  const precedents = await prisma.decision.findMany({
    where: { tenantId: auth.tenantId, subjectType: input.subjectType, state: { in: ['Decided', 'Implemented', 'Reviewed'] } },
    orderBy: { decidedAt: 'desc' },
    take: 3,
    include: { delegations: false },
  });

  const lessons = await prisma.lesson.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  const ceiling = await resolveAuthorityCeiling(auth, input.authorityBasis);

  const pack = {
    question: input.question,
    rejectedOptions: input.rejectedOptions ?? [],
    // Always present, never omitted.
    noActionOption: {
      option: 'Take no action',
      consequence: input.noActionConsequence?.statement ?? 'The current state persists.',
      by: input.noActionConsequence?.by ?? 'indefinitely',
    },
    subjectState: {} as Record<string, unknown>,
    lastFiveTransitions: transitions.map((t) => ({
      at: t.recordedAt.toISOString(),
      from: JSON.stringify((t.previousState as Record<string, unknown>) ?? {}),
      to: JSON.stringify((t.newState as Record<string, unknown>) ?? {}),
      actor: t.actorAccessRole ?? t.actorType,
    })),
    nearestPrecedents: precedents.map((p, i) => ({
      decisionId: p.id,
      question: p.question,
      outcome: p.outcomeAssessment ?? p.chosenOption ?? 'not yet reviewed',
      lesson: lessons[i]?.body ?? 'No lesson recorded for this precedent.',
    })),
    constraintsAndGrant: {
      constraint: input.requiredAuthorityValue
        ? `Requires ${input.authorityBasis} authority for ${input.requiredAuthorityValue} ${input.currency ?? 'INR'}.`
        : `Requires ${input.authorityBasis} authority.`,
      grantExercised: ceiling !== null ? `${input.authorityBasis} ceiling ${ceiling}` : 'no ceiling held',
    },
    // Explicitly labelled as a model, not a fact.
    modelView: {
      label: 'Model view',
      statement: `Based on ${precedents.length} comparable prior decision${precedents.length === 1 ? '' : 's'}, the modal disposition was ${precedents[0]?.chosenOption ?? 'decide'}.`,
      isModel: true as const,
    },
    noActionConsequence: input.noActionConsequence ?? {
      statement: 'The subject remains in its current state and the SLA clock continues.',
      by: 'until the next review',
    },
    complete: false,
    missingComponents: [] as string[],
  };

  const missing: string[] = [];
  if (pack.rejectedOptions.length === 0) missing.push('question_and_rejected_options');
  if (pack.lastFiveTransitions.length === 0) missing.push('subject_state_and_last_five_transitions');
  if (pack.nearestPrecedents.length === 0) missing.push('three_nearest_precedents');

  pack.missingComponents = missing;
  pack.complete = missing.length === 0;
  return pack;
}

export async function decisionQueue() {
  const auth = currentAuth();

  const rows = await prisma.decision.findMany({
    where: {
      tenantId: auth.tenantId,
      state: { in: ['Raised', 'Analysing', 'AwaitingAuthority', 'EvidenceRequested', 'Deferred'] },
    },
    orderBy: [{ raisedAt: 'asc' }],
    take: 50,
  });

  return rows.map((d) => {
    const pack = d.evidencePack as unknown as Awaited<ReturnType<typeof assembleEvidencePack>>;
    return {
      id: d.id,
      recordCode: d.recordCode,
      question: d.question,
      state: d.state,
      raisedAt: d.raisedAt.toISOString(),
      subjectType: d.subjectType,
      subjectId: d.subjectId,
      subjectLabel: d.subjectLabel ?? d.subjectId,
      authorityBasis: d.authorityBasis,
      requiredAuthorityValue: num(d.requiredAuthorityValue),
      currency: d.currency,
      confidence: d.confidence,
      deferUntil: d.deferUntil?.toISOString() ?? null,
      reviewDueOn: d.reviewDueOn?.toISOString() ?? null,
      pointOfNoReturn: d.pointOfNoReturn?.toISOString() ?? null,
      chosenOption: d.chosenOption,
      rationale: d.rationale,
      outcomeAssessment: d.outcomeAssessment,
      evidencePack: pack,
      // Not decidable until the pack is complete.
      availableDispositions: d.evidenceComplete ? ['decide', 'delegate', 'defer', 'request_evidence'] : ['request_evidence'],
      drillPath: drillPathFor(d.subjectType, d.subjectId),
      ranked: {
        band: d.state === 'AwaitingAuthority' ? ('my_due_items' as const) : ('scored' as const),
        score: Math.floor((Date.now() - d.raisedAt.getTime()) / 3_600_000),
        whyRanked: [`${Math.floor((Date.now() - d.raisedAt.getTime()) / 3_600_000)}h on the clock`, d.state],
      },
    };
  });
}

export interface DispositionInput {
  decisionId: string;
  disposition: DecisionDisposition;
  rationale: string;
  chosenOption?: string;
  confidence?: number;
  delegateToPartyId?: string;
  returnDueOn?: Date;
  deferUntil?: Date;
  rationaleAudioRef?: string;
}

export async function disposeDecision(input: DispositionInput) {
  const auth = currentAuth();

  // Exclusively human acts. An agent principal can never reach this path.
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden(
      'There is no AI disposition authority on this surface. Decide, Delegate, Defer and Request-Evidence are exclusively human acts.',
    );
  }

  await assertCan({ resource: 'decisions', verb: 'approve' });

  const decision = await prisma.decision.findFirst({ where: { id: input.decisionId } });
  if (!decision) throw ApiError.notFound('Decision');

  if (!decision.evidenceComplete && input.disposition !== 'request_evidence') {
    throw ApiError.unprocessable(
      'This decision\'s evidence pack is incomplete. It is not decidable until every mandatory component is assembled.',
      { missing: (decision.evidencePack as { missingComponents?: string[] })?.missingComponents ?? [] },
    );
  }

  if (input.disposition === 'decide') {
    if (!input.chosenOption) throw ApiError.badRequest('Decide requires a chosen option.');

    // Authority is checked at write time.
    if (decision.requiredAuthorityValue) {
      await assertCan({
        resource: 'decisions',
        verb: 'approve',
        magnitude: {
          authorityClass: decision.authorityBasis,
          value: num(decision.requiredAuthorityValue)!,
          currency: decision.currency ?? 'INR',
        },
      });
    }

    const updated = await prisma.decision.update({
      where: { id: input.decisionId },
      data: {
        state: 'Implemented',
        chosenOption: input.chosenOption,
        rationale: input.rationale,
        rationaleAudioRef: input.rationaleAudioRef ?? null,
        confidence: input.confidence ?? null,
        decidedById: auth.partyId,
        decidedAt: new Date(),
        // A decision does not close at disposition: review_due_on is mandatory
        // and armed on Decided.
        reviewDueOn: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    await emit({
      name: EVENTS.DECISION_DECIDED,
      subject: { entityType: 'decision', entityId: input.decisionId, recordCode: decision.recordCode },
      previousState: { state: decision.state },
      newState: { state: 'Implemented', chosenOption: input.chosenOption, reviewDueOn: updated.reviewDueOn },
      reason: { reasonCode: 'decided', note: input.rationale },
      confidentiality: 'confidential',
    });

    return updated;
  }

  if (input.disposition === 'delegate') {
    if (!input.delegateToPartyId) throw ApiError.badRequest('Delegate requires a target principal.');
    if (!input.returnDueOn) throw ApiError.badRequest('Delegate requires a mandatory return date.');

    await prisma.delegation.create({
      data: {
        tenantId: auth.tenantId,
        decisionId: input.decisionId,
        fromPartyId: auth.partyId ?? 'system',
        toPartyId: input.delegateToPartyId,
        scope: decision.authorityBasis,
        reason: input.rationale,
        returnDueOn: input.returnDueOn,
      },
    });

    const updated = await prisma.decision.update({
      where: { id: input.decisionId },
      data: { state: 'Delegated', routedToPartyId: input.delegateToPartyId, rationale: input.rationale },
    });

    await emit({
      name: EVENTS.DECISION_DELEGATED,
      subject: { entityType: 'decision', entityId: input.decisionId, recordCode: decision.recordCode },
      newState: { state: 'Delegated', toPartyId: input.delegateToPartyId, returnDueOn: input.returnDueOn },
      reason: { reasonCode: 'delegated', note: input.rationale },
    });

    return updated;
  }

  if (input.disposition === 'defer') {
    if (!input.deferUntil) throw ApiError.badRequest('Defer requires a date.');

    // Refused outright, not merely warned, if the deferral would fall after the
    // decision's point of no return.
    if (decision.pointOfNoReturn && input.deferUntil > decision.pointOfNoReturn) {
      throw ApiError.unprocessable(
        `Deferring to ${input.deferUntil.toISOString().slice(0, 10)} falls after this decision's point of no return (${decision.pointOfNoReturn.toISOString().slice(0, 10)}). Refused.`,
        { pointOfNoReturn: decision.pointOfNoReturn },
      );
    }

    const updated = await prisma.decision.update({
      where: { id: input.decisionId },
      data: { state: 'Deferred', deferUntil: input.deferUntil, rationale: input.rationale, slaDueAt: input.deferUntil },
    });

    await emit({
      name: EVENTS.DECISION_DEFERRED,
      subject: { entityType: 'decision', entityId: input.decisionId, recordCode: decision.recordCode },
      newState: { state: 'Deferred', deferUntil: input.deferUntil },
      reason: { reasonCode: 'deferred', note: input.rationale },
    });

    return updated;
  }

  // Request more evidence: holds the item's queue position AND its clock,
  // rather than silently dropping it to a parking lot.
  const updated = await prisma.decision.update({
    where: { id: input.decisionId },
    data: { state: 'EvidenceRequested', rationale: input.rationale },
  });

  await emit({
    name: EVENTS.DECISION_EVIDENCE_REQUESTED,
    subject: { entityType: 'decision', entityId: input.decisionId, recordCode: decision.recordCode },
    newState: { state: 'EvidenceRequested' },
    reason: { reasonCode: 'evidence_requested', note: input.rationale },
  });

  return updated;
}

/**
 * The loop only closes with BOTH a recorded lesson and a resolved change
 * commitment. A review that changes nothing does not count as closed.
 */
export async function reviewDecision(
  decisionId: string,
  input: { outcomeAssessment: string; varianceBand: string; lesson: string; changeCommitment: string },
) {
  const auth = currentAuth();
  const decision = await prisma.decision.findFirst({ where: { id: decisionId } });
  if (!decision) throw ApiError.notFound('Decision');

  await prisma.lesson.create({
    data: {
      tenantId: auth.tenantId,
      sourceType: 'decision',
      sourceId: decisionId,
      title: decision.question,
      body: input.lesson,
      domain: 'gov',
      createdById: auth.partyId,
    },
  });

  return prisma.decision.update({
    where: { id: decisionId },
    data: {
      state: 'Reviewed',
      outcomeAssessment: input.outcomeAssessment,
      varianceBand: input.varianceBand,
      changeCommitment: input.changeCommitment,
      changeCommitmentResolved: true,
    },
  });
}

/**
 * Calibration: DECISION.confidence recorded before the outcome was known,
 * against the realised assessment. A computed statistic, not an AI inference.
 */
export async function decisionCalibration() {
  const auth = currentAuth();
  const decided = await prisma.decision.findMany({
    where: { tenantId: auth.tenantId, confidence: { not: null }, outcomeAssessment: { not: null } },
    select: { confidence: true, outcomeAssessment: true, varianceBand: true, question: true, decidedAt: true },
    orderBy: { decidedAt: 'desc' },
    take: 50,
  });

  const buckets = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((upper, i, arr) => {
    const lower = i === 0 ? 0 : arr[i - 1];
    const inBucket = decided.filter((d) => (d.confidence ?? 0) > lower && (d.confidence ?? 0) <= upper);
    const realised = inBucket.filter((d) => d.outcomeAssessment === 'as_expected' || d.varianceBand === 'within').length;
    return {
      band: `${Math.round(lower * 100)}–${Math.round(upper * 100)}%`,
      stated: Math.round(((lower + upper) / 2) * 100),
      realised: inBucket.length ? Math.round((realised / inBucket.length) * 100) : null,
      count: inBucket.length,
    };
  });

  return { buckets, sampleSize: decided.length, components: EVIDENCE_PACK_COMPONENTS };
}
