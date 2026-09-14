/**
 * Audience & segmentation (MKT-AUD-001…). Canon: docs/plan/marketing-skeleton.md.
 *
 * An audience is either:
 *   - `dynamic`  — a rule tree evaluated against one of CRM's own entities
 *                  (person/student/organization/institution/lead); membership
 *                  is materialised into `MarketingAudienceMember` rows on
 *                  `evaluateAudience`, never recomputed silently at send time.
 *   - `static`   — a hand-picked list, added/removed one member at a time.
 *   - `suppression` — a list excluded from every send, regardless of channel
 *                  or consent state. `suppressedPersonIds()` is the single
 *                  gate messaging must intersect against.
 *
 * Marketing never owns Person/Student/Organization/Lead — this module only
 * reads them to decide membership.
 */

import {
  AUDIENCE_ENTITY_TYPES,
  AUDIENCE_KINDS,
  AUDIENCE_RULE_OPS,
  EVENTS,
  type AudienceCondition,
  type AudienceEntityType,
  type AudienceKind,
  type AudienceRule,
  type AudienceRuleOp,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';

registerGovernedEntities('mkt', ['audience', 'audience_member']);

// ---------------------------------------------------------------------------
// Rule-builder vocabulary
// ---------------------------------------------------------------------------

interface FieldDef {
  field: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'array';
  ops: AudienceRuleOp[];
  /** Prisma column path this field reads from, dot-separated for relations. */
  path: string;
}

const STRING_OPS: AudienceRuleOp[] = ['eq', 'ne', 'in', 'contains', 'is_null', 'not_null'];
const NUMBER_OPS: AudienceRuleOp[] = ['eq', 'ne', 'gt', 'lt', 'between', 'is_null', 'not_null'];
const DATE_OPS: AudienceRuleOp[] = ['before', 'after', 'between', 'is_null', 'not_null'];
const ARRAY_OPS: AudienceRuleOp[] = ['contains', 'is_null', 'not_null'];

const FIELD_VOCABULARY: Record<AudienceEntityType, FieldDef[]> = {
  person: [
    { field: 'fullName', label: 'Full name', type: 'string', ops: STRING_OPS, path: 'fullName' },
    { field: 'primaryEmail', label: 'Primary email', type: 'string', ops: STRING_OPS, path: 'primaryEmail' },
    { field: 'primaryPhone', label: 'Primary phone', type: 'string', ops: STRING_OPS, path: 'primaryPhone' },
    { field: 'source', label: 'Source', type: 'string', ops: STRING_OPS, path: 'source' },
    { field: 'createdAt', label: 'Created at', type: 'date', ops: DATE_OPS, path: 'createdAt' },
  ],
  student: [
    { field: 'funding', label: 'Funding', type: 'string', ops: STRING_OPS, path: 'funding' },
    { field: 'fundingFramework', label: 'Funding framework', type: 'string', ops: STRING_OPS, path: 'fundingFramework' },
    { field: 'status', label: 'Student status', type: 'string', ops: STRING_OPS, path: 'status' },
    { field: 'institutionId', label: 'Institution', type: 'string', ops: STRING_OPS, path: 'institutionId' },
    { field: 'createdAt', label: 'Created at', type: 'date', ops: DATE_OPS, path: 'createdAt' },
    { field: 'courseId', label: 'Enrolled course', type: 'string', ops: STRING_OPS, path: '$enrollment.cohort.courseId' },
    { field: 'cohortId', label: 'Enrolled cohort', type: 'string', ops: STRING_OPS, path: '$enrollment.cohortId' },
    { field: 'enrollmentStatus', label: 'Enrolment status', type: 'string', ops: STRING_OPS, path: '$enrollment.status' },
  ],
  organization: [
    { field: 'kind', label: 'Kind', type: 'string', ops: STRING_OPS, path: 'kind' },
    { field: 'name', label: 'Name', type: 'string', ops: STRING_OPS, path: 'name' },
    { field: 'roles', label: 'Roles', type: 'array', ops: ARRAY_OPS, path: 'roles' },
    { field: 'createdAt', label: 'Created at', type: 'date', ops: DATE_OPS, path: 'createdAt' },
  ],
  institution: [
    { field: 'name', label: 'Name', type: 'string', ops: STRING_OPS, path: 'name' },
    { field: 'district', label: 'District', type: 'string', ops: STRING_OPS, path: '$institutionProfile.district' },
    { field: 'state', label: 'State', type: 'string', ops: STRING_OPS, path: '$institutionProfile.state' },
    { field: 'institutionType', label: 'Institution type', type: 'string', ops: STRING_OPS, path: '$institutionProfile.institutionType' },
    { field: 'createdAt', label: 'Created at', type: 'date', ops: DATE_OPS, path: 'createdAt' },
  ],
  lead: [
    { field: 'vertical', label: 'Vertical', type: 'string', ops: STRING_OPS, path: 'vertical' },
    { field: 'stageKey', label: 'Stage', type: 'string', ops: STRING_OPS, path: 'stageKey' },
    { field: 'leadStatus', label: 'Lead status', type: 'string', ops: STRING_OPS, path: 'leadStatus' },
    { field: 'source', label: 'Source', type: 'string', ops: STRING_OPS, path: 'source' },
    { field: 'score', label: 'Score', type: 'number', ops: NUMBER_OPS, path: 'score' },
    { field: 'campaignId', label: 'Campaign', type: 'string', ops: STRING_OPS, path: 'campaignId' },
    { field: 'createdAt', label: 'Created at', type: 'date', ops: DATE_OPS, path: 'createdAt' },
  ],
};

export function audienceFields(entityType: AudienceEntityType): Array<{ field: string; label: string; type: string; ops: string[] }> {
  const defs = FIELD_VOCABULARY[entityType];
  if (!defs) throw ApiError.badRequest(`Unknown audience entity type '${entityType}'.`);
  return defs.map((d) => ({ field: d.field, label: d.label, type: d.type, ops: d.ops }));
}

function fieldDef(entityType: AudienceEntityType, field: string): FieldDef {
  const def = FIELD_VOCABULARY[entityType]?.find((d) => d.field === field);
  if (!def) throw ApiError.badRequest(`'${field}' is not a rule field on entity type '${entityType}'.`);
  return def;
}

/** Builds one Prisma leaf condition (or a nested-relation `some` condition for `$relation.path` fields). */
function conditionToWhere(entityType: AudienceEntityType, cond: AudienceCondition): Record<string, unknown> {
  const def = fieldDef(entityType, cond.field);
  const leaf = opToWhere(cond.op, cond.value);

  if (def.path.startsWith('$')) {
    // `$relationName.column` — one level of relation nesting, `some` for
    // to-many relations. Used for student.enrollment.* and institution.*.
    const [relation, ...rest] = def.path.slice(1).split('.');
    const column = rest.join('.');
    if (relation === 'enrollment') {
      if (column === 'status') return { enrollments: { some: { status: leaf } } };
      if (column === 'cohortId') return { enrollments: { some: { cohortId: leaf } } };
      if (column === 'cohort.courseId') return { enrollments: { some: { cohort: { courseId: leaf } } } };
      throw ApiError.badRequest(`Unsupported student rule field path '${def.path}'.`);
    }
    if (relation === 'institutionProfile') {
      return { institutionProfile: { [column]: leaf } };
    }
    throw ApiError.badRequest(`Unsupported rule field path '${def.path}'.`);
  }

  return { [def.path]: leaf };
}

function opToWhere(op: AudienceRuleOp, value: unknown): unknown {
  switch (op) {
    case 'eq':
      return value;
    case 'ne':
      return { not: value };
    case 'in':
      return { in: Array.isArray(value) ? value : [value] };
    case 'contains':
      return Array.isArray(value) || typeof value !== 'string' ? { has: value } : { contains: value, mode: 'insensitive' };
    case 'gt':
      return { gt: value };
    case 'lt':
      return { lt: value };
    case 'between': {
      const [lo, hi] = value as [unknown, unknown];
      return { gte: lo, lte: hi };
    }
    case 'is_null':
      return null;
    case 'not_null':
      return { not: null };
    case 'before':
      return { lt: new Date(value as string) };
    case 'after':
      return { gt: new Date(value as string) };
    default:
      throw ApiError.badRequest(`Unsupported rule operator '${op as string}'.`);
  }
}

/**
 * Translates an `AudienceRule` tree into the Prisma `where` clause for the
 * given entity type. An empty/absent rule tree matches everything of that
 * type — the "all of them" audience is a legitimate one.
 */
export function evaluateRules(entityType: AudienceEntityType, rules: AudienceRule | null | undefined): Record<string, unknown> {
  if (!rules || (!rules.all?.length && !rules.any?.length)) return {};
  const clauses: Record<string, unknown>[] = [];
  if (rules.all?.length) clauses.push({ AND: rules.all.map((c) => conditionToWhere(entityType, c)) });
  if (rules.any?.length) clauses.push({ OR: rules.any.map((c) => conditionToWhere(entityType, c)) });
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

// ---------------------------------------------------------------------------
// Entity resolution — matching rows for an entity type, tenant-scoped
// ---------------------------------------------------------------------------

async function matchingEntityIds(entityType: AudienceEntityType, rules: AudienceRule | null | undefined): Promise<string[]> {
  const auth = currentAuth();
  const where = evaluateRules(entityType, rules);

  if (entityType === 'person') {
    const rows = await prisma.person.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...where }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (entityType === 'student') {
    const rows = await prisma.studentProfile.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...where }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (entityType === 'organization') {
    const rows = await prisma.organization.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, kind: 'organization', ...where }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (entityType === 'institution') {
    const rows = await prisma.organization.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, kind: 'institution', ...where }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (entityType === 'lead') {
    const rows = await prisma.lead.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...where }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  throw ApiError.badRequest(`Unknown audience entity type '${entityType}'.`);
}

/** Best-effort human label for a matched entity, for preview samples. */
async function labelFor(entityType: AudienceEntityType, entityId: string): Promise<string> {
  const auth = currentAuth();
  if (entityType === 'person') {
    const p = await prisma.person.findFirst({ where: { id: entityId, tenantId: auth.tenantId }, select: { fullName: true } });
    return p?.fullName ?? entityId;
  }
  if (entityType === 'student') {
    const s = await prisma.studentProfile.findFirst({
      where: { id: entityId, tenantId: auth.tenantId },
      select: { person: { select: { fullName: true } } },
    });
    return s?.person.fullName ?? entityId;
  }
  if (entityType === 'organization' || entityType === 'institution') {
    const o = await prisma.organization.findFirst({ where: { id: entityId, tenantId: auth.tenantId }, select: { name: true } });
    return o?.name ?? entityId;
  }
  if (entityType === 'lead') {
    const l = await prisma.lead.findFirst({ where: { id: entityId, tenantId: auth.tenantId }, select: { title: true } });
    return l?.title ?? entityId;
  }
  return entityId;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface AudienceInput {
  name: string;
  kind: AudienceKind;
  entityType: AudienceEntityType;
  rules?: AudienceRule | null;
  description?: string | null;
}

function assertValidKindAndEntity(kind: string, entityType: string): void {
  if (!AUDIENCE_KINDS.includes(kind as AudienceKind)) throw ApiError.badRequest(`Unknown audience kind '${kind}'.`);
  if (!AUDIENCE_ENTITY_TYPES.includes(entityType as AudienceEntityType)) throw ApiError.badRequest(`Unknown audience entity type '${entityType}'.`);
}

export async function createAudience(input: AudienceInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'create' });
  assertValidKindAndEntity(input.kind, input.entityType);
  if (!input.name.trim()) throw ApiError.badRequest('An audience needs a name.');

  const recordCode = await nextRecordCode('AUD');
  const audience = await prisma.marketingAudience.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      kind: input.kind,
      entityType: input.entityType,
      rules: (input.rules ?? {}) as never,
      description: input.description ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'audience', subjectId: audience.id, after: { name: audience.name, kind: audience.kind } });
  await emit({
    name: EVENTS.MKT_AUDIENCE_CREATED,
    subject: { entityType: 'audience', entityId: audience.id, recordCode },
    newState: { kind: audience.kind, entityType: audience.entityType },
    impact: { domains: ['mkt'] },
  });

  return audience;
}

