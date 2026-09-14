/**
 * Technology — IT policy documents (docs/plan/cio.md, workstream F).
 *
 * A published body is immutable: nothing here ever writes `body`/`title` on
 * a `published` row. A change is `newVersionOf`, which opens a fresh `draft`
 * row at `version + 1` under the same `code`; publishing it marks the row it
 * supersedes `superseded`. Publication runs `evaluateApprovalGate` on
 * `POL-IT-POLICY-PUBLISH` with `ownerPartyId: drafterPartyId` — the
 * Self-Dealing Bar means the drafter never publishes their own draft
 * (IT-POL-001).
 */

import {
  EVENTS,
  IT_DOMAIN,
  policyMachine,
  POLICY_TRANSITION_VERBS,
  acknowledgementRate,
  type PolicyState,
  type PolicyEvent,
} from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { emit } from '../../../platform/eventBus.js';
import { availableTransitions } from '../../../platform/lifecycle.js';
import { evaluateApprovalGate } from '../../../platform/approvals.js';
import { nextRecordCode } from '../../../platform/recordCode.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';

registerGovernedEntities('it_governance', ['it_policy_document', 'it_policy_acknowledgement']);

const RESOURCE = 'it_policies';
const ACK_RESOURCE = 'it_policy_acknowledgements';

// ---------------------------------------------------------------------------
// Draft / read
// ---------------------------------------------------------------------------

export interface CreatePolicyInput {
  code: string;
  title: string;
  body: string;
  appliesToRoleSlugs?: string[];
  reacknowledgeMonths?: number | null;
}

export async function createPolicyDraft(input: CreatePolicyInput) {
  await assertCan({ resource: RESOURCE, verb: 'create' });
  const auth = currentAuth();

  const code = input.code?.trim();
  const title = input.title?.trim();
  const body = input.body?.trim();
  if (!code) throw ApiError.badRequest('A policy needs a code.');
  if (!title) throw ApiError.badRequest('A policy needs a title.');
  if (!body) throw ApiError.badRequest('A policy needs a body — the text staff will acknowledge.');

  const existing = await prisma.itPolicyDocument.findFirst({ where: { tenantId: auth.tenantId, code } });
  if (existing) {
    throw ApiError.conflict(`'${code}' already names a policy (${existing.recordCode}). Use new-version to revise it instead of a second draft under the same code.`);
  }

  const recordCode = await nextRecordCode('ITP');
  const policy = await prisma.itPolicyDocument.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      code,
      title,
      body,
      version: 1,
      status: 'draft',
      drafterPartyId: auth.partyId ?? 'system',
      appliesToRoleSlugs: input.appliesToRoleSlugs ?? [],
      reacknowledgeMonths: input.reacknowledgeMonths ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_policy_document', subjectId: policy.id, after: { recordCode, code, version: 1 } });
  return withTransitions(policy);
}

export interface UpdatePolicyDraftInput {
  title?: string;
  body?: string;
  appliesToRoleSlugs?: string[];
  reacknowledgeMonths?: number | null;
}

/** Edits a draft's text before it is published. A published row can never
 * reach this function's write path — the guard is explicit, not merely a
 * consequence of nobody calling it that way. */
export async function updatePolicyDraft(id: string, patch: UpdatePolicyDraftInput) {
  const auth = currentAuth();
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: policy.drafterPartyId } });
  if (policy.status !== 'draft') {
    throw ApiError.unprocessable(`${policy.recordCode} is ${policy.status}. A published policy is immutable — use new-version to revise it.`);
  }

  const updated = await prisma.itPolicyDocument.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.appliesToRoleSlugs !== undefined ? { appliesToRoleSlugs: patch.appliesToRoleSlugs } : {}),
      ...(patch.reacknowledgeMonths !== undefined ? { reacknowledgeMonths: patch.reacknowledgeMonths } : {}),
    },
  });
  await auditWrite({ action: 'update', subjectType: 'it_policy_document', subjectId: id, before: policy, after: updated });
  return withTransitions(updated);
}

export interface PolicyFilter {
  status?: string;
  code?: string;
}

export async function listPolicies(filter: PolicyFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.itPolicyDocument.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.code ? { code: filter.code } : {}),
    },
    orderBy: [{ code: 'asc' }, { version: 'desc' }],
  });
  return rows.map(withTransitions);
}

export async function policyDetail(id: string) {
  const auth = currentAuth();
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  await assertCan({ resource: RESOURCE, verb: 'view' });

  const myAck = auth.partyId
    ? await prisma.itPolicyAcknowledgement.findFirst({ where: { tenantId: auth.tenantId, policyId: id, partyId: auth.partyId, version: policy.version } })
    : null;

  return { ...withTransitions(policy), acknowledgedByMe: Boolean(myAck) };
}

function withTransitions<T extends { status: string }>(row: T): T & { availableTransitions: PolicyEvent[] } {
  return { ...row, availableTransitions: availableTransitions(policyMachine, row.status as PolicyState) };
}

