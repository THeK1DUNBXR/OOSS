/**
 * Bringing rows written under an older shape up to the current one.
 *
 * Not a migration framework. Each function here answers one question — "what
 * should this row say now that the model says more than it used to" — from the
 * data itself, and is safe to run again: it changes only rows that still carry
 * the old shape, so a second run does nothing.
 *
 * It runs as part of the seed because the seed is what every environment
 * already runs after a schema change, and a backfill nobody remembers to run is
 * a column that is wrong in production and right in the code.
 */

import { unscopedPrisma } from '../platform/db.js';

/**
 * Say which of the two an organisation is.
 *
 * `Organization.kind` arrived after the rows did, defaulting to `organization`
 * because most of them are. The ones that are not say so themselves: an
 * institution profile is attached to schools and colleges and to nothing else,
 * so a row carrying one is an institution whatever the default says.
 *
 * A row that carries both a profile and billing detail is still an institution
 * — a college we also invoice — because being invoiced is not an identity.
 */
export async function backfillOrganizationKinds(): Promise<number> {
  const colleges = await unscopedPrisma.organization.findMany({
    where: { kind: 'organization', institutionProfile: { isNot: null } },
    select: { id: true },
  });
  if (colleges.length === 0) return 0;

  const { count } = await unscopedPrisma.organization.updateMany({
    where: { id: { in: colleges.map((c) => c.id) } },
    data: { kind: 'institution' },
  });
  return count;
}

/**
 * Give every enrolled learner a student record.
 *
 * Enrolments came first: for a year a student was "a person who happens to
 * appear in the enrolments table", which is why there was no list of them, no
 * registration number in a field of its own, and nothing to bill that was not
 * also a contact at a company. Anyone with an enrolment and no student profile
 * gets one, carrying the registration number the register was imported under.
 */
export async function backfillStudentProfiles(): Promise<number> {
  // Enrolment names its learner by id rather than by relation, so the two
  // sides are read separately and matched here.
  const enrolled = await unscopedPrisma.enrollment.findMany({
    select: {
      tenantId: true,
      personId: true,
      legacyReference: true,
      institutionId: true,
      status: true,
      enrolledAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (enrolled.length === 0) return 0;

  const alreadyStudents = new Set(
    (
      await unscopedPrisma.studentProfile.findMany({
        where: { personId: { in: [...new Set(enrolled.map((e) => e.personId))] } },
        select: { personId: true },
      })
    ).map((p) => p.personId),
  );
  const livePeople = new Set(
    (
      await unscopedPrisma.person.findMany({
        where: { id: { in: [...new Set(enrolled.map((e) => e.personId))] }, deletedAt: null },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  // One student, however many courses they have taken. The first enrolment is
  // the one that carries the registration number they were first written down
  // under, so it wins.
  const first = new Map<string, (typeof enrolled)[number]>();
  for (const row of enrolled) {
    if (alreadyStudents.has(row.personId) || !livePeople.has(row.personId)) continue;
    if (!first.has(row.personId)) first.set(row.personId, row);
  }
  if (first.size === 0) return 0;

  // A registration number is unique per tenant, and a register imported twice
  // under two people would otherwise fail the whole backfill rather than the
  // one row that is wrong. Keep the first and leave the rest without one.
  const claimed = new Set<string>();
  let written = 0;
  for (const row of first.values()) {
    const key = `${row.tenantId}:${row.legacyReference ?? ''}`;
    const registrationNumber = row.legacyReference && !claimed.has(key) ? row.legacyReference : null;
    if (registrationNumber) claimed.add(key);

    await unscopedPrisma.studentProfile.create({
      data: {
        tenantId: row.tenantId,
        personId: row.personId,
        registrationNumber,
        institutionId: row.institutionId,
        status: statusFromEnrolment(row.status, row.enrolledAt),
      },
    });
    written += 1;
  }
  return written;
}

function statusFromEnrolment(status: string, enrolledAt: Date | null): string {
  if (status === 'completed') return 'alumni';
  if (status === 'withdrawn') return 'withdrawn';
  return enrolledAt ? 'active' : 'prospective';
}

export async function runBackfills(): Promise<{ organizationKinds: number; studentProfiles: number }> {
  return {
    organizationKinds: await backfillOrganizationKinds(),
    studentProfiles: await backfillStudentProfiles(),
  };
}
