import { Router } from 'express';
import { z } from 'zod';
import { VERTICALS, INTERACTION_TYPES, RELATIONSHIP_TYPES } from '@kaizen/shared';
import { handler, parsePaging, str, bool, date, numeric } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, can, canSeeMoney, applyFieldVisibility } from '../platform/permissions.js';
import {
  findOrCreatePerson,
  findDedupCandidates,
  crmResolutionScope,
  mergePersons,
  resolveMergeCandidate,
  createAffiliation,
} from '../domains/identity.js';
import {
  createOrganization,
  attachAccount,
  attachInstitutionProfile,
  detachAccount,
  assembleOrganization360,
  computeRelationshipStatus,
} from '../domains/organizations.js';
import { createRelationship, refineRelationship, supersedeRelationship, traverse, resolveEdge } from '../domains/relationships.js';
import {
  createLead,
  listLeads,
  advanceLeadStage,
  convertLead,
  reassignLead,
  applyRouting,
} from '../domains/leads.js';
import { routingAuditFor } from '../domains/routing.js';
import {
  createOpportunity,
  listOpportunities,
  advanceStage,
  changeForecastCategory,
  forecastRollup,
  coverageByPosition,
  openRenewalOpportunity,
} from '../domains/opportunities.js';
import { logInteraction, timelineFor, recentInteractions } from '../domains/interactions.js';
import { universalSearch } from '../domains/surfaces.js';

const router = Router();

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

router.get('/search', handler(async (req) => universalSearch(str(req.query.q) ?? '', 15)));

// ---------------------------------------------------------------------------
// People — the identity spine
// ---------------------------------------------------------------------------

