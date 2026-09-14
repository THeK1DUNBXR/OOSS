/**
 * HCM — WS1 workforce (docs/hcm/workforce.md).
 *
 * Employee master extensions (personal record, documents), reporting lines
 * and the org chart they derive, org design (cost centres, locations,
 * grades) and employee status changes (transfer/promotion/demotion/
 * redesignation) proposed then decided under the Self-Dealing Bar then
 * applied.
 */

import {
  buildOrgTree,
  canTransitionStatusChange,
  maskRegulatedId,
  statusChangeDiff,
  type EmployeeDocumentKind,
  type EmployeeStatusChangeKind,
  type EmployeeStatusChangeState,
  type OrgChartPersonFact,
  type ReportingLineKind,
  type StatusChangeTarget,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';

registerGovernedEntities('hcm_workforce', [
  'employee_profile_extension',
  'employee_document',
  'reporting_line',
  'cost_centre',
  'location',
  'grade',
  'employee_status_change',
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function requireEmployment(employmentRelationshipId: string) {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId, deletedAt: null },
    select: { id: true, personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment;
}

// ---------------------------------------------------------------------------
// Employee profile extension
// ---------------------------------------------------------------------------

export interface ProfileExtensionInput {
  gender?: string | null;
  maritalStatus?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  passportExpiry?: Date | null;
  emergencyContacts?: Array<{ name: string; relationship: string; phone: string }>;
  currentAddress?: Record<string, unknown> | null;
  permanentAddress?: Record<string, unknown> | null;
  educationHistory?: Array<Record<string, unknown>>;
  previousEmployment?: Array<Record<string, unknown>>;
  dependants?: Array<Record<string, unknown>>;
}

/**
 * `passportNumber` is a regulated field: masked to the last four characters
 * for any caller who is not looking at their own record and does not hold
 * `employee_profiles:view` at `all` scope.
 */
function redactProfileExtension<T extends { passportNumber: string | null }>(row: T, canSeeFull: boolean): T {
  if (canSeeFull) return row;
  return { ...row, passportNumber: maskRegulatedId(row.passportNumber) };
}

async function canSeeFullProfile(personId: string): Promise<boolean> {
  const auth = currentAuth();
  if (auth.partyId === personId) return true;
  const scope = await scopeFor('employee_profiles', 'view');
  return scope === 'all';
}

export async function getProfileExtension(employmentRelationshipId: string) {
  await assertCan({ resource: 'employee_profiles', verb: 'view' });
  const employment = await requireEmployment(employmentRelationshipId);
  const row = await prisma.employeeProfileExtension.findUnique({
    where: { employmentRelationshipId },
  });
  if (!row) return null;
  return redactProfileExtension(row, await canSeeFullProfile(employment.personId));
}

export async function upsertProfileExtension(employmentRelationshipId: string, input: ProfileExtensionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_profiles', verb: 'edit' });
  const employment = await requireEmployment(employmentRelationshipId);

  // `employee_profiles:edit` is held at `@own` by the employee role — the
  // WHERE axis only narrows when a record is supplied.
  await assertCan({ resource: 'employee_profiles', verb: 'edit', record: { ownerPartyId: employment.personId } });

  const before = await prisma.employeeProfileExtension.findUnique({ where: { employmentRelationshipId } });

  const data = {
    tenantId: auth.tenantId,
    employmentRelationshipId,
    gender: input.gender ?? before?.gender ?? null,
    maritalStatus: input.maritalStatus ?? before?.maritalStatus ?? null,
    nationality: input.nationality ?? before?.nationality ?? null,
    passportNumber: input.passportNumber !== undefined ? input.passportNumber : before?.passportNumber ?? null,
    passportExpiry: input.passportExpiry !== undefined ? input.passportExpiry : before?.passportExpiry ?? null,
    emergencyContacts: (input.emergencyContacts ?? before?.emergencyContacts ?? []) as never,
    currentAddress: (input.currentAddress !== undefined ? input.currentAddress : before?.currentAddress ?? null) as never,
    permanentAddress: (input.permanentAddress !== undefined ? input.permanentAddress : before?.permanentAddress ?? null) as never,
    educationHistory: (input.educationHistory ?? before?.educationHistory ?? []) as never,
    previousEmployment: (input.previousEmployment ?? before?.previousEmployment ?? []) as never,
    dependants: (input.dependants ?? before?.dependants ?? []) as never,
  };

  const row = await prisma.employeeProfileExtension.upsert({
    where: { employmentRelationshipId },
    create: data,
    update: data,
  });

  await auditWrite({
    action: before ? 'update' : 'create',
    subjectType: 'employee_profile_extension',
    subjectId: row.id,
    before: before as never,
    after: row as never,
  });
  await emit({
    name: 'kz.hr.employee_profile.updated',
    subject: { entityType: 'employee_profile_extension', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: employmentRelationshipId }],
    newState: { employmentRelationshipId },
  });

  return redactProfileExtension(row, await canSeeFullProfile(employment.personId));
}

// ---------------------------------------------------------------------------
// Employee documents
// ---------------------------------------------------------------------------

export interface UploadDocumentInput {
  kind: EmployeeDocumentKind;
  filename: string;
  mimeType: string;
  content: string;
  expiresOn?: Date | null;
}

export async function listEmployeeDocuments(employmentRelationshipId: string) {
  await assertCan({ resource: 'employee_documents', verb: 'view' });
  const employment = await requireEmployment(employmentRelationshipId);
  await assertCan({ resource: 'employee_documents', verb: 'view', record: { ownerPartyId: employment.personId } });

  const rows = await prisma.employeeDocument.findMany({
    where: { employmentRelationshipId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  // Content is never listed — a document's bytes are fetched one at a time,
  // never bundled into a browse response.
  return rows.map(({ content: _content, ...rest }) => rest);
}

export async function uploadEmployeeDocument(employmentRelationshipId: string, input: UploadDocumentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_documents', verb: 'create' });
  const employment = await requireEmployment(employmentRelationshipId);
  await assertCan({ resource: 'employee_documents', verb: 'create', record: { ownerPartyId: employment.personId } });

  const row = await prisma.employeeDocument.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
      expiresOn: input.expiresOn ?? null,
      uploadedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'employee_document', subjectId: row.id, after: { ...row, content: '[redacted]' } as never });
  await emit({
    name: 'kz.hr.employee_document.uploaded',
    subject: { entityType: 'employee_document', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: employmentRelationshipId }],
    newState: { kind: row.kind, filename: row.filename },
  });

  const { content: _content, ...rest } = row;
  return rest;
}

export async function verifyEmployeeDocument(id: string, note?: string) {
  const auth = currentAuth();
  // Verification is a distinct act from upload and needs the edit grant,
  // which the employee role does not hold on this resource at all — the
  // grant table alone keeps someone from verifying their own paperwork.
  await assertCan({ resource: 'employee_documents', verb: 'edit' });

  const before = await prisma.employeeDocument.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!before) throw ApiError.notFound('Employee document');
  if (before.verified) throw ApiError.badRequest('This document is already verified.');

  const row = await prisma.employeeDocument.update({
    where: { id },
    data: { verified: true, verifiedById: auth.partyId, verifiedAt: new Date() },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'employee_document',
    subjectId: id,
    before: { ...before, content: '[redacted]' } as never,
    after: { ...row, content: '[redacted]' } as never,
  });
  await emit({
    name: 'kz.hr.employee_document.verified',
    subject: { entityType: 'employee_document', entityId: id },
    newState: { verified: true, note: note ?? null },
  });

  const { content: _content, ...rest } = row;
  return rest;
}

export async function getEmployeeDocumentContent(id: string) {
  await assertCan({ resource: 'employee_documents', verb: 'view' });
  const auth = currentAuth();
  const row = await prisma.employeeDocument.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Employee document');
  const employment = await requireEmployment(row.employmentRelationshipId);
  await assertCan({ resource: 'employee_documents', verb: 'view', record: { ownerPartyId: employment.personId } });
  return row;
}

// ---------------------------------------------------------------------------
// Reporting lines & org chart
// ---------------------------------------------------------------------------

export interface SetReportingLineInput {
  employmentRelationshipId: string;
  managerEmploymentRelationshipId: string;
  kind?: ReportingLineKind;
  effectiveFrom?: Date;
}

export async function listReportingLines(employmentRelationshipId: string) {
  await assertCan({ resource: 'reporting_lines', verb: 'view' });
  const employment = await requireEmployment(employmentRelationshipId);
  await assertCan({ resource: 'reporting_lines', verb: 'view', record: { ownerPartyId: employment.personId } });

  const [asEmployee, asManager] = await Promise.all([
    prisma.reportingLine.findMany({ where: { employmentRelationshipId }, orderBy: { effectiveFrom: 'desc' } }),
    prisma.reportingLine.findMany({
      where: { managerEmploymentRelationshipId: employmentRelationshipId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  return { manages: asEmployee, directReports: asManager };
}

export async function setReportingLine(input: SetReportingLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'reporting_lines', verb: 'create' });

  if (input.employmentRelationshipId === input.managerEmploymentRelationshipId) {
    throw ApiError.badRequest('An employment cannot report to itself.');
  }
  await requireEmployment(input.employmentRelationshipId);
  await requireEmployment(input.managerEmploymentRelationshipId);

  const kind = input.kind ?? 'primary';
  const effectiveFrom = input.effectiveFrom ?? new Date();

  const previous = await prisma.reportingLine.findFirst({
    where: { employmentRelationshipId: input.employmentRelationshipId, kind, effectiveTo: null },
  });

  const row = await prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.reportingLine.update({ where: { id: previous.id }, data: { effectiveTo: effectiveFrom } });
    }
    return tx.reportingLine.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: input.employmentRelationshipId,
        managerEmploymentRelationshipId: input.managerEmploymentRelationshipId,
        kind,
        effectiveFrom,
        createdById: auth.partyId,
      },
    });
  });

  await auditWrite({
    action: 'create',
    subjectType: 'reporting_line',
    subjectId: row.id,
    before: previous as never,
    after: row as never,
  });
  await emit({
    name: 'kz.hr.reporting_line.changed',
    subject: { entityType: 'reporting_line', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    previousState: previous ? { managerEmploymentRelationshipId: previous.managerEmploymentRelationshipId } : null,
    newState: { managerEmploymentRelationshipId: input.managerEmploymentRelationshipId, kind },
  });

  return row;
}

