/**
 * HCM — WS5 performance (docs/hcm/performance.md). Mounted at
 * /api/hcm/performance.
 *
 * Review cycles and talent management, built alongside the existing
 * Goal/PerformanceEvidence pair in `../performance.ts` — that file remains
 * the continuous, append-only record of what a person did; this one is the
 * periodic reading of it (cycles, calibration, final ratings) plus the
 * ongoing talent processes around it (feedback, 1:1s, PIPs, succession).
 *
 * The one rule that recurs on every write here is the Self-Dealing Bar in
 * its non-financial form: nobody releases their own rating, closes their own
 * PIP, or reviews themselves outside the self form. There is no money moved
 * by this file — `incrementRecommendedPct` is a calibration recommendation
 * for WS7 compensation to act on, never a disbursement, and is never
 * withheld-as-null the way an actual pay figure would be.
 */

import {
  EVENTS,
  REVIEW_CYCLE_KINDS,
  REVIEW_CYCLE_PHASES,
  REVIEW_ASSIGNMENT_KINDS,
  FEEDBACK_KINDS,
  FEEDBACK_VISIBILITIES,
  PIP_OUTCOMES,
  READINESS_LEVELS,
  POTENTIAL_LEVELS,
  nextPhase,
  canAdvancePhase,
  isCycleClosed,
  isValidReviewerAssignment,
  ratingTier,
  nineBoxCell,
  isRatingVisibleToSubject,
  canClosePip,
  canReleaseRating,
  type ReviewCycleKind,
  type ReviewCyclePhase,
  type ReviewAssignmentKind,
  type FeedbackKind,
  type FeedbackVisibility,
  type PipOutcome,
  type ReadinessLevel,
  type PotentialLevel,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';

registerGovernedEntities('hcm_performance', ['succession_plan', 'final_rating']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function employmentOrThrow(employmentRelationshipId: string): Promise<{ id: string; personId: string }> {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
    select: { id: true, personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment;
}

/** The current principal's own employment relationship, for the `/me` surfaces. */
export async function myEmploymentContext(): Promise<{ employmentRelationshipId: string | null; partyId: string | null }> {
  const auth = currentAuth();
  if (!auth.partyId) return { employmentRelationshipId: null, partyId: null };
  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: auth.partyId, status: { not: 'Terminated' } },
    orderBy: { hireEffectiveDate: 'desc' },
    select: { id: true },
  });
  return { employmentRelationshipId: employment?.id ?? null, partyId: auth.partyId };
}

// ---------------------------------------------------------------------------
// Review cycles
// ---------------------------------------------------------------------------

export async function listReviewCycles() {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'view' });
  return prisma.reviewCycle.findMany({ where: { tenantId: auth.tenantId }, orderBy: { startsOn: 'desc' } });
}

export async function getReviewCycle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'view' });
  const cycle = await prisma.reviewCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Review cycle');
  return cycle;
}