router.get(
  '/people',
  handler(async (req) => {
    await assertCan({ resource: 'people', verb: 'view' });
    const auth = currentAuth();
    const { page, pageSize } = parsePaging(req);
    const q = str(req.query.q);

    const where = {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(bool(req.query.includeMerged) ? {} : { dedupeStatus: { not: 'merged' } }),
      ...(q
        ? { OR: [{ fullName: { contains: q, mode: 'insensitive' as const } }, { recordCode: { contains: q, mode: 'insensitive' as const } }, { primaryEmail: { contains: q, mode: 'insensitive' as const } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.person.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { affiliations: { where: { status: 'active' } } },
      }),
      prisma.person.count({ where: where as never }),
    ]);

    const canSeeHr = await can({ resource: 'users', verb: 'view' });

    return {
      items: items.map((p) => ({
        id: p.id,
        recordCode: p.recordCode,
        fullName: p.fullName,
        primaryPhone: p.primaryPhone,
        primaryEmail: p.primaryEmail,
        additionalPhones: p.additionalPhones,
        additionalEmails: p.additionalEmails,
        dedupeStatus: p.dedupeStatus,
        mergedInto: p.mergedIntoId,
        affiliations: p.affiliations.map((a) => ({
          id: a.id,
          affiliationType: a.affiliationType,
          status: a.status,
          counterpartyName: a.counterpartyName,
        })),
        // A CRM role sees "holds a non-CRM affiliation" as a badge, never the
        // specialisation detail behind it.
        externalAffiliationBadges: canSeeHr
          ? []
          : p.affiliations.filter((a) => ['employee', 'student'].includes(a.affiliationType)).map((a) => a.affiliationType),
        createdAt: p.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }),
);

router.get(
  '/people/:id',
  handler(async (req) => {
    await assertCan({ resource: 'people', verb: 'view' });
    const person = await prisma.person.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { affiliations: true },
    });
    if (!person) throw ApiError.notFound('Person');
    const relationships = await traverse('person', person.id, { fullHistory: true });
    const timeline = await timelineFor('person', person.id, { limit: 30 });
    return { person, relationships, timeline: timeline.items };
  }),
);

/** Dedup preview — lets an intake surface show candidates before committing. */
router.post(
  '/people/dedup-check',
  handler(async (req) => {
    const auth = currentAuth();
    const schema = z.object({
      fullName: z.string(),
      primaryPhone: z.string().nullish(),
      primaryEmail: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const candidates = await findDedupCandidates(input, crmResolutionScope(auth.tenantId));
    return { candidates };
  }),
);

router.post(
  '/people',
  handler(async (req, res) => {
    await assertCan({ resource: 'people', verb: 'create' });
    const schema = z.object({
      fullName: z.string().min(1),
      primaryPhone: z.string().nullish(),
      primaryEmail: z.string().email().nullish(),
      additionalPhones: z.array(z.string()).optional(),
      additionalEmails: z.array(z.string()).optional(),
      notes: z.string().nullish(),
      source: z.string().optional(),
      forceCreate: z.boolean().optional(),
      overrideReason: z.string().optional(),
    });
    const input = schema.parse(req.body);

    if (input.forceCreate && !input.overrideReason) {
      throw ApiError.badRequest('An explicit force-create requires a reason, which is audit-logged.');
    }

    const result = await findOrCreatePerson(input, {
      forceCreate: input.forceCreate,
      overrideReason: input.overrideReason,
    });
    res.status(result.created ? 201 : 200).json(result);
    return undefined;
  }),
);

router.post(
  '/people/:id/merge',
  handler(async (req) => {
    const schema = z.object({ targetId: z.string(), note: z.string().min(1) });
    const input = schema.parse(req.body);
    return mergePersons(req.params.id, input.targetId, input.note);
  }),
);

router.post(
  '/people/:id/affiliations',
  handler(async (req) => {
    await assertCan({ resource: 'people', verb: 'edit' });
    const schema = z.object({
      affiliationType: z.string(),
      roleSlug: z.string().nullish(),
      counterpartyId: z.string().nullish(),
      counterpartyName: z.string().nullish(),
      primaryFlag: z.boolean().optional(),
      branch: z.string().nullish(),
      orgUnitId: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    return createAffiliation({ partyId: req.params.id, ...input } as never);
  }),
);

// ---------------------------------------------------------------------------
// Merge candidates — the queue shows zero items only when zero are actually open
// ---------------------------------------------------------------------------

router.get(
  '/merge-candidates',
  handler(async (req) => {
    await assertCan({ resource: 'people', verb: 'view' });
    const auth = currentAuth();
    const rows = await prisma.mergeCandidate.findMany({
      where: { tenantId: auth.tenantId, state: str(req.query.state) ?? 'open' },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });

    return Promise.all(
      rows.map(async (r) => {
        const candidate = await prisma.person.findFirst({
          where: { id: r.candidatePersonId },
          include: { affiliations: { where: { status: 'active' } } },
        });
        return {
          id: r.id,
          confidence: r.confidence,
          matchedOn: r.matchedOn,
          raisedReason: r.raisedReason,
          state: r.state,
          createdAt: r.createdAt.toISOString(),
          incomingPayload: r.incomingPayload,
          candidate: candidate
            ? {
                id: candidate.id,
                recordCode: candidate.recordCode,
                fullName: candidate.fullName,
                affiliationBadges: candidate.affiliations.map((a) => a.affiliationType),
                statutoryRetentionFloor: candidate.affiliations.some((a) => a.statutoryRetentionFloor),
              }
            : null,
        };
      }),
    );
  }),
);

router.post(
  '/merge-candidates/:id/resolve',
  handler(async (req) => {
    const schema = z.object({ disposition: z.enum(['confirm', 'reject', 'defer']), note: z.string().min(1) });
    const input = schema.parse(req.body);
    return resolveMergeCandidate(req.params.id, input.disposition, input.note);
  }),
);

// ---------------------------------------------------------------------------
// Organizations and their two independent specialisations
// ---------------------------------------------------------------------------

router.get(
  '/organizations',
  handler(async (req) => {
    await assertCan({ resource: 'organizations', verb: 'view' });
    const auth = currentAuth();
    const { page, pageSize } = parsePaging(req);
    const q = str(req.query.q);
    const specialisation = str(req.query.specialisation);

    const where = {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { recordCode: { contains: q, mode: 'insensitive' as const } }] } : {}),
      // Tests specialisation existence, never a category enum.
      ...(specialisation === 'account' ? { account: { isNot: null } } : {}),
      ...(specialisation === 'institution' ? { institutionProfile: { isNot: null } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where: where as never,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { account: true, institutionProfile: true },
      }),
      prisma.organization.count({ where: where as never }),
    ]);

    const canSeeInstitution = await can({ resource: 'institutions', verb: 'view' });

    return {
      items: await Promise.all(
        items.map(async (o) => ({
          id: o.id,
          recordCode: o.recordCode,
          name: o.name,
          website: o.website,
          tags: o.tags,
          ownerPartyId: o.ownerPartyId,
          legacyCategory: o.legacyCategory,
          specialisations: [
            ...(o.account ? [{ kind: 'account' as const, present: true as const, viewable: true }] : []),
            ...(o.institutionProfile ? [{ kind: 'institution_profile' as const, present: true as const, viewable: canSeeInstitution }] : []),
          ],
          account: o.account,
          // The fact of the specialisation is not itself sensitive; its
          // contents are.
          institutionProfile: canSeeInstitution ? o.institutionProfile : null,
          computedRelationshipStatus: await computeRelationshipStatus(o.id),
          createdAt: o.createdAt.toISOString(),
        })),
      ),
      total,
      page,
      pageSize,
    };
  }),
);

router.get('/organizations/:id', handler(async (req) => assembleOrganization360(req.params.id)));

router.post(
  '/organizations',
  handler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      website: z.string().nullish(),
      tags: z.array(z.string()).optional(),
      ownerPartyId: z.string().nullish(),
    });
    const org = await createOrganization(schema.parse(req.body));
    res.status(201).json(org);
    return undefined;
  }),
);

