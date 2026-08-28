/**
 * P3 — the Relationship Graph (CRM-IDN-004).
 *
 * A normal collection traversed by aggregation, NOT a physical graph database.
 * History is preserved by never overwriting a Relationship in place when its
 * nature changes: a new role or employer produces a NEW record with its own
 * startDate, and the prior one gets an endDate.
 *
 * `status` and `strength` alone may be updated in place — those are refinements
 * of the same ongoing relationship, not nature changes.
 *
 * A relationship exists because a service recorded a real fact. Never created
 * speculatively.
 */

import { EVENTS, type RelationshipStrength, type RelationshipType } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { personIdChain } from './identity.js';

export interface RelationshipInput {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relationshipType: RelationshipType;
  role?: string | null;
  strength?: RelationshipStrength;
  ownerPartyId?: string | null;
  startDate?: Date;
  notes?: string | null;
}

export async function createRelationship(input: RelationshipInput) {
  const auth = currentAuth();
  const rel = await prisma.relationship.create({
    data: {
      tenantId: auth.tenantId,
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      relationshipType: input.relationshipType,
      role: input.role ?? null,
      strength: input.strength ?? 'moderate',
      ownerPartyId: input.ownerPartyId ?? auth.partyId,
      startDate: input.startDate ?? new Date(),
      notes: input.notes ?? null,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'relationship',
    subjectId: rel.id,
    after: { relationshipType: rel.relationshipType, fromId: rel.fromId, toId: rel.toId },
  });

  await emit({
    name: EVENTS.RELATIONSHIP_CREATED,
    subject: { entityType: 'relationship', entityId: rel.id },
    related: [
      { relation: 'from', entityType: input.fromType, entityId: input.fromId },
      { relation: 'to', entityType: input.toType, entityId: input.toId },
    ],
    newState: { relationshipType: input.relationshipType, strength: rel.strength },
  });

  return rel;
}

/**
 * A change to relationshipType, fromId or toId is a NATURE change: it ends the
 * current record and creates a new one. No service updates those fields in
 * place on an existing row.
 */
export async function supersedeRelationship(
  id: string,
  changes: Partial<Pick<RelationshipInput, 'relationshipType' | 'role' | 'fromId' | 'fromType' | 'toId' | 'toType'>>,
) {
  const existing = await prisma.relationship.findFirst({ where: { id } });
  if (!existing) throw ApiError.notFound('Relationship');
  if (existing.endDate) throw ApiError.conflict('This relationship is already ended; supersede the current one instead.');

  const ended = await prisma.relationship.update({
    where: { id },
    data: { endDate: new Date(), status: 'ended' },
  });

  const replacement = await createRelationship({
    fromType: changes.fromType ?? existing.fromType,
    fromId: changes.fromId ?? existing.fromId,
    toType: changes.toType ?? existing.toType,
    toId: changes.toId ?? existing.toId,
    relationshipType: (changes.relationshipType ?? existing.relationshipType) as RelationshipType,
    role: changes.role ?? existing.role,
    strength: existing.strength as RelationshipStrength,
    ownerPartyId: existing.ownerPartyId,
    startDate: new Date(),
    notes: existing.notes,
  });

  await prisma.relationship.update({ where: { id }, data: { supersededById: replacement.id } });

  await emit({
    name: EVENTS.RELATIONSHIP_ENDED,
    subject: { entityType: 'relationship', entityId: id },
    related: [{ relation: 'superseded_by', entityType: 'relationship', entityId: replacement.id }],
    previousState: { relationshipType: existing.relationshipType, role: existing.role },
    newState: { endDate: ended.endDate },
    reason: { reasonCode: 'nature_change' },
  });

  return { ended, replacement };
}

/** The deliberate exception to the supersede rule: in-place refinement. */
export async function refineRelationship(
  id: string,
  changes: { status?: string; strength?: RelationshipStrength },
) {
  const existing = await prisma.relationship.findFirst({ where: { id } });
  if (!existing) throw ApiError.notFound('Relationship');

  const updated = await prisma.relationship.update({
    where: { id },
    data: {
      ...(changes.status ? { status: changes.status } : {}),
      ...(changes.strength ? { strength: changes.strength } : {}),
    },
  });

  if (changes.status && changes.status !== existing.status) {
    await emit({
      name: EVENTS.RELATIONSHIP_STATUS_CHANGED,
      subject: { entityType: 'relationship', entityId: id },
      previousState: { status: existing.status },
      newState: { status: changes.status },
    });
  }
  if (changes.strength && changes.strength !== existing.strength) {
    await emit({
      name: EVENTS.RELATIONSHIP_STRENGTH_CHANGED,
      subject: { entityType: 'relationship', entityId: id },
      previousState: { strength: existing.strength },
      newState: { strength: changes.strength },
    });
  }

  return updated;
}

/**
 * Traversal against the from/to indexes. Current views filter `status != ended`;
 * a full-history view includes ended records — never deleted from view.
 *
 * Traversal from a surviving person id additionally follows the mergedInto
 * chain, so a merged-away person's edges remain part of the complete history.
 */
export async function traverse(
  entityType: string,
  entityId: string,
  opts: { fullHistory?: boolean } = {},
) {
  const auth = currentAuth();
  const ids = entityType === 'person' ? await personIdChain(entityId) : [entityId];

  return prisma.relationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(opts.fullHistory ? {} : { status: { not: 'ended' } }),
      OR: [
        { fromType: entityType, fromId: { in: ids } },
        { toType: entityType, toId: { in: ids } },
      ],
    },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
  });
}

