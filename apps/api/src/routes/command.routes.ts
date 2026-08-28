import { Router } from 'express';
import { z } from 'zod';
import { HEALTH_DOMAINS, type SeverityCode } from '@kaizen/shared';
import { handler, str, bool, numeric } from '../lib/http.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { acknowledgeException, resolveException } from '../platform/exceptions.js';
import {
  attentionQueue,
  commandCenter,
  liveAndHandled,
  peopleAndCapability,
  touchWatermark,
  whatChanged,
} from '../domains/commandCenter.js';
import { latestPulse, computeAndPersistAll, computeDomainHealth } from '../domains/health.js';
import { decisionQueue, disposeDecision, raiseDecision, reviewDecision, decisionCalibration } from '../domains/decisions.js';
import { forecastRollup } from '../domains/opportunities.js';

const router = Router();

/** The whole surface in one round trip. */
router.get(
  '/',
  handler(async () => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    return commandCenter();
  }),
);

router.get(
  '/pulse',
  handler(async () => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    return latestPulse();
  }),
);

/**
 * Hop 1 of the three-hop drill: the domain decomposes into its weighted
 * factors, every one shown alongside the others rather than hidden behind an
 * aggregate.
 */
router.get(
  '/health/:domainCode',
  handler(async (req) => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    const auth = currentAuth();
    const domain = HEALTH_DOMAINS.find((d) => d.code === req.params.domainCode);
    if (!domain) throw ApiError.notFound('Health domain');

    const [history, live] = await Promise.all([
      prisma.healthScore.findMany({
        where: { tenantId: auth.tenantId, domainCode: domain.code },
        orderBy: { asOf: 'desc' },
        take: 30,
      }),
      computeDomainHealth(domain.code),
    ]);

    return {
      domain,
      live,
      history: history.map((h) => ({
        asOf: h.asOf.toISOString(),
        score: h.score,
        band: h.band,
        state: h.state,
        factors: h.factors,
      })),
    };
  }),
);

router.post(
  '/health/recompute',
  handler(async () => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    return computeAndPersistAll();
  }),
);

router.get(
  '/what-changed',
  handler(async () => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    return whatChanged();
  }),
);

/** Advancing the watermark is a deliberate act, so the delta stays meaningful. */
router.post('/what-changed/seen', handler(async () => touchWatermark()));

router.get(
  '/attention',
  handler(async (req) => {
    await assertCan({ resource: 'exceptions', verb: 'view' });
    return attentionQueue((str(req.query.minSeverity) as SeverityCode) ?? 'S3_HIGH_RISK');
  }),
);

router.get(
  '/live-and-handled',
  handler(async (req) => {
    await assertCan({ resource: 'jobs', verb: 'view' });
    return liveAndHandled(numeric(req.query.windowHours) ?? 24);
  }),
);

router.get(
  '/people-capability',
  handler(async () => {
    await assertCan({ resource: 'health_scores', verb: 'view' });
    // Unit-level only. The k>=5 floor is enforced in the data contract, so it
    // applies regardless of who is asking — including the Chairman.
    return peopleAndCapability();
  }),
);

router.get('/forecast', handler(async (req) => forecastRollup({ blended: bool(req.query.blended) ?? false })));

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

router.get(
  '/decisions',
  handler(async () => {
    await assertCan({ resource: 'decisions', verb: 'view' });
    return decisionQueue();
  }),
);

router.post(
  '/decisions',
  handler(async (req, res) => {
    await assertCan({ resource: 'decisions', verb: 'create' });
    const schema = z.object({
      question: z.string().min(1),
      subjectType: z.string(),
      subjectId: z.string(),
      subjectLabel: z.string().optional(),
      authorityBasis: z.string(),
      requiredAuthorityValue: z.number().nullish(),
      routedToRole: z.string().optional(),
      pointOfNoReturn: z.string().nullish(),
      rejectedOptions: z
        .array(z.object({ option: z.string(), outcome: z.string(), risk: z.string(), cost: z.string() }))
        .optional(),
      noActionConsequence: z.object({ statement: z.string(), by: z.string() }).optional(),
    });
    const input = schema.parse(req.body);
    const decision = await raiseDecision({
      ...input,
      pointOfNoReturn: input.pointOfNoReturn ? new Date(input.pointOfNoReturn) : null,
    });
    res.status(201).json(decision);
    return undefined;
  }),
);