export async function listAudiences(filter: { kind?: string; entityType?: string; q?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'view' });
  return prisma.marketingAudience.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' as const } }, { recordCode: { contains: filter.q, mode: 'insensitive' as const } }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function getAudienceOr404(id: string) {
  const auth = currentAuth();
  const audience = await prisma.marketingAudience.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!audience) throw ApiError.notFound('Audience');
  return audience;
}

export async function loadAudience(id: string) {
  await assertCan({ resource: 'audiences', verb: 'view' });
  const audience = await getAudienceOr404(id);
  const members = await prisma.marketingAudienceMember.findMany({
    where: { audienceId: audience.id, deletedAt: null },
    orderBy: { addedAt: 'desc' },
    take: 50,
  });
  return { ...audience, members };
}

export async function updateAudience(id: string, patch: Partial<AudienceInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'edit' });
  const audience = await getAudienceOr404(id);
  if (patch.kind || patch.entityType) assertValidKindAndEntity(patch.kind ?? audience.kind, patch.entityType ?? audience.entityType);

  const updated = await prisma.marketingAudience.update({
    where: { id },
    data: {
      name: patch.name ?? undefined,
      description: patch.description === undefined ? undefined : patch.description,
      rules: patch.rules === undefined ? undefined : (patch.rules as never),
      updatedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'update', subjectType: 'audience', subjectId: id, before: { name: audience.name }, after: { name: updated.name } });

  // Rule changes on a dynamic audience only take effect on the next explicit
  // evaluate() call — membership is never silently recomputed on save.
  return updated;
}

