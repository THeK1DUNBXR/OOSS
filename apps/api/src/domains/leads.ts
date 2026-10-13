/**
 * Lead (CRM-LEAD-003).
 *
 * Ownership is routing-determined. The creation-time actor never leaks into
 * `ownerPartyId` through any code path — a lead created by a human who is not
 * themselves a valid routing candidate still routes to a real candidate, and a
 * webhook-sourced lead with no eligible candidate lands `unrouted` rather than
 * sitting with the intake service account.
 */

import type { Lead } from '@prisma/client';
import { EVENTS, isUnrouted, type Vertical } from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { rupeesToMinor, rupeesToMinorOrNull } from '../platform/wire.js';
import { governedWrite } from '../platform/governedWrite.js';
import { assertCan, scopeFor, scopeWhere } from '../platform/permissions.js';
import { notify, raiseException } from '../platform/exceptions.js';
import { entryStage, pipelineForVertical, stageFor, validateTransition } from './pipelines.js';
import { routeLead, raiseUnroutedException } from './routing.js';
import { lockAssignableParty } from './ownership.js';
import { findOrCreatePerson } from './identity.js';

export interface LeadInput {
  title: string;
  personId?: string | null;
  person?: { fullName: string; primaryPhone?: string | null; primaryEmail?: string | null };
  organizationId?: string | null;
  vertical: Vertical;
  offeringId?: string | null;
  legacyProductText?: string | null;
  source?: string;
  sourceDetail?: string | null;
  estimatedValue?: number | null;
  currency?: string;
  district?: string | null;
}

/**
 * Rule-based lead scoring: transparent, reversible, non-consequential until a
 * human acts on the qualification gate. Every contribution is disclosed in
 * scoreReasons — a black-box number is not acceptable here.
 */
export function scoreLead(input: {
  hasEmail: boolean;
  hasPhone: boolean;
  hasOrganization: boolean;
  hasOffering: boolean;
  estimatedValue: number | null;
  source: string;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (input.hasPhone) {
    score += 15;
    reasons.push('+15 reachable by phone');
  }
  if (input.hasEmail) {
    score += 10;
    reasons.push('+10 reachable by email');
  }
  if (input.hasOrganization) {
    score += 20;
    reasons.push('+20 linked to a known organization');
  }
  if (input.hasOffering) {
    score += 15;
    reasons.push('+15 a catalog offering is identified');
  }
  if (input.estimatedValue && input.estimatedValue > 0) {
    const band = input.estimatedValue >= 1_000_000 ? 25 : input.estimatedValue >= 250_000 ? 15 : 8;
    score += band;
    reasons.push(`+${band} estimated value band`);
  }
  const sourceWeights: Record<string, number> = {
    referral: 20,
    inbound_website: 12,
    event: 10,
    campaign: 8,
    manual: 5,
    cold_outreach: 2,
  };
  const sw = sourceWeights[input.source] ?? 5;
  score += sw;
  reasons.push(`+${sw} source: ${input.source}`);

  return { score: Math.min(score, 100), reasons };
}

export async function createLead(input: LeadInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'leads', verb: 'create' });

  // Every intake path resolves identity through the one sanctioned function.
  // No code path skips findOrCreatePerson — a form submission from an existing
  // student must not fork identity.
  let personId = input.personId ?? null;
  if (!personId && input.person) {
    const resolved = await findOrCreatePerson(input.person);
    personId = resolved.person.id;
  }

  const pipeline = await pipelineForVertical(input.vertical);
  const stage = await entryStage(pipeline.id);
  const scoring = scoreLead({
    hasEmail: Boolean(input.person?.primaryEmail),
    hasPhone: Boolean(input.person?.primaryPhone),
    hasOrganization: Boolean(input.organizationId),
    hasOffering: Boolean(input.offeringId),
    estimatedValue: input.estimatedValue ?? null,
    source: input.source ?? 'manual',
  });

  // The lead, its audit row and its creation event commit together; routing
  // runs after, as its own governed writes.
  const lead = await governedWrite(async (tx) => {
    const recordCode = await nextRecordCode('LEAD', undefined, tx);
    const created = await tx.lead.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        title: input.title,
        personId,
        organizationId: input.organizationId ?? null,
        vertical: input.vertical,
        offeringId: input.offeringId ?? null,
        legacyProductText: input.legacyProductText ?? null,
        pipelineId: pipeline.id,
        stageKey: stage.stageKey,
        stageEnteredAt: new Date(),
        leadStatus: 'open',
        // Nullable at creation. Written by the routing evaluation immediately
        // after — not a creation precondition, since a lead can legitimately
        // exist unrouted with no owner.
        ownerPartyId: null,
        score: scoring.score,
        scoreReasons: scoring.reasons,
        source: input.source ?? 'manual',
        sourceDetail: input.sourceDetail ?? null,
        estimatedValueMinor: rupeesToMinorOrNull(input.estimatedValue ?? undefined),
        currency: input.currency ?? 'INR',
        createdById: auth.partyId,
      },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'lead',
      subjectId: created.id,
      after: { title: created.title, recordCode },
      tx,
    });

    // Fired BEFORE routing, with ownerPartyId null.
    await emit({
      name: EVENTS.LEAD_CREATED,
      subject: { entityType: 'lead', entityId: created.id, recordCode },
      related: [
        ...(personId ? [{ relation: 'contact', entityType: 'person', entityId: personId }] : []),
        ...(input.organizationId
          ? [{ relation: 'account', entityType: 'organization', entityId: input.organizationId }]
          : []),
      ],
      newState: {
        stageKey: stage.stageKey,
        pipelinePosition: stage.pipelinePosition,
        ownerPartyId: null,
        score: scoring.score,
      },
      tx,
    });

    return created;
  });

  // Routing runs inline, synchronously.
  const routed = await applyRouting(lead.id, input.district ?? null);
  return routed;
}