// ---------------------------------------------------------------------------
// Publish / new version
// ---------------------------------------------------------------------------

const GATE_POLICY_CODE = 'POL-IT-POLICY-PUBLISH';

export async function publishPolicy(id: string) {
  const auth = currentAuth();
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  if (policy.status !== 'draft') {
    throw ApiError.unprocessable(`${policy.recordCode} is ${policy.status}; only a draft can be published.`);
  }
  if (!policyMachine.can('draft', 'PUBLISH')) throw ApiError.unprocessable('Publish is not a legal transition.');

  const gate = await evaluateApprovalGate(
    GATE_POLICY_CODE,
    {
      id,
      type: 'it_policy',
      label: `${policy.recordCode} — ${policy.title} v${policy.version}`,
      ownerPartyId: policy.drafterPartyId,
      commercialValue: null,
      currency: 'INR',
      strategicValue: null,
      termMonths: null,
      resource: 'it_policies',
    },
    'it_policy.publish',
  );

  if (!gate.permitted) {
    return { applied: false, policy: withTransitions(policy), approvalStepId: gate.approvalStepId, reason: gate.reason };
  }

  const now = new Date();
  if (policy.supersedesId) {
    await prisma.itPolicyDocument.update({ where: { id: policy.supersedesId }, data: { status: 'superseded' } });
  }
  const published = await prisma.itPolicyDocument.update({
    where: { id },
    data: { status: 'published', publishedAt: now, publishedById: auth.partyId },
  });

  await auditWrite({ action: 'update', subjectType: 'it_policy_document', subjectId: id, before: { status: 'draft' }, after: { status: 'published' } });
  await emit({
    name: EVENTS.IT_POLICY_PUBLISHED,
    subject: { entityType: 'it_policy_document', entityId: id, recordCode: policy.recordCode },
    previousState: { status: 'draft' },
    newState: { status: 'published', version: policy.version },
    owner: { partyId: policy.drafterPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return { applied: true, policy: withTransitions(published), approvalStepId: null, reason: gate.reason };
}

/** Opens a new draft at `version + 1` under the same code, so a change to a
 * published policy is a new row rather than an edit to the immutable one. */
export async function newVersionOf(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'create' });
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  if (policy.status !== 'published') {
    throw ApiError.unprocessable(`${policy.recordCode} is ${policy.status}. A new version is opened from a published policy.`);
  }

  const existingDraft = await prisma.itPolicyDocument.findFirst({ where: { tenantId: auth.tenantId, code: policy.code, status: 'draft' } });
  if (existingDraft) {
    throw ApiError.conflict(`${policy.code} already has an open draft (${existingDraft.recordCode}). Publish or retire it before opening another.`);
  }

  const recordCode = await nextRecordCode('ITP');
  const draft = await prisma.itPolicyDocument.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      code: policy.code,
      title: policy.title,
      body: policy.body,
      version: policy.version + 1,
      status: 'draft',
      drafterPartyId: auth.partyId ?? 'system',
      appliesToRoleSlugs: policy.appliesToRoleSlugs,
      reacknowledgeMonths: policy.reacknowledgeMonths,
      supersedesId: policy.id,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_policy_document', subjectId: draft.id, after: { recordCode, code: policy.code, version: draft.version, supersedesId: policy.id } });
  return withTransitions(draft);
}

export async function retirePolicy(id: string) {
  const auth = currentAuth();
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: policy.drafterPartyId } });

  if (!policyMachine.can(policy.status as PolicyState, 'RETIRE')) {
    throw ApiError.unprocessable(`${policy.recordCode} is ${policy.status}; retire is not one of its transitions.`);
  }
  const to = policyMachine.apply(policy.status as PolicyState, 'RETIRE');
  const updated = await prisma.itPolicyDocument.update({ where: { id }, data: { status: to } });
  await auditWrite({ action: 'update', subjectType: 'it_policy_document', subjectId: id, before: { status: policy.status }, after: { status: to }, meta: { transition: 'RETIRE' } });
  await emit({
    name: EVENTS.IT_POLICY_PUBLISHED,
    subject: { entityType: 'it_policy_document', entityId: id, recordCode: policy.recordCode },
    previousState: { status: policy.status },
    newState: { status: to },
    impact: { domains: [IT_DOMAIN] },
  });
  return withTransitions(updated);
}

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

