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

import {
  EVENTS,
  FUNDING_FRAMEWORKS,
  FUNDING_SOURCES,
  type FundingFramework,
  type FundingSource,
} from '@kaizen/shared';
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
  /** Who is paying: self | sponsor | scheme | institution. */
  funding?: FundingSource;
  /** The body paying, when it is not them. */
  sponsorId?: string | null;
  /** The framework the money comes under, when it is a scheme. */
  fundingFramework?: FundingFramework | null;
  /** Madurai, Coimbatore, online, or on their own campus. */
  deliveryLocation?: string | null;
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
  funding: string;
  fundingFramework: string | null;
  sponsor: { id: string; name: string; recordCode: string } | null;
  deliveryLocation: string | null;
  /**
   * Whether an invoice may be addressed to this learner at all.
   *
   * False for anyone whose place is funded by somebody else. It is stated here
   * rather than worked out at each call site, because there are three of them
   * and the consequence of getting it wrong is a tax invoice sent to a
   * fifteen-year-old on a state scheme.
   */
  billable: boolean;
  enrolmentCount: number;
  createdAt: string;
}

/**
 * The funding answer has to hold together.
 *
 * Each source implies who the payer is, and the combinations that do not
 * describe anything real are refused here rather than discovered when somebody
 * tries to invoice a scheme. "Sponsored" with nobody named is the common one,
 * and it is exactly the row that later gets billed to the learner by mistake.
 */
