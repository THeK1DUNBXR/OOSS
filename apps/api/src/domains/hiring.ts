/**
 * Hiring (Canon §14.3 R5 and R3, §14.4 rows 2-7).
 *
 * Requisition → Application → Hire. The gap the application machine insists on
 * is the point of it: Offer Accepted is not Joined, and everything that can go
 * wrong between the two — a rescinded offer, a no-show, a withdrawal before
 * the start date — happens in that gap and has to be recordable there.
 */

import {
  EVENTS,
  requisitionMachine,
  applicationMachine,
  REQUISITION_EVENT_VERB,
  APPLICATION_EVENT_VERB,
  applicationFunnelBucket,
  type RequisitionState,
  type RequisitionEvent,
  type ApplicationState,
  type ApplicationEvent,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { hire } from './employment.js';

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export async function listRequisitions(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'requisitions', verb: 'view' });

  return prisma.requisition.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      position: { include: { job: true, orgUnit: true } },
      applications: { select: { id: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createRequisition(input: {
  positionId: string;
  budgetLineId?: string | null;
  targetStartDate?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'requisitions', verb: 'create' });

  const position = await prisma.position.findFirst({
    where: { id: input.positionId, tenantId: auth.tenantId },
  });
  if (!position) throw ApiError.notFound('Position');

  const recordCode = await nextRecordCode('REQ');
  const requisition = await prisma.requisition.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      positionId: input.positionId,
      budgetLineId: input.budgetLineId ?? position.budgetLineId,
      raisedByPartyId: auth.partyId,
      targetStartDate: input.targetStartDate ?? null,
    },
  });

  await emit({
    name: EVENTS.REQUISITION_CREATED,
    subject: { entityType: 'requisition', entityId: requisition.id, recordCode },
    related: [{ relation: 'fills', entityType: 'position', entityId: input.positionId }],
    newState: { status: 'Draft', positionId: input.positionId, targetStartDate: input.targetStartDate },
    owner: { partyId: auth.partyId },
    impact: { domains: ['hr'] },
  });

  return requisition;
}

export async function transitionRequisition(id: string, event: RequisitionEvent, note?: string) {
  const auth = currentAuth();
  const requisition = await prisma.requisition.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!requisition) throw ApiError.notFound('Requisition');

  const result = await transition({
    machine: requisitionMachine,
    eventObject: 'requisition',
    verbs: REQUISITION_EVENT_VERB,
    resource: 'requisitions',
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'requisition',
    subjectId: id,
    recordCode: requisition.recordCode,
    ownerPartyId: requisition.raisedByPartyId,
    from: requisition.status as RequisitionState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.requisition.update({ where: { id }, data: { status: result.to } });
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function listApplications(filter: { requisitionId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'applications', verb: 'view' });

  const rows = await prisma.application.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.requisitionId ? { requisitionId: filter.requisitionId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      candidate: { select: { id: true, fullName: true, primaryEmail: true, recordCode: true } },
      requisition: { include: { position: { include: { job: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // The funnel bucket is a projection of the state, so it is computed on read
  // rather than stored — a stored copy is one more thing that can disagree.
  return rows.map((row) => ({ ...row, funnelBucket: applicationFunnelBucket(row.status as ApplicationState) }));
}

export async function createApplication(input: { requisitionId: string; candidatePartyId: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'applications', verb: 'create' });

  const requisition = await prisma.requisition.findFirst({
    where: { id: input.requisitionId, tenantId: auth.tenantId },
  });
  if (!requisition) throw ApiError.notFound('Requisition');
  if (requisition.status !== 'Open') {
    throw ApiError.unprocessable(
      `Requisition ${requisition.recordCode} is ${requisition.status}. Applications can only be taken against an Open requisition.`,
    );
  }

  const candidate = await prisma.person.findFirst({
    where: { id: input.candidatePartyId, tenantId: auth.tenantId },
  });
  if (!candidate) throw ApiError.notFound('Candidate');

  const duplicate = await prisma.application.findFirst({
    where: {
      tenantId: auth.tenantId,
      requisitionId: input.requisitionId,
      candidatePartyId: input.candidatePartyId,
      deletedAt: null,
    },
  });
  if (duplicate) {
    throw ApiError.conflict(
      `${candidate.fullName} already has application ${duplicate.recordCode} against this requisition.`,
      { applicationId: duplicate.id },
    );
  }

  const recordCode = await nextRecordCode('APP');
  const application = await prisma.application.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      requisitionId: input.requisitionId,
      candidatePartyId: input.candidatePartyId,
    },
  });

  await emit({
    name: EVENTS.APPLICATION_CREATED,
    subject: { entityType: 'application', entityId: application.id, recordCode },
    related: [
      { relation: 'against', entityType: 'requisition', entityId: input.requisitionId },
      { relation: 'by', entityType: 'person', entityId: input.candidatePartyId },
    ],
    newState: { status: 'Applied' },
    owner: { partyId: input.candidatePartyId },
    impact: { domains: ['hr'] },
  });

  return application;
}

export async function transitionApplication(
  id: string,
  event: ApplicationEvent,
  input: { note?: string; rejectionReason?: string; screeningOutcome?: string } = {},
) {
  const auth = currentAuth();
  const application = await prisma.application.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { requisition: true },
  });
  if (!application) throw ApiError.notFound('Application');

  if (event === 'REJECT' && !input.rejectionReason) {
    throw ApiError.unprocessable(
      'A rejection needs a reason. It is what makes the funnel answerable later, and what a candidate is owed.',
    );
  }

  const result = await transition({
    machine: applicationMachine,
    eventObject: 'application',
    verbs: APPLICATION_EVENT_VERB,
    resource: 'applications',
    subjectType: 'application',
    subjectId: id,
    recordCode: application.recordCode,
    ownerPartyId: application.candidatePartyId,
    from: application.status as ApplicationState,
    event,
    detail: { funnelBucket: applicationFunnelBucket(application.status as ApplicationState) },
    reasonNote: input.note ?? input.rejectionReason ?? null,
  });

  return prisma.application.update({
    where: { id },
    data: {
      status: result.to,
      ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      ...(input.screeningOutcome ? { screeningOutcome: input.screeningOutcome } : {}),
    },
  });
}