export async function createReviewCycle(input: {
  name: string;
  kind: ReviewCycleKind;
  periodLabel: string;
  startsOn: Date;
  endsOn: Date;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'create' });
  if (!REVIEW_CYCLE_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a review cycle kind. Expected one of: ${REVIEW_CYCLE_KINDS.join(', ')}.`);
  }
  if (input.endsOn.getTime() <= input.startsOn.getTime()) {
    throw ApiError.badRequest('A review cycle must end after it starts.');
  }

  const recordCode = await nextRecordCode('RVW');
  const cycle = await prisma.reviewCycle.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      kind: input.kind,
      periodLabel: input.periodLabel,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      phase: 'self',
    },
  });

  await emit({
    name: EVENTS.REVIEW_CYCLE_OPENED,
    subject: { entityType: 'review_cycle', entityId: cycle.id, recordCode },
    newState: { phase: cycle.phase, kind: cycle.kind, periodLabel: cycle.periodLabel },
    impact: { domains: ['hr'] },
  });

  return cycle;
}

/**
 * Advances a cycle exactly one phase forward (self -> manager -> calibration
 * -> closed). Closing is what makes a released FinalRating visible to its
 * subject, so it is the one phase change that also fires its own event.
 */
export async function advanceReviewCyclePhase(id: string, to: ReviewCyclePhase) {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'edit' });

  const cycle = await prisma.reviewCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Review cycle');

  const from = cycle.phase as ReviewCyclePhase;
  if (!REVIEW_CYCLE_PHASES.includes(to)) {
    throw ApiError.badRequest(`"${to}" is not a review cycle phase. Expected one of: ${REVIEW_CYCLE_PHASES.join(', ')}.`);
  }
  if (!canAdvancePhase(from, to)) {
    const expected = nextPhase(from);
    throw ApiError.unprocessable(
      expected
        ? `Cycle is in phase "${from}"; it can only advance to "${expected}" next, not "${to}".`
        : `Cycle is already "${from}", which is final. Nothing further can be recorded against it.`,
    );
  }

  if (to === 'calibration') {
    const openAssignments = await prisma.reviewAssignment.count({
      where: { tenantId: auth.tenantId, cycleId: id, status: 'pending' },
    });
    if (openAssignments > 0) {
      throw ApiError.unprocessable(
        `${openAssignments} review assignment(s) are still pending. Calibration opens once every assignment has been submitted.`,
      );
    }
  }

  const updated = await prisma.reviewCycle.update({ where: { id }, data: { phase: to } });

  if (to === 'closed') {
    await emit({
      name: EVENTS.REVIEW_CYCLE_CLOSED,
      subject: { entityType: 'review_cycle', entityId: id, recordCode: cycle.recordCode },
      previousState: { phase: from },
      newState: { phase: to },
      impact: { domains: ['hr'] },
    });
  }

  await auditWrite({
    action: 'update',
    subjectType: 'review_cycle',
    subjectId: id,
    before: { phase: from },
    after: { phase: to },
    force: true,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Review templates
// ---------------------------------------------------------------------------

export async function listReviewTemplates() {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'view' });
  return prisma.reviewTemplate.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } });
}

export async function createReviewTemplate(input: { name: string; sections: unknown; ratingScale: unknown }) {
  const auth = currentAuth();
  await assertCan({ resource: 'review_cycles', verb: 'create' });
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw ApiError.badRequest('A review template needs at least one section.');
  }
  if (!Array.isArray(input.ratingScale) || input.ratingScale.length === 0) {
    throw ApiError.badRequest('A review template needs a rating scale.');
  }
  return prisma.reviewTemplate.create({
    data: { tenantId: auth.tenantId, name: input.name, sections: input.sections as never, ratingScale: input.ratingScale as never },
  });
}

// ---------------------------------------------------------------------------
// Review assignments + responses
// ---------------------------------------------------------------------------

export async function listReviewAssignments(filters: { cycleId?: string; employmentRelationshipId?: string; mine?: boolean }) {
  const auth = currentAuth();
  await assertCan({ resource: 'reviews', verb: 'view' });
  const scope = await scopeFor('reviews', 'view');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filters.cycleId) where.cycleId = filters.cycleId;
  if (filters.employmentRelationshipId) where.employmentRelationshipId = filters.employmentRelationshipId;

  if (filters.mine || scope !== 'all') {
    where.reviewerPartyId = auth.partyId;
  }

  const assignments = await prisma.reviewAssignment.findMany({ where, orderBy: { createdAt: 'desc' } });
  const responses = await prisma.reviewResponse.findMany({
    where: { tenantId: auth.tenantId, assignmentId: { in: assignments.map((a) => a.id) } },
  });
  const byAssignment = new Map(responses.map((r) => [r.assignmentId, r]));
  return assignments.map((a) => ({ ...a, response: byAssignment.get(a.id) ?? null }));
}

export async function createReviewAssignment(input: {
  cycleId: string;
  templateId?: string | null;
  employmentRelationshipId: string;
  reviewerEmploymentRelationshipId: string;
  kind: ReviewAssignmentKind;
  dueAt?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'reviews', verb: 'create' });

  if (!REVIEW_ASSIGNMENT_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a review assignment kind. Expected one of: ${REVIEW_ASSIGNMENT_KINDS.join(', ')}.`);
  }

  const cycle = await prisma.reviewCycle.findFirst({ where: { id: input.cycleId, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Review cycle');
  if (isCycleClosed(cycle.phase as ReviewCyclePhase)) {
    throw ApiError.unprocessable('This review cycle is closed. No further assignments can be opened against it.');
  }

  const subject = await employmentOrThrow(input.employmentRelationshipId);
  const reviewer = await employmentOrThrow(input.reviewerEmploymentRelationshipId);

  if (!isValidReviewerAssignment(input.kind, subject.personId, reviewer.personId)) {
    throw ApiError.unprocessable(
      input.kind === 'self'
        ? 'A self assignment must have the subject reviewing themselves.'
        : `A "${input.kind}" review needs a reviewer who is not the subject — a reviewer never reviews themselves outside the self form.`,
    );
  }

  const assignment = await prisma.reviewAssignment.create({
    data: {
      tenantId: auth.tenantId,
      cycleId: input.cycleId,
      templateId: input.templateId ?? null,
      employmentRelationshipId: input.employmentRelationshipId,
      subjectPartyId: subject.personId,
      reviewerEmploymentRelationshipId: input.reviewerEmploymentRelationshipId,
      reviewerPartyId: reviewer.personId,
      kind: input.kind,
      dueAt: input.dueAt ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'review_assignment', subjectId: assignment.id, after: assignment as never });
  return assignment;
}

export async function getReviewAssignment(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'reviews', verb: 'view' });
  const assignment = await prisma.reviewAssignment.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!assignment) throw ApiError.notFound('Review assignment');

  // Only the reviewer themselves (or an all-scope grant) may fetch a single
  // assignment by id — a subject who is not also its reviewer (i.e. every
  // kind but `self`) must never be able to resolve this record, since it
  // carries the peer/upward reviewer's identity and their submitted
  // ratings/comments before the cycle closes and any rating is released.
  const scope = await scopeFor('reviews', 'view');
  if (scope !== 'all' && assignment.reviewerPartyId !== auth.partyId) {
    throw ApiError.notFound('Review assignment');
  }

  const response = await prisma.reviewResponse.findUnique({ where: { assignmentId: id } });
  return { ...assignment, response };
}

