/**
 * Opportunity — the busiest node in the catalogue, and the one entity referenced
 * from every commercial cluster.
 *
 * Two state machines live here, deliberately decoupled: `stageKey` (where the
 * deal is) and `forecastCategory` (how confident we are). Moving a card to
 * negotiating does not set commit — a deal can sit in negotiating for weeks
 * without ever being confidently committable, and conflating the two axes is
 * exactly the kind of blended, meaningless number this rebuild eliminates
 * everywhere else.
 *
 * The won-transition is hard-blocked in the SERVICE layer unless contractId OR
 * mouId is populated — blocking at the point of action is a stronger guarantee
 * than an after-the-fact exception, and the block must live here or the gap
 * reopens through a bulk-import or API back door.
 */

import {
  EVENTS,
  FORECAST_TRANSITIONS,
  type ForecastCategory,
  type SeverityCode,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, scopeFor } from '../platform/permissions.js';
import { notify, raiseException } from '../platform/exceptions.js';
import { entryStage, loadPipelineWithStages, stageFor, validateTransition } from './pipelines.js';

export interface OpportunityInput {
  title: string;
  organizationId?: string | null;
  primaryContactPersonId?: string | null;
  vertical: string;
  offeringId?: string | null;
  expectedValue?: number | null;
  currency?: string;
  expectedCloseDate?: Date | null;
  ownerPartyId?: string | null;
  strategicValue?: string | null;
  pipelineId?: string;
  parentContractId?: string | null;
}

export async function createOpportunity(input: OpportunityInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'opportunities', verb: 'create' });

  const pipeline = input.pipelineId
    ? await prisma.pipelineDefinition.findFirstOrThrow({ where: { id: input.pipelineId } })
    : await (await import('./pipelines.js')).pipelineForVertical(input.vertical);

  const stage = await entryStage(pipeline.id);
  const recordCode = await nextRecordCode('OPP');

  const opportunity = await prisma.opportunity.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      organizationId: input.organizationId ?? null,
      primaryContactPersonId: input.primaryContactPersonId ?? null,
      vertical: input.vertical,
      offeringId: input.offeringId ?? null,
      pipelineId: pipeline.id,
      stageKey: stage.stageKey,
      stageEnteredAt: new Date(),
      expectedValue: input.expectedValue ?? undefined,
      currency: input.currency ?? 'INR',
      expectedCloseDate: input.expectedCloseDate ?? null,
      ownerPartyId: input.ownerPartyId ?? auth.partyId,
      strategicValue: input.strategicValue ?? null,
      parentContractId: input.parentContractId ?? null,
      forecastCategory: 'pipeline',
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'opportunity', subjectId: opportunity.id, after: { title: opportunity.title, recordCode } });

  await emit({
    name: input.parentContractId ? EVENTS.OPPORTUNITY_RENEWAL_OPENED : EVENTS.OPPORTUNITY_CREATED,
    subject: { entityType: 'opportunity', entityId: opportunity.id, recordCode },
    related: [
      ...(input.organizationId ? [{ relation: 'account', entityType: 'organization', entityId: input.organizationId }] : []),
      ...(input.parentContractId ? [{ relation: 'renews', entityType: 'contract', entityId: input.parentContractId }] : []),
    ],
    newState: { stageKey: stage.stageKey, pipelinePosition: stage.pipelinePosition, pipelineCode: pipeline.pipelineCode },
    owner: { partyId: opportunity.ownerPartyId },
  });

  return opportunity;
}

/**
 * Renewal and expansion never re-open the original opportunity: a PL-RENEWAL
 * opportunity is created fresh with parentContractId pointing at the contract
 * concerned, mirroring the MoU renewedFrom chain the codebase already trusts.
 */