export async function applyRouting(leadId: string, district: string | null = null) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw ApiError.notFound('Lead');

  const outcome = await routeLead({
    leadId: lead.id,
    vertical: lead.vertical,
    organizationId: lead.organizationId,
    offeringId: lead.offeringId,
    district,
    accountKind: lead.organizationId ? 'organization' : 'individual',
  });

  const updated = await governedWrite(async (tx) => {
    const row = await tx.lead.update({
      where: { id: leadId },
      data: {
        ownerPartyId: outcome.winnerPartyId,
        territoryId: outcome.territoryId,
        unroutedReason: outcome.unroutedReason,
        routedAt: outcome.winnerPartyId ? new Date() : null,
      },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'lead',
      subjectId: leadId,
      before: { ownerPartyId: lead.ownerPartyId },
      after: {
        ownerPartyId: outcome.winnerPartyId,
        territoryId: outcome.territoryId,
        unroutedReason: outcome.unroutedReason,
      },
      meta: { assignedBy: 'routing_rule' },
      tx,
    });

    if (outcome.winnerPartyId) {
      await emit({
        name: EVENTS.LEAD_ROUTED,
        subject: { entityType: 'lead', entityId: leadId, recordCode: lead.recordCode },
        newState: { ownerPartyId: outcome.winnerPartyId, territoryId: outcome.territoryId },
        owner: { partyId: outcome.winnerPartyId },
        tx,
      });
    }

    return row;
  });

  if (outcome.winnerPartyId) {
    await notify({
      recipientPartyId: outcome.winnerPartyId,
      priority: 'N2_NORMAL',
      title: `Lead assigned: ${lead.title}`,
      body: `${lead.recordCode} routed to you. SLA clock started.`,
      subjectType: 'lead',
      subjectId: leadId,
      drillPath: `/crm/leads/${leadId}`,
    });
  } else if (outcome.unroutedReason) {
    // An unrouted lead is abnormal the moment routing fails to find a
    // candidate, not after some grace period.
    await raiseUnroutedException(leadId, lead.title, outcome.territoryId, outcome.unroutedReason);
  }

  return updated;
}

/** An explicit, separately-permissioned override, distinct from the ordinary creation flow. */
export async function reassignLead(leadId: string, newOwnerPartyId: string, reason: string) {
  await assertCan({ resource: 'leads', verb: 'assign' });

  const lead = await prisma.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw ApiError.notFound('Lead');

  return governedWrite((tx) => writeLeadOwner(tx, lead, newOwnerPartyId, reason, 'human_override'));
}

/** The grant a handover needs for leads. Checked outside the exit's transaction, as every grant check here is. */
export async function authoriseLeadHandover(): Promise<void> {
  await assertCan({ resource: 'leads', verb: 'assign' });
}

/** The exit handover's write for one open lead, inside the exit's transaction. The caller has locked the row and checked the grant. */
export function handOverLeadInTx(tx: DbTx, lead: Lead, successorPartyId: string, reason: string): Promise<Lead> {
  return writeLeadOwner(tx, lead, successorPartyId, reason, 'exit_handover');
}