/** The whole tenant's current primary-line tree, for `/org-chart`. */
export async function orgChart() {
  await assertCan({ resource: 'org_design', verb: 'view' });
  const auth = currentAuth();

  const [employments, lines] = await Promise.all([
    prisma.employmentRelationship.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['Active', 'OnNotice'] } },
      include: {
        person: { select: { fullName: true } },
        assignments: {
          where: { rowStatus: 'Effective' },
          include: { position: { include: { job: true, orgUnit: true } } },
          take: 1,
          orderBy: { effectiveFrom: 'desc' },
        },
      },
    }),
    prisma.reportingLine.findMany({
      where: { tenantId: auth.tenantId, kind: 'primary', effectiveTo: null },
    }),
  ]);

  const managerOf = new Map(lines.map((l) => [l.employmentRelationshipId, l.managerEmploymentRelationshipId]));

  const facts: OrgChartPersonFact[] = employments.map((e) => {
    const assignment = e.assignments[0];
    return {
      employmentRelationshipId: e.id,
      managerEmploymentRelationshipId: managerOf.get(e.id) ?? null,
      fullName: e.person.fullName,
      title: assignment?.position.job.title ?? null,
      orgUnitName: assignment?.position.orgUnit.name ?? null,
    };
  });

  return buildOrgTree(facts);
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export interface DirectoryFilter {
  q?: string;
  orgUnitId?: string;
  status?: string;
}

