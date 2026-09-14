/**
 * Technology — incidents, problems and changes (docs/plan/cio.md,
 * workstream E).
 *
 * An `ItIncident`'s timeline stamps are set once each, run through
 * `platform/lifecycle`'s shared machine so a screen can never offer a
 * transition the API would refuse. A change runs the identical approval-gate
 * shape `domains/agreements.ts` already runs for a contract — standard
 * changes are pre-approved by kind, normal and emergency changes run
 * `evaluateApprovalGate('POL-IT-CHANGE-APPROVAL', ...)` and are refused a
 * schedule inside a freeze window unless the freeze itself allows it.
 */

import {
  EVENTS,
  IT_DOMAIN,
  changeSuccessRate,
  isInFreeze,
  isWindowInFreeze,
  itChangeMachine,
  itIncidentMachine,
  itProblemMachine,
  mttrMinutes,
  IT_CHANGE_KINDS,
  ITSM_INCIDENT_VERBS,
  type ItChangeEvent,
  type ItChangeKind,
  type ItChangeRisk,
  type ItChangeState,
  type ItFreezeWindow,
  type ItIncidentEvent,
  type ItIncidentSeverity,
  type ItIncidentState,
  type ItProblemEvent,
  type ItProblemState,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor, scopeWhere } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { availableTransitions } from '../../platform/lifecycle.js';
import { evaluateApprovalGate } from '../../platform/approvals.js';
import type { Machine, Resource, Verb } from '@kaizen/shared';

registerGovernedEntities('it_itsm', ['it_incident', 'it_problem', 'it_change', 'it_change_freeze']);

/**
 * `platform/lifecycle.transition` composes its event name as
 * `kz.hr.<object>.<verb>` unconditionally (`hrTransitionEvent`) — it is an
 * HR-domain helper despite the generic module name, and a `kz.hr.it.*` name
 * fails the canonical `kz.<domain>.<entity>.<verb>` grammar. This does the
 * same five things (grant check, ask the machine, write nothing itself —
 * the caller persists — audit the transition) but lets the caller emit its
 * own correctly-named `kz.it.*` event instead.
 */
