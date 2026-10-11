/**
 * The learner age basis over HTTP (FX-64): assign-course and student attach
 * carry a date of birth and an adult attestation through the routes, and a
 * learner with neither a date of birth nor a guardian is refused with 422
 * before anything is written. Over HTTP, so the refusal is the one a staff
 * member receives.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { asUser, principalFor, prisma, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
let server: Server;
let base: string;
let TENANT: string;
let chairman: TestPrincipal;
let seq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
  chairman = await principalFor(CHAIRMAN);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function tokenFor(p: TestPrincipal): Promise<string> {
  return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
}

async function post(path: string, body: Record<string, unknown>) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(chairman)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const yearsAgo = (years: number) => new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
const phone = () => {
  seq += 1;
  return `9${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`.slice(0, 10);
};

async function aCourseAndBatch(tag: string) {
  return asUser(CHAIRMAN, async () => {
    const course = await prisma.course.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('CRS'),
        name: `Http ${tag}`,
        code: `HTTP${tag}`.slice(0, 16),
      },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `Http Batch ${tag}`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    return { course, cohort };
  });
}

async function aPerson(label: string, dateOfBirth: Date | null) {
  return asUser(CHAIRMAN, async () =>
    prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Http ${label} ${Date.now()}`,
        primaryPhone: phone(),
        source: 'test',
        dateOfBirth,
      },
    }),
  );
}

describe('HTTP: POST /education/courses/:id/assign carries the age basis', () => {
  it('an adult with a date of birth is enrolled with no guardian', async () => {
    const tag = `${Date.now()}`;
    const { course, cohort } = await aCourseAndBatch(tag);
    const res = await post(`/education/courses/${course.id}/assign`, {
      cohortId: cohort.id,
      fullName: `Adult By Dob ${tag}`,
      primaryPhone: phone(),
      dateOfBirth: yearsAgo(30),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { isMinor: boolean };
    expect(body.isMinor).toBe(false);
  });

  it('an attested adult with no date of birth is enrolled, and the audit row names who attested', async () => {
    const tag = `${Date.now() + 1}`;
    const { course, cohort } = await aCourseAndBatch(tag);
    const res = await post(`/education/courses/${course.id}/assign`, {
      cohortId: cohort.id,
      fullName: `Attested Adult ${tag}`,
      primaryPhone: phone(),
      adultAttested: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; isMinor: boolean };
    expect(body.isMinor).toBe(false);
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'enrollment', subjectId: body.id, action: 'create' },
    });
    expect(audit?.meta).toMatchObject({ adultAttestedBy: chairman.partyId });
  });

  it('an unattested learner with no date of birth and no guardian is refused 422, and nothing is written', async () => {
    const tag = `${Date.now() + 2}`;
    const { course, cohort } = await aCourseAndBatch(tag);
    const name = `Unknown Age Http ${tag}`;
    const res = await post(`/education/courses/${course.id}/assign`, {
      cohortId: cohort.id,
      fullName: name,
      primaryPhone: phone(),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/No date of birth is on file and no adult has been attested/);
    expect(await unscopedPrisma.person.count({ where: { tenantId: TENANT, fullName: name } })).toBe(0);
  });
});

describe('HTTP: POST /crm/people/:id/student-record carries the age basis', () => {
  it('an adult with a date of birth on file becomes a student with no guardian', async () => {
    const person = await aPerson('adult-on-file', new Date(Date.now() - 30 * 365.25 * 86_400_000));
    const res = await post(`/crm/people/${person.id}/student-record`, { fullName: person.fullName });
    expect(res.status).toBe(201);
  });

  it('a date of birth stated on attach is measured: a refused attach records nothing, and an accepted one records it', async () => {
    const person = await aPerson('dob-on-attach', null);
    // A 15-year-old with no guardian is refused, and the date is not written on
    // a refusal.
    const refused = await post(`/crm/people/${person.id}/student-record`, {
      fullName: person.fullName,
      dateOfBirth: yearsAgo(15),
    });
    expect(refused.status).toBe(422);
    const untouched = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(untouched.dateOfBirth).toBeNull();

    // With the guardian named, the same date is accepted and recorded.
    const accepted = await post(`/crm/people/${person.id}/student-record`, {
      fullName: person.fullName,
      dateOfBirth: yearsAgo(15),
      guardianName: 'Parent Name',
      guardianPhone: '9800000009',
    });
    expect(accepted.status).toBe(201);
    const stored = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(stored.dateOfBirth).not.toBeNull();
  });

  it('an attested adult with no date of birth on file becomes a student, and the audit row names who attested', async () => {
    const person = await aPerson('attested-on-attach', null);
    const res = await post(`/crm/people/${person.id}/student-record`, {
      fullName: person.fullName,
      adultAttested: true,
    });
    expect(res.status).toBe(201);
    const profile = await unscopedPrisma.studentProfile.findFirstOrThrow({ where: { personId: person.id } });
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'student_profile', subjectId: profile.id, action: 'create' },
    });
    expect(audit?.meta).toMatchObject({ adultAttestedBy: chairman.partyId });
  });

  it('an unattested person with no date of birth and no guardian is refused 422, and no profile is created', async () => {
    const person = await aPerson('unattested-on-attach', null);
    const res = await post(`/crm/people/${person.id}/student-record`, { fullName: person.fullName });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/No date of birth is on file and no adult has been attested/);
    expect(await unscopedPrisma.studentProfile.count({ where: { personId: person.id } })).toBe(0);
  });
});