export async function directorySearch(filter: DirectoryFilter = {}) {
  await assertCan({ resource: 'employee_profiles', verb: 'view' });
  const auth = currentAuth();

  const employments = await prisma.employmentRelationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q
        ? { person: { fullName: { contains: filter.q, mode: 'insensitive' } } }
        : {}),
      ...(filter.orgUnitId
        ? { assignments: { some: { rowStatus: 'Effective', position: { orgUnitId: filter.orgUnitId } } } }
        : {}),
    },
    include: {
      person: { select: { id: true, fullName: true, primaryEmail: true, primaryPhone: true } },
      assignments: {
        where: { rowStatus: 'Effective' },
        include: { position: { include: { job: true, orgUnit: true } } },
        take: 1,
        orderBy: { effectiveFrom: 'desc' },
      },
    },
    orderBy: { person: { fullName: 'asc' } },
    take: 200,
  });

  const locationRows = await prisma.locationAssignment.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId: { in: employments.map((e) => e.id) }, effectiveTo: null },
  });
  const locationIds = [...new Set(locationRows.map((l) => l.locationId))];
  const locations = locationIds.length
    ? await prisma.location.findMany({ where: { id: { in: locationIds } } })
    : [];
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const locationByEmployment = new Map(locationRows.map((l) => [l.employmentRelationshipId, locationById.get(l.locationId) ?? null]));

  return employments.map((e) => {
    const assignment = e.assignments[0];
    return {
      employmentRelationshipId: e.id,
      recordCode: e.recordCode,
      status: e.status,
      person: e.person,
      title: assignment?.position.job.title ?? null,
      orgUnit: assignment?.position.orgUnit.name ?? null,
      location: locationByEmployment.get(e.id) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Employee 360 — the aggregate view
// ---------------------------------------------------------------------------

export async function employee360(employmentRelationshipId: string) {
  await assertCan({ resource: 'employee_profiles', verb: 'view' });
  const auth = currentAuth();

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId, deletedAt: null },
    include: {
      person: true,
      assignments: { include: { position: { include: { job: true, orgUnit: true } } }, orderBy: { effectiveFrom: 'desc' } },
    },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  await assertCan({ resource: 'employee_profiles', verb: 'view', record: { ownerPartyId: employment.personId } });
  const canSeeFull = await canSeeFullProfile(employment.personId);

  const [profile, documents, reportingLines, gradeAssignment, costCentreAssignment, locationAssignment, statusChanges] =
    await Promise.all([
      prisma.employeeProfileExtension.findUnique({ where: { employmentRelationshipId } }),
      prisma.employeeDocument.findMany({
        where: { employmentRelationshipId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, kind: true, filename: true, mimeType: true, verified: true,
          verifiedAt: true, expiresOn: true, createdAt: true,
        },
      }),
      listReportingLines(employmentRelationshipId),
      prisma.gradeAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
      prisma.costCentreAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
      prisma.locationAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
      prisma.employeeStatusChange.findMany({ where: { employmentRelationshipId }, orderBy: { createdAt: 'desc' } }),
    ]);

  const [grade, costCentre, location, managerNames] = await Promise.all([
    gradeAssignment ? prisma.grade.findUnique({ where: { id: gradeAssignment.gradeId } }) : null,
    costCentreAssignment ? prisma.costCentre.findUnique({ where: { id: costCentreAssignment.costCentreId } }) : null,
    locationAssignment ? prisma.location.findUnique({ where: { id: locationAssignment.locationId } }) : null,
    Promise.all(
      reportingLines.manages
        .filter((l) => l.effectiveTo === null)
        .map(async (l) => {
          const mgr = await prisma.employmentRelationship.findFirst({
            where: { id: l.managerEmploymentRelationshipId },
            include: { person: { select: { fullName: true } } },
          });
          return { line: l, managerName: mgr?.person.fullName ?? null };
        }),
    ),
  ]);

  const directReportNames = await Promise.all(
    reportingLines.directReports.map(async (l) => {
      const rep = await prisma.employmentRelationship.findFirst({
        where: { id: l.employmentRelationshipId },
        include: { person: { select: { fullName: true } } },
      });
      return { line: l, name: rep?.person.fullName ?? null };
    }),
  );

  return {
    employment: {
      id: employment.id,
      recordCode: employment.recordCode,
      status: employment.status,
      confirmationState: employment.confirmationState,
      hireEffectiveDate: employment.hireEffectiveDate,
      engagementType: employment.engagementType,
      legalEntity: employment.legalEntity,
    },
    person: {
      id: employment.person.id,
      fullName: employment.person.fullName,
      primaryEmail: employment.person.primaryEmail,
      primaryPhone: employment.person.primaryPhone,
      recordCode: employment.person.recordCode,
      // dateOfBirth/bloodGroup are regulated on Person and excluded here
      // exactly as `redactRegulatedEmploymentFields` excludes them elsewhere.
    },
    currentAssignment: employment.assignments.find((a) => a.rowStatus === 'Effective') ?? null,
    profile: profile ? redactProfileExtension(profile, canSeeFull) : null,
    documents,
    org: {
      managers: managerNames,
      directReports: directReportNames,
      grade,
      costCentre,
      location,
    },
    statusChanges,
  };
}

// ---------------------------------------------------------------------------
// Org design — cost centres, locations, grades
// ---------------------------------------------------------------------------

export async function listCostCentres() {
  await assertCan({ resource: 'org_design', verb: 'view' });
  const auth = currentAuth();
  return prisma.costCentre.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { code: 'asc' } });
}

