/**
 * HCM — workflow (docs/hcm/workflow.md). Mounted at /api/hcm/workflow.
 *
 * The generic HR request & approval engine other workstreams reach by id
 * only: `submitRequest` opens an HrRequest against its type's approval chain,
 * `decide` walks one level at a time, and `listInbox` answers "what is
 * pending for me" across every request type at once.
 *
 * A `manager` level resolves through WS1's `ReportingLine` table when it is
 * present, and through the `hr_ops_manager` role otherwise. It is looked up
 * by raw table name rather than through a generated Prisma model — WS1 owns
 * that table's shape, and this file must keep working (falling back
 * gracefully) whether or not that migration has landed yet. See
 * docs/hcm/workflow.md, "Wanted from the scaffold".
 */

import {
  EVENTS,
  isValidApprovalChain,
  resolveDelegate,
  stepForLevel,
  tripsSelfDealingBar,
  validateApprovalChain,
  type ApprovalChain,
  type ApprovalResolverKind,
  type DelegationFact,
} from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';

registerGovernedEntities('hcm_workflow', ['hr_request_type', 'hr_request', 'authority_delegation']);

// ---------------------------------------------------------------------------
// Manager resolution — ReportingLine (WS1) if present, else the hr_ops_manager role.
// ---------------------------------------------------------------------------

let reportingLineTableChecked = false;
let reportingLineTableExists = false;

/**
 * Whether `hcm_workforce_reporting_lines` (WS1's `ReportingLine` table) is
 * present in this database. Cached for the process lifetime — a table either
 * exists after migration or it doesn't, and re-checking every call would be
 * one extra round trip per resolution for no benefit.
 */
async function reportingLineTablePresent(): Promise<boolean> {
  if (reportingLineTableChecked) return reportingLineTableExists;
  try {
    const rows = await unscopedPrisma.$queryRaw<Array<{ present: string | null }>>`
      SELECT to_regclass('public.hcm_workforce_reporting_lines')::text AS present
    `;
    reportingLineTableExists = Boolean(rows[0]?.present);
  } catch {
    reportingLineTableExists = false;
  }
  reportingLineTableChecked = true;
  return reportingLineTableExists;
}

/** Test-only: forces the next `reportingLineTablePresent()` call to re-check. */
export function _resetReportingLineTableCache(): void {
  reportingLineTableChecked = false;
}

/** The active primary manager's employment id for `employmentId`, via the raw ReportingLine table — null if the table is absent or no line is open. */
async function managerEmploymentIdViaReportingLine(tenantId: string, employmentId: string): Promise<string | null> {
  if (!(await reportingLineTablePresent())) return null;
  try {
    const rows = await unscopedPrisma.$queryRaw<Array<{ managerEmploymentRelationshipId: string }>>`
      SELECT "managerEmploymentRelationshipId"
      FROM hcm_workforce_reporting_lines
      WHERE "tenantId" = ${tenantId}
        AND "employmentRelationshipId" = ${employmentId}
        AND kind = 'primary'
        AND "effectiveTo" IS NULL
      ORDER BY "effectiveFrom" DESC
      LIMIT 1
    `;
    return rows[0]?.managerEmploymentRelationshipId ?? null;
  } catch {
    // The table exists but the query failed (shape drift mid-build across
    // workstreams) — fall back rather than fail the request.
    return null;
  }
}

async function partyIdForEmployment(tenantId: string, employmentId: string): Promise<string | null> {
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentId, tenantId },
    select: { personId: true },
  });
  return employment?.personId ?? null;
}

