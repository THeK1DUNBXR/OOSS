import { Router } from 'express';
import { z } from 'zod';
import { COMMERCIAL_MOTIONS, PIPELINE_POSITIONS, VERTICALS } from '@kaizen/shared';
import { handler } from '../lib/http.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import {
  addStage,
  addTransition,
  assertGraphReachable,
  assertPipelineUsable,
  createPipeline,
  retireStage,
} from '../domains/pipelines.js';

const router = Router();

router.get(
  '/',
  handler(async () => {
    await assertCan({ resource: 'pipeline_definitions', verb: 'view' });
    const auth = currentAuth();
    const pipelines = await prisma.pipelineDefinition.findMany({
      where: { tenantId: auth.tenantId, effectiveTo: null },
      include: {
        stages: { where: { retiredAt: null }, orderBy: { sequence: 'asc' } },
        transitions: true,
      },
      orderBy: { pipelineCode: 'asc' },
    });

    return Promise.all(
      pipelines.map(async (p) => {
        const usable = await assertPipelineUsable(p.id);
        const [leadCount, oppCount] = await Promise.all([
          prisma.lead.count({ where: { tenantId: auth.tenantId, pipelineId: p.id, deletedAt: null } }),
          prisma.opportunity.count({ where: { tenantId: auth.tenantId, pipelineId: p.id, deletedAt: null } }),
        ]);

        return {
          id: p.id,
          pipelineCode: p.pipelineCode,
          name: p.name,
          commercialMotion: p.commercialMotion,
          appliesToVerticals: p.appliesToVerticals,
          appliesToAccountKind: p.appliesToAccountKind,
          defaultForecastMethod: p.defaultForecastMethod,
          requiresAwardArtefact: p.requiresAwardArtefact,
          isDefault: p.isDefault,
          usable: usable.usable,
          usableReason: usable.reason,
          effectiveFrom: p.effectiveFrom.toISOString(),
          effectiveTo: p.effectiveTo?.toISOString() ?? null,
          leadCount,
          opportunityCount: oppCount,
          stages: p.stages.map((s) => ({
            id: s.id,
            stageKey: s.stageKey,
            label: s.label,
            sequence: s.sequence,
            defaultProbability: s.defaultProbability,
            pipelinePosition: s.pipelinePosition,
            isOpen: s.isOpen,
            isTerminal: s.isTerminal,
            postAward: s.postAward,
            stageAgeBudgetDays: s.stageAgeBudgetDays,
            requiredFields: s.requiredFields,
          })),
          transitions: p.transitions.map((t) => ({
            id: t.id,
            fromStageKey: t.fromStageKey,
            toStageKey: t.toStageKey,
            requiresApproval: t.requiresApproval,
            requiredPermission: t.requiredPermission,
            emitsEvent: t.emitsEvent,
          })),
        };
      }),
    );
  }),
);

router.post(
  '/',
  handler(async (req, res) => {
    const schema = z.object({
      pipelineCode: z.string().regex(/^PL-[A-Z0-9_]+$/, 'Pipeline codes follow the PL-<MOTION> convention.'),
      name: z.string().min(1),
      commercialMotion: z.enum(COMMERCIAL_MOTIONS),
      appliesToVerticals: z.array(z.enum(VERTICALS)),
      appliesToAccountKind: z.enum(['organization', 'institution', 'individual', 'any']).optional(),
      defaultForecastMethod: z.enum(['weighted_stage', 'manual_commit', 'milestone_based']).optional(),
      requiresAwardArtefact: z.enum(['contract', 'mou', 'enrollment', 'partner_agreement', 'none']).optional(),
      isDefault: z.boolean().optional(),
    });
    const pipeline = await createPipeline(schema.parse(req.body));
    res.status(201).json(pipeline);
    return undefined;
  }),
);