/**
 * Moves a lead to a new owner inside the caller's transaction: the row, the audit
 * row and the event. A lead sitting with the wrong owner for the wrong reason (a
 * routing bug vs. a manager's deliberate reassignment, or a leaver's exit) needs
 * different remediation, so the audit trail and the event say which one it was.
 */
async function writeLeadOwner(
  tx: DbTx,
  lead: Lead,
  newOwnerPartyId: string,
  reason: string,
  change: 'human_override' | 'exit_handover',
): Promise<Lead> {
  const auth = currentAuth();
  await lockAssignableParty(tx, auth.tenantId, newOwnerPartyId);

  const updated = await tx.lead.update({
    where: { id: lead.id },
    data: { ownerPartyId: newOwnerPartyId, unroutedReason: null, routedAt: new Date() },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'lead',
    subjectId: lead.id,
    before: { ownerPartyId: lead.ownerPartyId },
    after: { ownerPartyId: newOwnerPartyId },
    meta: { assignedBy: change, reason, actorId: auth.partyId },
    tx,
  });

  await emit({
    name: EVENTS.LEAD_REASSIGNED,
    subject: { entityType: 'lead', entityId: lead.id, recordCode: lead.recordCode },
    previousState: { ownerPartyId: lead.ownerPartyId },
    newState: { ownerPartyId: newOwnerPartyId },
    reason: { reasonCode: change === 'human_override' ? 'manual_override' : 'exit_handover', note: reason },
    tx,
  });

  return updated;
}

export async function advanceLeadStage(leadId: string, toStageKey: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw ApiError.notFound('Lead');

  await assertCan({ resource: 'leads', verb: 'edit', record: { ownerPartyId: lead.ownerPartyId } });

  const check = await validateTransition(lead.pipelineId, lead.stageKey, toStageKey, lead as never);
  if (!check.ok) throw ApiError.unprocessable(check.reason!, { missingRequiredFields: check.missingRequiredFields });

  const fromStage = await stageFor(lead.pipelineId, lead.stageKey);

  return governedWrite(async (tx) => {
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: { stageKey: toStageKey, stageEnteredAt: new Date(), untouchedNotifiedAt: null },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'lead',
      subjectId: leadId,
      before: { stageKey: lead.stageKey },
      after: { stageKey: toStageKey },
      tx,
    });

    await emit({
      name: EVENTS.LEAD_STAGE_CHANGED,
      subject: { entityType: 'lead', entityId: leadId, recordCode: lead.recordCode },
      previousState: { stageKey: lead.stageKey, pipelinePosition: fromStage.pipelinePosition },
      // Every subscriber that only needs the canonical axis reads
      // pipelinePosition and never needs to know the pipeline's local vocabulary.
      newState: { stageKey: toStageKey, pipelinePosition: check.targetStage!.pipelinePosition },
      owner: { partyId: lead.ownerPartyId },
      tx,
    });

    return updated;
  });
}

/**
 * Conversion carries pipelineId forward only if the target pipeline accepts
 * conversions from the lead's pipeline — a PL-ADMISSION lead lands in
 * PL-ADMISSION's own stages, never silently re-routed into PL-ENTERPRISE.
 */
export async function convertLead(
  leadId: string,
  opts: { expectedValue?: number | null; expectedCloseDate?: Date | null } = {},
) {
  const auth = currentAuth();
  const lead = await prisma.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw ApiError.notFound('Lead');
  if (lead.leadStatus === 'converted') throw ApiError.conflict('Lead is already converted.');

  await assertCan({ resource: 'opportunities', verb: 'create' });

  const stage = await entryStage(lead.pipelineId);

  // The conversion is one change: the opportunity appears and the lead stops
  // being open, or neither happens.
  return governedWrite(async (tx) => {
    const recordCode = await nextRecordCode('OPP', undefined, tx);
    const opportunity = await tx.opportunity.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        title: lead.title,
        organizationId: lead.organizationId,
        primaryContactPersonId: lead.personId,
        leadId: lead.id,
        vertical: lead.vertical,
        offeringId: lead.offeringId,
        legacyProductText: lead.legacyProductText,
        pipelineId: lead.pipelineId,
        stageKey: stage.stageKey,
        stageEnteredAt: new Date(),
        expectedValueMinor:
          opts.expectedValue != null ? rupeesToMinor(opts.expectedValue) : (lead.estimatedValueMinor ?? undefined),
        currency: lead.currency,
        expectedCloseDate: opts.expectedCloseDate ?? null,
        ownerPartyId: lead.ownerPartyId,
        forecastCategory: 'pipeline',
        createdById: auth.partyId,
      },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      after: { recordCode, leadId: lead.id, stageKey: stage.stageKey },
      tx,
    });

    await tx.lead.update({
      where: { id: leadId },
      data: { leadStatus: 'converted', convertedOpportunityId: opportunity.id },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'lead',
      subjectId: leadId,
      before: { leadStatus: lead.leadStatus },
      after: { leadStatus: 'converted', convertedOpportunityId: opportunity.id },
      tx,
    });

    await emit({
      name: EVENTS.LEAD_CONVERTED,
      subject: { entityType: 'lead', entityId: leadId, recordCode: lead.recordCode },
      related: [{ relation: 'converted_to', entityType: 'opportunity', entityId: opportunity.id }],
      newState: { leadStatus: 'converted', opportunityId: opportunity.id },
      tx,
    });

    await emit({
      name: EVENTS.OPPORTUNITY_CREATED,
      subject: { entityType: 'opportunity', entityId: opportunity.id, recordCode },
      related: [{ relation: 'converted_from', entityType: 'lead', entityId: leadId }],
      newState: { stageKey: stage.stageKey, pipelinePosition: stage.pipelinePosition },
      owner: { partyId: opportunity.ownerPartyId },
      tx,
    });

    return opportunity;
  });
}

