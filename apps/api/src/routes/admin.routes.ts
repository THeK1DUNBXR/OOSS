import { Router } from 'express';
import { z } from 'zod';
import {
  AI_TOUCHPOINTS,
  AI_TIERS,
  AXES,
  BOUNDED_CONTEXTS,
  HARD_PROHIBITIONS,
  LEGACY_EVENT_CROSSWALK,
  MODULE_REGISTER,
  PLANES,
  RESOURCES,
  ROLE_SLUGS,
  formatGrant,
} from '@kaizen/shared';
import { handler, str, bool, numeric } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, invalidateGrantCache } from '../platform/permissions.js';
import { verifyChain } from '../platform/eventBus.js';
import { governedEntities } from '../platform/audit.js';
import { agentRoster, decideAgentAction, pauseAgent, revokeAuthority, propose } from '../agents/index.js';
import { ALL_JOBS, runJobsForTenant } from '../jobs/scheduler.js';

const router = Router();

// ---------------------------------------------------------------------------
// Platform reference — the architecture, served as data
// ---------------------------------------------------------------------------

router.get(
  '/platform',
  handler(async () => ({
    planes: Object.values(PLANES),
    boundedContexts: BOUNDED_CONTEXTS,
    moduleRegister: MODULE_REGISTER,
    axes: AXES,
    resources: RESOURCES,
    roles: ROLE_SLUGS,
    eventCrosswalk: Object.entries(LEGACY_EVENT_CROSSWALK).map(([legacy, canonical]) => ({ legacy, canonical })),
    governedEntities: governedEntities(),
    aiTiers: AI_TIERS,
    aiTouchpoints: AI_TOUCHPOINTS,
    hardProhibitions: HARD_PROHIBITIONS,
  })),
);

// ---------------------------------------------------------------------------
// Governance: roles, grants, policies
// ---------------------------------------------------------------------------

router.get(
  '/roles',
  handler(async () => {
    await assertCan({ resource: 'grants', verb: 'view' });
    const auth = currentAuth();
    const roles = await prisma.accessRole.findMany({
      where: { tenantId: auth.tenantId },
      include: { grants: { include: { policyVersion: { select: { version: true } } } } },
      orderBy: { slug: 'asc' },
    });

    return Promise.all(
      roles.map(async (r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        archetype: r.archetype,
        classificationCeiling: r.classificationCeiling,
        holders: await prisma.affiliation.count({ where: { tenantId: auth.tenantId, roleSlug: r.slug, status: 'active' } }),
        grants: r.grants.map((g) => ({
          id: g.id,
          resource: g.resource,
          verbs: g.verbs,
          scope: g.scope,
          scopeResolver: g.scopeResolver,
          policyVersion: g.policyVersion?.version ?? null,
          display: formatGrant({ resource: g.resource, verbs: g.verbs as never, scope: g.scope as never }),
        })),
      })),
    );
  }),
);

/** The role x resource matrix, rendered from durable grant data. */
router.get(
  '/grant-matrix',
  handler(async () => {
    await assertCan({ resource: 'grants', verb: 'view' });
    const auth = currentAuth();

    const [roles, grants] = await Promise.all([
      prisma.accessRole.findMany({ where: { tenantId: auth.tenantId }, orderBy: { slug: 'asc' } }),
      prisma.grant.findMany({ where: { tenantId: auth.tenantId } }),
    ]);

    const byRole = new Map(roles.map((r) => [r.id, r.slug]));
    const matrix: Record<string, Record<string, string>> = {};

    for (const resource of RESOURCES) matrix[resource] = {};
    for (const g of grants) {
      const slug = g.roleId ? byRole.get(g.roleId) : null;
      if (!slug) continue;
      matrix[g.resource] = matrix[g.resource] ?? {};
      matrix[g.resource][slug] = formatGrant({ resource: g.resource, verbs: g.verbs as never, scope: g.scope as never })
        .split(':')[1];
    }

    return { roles: roles.map((r) => r.slug), resources: RESOURCES, matrix };
  }),
);

router.post(
  '/grants',
  handler(async (req, res) => {
    await assertCan({ resource: 'grants', verb: 'create' });
    const auth = currentAuth();
    const schema = z.object({
      roleSlug: z.string(),
      resource: z.enum(RESOURCES),
      verbs: z.array(z.string()).min(1),
      scope: z.enum(['own', 'own_or_unowned', 'all']),
      scopeResolver: z.string().nullish(),
    });
    const input = schema.parse(req.body);

    const role = await prisma.accessRole.findFirst({ where: { tenantId: auth.tenantId, slug: input.roleSlug } });
    if (!role) throw ApiError.notFound('Role');

    const policyVersion = await prisma.policyVersion.findFirst({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const grant = await prisma.grant.upsert({
      where: { id: (await prisma.grant.findFirst({ where: { tenantId: auth.tenantId, roleId: role.id, resource: input.resource } }))?.id ?? '__none__' },
      create: {
        tenantId: auth.tenantId,
        roleId: role.id,
        resource: input.resource,
        verbs: input.verbs,
        scope: input.scope,
        scopeResolver: input.scopeResolver ?? null,
        policyVersionId: policyVersion?.id,
      },
      update: { verbs: input.verbs, scope: input.scope, scopeResolver: input.scopeResolver ?? null },
    });

    // Evaluated at query time, so the change is live on the very next request.
    invalidateGrantCache();
    res.status(201).json(grant);
    return undefined;
  }),
);

router.get(
  '/policies',
  handler(async () => {
    await assertCan({ resource: 'policies', verb: 'view' });
    const auth = currentAuth();
    return prisma.policy.findMany({
      where: { tenantId: auth.tenantId },
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { policyCode: 'asc' },
    });
  }),
);

router.get(
  '/authority-grants',
  handler(async () => {
    await assertCan({ resource: 'grants', verb: 'view' });
    const auth = currentAuth();
    const rows = await prisma.authorityGrant.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ authorityClass: 'asc' }, { ceilingValue: 'desc' }],
    });
    return rows.map((g) => ({ ...g, ceilingValue: num(g.ceilingValue) }));
  }),
);