router.post(
  '/:id/stages',
  handler(async (req, res) => {
    const schema = z.object({
      stageKey: z.string().regex(/^[a-z0-9_]+$/),
      label: z.string().min(1),
      sequence: z.number().int(),
      defaultProbability: z.number().int().min(0).max(100),
      // Deliberately a closed set, not a free-entry field — the whole point of
      // the canonical ordinal is that it stays closed.
      pipelinePosition: z.number().refine((n) => (PIPELINE_POSITIONS as readonly number[]).includes(n), {
        message: `pipeline_position must be one of {${PIPELINE_POSITIONS.join(', ')}}`,
      }),
      stageAgeBudgetDays: z.number().int().nullish(),
      requiredFields: z.array(z.string()).optional(),
    });
    const stage = await addStage(req.params.id, schema.parse(req.body) as never);
    res.status(201).json(stage);
    return undefined;
  }),
);

router.patch(
  '/stages/:stageId',
  handler(async (req) => {
    await assertCan({ resource: 'pipeline_stages', verb: 'edit' });
    const schema = z.object({
      label: z.string().optional(),
      stageAgeBudgetDays: z.number().int().nullish(),
      defaultProbability: z.number().int().min(0).max(100).optional(),
      requiredFields: z.array(z.string()).optional(),
    });
    const input = schema.parse(req.body);

    // Renaming a stage_key with live records is disallowed: the platform
    // requires a new key plus a transition migrating existing rows, so
    // historical stage_changed events stay interpretable.
    if ('stageKey' in (req.body ?? {})) {
      throw ApiError.unprocessable(
        'stage_key is immutable once referenced by a live record. Create a new stage and retire the old one instead.',
      );
    }

    return prisma.pipelineStage.update({ where: { id: req.params.stageId }, data: input as never });
  }),
);

router.delete('/stages/:stageId', handler(async (req) => retireStage(req.params.stageId)));

router.post(
  '/:id/transitions',
  handler(async (req, res) => {
    const schema = z.object({
      fromStageKey: z.string().nullable(),
      toStageKey: z.string(),
      requiresApproval: z.boolean().optional(),
      requiredPermission: z.string().optional(),
      emitsEvent: z.string().optional(),
    });
    const transition = await addTransition(req.params.id, schema.parse(req.body));
    // Reachability is checked at save time, so a cycle with no path to a
    // terminal stage never lands.
    await assertGraphReachable(req.params.id);
    res.status(201).json(transition);
    return undefined;
  }),
);

router.delete(
  '/transitions/:transitionId',
  handler(async (req) => {
    await assertCan({ resource: 'pipeline_transitions', verb: 'delete' });
    await prisma.pipelineTransition.delete({ where: { id: req.params.transitionId } });
    return { ok: true };
  }),
);

