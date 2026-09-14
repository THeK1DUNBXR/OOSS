/**
 * Technology — the IT risk register (docs/plan/cio.md, workstream F).
 *
 * Inherent and residual scores are never a constant: `currentBandSet` reads
 * the `ItRiskScoringBand` rows in force at scoring time, `riskScore`/
 * `riskBandFor` (packages/shared/src/it/governance.ts) do the pure
 * arithmetic, and the row records which `setId` it was scored under
 * (`scoredUnderBandSetId`) so a later change to the bands never silently
 * reclassifies an already-scored risk (IT-RSK-001).
 */

import {
  EVENTS,
  IT_DOMAIN,
  riskScore,
  riskBandFor,
  bandSetInForce,
  riskMachine,
  GOVERNANCE_LADDER_RUNGS,
  type RiskState,
  type RiskEvent,
  type RiskScoringBandRow,
} from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { emit } from '../../../platform/eventBus.js';
import { availableTransitions } from '../../../platform/lifecycle.js';
import { nextRecordCode } from '../../../platform/recordCode.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan, visibilityWhere } from '../../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';
import { raiseException } from '../../../platform/exceptions.js';

registerGovernedEntities('it_governance', ['it_risk', 'it_risk_scoring_band']);

const RESOURCE = 'it_risks';

// ---------------------------------------------------------------------------
// Scoring bands
// ---------------------------------------------------------------------------

/** Every scoring-band row (all sets), for pure arithmetic to be handed
 * `bandSetInForce`/`riskBandFor`. */
async function allBandRows(): Promise<RiskScoringBandRow[]> {
  const auth = currentAuth();
  const rows = await prisma.itRiskScoringBand.findMany({ where: { tenantId: auth.tenantId } });
  return rows.map((r) => ({ setId: r.setId, band: r.band as RiskScoringBandRow['band'], minScore: r.minScore, effectiveFrom: r.effectiveFrom }));
}

/** Scores `likelihood x impact` against the band set in force `at` (default
 * now). Throws when no band set has taken effect yet — a risk with no band
 * to score under is a seed defect, never a silent constant. */
export async function scoreAgainstBands(
  likelihood: number,
  impact: number,
  at: Date = new Date(),
): Promise<{ score: number; band: string; setId: string }> {
  const all = await allBandRows();
  const setId = bandSetInForce(all, at);
  if (!setId) {
    throw ApiError.unprocessable('No risk scoring band set is in force yet. Run the seed before scoring a risk.');
  }
  const score = riskScore(likelihood, impact);
  const band = riskBandFor(score, all.filter((r) => r.setId === setId));
  return { score, band, setId };
}

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

export interface CreateRiskInput {
  title: string;
  category: string;
  ownerPartyId: string;
  likelihoodInherent: number;
  impactInherent: number;
  treatment: string;
  treatmentPlan?: string | null;
  reviewDueAt?: Date | null;
  controlIds?: string[];
}

const TREATMENTS = ['accept', 'mitigate', 'transfer', 'avoid'];

function assertScale(n: number, what: string) {
  if (!Number.isInteger(n) || n < 1 || n > 5) throw ApiError.badRequest(`${what} must be a whole number from 1 to 5.`);
}

