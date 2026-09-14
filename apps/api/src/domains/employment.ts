/**
 * Employment (Canon §14.2, §14.3, §14.5).
 *
 * The spine: org units, seats, the employment relationship itself, where
 * somebody sits and what they are paid, and the two sub-workflows that bracket
 * a working life.
 *
 * The standalone HRM build wrote PERSON and AFFILIATION directly, because it
 * had no identity plane to defer to. Here it does, so hiring somebody attaches
 * an employment relationship to the Person row they already had — as a
 * candidate, a student, a contact — and adds an employee affiliation beside
 * their existing ones. Nobody is entered twice.
 */

import {
  EVENTS,
  employmentRelationshipMachine,
  assignmentMachine,
  compensationRecordMachine,
  positionMachine,
  onboardingMachine,
  offboardingMachine,
  ABANDONMENT_SEPARATION_TYPE,
  PROMOTION_REVISION_REASON,
  EMPLOYMENT_EVENT_VERB,
  ASSIGNMENT_EVENT_VERB,
  COMPENSATION_EVENT_VERB,
  POSITION_EVENT_VERB,
  ONBOARDING_EVENT_VERB,
  OFFBOARDING_EVENT_VERB,
  isEmployed,
  type EmploymentState,
  type EmploymentEvent,
  type AssignmentRequestState,
  type AssignmentRequestEvent,
  type CompensationState,
  type CompensationEvent,
  type PositionState,
  type PositionEvent,
  type OnboardingState,
  type OnboardingEvent,
  type OffboardingState,
  type OffboardingEvent,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, canSeeMoney, assertScopeAll } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { raiseException } from '../platform/exceptions.js';
import { assertEmploymentVisible } from '../platform/recordScope.js';
import { normalisePhone, normaliseEmail } from './identity.js';

// ---------------------------------------------------------------------------
// Org structure
// ---------------------------------------------------------------------------

export async function listOrgUnits() {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'view' });
  return prisma.orgUnit.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
  });
}

export async function createOrgUnit(input: {
  name: string;
  unitType?: string;
  division?: string | null;
  parentId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'create' });
  return prisma.orgUnit.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      unitType: input.unitType ?? 'team',
      division: input.division ?? null,
      parentId: input.parentId ?? null,
    },
  });
}

export async function listJobs() {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'view' });
  return prisma.job.findMany({ where: { tenantId: auth.tenantId }, orderBy: { title: 'asc' } });
}

export async function createJob(input: { title: string; jobFamily: string; jobLevel: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'create' });
  return prisma.job.create({ data: { tenantId: auth.tenantId, ...input } });
}

export async function listPositions(filter: { status?: string; orgUnitId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'view' });
  return prisma.position.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.orgUnitId ? { orgUnitId: filter.orgUnitId } : {}),
    },
    include: { job: true, orgUnit: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createPosition(input: {
  orgUnitId: string;
  jobId: string;
  location?: string;
  reportingPositionId?: string | null;
  isLeadPosition?: boolean;
  budgetLineId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'positions', verb: 'create' });

  const recordCode = await nextRecordCode('POS');
  const position = await prisma.position.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      orgUnitId: input.orgUnitId,
      jobId: input.jobId,
      location: input.location ?? 'Head Office',
      reportingPositionId: input.reportingPositionId ?? null,
      isLeadPosition: input.isLeadPosition ?? false,
      budgetLineId: input.budgetLineId ?? null,
    },
  });

  await emit({
    name: EVENTS.POSITION_CREATED,
    subject: { entityType: 'position', entityId: position.id, recordCode },
    newState: { status: position.status, orgUnitId: input.orgUnitId, jobId: input.jobId },
    impact: { domains: ['hr'] },
  });

  return position;
}