async function checkedTransition<S extends string, E extends string>(input: {
  machine: Machine<S, E>;
  resource: Resource;
  verb: Verb;
  subjectType: string;
  subjectId: string;
  ownerPartyId?: string | null;
  from: S;
  event: E;
}): Promise<{ from: S; to: S }> {
  await assertCan({ resource: input.resource, verb: input.verb, record: { ownerPartyId: input.ownerPartyId ?? null } });

  if (!input.machine.can(input.from, input.event)) {
    throw ApiError.unprocessable(
      `${input.machine.name} is ${input.from}; ${input.event} is not one of its transitions. ` +
        `From here it accepts: ${input.machine.allowedEvents(input.from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  const to = input.machine.apply(input.from, input.event);

  await auditWrite({
    action: 'update',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    before: { status: input.from },
    after: { status: to },
    meta: { transition: input.event, machine: input.machine.name },
    force: true,
  });

  return { from: input.from, to };
}

// ---------------------------------------------------------------------------
// The dated policy row (Principle 4): stale-commander minutes, review-overdue
// days, which severities require a review. Never a constant in this file.
// ---------------------------------------------------------------------------

const POLICY_DEFAULTS = { staleMinutes: 60, reviewOverdueDays: 5, reviewRequiredSeverities: ['sev1', 'sev2'] as string[] };

export async function currentPolicy() {
  const auth = currentAuth();
  const row = await prisma.itItsmPolicy.findFirst({ where: { tenantId: auth.tenantId } });
  return row
    ? { staleMinutes: row.staleMinutes, reviewOverdueDays: row.reviewOverdueDays, reviewRequiredSeverities: row.reviewRequiredSeverities }
    : POLICY_DEFAULTS;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface DeclareIncidentInput {
  title: string;
  severity: ItIncidentSeverity;
  affectedApplicationIds?: string[];
  impact?: string | null;
  customerFacing?: boolean;
  commanderPartyId?: string | null;
  breachId?: string | null;
}

export async function declareIncident(input: DeclareIncidentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'create' });

  if (!input.title?.trim()) throw ApiError.badRequest('An incident needs a title.');

  const policy = await currentPolicy();
  const reviewRequired = policy.reviewRequiredSeverities.includes(input.severity);
  const recordCode = await nextRecordCode('INC');
  const now = new Date();

  const incident = await prisma.itIncident.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      severity: input.severity,
      status: 'declared',
      affectedApplicationIds: input.affectedApplicationIds ?? [],
      detectedAt: now,
      lastActivityAt: now,
      commanderPartyId: input.commanderPartyId ?? auth.partyId,
      impact: input.impact ?? null,
      customerFacing: input.customerFacing ?? false,
      breachId: input.breachId ?? null,
      reviewRequired,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_incident', subjectId: incident.id, after: { recordCode, severity: input.severity } });
  await emit({
    name: EVENTS.IT_INCIDENT_DECLARED,
    subject: { entityType: 'it_incident', entityId: incident.id, recordCode },
    newState: { status: 'declared', severity: input.severity, customerFacing: incident.customerFacing },
    owner: { partyId: incident.commanderPartyId },
    impact: { domains: [IT_DOMAIN], severity: input.severity === 'sev1' ? 'S4_CRITICAL' : input.severity === 'sev2' ? 'S3_HIGH_RISK' : 'S2_WARNING' },
  });

  return incident;
}

export interface IncidentFilter {
  status?: string;
  severity?: string;
}

export async function listIncidents(filter: IncidentFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'view' });
  return prisma.itIncident.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
    },
    orderBy: { detectedAt: 'desc' },
  });
}

function incidentAvailableTransitions(status: ItIncidentState, reviewRequired: boolean, reviewPublishedAt: Date | null): ItIncidentEvent[] {
  const events = availableTransitions(itIncidentMachine, status);
  if (status === 'resolved' && reviewRequired && !reviewPublishedAt) {
    return events.filter((e) => e !== 'CLOSE');
  }
  return events;
}

export async function incidentDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'view' });
  const incident = await prisma.itIncident.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { updates: { orderBy: { at: 'asc' } } },
  });
  if (!incident) throw ApiError.notFound('Incident');
  return {
    ...incident,
    availableTransitions: incidentAvailableTransitions(incident.status as ItIncidentState, incident.reviewRequired, incident.reviewPublishedAt),
  };
}

export async function transitionIncident(id: string, event: ItIncidentEvent, note?: string) {
  const auth = currentAuth();
  const incident = await prisma.itIncident.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!incident) throw ApiError.notFound('Incident');

  // IT-INC-001: a stamp already set is a conflict, never a silent overwrite —
  // checked ahead of the machine so the caller is told exactly why.
  const alreadySet: Partial<Record<ItIncidentEvent, boolean>> = {
    ACKNOWLEDGE: Boolean(incident.acknowledgedAt),
    MITIGATE: Boolean(incident.mitigatedAt),
    RESOLVE: Boolean(incident.resolvedAt),
    CLOSE: Boolean(incident.closedAt),
  };
  if (alreadySet[event]) {
    throw ApiError.conflict(`${incident.recordCode ?? incident.id} was already ${ITSM_INCIDENT_VERBS[event]} — the timestamp is set once and this is a repeat, not a correction.`);
  }

  if (event === 'CLOSE' && incident.reviewRequired && !incident.reviewPublishedAt) {
    throw ApiError.unprocessable(
      `${incident.recordCode ?? incident.id} is sev${incident.severity.slice(3)} and requires a published post-incident review before it can be closed (IT-INC-002).`,
    );
  }

  const result = await checkedTransition({
    machine: itIncidentMachine,
    resource: 'it_incidents',
    verb: 'edit',
    subjectType: 'it_incident',
    subjectId: id,
    ownerPartyId: incident.commanderPartyId,
    from: incident.status as ItIncidentState,
    event,
  });

  const now = new Date();
  const patch: Record<string, unknown> = { status: result.to, lastActivityAt: now, staleNotifiedAt: null };
  if (event === 'ACKNOWLEDGE') patch.acknowledgedAt = now;
  if (event === 'MITIGATE') patch.mitigatedAt = now;
  if (event === 'RESOLVE') patch.resolvedAt = now;
  if (event === 'CLOSE') patch.closedAt = now;

  const updated = await prisma.itIncident.update({ where: { id }, data: patch });

  await emit({
    name: EVENTS.IT_INCIDENT_TRANSITIONED,
    subject: { entityType: 'it_incident', entityId: id, recordCode: incident.recordCode },
    previousState: { status: incident.status },
    newState: { status: result.to },
    reason: note ? { reasonCode: event, note } : null,
    owner: { partyId: incident.commanderPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

export async function postIncidentUpdate(id: string, body: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'edit' });

  if (!body?.trim()) throw ApiError.badRequest('An update needs a body — what changed, what is being tried next.');

  const incident = await prisma.itIncident.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!incident) throw ApiError.notFound('Incident');

  const now = new Date();
  const update = await prisma.itIncidentUpdate.create({
    data: { tenantId: auth.tenantId, incidentId: id, body: body.trim(), authorPartyId: auth.partyId, at: now },
  });

  await prisma.itIncident.update({ where: { id }, data: { lastActivityAt: now, staleNotifiedAt: null } });
  await auditWrite({ action: 'create', subjectType: 'it_incident_update', subjectId: update.id, after: { incidentId: id } });

  return update;
}

export interface IncidentReviewInput {
  reviewBody: string;
  publish?: boolean;
}

/** Draft-saves or, with `publish: true`, publishes the post-incident review.
 * A published review is final — a further call on a published review is
 * refused, never silently overwritten (IT-INC-002). */
export async function submitIncidentReview(id: string, input: IncidentReviewInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'edit' });

  const incident = await prisma.itIncident.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!incident) throw ApiError.notFound('Incident');
  if (incident.reviewPublishedAt) {
    throw ApiError.conflict(`${incident.recordCode ?? incident.id}'s post-incident review was published on ${incident.reviewPublishedAt.toISOString().slice(0, 10)} and is final. A correction is a new incident's review, not an edit to this one.`);
  }

  const body = input.reviewBody?.trim();
  if (input.publish && !body) {
    throw ApiError.badRequest('Publishing a review needs a body.');
  }

  const patch: Record<string, unknown> = { reviewBody: body ?? incident.reviewBody };
  if (input.publish) {
    patch.reviewPublishedAt = new Date();
    patch.reviewPublishedById = auth.partyId;
    patch.reviewOverdueNotifiedAt = null;
  }

  const updated = await prisma.itIncident.update({ where: { id }, data: patch });

  await auditWrite({
    action: 'update',
    subjectType: 'it_incident',
    subjectId: id,
    after: { reviewPublished: Boolean(input.publish) },
  });

  if (input.publish) {
    await emit({
      name: EVENTS.IT_INCIDENT_REVIEW_PUBLISHED,
      subject: { entityType: 'it_incident', entityId: id, recordCode: incident.recordCode },
      newState: { reviewPublishedAt: updated.reviewPublishedAt },
      owner: { partyId: incident.commanderPartyId },
      impact: { domains: [IT_DOMAIN] },
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export interface CreateProblemInput {
  title: string;
  rootCause?: string | null;
  knownError?: boolean;
  workaround?: string | null;
  incidentIds?: string[];
  ownerPartyId?: string | null;
}

export async function createProblem(input: CreateProblemInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_problems', verb: 'create' });
  if (!input.title?.trim()) throw ApiError.badRequest('A problem needs a title.');

  const recordCode = await nextRecordCode('PRB');
  const problem = await prisma.itProblem.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      rootCause: input.rootCause ?? null,
      knownError: input.knownError ?? false,
      workaround: input.workaround ?? null,
      incidentIds: input.incidentIds ?? [],
      ownerPartyId: input.ownerPartyId ?? auth.partyId,
      createdById: auth.partyId,
    },
  });

  if (input.incidentIds?.length) {
    await prisma.itIncident.updateMany({
      where: { id: { in: input.incidentIds }, tenantId: auth.tenantId },
      data: { problemId: problem.id },
    });
  }

  await auditWrite({ action: 'create', subjectType: 'it_problem', subjectId: problem.id, after: { recordCode } });
  await emit({
    name: EVENTS.IT_PROBLEM_CREATED,
    subject: { entityType: 'it_problem', entityId: problem.id, recordCode },
    newState: { status: 'open' },
    owner: { partyId: problem.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return problem;
}

export async function listProblems(status?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_problems', verb: 'view' });
  return prisma.itProblem.findMany({
    where: { tenantId: auth.tenantId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function problemDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_problems', verb: 'view' });
  const problem = await prisma.itProblem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!problem) throw ApiError.notFound('Problem');
  const linkedIncidents = problem.incidentIds.length
    ? await prisma.itIncident.findMany({ where: { id: { in: problem.incidentIds }, tenantId: auth.tenantId } })
    : [];
  return { ...problem, availableTransitions: availableTransitions(itProblemMachine, problem.status as ItProblemState), linkedIncidents };
}

export interface UpdateProblemInput {
  rootCause?: string | null;
  knownError?: boolean;
  workaround?: string | null;
  incidentIds?: string[];
}

export async function updateProblem(id: string, input: UpdateProblemInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_problems', verb: 'edit' });
  const problem = await prisma.itProblem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!problem) throw ApiError.notFound('Problem');

  const nextIncidentIds = input.incidentIds ?? problem.incidentIds;
  const updated = await prisma.itProblem.update({
    where: { id },
    data: {
      ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
      ...(input.knownError !== undefined ? { knownError: input.knownError } : {}),
      ...(input.workaround !== undefined ? { workaround: input.workaround } : {}),
      incidentIds: nextIncidentIds,
    },
  });

  if (input.incidentIds?.length) {
    await prisma.itIncident.updateMany({
      where: { id: { in: input.incidentIds }, tenantId: auth.tenantId },
      data: { problemId: id },
    });
  }

  await auditWrite({ action: 'update', subjectType: 'it_problem', subjectId: id, after: { rootCause: updated.rootCause, knownError: updated.knownError } });
  return updated;
}

export async function transitionProblem(id: string, event: ItProblemEvent, note?: string) {
  const auth = currentAuth();
  const problem = await prisma.itProblem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!problem) throw ApiError.notFound('Problem');

  const result = await checkedTransition({
    machine: itProblemMachine,
    resource: 'it_problems',
    verb: 'edit',
    subjectType: 'it_problem',
    subjectId: id,
    ownerPartyId: problem.ownerPartyId,
    from: problem.status as ItProblemState,
    event,
  });

  const updated = await prisma.itProblem.update({ where: { id }, data: { status: result.to } });

  await emit({
    name: EVENTS.IT_PROBLEM_TRANSITIONED,
    subject: { entityType: 'it_problem', entityId: id, recordCode: problem.recordCode },
    previousState: { status: problem.status },
    newState: { status: result.to },
    reason: note ? { reasonCode: event, note } : null,
    owner: { partyId: problem.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

const CHANGE_POLICY_CODE = 'POL-IT-CHANGE-APPROVAL';

export interface CreateChangeInput {
  title: string;
  kind: ItChangeKind;
  risk: ItChangeRisk;
  affectedApplicationIds?: string[];
  plan: string;
  rollbackPlan: string;
  windowStart: Date;
  windowEnd: Date;
}

export async function createChange(input: CreateChangeInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_changes', verb: 'create' });

  if (!input.title?.trim()) throw ApiError.badRequest('A change needs a title.');
  if (!(input.windowEnd > input.windowStart)) throw ApiError.badRequest('A change window must end after it starts.');

  const recordCode = await nextRecordCode('CHG');
  const change = await prisma.itChange.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      kind: input.kind,
      risk: input.risk,
      status: 'draft',
      affectedApplicationIds: input.affectedApplicationIds ?? [],
      plan: input.plan,
      rollbackPlan: input.rollbackPlan,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      requesterPartyId: auth.partyId ?? 'unknown',
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_change', subjectId: change.id, after: { recordCode, kind: input.kind } });
  await emit({
    name: EVENTS.IT_CHANGE_CREATED,
    subject: { entityType: 'it_change', entityId: change.id, recordCode },
    newState: { status: 'draft', kind: input.kind, risk: input.risk },
    owner: { partyId: change.requesterPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return change;
}

export interface ChangeFilter {
  status?: string;
  mine?: boolean;
}

export async function listChanges(filter: ChangeFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_changes', verb: 'view' });
  const scope = await scopeFor('it_changes', 'view');
  const where = scope ? scopeWhere(scope, auth, 'requesterPartyId') : {};

  return prisma.itChange.findMany({
    where: {
      tenantId: auth.tenantId,
      ...where,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.mine ? { requesterPartyId: auth.partyId ?? '__none__' } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function activeFreezes(tenantId: string): Promise<ItFreezeWindow[]> {
  const rows = await prisma.itChangeFreeze.findMany({ where: { tenantId } });
  return rows.map((f) => ({ name: f.name, startsAt: f.startsAt, endsAt: f.endsAt, allowEmergency: f.allowEmergency }));
}

/**
 * The freeze covering this instant, if any, plus which change kinds it
 * actually blocks right now — `standard`/`normal` always, `emergency` only
 * when the freeze does not say `allowEmergency`. When more than one freeze
 * covers the moment, the one reported is whichever runs latest (the one
 * that matters for "until"); `blockedKinds` still reflects every freeze
 * covering the moment, not just the reported one.
 */
function freezeInForceNow(freezes: ItFreezeWindow[]): { name: string; until: Date | string; blockedKinds: ItChangeKind[] } | null {
  const now = new Date();
  const covering = freezes.filter((f) => {
    const start = new Date(f.startsAt).getTime();
    const end = new Date(f.endsAt).getTime();
    return now.getTime() >= start && now.getTime() <= end;
  });
  if (covering.length === 0) return null;

  const blockedKinds = IT_CHANGE_KINDS.filter((kind) => isInFreeze(freezes, now, kind) !== null);
  const reported = covering.reduce((latest, f) => (new Date(f.endsAt).getTime() > new Date(latest.endsAt).getTime() ? f : latest));
  return { name: reported.name, until: reported.endsAt, blockedKinds: [...blockedKinds] };
}

export async function changeDetail(id: string) {
  const auth = currentAuth();
  const change = await prisma.itChange.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!change) throw ApiError.notFound('Change');
  await assertCan({ resource: 'it_changes', verb: 'view', record: { ownerPartyId: change.requesterPartyId } });

  const freezes = await activeFreezes(auth.tenantId);
  // The same rule `SCHEDULE` enforces: the whole window, not just its start
  // — a freeze this change's window runs into is exactly the freeze it
  // will be refused a schedule under.
  const inForce = isWindowInFreeze(freezes, change.windowStart, change.windowEnd, change.kind as ItChangeKind);

  return {
    ...change,
    availableTransitions: availableTransitions(itChangeMachine, change.status as ItChangeState),
    freezeInForce: inForce,
  };
}

export interface TransitionChangeInput {
  event: ItChangeEvent;
  note?: string;
}

export async function transitionChange(id: string, input: TransitionChangeInput) {
  const auth = currentAuth();
  const change = await prisma.itChange.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!change) throw ApiError.notFound('Change');

  const from = change.status as ItChangeState;
  const event = input.event;

  // Privileged transition: normal/emergency changes run the gate on APPROVE.
  // Standard changes never reach here in the `submitted` state (SUBMIT
  // auto-applies APPROVE for them), so an explicit APPROVE on a standard
  // change is simply not a transition the machine has from `approved`.
  if (event === 'APPROVE') {
    if (!itChangeMachine.can(from, event)) {
      throw ApiError.unprocessable(`${change.recordCode ?? id} is ${from}; APPROVE is not one of its transitions from there.`);
    }
    const gate = await evaluateApprovalGate(
      CHANGE_POLICY_CODE,
      {
        id,
        type: 'it_change',
        label: `${change.recordCode} — ${change.title}`,
        ownerPartyId: change.requesterPartyId,
        commercialValue: null,
        currency: 'INR',
        strategicValue: null,
        termMonths: null,
      },
      'it_change.approve',
    );
    if (!gate.permitted) {
      return { applied: false, change, approvalStepId: gate.approvalStepId, resolvedApproverRole: gate.resolvedApproverRole, resolutionTier: gate.resolutionTier, selfDealingBarTripped: gate.selfDealingBarTripped, reason: gate.reason };
    }
    const updated = await applyChangeTransition(change, event, input.note, { approvedById: auth.partyId, approvedAt: new Date() }, 'approve');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Approved.' };
  }

  if (event === 'SCHEDULE') {
    const freezes = await activeFreezes(auth.tenantId);
    // The whole window, not just its start — a change that starts before a
    // freeze opens and runs into it is just as much scheduled into the
    // freeze as one that starts inside it.
    const hit = isWindowInFreeze(freezes, change.windowStart, change.windowEnd, change.kind as ItChangeKind);
    if (hit) {
      throw ApiError.unprocessable(
        `${change.recordCode ?? id} cannot be scheduled: the '${hit.name}' freeze covers this window (${new Date(hit.startsAt).toISOString().slice(0, 10)} to ${new Date(hit.endsAt).toISOString().slice(0, 10)})${change.kind === 'emergency' ? ', and the freeze does not allow emergency changes' : ''} (IT-CHG-002).`,
      );
    }
    const updated = await applyChangeTransition(change, event, input.note, { scheduledAt: new Date() }, 'edit');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Scheduled.' };
  }

  if (event === 'IMPLEMENT') {
    if (!input.note?.trim()) throw ApiError.badRequest('Implementing a change needs an implementation note.');
    const updated = await applyChangeTransition(change, event, input.note, { implementedAt: new Date(), implementationNote: input.note.trim() }, 'edit');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Implemented.' };
  }

  if (event === 'REVIEW') {
    if (!input.note?.trim()) throw ApiError.badRequest('Reviewing a change needs a review note.');
    if (change.reviewNote) throw ApiError.conflict(`${change.recordCode ?? id} already carries a review note — it is set once.`);
    const updated = await applyChangeTransition(change, event, input.note, { reviewedAt: new Date(), reviewNote: input.note.trim() }, 'edit');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Reviewed.' };
  }

  if (event === 'ROLLBACK') {
    const updated = await applyChangeTransition(change, event, input.note, { reviewNote: input.note?.trim() ?? change.reviewNote }, 'edit');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Rolled back.' };
  }

  if (event === 'FAIL') {
    const updated = await applyChangeTransition(change, event, input.note, { failureReason: input.note?.trim() ?? null }, 'edit');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Failed.' };
  }

  if (event === 'REJECT') {
    const updated = await applyChangeTransition(change, event, input.note, { rejectionReason: input.note?.trim() ?? null }, 'approve');
    return { applied: true, change: updated, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Rejected.' };
  }

  // SUBMIT — the last step of "raising" a change, which is what the
  // employee's `create`-only grant on `it_changes` covers (IT-CHG-001 needs
  // the raiser able to reach `submitted` without an `edit` grant they do not
  // hold).
  const submitted = await applyChangeTransition(change, event, input.note, {}, 'create');
  if (change.kind === 'standard') {
    // Pre-approved by kind: skip the gate AND the `approve` grant check
    // entirely — this is the system applying policy, not a person deciding,
    // so it never asks the raiser to hold an approval grant they do not have.
    const autoApproved = await autoApproveStandardChange({ ...submitted, status: 'submitted' });
    return { applied: true, change: autoApproved, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Standard change — auto-approved on submit.' };
  }
  return { applied: true, change: submitted, approvalStepId: null, resolvedApproverRole: null, resolutionTier: 0, selfDealingBarTripped: false, reason: 'Submitted.' };
}

/**
 * Standard changes are pre-approved by kind (docs/plan/cio.md, workstream E):
 * the raiser is never asked to hold `it_changes:approve` for their own
 * standard-kind change, because nobody is deciding anything here — the
 * `APPROVE` transition still runs (so the state diagram is exactly what the
 * machine draws), but as policy applying itself, not as a graded permission
 * check.
 */
async function autoApproveStandardChange(change: { id: string; status: string; recordCode: string | null; requesterPartyId: string }) {
  const from = change.status as ItChangeState;
  if (!itChangeMachine.can(from, 'APPROVE')) {
    throw ApiError.unprocessable(`${change.recordCode ?? change.id} is ${from}; APPROVE is not one of its transitions from there.`);
  }
  const to = itChangeMachine.apply(from, 'APPROVE');

  const updated = await prisma.itChange.update({ where: { id: change.id }, data: { status: to, approvedById: null, approvedAt: new Date() } });

  await auditWrite({
    action: 'update',
    subjectType: 'it_change',
    subjectId: change.id,
    before: { status: from },
    after: { status: to },
    meta: { transition: 'APPROVE', machine: itChangeMachine.name, autoApproved: true },
    force: true,
  });
  await emit({
    name: EVENTS.IT_CHANGE_TRANSITIONED,
    subject: { entityType: 'it_change', entityId: change.id, recordCode: change.recordCode },
    previousState: { status: from },
    newState: { status: to, autoApproved: true },
    owner: { partyId: change.requesterPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

async function applyChangeTransition(
  change: { id: string; status: string; recordCode: string | null; requesterPartyId: string },
  event: ItChangeEvent,
  note: string | undefined,
  patch: Record<string, unknown>,
  verb: 'create' | 'edit' | 'approve',
) {
  const from = change.status as ItChangeState;
  const result = await checkedTransition({
    machine: itChangeMachine,
    resource: 'it_changes',
    verb,
    subjectType: 'it_change',
    subjectId: change.id,
    ownerPartyId: change.requesterPartyId,
    from,
    event,
  });

  const updated = await prisma.itChange.update({ where: { id: change.id }, data: { status: result.to, ...patch } });

  await emit({
    name: EVENTS.IT_CHANGE_TRANSITIONED,
    subject: { entityType: 'it_change', entityId: change.id, recordCode: change.recordCode },
    previousState: { status: from },
    newState: { status: result.to },
    reason: note ? { reasonCode: event, note } : null,
    owner: { partyId: change.requesterPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

export interface DeclareFreezeInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  allowEmergency?: boolean;
}

export async function declareFreeze(input: DeclareFreezeInput) {
  const auth = currentAuth();
  // Web gates the control on `it_changes:assign` or `it_changes:edit`; the
  // Operations Head's `VCEX` grant carries edit, which is what this checks.
  await assertCan({ resource: 'it_changes', verb: 'edit' });

  if (!input.name?.trim()) throw ApiError.badRequest('A freeze needs a name.');
  if (!input.reason?.trim()) throw ApiError.badRequest('A freeze needs a reason.');
  if (!(input.endsAt > input.startsAt)) throw ApiError.badRequest('A freeze must end after it starts.');

  const freeze = await prisma.itChangeFreeze.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason.trim(),
      allowEmergency: input.allowEmergency ?? false,
      declaredById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_change_freeze', subjectId: freeze.id, after: { name: freeze.name } });
  await emit({
    name: EVENTS.IT_CHANGE_FREEZE_DECLARED,
    subject: { entityType: 'it_change_freeze', entityId: freeze.id },
    newState: { name: freeze.name, startsAt: freeze.startsAt, endsAt: freeze.endsAt },
    impact: { domains: [IT_DOMAIN] },
  });

  return freeze;
}

export async function listFreezes() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_changes', verb: 'view' });
  return prisma.itChangeFreeze.findMany({ where: { tenantId: auth.tenantId }, orderBy: { startsAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export async function incidentSummary() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_incidents', verb: 'view' });

  const total = await prisma.itIncident.count({ where: { tenantId: auth.tenantId } });
  if (total === 0) {
    return {
      notYetMeasured: true,
      openBySeverity: { sev1: 0, sev2: 0, sev3: 0, sev4: 0 },
      mttrMinutes30d: null,
      customerFacingOpen: 0,
      reviewsOutstanding: 0,
    };
  }

  const open = await prisma.itIncident.findMany({ where: { tenantId: auth.tenantId, status: { not: 'closed' } } });
  const openBySeverity = { sev1: 0, sev2: 0, sev3: 0, sev4: 0 };
  let customerFacingOpen = 0;
  for (const inc of open) {
    openBySeverity[inc.severity as keyof typeof openBySeverity] = (openBySeverity[inc.severity as keyof typeof openBySeverity] ?? 0) + 1;
    if (inc.customerFacing) customerFacingOpen += 1;
  }

  const since = new Date(Date.now() - 30 * 86_400_000);
  const resolved30d = await prisma.itIncident.findMany({
    where: { tenantId: auth.tenantId, resolvedAt: { gte: since } },
    select: { detectedAt: true, resolvedAt: true },
  });
  const mttr = mttrMinutes(resolved30d);

  const reviewsOutstanding = await prisma.itIncident.count({
    where: { tenantId: auth.tenantId, reviewRequired: true, reviewPublishedAt: null, resolvedAt: { not: null } },
  });

  return {
    notYetMeasured: false,
    openBySeverity,
    mttrMinutes30d: mttr,
    customerFacingOpen,
    reviewsOutstanding,
  };
}

export async function changeSummary() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_changes', verb: 'view' });

  const total = await prisma.itChange.count({ where: { tenantId: auth.tenantId } });
  const freezes = await activeFreezes(auth.tenantId);
  const freezeInForce = freezeInForceNow(freezes);

  if (total === 0) {
    return {
      notYetMeasured: true,
      awaitingApproval: 0,
      scheduledThisWeek: 0,
      successRate90d: null,
      freezeInForce,
    };
  }

  const awaitingApproval = await prisma.itChange.count({ where: { tenantId: auth.tenantId, status: 'submitted' } });

  const weekEnd = new Date(Date.now() + 7 * 86_400_000);
  const scheduledThisWeek = await prisma.itChange.count({
    where: { tenantId: auth.tenantId, status: 'scheduled', windowStart: { lte: weekEnd }, windowEnd: { gte: new Date() } },
  });

  const since = new Date(Date.now() - 90 * 86_400_000);
  const recent = await prisma.itChange.findMany({
    where: { tenantId: auth.tenantId, updatedAt: { gte: since }, status: { in: ['reviewed', 'failed', 'rolled_back'] } },
    select: { status: true },
  });
  const successRate90d = changeSuccessRate(recent);

  return {
    notYetMeasured: false,
    awaitingApproval,
    scheduledThisWeek,
    successRate90d,
    freezeInForce,
  };
}