export async function deleteAudience(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'delete' });
  const audience = await getAudienceOr404(id);
  await prisma.marketingAudience.update({ where: { id }, data: { deletedAt: new Date(), updatedById: auth.partyId } });
  await auditWrite({ action: 'delete', subjectType: 'audience', subjectId: id, after: { name: audience.name } });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Evaluation & membership
// ---------------------------------------------------------------------------

/**
 * Preview: count and a small sample, without writing anything. Used by both
 * the audience builder (before save) and `POST /audiences/preview`.
 */
export async function previewAudience(entityType: AudienceEntityType, rules: AudienceRule | null | undefined) {
  await assertCan({ resource: 'audiences', verb: 'view' });
  assertValidKindAndEntity('dynamic', entityType);
  const ids = await matchingEntityIds(entityType, rules);
  const sampleIds = ids.slice(0, 10);
  const sample = await Promise.all(sampleIds.map(async (entityId) => ({ entityId, label: await labelFor(entityType, entityId) })));
  return { count: ids.length, sample };
}

/**
 * Dynamic: replaces rule-sourced (`source: 'rule'`) members with the current
 * match set, leaving manually-added members untouched. Static: a no-op —
 * membership only changes through add/remove. Either way, `memberCount` and
 * `lastEvaluatedAt` are refreshed and an event is emitted.
 */