export async function transitionPosition(id: string, event: PositionEvent, note?: string) {
  const auth = currentAuth();
  const position = await prisma.position.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!position) throw ApiError.notFound('Position');

  const result = await transition({
    machine: positionMachine,
    eventObject: 'position',
    verbs: POSITION_EVENT_VERB,
    resource: 'positions',
    subjectType: 'position',
    subjectId: id,
    recordCode: position.recordCode,
    from: position.status as PositionState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.position.update({ where: { id }, data: { status: result.to } });
}

// ---------------------------------------------------------------------------
// The employment relationship
// ---------------------------------------------------------------------------

export async function listEmployments(filter: { status?: string; orgUnitId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'view' });

  return prisma.employmentRelationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      person: { select: { id: true, fullName: true, primaryEmail: true, recordCode: true } },
      assignments: {
        where: { rowStatus: 'Effective' },
        include: { position: { include: { job: true, orgUnit: true } } },
        take: 1,
        orderBy: { effectiveFrom: 'desc' },
      },
    },
    orderBy: { hireEffectiveDate: 'desc' },
  });
}

export async function getEmployment(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'view' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: {
      person: true,
      assignments: { include: { position: { include: { job: true, orgUnit: true } } }, orderBy: { effectiveFrom: 'desc' } },
      leaveBalances: { include: { leaveType: true } },
      onboarding: true,
      offboarding: true,
      goals: { orderBy: { createdAt: 'desc' } },
      learningRecords: { include: { learningActivity: true } },
    },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment;
}

/**
 * Strips every field classified `regulated` from an employment record before
 * it reaches a response: the statutory identifiers on the employment itself
 * (PAN, Aadhaar, UAN) and, on the person underneath, `bloodGroup` — health
 * data under the DPDP Act. Structurally excluded rather than nulled, per the
 * schema's own documentation for these fields: a null still announces that
 * something is being withheld, and the exclusion contract calls for absence
 * from the response shape entirely.
 */
export function redactRegulatedEmploymentFields<
  T extends {
    panNumber?: unknown;
    aadhaarReference?: unknown;
    uanNumber?: unknown;
    person: { bloodGroup?: unknown };
  },
>(employment: T): T {
  return {
    ...employment,
    panNumber: undefined,
    aadhaarReference: undefined,
    uanNumber: undefined,
    person: { ...employment.person, bloodGroup: undefined },
  };
}

/**
 * Hiring. Creates the employment relationship in PendingHire, opens the
 * onboarding record, and adds the employee affiliation on the identity plane.
 *
 * The affiliation carries `statutoryRetentionFloor`, which is what stops the
 * dedup resolver from ever auto-merging an employee record away: the company
 * has a legal obligation to keep it that outlives its convenience.
 */
export async function hire(input: {
  personId: string;
  positionId: string;
  hireEffectiveDate: Date;
  legalEntity?: string;
  noticePeriodDays?: number;
  branch?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'create' });

  const person = await prisma.person.findFirst({ where: { id: input.personId, tenantId: auth.tenantId } });
  if (!person) throw ApiError.notFound('Person');

  const position = await prisma.position.findFirst({ where: { id: input.positionId, tenantId: auth.tenantId } });
  if (!position) throw ApiError.notFound('Position');

  // One live employment per person per legal entity. A rehire is a second row
  // opened after the first has ended, never an edit of the ended one.
  const legalEntity = input.legalEntity ?? 'Kaizen Infinities Pvt Ltd';
  const live = await prisma.employmentRelationship.findFirst({
    where: {
      tenantId: auth.tenantId,
      personId: input.personId,
      legalEntity,
      status: { in: ['PendingHire', 'Active', 'OnLeave', 'Suspended', 'NoticePeriod', 'Absconded'] },
    },
  });
  if (live) {
    throw ApiError.conflict(
      `${person.fullName} already holds a live employment (${live.recordCode}, ${live.status}) with ${legalEntity}.`,
      { employmentRelationshipId: live.id },
    );
  }

  const recordCode = await nextRecordCode('EMP');

  const employment = await prisma.$transaction(async (tx) => {
    const created = await tx.employmentRelationship.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        personId: input.personId,
        legalEntity,
        hireEffectiveDate: input.hireEffectiveDate,
        noticePeriodDays: input.noticePeriodDays ?? 30,
        confirmationState: 'in_probation',
      },
    });

    // The hire assignment. Effective from the hire date, and the reason code
    // says why the seat changed hands.
    await tx.assignment.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: created.id,
        positionId: input.positionId,
        reasonCode: 'Hire',
        requestStatus: 'Effective',
        rowStatus: 'Effective',
        effectiveFrom: input.hireEffectiveDate,
      },
    });

    await tx.onboarding.create({
      data: { tenantId: auth.tenantId, employmentRelationshipId: created.id },
    });

    await tx.affiliation.create({
      data: {
        tenantId: auth.tenantId,
        partyId: input.personId,
        affiliationType: 'employee',
        status: 'active',
        effectiveFrom: input.hireEffectiveDate,
        orgUnitId: position.orgUnitId,
        positionId: input.positionId,
        branch: input.branch ?? null,
        statutoryRetentionFloor: true,
      },
    });

    return created;
  });

  await emit({
    name: EVENTS.EMPLOYMENT_RELATIONSHIP_CREATED,
    subject: { entityType: 'employment_relationship', entityId: employment.id, recordCode },
    related: [
      { relation: 'employs', entityType: 'person', entityId: input.personId },
      { relation: 'fills', entityType: 'position', entityId: input.positionId },
    ],
    newState: { status: employment.status, hireEffectiveDate: input.hireEffectiveDate, legalEntity },
    owner: { partyId: input.personId },
    impact: { domains: ['hr', 'idn'] },
  });

  await emit({
    name: EVENTS.ONBOARDING_INITIATED,
    subject: { entityType: 'onboarding', entityId: employment.id },
    related: [{ relation: 'onboards', entityType: 'employment_relationship', entityId: employment.id }],
    newState: { status: 'Initiated' },
    impact: { domains: ['hr'] },
  });

  return employment;
}