/**
 * Joining. Moves the application to Joined and opens the employment
 * relationship in one step, because the two are one event in the world and
 * letting them be recorded separately is how a hire ends up in the funnel
 * report but not on the payroll.
 *
 * The candidate's Person row becomes the employee's Person row — no second
 * record for the same human.
 */
export async function joinFromApplication(
  applicationId: string,
  input: { hireEffectiveDate: Date; legalEntity?: string; noticePeriodDays?: number; branch?: string | null },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'create' });

  const application = await prisma.application.findFirst({
    where: { id: applicationId, tenantId: auth.tenantId },
    include: { requisition: true },
  });
  if (!application) throw ApiError.notFound('Application');

  if (application.status !== 'OfferAccepted') {
    throw ApiError.unprocessable(
      `Application ${application.recordCode} is ${application.status}. Only an accepted offer can become a joining — ` +
        'the gap between accepting and starting is where a rescission or a no-show is recorded.',
    );
  }

  const employment = await hire({
    personId: application.candidatePartyId,
    positionId: application.requisition.positionId,
    hireEffectiveDate: input.hireEffectiveDate,
    legalEntity: input.legalEntity,
    noticePeriodDays: input.noticePeriodDays,
    branch: input.branch,
  });

  await transitionApplication(applicationId, 'JOIN', { note: `Joined as ${employment.recordCode}` });

  // The seat is filled and the requisition is satisfied. Both are consequences
  // of the joining, not separate decisions somebody has to remember to make.
  await transitionRequisition(application.requisitionId, 'FILL', `Filled by ${employment.recordCode}`).catch(() => {
    // A requisition already Filled or Closed by another joining is not an
    // error here — the hire itself has happened either way.
  });

  return employment;
}

/** The funnel, counted by bucket rather than by raw state. */
export async function hiringFunnel() {
  const auth = currentAuth();
  await assertScopeAll('requisitions');

  const rows = await prisma.application.groupBy({
    by: ['status'],
    where: { tenantId: auth.tenantId, deletedAt: null },
    _count: { _all: true },
  });

  const buckets: Record<string, number> = { open: 0, offer: 0, hired: 0, closed: 0 };
  for (const row of rows) {
    buckets[applicationFunnelBucket(row.status as ApplicationState)] += row._count._all;
  }

  return { byState: rows.map((r) => ({ status: r.status, count: r._count._all })), buckets };
}