export async function openRenewalOpportunity(contractId: string) {
  const auth = currentAuth();
  const contract = await prisma.contract.findFirst({ where: { id: contractId } });
  if (!contract) throw ApiError.notFound('Contract');

  const renewalPipeline = await prisma.pipelineDefinition.findFirst({
    where: { tenantId: auth.tenantId, commercialMotion: 'renewal_expansion', effectiveTo: null },
  });
  if (!renewalPipeline) throw ApiError.unprocessable('No renewal/expansion pipeline is configured for this tenant.');

  return createOpportunity({
    title: `Renewal — ${contract.title}`,
    organizationId: contract.organizationId,
    vertical: 'other',
    expectedValue: num(contract.commercialValue),
    currency: contract.currency,
    ownerPartyId: contract.ownerPartyId,
    strategicValue: contract.strategicValue,
    pipelineId: renewalPipeline.id,
    parentContractId: contractId,
  });
}

export interface StageChangeResult {
  opportunity: Awaited<ReturnType<typeof prisma.opportunity.findFirstOrThrow>>;
  wonGateSatisfied: boolean;
}

export async function advanceStage(
  opportunityId: string,
  toStageKey: string,
  opts: { reasonCode?: string; note?: string } = {},
): Promise<StageChangeResult> {
  const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId } });
  if (!opportunity) throw ApiError.notFound('Opportunity');

  await assertCan({ resource: 'opportunities', verb: 'edit', record: { ownerPartyId: opportunity.ownerPartyId } });

  const check = await validateTransition(opportunity.pipelineId, opportunity.stageKey, toStageKey, opportunity as never);
  if (!check.ok) throw ApiError.unprocessable(check.reason!, { missingRequiredFields: check.missingRequiredFields });

  const target = check.targetStage!;
  const fromStage = await stageFor(opportunity.pipelineId, opportunity.stageKey);

  // An opportunity cannot claim to be in the proposed stage with nothing
  // proposed. The gate is on the entity reference, not a document pointer.
  if (target.pipelinePosition === 50 && !opportunity.proposalId) {
    throw ApiError.unprocessable(
      'Cannot enter the offered/proposed stage while proposal_id is null. Create a proposal first.',
      { requiredField: 'proposalId' },
    );
  }

  // The won-gate. Service-layer, so a bulk import or direct API call cannot
  // reopen the gap through a back door.
  if (target.pipelinePosition === 90) {
    const satisfied = Boolean(opportunity.contractId || opportunity.mouId);
    if (!satisfied) {
      throw ApiError.unprocessable(
        'Cannot mark won while both contract_id and mou_id are null. A document reference proves nothing about whether anything was actually signed.',
        { requiredOneOf: ['contractId', 'mouId'] },
      );
    }
  }

  const updated = await prisma.opportunity.update({
    where: { id: opportunityId },
    data: {
      stageKey: toStageKey,
      stageEnteredAt: new Date(),
      stageAgeNotifiedAt: null,
      ...(target.pipelinePosition === 90 ? { outcome: 'won', closedAt: new Date(), forecastCategory: 'closed_won' } : {}),
      ...(target.pipelinePosition === 0 ? { outcome: 'lost', closedAt: new Date(), forecastCategory: 'closed_lost' } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'opportunity',
    subjectId: opportunityId,
    before: { stageKey: opportunity.stageKey },
    after: { stageKey: toStageKey },
  });

  await emit({
    name: EVENTS.OPPORTUNITY_STAGE_CHANGED,
    subject: { entityType: 'opportunity', entityId: opportunityId, recordCode: opportunity.recordCode },
    previousState: { stageKey: opportunity.stageKey, pipelinePosition: fromStage.pipelinePosition },
    newState: { stageKey: toStageKey, pipelinePosition: target.pipelinePosition },
    // A downstream consumer can distinguish a proposal-driven change from a
    // rep-initiated one.
    reason: opts.reasonCode ? { reasonCode: opts.reasonCode, note: opts.note ?? null } : null,
    owner: { partyId: opportunity.ownerPartyId },
    impact: {
      domains: ['crm'],
      materiality: opportunity.expectedValue
        ? { measure: 'expected_value', value: num(opportunity.expectedValue)!, currency: opportunity.currency }
        : null,
    },
  });

  if (target.pipelinePosition === 90) {
    await emit({
      name: EVENTS.OPPORTUNITY_WON,
      subject: { entityType: 'opportunity', entityId: opportunityId, recordCode: opportunity.recordCode },
      newState: { contractId: opportunity.contractId, mouId: opportunity.mouId },
      impact: {
        domains: ['crm', 'fin', 'prj'],
        materiality: opportunity.expectedValue
          ? { measure: 'expected_value', value: num(opportunity.expectedValue)!, currency: opportunity.currency }
          : null,
      },
      confidentiality: 'confidential',
    });
    await handoffOnWin(updated);
  }

  if (target.pipelinePosition === 0) {
    await emit({
      name: EVENTS.OPPORTUNITY_LOST,
      subject: { entityType: 'opportunity', entityId: opportunityId, recordCode: opportunity.recordCode },
      newState: { lostReason: opportunity.lostReason },
    });
    await (await import('./winLoss.js')).ensureWinLossReview('opportunity', opportunityId);
  }

  return { opportunity: updated, wonGateSatisfied: Boolean(updated.contractId || updated.mouId) };
}

/**
 * Won immediately triggers the handoff opening the PROJECT / ENROLLMENT record
 * where all further delivery tracking happens. Post-award state lives entirely
 * outside the sales pipeline.
 */
async function handoffOnWin(opportunity: { id: string; tenantId: string; title: string; organizationId: string | null; contractId: string | null; ownerPartyId: string | null; recordCode: string }) {
  const auth = currentAuth();
  const recordCode = await nextRecordCode('PRJ');

  const project = await prisma.project.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: opportunity.title,
      organizationId: opportunity.organizationId,
      opportunityId: opportunity.id,
      contractId: opportunity.contractId,
      status: 'planned',
      startDate: new Date(),
    },
  });

  await emit({
    name: EVENTS.OPPORTUNITY_HANDED_OFF,
    subject: { entityType: 'opportunity', entityId: opportunity.id, recordCode: opportunity.recordCode },
    related: [{ relation: 'delivered_by', entityType: 'project', entityId: project.id }],
    newState: { projectId: project.id },
    impact: { domains: ['crm', 'prj'] },
  });

  return project;
}