export async function createCostCentre(input: { code: string; name: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'org_design', verb: 'create' });
  const row = await prisma.costCentre.create({ data: { tenantId: auth.tenantId, code: input.code, name: input.name } });
  await auditWrite({ action: 'create', subjectType: 'cost_centre', subjectId: row.id, after: row as never });
  return row;
}

export async function listLocations() {
  await assertCan({ resource: 'org_design', verb: 'view' });
  const auth = currentAuth();
  return prisma.location.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
}

export async function createLocation(input: {
  name: string;
  kind?: string;
  city?: string | null;
  state?: string | null;
  address?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'org_design', verb: 'create' });
  const row = await prisma.location.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      kind: input.kind ?? 'office',
      city: input.city ?? null,
      state: input.state ?? null,
      address: input.address ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'location', subjectId: row.id, after: row as never });
  return row;
}

export async function listGrades() {
  await assertCan({ resource: 'org_design', verb: 'view' });
  const auth = currentAuth();
  return prisma.grade.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { level: 'asc' } });
}

export async function createGrade(input: { code: string; name: string; level: number }) {
  const auth = currentAuth();
  await assertCan({ resource: 'org_design', verb: 'create' });
  const row = await prisma.grade.create({
    data: { tenantId: auth.tenantId, code: input.code, name: input.name, level: input.level },
  });
  await auditWrite({ action: 'create', subjectType: 'grade', subjectId: row.id, after: row as never });
  return row;
}