async function assertFundingCoherent(
  funding: FundingSource,
  sponsorId: string | null,
  fundingFramework: string | null,
  institutionId: string | null,
): Promise<void> {
  if (!FUNDING_SOURCES.includes(funding)) {
    throw ApiError.badRequest(`"${funding}" is not one of the ways a place is paid for.`);
  }
  if (fundingFramework && !(FUNDING_FRAMEWORKS as readonly string[]).includes(fundingFramework)) {
    throw ApiError.badRequest(`"${fundingFramework}" is not a framework this platform knows about.`);
  }

  if (funding === 'self') {
    if (sponsorId) {
      throw ApiError.badRequest(
        'Somebody paying their own fee has no sponsor. Either they are sponsored, or they are not.',
      );
    }
    return;
  }

  if (funding === 'sponsor') {
    if (!sponsorId) {
      throw ApiError.badRequest(
        'A sponsored learner needs the organisation that is paying. Without it the fee has nowhere to be invoiced, and it ends up on the learner.',
      );
    }
    const sponsor = await prisma.organization.findFirst({
      where: { id: sponsorId, deletedAt: null },
      select: { kind: true, name: true, roles: true },
    });
    if (!sponsor) throw ApiError.notFound('Sponsor');
    if (sponsor.kind !== 'organization') {
      throw ApiError.badRequest(
        `${sponsor.name} is a school or college. A college paying for its own students is "paid by their college" rather than a sponsorship — the two are reported differently.`,
      );
    }
    return;
  }

  if (funding === 'institution') {
    if (!institutionId) {
      throw ApiError.badRequest(
        'A learner whose college is paying has to name the college. It is the same field as where they came from.',
      );
    }
    return;
  }

  // A scheme.
  if (!fundingFramework) {
    throw ApiError.badRequest(
      'A learner funded under a scheme needs the framework named — Naan Mudhalvan, Vetri Nichayam, a TNSDC or NSDC-linked programme, CSR. Each reports differently, and "funded" on its own reports as nothing.',
    );
  }
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

  const funding = input.funding ?? 'self';
  await assertFundingCoherent(
    funding,
    input.sponsorId ?? null,
    input.fundingFramework ?? null,
    input.institutionId ?? null,
  );

  const profile = await prisma.studentProfile.create({
    data: {
      tenantId: auth.tenantId,
      personId,
      registrationNumber: input.registrationNumber ?? null,
      institutionId: input.institutionId ?? null,
      status: input.status ?? 'prospective',
      funding,
      sponsorId: input.sponsorId ?? null,
      fundingFramework: input.fundingFramework ?? null,
      deliveryLocation: input.deliveryLocation ?? null,
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

  // Funding is checked against what the record will say afterwards, not against
  // what was sent: changing the source alone must not leave a sponsored learner
  // with nobody paying.
  const next = {
    funding: (input.funding ?? profile.funding) as FundingSource,
    sponsorId: input.sponsorId !== undefined ? input.sponsorId : profile.sponsorId,
    fundingFramework:
      input.fundingFramework !== undefined ? input.fundingFramework : profile.fundingFramework,
    institutionId: input.institutionId !== undefined ? input.institutionId : profile.institutionId,
  };
  await assertFundingCoherent(next.funding, next.sponsorId, next.fundingFramework, next.institutionId);

  const before = {
    status: profile.status,
    registrationNumber: profile.registrationNumber,
    funding: profile.funding,
  };

  await prisma.studentProfile.update({
    where: { id },
    data: {
      ...(input.registrationNumber !== undefined ? { registrationNumber: input.registrationNumber } : {}),
      ...(input.institutionId !== undefined ? { institutionId: input.institutionId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.funding !== undefined ? { funding: input.funding } : {}),
      ...(input.sponsorId !== undefined ? { sponsorId: input.sponsorId } : {}),
      ...(input.fundingFramework !== undefined ? { fundingFramework: input.fundingFramework } : {}),
      ...(input.deliveryLocation !== undefined ? { deliveryLocation: input.deliveryLocation } : {}),
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
    after: { status: after!.status, registrationNumber: after!.registrationNumber, funding: after!.funding },
  });
  return after!;
}

export interface StudentQuery {
  q?: string;
  status?: string;
  institutionId?: string;
  /** "Which of our learners are sponsored", asked straight. */
  funding?: string;
  sponsorId?: string;
  fundingFramework?: string;
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
    ...(query.funding ? { funding: query.funding } : {}),
    ...(query.sponsorId ? { sponsorId: query.sponsorId } : {}),
    ...(query.fundingFramework ? { fundingFramework: query.fundingFramework } : {}),
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
      include: { person: true, institution: true, sponsor: true },
    }),
    prisma.studentProfile.count({ where: where as never }),
  ]);

  const counts = await enrolmentCounts(rows.map((r) => r.personId));
  return { items: rows.map((r) => toView(r, counts.get(r.personId) ?? 0)), total, page, pageSize };
}

export async function loadStudent(id: string): Promise<StudentView | null> {
  const row = await prisma.studentProfile.findFirst({
    where: { id, deletedAt: null },
    include: { person: true, institution: true, sponsor: true },
  });
  if (!row) return null;
  const counts = await enrolmentCounts([row.personId]);
  return toView(row, counts.get(row.personId) ?? 0);
}

/** The student record of a person, if they have one. Used by invoicing. */
export async function studentOf(personId: string): Promise<StudentView | null> {
  const row = await prisma.studentProfile.findFirst({
    where: { personId, deletedAt: null },
    include: { person: true, institution: true, sponsor: true },
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
  funding: string;
  fundingFramework: string | null;
  deliveryLocation: string | null;
  address: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  createdAt: Date;
  person: { recordCode: string; fullName: string; primaryPhone: string | null; primaryEmail: string | null };
  institution: { id: string; name: string; recordCode: string } | null;
  sponsor: { id: string; name: string; recordCode: string } | null;
};

/** Somebody else is paying, so no invoice is addressed to them. */
export function isBillable(funding: string): boolean {
  return funding === 'self';
}

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
    funding: row.funding,
    fundingFramework: row.fundingFramework,
    sponsor: row.sponsor
      ? { id: row.sponsor.id, name: row.sponsor.name, recordCode: row.sponsor.recordCode }
      : null,
    deliveryLocation: row.deliveryLocation,
    billable: isBillable(row.funding),
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