export async function createRisk(input: CreateRiskInput) {
  await assertCan({ resource: RESOURCE, verb: 'create' });

  const title = input.title?.trim();
  if (!title) throw ApiError.badRequest('A risk needs a title.');
  if (!input.category?.trim()) throw ApiError.badRequest('A risk needs a category.');
  if (!input.ownerPartyId) throw ApiError.badRequest('A risk needs an owner.');
  if (!TREATMENTS.includes(input.treatment)) throw ApiError.badRequest(`Treatment must be one of: ${TREATMENTS.join(', ')}.`);
  assertScale(input.likelihoodInherent, 'Inherent likelihood');
  assertScale(input.impactInherent, 'Inherent impact');

  const auth = currentAuth();
  const scored = await scoreAgainstBands(input.likelihoodInherent, input.impactInherent);
  const recordCode = await nextRecordCode('ITR');

  const risk = await prisma.itRisk.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title,
      category: input.category.trim(),
      ownerPartyId: input.ownerPartyId,
      likelihoodInherent: input.likelihoodInherent,
      impactInherent: input.impactInherent,
      scoreInherent: scored.score,
      bandInherent: scored.band,
      scoredUnderBandSetId: scored.setId,
      treatment: input.treatment,
      treatmentPlan: input.treatmentPlan ?? null,
      reviewDueAt: input.reviewDueAt ?? null,
      controlIds: input.controlIds ?? [],
      status: 'open',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_risk', subjectId: risk.id, after: { recordCode, title, scoreInherent: scored.score, bandInherent: scored.band } });
  await emit({
    name: EVENTS.IT_RISK_CREATED,
    subject: { entityType: 'it_risk', entityId: risk.id, recordCode },
    newState: { status: risk.status, bandInherent: scored.band },
    owner: { partyId: input.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(risk);
}

export interface UpdateRiskInput {
  title?: string;
  category?: string;
  ownerPartyId?: string;
  treatment?: string;
  treatmentPlan?: string | null;
  reviewDueAt?: Date | null;
  controlIds?: string[];
  likelihoodResidual?: number;
  impactResidual?: number;
}

/** Edits descriptive fields and, when residual likelihood/impact are given,
 * rescores the residual score/band against the band set in force now. Status
 * moves only through `transitionRisk`. */
export async function updateRisk(id: string, patch: UpdateRiskInput) {
  const auth = currentAuth();
  const risk = await prisma.itRisk.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!risk) throw ApiError.notFound('Risk');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: risk.ownerPartyId } });

  if (patch.treatment && !TREATMENTS.includes(patch.treatment)) {
    throw ApiError.badRequest(`Treatment must be one of: ${TREATMENTS.join(', ')}.`);
  }

  let residual: { likelihoodResidual?: number; impactResidual?: number; scoreResidual?: number; bandResidual?: string; scoredUnderBandSetId?: string } = {};
  if (patch.likelihoodResidual !== undefined || patch.impactResidual !== undefined) {
    const likelihood = patch.likelihoodResidual ?? risk.likelihoodResidual;
    const impact = patch.impactResidual ?? risk.impactResidual;
    if (likelihood === null || likelihood === undefined || impact === null || impact === undefined) {
      throw ApiError.badRequest('Residual likelihood and impact are both needed to score a residual band.');
    }
    assertScale(likelihood, 'Residual likelihood');
    assertScale(impact, 'Residual impact');
    const scored = await scoreAgainstBands(likelihood, impact);
    residual = {
      likelihoodResidual: likelihood,
      impactResidual: impact,
      scoreResidual: scored.score,
      bandResidual: scored.band,
      scoredUnderBandSetId: scored.setId,
    };
  }

  const updated = await prisma.itRisk.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.ownerPartyId !== undefined ? { ownerPartyId: patch.ownerPartyId } : {}),
      ...(patch.treatment !== undefined ? { treatment: patch.treatment } : {}),
      ...(patch.treatmentPlan !== undefined ? { treatmentPlan: patch.treatmentPlan } : {}),
      ...(patch.reviewDueAt !== undefined ? { reviewDueAt: patch.reviewDueAt, reviewNotifiedRungs: [] } : {}),
      ...(patch.controlIds !== undefined ? { controlIds: patch.controlIds } : {}),
      ...residual,
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_risk', subjectId: id, before: risk, after: updated });
  return withTransitions(updated);
}

export interface RiskFilter {
  status?: string;
  band?: string;
  category?: string;
}

export async function listRisks(filter: RiskFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const scopeWhere = await visibilityWhere(RESOURCE);

  const rows = await prisma.itRisk.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.band ? { OR: [{ bandResidual: filter.band }, { AND: [{ bandResidual: null }, { bandInherent: filter.band }] }] } : {}),
      ...scopeWhere,
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(withTransitions);
}

export async function riskDetail(id: string) {
  const auth = currentAuth();
  const risk = await prisma.itRisk.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!risk) throw ApiError.notFound('Risk');
  await assertCan({ resource: RESOURCE, verb: 'view', record: { ownerPartyId: risk.ownerPartyId } });
  return withTransitions(risk);
}

