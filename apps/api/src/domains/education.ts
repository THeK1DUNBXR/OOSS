/**
 * Enrolling somebody on a batch.
 *
 * Lifted out of its route handler because this is the piece of the education
 * domain with actual judgement in it — which person this is, whether they came
 * from a college, whether the college is one, whether they are already on this
 * batch — and a rule that only exists inside an Express handler is a rule the
 * suite cannot reach. Twice now I have got the order of these checks wrong in a
 * way types could not catch and only a run against a database showed.
 */

import { EVENTS, istDateKey } from '@kaizen/shared';
import { z } from 'zod';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { createAffiliation } from './identity.js';
import {
  assertMinorHasGuardian,
  encryptField,
  parseStatedDateOfBirth,
  readRegulated,
  requireGuardianConsentForMinor,
} from './compliance/privacy.js';

type PersonRow = NonNullable<Awaited<ReturnType<typeof prisma.person.findFirst>>>;

export const ENROLLMENT_STATUSES = ['reserved', 'confirmed', 'active', 'completed', 'withdrawn', 'deferred'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export async function enrolStudent(input: unknown) {
  await assertCan({ resource: 'education', verb: 'create' });
  const auth = currentAuth();

  // `isMinor` is no longer an input. A caller's claim of minority made no
  // difference the minor rule did not already make: a measured age decides,
  // and with no age the rule holds unless `adultAttested` says otherwise. FX-64.
  const body = z
    .object({
      cohortId: z.string(),
      personId: z.string().optional(),
      fullName: z.string().min(1).optional(),
      primaryPhone: z.string().nullish(),
      primaryEmail: z.string().nullish(),
      institutionId: z.string().nullish(),
      dateOfBirth: z.string().nullish(),
      adultAttested: z.boolean().optional(),
      guardianName: z.string().nullish(),
      guardianPhone: z.string().nullish(),
      guardianEmail: z.string().nullish(),
    })
    .refine((b) => b.personId || b.fullName, {
      message: 'Either an existing person, or a name to create one from.',
    })
    .parse(input);

  const cohort = await prisma.cohort.findFirst({
    where: { id: body.cohortId, tenantId: auth.tenantId },
    include: { course: { select: { name: true } } },
  });
  if (!cohort) throw ApiError.notFound('Cohort');

  // Everything that can refuse this enrolment is checked before anything is
  // written. Creating the person first and validating afterwards left a
  // refused enrolment behind as a contact nobody added on purpose — a name in
  // the directory with no relationship to us, produced by an error message.
  let collegeName: string | null = null;
  if (body.institutionId) {
    const college = await prisma.organization.findFirst({
      where: { id: body.institutionId, tenantId: auth.tenantId, deletedAt: null },
      include: { institutionProfile: { select: { id: true } } },
    });
    if (!college) throw ApiError.notFound('Organisation');
    if (!college.institutionProfile) {
      throw ApiError.badRequest(
        `${college.name} is on file but is not marked as a college, so students cannot be recorded as coming from it. ` +
          'Mark it as a college on its own page first.',
      );
    }
    collegeName = college.name;
  }

  // Guardian contact is DPDP-covered and stored encrypted. Minority is measured
  // from the date of birth, stated here or on file; with neither, the minor
  // rule holds unless the caller attests adulthood (assertMinorHasGuardian). FX-64.
  const statedDob = body.dateOfBirth ? parseStatedDateOfBirth(body.dateOfBirth) : null;
  const guardianName = body.guardianName?.trim() || null;
  const guardianPhone = body.guardianPhone?.trim() || null;
  const guardianEmail = body.guardianEmail?.trim() || null;

  // A student is a person like any other. Somebody who was a lead last year
  // and is a learner now is one record with two roles, not two people.
  //
  // Three ways in, in descending order of certainty:
  //
  //   - an id, when the caller picked somebody already on file;
  //   - a phone or an email that exactly matches one person, who is then that
  //     person. Nothing is merged here and no merge candidate is raised:
  //     attaching a second enrolment to somebody is not the same act as
  //     folding two person records together, and the general resolver treats
  //     it as one — which means a student signing up for their second course
  //     lands in a queue a human has to drain, every time. That is a worse
  //     outcome than the duplicate it prevents.
  //   - a bare name, which can only ever create. There is nothing to match on,
  //     and refusing the enrolment over it would help nobody.
  //
  // More than one match is the case that genuinely cannot be decided here, so
  // it is refused with the names, and the form offers picking one of them.
  const phoneKey = body.primaryPhone?.replace(/\D/g, '') || null;
  const emailKey = body.primaryEmail?.toLowerCase() || null;

  let existing: PersonRow | null = null;
  if (body.personId) {
    existing = await prisma.person.findFirst({ where: { id: body.personId, tenantId: auth.tenantId } });
    if (!existing) throw ApiError.notFound('Person');
  } else {
    const matches =
      phoneKey || emailKey
        ? await prisma.person.findMany({
            where: {
              tenantId: auth.tenantId,
              deletedAt: null,
              dedupeStatus: { not: 'merged' },
              OR: [
                ...(phoneKey ? [{ primaryPhoneNormalised: phoneKey }] : []),
                ...(emailKey ? [{ primaryEmailNormalised: emailKey }] : []),
              ],
            },
            take: 5,
          })
        : [];

    if (matches.length > 1) {
      throw ApiError.conflict(
        `That phone or email belongs to more than one person on file (${matches
          .map((m) => `${m.fullName} ${m.recordCode}`)
          .join(', ')}). Pick the right one rather than letting this guess.`,
      );
    }

    existing = matches[0] ?? null;
  }

  // The same person on the same batch twice is a mistake every time, and it
  // is the mistake a list of near-identical rows is made of. Checked before
  // any write, including the date of birth below, so a refusal leaves nothing.
  if (existing) {
    const already = await prisma.enrollment.findFirst({
      where: { tenantId: auth.tenantId, personId: existing.id, cohortId: cohort.id },
    });
    if (already) {
      throw ApiError.conflict(`${existing.fullName} is already on ${cohort.name} as ${already.recordCode}.`);
    }
  }

  // A date of birth on file wins. A different one stated here is refused rather
  // than quietly preferred, because the minor rule turns on it and a second,
  // conflicting value is how the record ends up disagreeing with itself. FX-64.
  const onFile = existing?.dateOfBirth ?? null;
  if (existing && statedDob && onFile && istDateKey(statedDob) !== istDateKey(onFile)) {
    throw ApiError.conflict(
      `${existing.fullName} already has a different date of birth on file. Correct it on their record rather than entering a second one here.`,
    );
  }
  const dateOfBirth = onFile ?? statedDob;
  const adultAttested = body.adultAttested === true;
  const attestedAdult = dateOfBirth === null && adultAttested;

  // Refused before anything is written: a refused enrolment must not leave a
  // person behind (see the note above). The consent row is written later, once
  // there is a person to attach it to.
  const minor = assertMinorHasGuardian({ dateOfBirth, adultAttested, guardianName, guardianPhone });

  let person: PersonRow;
  if (existing) {
    person = existing;
    if (!onFile && statedDob) {
      person = await prisma.person.update({ where: { id: existing.id }, data: { dateOfBirth: statedDob } });
      await auditWrite({
        action: 'update',
        subjectType: 'person',
        subjectId: person.id,
        before: { dateOfBirth: null },
        after: { dateOfBirth: statedDob },
      });
    }
  } else {
    person = await prisma.person.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName: body.fullName!,
        ...(emailKey ? { primaryEmail: body.primaryEmail, primaryEmailNormalised: emailKey } : {}),
        ...(phoneKey ? { primaryPhone: body.primaryPhone, primaryPhoneNormalised: phoneKey } : {}),
        ...(statedDob ? { dateOfBirth: statedDob } : {}),
        source: 'enrollment',
      },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'person',
      subjectId: person.id,
      after: { source: 'enrollment', recordCode: person.recordCode },
    });
  }

  // The consent a minor's enrolment rests on. Written only after every refusal
  // above has passed, and stamped on the enrolment so the rule can be audited
  // from the enrolment itself.
  const guardianConsentId = minor
    ? await requireGuardianConsentForMinor({
        personId: person.id,
        dateOfBirth,
        adultAttested,
        guardianName,
        guardianPhone,
      })
    : null;

  const enrollment = await prisma.enrollment.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('ENR'),
      personId: person.id,
      cohortId: cohort.id,
      institutionId: body.institutionId ?? null,
      status: 'reserved',
      isMinor: minor,
      guardianName: guardianName ? encryptField(guardianName) : null,
      guardianPhone: guardianPhone ? encryptField(guardianPhone) : null,
      guardianEmail: guardianEmail ? encryptField(guardianEmail) : null,
      guardianConsentId,
    },
  });

  // The attesting party is named on the row when the rule was released on
  // attestation rather than on a date, so "this learner was treated as an adult
  // because X said so" can be answered from the log alone. FX-64.
  await auditWrite({
    action: 'create',
    subjectType: 'enrollment',
    subjectId: enrollment.id,
    after: { status: 'reserved', cohortId: cohort.id, personId: person.id, isMinor: minor, guardianConsentId },
    meta: attestedAdult ? { adultAttestedBy: auth.partyId } : undefined,
  });

  // Being enrolled is what makes somebody a student, so it is what writes the
  // affiliation. Without this the Contacts list showed a student as a name
  // with no stated relationship to us — indistinguishable from a stranger
  // somebody typed in — and the "one person, many roles" promise the page
  // makes was true in the schema and invisible in the product.
  //
  // A second enrolment does not write a second affiliation: they were already
  // a student, and two identical badges say nothing the first did not.
  const alreadyAStudent = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, partyId: person.id, affiliationType: 'student', status: 'active' },
  });
  if (!alreadyAStudent) {
    await createAffiliation({
      partyId: person.id,
      affiliationType: 'student',
      counterpartyId: body.institutionId ?? null,
      counterpartyName: collegeName,
    });
  }

  await emit({
    name: EVENTS.ENROLLMENT_CREATED,
    subject: { entityType: 'enrollment', entityId: enrollment.id, recordCode: enrollment.recordCode },
    related: [
      { relation: 'about', entityType: 'person', entityId: person.id },
      { relation: 'in', entityType: 'cohort', entityId: cohort.id },
      ...(body.institutionId
        ? [{ relation: 'recruited_from', entityType: 'organization', entityId: body.institutionId }]
        : []),
    ],
    // The guardian's details are deliberately not in the event body: an event
    // log is a wider audience than the record.
    newState: { status: 'reserved', cohort: cohort.name, course: cohort.course.name, isMinor: enrollment.isMinor },
    owner: { partyId: person.id },
    confidentiality: enrollment.isMinor ? 'restricted' : 'internal',
    impact: { domains: ['edu'] },
  });
  // Handed back in the clear to the caller who supplied them; what is stored
  // is the ciphertext.
  return {
    ...enrollment,
    guardianName: readRegulated(enrollment.guardianName),
    guardianPhone: readRegulated(enrollment.guardianPhone),
    guardianEmail: readRegulated(enrollment.guardianEmail),
  };
}