router.post(
  '/organizations/:id/account',
  handler(async (req) => {
    const schema = z.object({
      tier: z.string().optional(),
      billingEmail: z.string().nullish(),
      paymentTermsDays: z.number().nullish(),
      annualRevenueBand: z.string().nullish(),
      employeeCountBand: z.string().nullish(),
    });
    return attachAccount(req.params.id, schema.parse(req.body));
  }),
);

router.post(
  '/organizations/:id/institution-profile',
  handler(async (req) => {
    const schema = z.object({
      institutionType: z.string().nullish(),
      managementType: z.string().nullish(),
      district: z.string().nullish(),
      taluk: z.string().nullish(),
      state: z.string().nullish(),
      address: z.string().nullish(),
      latitude: z.number().nullish(),
      longitude: z.number().nullish(),
      externalIdentifier: z.string().nullish(),
      establishedYear: z.number().nullish(),
      studentCount: z.number().nullish(),
      departments: z.array(z.string()).optional(),
      strategicPriority: z.string().nullish(),
    });
    return attachInstitutionProfile(req.params.id, schema.parse(req.body));
  }),
);

router.delete('/organizations/:id/account', handler(async (req) => detachAccount(req.params.id)));

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

router.get(
  '/relationships',
  handler(async (req) => {
    await assertCan({ resource: 'relationships', verb: 'view' });
    const entityType = str(req.query.entityType);
    const entityId = str(req.query.entityId);
    if (!entityType || !entityId) throw ApiError.badRequest('entityType and entityId are required.');
    return traverse(entityType, entityId, { fullHistory: bool(req.query.fullHistory) ?? false });
  }),
);

router.post(
  '/relationships',
  handler(async (req, res) => {
    await assertCan({ resource: 'relationships', verb: 'create' });
    const schema = z.object({
      fromType: z.string(),
      fromId: z.string(),
      toType: z.string(),
      toId: z.string(),
      relationshipType: z.enum(RELATIONSHIP_TYPES),
      role: z.string().nullish(),
      strength: z.enum(['weak', 'moderate', 'strong']).optional(),
      notes: z.string().nullish(),
    });
    const rel = await createRelationship(schema.parse(req.body) as never);
    res.status(201).json(rel);
    return undefined;
  }),
);