/** The active affiliate holding `roleSlug`, excluding `excludePartyId`. */
async function partyIdForRole(tenantId: string, roleSlug: string, excludePartyId: string | null): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: {
      tenantId,
      roleSlug,
      status: 'active',
      ...(excludePartyId ? { partyId: { not: excludePartyId } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  return affiliation?.partyId ?? null;
}

async function activeDelegations(tenantId: string): Promise<DelegationFact[]> {
  const rows = await prisma.delegationOfAuthority.findMany({
    where: { tenantId, revokedAt: null },
  });
  return rows.map((r) => ({
    fromPartyId: r.fromPartyId,
    toPartyId: r.toPartyId,
    fromDate: r.fromDate,
    toDate: r.toDate,
    scope: r.scope,
  }));
}

interface ResolutionResult {
  partyId: string | null;
  via: ApprovalResolverKind | 'reporting_line_absent';
}

/**
 * Resolves one chain step to a party id, excluding the requester and the
 * request's subject (the Self-Dealing Bar acts here as well as at decide
 * time, so a request never even opens against an approver it would refuse).
 * Delegation is applied last, on top of whichever resolver found a candidate.
 */
async function resolveStepApprover(
  step: { resolver: ApprovalResolverKind; partyId?: string },
  ctx: { tenantId: string; subjectEmploymentId: string; requestedById: string; subjectPartyId: string | null },
  delegations: DelegationFact[],
): Promise<ResolutionResult> {
  const exclude = (candidate: string | null): string | null => {
    if (!candidate) return null;
    if (candidate === ctx.requestedById) return null;
    if (ctx.subjectPartyId && candidate === ctx.subjectPartyId) return null;
    return candidate;
  };

  let raw: string | null = null;
  let via: ResolutionResult['via'] = step.resolver;

  if (step.resolver === 'specific') {
    raw = exclude(step.partyId ?? null);
  } else if (step.resolver === 'manager') {
    const managerEmploymentId = await managerEmploymentIdViaReportingLine(ctx.tenantId, ctx.subjectEmploymentId);
    if (managerEmploymentId) {
      raw = exclude(await partyIdForEmployment(ctx.tenantId, managerEmploymentId));
      via = 'manager';
    }
    if (!raw) {
      // No ReportingLine table, no open primary line, or the line resolved
      // to the requester/subject themselves — the hr grant holder decides.
      raw = exclude(await partyIdForRole(ctx.tenantId, 'hr_ops_manager', null));
      via = 'reporting_line_absent';
    }
  } else if (step.resolver === 'hr_grant') {
    raw = exclude(await partyIdForRole(ctx.tenantId, 'hr_ops_manager', null));
  } else if (step.resolver === 'finance_grant') {
    raw = exclude(await partyIdForRole(ctx.tenantId, 'finance_head', null));
  }

  if (!raw) return { partyId: null, via };

  const delegated = resolveDelegate(raw, step.resolver, delegations);
  return { partyId: exclude(delegated) ?? raw, via };
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export async function listRequestTypes(activeOnly = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_request_types', verb: 'view' });
  return prisma.hrRequestType.findMany({
    where: { tenantId: auth.tenantId, ...(activeOnly ? { active: true } : {}) },
    orderBy: { name: 'asc' },
  });
}

export async function createRequestType(input: { code: string; name: string; approvalChain: ApprovalChain; slaHours?: number }) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_request_types', verb: 'create' });

  const problems = validateApprovalChain(input.approvalChain);
  if (problems.length > 0) {
    throw ApiError.badRequest(`Invalid approval chain: ${problems.join(' ')}`);
  }

  const row = await prisma.hrRequestType.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      name: input.name,
      approvalChain: input.approvalChain as never,
      slaHours: input.slaHours ?? 48,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'hr_request_type', subjectId: row.id, after: row as never });
  return row;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface HrRequestWithApprovals {
  id: string;
  recordCode: string;
  typeId: string;
  subjectEmploymentId: string;
  payload: unknown;
  status: string;
  currentLevel: number;
  requestedById: string;
  createdAt: Date;
  closedAt: Date | null;
  approvals: Array<{ level: number; approverPartyId: string | null; decision: string; note: string | null; decidedAt: Date | null }>;
}

async function openLevel(
  tenantId: string,
  requestId: string,
  chain: ApprovalChain,
  level: number,
  ctx: { subjectEmploymentId: string; requestedById: string; subjectPartyId: string | null },
  delegations: DelegationFact[],
): Promise<{ approverPartyId: string | null }> {
  const step = stepForLevel(chain, level);
  if (!step) throw ApiError.badRequest(`Approval chain has no step for level ${level}.`);

  const resolved = await resolveStepApprover(step, { tenantId, ...ctx }, delegations);

  await prisma.hrRequestApproval.create({
    data: {
      tenantId,
      requestId,
      level,
      approverPartyId: resolved.partyId,
      decision: 'pending',
    },
  });

  if (!resolved.partyId) {
    await raiseException({
      code: 'EX-HCM-WF-001',
      label: 'No approver could be resolved for an HR request level',
      severity: 'S3_HIGH_RISK',
      subjectType: 'hr_request',
      subjectId: requestId,
      domain: 'hcm',
      detail: `Level ${level} (resolver: ${step.resolver}) resolved to nobody — check the chain configuration and active affiliations.`,
      reasonCode: 'approver_unresolved',
    });
  }

  return { partyId: resolved.partyId } as never;
}

/** Submits a new HR request, opening its first chain level. */
export async function submitRequest(input: { typeId: string; subjectEmploymentId: string; payload: unknown }) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_requests', verb: 'create' });

  const type = await prisma.hrRequestType.findFirst({ where: { id: input.typeId, tenantId: auth.tenantId } });
  if (!type) throw ApiError.notFound('HR request type');
  if (!type.active) throw ApiError.badRequest(`"${type.name}" is no longer accepting new requests.`);

  const chain = type.approvalChain as unknown;
  if (!isValidApprovalChain(chain)) {
    throw ApiError.unprocessable(`Request type "${type.name}" carries an invalid approval chain and cannot be submitted against.`);
  }

  const subjectPartyId = await partyIdForEmployment(auth.tenantId, input.subjectEmploymentId);
  if (!subjectPartyId) throw ApiError.notFound('Subject employment relationship');

  const requestedById = auth.partyId ?? 'system';
  const recordCode = await nextRecordCode('HRQ');

  const request = await prisma.hrRequest.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      typeId: type.id,
      subjectEmploymentId: input.subjectEmploymentId,
      payload: input.payload as never,
      status: 'submitted',
      currentLevel: 1,
      requestedById,
    },
  });

  const delegations = await activeDelegations(auth.tenantId);
  await openLevel(
    auth.tenantId,
    request.id,
    chain,
    1,
    { subjectEmploymentId: input.subjectEmploymentId, requestedById, subjectPartyId },
    delegations,
  );

  await emit({
    name: EVENTS.HR_REQUEST_SUBMITTED,
    subject: { entityType: 'hr_request', entityId: request.id, recordCode },
    newState: { typeCode: type.code, level: 1, status: 'submitted' },
    impact: { domains: ['hcm'], severity: 'S1_ATTENTION' },
  });
  await auditWrite({ action: 'create', subjectType: 'hr_request', subjectId: request.id, after: request as never });

  return getRequest(request.id);
}