/**
 * Moves an enrolment to a new status, and does what that status implies.
 *
 * Lifted out of its route handler for the same reason `enrolStudent` was: a
 * rule that only exists inside an Express handler is a rule the suite cannot
 * reach. Withdrawal is the status with judgement in it — it is also a
 * finance fact, closing out any course-fee invoice this enrolment is billed
 * against with its final (tax) invoice, dated today, naming whatever
 * receipts exist even if that is none. See `finalizeCourseFeeInvoice` in
 * `domains/receipts.ts`.
 */
export async function setEnrollmentStatus(enrollmentId: string, status: EnrollmentStatus) {
  const auth = currentAuth();
  await assertCan({ resource: 'education', verb: 'edit' });

  const enrollment = await prisma.enrollment.findFirst({ where: { id: enrollmentId }, include: { cohort: true } });
  if (!enrollment) throw ApiError.notFound('Enrollment');

  // The batch_member narrowing applies to the mutation, evaluated through the
  // same evaluator as everything else.
  await assertCan({
    resource: 'education',
    verb: 'edit',
    record: { trainerPartyId: enrollment.cohort.trainerPartyId },
  });

  const updated = await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      status,
      ...(status === 'confirmed' ? { enrolledAt: new Date() } : {}),
      ...(status === 'completed' ? { completedAt: new Date(), progressPct: 100 } : {}),
    },
  });

  // Withdrawal, completion and confirmation all change what the enrolment
  // means for money and for the learner's record, so the change is on the log
  // before any event announces it. FX-22.
  await auditWrite({
    action: 'update',
    subjectType: 'enrollment',
    subjectId: updated.id,
    before: { status: enrollment.status },
    after: { status: updated.status },
  });

  if (status === 'confirmed') {
    // Triggers Finance's FEE_INSTALMENT generation — the education-motion
    // parallel to a signed contract's invoice.
    await emit({
      name: EVENTS.ENROLLMENT_CONFIRMED,
      subject: { entityType: 'enrollment', entityId: updated.id, recordCode: updated.recordCode },
      newState: { status: 'confirmed', cohortId: updated.cohortId },
      impact: { domains: ['edu', 'fin'] },
    });
  }
  if (status === 'completed') {
    await emit({
      name: EVENTS.ENROLLMENT_COMPLETED,
      subject: { entityType: 'enrollment', entityId: updated.id, recordCode: updated.recordCode },
      newState: { status: 'completed' },
      impact: { domains: ['edu'] },
    });
  }
  if (status === 'withdrawn') {
    await emit({
      name: EVENTS.ENROLLMENT_WITHDRAWN,
      subject: { entityType: 'enrollment', entityId: updated.id, recordCode: updated.recordCode },
      newState: { status: 'withdrawn' },
      impact: { domains: ['edu', 'fin'] },
    });

    // The tax invoice a course-fee student never got mid-way through: this
    // enrolment's temp invoice, if any, closes out today — naming whatever
    // receipts exist, even zero of them, rather than being left open with
    // nothing to ever finalise it now that the course is over for them.
    const lines = await prisma.invoiceLine.findMany({
      where: { tenantId: auth.tenantId, enrollmentId: updated.id },
      select: { invoiceId: true },
    });
    const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
    if (invoiceIds.length > 0) {
      const invoices = await prisma.invoice.findMany({
        where: { tenantId: auth.tenantId, id: { in: invoiceIds }, enrollmentDate: { not: null } },
        select: { id: true, status: true },
      });
      const { finalizeCourseFeeInvoice } = await import('./receipts.js');
      for (const inv of invoices) {
        if (inv.status === 'draft' || inv.status === 'void') continue;
        await finalizeCourseFeeInvoice(inv.id, 'dropout');
      }
    }
  }

  return updated;
}
