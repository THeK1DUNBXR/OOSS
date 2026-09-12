/**
 * Students: the people who take the courses.
 *
 * The platform used to have no such thing. It had organisations — under which
 * sat both the colleges that send learners and the firms that buy training —
 * and it had people, who were contacts at those organisations, and a student
 * was a person who happened to appear in the enrolments table. Everything was a
 * customer. That made three plain questions unanswerable: how many learners do
 * we have, which colleges do we work with, and who are we actually invoicing.
 *
 * So there are three party types now, and this is the first of them. The other
 * two are in `organizations.ts`, separated by `Organization.kind`.
 *
 * A student is a PERSON carrying a StudentProfile, not a table of its own,
 * because the platform keeps exactly one row per human: the graduate you hire
 * next year has to be the same row, or their history starts again on their
 * first day. The profile is what makes them a student; the person is who they
 * are.
 *
 * "Customer" survives as a role on a document — whoever an invoice is
 * addressed to — and never again as a kind of record.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { findOrCreatePerson, normalisePhone, normaliseEmail } from './identity.js';

export const STUDENT_STATUSES = ['prospective', 'active', 'alumni', 'withdrawn'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export interface StudentInput {
  fullName: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  registrationNumber?: string | null;
  /** The school or college they came from. Checked to be one. */
  institutionId?: string | null;
  address?: string | null;
  placeOfSupply?: string | null;
  gstin?: string | null;
  status?: StudentStatus;
  notes?: string | null;
}

/** What a student looks like everywhere they are listed or billed. */
export interface StudentView {
  id: string;
  personId: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  registrationNumber: string | null;
  status: string;
  address: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  institution: { id: string; name: string; recordCode: string } | null;
  enrolmentCount: number;
  createdAt: string;
}

async function assertInstitution(institutionId: string): Promise<void> {
  const org = await prisma.organization.findFirst({
    where: { id: institutionId, deletedAt: null },
    select: { kind: true },
  });
  if (!org) throw ApiError.notFound('Institution');
  if (org.kind !== 'institution') {
    throw ApiError.badRequest(
      'That record is an organisation, not a school or a college. A student comes from an institution, so only an institution can be named here.',
    );
  }
}

/**
 * Take somebody on as a student.
 *
 * The person comes through `findOrCreatePerson` like every other intake, so
 * enrolling somebody already on file — a contact at a college, an employee's
 * daughter, a learner coming back for a second course — attaches the profile to
 * the row that already exists instead of starting a second history for them.
 * That is the whole reason a student is a person wearing a profile rather than
 * a table of its own.
 */
export async function createStudent(
  input: StudentInput,
  opts: { forceCreate?: boolean; overrideReason?: string } = {},
): Promise<StudentView> {
  await assertCan({ resource: 'students', verb: 'create' });

  if (input.institutionId) await assertInstitution(input.institutionId);
  await assertRegistrationFree(input.registrationNumber ?? null, null);

  const { person } = await findOrCreatePerson(
    {
      fullName: input.fullName,
      primaryPhone: input.primaryPhone ?? null,
      primaryEmail: input.primaryEmail ?? null,
      notes: input.notes ?? null,
      source: 'manual',
    },
    opts,
  );

  // Somebody who is already a student does not become one twice: this is the
  // resolve case above, and saying so is more use than a second profile.
  const existing = await prisma.studentProfile.findFirst({ where: { personId: person.id, deletedAt: null } });
  if (existing) {
    throw ApiError.conflict(
      `${person.fullName} is already on file as a student (${person.recordCode}). Open their record to enrol them on another course.`,
    );
  }

  return attachStudentProfile(person.id, input);
}

/** Make an existing person a student. The same operation, arriving later. */
export async function attachStudentProfile(personId: string, input: StudentInput): Promise<StudentView> {
  const auth = currentAuth();
  await assertCan({ resource: 'students', verb: 'create' });

  const person = await prisma.person.findFirst({ where: { id: personId, deletedAt: null } });
  if (!person) throw ApiError.notFound('Person');

  const existing = await prisma.studentProfile.findFirst({ where: { personId } });
  if (existing) throw ApiError.conflict('This person is already a student.');

  if (input.institutionId) await assertInstitution(input.institutionId);
  await assertRegistrationFree(input.registrationNumber ?? null, null);

  const profile = await prisma.studentProfile.create({
    data: {
      tenantId: auth.tenantId,
      personId,
      registrationNumber: input.registrationNumber ?? null,
      institutionId: input.institutionId ?? null,
      status: input.status ?? 'prospective',
      address: input.address ?? null,
      placeOfSupply: input.placeOfSupply ?? null,
      gstin: input.gstin ?? null,
      attachedById: auth.partyId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'student_profile',
    subjectId: profile.id,
    after: { registrationNumber: profile.registrationNumber, status: profile.status },
  });
  await emit({
    name: EVENTS.PERSON_CREATED,
    subject: { entityType: 'person', entityId: personId, recordCode: person.recordCode },
    related: [{ relation: 'specialises', entityType: 'student_profile', entityId: profile.id }],
    newState: { student: true, status: profile.status },
  });

  return (await loadStudent(profile.id))!;
}

export async function updateStudent(id: string, input: Partial<StudentInput>): Promise<StudentView> {
  await assertCan({ resource: 'students', verb: 'edit' });

  const profile = await prisma.studentProfile.findFirst({ where: { id, deletedAt: null } });
  if (!profile) throw ApiError.notFound('Student');

  if (input.institutionId) await assertInstitution(input.institutionId);
  if (input.registrationNumber !== undefined) {
    await assertRegistrationFree(input.registrationNumber ?? null, id);
  }

  const before = { status: profile.status, registrationNumber: profile.registrationNumber };

  await prisma.studentProfile.update({
    where: { id },
    data: {
      ...(input.registrationNumber !== undefined ? { registrationNumber: input.registrationNumber } : {}),
      ...(input.institutionId !== undefined ? { institutionId: input.institutionId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.placeOfSupply !== undefined ? { placeOfSupply: input.placeOfSupply } : {}),
      ...(input.gstin !== undefined ? { gstin: input.gstin } : {}),
    },
  });

  // The person's own fields live on the person, and are edited as the person.
  if (input.fullName !== undefined || input.primaryPhone !== undefined || input.primaryEmail !== undefined) {
    await prisma.person.update({
      where: { id: profile.personId },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.primaryPhone !== undefined
          ? { primaryPhone: input.primaryPhone, primaryPhoneNormalised: normalisePhone(input.primaryPhone) }
          : {}),
        ...(input.primaryEmail !== undefined
          ? {
              primaryEmail: input.primaryEmail,
              primaryEmailNormalised: normaliseEmail(input.primaryEmail),
            }
          : {}),
      },
    });
  }

  const after = await loadStudent(id);
  await auditWrite({
    action: 'update',
    subjectType: 'student_profile',
    subjectId: id,
    before,
    after: { status: after!.status, registrationNumber: after!.registrationNumber },
  });
  return after!;
}