/** In-place refinement — the deliberate exception to the supersede rule. */
router.patch(
  '/relationships/:id/refine',
  handler(async (req) => {
    await assertCan({ resource: 'relationships', verb: 'edit' });
    const schema = z.object({ status: z.string().optional(), strength: z.enum(['weak', 'moderate', 'strong']).optional() });
    return refineRelationship(req.params.id, schema.parse(req.body));
  }),
);

/** A nature change ends the current record and starts a new one. */
router.post(
  '/relationships/:id/supersede',
  handler(async (req) => {
    await assertCan({ resource: 'relationships', verb: 'edit' });
    const schema = z.object({
      relationshipType: z.enum(RELATIONSHIP_TYPES).optional(),
      role: z.string().nullish(),
      toId: z.string().optional(),
      toType: z.string().optional(),
    });
    return supersedeRelationship(req.params.id, schema.parse(req.body) as never);
  }),
);

/** The published EDGE projection, for non-crm contexts. */
router.get(
  '/edges',
  handler(async (req) => {
    const personId = str(req.query.personId);
    const organizationId = str(req.query.organizationId);
    if (!personId || !organizationId) throw ApiError.badRequest('personId and organizationId are required.');
    return resolveEdge(personId, organizationId);
  }),
);

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

router.get(
  '/leads',
  handler(async (req) => {
    const { page, pageSize } = parsePaging(req);
    const result = await listLeads({
      page,
      pageSize,
      pipelineId: str(req.query.pipelineId),
      stageKey: str(req.query.stageKey),
      leadStatus: str(req.query.leadStatus),
      ownerPartyId: str(req.query.ownerPartyId),
      unrouted: bool(req.query.unrouted),
      vertical: str(req.query.vertical),
      q: str(req.query.q),
    });

    const stages = await prisma.pipelineStage.findMany({ where: { tenantId: currentAuth().tenantId, retiredAt: null } });
    const stageMap = new Map(stages.map((s) => [`${s.pipelineId}:${s.stageKey}`, s]));
    const money = await canSeeMoney('leads');

    return {
      ...result,
      items: result.items.map((l) => {
        const stage = stageMap.get(`${l.pipelineId}:${l.stageKey}`);
        const ageDays = Math.floor((Date.now() - l.stageEnteredAt.getTime()) / 86_400_000);
        return {
          id: l.id,
          recordCode: l.recordCode,
          title: l.title,
          personId: l.personId,
          personName: l.person?.fullName ?? null,
          organizationId: l.organizationId,
          organizationName: l.organization?.name ?? null,
          vertical: l.vertical,
          offeringId: l.offeringId,
          offeringName: l.offering?.name ?? null,
          legacyProductText: l.legacyProductText,
          pipelineId: l.pipelineId,
          pipelineCode: l.pipeline.pipelineCode,
          stageKey: l.stageKey,
          stageLabel: stage?.label ?? l.stageKey,
          pipelinePosition: stage?.pipelinePosition ?? 10,
          leadStatus: l.leadStatus,
          ownerPartyId: l.ownerPartyId,
          ownerName: null,
          territoryId: l.territoryId,
          territoryName: l.territory?.name ?? null,
          unrouted: l.leadStatus === 'open' && l.ownerPartyId === null,
          unroutedReason: l.unroutedReason,
          score: l.score,
          scoreReasons: l.scoreReasons,
          source: l.source,
          estimatedValue: money ? num(l.estimatedValue) : null,
          currency: l.currency,
          stageEnteredAt: l.stageEnteredAt.toISOString(),
          stageAgeDays: ageDays,
          stageAgeBreached: Boolean(stage?.stageAgeBudgetDays && ageDays > stage.stageAgeBudgetDays),
          lastInteractionAt: l.lastInteractionAt?.toISOString() ?? null,
          createdAt: l.createdAt.toISOString(),
        };
      }),
    };
  }),
);

router.get(
  '/leads/:id',
  handler(async (req) => {
    await assertCan({ resource: 'leads', verb: 'view' });
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { person: true, organization: true, offering: true, pipeline: { include: { stages: true, transitions: true } }, territory: true },
    });
    if (!lead) throw ApiError.notFound('Lead');
    const [timeline, routing] = await Promise.all([
      timelineFor('lead', lead.id, { limit: 30 }),
      routingAuditFor(lead.id),
    ]);
    return { lead, timeline: timeline.items, routingAudit: routing };
  }),
);