export async function getRequest(id: string): Promise<HrRequestWithApprovals> {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_requests', verb: 'view' });
  const request = await prisma.hrRequest.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { approvals: { orderBy: { level: 'asc' } } },
  });
  if (!request) throw ApiError.notFound('HR request');
  // Employee-scope callers may only see their own or their subject's requests.
  const scope = await scopeFor('hr_requests', 'view');
  if (scope !== 'all') {
    const subjectPartyId = await partyIdForEmployment(auth.tenantId, request.subjectEmploymentId);
    if (request.requestedById !== auth.partyId && subjectPartyId !== auth.partyId) {
      throw ApiError.notFound('HR request');
    }
  }
  return request as never;
}

export async function listMyRequests() {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_requests', verb: 'view' });
  return prisma.hrRequest.findMany({
    where: { tenantId: auth.tenantId, requestedById: auth.partyId ?? '__none__' },
    include: { approvals: { orderBy: { level: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Everything with a `pending` approval row resolved to `forParty` — the
 * reusable inbox `RequestInbox.tsx` renders, and what backs `/people/approvals`.
 */
export async function listInbox(forParty?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_requests', verb: 'approve' });
  const partyId = forParty ?? auth.partyId;
  if (!partyId) return [];

  const pending = await prisma.hrRequestApproval.findMany({
    where: { tenantId: auth.tenantId, approverPartyId: partyId, decision: 'pending' },
    include: { request: { include: { type: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return pending
    .filter((p) => p.request.status === 'submitted')
    .map((p) => ({
      approvalId: p.id,
      level: p.level,
      requestId: p.request.id,
      recordCode: p.request.recordCode,
      typeCode: p.request.type.code,
      typeName: p.request.type.name,
      subjectEmploymentId: p.request.subjectEmploymentId,
      payload: p.request.payload,
      requestedById: p.request.requestedById,
      submittedAt: p.request.createdAt,
      slaHours: p.request.type.slaHours,
    }));
}

/**
 * Decides the current level of a request. The Self-Dealing Bar is
 * unconditional: an approver may never decide a request they raised, nor one
 * whose subject they are — enforced here even though the resolver already
 * excludes both, because a chain can be edited or a delegation can be added
 * after the level opened.
 */
export async function decide(requestId: string, approve: boolean, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_requests', verb: 'approve' });

  const request = await prisma.hrRequest.findFirst({ where: { id: requestId, tenantId: auth.tenantId }, include: { type: true } });
  if (!request) throw ApiError.notFound('HR request');
  if (request.status !== 'submitted') {
    throw ApiError.conflict(`This request is already ${request.status}.`);
  }

  const subjectPartyId = await partyIdForEmployment(auth.tenantId, request.subjectEmploymentId);
  if (tripsSelfDealingBar(auth.partyId, request.requestedById, subjectPartyId)) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: you may never decide a request you raised or that is about you.');
  }

  const approval = await prisma.hrRequestApproval.findFirst({
    where: { tenantId: auth.tenantId, requestId, level: request.currentLevel },
  });
  if (!approval) throw ApiError.conflict('This request has no open approval level.');
  if (approval.decision !== 'pending') throw ApiError.conflict('This level has already been decided.');
  if (approval.approverPartyId && approval.approverPartyId !== auth.partyId) {
    throw ApiError.forbidden('This level is resolved to a different approver.');
  }

  await prisma.hrRequestApproval.update({
    where: { id: approval.id },
    data: { decision: approve ? 'approved' : 'rejected', note: note ?? null, decidedAt: new Date() },
  });

  const chain = request.type.approvalChain as unknown as ApprovalChain;
  const isFinalLevel = request.currentLevel >= chain.length;

  if (!approve) {
    await prisma.hrRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', currentLevel: 0, closedAt: new Date() },
    });
    await emit({
      name: EVENTS.HR_REQUEST_REJECTED,
      subject: { entityType: 'hr_request', entityId: requestId, recordCode: request.recordCode },
      previousState: { status: request.status, level: request.currentLevel },
      newState: { status: 'rejected' },
      reason: { reasonCode: 'declined' },
    });
  } else if (isFinalLevel) {
    await prisma.hrRequest.update({
      where: { id: requestId },
      data: { status: 'closed', currentLevel: 0, closedAt: new Date() },
    });
    await emit({
      name: EVENTS.HR_REQUEST_APPROVED,
      subject: { entityType: 'hr_request', entityId: requestId, recordCode: request.recordCode },
      previousState: { status: request.status, level: request.currentLevel },
      newState: { status: 'closed' },
      reason: { reasonCode: 'approved' },
    });
    await emit({
      name: EVENTS.HR_REQUEST_CLOSED,
      subject: { entityType: 'hr_request', entityId: requestId, recordCode: request.recordCode },
      newState: { status: 'closed' },
    });
  } else {
    const nextLevel = request.currentLevel + 1;
    await prisma.hrRequest.update({ where: { id: requestId }, data: { currentLevel: nextLevel } });
    const delegations = await activeDelegations(auth.tenantId);
    await openLevel(
      auth.tenantId,
      requestId,
      chain,
      nextLevel,
      { subjectEmploymentId: request.subjectEmploymentId, requestedById: request.requestedById, subjectPartyId },
      delegations,
    );
    await emit({
      name: EVENTS.HR_REQUEST_APPROVED,
      subject: { entityType: 'hr_request', entityId: requestId, recordCode: request.recordCode },
      previousState: { status: request.status, level: request.currentLevel },
      newState: { status: 'submitted', level: nextLevel },
      reason: { reasonCode: 'approved' },
    });
  }

  await auditWrite({
    action: 'update',
    subjectType: 'hr_request',
    subjectId: requestId,
    before: { level: approval.level, decision: 'pending' } as never,
    after: { level: approval.level, decision: approve ? 'approved' : 'rejected', note } as never,
  });

  return getRequest(requestId);
}

export async function withdrawRequest(requestId: string) {
  const auth = currentAuth();
  // The employee role's own-scope grant on `hr_requests` is view+create only
  // (no `edit`/`delete`) — the scaffold's grant for a requester managing
  // their own submission. `create` is therefore the closest held verb; the
  // real authorization is the ownership check just below, not this grant.
  // See docs/hcm/workflow.md, "Wanted from the scaffold".
  await assertCan({ resource: 'hr_requests', verb: 'create' });
  const request = await prisma.hrRequest.findFirst({ where: { id: requestId, tenantId: auth.tenantId } });
  if (!request) throw ApiError.notFound('HR request');
  if (request.requestedById !== auth.partyId) {
    throw ApiError.forbidden('Only the person who raised a request may withdraw it.');
  }
  if (request.status !== 'submitted') {
    throw ApiError.conflict(`This request is already ${request.status} and cannot be withdrawn.`);
  }
  const updated = await prisma.hrRequest.update({
    where: { id: requestId },
    data: { status: 'withdrawn', currentLevel: 0, closedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'hr_request', subjectId: requestId, after: updated as never });
  return getRequest(requestId);
}

// ---------------------------------------------------------------------------
// Delegation of authority
// ---------------------------------------------------------------------------

export async function listDelegations() {
  const auth = currentAuth();
  await assertCan({ resource: 'authority_delegations', verb: 'view' });
  return prisma.delegationOfAuthority.findMany({
    where: { tenantId: auth.tenantId, revokedAt: null },
    orderBy: { fromDate: 'desc' },
  });
}

export async function createDelegation(input: { toPartyId: string; fromDate: Date; toDate: Date; scope?: string; note?: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'authority_delegations', verb: 'create' });
  const fromPartyId = auth.partyId;
  if (!fromPartyId) throw ApiError.badRequest('No party to delegate from.');
  if (input.toDate <= input.fromDate) throw ApiError.badRequest('toDate must be after fromDate.');
  if (input.toPartyId === fromPartyId) throw ApiError.badRequest('Cannot delegate to yourself.');

  const row = await prisma.delegationOfAuthority.create({
    data: {
      tenantId: auth.tenantId,
      fromPartyId,
      toPartyId: input.toPartyId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      scope: input.scope ?? 'all',
      note: input.note ?? null,
    },
  });
  await emit({
    name: EVENTS.AUTHORITY_DELEGATION_CREATED,
    subject: { entityType: 'authority_delegation', entityId: row.id },
    newState: { fromPartyId, toPartyId: input.toPartyId, scope: row.scope },
  });
  await auditWrite({ action: 'create', subjectType: 'authority_delegation', subjectId: row.id, after: row as never });
  return row;
}

export async function revokeDelegation(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'authority_delegations', verb: 'delete' });
  const row = await prisma.delegationOfAuthority.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Delegation');
  if (row.fromPartyId !== auth.partyId) throw ApiError.forbidden('Only the delegator may revoke a delegation.');
  const updated = await prisma.delegationOfAuthority.update({ where: { id }, data: { revokedAt: new Date() } });
  await emit({
    name: EVENTS.AUTHORITY_DELEGATION_ENDED,
    subject: { entityType: 'authority_delegation', entityId: id },
    newState: { revokedAt: updated.revokedAt },
  });
  await auditWrite({ action: 'update', subjectType: 'authority_delegation', subjectId: id, after: updated as never });
  return updated;
}