export async function evaluateAudience(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'edit' });
  const audience = await getAudienceOr404(id);

  let addedCount = 0;
  let removedCount = 0;

  if (audience.kind === 'dynamic') {
    const entityType = audience.entityType as AudienceEntityType;
    const matched = new Set(await matchingEntityIds(entityType, audience.rules as AudienceRule | null));

    const existingRuleMembers = await prisma.marketingAudienceMember.findMany({
      where: { audienceId: id, source: 'rule', deletedAt: null },
    });
    const existingIds = new Set(existingRuleMembers.map((m) => m.entityId));

    const toAdd = [...matched].filter((eid) => !existingIds.has(eid));
    const toRemove = existingRuleMembers.filter((m) => !matched.has(m.entityId));

    for (const entityId of toAdd) {
      const recordCode = await nextRecordCode('AUD');
      await prisma.marketingAudienceMember.create({
        data: { tenantId: auth.tenantId, recordCode, audienceId: id, entityType, entityId, source: 'rule', createdById: auth.partyId },
      });
    }
    if (toRemove.length) {
      await prisma.marketingAudienceMember.updateMany({
        where: { id: { in: toRemove.map((m) => m.id) } },
        data: { deletedAt: new Date() },
      });
    }
    addedCount = toAdd.length;
    removedCount = toRemove.length;
  }

  const memberCount = await prisma.marketingAudienceMember.count({ where: { audienceId: id, deletedAt: null } });
  const evaluatedAt = new Date();
  await prisma.marketingAudience.update({ where: { id }, data: { memberCount, lastEvaluatedAt: evaluatedAt } });

  await emit({
    name: EVENTS.MKT_AUDIENCE_EVALUATED,
    subject: { entityType: 'audience', entityId: id, recordCode: audience.recordCode },
    newState: { memberCount, addedCount, removedCount },
    impact: { domains: ['mkt'] },
  });

  return { memberCount, addedCount, removedCount, evaluatedAt };
}