export interface LeadListFilters {
  pipelineId?: string;
  stageKey?: string;
  leadStatus?: string;
  ownerPartyId?: string;
  unrouted?: boolean;
  vertical?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listLeads(filters: LeadListFilters) {
  const auth = currentAuth();
  const scope = await scopeFor('leads', 'view');
  if (!scope) throw ApiError.forbidden('leads:view is not held.');

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);

  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
    ...(filters.stageKey ? { stageKey: filters.stageKey } : {}),
    ...(filters.leadStatus ? { leadStatus: filters.leadStatus } : {}),
    ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
    ...(filters.vertical ? { vertical: filters.vertical } : {}),
    // The canonical unrouted predicate. One source of truth.
    ...(filters.unrouted ? { leadStatus: 'open', ownerPartyId: null } : {}),
    ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        person: { select: { id: true, fullName: true } },
        organization: { select: { id: true, name: true } },
        offering: { select: { id: true, name: true } },
        pipeline: { select: { id: true, pipelineCode: true, name: true } },
        territory: { select: { id: true, name: true } },
      },
    }),
    prisma.lead.count({ where: where as never }),
  ]);

  return { items, total, page, pageSize };
}

/** Confirms the unrouted predicate is the same in code as in the query. */
export function leadIsUnrouted(lead: { leadStatus: string; ownerPartyId: string | null }): boolean {
  return isUnrouted(lead);
}

/**
 * The lead-untouched detector. Idempotent by its per-record marker, in addition
 * to the substrate-level idempotency key.
 */
export async function detectUntouchedLeads(thresholdDays = 3): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);

  const stale = await prisma.lead.findMany({
    where: {
      tenantId: auth.tenantId,
      leadStatus: 'open',
      deletedAt: null,
      ownerPartyId: { not: null },
      untouchedNotifiedAt: null,
      createdAt: { lt: cutoff },
      OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: cutoff } }],
    },
    take: 200,
  });

  for (const lead of stale) {
    await raiseException({
      code: 'EX-CRM-010',
      label: 'Nobody has contacted this lead yet',
      severity: 'S1_ATTENTION',
      subjectType: 'lead',
      subjectId: lead.id,
      subjectLabel: `${lead.recordCode} — ${lead.title}`,
      detail: `No recorded interaction in ${thresholdDays} days since assignment.`,
      ownerPartyId: lead.ownerPartyId,
      triggerFingerprint: `lead_untouched:${thresholdDays}`,
      ladderRung: 1,
    });
    await governedWrite(async (tx) => {
      await tx.lead.update({ where: { id: lead.id }, data: { untouchedNotifiedAt: new Date() } });
      await auditWrite({
        action: 'update',
        subjectType: 'lead',
        subjectId: lead.id,
        before: { untouchedNotifiedAt: null },
        after: { untouchedNotifiedAt: 'set' },
        tx,
      });
      await emit({
        name: EVENTS.LEAD_UNTOUCHED_DETECTED,
        subject: { entityType: 'lead', entityId: lead.id, recordCode: lead.recordCode },
        newState: { thresholdDays },
        owner: { partyId: lead.ownerPartyId },
        impact: { domains: ['crm'], severity: 'S1_ATTENTION' },
        tx,
      });
    });
  }

  return stale.length;
}

export { scopeWhere };