/** The Kanban read path, scoped to one pipeline. */
router.get(
  '/:id/board',
  handler(async (req) => {
    await assertCan({ resource: 'opportunities', verb: 'view' });
    const auth = currentAuth();

    const pipeline = await prisma.pipelineDefinition.findFirst({
      where: { id: req.params.id },
      include: { stages: { where: { retiredAt: null, postAward: false }, orderBy: { sequence: 'asc' } }, transitions: true },
    });
    if (!pipeline) throw ApiError.notFound('Pipeline');

    const [opportunities, leads] = await Promise.all([
      prisma.opportunity.findMany({
        where: { tenantId: auth.tenantId, pipelineId: pipeline.id, deletedAt: null, outcome: null },
        include: { organization: { select: { name: true } }, offering: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 300,
      }),
      prisma.lead.findMany({
        where: { tenantId: auth.tenantId, pipelineId: pipeline.id, deletedAt: null, leadStatus: 'open' },
        include: { organization: { select: { name: true } }, person: { select: { fullName: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 300,
      }),
    ]);

    return {
      pipeline: {
        id: pipeline.id,
        pipelineCode: pipeline.pipelineCode,
        name: pipeline.name,
        commercialMotion: pipeline.commercialMotion,
        defaultForecastMethod: pipeline.defaultForecastMethod,
      },
      // Columns render from PIPELINE_STAGE.sequence/label — one component, no
      // vertical-specific code branch, no hard-coded labels per role.
      columns: pipeline.stages.map((s) => {
        const stageOpps = opportunities.filter((o) => o.stageKey === s.stageKey);
        const stageLeads = leads.filter((l) => l.stageKey === s.stageKey);
        return {
          stageKey: s.stageKey,
          label: s.label,
          pipelinePosition: s.pipelinePosition,
          defaultProbability: s.defaultProbability,
          stageAgeBudgetDays: s.stageAgeBudgetDays,
          requiredFields: s.requiredFields,
          isTerminal: s.isTerminal,
          opportunities: stageOpps.map((o) => ({
            id: o.id,
            recordCode: o.recordCode,
            title: o.title,
            organizationName: o.organization?.name ?? null,
            offeringName: o.offering?.name ?? null,
            expectedValue: o.expectedValue ? Number(o.expectedValue.toString()) : null,
            currency: o.currency,
            // Two different axes, shown simultaneously and never conflated.
            forecastCategory: o.forecastCategory,
            ownerPartyId: o.ownerPartyId,
            stageAgeDays: Math.floor((Date.now() - o.stageEnteredAt.getTime()) / 86_400_000),
            stageAgeBreached: Boolean(s.stageAgeBudgetDays && Math.floor((Date.now() - o.stageEnteredAt.getTime()) / 86_400_000) > s.stageAgeBudgetDays),
            wonGateSatisfied: Boolean(o.contractId || o.mouId),
          })),
          leads: stageLeads.map((l) => ({
            id: l.id,
            recordCode: l.recordCode,
            title: l.title,
            personName: l.person?.fullName ?? null,
            organizationName: l.organization?.name ?? null,
            score: l.score,
            ownerPartyId: l.ownerPartyId,
            unrouted: l.ownerPartyId === null,
            stageAgeDays: Math.floor((Date.now() - l.stageEnteredAt.getTime()) / 86_400_000),
            stageAgeBreached: Boolean(s.stageAgeBudgetDays && Math.floor((Date.now() - l.stageEnteredAt.getTime()) / 86_400_000) > s.stageAgeBudgetDays),
          })),
        };
      }),
      transitions: pipeline.transitions,
    };
  }),
);

// ---------------------------------------------------------------------------
// Territories & routing rules
// ---------------------------------------------------------------------------

router.get(
  '/territories/all',
  handler(async () => {
    await assertCan({ resource: 'territories', verb: 'view' });
    const auth = currentAuth();
    return prisma.territory.findMany({ where: { tenantId: auth.tenantId }, orderBy: { name: 'asc' } });
  }),
);

router.post(
  '/territories/all',
  handler(async (req, res) => {
    await assertCan({ resource: 'territories', verb: 'create' });
    const auth = currentAuth();
    const schema = z.object({
      name: z.string().min(1),
      geoAreaRef: z.array(z.string()).optional(),
      appliesToVerticals: z.array(z.string()).optional(),
      appliesToAccountKind: z.string().optional(),
      ownerPositionId: z.string().nullish(),
      ownerPartyId: z.string().nullish(),
      capacityCeiling: z.number().int().optional(),
    });
    const input = schema.parse(req.body);
    const { nextRecordCode } = await import('../platform/recordCode.js');
    const territory = await prisma.territory.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('TER'),
        name: input.name,
        geoAreaRef: input.geoAreaRef ?? [],
        appliesToVerticals: input.appliesToVerticals ?? [],
        appliesToAccountKind: input.appliesToAccountKind ?? 'any',
        ownerPositionId: input.ownerPositionId ?? null,
        ownerPartyId: input.ownerPartyId ?? null,
        capacityCeiling: input.capacityCeiling ?? 50,
      },
    });
    res.status(201).json(territory);
    return undefined;
  }),
);

router.get(
  '/routing-rules/all',
  handler(async () => {
    await assertCan({ resource: 'routing_rules', verb: 'view' });
    const auth = currentAuth();
    return prisma.routingRule.findMany({ where: { tenantId: auth.tenantId }, orderBy: { priority: 'asc' } });
  }),
);

router.patch(
  '/routing-rules/:id',
  handler(async (req) => {
    await assertCan({ resource: 'routing_rules', verb: 'edit' });
    const schema = z.object({
      factorWeights: z.record(z.number()).optional(),
      tieBreakMarginPoints: z.number().int().optional(),
      active: z.boolean().optional(),
    });
    return prisma.routingRule.update({ where: { id: req.params.id }, data: schema.parse(req.body) as never });
  }),
);

export default router;