/** Static/suppression only — adds one member by hand. */
export async function addAudienceMember(audienceId: string, entityType: AudienceEntityType, entityId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'edit' });
  const audience = await getAudienceOr404(audienceId);

  const existing = await prisma.marketingAudienceMember.findFirst({ where: { audienceId, entityType, entityId, deletedAt: null } });
  if (existing) throw ApiError.conflict('This entity is already a member of the audience.');

  const recordCode = await nextRecordCode('AUD');
  const member = await prisma.marketingAudienceMember.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      audienceId,
      entityType,
      entityId,
      source: 'manual',
      suppressed: audience.kind === 'suppression',
      createdById: auth.partyId,
    },
  });

  const memberCount = await prisma.marketingAudienceMember.count({ where: { audienceId, deletedAt: null } });
  await prisma.marketingAudience.update({ where: { id: audienceId }, data: { memberCount } });

  await emit({
    name: EVENTS.MKT_AUDIENCE_MEMBER_ADDED,
    subject: { entityType: 'audience', entityId: audienceId, recordCode: audience.recordCode },
    related: [{ relation: 'member', entityType, entityId }],
    impact: { domains: ['mkt'] },
  });

  return member;
}

export async function removeAudienceMember(audienceId: string, memberId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'edit' });
  const audience = await getAudienceOr404(audienceId);
  const member = await prisma.marketingAudienceMember.findFirst({ where: { id: memberId, audienceId, deletedAt: null } });
  if (!member) throw ApiError.notFound('Audience member');

  await prisma.marketingAudienceMember.update({ where: { id: memberId }, data: { deletedAt: new Date(), updatedById: auth.partyId } });
  const memberCount = await prisma.marketingAudienceMember.count({ where: { audienceId, deletedAt: null } });
  await prisma.marketingAudience.update({ where: { id: audienceId }, data: { memberCount } });
  return { id: memberId, removed: true };
}

/** Marks a member suppressed without removing it — a record of "we chose not to reach this person," not a deletion. */
export async function suppressMember(audienceId: string, memberId: string, reason?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'audiences', verb: 'edit' });
  const audience = await getAudienceOr404(audienceId);
  const member = await prisma.marketingAudienceMember.findFirst({ where: { id: memberId, audienceId, deletedAt: null } });
  if (!member) throw ApiError.notFound('Audience member');

  const updated = await prisma.marketingAudienceMember.update({ where: { id: memberId }, data: { suppressed: true, updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_AUDIENCE_MEMBER_SUPPRESSED,
    subject: { entityType: 'audience', entityId: audienceId, recordCode: audience.recordCode },
    related: [{ relation: 'member', entityType: member.entityType, entityId: member.entityId }],
    reason: reason ? { reasonCode: 'manual_suppression', note: reason } : null,
    impact: { domains: ['mkt'] },
  });
  return updated;
}