router.post(
  '/authority-grants/:id/revoke',
  handler(async (req) => {
    await assertCan({ resource: 'grants', verb: 'edit' });
    const schema = z.object({ reason: z.string().min(1), confirmSecondPerson: z.boolean() });
    const input = schema.parse(req.body);
    // Revocation is second-person confirmed: it hits every automation AND agent
    // relying on the grant, so the confirmation names each one going dark.
    if (!input.confirmSecondPerson) {
      throw ApiError.unprocessable(
        'Revoking an authority grant requires second-person confirmation, because it affects every automation and agent relying on it.',
      );
    }
    return revokeAuthority(req.params.id, input.reason);
  }),
);

// ---------------------------------------------------------------------------
// Event fabric
// ---------------------------------------------------------------------------

router.get(
  '/events',
  handler(async (req) => {
    await assertCan({ resource: 'events', verb: 'view' });
    const auth = currentAuth();

    const rows = await prisma.eventRecord.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(bool(req.query.includeLegacy) ? {} : { legacyName: null }),
        ...(str(req.query.eventName) ? { eventName: str(req.query.eventName) } : {}),
        ...(str(req.query.subject) ? { subjectEntityId: str(req.query.subject) } : {}),
        ...(str(req.query.correlationId) ? { correlationId: str(req.query.correlationId) } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: numeric(req.query.limit) ?? 100,
    });

    // Verify each link against its predecessor so a tampered record is visible.
    let expectedPrev: string | null = null;
    const ordered = [...rows].reverse();
    const validity = new Map<string, boolean>();
    for (const e of ordered) {
      validity.set(e.id, expectedPrev === null || e.prevHash === expectedPrev);
      expectedPrev = e.hash;
    }

    return rows.map((e) => ({
      id: e.id,
      eventId: e.eventId,
      eventName: e.eventName,
      eventVersion: e.eventVersion,
      occurredAt: e.occurredAt.toISOString(),
      recordedAt: e.recordedAt.toISOString(),
      actorType: e.actorType,
      actorLabel: e.actorAccessRole ?? e.actorAgentId ?? e.actorType,
      subjectType: e.subjectEntityType,
      subjectId: e.subjectEntityId,
      recordCode: e.subjectRecordCode,
      correlationId: e.correlationId,
      causationId: e.causationId,
      confidentiality: e.confidentiality,
      severity: e.impactSeverity,
      domains: e.impactDomains,
      prevHash: e.prevHash,
      hash: e.hash,
      chainValid: validity.get(e.id) ?? true,
      previousState: e.previousState,
      newState: e.newState,
      reason: e.reason,
      related: e.related,
    }));
  }),
);

/** Chain-continuity is alerted on per tenant, not merely logged. */
router.get(
  '/events/verify-chain',
  handler(async () => {
    await assertCan({ resource: 'events', verb: 'view' });
    return verifyChain(currentAuth().tenantId);
  }),
);

router.get(
  '/events/dead-letters',
  handler(async () => {
    await assertCan({ resource: 'events', verb: 'view' });
    const auth = currentAuth();
    return prisma.eventDeadLetter.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }),
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

router.get(
  '/audit',
  handler(async (req) => {
    await assertCan({ resource: 'audit', verb: 'view' });
    const auth = currentAuth();
    const rows = await prisma.auditRecord.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.action) ? { action: str(req.query.action) } : {}),
        ...(str(req.query.subjectType) ? { subjectType: str(req.query.subjectType) } : {}),
        ...(str(req.query.subjectId) ? { subjectId: str(req.query.subjectId) } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: numeric(req.query.limit) ?? 150,
    });

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      actorLabel: r.actorLabel ?? r.actorType,
      actorType: r.actorType,
      timestamp: r.timestamp.toISOString(),
      diff: r.diff,
      // Names only, never values.
      fieldsRead: r.fieldsRead,
      meta: r.meta,
    }));
  }),
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