// ---------------------------------------------------------------------------
// Forecast category state machine (CRM-LEAD-006)
// ---------------------------------------------------------------------------

export interface ForecastChangeInput {
  opportunityId: string;
  to: ForecastCategory;
  reason?: string;
  /** Set by AU-CRM-010 so the demotion is attributable to the system, not a human. */
  systemActor?: string;
}

export async function changeForecastCategory(input: ForecastChangeInput) {
  const auth = currentAuth();
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: input.opportunityId },
    include: { pipeline: true },
  });
  if (!opportunity) throw ApiError.notFound('Opportunity');

  const from = opportunity.forecastCategory as ForecastCategory;

  // Closure is always stage-driven and category-derived, never the reverse.
  if (input.to === 'closed_won' || input.to === 'closed_lost') {
    throw ApiError.unprocessable(
      'forecast_category cannot be set to a closed value independently. Closure follows the stage reaching a terminal pipeline_position.',
    );
  }

  const allowed = FORECAST_TRANSITIONS[from] ?? [];
  if (!allowed.includes(input.to)) {
    throw ApiError.unprocessable(`No permitted forecast transition from '${from}' to '${input.to}'.`);
  }

  const stage = await stageFor(opportunity.pipelineId, opportunity.stageKey);
  const isPromotion = rank(input.to) > rank(from);

  if (isPromotion) {
    if (!input.systemActor) {
      await assertCan({ resource: 'opportunities', verb: 'edit', record: { ownerPartyId: opportunity.ownerPartyId } });
    }

    // A bare identified-stage deal cannot be best_case.
    if (input.to === 'best_case' && stage.pipelinePosition < 20) {
      throw ApiError.unprocessable(
        `An opportunity at pipeline_position ${stage.pipelinePosition} cannot be promoted to best_case — engaged (20) or later is required.`,
      );
    }

    if (input.to === 'commit') {
      // Promotion always re-validates staleness at the moment of promotion,
      // closing the obvious workaround of re-committing an unrevised date.
      if (!opportunity.expectedCloseDate) {
        throw ApiError.unprocessable('Commit requires an expected_close_date within the current forecast period.');
      }
      if (opportunity.expectedCloseDate < new Date()) {
        throw ApiError.unprocessable(
          'Commit is blocked: expected_close_date is in the past. Revise the date before re-promoting.',
          { staleCloseDate: opportunity.expectedCloseDate },
        );
      }

      // Commit without a qualified evidentiary basis is exactly the failure
      // mode this requirement exists to prevent.
      if (['PL-ENTERPRISE', 'PL-INSTITUTION'].includes(opportunity.pipeline.pipelineCode)) {
        const missing = stage.requiredFields.filter((f) => {
          const v = (opportunity as unknown as Record<string, unknown>)[f];
          return v === null || v === undefined || v === '';
        });
        if (missing.length) {
          throw ApiError.unprocessable(
            `Commit on a ${opportunity.pipeline.pipelineCode} opportunity requires the current stage's qualification fields: ${missing.join(', ')}.`,
            { missingRequiredFields: missing },
          );
        }
      }

      // A tenant may additionally require manager-level grant for commit above
      // a value threshold — configurable per pipeline, not a fixed rule.
      const threshold = opportunity.pipeline.commitApprovalThreshold;
      if (threshold && opportunity.expectedValue && num(opportunity.expectedValue)! > Number(threshold.toString())) {
        await assertCan({
          resource: 'opportunities',
          verb: 'approve',
          magnitude: { authorityClass: 'commit_approval', value: num(opportunity.expectedValue)! },
        });
      }
    }
  } else {
    // Demotion needs no gate: under-committing is never the risk. But a silent
    // demotion with no reason is what erodes trust in the number, so a reason
    // is always required.
    if (!input.reason) throw ApiError.badRequest('A demotion requires a reason.');
  }

  const updated = await prisma.opportunity.update({
    where: { id: input.opportunityId },
    data: {
      forecastCategory: input.to,
      forecastCategoryChangedAt: new Date(),
      forecastCategoryChangeReason: input.reason ?? null,
    },
  });

  await emit({
    name: EVENTS.OPPORTUNITY_FORECAST_CATEGORY_CHANGED,
    subject: { entityType: 'opportunity', entityId: input.opportunityId, recordCode: opportunity.recordCode },
    previousState: { forecastCategory: from },
    newState: { forecastCategory: input.to },
    reason: {
      reasonCode: input.systemActor ?? (isPromotion ? 'manual_promotion' : 'manual_demotion'),
      note: input.reason ?? null,
    },
    owner: { partyId: opportunity.ownerPartyId },
  });

  if (!isPromotion && opportunity.ownerPartyId) {
    await notify({
      recipientPartyId: opportunity.ownerPartyId,
      priority: 'N2_NORMAL',
      title: `Forecast demoted: ${opportunity.title}`,
      body: input.reason ?? 'Demoted.',
      subjectType: 'opportunity',
      subjectId: input.opportunityId,
      drillPath: `/crm/opportunities/${input.opportunityId}`,
    });
  }

  return updated;
}