export async function submitReviewResponse(assignmentId: string, input: { ratings: unknown; comments?: string | null }) {
  const auth = currentAuth();
  const assignment = await prisma.reviewAssignment.findFirst({ where: { id: assignmentId, tenantId: auth.tenantId } });
  if (!assignment) throw ApiError.notFound('Review assignment');

  await assertCan({ resource: 'reviews', verb: 'edit', record: { ownerPartyId: assignment.reviewerPartyId } });

  if (assignment.status === 'submitted') {
    throw ApiError.conflict('This review has already been submitted. A correction is a new assignment, not an edit to a filed one.');
  }
  if (!Array.isArray(input.ratings) || input.ratings.length === 0) {
    throw ApiError.badRequest('A review response needs at least one rating.');
  }

  const cycle = await prisma.reviewCycle.findFirst({ where: { id: assignment.cycleId, tenantId: auth.tenantId } });
  if (cycle && isCycleClosed(cycle.phase as ReviewCyclePhase)) {
    throw ApiError.unprocessable('This review cycle is closed. Responses can no longer be filed against it.');
  }

  const response = await prisma.$transaction(async (tx) => {
    const created = await tx.reviewResponse.create({
      data: {
        tenantId: auth.tenantId,
        assignmentId,
        ratings: input.ratings as never,
        comments: input.comments ?? null,
      },
    });
    await tx.reviewAssignment.update({ where: { id: assignmentId }, data: { status: 'submitted' } });
    return created;
  });

  await emit({
    name: EVENTS.REVIEW_SUBMITTED,
    subject: { entityType: 'review_assignment', entityId: assignmentId },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: assignment.employmentRelationshipId }],
    newState: { status: 'submitted', kind: assignment.kind },
    owner: { partyId: assignment.reviewerPartyId },
    impact: { domains: ['hr'] },
  });

  return response;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationDecisionInput {
  employmentRelationshipId: string;
  rating: string;
  potential: PotentialLevel;
  band?: string | null;
  promotionRecommended?: boolean;
  incrementRecommendedPct?: number | null;
  note?: string | null;
}