export async function acknowledgePolicy(id: string) {
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.badRequest('No party to acknowledge as.');
  await assertCan({ resource: ACK_RESOURCE, verb: 'create', record: { ownerPartyId: auth.partyId } });

  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  if (policy.status !== 'published') {
    throw ApiError.unprocessable(`${policy.recordCode} is ${policy.status}. Only a published policy can be acknowledged.`);
  }

  const existing = await prisma.itPolicyAcknowledgement.findFirst({
    where: { tenantId: auth.tenantId, policyId: id, partyId: auth.partyId, version: policy.version },
  });
  if (existing) return existing;

  const ack = await prisma.itPolicyAcknowledgement.create({
    data: { tenantId: auth.tenantId, policyId: id, version: policy.version, partyId: auth.partyId },
  });

  await auditWrite({ action: 'create', subjectType: 'it_policy_acknowledgement', subjectId: ack.id, after: { policyId: id, version: policy.version, partyId: auth.partyId } });
  await emit({
    name: EVENTS.IT_POLICY_ACKNOWLEDGED,
    subject: { entityType: 'it_policy_acknowledgement', entityId: ack.id },
    related: [{ relation: 'acknowledges', entityType: 'it_policy_document', entityId: id }],
    newState: { partyId: auth.partyId, version: policy.version },
    impact: { domains: [IT_DOMAIN] },
  });

  return ack;
}

/** Published policies the caller has not yet acknowledged at the current
 * version — the My IT page (another workstream) calls this. */
export async function policiesAwaitingCaller() {
  const auth = currentAuth();
  await assertCan({ resource: RESOURCE, verb: 'view' });
  if (!auth.partyId) return [];

  const published = await prisma.itPolicyDocument.findMany({ where: { tenantId: auth.tenantId, status: 'published' } });
  if (!published.length) return [];

  const acks = await prisma.itPolicyAcknowledgement.findMany({
    where: { tenantId: auth.tenantId, partyId: auth.partyId, policyId: { in: published.map((p) => p.id) } },
  });
  const ackKey = new Set(acks.map((a) => `${a.policyId}:${a.version}`));

  return published.filter((p) => !ackKey.has(`${p.id}:${p.version}`) && appliesTo(p.appliesToRoleSlugs, auth.roleSlug));
}

function appliesTo(roleSlugs: string[], roleSlug: string | null): boolean {
  return roleSlugs.length === 0 || (roleSlug !== null && roleSlugs.includes(roleSlug));
}

/** Acknowledgement rows for a policy's current version — `it_policies:E`
 * holders only (the audit trail is confidential to those who run the desk). */
export async function acknowledgementsFor(id: string) {
  const auth = currentAuth();
  const policy = await prisma.itPolicyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Policy');
  await assertCan({ resource: RESOURCE, verb: 'edit' });

  return prisma.itPolicyAcknowledgement.findMany({
    where: { tenantId: auth.tenantId, policyId: id, version: policy.version },
    orderBy: { acknowledgedAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Re-acknowledgement due job support
// ---------------------------------------------------------------------------

export interface TargetAudience {
  policy: { id: string; code: string; title: string; version: number; publishedAt: Date | null; reacknowledgeMonths: number | null; recordCode: string | null };
  targetPartyIds: string[];
  acknowledgedPartyIds: string[];
}

/** The published policies and, for each, who is meant to acknowledge it
 * (every active affiliation, narrowed by `appliesToRoleSlugs` when set) and
 * who already has, at the current version. Read by both the summary and the
 * re-acknowledgement job so the two never compute the audience differently. */
export async function publishedPolicyAudiences(): Promise<TargetAudience[]> {
  const auth = currentAuth();
  const published = await prisma.itPolicyDocument.findMany({ where: { tenantId: auth.tenantId, status: 'published' } });
  if (!published.length) return [];

  const affiliations = await prisma.affiliation.findMany({ where: { tenantId: auth.tenantId, status: 'active' } });

  const out: TargetAudience[] = [];
  for (const p of published) {
    const targetPartyIds = [...new Set(affiliations.filter((a) => appliesTo(p.appliesToRoleSlugs, a.roleSlug)).map((a) => a.partyId))];
    const acks = await prisma.itPolicyAcknowledgement.findMany({ where: { tenantId: auth.tenantId, policyId: p.id, version: p.version } });
    out.push({
      policy: { id: p.id, code: p.code, title: p.title, version: p.version, publishedAt: p.publishedAt, reacknowledgeMonths: p.reacknowledgeMonths, recordCode: p.recordCode },
      targetPartyIds,
      acknowledgedPartyIds: [...new Set(acks.map((a) => a.partyId))],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function policiesSummary() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const total = await prisma.itPolicyDocument.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return { notYetMeasured: true, published: 0, drafts: 0, acknowledgementRate: null as number | null };
  }

  const [published, drafts] = await Promise.all([
    prisma.itPolicyDocument.count({ where: { tenantId: auth.tenantId, status: 'published' } }),
    prisma.itPolicyDocument.count({ where: { tenantId: auth.tenantId, status: 'draft' } }),
  ]);

  const audiences = await publishedPolicyAudiences();
  const totalTarget = audiences.reduce((sum, a) => sum + a.targetPartyIds.length, 0);
  const totalAcked = audiences.reduce((sum, a) => sum + a.targetPartyIds.filter((id) => a.acknowledgedPartyIds.includes(id)).length, 0);
  const rate = acknowledgementRate(totalAcked, totalTarget);

  return { notYetMeasured: false, published, drafts, acknowledgementRate: rate };
}
