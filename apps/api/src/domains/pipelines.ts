/**
 * Pipeline as data (CRM-LEAD-001/002).
 *
 * The pipeline vocabulary is configuration, not code. A tenant administrator
 * can add a stage, retire a stage, change a stage's age budget, or gate a
 * transition behind an approval — entirely through data, with no deploy.
 *
 * A stage transition is a validated edge traversal in a directed graph the
 * platform enforces, never a value a caller can set.
 *
 * `pipelinePosition` is the mechanism that makes stages comparable across
 * pipelines by position rather than by name: "this deal and that deal are both
 * at qualified" holds even though one shows "Qualified" and the other shows
 * "Requirement Confirmed", because both carry position 30.
 */

import { EVENTS, isCanonicalPosition, PIPELINE_POSITIONS } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';

export interface StageInput {
  stageKey: string;
  label: string;
  sequence: number;
  defaultProbability: number;
  pipelinePosition: number;
  isOpen?: boolean;
  isTerminal?: boolean;
  postAward?: boolean;
  stageAgeBudgetDays?: number | null;
  requiredFields?: string[];
}

export interface PipelineInput {
  pipelineCode: string;
  name: string;
  commercialMotion: string;
  appliesToVerticals: string[];
  appliesToAccountKind?: string;
  defaultForecastMethod?: string;
  requiresAwardArtefact?: string;
  isDefault?: boolean;
  commitApprovalThreshold?: number | null;
}

export async function createPipeline(input: PipelineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'pipeline_definitions', verb: 'create' });

  const clash = await prisma.pipelineDefinition.findFirst({
    where: { tenantId: auth.tenantId, pipelineCode: input.pipelineCode, effectiveTo: null },
  });
  if (clash) {
    throw ApiError.conflict(
      `A pipeline with code ${input.pipelineCode} is already in force for this tenant.`,
      { existingId: clash.id },
    );
  }

  // Exactly one PIPELINE_DEFINITION per tenant may be is_default = true at any
  // effective date.
  if (input.isDefault) {
    await prisma.pipelineDefinition.updateMany({
      where: { tenantId: auth.tenantId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const pipeline = await prisma.pipelineDefinition.create({
    data: {
      tenantId: auth.tenantId,
      pipelineCode: input.pipelineCode,
      name: input.name,
      commercialMotion: input.commercialMotion,
      appliesToVerticals: input.appliesToVerticals,
      appliesToAccountKind: input.appliesToAccountKind ?? 'any',
      defaultForecastMethod: input.defaultForecastMethod ?? 'weighted_stage',
      requiresAwardArtefact: input.requiresAwardArtefact ?? 'none',
      isDefault: input.isDefault ?? false,
      commitApprovalThreshold: input.commitApprovalThreshold ?? undefined,
      createdById: auth.partyId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'pipeline_definition',
    subjectId: pipeline.id,
    after: { pipelineCode: pipeline.pipelineCode },
  });
  await emit({
    name: EVENTS.PIPELINE_DEFINITION_CREATED,
    subject: { entityType: 'pipeline_definition', entityId: pipeline.id, recordCode: pipeline.pipelineCode },
    newState: { commercialMotion: pipeline.commercialMotion },
  });

  return pipeline;
}

export async function addStage(pipelineId: string, input: StageInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'pipeline_stages', verb: 'create' });

  // The canonical ordinal stays closed. This is deliberately not a free-entry
  // field — the whole point of the ordinal is that it stays comparable.
  if (!isCanonicalPosition(input.pipelinePosition)) {
    throw ApiError.unprocessable(
      `pipeline_position must be one of the closed canonical set {${PIPELINE_POSITIONS.join(', ')}}; received ${input.pipelinePosition}.`,
    );
  }

  const stage = await prisma.pipelineStage.create({
    data: {
      tenantId: auth.tenantId,
      pipelineId,
      stageKey: input.stageKey,
      label: input.label,
      sequence: input.sequence,
      defaultProbability: input.defaultProbability,
      pipelinePosition: input.pipelinePosition,
      isOpen: input.isOpen ?? (input.pipelinePosition !== 0 && input.pipelinePosition !== 90),
      isTerminal: input.isTerminal ?? (input.pipelinePosition === 0 || input.pipelinePosition === 90),
      postAward: input.postAward ?? false,
      stageAgeBudgetDays: input.stageAgeBudgetDays ?? null,
      requiredFields: input.requiredFields ?? [],
    },
  });

  await emit({
    name: EVENTS.PIPELINE_STAGE_CREATED,
    subject: { entityType: 'pipeline_stage', entityId: stage.id, recordCode: stage.stageKey },
    related: [{ relation: 'belongs_to', entityType: 'pipeline_definition', entityId: pipelineId }],
    newState: { stageKey: stage.stageKey, pipelinePosition: stage.pipelinePosition },
  });

  return stage;
}

export async function addTransition(
  pipelineId: string,
  input: { fromStageKey: string | null; toStageKey: string; requiresApproval?: boolean; requiredPermission?: string; emitsEvent?: string },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'pipeline_transitions', verb: 'create' });

  return prisma.pipelineTransition.create({
    data: {
      tenantId: auth.tenantId,
      pipelineId,
      fromStageKey: input.fromStageKey,
      toStageKey: input.toStageKey,
      requiresApproval: input.requiresApproval ?? false,
      requiredPermission: input.requiredPermission ?? 'opportunities:edit',
      emitsEvent: input.emitsEvent ?? EVENTS.OPPORTUNITY_STAGE_CHANGED,
    },
  });
}

