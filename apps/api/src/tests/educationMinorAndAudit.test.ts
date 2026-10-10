/**
 * Education enrolment: the minor rule on an unknown date of birth, the audit
 * rows enrolment and status changes write, and the day a learner's progress
 * is filed under. Real database, real request context, as the rest of the
 * suite runs.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { enrolStudent, setEnrollmentStatus } from '../domains/education.js';
import { recordDailyProgress } from '../domains/learnerTimeline.js';
import { nextRecordCode } from '../platform/recordCode.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
let TENANT: string;
let seq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

function aPhone(): string {
  seq += 1;
  return `9${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`.slice(0, 10);
}

async function aBatch(tag: string) {
  return asUser(CHAIRMAN, async () => {
    const course = await prisma.course.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `${tag} Course`, code: `${tag}-C` },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${tag} Batch`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    return { course, cohort };
  });
}

const yearsAgo = (years: number) => new Date(Date.now() - years * 365.25 * 86_400_000).toISOString();

describe('FX-64: enrolment with no date of birth holds the minor rule', () => {
  it('refuses an enrolment with no date of birth, no guardian and no adult attestation, and leaves no person behind', async () => {
    const { cohort } = await aBatch(`UNK${Date.now()}`);
    const name = `Unknown Age ${Date.now()}`;
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () => enrolStudent({ cohortId: cohort.id, fullName: name, primaryPhone: aPhone() })),
    );
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/guardian/i);
    expect(await unscopedPrisma.person.count({ where: { tenantId: TENANT, fullName: name } })).toBe(0);
  });

  it('an explicit adult attestation enrols them as an adult, and the audit row names the attesting party', async () => {
    const { cohort } = await aBatch(`ATT${Date.now()}`);
    await asUser(CHAIRMAN, async (p) => {
      const enrollment = await enrolStudent({
        cohortId: cohort.id,
        fullName: `Attested Adult ${Date.now()}`,
        primaryPhone: aPhone(),
        adultAttested: true,
      });
      expect(enrollment.isMinor).toBe(false);

      const audit = await unscopedPrisma.auditRecord.findFirst({
        where: { tenantId: TENANT, subjectType: 'enrollment', subjectId: enrollment.id, action: 'create' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.meta).toMatchObject({ adultAttestedBy: p.partyId });
    });
  });

  it('a stated date of birth is what is measured: a 15-year-old needs a guardian, and the date is kept', async () => {
    const { cohort } = await aBatch(`DOB${Date.now()}`);
    const name = `Stated Minor ${Date.now()}`;
    const dob = yearsAgo(15);
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () => enrolStudent({ cohortId: cohort.id, fullName: name, primaryPhone: aPhone(), dateOfBirth: dob })),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.person.count({ where: { tenantId: TENANT, fullName: name } })).toBe(0);

    const enrollment = await asUser(CHAIRMAN, () =>
      enrolStudent({
        cohortId: cohort.id,
        fullName: name,
        primaryPhone: aPhone(),
        dateOfBirth: dob,
        guardianName: 'Parent Name',
        guardianPhone: '9800000005',
      }),
    );
    expect(enrollment.isMinor).toBe(true);
    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { id: enrollment.personId } });
    expect(person.dateOfBirth).not.toBeNull();
  });
});

describe('FX-22: enrolment and status changes are audited', () => {
  it('writes an audit row for the person and the enrolment, and one for each status change', async () => {
    const { cohort } = await aBatch(`AUD${Date.now()}`);
    await asUser(CHAIRMAN, async () => {
      const enrollment = await enrolStudent({
        cohortId: cohort.id,
        fullName: `Audited Student ${Date.now()}`,
        primaryPhone: aPhone(),
        adultAttested: true,
      });

      const created = await unscopedPrisma.auditRecord.findMany({
        where: { tenantId: TENANT, action: 'create', subjectId: { in: [enrollment.id, enrollment.personId] } },
      });
      expect(created.map((r) => r.subjectType).sort()).toEqual(['enrollment', 'person']);

      await setEnrollmentStatus(enrollment.id, 'withdrawn');
      const changed = await unscopedPrisma.auditRecord.findFirst({
        where: { tenantId: TENANT, action: 'update', subjectType: 'enrollment', subjectId: enrollment.id },
      });
      expect(changed).not.toBeNull();
      expect(changed!.diff).toMatchObject({ status: { from: 'reserved', to: 'withdrawn' } });
    });
  });
});

describe('P1 learner timeline: progress is filed under the IST day', () => {
  it('a score recorded at 01:30 IST on 10 May is filed under 10 May, which starts at 18:30 UTC on 9 May', async () => {
    const { cohort } = await aBatch(`DAY${Date.now()}`);
    await asUser(CHAIRMAN, async () => {
      const enrollment = await enrolStudent({
        cohortId: cohort.id,
        fullName: `Daily Student ${Date.now()}`,
        primaryPhone: aPhone(),
        adultAttested: true,
      });
      const row = await recordDailyProgress(enrollment.id, { progressDate: new Date('2026-05-09T20:00:00Z'), score: 80 });
      expect(row.progressDate.toISOString()).toBe('2026-05-09T18:30:00.000Z');
    });
  });
});