function rank(c: ForecastCategory): number {
  return { pipeline: 0, best_case: 1, commit: 2, closed_won: 3, closed_lost: 3 }[c];
}

// ---------------------------------------------------------------------------
// Forecast roll-up — per pipeline by default, never a blended sum unless the
// viewer explicitly asks for one.
// ---------------------------------------------------------------------------

export interface PipelineRollup {
  pipelineId: string;
  pipelineCode: string;
  pipelineName: string;
  forecastMethod: string;
  currency: string;
  buckets: { category: string; count: number; rawValue: number; weightedValue: number }[];
  closedWon: number;
  closedLost: number;
  openCount: number;
}

export async function forecastRollup(opts: { blended?: boolean } = {}): Promise<{
  perPipeline: PipelineRollup[];
  blended: { rawValue: number; weightedValue: number } | null;
  note: string;
}> {
  const auth = currentAuth();
  const pipelines = await prisma.pipelineDefinition.findMany({
    where: { tenantId: auth.tenantId, effectiveTo: null },
    include: { stages: { where: { retiredAt: null } } },
  });

  const perPipeline: PipelineRollup[] = [];

  for (const pipeline of pipelines) {
    const opps = await prisma.opportunity.findMany({
      where: { tenantId: auth.tenantId, pipelineId: pipeline.id, deletedAt: null },
      select: { forecastCategory: true, expectedValue: true, stageKey: true, outcome: true, currency: true },
    });

    const probabilityByStage = new Map(pipeline.stages.map((s) => [s.stageKey, s.defaultProbability]));
    const buckets = ['pipeline', 'best_case', 'commit'].map((category) => {
      const rows = opps.filter((o) => o.forecastCategory === category);
      const rawValue = rows.reduce((sum, o) => sum + (num(o.expectedValue) ?? 0), 0);

      // Roll-up branches on default_forecast_method per opportunity — the
      // method field is not advisory metadata.
      let weightedValue = 0;
      if (pipeline.defaultForecastMethod === 'weighted_stage') {
        weightedValue = rows.reduce(
          (sum, o) => sum + (num(o.expectedValue) ?? 0) * ((probabilityByStage.get(o.stageKey) ?? 0) / 100),
          0,
        );
      } else if (pipeline.defaultForecastMethod === 'manual_commit') {
        // Only opportunities a human explicitly moved to commit count at all.
        weightedValue = category === 'commit' ? rawValue : 0;
      } else {
        // milestone_based: conversion-rate-by-volume, not per-deal probability.
        const conversionRate = 0.35;
        weightedValue = rawValue * conversionRate;
      }

      return {
        category,
        count: rows.length,
        rawValue: round2(rawValue),
        weightedValue: round2(weightedValue),
      };
    });

    perPipeline.push({
      pipelineId: pipeline.id,
      pipelineCode: pipeline.pipelineCode,
      pipelineName: pipeline.name,
      forecastMethod: pipeline.defaultForecastMethod,
      currency: opps[0]?.currency ?? 'INR',
      buckets,
      closedWon: round2(opps.filter((o) => o.outcome === 'won').reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0)),
      closedLost: round2(opps.filter((o) => o.outcome === 'lost').reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0)),
      openCount: opps.filter((o) => !o.outcome).length,
    });
  }

  return {
    perPipeline,
    // The platform never produces a blended sum as the default view.
    blended: opts.blended
      ? {
          rawValue: round2(perPipeline.reduce((s, p) => s + p.buckets.reduce((b, x) => b + x.rawValue, 0), 0)),
          weightedValue: round2(perPipeline.reduce((s, p) => s + p.buckets.reduce((b, x) => b + x.weightedValue, 0), 0)),
        }
      : null,
    note: opts.blended
      ? 'Blended total requested explicitly. Weighted values across motions with different forecast methods are not directly comparable.'
      : 'Per-pipeline totals shown side by side. Blending across incompatible motions is available only on explicit request.',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cross-pipeline coverage keyed on the canonical ordinal — a query that spans
 * every pipeline correctly in one pass.
 */
export async function coverageByPosition(minPosition = 30) {
  const auth = currentAuth();
  const stages = await prisma.pipelineStage.findMany({
    where: { tenantId: auth.tenantId, pipelinePosition: { gte: minPosition }, retiredAt: null },
    select: { pipelineId: true, stageKey: true, pipelinePosition: true },
  });

  const opps = await prisma.opportunity.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, outcome: null },
    select: { id: true, pipelineId: true, stageKey: true, expectedValue: true, title: true, recordCode: true },
  });

  const keySet = new Set(stages.map((s) => `${s.pipelineId}:${s.stageKey}`));
  const matched = opps.filter((o) => keySet.has(`${o.pipelineId}:${o.stageKey}`));

  return {
    minPosition,
    count: matched.length,
    value: round2(matched.reduce((s, o) => s + (num(o.expectedValue) ?? 0), 0)),
    opportunities: matched,
  };
}