/**
 * A pipeline is not usable — not selectable when creating a new Lead — until it
 * has at least one entry stage at position 10 and terminal stages at 90 and 0.
 * A pipeline with no win state or no loss state is rejected as incomplete,
 * never silently accepted.
 */
export async function assertPipelineUsable(pipelineId: string): Promise<{ usable: boolean; reason: string | null }> {
  const stages = await prisma.pipelineStage.findMany({
    where: { pipelineId, retiredAt: null },
    select: { pipelinePosition: true },
  });
  const positions = new Set(stages.map((s) => s.pipelinePosition));

  if (!positions.has(10)) return { usable: false, reason: 'No entry stage at pipeline_position 10.' };
  if (!positions.has(90)) return { usable: false, reason: 'No terminal win stage at pipeline_position 90.' };
  if (!positions.has(0)) return { usable: false, reason: 'No terminal loss stage at pipeline_position 0.' };
  return { usable: true, reason: null };
}

/**
 * Reachability check: a transition graph containing a non-terminal cycle with
 * no path to a terminal position is rejected at save time. A backward move
 * (negotiating -> qualified on a re-scope) is legitimate and accepted; a cycle
 * with no exit is not.
 */
export async function assertGraphReachable(pipelineId: string): Promise<void> {
  const [stages, transitions] = await Promise.all([
    prisma.pipelineStage.findMany({ where: { pipelineId, retiredAt: null } }),
    prisma.pipelineTransition.findMany({ where: { pipelineId } }),
  ]);

  const terminals = new Set(stages.filter((s) => s.isTerminal).map((s) => s.stageKey));
  const adjacency = new Map<string, string[]>();
  for (const t of transitions) {
    if (!t.fromStageKey) continue;
    adjacency.set(t.fromStageKey, [...(adjacency.get(t.fromStageKey) ?? []), t.toStageKey]);
  }

  const unreachable: string[] = [];
  for (const stage of stages) {
    if (terminals.has(stage.stageKey)) continue;
    // Post-award stages are retained so historical rows still render a label.
    // Nothing transitions into them, so requiring a path out of them would
    // reject a graph that is in fact sound.
    if (stage.postAward) continue;
    const seen = new Set<string>();
    const stack = [stage.stageKey];
    let found = false;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (terminals.has(cur)) {
        found = true;
        break;
      }
      for (const next of adjacency.get(cur) ?? []) stack.push(next);
    }
    if (!found) unreachable.push(stage.stageKey);
  }

  if (unreachable.length) {
    throw ApiError.unprocessable(
      `Transition graph rejected: ${unreachable.join(', ')} cannot reach any terminal stage.`,
      { unreachable },
    );
  }
}

export interface TransitionCheck {
  ok: boolean;
  transition: Awaited<ReturnType<typeof prisma.pipelineTransition.findFirst>>;
  targetStage: Awaited<ReturnType<typeof prisma.pipelineStage.findFirst>>;
  reason: string | null;
  missingRequiredFields: string[];
}

/**
 * Validates a stage write at the SERVICE layer, not just in the client. A write
 * is rejected with a 422 unless a stage exists with that key under the record's
 * pipeline AND a transition exists from the record's current stage to it.
 */