export interface EmploymentTransitionInput {
  separationType?: string | null;
  rehireEligible?: boolean | null;
  rehireIneligibleReason?: string | null;
  note?: string | null;
}

/**
 * Every move along Diagram 14.1.
 *
 * Two rules live here rather than in the machine, because they read more than
 * the current state: a separation must say what kind it was, and an
 * abandonment confirmation is always the abandonment kind — Absconded resolves
 * into Terminated with that reason, never into Alumni directly.
 */
export async function transitionEmployment(
  id: string,
  event: EmploymentEvent,
  input: EmploymentTransitionInput = {},
) {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const from = employment.status as EmploymentState;

  const separating =
    event === 'TERMINATE_POST_DISCIPLINARY' ||
    event === 'REACH_LAST_WORKING_DAY' ||
    event === 'ABANDONMENT_CONFIRMED';

  let separationType = employment.separationType;
  if (separating) {
    separationType =
      event === 'ABANDONMENT_CONFIRMED'
        ? ABANDONMENT_SEPARATION_TYPE
        : event === 'REACH_LAST_WORKING_DAY'
          ? (input.separationType ?? 'resignation')
          : (input.separationType ?? 'termination');
  }

  const result = await transition({
    machine: employmentRelationshipMachine,
    eventObject: 'employment',
    verbs: EMPLOYMENT_EVENT_VERB,
    resource: 'employees',
    subjectType: 'employment_relationship',
    subjectId: id,
    recordCode: employment.recordCode,
    ownerPartyId: employment.personId,
    from,
    event,
    detail: separating ? { separationType } : undefined,
    reasonNote: input.note ?? null,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.employmentRelationship.update({
      where: { id },
      data: {
        status: result.to,
        ...(separating
          ? {
              separationType,
              separationDate: new Date(),
              rehireEligible: input.rehireEligible ?? null,
              rehireIneligibleReason: input.rehireIneligibleReason ?? null,
            }
          : {}),
      },
    });

    // Resigning opens the offboarding workflow; the notice period is where it
    // starts, not the last working day.
    if (event === 'SUBMIT_RESIGNATION') {
      const existing = await tx.offboarding.findUnique({ where: { employmentRelationshipId: id } });
      if (!existing) {
        await tx.offboarding.create({
          data: { tenantId: auth.tenantId, employmentRelationshipId: id, status: 'NoticePeriodActive' },
        });
      }
    }

    // Leaving for any reason ends the employee affiliation. Access follows the
    // affiliation, so this is what actually removes their reach.
    if (!isEmployed(result.to)) {
      await tx.affiliation.updateMany({
        where: { tenantId: auth.tenantId, partyId: row.personId, affiliationType: 'employee', status: 'active' },
        data: { status: 'ended', effectiveTo: new Date() },
      });
    }

    return row;
  });

  if (event === 'SUBMIT_RESIGNATION') {
    await emit({
      name: EVENTS.OFFBOARDING_INITIATED,
      subject: { entityType: 'offboarding', entityId: id },
      related: [{ relation: 'offboards', entityType: 'employment_relationship', entityId: id }],
      newState: { status: 'NoticePeriodActive', noticePeriodDays: employment.noticePeriodDays },
      impact: { domains: ['hr'] },
    });
  }

  // An absence breach is a fact the company has to act on within a window, so
  // it is raised as an exception rather than left as a status somebody might
  // notice.
  if (event === 'ABSENCE_BREACH') {
    await raiseException({
      code: 'EX-HR-001',
      label: 'Unexplained absence breach',
      severity: 'S3_HIGH_RISK',
      subjectType: 'employment_relationship',
      subjectId: id,
      subjectLabel: employment.recordCode,
      detail:
        'The absence threshold was crossed. This resolves either by accepting an explanation or by ' +
        'confirming abandonment — it does not lapse on its own.',
      ownerPartyId: employment.personId,
      triggerFingerprint: `absence_breach:${id}`,
      ladderRung: 1,
    });
  }

  return updated;
}