function withTransitions<T extends { status: string }>(row: T): T & { availableTransitions: RiskEvent[] } {
  return { ...row, availableTransitions: availableTransitions(riskMachine, row.status as RiskState) };
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

/**
 * Applies the machine's own rule for `event`, exactly the shape
 * `platform/lifecycle.ts`'s generic `transition` would — but inline, because
 * that helper types its `resource` parameter against the CRM/HR resource
 * union declared in `packages/shared/src/permissions.ts`, which this
 * workstream's own files may not edit to extend (Technology's resources are
 * checked as plain strings by `assertCan`, not by that stricter type).
 */
export async function transitionRisk(id: string, event: RiskEvent, note?: string | null) {
  const auth = currentAuth();
  const risk = await prisma.itRisk.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!risk) throw ApiError.notFound('Risk');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: risk.ownerPartyId } });

  const from = risk.status as RiskState;
  if (!riskMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `ItRisk is ${from}; ${event} is not one of its transitions. From here it accepts: ${riskMachine.allowedEvents(from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  const to = riskMachine.apply(from, event);

  const updated = await prisma.itRisk.update({ where: { id }, data: { status: to } });

  await auditWrite({ action: 'update', subjectType: 'it_risk', subjectId: id, before: { status: from }, after: { status: to }, meta: { transition: event } });
  await emit({
    name: EVENTS.IT_RISK_TRANSITIONED,
    subject: { entityType: 'it_risk', entityId: id, recordCode: risk.recordCode },
    previousState: { status: from },
    newState: { status: to },
    reason: note ? { reasonCode: event, note } : null,
    owner: { partyId: risk.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

// ---------------------------------------------------------------------------
// Review-overdue ladder (jobs/it/governance.ts calls this)
// ---------------------------------------------------------------------------

export async function resolveOpsHeadPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

export interface RiskReviewLadderResult {
  checked: number;
  notified: number;
  skippedIdempotent: number;
}

export async function runRiskReviewLadder(now: Date = new Date()): Promise<RiskReviewLadderResult> {
  const auth = currentAuth();
  const rows = await prisma.itRisk.findMany({
    where: { tenantId: auth.tenantId, reviewDueAt: { not: null }, status: { in: ['open', 'treating'] } },
  });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const row of rows) {
    const daysToDue = Math.ceil((row.reviewDueAt!.getTime() - now.getTime()) / 86_400_000);
    const crossed = GOVERNANCE_LADDER_RUNGS.filter((r) => daysToDue <= r);
    const rung = crossed.length ? crossed[crossed.length - 1] : undefined;
    if (rung === undefined) continue;

    const already = row.reviewNotifiedRungs ?? [];
    if (already.includes(rung)) {
      skippedIdempotent += 1;
      continue;
    }

    const overdue = rung < 0;
    await raiseException({
      code: overdue ? 'IT_RSK_REVIEW_OVERDUE' : 'IT_RSK_REVIEW_DUE',
      label: overdue ? `${row.title} review overdue` : `${row.title} review due in ${rung} day${rung === 1 ? '' : 's'}`,
      severity: overdue ? 'S3_HIGH_RISK' : rung <= 7 ? 'S2_WARNING' : 'S1_ATTENTION',
      subjectType: 'it_risk',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: overdue
        ? `${row.title} (${row.recordCode}) review was due ${row.reviewDueAt!.toISOString().slice(0, 10)} and has not been reviewed.`
        : `${row.title} (${row.recordCode}) review is due ${row.reviewDueAt!.toISOString().slice(0, 10)}.`,
      ownerPartyId: row.ownerPartyId,
      slaDueAt: row.reviewDueAt,
      triggerFingerprint: 'it_risk_review_ladder',
      ladderRung: rung,
    });
    notified += 1;
    await prisma.itRisk.update({ where: { id: row.id }, data: { reviewNotifiedRungs: [...new Set([...already, ...crossed])] } });
  }

  return { checked: rows.length, notified, skippedIdempotent };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function risksSummary() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const total = await prisma.itRisk.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return { notYetMeasured: true, total: 0, byBand: { low: 0, medium: 0, high: 0, critical: 0 }, open: 0, reviewsOverdue: 0 };
  }

  const rows = await prisma.itRisk.findMany({ where: { tenantId: auth.tenantId } });
  const byBand: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let open = 0;
  let reviewsOverdue = 0;
  const now = new Date();
  for (const r of rows) {
    const band = r.bandResidual ?? r.bandInherent;
    byBand[band] = (byBand[band] ?? 0) + 1;
    if (r.status === 'open' || r.status === 'treating') open += 1;
    if (r.reviewDueAt && r.reviewDueAt < now && (r.status === 'open' || r.status === 'treating')) reviewsOverdue += 1;
  }

  return { notYetMeasured: false, total, byBand, open, reviewsOverdue };
}