export async function validateTransition(
  pipelineId: string,
  fromStageKey: string | null,
  toStageKey: string,
  record: Record<string, unknown>,
): Promise<TransitionCheck> {
  const targetStage = await prisma.pipelineStage.findFirst({
    where: { pipelineId, stageKey: toStageKey, retiredAt: null },
  });

  if (!targetStage) {
    return {
      ok: false,
      transition: null,
      targetStage: null,
      reason: `No stage '${toStageKey}' exists under this pipeline, effective now.`,
      missingRequiredFields: [],
    };
  }

  // No transition may target a post-award stage after cutover — the Kanban
  // stops offering them as drop targets entirely.
  if (targetStage.postAward) {
    return {
      ok: false,
      transition: null,
      targetStage,
      reason: `'${toStageKey}' is a retired post-award stage. Delivery state lives in PROJECT.status, enrollment state in ENROLLMENT.status, and renewal in a new PL-RENEWAL opportunity.`,
      missingRequiredFields: [],
    };
  }

  const transition = await prisma.pipelineTransition.findFirst({
    where: { pipelineId, fromStageKey, toStageKey },
  });

  if (!transition) {
    return {
      ok: false,
      transition: null,
      targetStage,
      reason: `No permitted transition from '${fromStageKey ?? '(creation)'}' to '${toStageKey}'.`,
      missingRequiredFields: [],
    };
  }

  // Fields that must be non-null before a transition INTO this stage is accepted.
  const missing = targetStage.requiredFields.filter((f) => {
    const value = resolvePath(record, f);
    return value === null || value === undefined || value === '';
  });

  if (missing.length) {
    return {
      ok: false,
      transition,
      targetStage,
      reason: `Required fields for '${targetStage.label}' are not populated: ${missing.join(', ')}.`,
      missingRequiredFields: missing,
    };
  }

  return { ok: true, transition, targetStage, reason: null, missingRequiredFields: [] };
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * Retirement is the only supported removal path. Attempting to delete a stage
 * with live records is blocked with an explicit count.
 */
export async function retireStage(stageId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'pipeline_stages', verb: 'edit' });

  const stage = await prisma.pipelineStage.findFirst({ where: { id: stageId } });
  if (!stage) throw ApiError.notFound('Pipeline stage');

  const [leads, opps] = await Promise.all([
    prisma.lead.count({ where: { tenantId: auth.tenantId, pipelineId: stage.pipelineId, stageKey: stage.stageKey, deletedAt: null } }),
    prisma.opportunity.count({ where: { tenantId: auth.tenantId, pipelineId: stage.pipelineId, stageKey: stage.stageKey, deletedAt: null } }),
  ]);

  const live = leads + opps;
  if (live > 0) {
    throw ApiError.conflict(
      `${live} open record${live === 1 ? '' : 's'} ${live === 1 ? 'is' : 'are'} in this stage — reassign or retire them first.`,
      { blockingCount: live, leads, opportunities: opps },
    );
  }

  const retired = await prisma.pipelineStage.update({ where: { id: stageId }, data: { retiredAt: new Date() } });
  await emit({
    name: EVENTS.PIPELINE_STAGE_RETIRED,
    subject: { entityType: 'pipeline_stage', entityId: stageId, recordCode: stage.stageKey },
    newState: { retiredAt: retired.retiredAt },
  });
  return retired;
}

/** Resolves the pipeline a vertical maps to, falling back to the default pipeline. */
export async function pipelineForVertical(vertical: string) {
  const auth = currentAuth();
  const match = await prisma.pipelineDefinition.findFirst({
    where: { tenantId: auth.tenantId, effectiveTo: null, appliesToVerticals: { has: vertical } },
    orderBy: { createdAt: 'asc' },
  });
  if (match) return match;

  const fallback = await prisma.pipelineDefinition.findFirst({
    where: { tenantId: auth.tenantId, isDefault: true, effectiveTo: null },
  });
  if (!fallback) {
    throw ApiError.unprocessable(
      `Vertical '${vertical}' maps to no pipeline and no default pipeline is configured for this tenant.`,
    );
  }
  return fallback;
}

export async function entryStage(pipelineId: string) {
  const stage = await prisma.pipelineStage.findFirst({
    where: { pipelineId, pipelinePosition: 10, retiredAt: null },
    orderBy: { sequence: 'asc' },
  });
  if (!stage) throw ApiError.unprocessable('Pipeline has no entry stage at pipeline_position 10.');
  return stage;
}

export async function loadPipelineWithStages(pipelineId: string) {
  const pipeline = await prisma.pipelineDefinition.findFirst({
    where: { id: pipelineId },
    include: {
      stages: { where: { retiredAt: null }, orderBy: { sequence: 'asc' } },
      transitions: true,
    },
  });
  if (!pipeline) throw ApiError.notFound('Pipeline');
  return pipeline;
}

export async function stageFor(pipelineId: string, stageKey: string) {
  const stage = await prisma.pipelineStage.findFirst({ where: { pipelineId, stageKey } });
  if (!stage) throw ApiError.notFound(`Stage '${stageKey}'`);
  return stage;
}