export async function setConfirmationState(id: string, state: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'edit' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const updated = await prisma.employmentRelationship.update({
    where: { id },
    data: { confirmationState: state },
  });

  await emit({
    name: EVENTS.EMPLOYMENT_CONFIRMATION_CHANGED,
    subject: { entityType: 'employment_relationship', entityId: id, recordCode: employment.recordCode },
    previousState: { confirmationState: employment.confirmationState },
    newState: { confirmationState: state },
    reason: note ? { reasonCode: 'confirmation_change', note } : null,
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

export interface EmployeeProfileInput {
  fullName?: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  dateOfBirth?: string | null;
}

/**
 * The underlying person's plain identity fields — name, phone, email, date of
 * birth. Deliberately narrow: everything else on `EmploymentRelationship` is
 * governed by its own lifecycle transition (`transitionEmployment`,
 * `setConfirmationState`) or is `regulated` and structurally excluded from
 * every projection (PAN, Aadhaar, UAN; `Person.bloodGroup`). This is the
 * correction path for exactly what a staff-list import writes and sometimes
 * gets wrong, and nothing more.
 */
export async function updateEmployeeProfile(employmentId: string, input: EmployeeProfileInput) {
  const auth = currentAuth();
  // Coarse first, so a caller holding no grant at all is refused before the
  // lookup and the id cannot be used as an existence oracle.
  await assertCan({ resource: 'employees', verb: 'edit' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentId, tenantId: auth.tenantId },
    include: { person: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  // Then again against whose record this is. `employees:edit` is held at
  // `@own` by the employee role, and the WHERE axis only narrows a scope when
  // a record is actually supplied — without this, self-service would let
  // anybody rewrite a colleague's name, phone or email.
  await assertCan({ resource: 'employees', verb: 'edit', record: { ownerPartyId: employment.personId } });

  const before = {
    fullName: employment.person.fullName,
    primaryPhone: employment.person.primaryPhone,
    primaryEmail: employment.person.primaryEmail,
  };

  const updated = await prisma.person.update({
    where: { id: employment.personId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.primaryPhone !== undefined
        ? { primaryPhone: input.primaryPhone, primaryPhoneNormalised: normalisePhone(input.primaryPhone) }
        : {}),
      ...(input.primaryEmail !== undefined
        ? { primaryEmail: input.primaryEmail, primaryEmailNormalised: normaliseEmail(input.primaryEmail) }
        : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'person',
    subjectId: employment.personId,
    before,
    after: { fullName: updated.fullName, primaryPhone: updated.primaryPhone, primaryEmail: updated.primaryEmail },
  });

  return getEmployment(employmentId);
}

// ---------------------------------------------------------------------------
// Assignments and compensation
// ---------------------------------------------------------------------------

export async function proposeAssignment(input: {
  employmentRelationshipId: string;
  positionId: string;
  managerPositionId?: string | null;
  reasonCode: string;
  effectiveFrom: Date;
  correlationId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'assignments', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const assignment = await prisma.assignment.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      positionId: input.positionId,
      managerPositionId: input.managerPositionId ?? null,
      reasonCode: input.reasonCode,
      requestStatus: 'Draft',
      rowStatus: 'Effective',
      effectiveFrom: input.effectiveFrom,
      correlationId: input.correlationId ?? null,
    },
  });

  await emit({
    name: EVENTS.ASSIGNMENT_CREATED,
    subject: { entityType: 'assignment', entityId: assignment.id },
    related: [
      { relation: 'assigns', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      { relation: 'to', entityType: 'position', entityId: input.positionId },
    ],
    newState: { status: 'Draft', reasonCode: input.reasonCode, effectiveFrom: input.effectiveFrom },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return assignment;
}

/**
 * Activating an assignment supersedes the one it replaces — closing its
 * effective range on the new one's start date rather than deleting it, so the
 * question "where did they sit last March" stays answerable.
 */
export async function transitionAssignment(id: string, event: AssignmentRequestEvent, note?: string) {
  const auth = currentAuth();
  const assignment = await prisma.assignment.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!assignment) throw ApiError.notFound('Assignment');

  const result = await transition({
    machine: assignmentMachine,
    eventObject: 'assignment',
    verbs: ASSIGNMENT_EVENT_VERB,
    resource: 'assignments',
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'assignment',
    subjectId: id,
    ownerPartyId: assignment.employmentRelationship.personId,
    from: assignment.requestStatus as AssignmentRequestState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.$transaction(async (tx) => {
    if (event === 'ACTIVATE') {
      await tx.assignment.updateMany({
        where: {
          tenantId: auth.tenantId,
          employmentRelationshipId: assignment.employmentRelationshipId,
          rowStatus: 'Effective',
          id: { not: id },
        },
        data: { rowStatus: 'Superseded', effectiveTo: assignment.effectiveFrom },
      });
      await tx.position.update({ where: { id: assignment.positionId }, data: { status: 'Filled' } });
    }

    return tx.assignment.update({ where: { id }, data: { requestStatus: result.to } });
  });
}

/**
 * A pay change. The promotion linkage constraint of §14.5 is enforced here:
 * a change whose reason is a promotion must name the assignment that promoted
 * them, and the two share a correlation id. A promotion that moved the money
 * but not the seat is the failure this prevents.
 */
export async function proposeCompensation(input: {
  employmentRelationshipId: string;
  revisionReason: string;
  amount: number;
  basicPay?: number | null;
  effectiveFrom: Date;
  linkedAssignmentId?: string | null;
  currency?: string;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'compensation', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  if (input.revisionReason === PROMOTION_REVISION_REASON && !input.linkedAssignmentId) {
    throw ApiError.unprocessable(
      'A promotion pay change must name the assignment that promoted them [Canon §14.5]. ' +
        'Raise the assignment first, then link this record to it.',
    );
  }

  let correlationId: string | null = null;
  if (input.linkedAssignmentId) {
    const linked = await prisma.assignment.findFirst({
      where: { id: input.linkedAssignmentId, tenantId: auth.tenantId },
    });
    if (!linked) throw ApiError.notFound('Linked assignment');
    if (linked.employmentRelationshipId !== input.employmentRelationshipId) {
      throw ApiError.unprocessable('The linked assignment belongs to a different employment relationship.');
    }
    // One correlation id across both records, so the promotion reads as one
    // decision in the event log rather than two coincidences.
    correlationId = linked.correlationId ?? linked.id;
    if (!linked.correlationId) {
      await prisma.assignment.update({ where: { id: linked.id }, data: { correlationId } });
    }
  }

  const record = await prisma.compensationRecord.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      revisionReason: input.revisionReason,
      amount: input.amount,
      basicPay: input.basicPay ?? null,
      currency: input.currency ?? 'INR',
      effectiveFrom: input.effectiveFrom,
      linkedAssignmentId: input.linkedAssignmentId ?? null,
      correlationId,
    },
  });

  await emit({
    name: EVENTS.COMPENSATION_RECORD_CREATED,
    subject: { entityType: 'compensation_record', entityId: record.id },
    related: [
      { relation: 'pays', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      ...(input.linkedAssignmentId
        ? [{ relation: 'promotes_via', entityType: 'assignment', entityId: input.linkedAssignmentId }]
        : []),
    ],
    newState: { status: 'Proposed', revisionReason: input.revisionReason, effectiveFrom: input.effectiveFrom },
    owner: { partyId: employment.personId },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });

  return record;
}

export async function transitionCompensation(id: string, event: CompensationEvent, note?: string) {
  const auth = currentAuth();
  const record = await prisma.compensationRecord.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!record) throw ApiError.notFound('Compensation record');

  // The self-dealing bar, on pay.
  //
  // Sixteen roles kept a pay rise a two-party act by construction: hr_ops
  // proposed and had no `approve`, so somebody else always signed. With three
  // roles the Finance Head holds both verbs, and without this the operating
  // authority could raise its own salary alone — the single most obvious way
  // for an ERP's permission model to be quietly worthless.
  //
  // Approval of your own compensation is refused outright rather than routed,
  // and the chairman signs instead. It is a bar, not a ceiling: no value makes
  // it acceptable.
  const isSelf = record.employmentRelationship.personId === auth.partyId;
  if (isSelf && (event === 'APPROVE' || event === 'REJECT')) {
    throw ApiError.forbidden(
      'A compensation record about you cannot be approved by you, at any amount. Somebody else — the chairman, if nobody else holds it — has to sign this one.',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' }],
    );
  }

  const result = await transition({
    machine: compensationRecordMachine,
    eventObject: 'compensation',
    verbs: COMPENSATION_EVENT_VERB,
    resource: 'compensation',
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'compensation_record',
    subjectId: id,
    ownerPartyId: record.employmentRelationship.personId,
    from: record.status as CompensationState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.$transaction(async (tx) => {
    if (event === 'ACTIVATE') {
      await tx.compensationRecord.updateMany({
        where: {
          tenantId: auth.tenantId,
          employmentRelationshipId: record.employmentRelationshipId,
          status: 'Effective',
          id: { not: id },
        },
        data: { status: 'Superseded', effectiveTo: record.effectiveFrom },
      });
    }
    return tx.compensationRecord.update({ where: { id }, data: { status: result.to } });
  });
}

/** The pay in force on a date — what payroll reads, and what a cost cut sums. */
export async function currentCompensation(employmentRelationshipId: string, asOf = new Date()) {
  const auth = currentAuth();
  // Somebody's salary, so it is gated like any other pay figure — and gated
  // against the person it is about, not merely against the resource. Asserting
  // the grant alone left an employment id as a side door onto a colleague's
  // pay for anybody holding `compensation:V@own`.
  await assertEmploymentVisible('compensation', employmentRelationshipId);

  return prisma.compensationRecord.findFirst({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      status: 'Effective',
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Onboarding and offboarding
// ---------------------------------------------------------------------------

export async function transitionOnboarding(id: string, event: OnboardingEvent, note?: string) {
  const auth = currentAuth();
  const record = await prisma.onboarding.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!record) throw ApiError.notFound('Onboarding');

  const result = await transition({
    machine: onboardingMachine,
    eventObject: 'onboarding',
    verbs: ONBOARDING_EVENT_VERB,
    resource: 'employees',
    subjectType: 'onboarding',
    subjectId: id,
    ownerPartyId: record.employmentRelationship.personId,
    from: record.status as OnboardingState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.onboarding.update({
    where: { id },
    data: { status: result.to, blockedReason: event === 'ESCALATE' ? (note ?? 'escalated') : null },
  });
}

export async function transitionOffboarding(id: string, event: OffboardingEvent, note?: string) {
  const auth = currentAuth();
  const record = await prisma.offboarding.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!record) throw ApiError.notFound('Offboarding');

  const result = await transition({
    machine: offboardingMachine,
    eventObject: 'offboarding',
    verbs: OFFBOARDING_EVENT_VERB,
    resource: 'employees',
    subjectType: 'offboarding',
    subjectId: id,
    ownerPartyId: record.employmentRelationship.personId,
    from: record.status as OffboardingState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.offboarding.update({
    where: { id },
    data: { status: result.to, disputeReason: event === 'DISPUTE' ? (note ?? 'disputed') : null },
  });
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * A probation that nobody closed. The confirmation date passes silently
 * otherwise: the employee stays "in probation" indefinitely, which is a real
 * exposure for them and a paperwork failure for the company.
 */
export async function detectOverdueConfirmations(probationMonths = 6): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - probationMonths);

  const overdue = await prisma.employmentRelationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: 'Active',
      confirmationState: 'in_probation',
      hireEffectiveDate: { lt: cutoff },
    },
    include: { person: { select: { fullName: true } } },
    take: 200,
  });

  for (const employment of overdue) {
    await raiseException({
      code: 'EX-HR-002',
      label: 'Probation confirmation overdue',
      severity: 'S1_ATTENTION',
      subjectType: 'employment_relationship',
      subjectId: employment.id,
      subjectLabel: `${employment.recordCode} — ${employment.person.fullName}`,
      detail: `Hired ${employment.hireEffectiveDate.toISOString().slice(0, 10)}; still in probation after ${probationMonths} months.`,
      ownerPartyId: employment.personId,
      triggerFingerprint: `probation_overdue:${employment.id}`,
      ladderRung: 1,
    });
  }

  return overdue.length;
}

/**
 * Somebody working without a pay record in force. Payroll would compute a zero
 * for them, which is the kind of error that only surfaces on payday.
 */
export async function detectMissingCompensation(): Promise<number> {
  const auth = currentAuth();
  const now = new Date();

  const active = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
    include: { person: { select: { fullName: true } } },
    take: 500,
  });

  let raised = 0;
  for (const employment of active) {
    const pay = await prisma.compensationRecord.findFirst({
      where: {
        tenantId: auth.tenantId,
        employmentRelationshipId: employment.id,
        status: 'Effective',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
    });
    if (pay) continue;

    await raiseException({
      code: 'EX-HR-003',
      label: 'Active employee with no compensation in force',
      severity: 'S2_WARNING',
      subjectType: 'employment_relationship',
      subjectId: employment.id,
      subjectLabel: `${employment.recordCode} — ${employment.person.fullName}`,
      detail: 'No compensation record is Effective as of today, so a payroll run would compute nothing for them.',
      ownerPartyId: employment.personId,
      triggerFingerprint: `no_compensation:${employment.id}`,
      ladderRung: 1,
    });
    raised += 1;
  }

  return raised;
}

/**
 * Headcount and monthly pay cost, by division. Read by the Command Center.
 *
 * A line manager can see how many people sit in each division without being
 * able to see what they cost, so the cost is withheld rather than the whole
 * rollup being refused: `monthlyCost` comes back null, and the surface says
 * so, instead of showing a zero that reads as "nobody is paid anything".
 */
export async function headcountByDivision(asOf = new Date()) {
  const auth = currentAuth();
  await assertScopeAll('employees');
  const money = await canSeeMoney('compensation');

  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
    include: {
      assignments: {
        where: { rowStatus: 'Effective' },
        include: { position: { include: { orgUnit: true } } },
        take: 1,
        orderBy: { effectiveFrom: 'desc' },
      },
    },
  });

  const pay = money
    ? await prisma.compensationRecord.findMany({
        where: {
          tenantId: auth.tenantId,
          employmentRelationshipId: { in: employments.map((e) => e.id) },
          status: 'Effective',
          effectiveFrom: { lte: asOf },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
        },
        select: { employmentRelationshipId: true, amount: true },
      })
    : [];
  const payByEmployment = new Map(pay.map((p) => [p.employmentRelationshipId, num(p.amount) ?? 0]));

  const rows = new Map<string, { division: string; headcount: number; monthlyCost: number | null }>();
  for (const employment of employments) {
    const division = employment.assignments[0]?.position.orgUnit.division ?? 'shared';
    const row = rows.get(division) ?? { division, headcount: 0, monthlyCost: money ? 0 : null };
    row.headcount += 1;
    if (money) row.monthlyCost = (row.monthlyCost ?? 0) + (payByEmployment.get(employment.id) ?? 0);
    rows.set(division, row);
  }

  return [...rows.values()].sort((a, b) => b.headcount - a.headcount);
}