router.post(
  '/leads',
  handler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      personId: z.string().nullish(),
      person: z
        .object({ fullName: z.string(), primaryPhone: z.string().nullish(), primaryEmail: z.string().nullish() })
        .optional(),
      organizationId: z.string().nullish(),
      vertical: z.enum(VERTICALS),
      offeringId: z.string().nullish(),
      source: z.string().optional(),
      sourceDetail: z.string().nullish(),
      estimatedValue: z.number().nullish(),
      district: z.string().nullish(),
    });
    const lead = await createLead(schema.parse(req.body) as never);
    res.status(201).json(lead);
    return undefined;
  }),
);

router.post(
  '/leads/:id/stage',
  handler(async (req) => {
    const schema = z.object({ toStageKey: z.string() });
    return advanceLeadStage(req.params.id, schema.parse(req.body).toStageKey);
  }),
);

router.post(
  '/leads/:id/reroute',
  handler(async (req) => applyRouting(req.params.id, str(req.body?.district) ?? null)),
);

router.post(
  '/leads/:id/reassign',
  handler(async (req) => {
    const schema = z.object({ ownerPartyId: z.string(), reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return reassignLead(req.params.id, input.ownerPartyId, input.reason);
  }),
);

router.post(
  '/leads/:id/convert',
  handler(async (req, res) => {
    const schema = z.object({ expectedValue: z.number().nullish(), expectedCloseDate: z.string().nullish() });
    const input = schema.parse(req.body ?? {});
    const opp = await convertLead(req.params.id, {
      expectedValue: input.expectedValue ?? null,
      expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
    });
    res.status(201).json(opp);
    return undefined;
  }),
);

router.get('/leads/:id/routing-audit', handler(async (req) => routingAuditFor(req.params.id)));

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

router.get(
  '/opportunities',
  handler(async (req) => {
    const { page, pageSize } = parsePaging(req);
    const result = await listOpportunities({
      page,
      pageSize,
      pipelineId: str(req.query.pipelineId),
      stageKey: str(req.query.stageKey),
      forecastCategory: str(req.query.forecastCategory),
      ownerPartyId: str(req.query.ownerPartyId),
      organizationId: str(req.query.organizationId),
      open: bool(req.query.open),
      q: str(req.query.q),
    });

    const auth = currentAuth();
    const stages = await prisma.pipelineStage.findMany({ where: { tenantId: auth.tenantId, retiredAt: null } });
    const stageMap = new Map(stages.map((s) => [`${s.pipelineId}:${s.stageKey}`, s]));
    const money = await canSeeMoney('opportunities');

    return {
      ...result,
      items: result.items.map((o) => {
        const stage = stageMap.get(`${o.pipelineId}:${o.stageKey}`);
        const ageDays = Math.floor((Date.now() - o.stageEnteredAt.getTime()) / 86_400_000);
        const value = num(o.expectedValue);
        return {
          id: o.id,
          recordCode: o.recordCode,
          title: o.title,
          accountId: o.accountId,
          organizationId: o.organizationId,
          organizationName: o.organization?.name ?? null,
          primaryContactPersonId: o.primaryContactPersonId,
          primaryContactName: null,
          vertical: o.vertical,
          offeringId: o.offeringId,
          offeringName: o.offering?.name ?? null,
          pipelineId: o.pipelineId,
          pipelineCode: o.pipeline.pipelineCode,
          pipelineName: o.pipeline.name,
          stageKey: o.stageKey,
          stageLabel: stage?.label ?? o.stageKey,
          pipelinePosition: stage?.pipelinePosition ?? 10,
          defaultProbability: stage?.defaultProbability ?? 0,
          forecastCategory: o.forecastCategory,
          forecastCategoryChangedAt: o.forecastCategoryChangedAt?.toISOString() ?? null,
          forecastCategoryChangeReason: o.forecastCategoryChangeReason,
          // Masked (present but nulled) rather than absent, for a viewer
          // without financial visibility.
          expectedValue: money ? value : null,
          weightedValue: money && value !== null ? Number((value * ((stage?.defaultProbability ?? 0) / 100)).toFixed(2)) : null,
          currency: o.currency,
          expectedCloseDate: o.expectedCloseDate?.toISOString() ?? null,
          closeDateStale: Boolean(o.expectedCloseDate && o.expectedCloseDate < new Date() && !o.outcome),
          ownerPartyId: o.ownerPartyId,
          ownerName: null,
          strategicValue: o.strategicValue,
          proposalId: o.proposalId,
          proposalSentAt: o.proposalSentAt?.toISOString() ?? null,
          quoteId: o.quoteId,
          contractId: o.contractId,
          mouId: o.mouId,
          parentContractId: o.parentContractId,
          legacyStage: o.legacyStage,
          outcome: o.outcome,
          lostReason: o.lostReason,
          stageEnteredAt: o.stageEnteredAt.toISOString(),
          stageAgeDays: ageDays,
          stageAgeBreached: Boolean(stage?.stageAgeBudgetDays && ageDays > stage.stageAgeBudgetDays),
          wonGateSatisfied: Boolean(o.contractId || o.mouId),
          createdAt: o.createdAt.toISOString(),
        };
      }),
    };
  }),
);

router.get(
  '/opportunities/:id',
  handler(async (req) => {
    await assertCan({ resource: 'opportunities', verb: 'view' });
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { organization: true, offering: true, pipeline: { include: { stages: { where: { retiredAt: null }, orderBy: { sequence: 'asc' } }, transitions: true } } },
    });
    if (!opportunity) throw ApiError.notFound('Opportunity');

    const [timeline, proposal, quote, contract, mou, winLoss, receivables] = await Promise.all([
      timelineFor('opportunity', opportunity.id, { limit: 40 }),
      opportunity.proposalId ? prisma.proposal.findFirst({ where: { id: opportunity.proposalId } }) : null,
      opportunity.quoteId ? prisma.quote.findFirst({ where: { id: opportunity.quoteId }, include: { lines: true } }) : null,
      opportunity.contractId ? prisma.contract.findFirst({ where: { id: opportunity.contractId } }) : null,
      opportunity.mouId ? prisma.mou.findFirst({ where: { id: opportunity.mouId } }) : null,
      prisma.winLossReview.findFirst({ where: { subjectType: 'opportunity', subjectId: opportunity.id } }),
      prisma.receivablesProjection.findFirst({ where: { subjectType: 'opportunity', subjectId: opportunity.id } }),
    ]);

    const money = await canSeeMoney('opportunities');
    const filtered = applyFieldVisibility(
      { opportunity, proposal, quote, contract, mou } as unknown as Record<string, unknown>,
      { canSeeMoney: money, ceiling: currentAuth().classificationCeiling },
    );

    return {
      ...filtered.data,
      timeline: timeline.items,
      winLossReview: winLoss,
      receivables,
      withheld: filtered.withheld,
      wonGateSatisfied: Boolean(opportunity.contractId || opportunity.mouId),
    };
  }),
);