export interface StudentQuery {
  q?: string;
  status?: string;
  institutionId?: string;
  page?: number;
  pageSize?: number;
}

export async function listStudents(query: StudentQuery = {}): Promise<{
  items: StudentView[];
  total: number;
  page: number;
  pageSize: number;
}> {
  await assertCan({ resource: 'students', verb: 'view' });
  const auth = currentAuth();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));

  const where = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.institutionId ? { institutionId: query.institutionId } : {}),
    ...(query.q
      ? {
          OR: [
            { registrationNumber: { contains: query.q, mode: 'insensitive' as const } },
            { person: { fullName: { contains: query.q, mode: 'insensitive' as const } } },
            { person: { recordCode: { contains: query.q, mode: 'insensitive' as const } } },
            { person: { primaryPhone: { contains: query.q } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.studentProfile.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { person: true, institution: true },
    }),
    prisma.studentProfile.count({ where: where as never }),
  ]);

  const counts = await enrolmentCounts(rows.map((r) => r.personId));
  return { items: rows.map((r) => toView(r, counts.get(r.personId) ?? 0)), total, page, pageSize };
}

export async function loadStudent(id: string): Promise<StudentView | null> {
  const row = await prisma.studentProfile.findFirst({
    where: { id, deletedAt: null },
    include: { person: true, institution: true },
  });
  if (!row) return null;
  const counts = await enrolmentCounts([row.personId]);
  return toView(row, counts.get(row.personId) ?? 0);
}

/** The student record of a person, if they have one. Used by invoicing. */
export async function studentOf(personId: string): Promise<StudentView | null> {
  const row = await prisma.studentProfile.findFirst({
    where: { personId, deletedAt: null },
    include: { person: true, institution: true },
  });
  if (!row) return null;
  const counts = await enrolmentCounts([personId]);
  return toView(row, counts.get(personId) ?? 0);
}

async function enrolmentCounts(personIds: string[]): Promise<Map<string, number>> {
  if (personIds.length === 0) return new Map();
  const grouped = await prisma.enrollment.groupBy({
    by: ['personId'],
    where: { personId: { in: personIds } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.personId, g._count._all]));
}

type Row = {
  id: string;
  personId: string;
  registrationNumber: string | null;
  status: string;
  address: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  createdAt: Date;
  person: { recordCode: string; fullName: string; primaryPhone: string | null; primaryEmail: string | null };
  institution: { id: string; name: string; recordCode: string } | null;
};

function toView(row: Row, enrolmentCount: number): StudentView {
  return {
    id: row.id,
    personId: row.personId,
    recordCode: row.person.recordCode,
    fullName: row.person.fullName,
    primaryPhone: row.person.primaryPhone,
    primaryEmail: row.person.primaryEmail,
    registrationNumber: row.registrationNumber,
    status: row.status,
    address: row.address,
    placeOfSupply: row.placeOfSupply,
    gstin: row.gstin,
    institution: row.institution
      ? { id: row.institution.id, name: row.institution.name, recordCode: row.institution.recordCode }
      : null,
    enrolmentCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A registration number identifies one learner to the company, so two of them
 * is a data-entry error rather than a coincidence — and the one that catches it
 * should say so, not surface as a unique-constraint violation from the database.
 */
async function assertRegistrationFree(registrationNumber: string | null, exceptId: string | null): Promise<void> {
  if (!registrationNumber) return;
  const clash = await prisma.studentProfile.findFirst({
    where: { registrationNumber, ...(exceptId ? { id: { not: exceptId } } : {}) },
    include: { person: { select: { fullName: true } } },
  });
  if (clash) {
    throw ApiError.conflict(
      `Registration number ${registrationNumber} already belongs to ${clash.person.fullName}.`,
    );
  }
}