export async function listAudienceMembers(audienceId: string, opts: { page?: number; pageSize?: number; suppressed?: boolean } = {}) {
  await assertCan({ resource: 'audiences', verb: 'view' });
  await getAudienceOr404(audienceId);
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);

  const where = {
    audienceId,
    deletedAt: null,
    ...(opts.suppressed === undefined ? {} : { suppressed: opts.suppressed }),
  };
  const [items, total] = await Promise.all([
    prisma.marketingAudienceMember.findMany({ where, orderBy: { addedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.marketingAudienceMember.count({ where }),
  ]);
  return { items, total };
}

// ---------------------------------------------------------------------------
// Resolution helpers for messaging — every send/journey must intersect
// against these before dispatching.
// ---------------------------------------------------------------------------

/** Resolves any audience's members down to Person ids — the unit every send actually addresses. */
export async function audiencePersonIds(id: string): Promise<string[]> {
  const auth = currentAuth();
  const audience = await getAudienceOr404(id);
  const members = await prisma.marketingAudienceMember.findMany({
    where: { audienceId: id, deletedAt: null, suppressed: false },
  });

  const personIds = new Set<string>();
  const studentIds = members.filter((m) => m.entityType === 'student').map((m) => m.entityId);
  const orgIds = members.filter((m) => m.entityType === 'organization' || m.entityType === 'institution').map((m) => m.entityId);

  for (const m of members) {
    if (m.entityType === 'person') personIds.add(m.entityId);
  }
  const leadIds = members.filter((m) => m.entityType === 'lead').map((m) => m.entityId);
  if (leadIds.length) {
    const leads = await prisma.lead.findMany({ where: { id: { in: leadIds }, tenantId: auth.tenantId }, select: { personId: true } });
    for (const l of leads) if (l.personId) personIds.add(l.personId);
  }
  if (studentIds.length) {
    const students = await prisma.studentProfile.findMany({ where: { id: { in: studentIds }, tenantId: auth.tenantId }, select: { personId: true } });
    for (const s of students) personIds.add(s.personId);
  }
  if (orgIds.length) {
    // Primary contact persons via Affiliation, where resolvable — an
    // organization with no primary contact affiliation on file simply
    // contributes no persons, rather than raising an error.
    const affiliations = await prisma.affiliation.findMany({
      where: { tenantId: auth.tenantId, counterpartyId: { in: orgIds }, status: 'active', primaryFlag: true },
      select: { partyId: true },
    });
    for (const a of affiliations) personIds.add(a.partyId);
  }

  return [...personIds];
}

/** Every person suppressed anywhere — the set messaging must exclude from every send, regardless of channel. */
export async function suppressedPersonIds(): Promise<Set<string>> {
  const auth = currentAuth();
  const suppressionAudiences = await prisma.marketingAudience.findMany({
    where: { tenantId: auth.tenantId, kind: 'suppression', deletedAt: null },
    select: { id: true },
  });

  const suppressed = new Set<string>();
  for (const a of suppressionAudiences) {
    for (const personId of await audiencePersonIds(a.id)) suppressed.add(personId);
  }
  // A member marked `suppressed: true` on any (non-suppression) audience is
  // also excluded — the per-member suppression flag is the same fact stated
  // at row granularity instead of list granularity.
  const suppressedMembers = await prisma.marketingAudienceMember.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, suppressed: true },
  });
  for (const m of suppressedMembers) {
    if (m.entityType === 'person') suppressed.add(m.entityId);
  }
  return suppressed;
}

export { AUDIENCE_ENTITY_TYPES, AUDIENCE_KINDS, AUDIENCE_RULE_OPS };