/** The four dispositions. All are exclusively human acts. */
router.post(
  '/decisions/:id/dispose',
  handler(async (req) => {
    const schema = z.object({
      disposition: z.enum(['decide', 'delegate', 'defer', 'request_evidence']),
      rationale: z.string().min(1),
      chosenOption: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      delegateToPartyId: z.string().optional(),
      returnDueOn: z.string().optional(),
      deferUntil: z.string().optional(),
      rationaleAudioRef: z.string().optional(),
    });
    const input = schema.parse(req.body);
    return disposeDecision({
      decisionId: req.params.id,
      disposition: input.disposition,
      rationale: input.rationale,
      chosenOption: input.chosenOption,
      confidence: input.confidence,
      delegateToPartyId: input.delegateToPartyId,
      returnDueOn: input.returnDueOn ? new Date(input.returnDueOn) : undefined,
      deferUntil: input.deferUntil ? new Date(input.deferUntil) : undefined,
      rationaleAudioRef: input.rationaleAudioRef,
    });
  }),
);

router.post(
  '/decisions/:id/review',
  handler(async (req) => {
    const schema = z.object({
      outcomeAssessment: z.string().min(1),
      varianceBand: z.string().min(1),
      lesson: z.string().min(1),
      changeCommitment: z.string().min(1),
    });
    return reviewDecision(req.params.id, schema.parse(req.body));
  }),
);

router.get('/decisions/calibration', handler(async () => decisionCalibration()));

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

router.get(
  '/exceptions',
  handler(async (req) => {
    await assertCan({ resource: 'exceptions', verb: 'view' });
    const auth = currentAuth();

    const rows = await prisma.exceptionRecord.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(str(req.query.state) ? { state: str(req.query.state) } : { state: { in: ['open', 'acknowledged', 'escalated'] } }),
        ...(str(req.query.domain) ? { domain: str(req.query.domain) } : {}),
        ...(bool(req.query.mine) ? { ownerPartyId: auth.partyId } : {}),
        ...(bool(req.query.unowned) ? { ownerUnresolved: true } : {}),
        ...(bool(req.query.breached) ? { slaDueAt: { lt: new Date() } } : {}),
      },
      orderBy: [{ severity: 'desc' }, { raisedAt: 'asc' }],
      take: 200,
    });

    const ownerIds = [...new Set(rows.map((r) => r.ownerPartyId).filter(Boolean) as string[])];
    const owners = ownerIds.length
      ? await prisma.person.findMany({ where: { id: { in: ownerIds } }, select: { id: true, fullName: true } })
      : [];
    const ownerMap = new Map(owners.map((o) => [o.id, o.fullName]));

    return rows.map((r) => ({
      id: r.id,
      recordCode: r.recordCode,
      code: r.code,
      label: r.label,
      severity: r.severity,
      state: r.state,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectLabel: r.subjectLabel ?? r.subjectId,
      domain: r.domain,
      detail: r.detail,
      reasonCode: r.reasonCode,
      ownerPartyId: r.ownerPartyId,
      ownerName: r.ownerPartyId ? (ownerMap.get(r.ownerPartyId) ?? null) : null,
      ownerUnresolved: r.ownerUnresolved,
      raisedAt: r.raisedAt.toISOString(),
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      slaDueAt: r.slaDueAt?.toISOString() ?? null,
      slaBreached: Boolean(r.slaDueAt && r.slaDueAt < new Date() && !r.resolvedAt),
      escalationRung: r.escalationRung,
      escalationTrigger: r.escalationTrigger,
      ladderRung: r.ladderRung,
    }));
  }),
);

router.post(
  '/exceptions/:id/acknowledge',
  handler(async (req) => acknowledgeException(req.params.id, str(req.body?.note))),
);

router.post(
  '/exceptions/:id/resolve',
  handler(async (req) => {
    const schema = z.object({ note: z.string().min(1) });
    return resolveException(req.params.id, schema.parse(req.body).note);
  }),
);

export default router;