export async function listCalibrationSessions(cycleId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'calibrations', verb: 'view' });
  return prisma.calibrationSession.findMany({
    where: { tenantId: auth.tenantId, ...(cycleId ? { cycleId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function openCalibrationSession(input: { cycleId: string; participants: Array<{ employmentRelationshipId: string }> }) {
  const auth = currentAuth();
  await assertCan({ resource: 'calibrations', verb: 'create' });

  const cycle = await prisma.reviewCycle.findFirst({ where: { id: input.cycleId, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Review cycle');
  if (cycle.phase !== 'calibration') {
    throw ApiError.unprocessable(`Cycle is in phase "${cycle.phase}". A calibration session opens once it reaches "calibration".`);
  }
  if (!input.participants?.length) throw ApiError.badRequest('A calibration session needs at least one participant.');

  const session = await prisma.calibrationSession.create({
    data: {
      tenantId: auth.tenantId,
      cycleId: input.cycleId,
      facilitatorPartyId: auth.partyId,
      participants: input.participants as never,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'calibration_session', subjectId: session.id, after: session as never });
  return session;
}

export async function updateCalibrationDecisions(id: string, decisions: CalibrationDecisionInput[]) {
  const auth = currentAuth();
  await assertCan({ resource: 'calibrations', verb: 'edit' });

  const session = await prisma.calibrationSession.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!session) throw ApiError.notFound('Calibration session');
  if (session.status === 'closed') throw ApiError.conflict('This calibration session is closed and can no longer be edited.');

  for (const d of decisions) {
    if (!POTENTIAL_LEVELS.includes(d.potential)) {
      throw ApiError.badRequest(`"${d.potential}" is not a potential level. Expected one of: ${POTENTIAL_LEVELS.join(', ')}.`);
    }
  }

  return prisma.calibrationSession.update({ where: { id }, data: { decisions: decisions as never } });
}

/**
 * Closing a session snapshots each decision into a FinalRating row (created
 * or overwritten by the same tenant/cycle/employment key) and locks the
 * session. Nothing is released yet — that is a distinct, later action, and
 * the one the Self-Dealing Bar applies to.
 */
export async function closeCalibrationSession(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'calibrations', verb: 'edit' });

  const session = await prisma.calibrationSession.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!session) throw ApiError.notFound('Calibration session');
  if (session.status === 'closed') throw ApiError.conflict('This calibration session is already closed.');

  const decisions = (session.decisions as unknown as CalibrationDecisionInput[]) ?? [];
  if (decisions.length === 0) {
    throw ApiError.unprocessable('There are no decisions recorded. Record at least one before closing the session.');
  }

  await prisma.$transaction(async (tx) => {
    for (const d of decisions) {
      const employment = await tx.employmentRelationship.findFirst({
        where: { id: d.employmentRelationshipId, tenantId: auth.tenantId },
        select: { personId: true },
      });
      if (!employment) continue;
      await tx.finalRating.upsert({
        where: { tenantId_cycleId_employmentRelationshipId: { tenantId: auth.tenantId, cycleId: session.cycleId, employmentRelationshipId: d.employmentRelationshipId } },
        create: {
          tenantId: auth.tenantId,
          cycleId: session.cycleId,
          employmentRelationshipId: d.employmentRelationshipId,
          subjectPartyId: employment.personId,
          rating: d.rating,
          potential: d.potential,
          band: d.band ?? null,
          promotionRecommended: d.promotionRecommended ?? false,
          incrementRecommendedPct: d.incrementRecommendedPct ?? null,
        },
        update: {
          rating: d.rating,
          potential: d.potential,
          band: d.band ?? null,
          promotionRecommended: d.promotionRecommended ?? false,
          incrementRecommendedPct: d.incrementRecommendedPct ?? null,
        },
      });
    }
    await tx.calibrationSession.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
  });

  await emit({
    name: EVENTS.CALIBRATION_CLOSED,
    subject: { entityType: 'calibration_session', entityId: id },
    related: [{ relation: 'for', entityType: 'review_cycle', entityId: session.cycleId }],
    newState: { status: 'closed', decisionCount: decisions.length },
    impact: { domains: ['hr'] },
  });

  return prisma.calibrationSession.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Final ratings
// ---------------------------------------------------------------------------

export async function listFinalRatings(filters: { cycleId?: string; employmentRelationshipId?: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'reviews', verb: 'view' });
  const scope = await scopeFor('reviews', 'view');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filters.cycleId) where.cycleId = filters.cycleId;
  if (filters.employmentRelationshipId) where.employmentRelationshipId = filters.employmentRelationshipId;

  const rows = await prisma.finalRating.findMany({ where, orderBy: { createdAt: 'desc' } });

  if (scope === 'all') return rows;

  // Narrowed to `own`: only the caller's own rows, and only once released —
  // the plan's rule that ratings are hidden from the employee until the
  // cycle is closed and the row released.
  const cycles = new Map<string, ReviewCyclePhase>();
  const visible: typeof rows = [];
  for (const row of rows) {
    if (row.subjectPartyId !== auth.partyId) continue;
    if (!cycles.has(row.cycleId)) {
      const cycle = await prisma.reviewCycle.findFirst({ where: { id: row.cycleId, tenantId: auth.tenantId } });
      cycles.set(row.cycleId, (cycle?.phase as ReviewCyclePhase) ?? 'self');
    }
    if (isRatingVisibleToSubject(cycles.get(row.cycleId)!, row.released)) visible.push(row);
  }
  return visible;
}

/** Releases one person's rating so they can see it. Barred from the subject themselves — the Self-Dealing Bar in its non-financial form. */
export async function releaseFinalRating(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'reviews', verb: 'edit' });

  // `reviews:edit` alone is not enough: an employee holds it too, at `own`
  // scope, for filing their own review response — and `assertCan` without a
  // `record` never checks the WHERE axis. Releasing somebody else's rating is
  // never an `own`-scope action, so it is gated on the resolved scope being
  // `all` here explicitly, the same way `nineBoxForCycle` gates an aggregate
  // read. Without this an ordinary employee could release a colleague's
  // rating outright — the Self-Dealing Bar alone only stops them releasing
  // their *own*.
  const scope = await scopeFor('reviews', 'edit');
  if (scope !== 'all') {
    throw ApiError.forbidden('Releasing a rating needs an all-scope grant on reviews; it is not a self-service action.');
  }

  const rating = await prisma.finalRating.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!rating) throw ApiError.notFound('Final rating');
  if (rating.released) throw ApiError.conflict('This rating has already been released.');

  const cycle = await prisma.reviewCycle.findFirst({ where: { id: rating.cycleId, tenantId: auth.tenantId } });
  if (!cycle || !isCycleClosed(cycle.phase as ReviewCyclePhase)) {
    throw ApiError.unprocessable('A rating can only be released once its cycle is closed — calibration is not final until then.');
  }

  if (!canReleaseRating(rating.subjectPartyId, auth.partyId ?? '')) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: nobody may release their own rating.');
  }

  const updated = await prisma.finalRating.update({
    where: { id },
    data: { released: true, releasedAt: new Date(), releasedById: auth.partyId },
  });

  await emit({
    name: EVENTS.FINAL_RATING_RELEASED,
    subject: { entityType: 'final_rating', entityId: id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: rating.employmentRelationshipId }],
    newState: { rating: rating.rating, band: rating.band, released: true },
    owner: { partyId: rating.subjectPartyId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

/** The 9-box grid for a cycle: one cell per rated employment. HR-only — a
 * scope narrower than `all` cannot answer a question about everybody. */
export async function nineBoxForCycle(cycleId: string) {
  const auth = currentAuth();
  const scope = await scopeFor('reviews', 'view');
  if (scope !== 'all') {
    throw ApiError.forbidden('The 9-box is a statement about every rated employee at once; it needs an all-scope grant on reviews.');
  }
  const rows = await prisma.finalRating.findMany({ where: { tenantId: auth.tenantId, cycleId, rating: { not: null }, potential: { not: null } } });
  return rows.map((r) => {
    const performanceTier = ratingTier(Number(r.rating));
    const cell = nineBoxCell(performanceTier, r.potential as PotentialLevel);
    return { employmentRelationshipId: r.employmentRelationshipId, rating: r.rating, potential: r.potential, ...cell };
  });
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function listFeedback(filters: { employmentRelationshipId?: string; direction?: 'given' | 'received' }) {
  const auth = currentAuth();
  await assertCan({ resource: 'feedback', verb: 'view' });
  const scope = await scopeFor('feedback', 'view');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filters.employmentRelationshipId) {
    where[filters.direction === 'given' ? 'fromEmploymentRelationshipId' : 'toEmploymentRelationshipId'] = filters.employmentRelationshipId;
  }
  if (scope !== 'all') {
    where.OR = [{ toPartyId: auth.partyId }, { fromPartyId: auth.partyId }];
  }

  return prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' } });
}

export async function giveFeedback(input: {
  fromEmploymentRelationshipId: string;
  toEmploymentRelationshipId: string;
  kind: FeedbackKind;
  message: string;
  visibility?: FeedbackVisibility;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'feedback', verb: 'create' });

  if (!FEEDBACK_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a feedback kind. Expected one of: ${FEEDBACK_KINDS.join(', ')}.`);
  }
  const visibility = input.visibility ?? 'private';
  if (!FEEDBACK_VISIBILITIES.includes(visibility)) {
    throw ApiError.badRequest(`"${visibility}" is not a feedback visibility. Expected one of: ${FEEDBACK_VISIBILITIES.join(', ')}.`);
  }
  if (!input.message.trim()) throw ApiError.badRequest('Feedback needs a message.');

  const from = await employmentOrThrow(input.fromEmploymentRelationshipId);
  const to = await employmentOrThrow(input.toEmploymentRelationshipId);

  const scope = await scopeFor('feedback', 'create');
  if (scope !== 'all' && from.personId !== auth.partyId) {
    throw ApiError.forbidden('Feedback is given as yourself: the "from" employment must be your own.');
  }

  const row = await prisma.feedback.create({
    data: {
      tenantId: auth.tenantId,
      fromEmploymentRelationshipId: input.fromEmploymentRelationshipId,
      fromPartyId: from.personId,
      toEmploymentRelationshipId: input.toEmploymentRelationshipId,
      toPartyId: to.personId,
      kind: input.kind,
      message: input.message,
      visibility,
    },
  });

  await emit({
    name: EVENTS.FEEDBACK_GIVEN,
    subject: { entityType: 'feedback', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.toEmploymentRelationshipId }],
    newState: { kind: input.kind, visibility },
    owner: { partyId: to.personId },
    impact: { domains: ['hr'] },
  });

  return row;
}

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

export async function listOneOnOnes(filters: { employmentRelationshipId?: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'one_on_ones', verb: 'view' });
  const scope = await scopeFor('one_on_ones', 'view');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filters.employmentRelationshipId) where.reportEmploymentRelationshipId = filters.employmentRelationshipId;
  if (scope !== 'all') where.OR = [{ reportPartyId: auth.partyId }, { managerPartyId: auth.partyId }];

  return prisma.oneOnOne.findMany({ where, orderBy: { scheduledAt: 'desc' } });
}

export async function scheduleOneOnOne(input: {
  managerEmploymentRelationshipId: string;
  reportEmploymentRelationshipId: string;
  scheduledAt: Date;
  agenda?: unknown;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'one_on_ones', verb: 'create' });

  const manager = await employmentOrThrow(input.managerEmploymentRelationshipId);
  const report = await employmentOrThrow(input.reportEmploymentRelationshipId);
  if (manager.personId === report.personId) {
    throw ApiError.badRequest('A 1:1 needs two different people — the manager and the report.');
  }

  const row = await prisma.oneOnOne.create({
    data: {
      tenantId: auth.tenantId,
      managerEmploymentRelationshipId: input.managerEmploymentRelationshipId,
      managerPartyId: manager.personId,
      reportEmploymentRelationshipId: input.reportEmploymentRelationshipId,
      reportPartyId: report.personId,
      scheduledAt: input.scheduledAt,
      agenda: (input.agenda ?? null) as never,
    },
  });

  await emit({
    name: EVENTS.ONE_ON_ONE_SCHEDULED,
    subject: { entityType: 'one_on_one', entityId: row.id },
    related: [{ relation: 'with', entityType: 'employment_relationship', entityId: input.reportEmploymentRelationshipId }],
    newState: { scheduledAt: row.scheduledAt.toISOString(), status: row.status },
    owner: { partyId: report.personId },
    impact: { domains: ['hr'] },
  });

  return row;
}

export async function updateOneOnOne(
  id: string,
  patch: { notes?: unknown; actions?: unknown; status?: 'scheduled' | 'completed' | 'cancelled' },
) {
  const auth = currentAuth();
  const row = await prisma.oneOnOne.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('1:1');

  await assertCan({ resource: 'one_on_ones', verb: 'edit', record: { ownerPartyId: row.reportPartyId } });

  return prisma.oneOnOne.update({
    where: { id },
    data: {
      notes: patch.notes === undefined ? undefined : (patch.notes as never),
      actions: patch.actions === undefined ? undefined : (patch.actions as never),
      status: patch.status,
    },
  });
}

// ---------------------------------------------------------------------------
// PIPs
// ---------------------------------------------------------------------------

export async function listPips(filters: { employmentRelationshipId?: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'pips', verb: 'view' });
  const scope = await scopeFor('pips', 'view');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filters.employmentRelationshipId) where.employmentRelationshipId = filters.employmentRelationshipId;
  if (scope !== 'all') where.subjectPartyId = auth.partyId;

  return prisma.pip.findMany({ where, orderBy: { startsOn: 'desc' } });
}

export async function openPip(input: {
  employmentRelationshipId: string;
  managerEmploymentRelationshipId?: string | null;
  startsOn: Date;
  endsOn: Date;
  objectives: unknown;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'pips', verb: 'create' });

  if (input.endsOn.getTime() <= input.startsOn.getTime()) {
    throw ApiError.badRequest('A PIP must end after it starts.');
  }
  if (!Array.isArray(input.objectives) || input.objectives.length === 0) {
    throw ApiError.badRequest('A PIP needs at least one objective.');
  }

  const subject = await employmentOrThrow(input.employmentRelationshipId);
  const manager = input.managerEmploymentRelationshipId ? await employmentOrThrow(input.managerEmploymentRelationshipId) : null;

  const row = await prisma.pip.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      subjectPartyId: subject.personId,
      managerEmploymentRelationshipId: input.managerEmploymentRelationshipId ?? null,
      managerPartyId: manager?.personId ?? null,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      objectives: input.objectives as never,
    },
  });

  await emit({
    name: EVENTS.PIP_OPENED,
    subject: { entityType: 'pip', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { outcome: row.outcome, startsOn: row.startsOn.toISOString(), endsOn: row.endsOn.toISOString() },
    owner: { partyId: subject.personId },
    impact: { domains: ['hr'] },
  });

  return row;
}

export async function addPipCheckpoint(id: string, checkpoint: { note: string; onTrack: boolean }) {
  const auth = currentAuth();
  const pip = await prisma.pip.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!pip) throw ApiError.notFound('PIP');
  await assertCan({ resource: 'pips', verb: 'edit' });
  if (pip.outcome !== 'open') throw ApiError.conflict(`This PIP is already ${pip.outcome}. No further checkpoints can be added.`);

  const checkpoints = ((pip.checkpoints as unknown as Array<Record<string, unknown>>) ?? []).concat([
    { at: new Date().toISOString(), note: checkpoint.note, onTrack: checkpoint.onTrack },
  ]);
  return prisma.pip.update({ where: { id }, data: { checkpoints: checkpoints as never } });
}

/** Closes a PIP. Barred from the person it is about — the Self-Dealing Bar in its corrective form. */
export async function closePip(id: string, outcome: PipOutcome, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'pips', verb: 'edit' });

  const pip = await prisma.pip.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!pip) throw ApiError.notFound('PIP');
  if (pip.outcome !== 'open') throw ApiError.conflict(`This PIP is already ${pip.outcome}.`);
  if (outcome === 'open') throw ApiError.badRequest('Closing a PIP requires a real outcome, not "open".');
  if (!PIP_OUTCOMES.includes(outcome)) {
    throw ApiError.badRequest(`"${outcome}" is not a PIP outcome. Expected one of: ${PIP_OUTCOMES.join(', ')}.`);
  }

  if (!canClosePip(pip.subjectPartyId, auth.partyId ?? '')) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: nobody may close their own PIP.');
  }

  const updated = await prisma.pip.update({
    where: { id },
    data: { outcome, closedAt: new Date(), closedById: auth.partyId },
  });

  await emit({
    name: EVENTS.PIP_CLOSED,
    subject: { entityType: 'pip', entityId: id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: pip.employmentRelationshipId }],
    previousState: { outcome: 'open' },
    newState: { outcome },
    reason: note ? { reasonCode: outcome, note } : null,
    owner: { partyId: pip.subjectPartyId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Succession
// ---------------------------------------------------------------------------

export interface SuccessorInput {
  employmentRelationshipId: string;
  readiness: ReadinessLevel;
  note?: string | null;
}

export async function listSuccessionPlans() {
  const auth = currentAuth();
  await assertCan({ resource: 'succession_plans', verb: 'view' });
  return prisma.successionPlan.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } });
}

export async function createSuccessionPlan(input: { positionTitle: string; positionId?: string | null; successors: SuccessorInput[] }) {
  const auth = currentAuth();
  await assertCan({ resource: 'succession_plans', verb: 'create' });

  for (const s of input.successors ?? []) {
    if (!READINESS_LEVELS.includes(s.readiness)) {
      throw ApiError.badRequest(`"${s.readiness}" is not a readiness level. Expected one of: ${READINESS_LEVELS.join(', ')}.`);
    }
    await employmentOrThrow(s.employmentRelationshipId);
  }

  const row = await prisma.successionPlan.create({
    data: {
      tenantId: auth.tenantId,
      positionTitle: input.positionTitle,
      positionId: input.positionId ?? null,
      successors: (input.successors ?? []) as never,
    },
  });

  await emit({
    name: EVENTS.SUCCESSION_PLAN_UPDATED,
    subject: { entityType: 'succession_plan', entityId: row.id },
    newState: { positionTitle: row.positionTitle, successorCount: (input.successors ?? []).length },
    confidentiality: 'confidential',
    impact: { domains: ['hr'] },
  });

  return row;
}

export async function updateSuccessionPlan(id: string, successors: SuccessorInput[]) {
  const auth = currentAuth();
  await assertCan({ resource: 'succession_plans', verb: 'edit' });

  const plan = await prisma.successionPlan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!plan) throw ApiError.notFound('Succession plan');

  for (const s of successors) {
    if (!READINESS_LEVELS.includes(s.readiness)) {
      throw ApiError.badRequest(`"${s.readiness}" is not a readiness level. Expected one of: ${READINESS_LEVELS.join(', ')}.`);
    }
    await employmentOrThrow(s.employmentRelationshipId);
  }

  const updated = await prisma.successionPlan.update({ where: { id }, data: { successors: successors as never } });

  await emit({
    name: EVENTS.SUCCESSION_PLAN_UPDATED,
    subject: { entityType: 'succession_plan', entityId: id },
    newState: { successorCount: successors.length },
    confidentiality: 'confidential',
    impact: { domains: ['hr'] },
  });

  return updated;
}