/** Stage-age SLA breach, read per the record's actual pipeline, not one shared threshold. */
export async function detectStageAgeBreaches(): Promise<number> {
  const auth = currentAuth();
  const opps = await prisma.opportunity.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, outcome: null, stageAgeNotifiedAt: null },
    include: { pipeline: { include: { stages: { where: { retiredAt: null } } } } },
    take: 500,
  });

  let raised = 0;
  for (const opp of opps) {
    const stage = opp.pipeline.stages.find((s) => s.stageKey === opp.stageKey);
    if (!stage?.stageAgeBudgetDays) continue;

    const ageDays = Math.floor((Date.now() - opp.stageEnteredAt.getTime()) / 86_400_000);
    if (ageDays <= stage.stageAgeBudgetDays) continue;

    await raiseException({
      code: 'EX-CRM-009',
      label: 'Stage age budget breached',
      severity: 'S2_WARNING' as SeverityCode,
      subjectType: 'opportunity',
      subjectId: opp.id,
      subjectLabel: `${opp.recordCode} — ${opp.title}`,
      detail: `${ageDays} days at '${stage.label}' against a ${stage.stageAgeBudgetDays}-day budget on ${opp.pipeline.pipelineCode}.`,
      ownerPartyId: opp.ownerPartyId,
      triggerFingerprint: `stage_age:${stage.stageKey}:${stage.stageAgeBudgetDays}`,
      ladderRung: 1,
    });
    await prisma.opportunity.update({ where: { id: opp.id }, data: { stageAgeNotifiedAt: new Date() } });
    raised += 1;
  }
  return raised;
}