// ---------------------------------------------------------------------------
// Employee status changes — transfer / promotion / demotion / redesignation
// ---------------------------------------------------------------------------

export interface ProposeStatusChangeInput {
  employmentRelationshipId: string;
  kind: EmployeeStatusChangeKind;
  changes: StatusChangeTarget;
  reason: string;
  effectiveDate: Date;
}

async function currentTargetState(employmentRelationshipId: string): Promise<StatusChangeTarget> {
  const [grade, costCentre, location, assignment] = await Promise.all([
    prisma.gradeAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
    prisma.costCentreAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
    prisma.locationAssignment.findFirst({ where: { employmentRelationshipId, effectiveTo: null } }),
    prisma.assignment.findFirst({
      where: { employmentRelationshipId, rowStatus: 'Effective' },
      include: { position: { include: { job: true } } },
    }),
  ]);
  return {
    gradeId: grade?.gradeId,
    costCentreId: costCentre?.costCentreId,
    locationId: location?.locationId,
    designation: assignment?.position.job.title,
  };
}

export async function proposeStatusChange(input: ProposeStatusChangeInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_changes', verb: 'create' });
  await requireEmployment(input.employmentRelationshipId);

  const row = await prisma.employeeStatusChange.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      kind: input.kind,
      changes: input.changes as never,
      reason: input.reason,
      effectiveDate: input.effectiveDate,
      status: 'pending_approval',
      proposedById: auth.partyId ?? 'unknown',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'employee_status_change', subjectId: row.id, after: row as never });
  await emit({
    name: 'kz.hr.employee_change.submitted',
    subject: { entityType: 'employee_status_change', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { kind: row.kind, status: row.status },
  });

  return row;
}