/**
 * The published EDGE projection: lets a non-`crm` context resolve "does this
 * Person have an active relationship to this Organization, and of what
 * strength" without importing CRM's models — the "no module reads another
 * module's tables directly" rule applied to the relationship graph.
 */
export async function resolveEdge(
  personId: string,
  organizationId: string,
): Promise<{ active: boolean; strength: RelationshipStrength | null; relationshipTypes: string[] }> {
  const auth = currentAuth();
  const ids = await personIdChain(personId);
  const edges = await prisma.relationship.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'active',
      deletedAt: null,
      OR: [
        { fromType: 'person', fromId: { in: ids }, toType: 'organization', toId: organizationId },
        { fromType: 'organization', fromId: organizationId, toType: 'person', toId: { in: ids } },
      ],
    },
    select: { strength: true, relationshipType: true },
  });

  if (edges.length === 0) return { active: false, strength: null, relationshipTypes: [] };

  const rank: Record<string, number> = { weak: 0, moderate: 1, strong: 2 };
  const strongest = edges.reduce((a, b) => (rank[b.strength] > rank[a.strength] ? b : a));
  return {
    active: true,
    strength: strongest.strength as RelationshipStrength,
    relationshipTypes: [...new Set(edges.map((e) => e.relationshipType))],
  };
}

/** Numeric relationship-strength input to the routing engine's soft factor (0.0–1.0). */
export async function relationshipStrengthScore(candidatePartyId: string, organizationId: string | null): Promise<number> {
  if (!organizationId) return 0;
  const auth = currentAuth();

  const [edges, priorWins] = await Promise.all([
    prisma.relationship.findMany({
      where: {
        tenantId: auth.tenantId,
        status: 'active',
        ownerPartyId: candidatePartyId,
        OR: [
          { toType: 'organization', toId: organizationId },
          { fromType: 'organization', fromId: organizationId },
        ],
      },
      select: { strength: true },
    }),
    prisma.opportunity.count({
      where: { tenantId: auth.tenantId, organizationId, ownerPartyId: candidatePartyId, outcome: 'won' },
    }),
  ]);

  const strengthValue = edges.reduce((acc, e) => Math.max(acc, e.strength === 'strong' ? 1 : e.strength === 'moderate' ? 0.6 : 0.3), 0);
  const winBonus = Math.min(priorWins * 0.2, 0.4);
  return Math.min(strengthValue + winBonus, 1);
}