/**
 * AU-CRM-010: a commit opportunity whose expected_close_date passes without a
 * stage advance is automatically demoted to best_case. This is the ONE case
 * where the state machine moves without a human action, and it is a demotion,
 * never a promotion — consistent with the platform's bias toward conservative
 * forecasting.
 */
export async function demoteStaleCommits(): Promise<number> {
  const auth = currentAuth();
  const stale = await prisma.opportunity.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      outcome: null,
      forecastCategory: 'commit',
      expectedCloseDate: { lt: new Date() },
    },
    take: 200,
  });

  for (const opp of stale) {
    await changeForecastCategory({
      opportunityId: opp.id,
      to: 'best_case',
      reason: `Automatic demotion: expected_close_date ${opp.expectedCloseDate?.toISOString().slice(0, 10)} passed without a stage advance.`,
      systemActor: 'system:au-crm-010',
    });
  }
  return stale.length;
}

/** A chronically-recommitted deal that never closes is a forecasting-integrity signal. */
export async function detectChronicRecommits(periodDays = 90): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - periodDays * 86_400_000);
  const chronic = await prisma.opportunity.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      outcome: null,
      forecastCategory: 'commit',
      expectedCloseDate: { lt: cutoff },
    },
    take: 100,
  });

  for (const opp of chronic) {
    await raiseException({
      code: 'EX-CRM-016',
      label: 'Chronic recommit — commit past one full forecast period',
      severity: 'S2_WARNING',
      subjectType: 'opportunity',
      subjectId: opp.id,
      subjectLabel: `${opp.recordCode} — ${opp.title}`,
      detail: `Sitting in commit more than ${periodDays} days past its expected close date without closing.`,
      ownerPartyId: opp.ownerPartyId,
      triggerFingerprint: `chronic_recommit:${periodDays}`,
      ladderRung: 1,
    });
  }
  return chronic.length;
}

export async function listOpportunities(filters: {
  pipelineId?: string;
  stageKey?: string;
  forecastCategory?: string;
  ownerPartyId?: string;
  organizationId?: string;
  open?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}) {
  const auth = currentAuth();
  const scope = await scopeFor('opportunities', 'view');
  if (!scope) throw ApiError.forbidden('opportunities:view is not held.');

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);

  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
    ...(filters.stageKey ? { stageKey: filters.stageKey } : {}),
    ...(filters.forecastCategory ? { forecastCategory: filters.forecastCategory } : {}),
    ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
    ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
    ...(filters.open ? { outcome: null } : {}),
    ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.opportunity.findMany({
      where: where as never,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        organization: { select: { id: true, name: true } },
        offering: { select: { id: true, name: true } },
        pipeline: { select: { id: true, pipelineCode: true, name: true, defaultForecastMethod: true } },
      },
    }),
    prisma.opportunity.count({ where: where as never }),
  ]);

  return { items, total, page, pageSize };
}

export { loadPipelineWithStages };