router.post(
  '/opportunities',
  handler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      organizationId: z.string().nullish(),
      primaryContactPersonId: z.string().nullish(),
      vertical: z.enum(VERTICALS),
      offeringId: z.string().nullish(),
      expectedValue: z.number().nullish(),
      expectedCloseDate: z.string().nullish(),
      strategicValue: z.enum(['high', 'medium', 'low']).nullish(),
      pipelineId: z.string().optional(),
    });
    const input = schema.parse(req.body);
    const opp = await createOpportunity({
      ...input,
      expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
    } as never);
    res.status(201).json(opp);
    return undefined;
  }),
);

router.post(
  '/opportunities/:id/stage',
  handler(async (req) => {
    const schema = z.object({ toStageKey: z.string(), reasonCode: z.string().optional(), note: z.string().optional() });
    const input = schema.parse(req.body);
    return advanceStage(req.params.id, input.toStageKey, { reasonCode: input.reasonCode, note: input.note });
  }),
);

router.post(
  '/opportunities/:id/forecast-category',
  handler(async (req) => {
    const schema = z.object({ to: z.enum(['pipeline', 'best_case', 'commit']), reason: z.string().optional() });
    const input = schema.parse(req.body);
    return changeForecastCategory({ opportunityId: req.params.id, to: input.to, reason: input.reason });
  }),
);