export async function listStatusChanges(employmentRelationshipId?: string) {
  await assertCan({ resource: 'employee_changes', verb: 'view' });
  const auth = currentAuth();
  return prisma.employeeStatusChange.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Decides a pending status change. The Self-Dealing Bar is unconditional and
 * two-sided: the decider may never be the proposer — an employee cannot
 * approve their own transfer, and a manager cannot approve a change they
 * themselves proposed on somebody else's behalf without a second,
 * independent decider — and the decider may never be the subject of the
 * change either, even when someone else proposed it on their behalf.
 */
export async function decideStatusChange(id: string, approve: boolean, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_changes', verb: 'approve' });

  const row = await prisma.employeeStatusChange.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Employee status change');
  if (!canTransitionStatusChange(row.status as EmployeeStatusChangeState, approve ? 'approved' : 'rejected')) {
    throw ApiError.conflict(`This status change is ${row.status} and cannot be decided again.`);
  }
  if (row.proposedById === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: a proposer may never decide their own status change.');
  }
  const subject = await requireEmployment(row.employmentRelationshipId);
  if (subject.personId === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: the subject of a status change may never decide it themselves.');
  }

  const updated = await prisma.employeeStatusChange.update({
    where: { id },
    data: {
      status: approve ? 'approved' : 'rejected',
      decidedById: auth.partyId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'employee_status_change',
    subjectId: id,
    before: row as never,
    after: updated as never,
  });
  await emit({
    name: approve ? 'kz.hr.employee_change.approved' : 'kz.hr.employee_change.rejected',
    subject: { entityType: 'employee_status_change', entityId: id },
    previousState: { status: row.status },
    newState: { status: updated.status, note: note ?? null },
  });

  return updated;
}

/** Applies an approved status change: writes the new grade/cost-centre/location assignment. */
export async function applyStatusChange(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_changes', verb: 'edit' });

  const row = await prisma.employeeStatusChange.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Employee status change');
  if (!canTransitionStatusChange(row.status as EmployeeStatusChangeState, 'applied')) {
    throw ApiError.conflict(`Only an approved status change can be applied; this one is ${row.status}.`);
  }

  const target = row.changes as StatusChangeTarget;
  const current = await currentTargetState(row.employmentRelationshipId);
  const diff = statusChangeDiff(current, target);
  const effectiveFrom = row.effectiveDate;

  await prisma.$transaction(async (tx) => {
    if (target.gradeId) {
      await tx.gradeAssignment.updateMany({
        where: { employmentRelationshipId: row.employmentRelationshipId, effectiveTo: null },
        data: { effectiveTo: effectiveFrom },
      });
      await tx.gradeAssignment.create({
        data: { tenantId: auth.tenantId, employmentRelationshipId: row.employmentRelationshipId, gradeId: target.gradeId, effectiveFrom },
      });
    }
    if (target.costCentreId) {
      await tx.costCentreAssignment.updateMany({
        where: { employmentRelationshipId: row.employmentRelationshipId, effectiveTo: null },
        data: { effectiveTo: effectiveFrom },
      });
      await tx.costCentreAssignment.create({
        data: { tenantId: auth.tenantId, employmentRelationshipId: row.employmentRelationshipId, costCentreId: target.costCentreId, effectiveFrom },
      });
    }
    if (target.locationId) {
      await tx.locationAssignment.updateMany({
        where: { employmentRelationshipId: row.employmentRelationshipId, effectiveTo: null },
        data: { effectiveTo: effectiveFrom },
      });
      await tx.locationAssignment.create({
        data: { tenantId: auth.tenantId, employmentRelationshipId: row.employmentRelationshipId, locationId: target.locationId, effectiveFrom },
      });
    }
    await tx.employeeStatusChange.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } });
  });

  const updated = await prisma.employeeStatusChange.findFirstOrThrow({ where: { id } });

  await auditWrite({
    action: 'update',
    subjectType: 'employee_status_change',
    subjectId: id,
    before: row as never,
    after: { ...updated, diff } as never,
  });
  await emit({
    name: 'kz.hr.employee_change.applied',
    subject: { entityType: 'employee_status_change', entityId: id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    newState: { diff },
  });

  return updated;
}