router.get(
  '/jobs',
  handler(async () => {
    await assertCan({ resource: 'jobs', verb: 'view' });
    const auth = currentAuth();

    const [definitions, runs] = await Promise.all([
      prisma.automationDefinition.findMany({ where: { tenantId: auth.tenantId }, orderBy: { jobName: 'asc' } }),
      prisma.jobRun.findMany({ where: { tenantId: auth.tenantId }, orderBy: { startedAt: 'desc' }, take: 100 }),
    ]);

    return {
      registered: ALL_JOBS.map((j) => ({ name: j.name, label: j.label, automationClass: j.automationClass, cron: j.cron })),
      definitions,
      runs: runs.map((r) => ({
        id: r.id,
        jobName: r.jobName,
        label: definitions.find((d) => d.jobName === r.jobName)?.label ?? r.jobName,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        status: r.status,
        processed: r.processed,
        notified: r.notified,
        skippedIdempotent: r.skippedIdempotent,
        errors: r.errors,
        dryRun: r.dryRun,
        automationVersionId: r.automationVersionId,
      })),
    };
  }),
);

router.post(
  '/jobs/run',
  handler(async (req) => {
    await assertCan({ resource: 'jobs', verb: 'edit' });
    const auth = currentAuth();
    const schema = z.object({ jobNames: z.array(z.string()).optional(), dryRun: z.boolean().optional() });
    const input = schema.parse(req.body ?? {});
    // Manual and scheduled execution share the same substrate and the same
    // idempotency-key store, so they can never diverge.
    return runJobsForTenant(auth.tenantId, input);
  }),
);

router.get(
  '/jobs/firing-log',
  handler(async (req) => {
    await assertCan({ resource: 'jobs', verb: 'view' });
    const auth = currentAuth();
    return prisma.jobFiringLog.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { firedAt: 'desc' },
      take: numeric(req.query.limit) ?? 100,
    });
  }),
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

router.get(
  '/agents',
  handler(async () => {
    await assertCan({ resource: 'agents', verb: 'view' });
    return agentRoster();
  }),
);

router.get(
  '/agents/actions',
  handler(async (req) => {
    await assertCan({ resource: 'agents', verb: 'view' });
    const auth = currentAuth();
    const rows = await prisma.agentAction.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.state) ? { state: str(req.query.state) } : {}),
        ...(str(req.query.agentId) ? { agentId: str(req.query.agentId) } : {}),
      },
      include: { agent: { select: { name: true } } },
      orderBy: { proposedAt: 'desc' },
      take: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      agentName: a.agent.name,
      tier: a.tier,
      tool: a.tool,
      action: a.action,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      proposal: a.proposal,
      proposedAt: a.proposedAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      state: a.state,
      rationale: a.rationale,
      humanActorName: null,
      onBehalfOfPartyId: a.onBehalfOfPartyId,
      blockedReason: a.blockedReason,
    }));
  }),
);

router.post(
  '/agents/actions/:id/decide',
  handler(async (req) => {
    const schema = z.object({ accept: z.boolean(), note: z.string().optional() });
    const input = schema.parse(req.body);
    return decideAgentAction(req.params.id, input.accept, input.note);
  }),
);

router.post(
  '/agents/:id/pause',
  handler(async (req) => {
    await assertCan({ resource: 'agents', verb: 'edit' });
    const schema = z.object({ paused: z.boolean() });
    return pauseAgent(req.params.id, schema.parse(req.body).paused);
  }),
);

/** Exercise a declared tool. Demonstrates the tier gate end to end. */
router.post(
  '/agents/:agentKey/propose',
  handler(async (req) => {
    await assertCan({ resource: 'agents', verb: 'edit' });
    const schema = z.object({
      tool: z.string(),
      action: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
      proposal: z.record(z.unknown()).optional(),
      rationale: z.string().min(1),
      magnitude: z.object({ authorityClass: z.string(), value: z.number() }).nullish(),
    });
    const input = schema.parse(req.body);
    return propose({
      agentKey: req.params.agentKey,
      tool: input.tool,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      proposal: input.proposal ?? {},
      rationale: input.rationale,
      magnitude: input.magnitude ?? null,
      onBehalfOfPartyId: currentAuth().partyId,
    });
  }),
);

// ---------------------------------------------------------------------------
// Thresholds — every unvalidated constant ships as a tunable row
// ---------------------------------------------------------------------------

router.get(
  '/thresholds',
  handler(async () => {
    const auth = currentAuth();
    return prisma.threshold.findMany({ where: { tenantId: auth.tenantId }, orderBy: { thresholdKey: 'asc' } });
  }),
);

router.patch(
  '/thresholds/:key',
  handler(async (req) => {
    await assertCan({ resource: 'policies', verb: 'edit' });
    const auth = currentAuth();
    const schema = z.object({ value: z.number() });
    return prisma.threshold.update({
      where: { tenantId_thresholdKey: { tenantId: auth.tenantId, thresholdKey: req.params.key } },
      data: { value: schema.parse(req.body).value },
    });
  }),
);

router.get(
  '/sensitivity-registrations',
  handler(async () => {
    const auth = currentAuth();
    return prisma.sensitivityRegistration.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ contextCode: 'asc' }, { entityType: 'asc' }],
    });
  }),
);

export default router;