router.patch(
  '/opportunities/:id',
  handler(async (req) => {
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id } });
    if (!opportunity) throw ApiError.notFound('Opportunity');
    await assertCan({ resource: 'opportunities', verb: 'edit', record: { ownerPartyId: opportunity.ownerPartyId } });

    const schema = z.object({
      title: z.string().optional(),
      expectedValue: z.number().nullish(),
      expectedCloseDate: z.string().nullish(),
      strategicValue: z.enum(['high', 'medium', 'low']).nullish(),
      lostReason: z.string().nullish(),
      economicBuyer: z.string().nullish(),
      decisionCriteria: z.string().nullish(),
    });
    const input = schema.parse(req.body);

    return prisma.opportunity.update({
      where: { id: req.params.id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.expectedValue !== undefined ? { expectedValue: input.expectedValue ?? undefined } : {}),
        ...(input.expectedCloseDate !== undefined
          ? { expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null }
          : {}),
        ...(input.strategicValue !== undefined ? { strategicValue: input.strategicValue } : {}),
        ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
      },
    });
  }),
);

router.post(
  '/opportunities/:id/renewal',
  handler(async (req) => {
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.id } });
    if (!opportunity?.contractId) throw ApiError.unprocessable('This opportunity has no contract to renew.');
    return openRenewalOpportunity(opportunity.contractId);
  }),
);

router.get('/forecast', handler(async (req) => forecastRollup({ blended: bool(req.query.blended) ?? false })));

router.get(
  '/coverage',
  handler(async (req) => coverageByPosition(numeric(req.query.minPosition) ?? 30)),
);

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

router.get(
  '/interactions',
  handler(async (req) => {
    const entityType = str(req.query.entityType);
    const entityId = str(req.query.entityId);
    if (entityType && entityId) {
      const result = await timelineFor(entityType, entityId, { limit: numeric(req.query.limit) ?? 50 });
      return result.items;
    }
    return recentInteractions(numeric(req.query.limit) ?? 50);
  }),
);

router.post(
  '/interactions',
  handler(async (req, res) => {
    const schema = z.object({
      interactionType: z.enum(INTERACTION_TYPES),
      direction: z.enum(['inbound', 'outbound', 'internal']).optional(),
      occurredAt: z.string(),
      relatedReferences: z
        .array(z.object({ contextCode: z.string(), entityType: z.string(), entityId: z.string(), displayLabel: z.string().nullish() }))
        .min(1),
      durationMinutes: z.number().nullish(),
      subject: z.string().nullish(),
      notes: z.string().nullish(),
      outcome: z.string().nullish(),
      nextAction: z.string().nullish(),
      nextActionDue: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const interaction = await logInteraction({
      ...input,
      occurredAt: new Date(input.occurredAt),
      nextActionDue: input.nextActionDue ? new Date(input.nextActionDue) : null,
    } as never);
    res.status(201).json(interaction);
    return undefined;
  }),
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get(
  '/tasks',
  handler(async (req) => {
    const auth = currentAuth();
    return prisma.task.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(bool(req.query.mine) !== false ? { assigneePartyId: auth.partyId } : {}),
        ...(str(req.query.status) ? { status: str(req.query.status) } : { status: { in: ['open', 'in_progress'] } }),
      },
      orderBy: [{ dueAt: 'asc' }],
      take: 100,
    });
  }),
);

router.post(
  '/tasks/:id/complete',
  handler(async (req) => {
    const auth = currentAuth();
    return prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'done', completedAt: new Date(), ownerPartyId: auth.partyId },
    });
  }),
);

export default router;
