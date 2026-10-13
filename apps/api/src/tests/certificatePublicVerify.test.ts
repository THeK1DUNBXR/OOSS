/**
 * FX-80 — the certificate read paths and the public verification check.
 *
 * Each test builds its own person, course, cohort and enrolment, so nothing here
 * depends on the demo rows another test may change. Tenant B is a second tenant
 * row created for this file.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import {
  issueCertificate,
  listCertificates,
  revokeCertificate,
  verifyCertificate,
} from '../domains/compliance/corporate.js';
import { asSystem } from '../platform/context.js';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { asPrincipal, asUser, authFor, expectReject, principalFor, tenantId } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ISSUER = 'chairman@kaizen.co.in';
const TENANT_B_SLUG = 'fx80-verify-b';

const made = {
  certificateIds: [] as string[],
  enrollmentIds: [] as string[],
  cohortIds: [] as string[],
  courseIds: [] as string[],
  personIds: [] as string[],
};

let tenantA: string;
let tenantB: string;
let server: Server;
let base: string;

beforeAll(async () => {
  tenantA = await tenantId();
  const b = await unscopedPrisma.tenant.upsert({
    where: { slug: TENANT_B_SLUG },
    create: { name: 'FX-80 verify fixture B', slug: TENANT_B_SLUG, status: 'active' },
    update: {},
  });
  tenantB = b.id;
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  server?.close();
  await unscopedPrisma.certificate.deleteMany({ where: { id: { in: made.certificateIds } } }).catch(() => {});
  await unscopedPrisma.enrollment.deleteMany({ where: { id: { in: made.enrollmentIds } } }).catch(() => {});
  await unscopedPrisma.cohort.deleteMany({ where: { id: { in: made.cohortIds } } }).catch(() => {});
  await unscopedPrisma.course.deleteMany({ where: { id: { in: made.courseIds } } }).catch(() => {});
  await unscopedPrisma.person.deleteMany({ where: { id: { in: made.personIds } } }).catch(() => {});
});

/** A person on a course, enrolled with the given status, all in tenant A. */
async function enrolment(status: string) {
  const n = stamp();
  const person = await unscopedPrisma.person.create({
    data: { tenantId: tenantA, recordCode: `FX80-P-${n}`, fullName: `Verify Holder ${n}` },
  });
  made.personIds.push(person.id);
  const course = await unscopedPrisma.course.create({
    data: { tenantId: tenantA, recordCode: `FX80-C-${n}`, name: `Verify Course ${n}`, code: `FX80C${n}` },
  });
  made.courseIds.push(course.id);
  const cohort = await unscopedPrisma.cohort.create({
    data: {
      tenantId: tenantA,
      recordCode: `FX80-K-${n}`,
      courseId: course.id,
      name: `Verify Cohort ${n}`,
      startDate: new Date('2026-01-01'),
    },
  });
  made.cohortIds.push(cohort.id);
  const enrollment = await unscopedPrisma.enrollment.create({
    data: {
      tenantId: tenantA,
      recordCode: `FX80-E-${n}`,
      personId: person.id,
      cohortId: cohort.id,
      status,
      completedAt: status === 'completed' ? new Date() : null,
    },
  });
  made.enrollmentIds.push(enrollment.id);
  return { enrollment, person, course };
}

async function issue(enrollmentId: string, snapshot: Record<string, unknown>) {
  const certificate = await asUser(ISSUER, () => issueCertificate({ enrollmentId, kind: 'completion', snapshot }));
  made.certificateIds.push(certificate.id);
  return certificate;
}

async function getPublic(code: string, extra: { headers?: Record<string, string>; query?: string } = {}) {
  const res = await fetch(`${base}/compliance/public/certificates/${encodeURIComponent(code)}${extra.query ?? ''}`, {
    headers: extra.headers,
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('FX-80 authenticated certificate reads', () => {
  it('no authenticated read returns the snapshot', async () => {
    // Refused on the pre-fix code: list, issue and verify all handed back the
    // Prisma row, snapshot included.
    const { enrollment } = await enrolment('completed');
    const marker = `Snapshot Only Name ${stamp()}`;
    const issued = await issue(enrollment.id, { learnerName: marker });

    const listed = await asUser(ISSUER, () => listCertificates(enrollment.id));
    expect(listed.length).toBe(1);
    expect(Object.keys(listed[0]).includes('snapshot')).toBe(false);
    expect(Object.keys(issued).includes('snapshot')).toBe(false);

    const verified = await asUser(ISSUER, () => verifyCertificate(issued.verificationCode));
    expect(Object.keys(verified).includes('snapshot')).toBe(false);

    expect(JSON.stringify([listed, issued, verified])).not.toContain(marker);
  });

  it('refuses to issue for an enrolment that is not completed, with a 422', async () => {
    // Already enforced by certificates.ts:55-61 and certificateStatus.test.ts:41-48.
    // Repeated here on its own fixture, so this file stands alone. It is not a
    // new failure on the pre-fix code.
    const { enrollment } = await enrolment('active');
    const err = await expectReject(() =>
      asUser(ISSUER, () => issueCertificate({ enrollmentId: enrollment.id, kind: 'completion', snapshot: {} })),
    );
    expect(err.status).toBe(422);
  });
});

describe('FX-80 public verification', () => {
  it('returns exactly four fields for a valid certificate, with the holder and course from the enrolment', async () => {
    // Refused on the pre-fix code: GET /api/compliance/public/... did not exist,
    // and the same path under /api/compliance answered 401 without a session.
    const { enrollment, person, course } = await enrolment('completed');
    const issued = await issue(enrollment.id, { learnerName: 'Issuer Typed Name' });

    const res = await getPublic(issued.verificationCode);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['courseName', 'holderName', 'issuedAt', 'status']);
    expect(res.body.holderName).toBe(person.fullName);
    expect(res.body.courseName).toBe(course.name);
    expect(res.body.status).toBe('valid');
    expect(new Date(res.body.issuedAt as string).getTime()).toBe(issued.issuedAt.getTime());
    // The issuer's free-form snapshot is not the source of the public names.
    expect(res.text).not.toContain('Issuer Typed Name');
  });

  it('shows revoked for a revoked certificate, and leaks the reason to no one', async () => {
    const { enrollment } = await enrolment('completed');
    const issued = await issue(enrollment.id, {});
    await asUser(ISSUER, () => revokeCertificate(issued.id, 'issued against the wrong cohort'));

    const res = await getPublic(issued.verificationCode);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(Object.keys(res.body).sort()).toEqual(['courseName', 'holderName', 'issuedAt', 'status']);
    expect(res.text).not.toContain('wrong cohort');
  });

  it('shows invalid once the enrolment behind a certificate has been reversed', async () => {
    const { enrollment } = await enrolment('completed');
    const issued = await issue(enrollment.id, {});
    await unscopedPrisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'withdrawn' } });

    const res = await getPublic(issued.verificationCode);
    expect(res.body.status).toBe('invalid');
  });

  it('answers an unknown code with a 404 that names no tenant and no other record', async () => {
    const res = await getPublic(`no-such-code-${stamp()}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(tenantA);
    expect(res.text).not.toContain(tenantB);
    expect(res.text).not.toContain('kaizen');
    expect(res.text).not.toContain('holderName');
  });

  it('ignores a tenant named by the caller, so tenant B cannot reach tenant A data', async () => {
    const { enrollment } = await enrolment('completed');
    const issued = await issue(enrollment.id, {});

    const plain = await getPublic(issued.verificationCode);
    const withHeader = await getPublic(issued.verificationCode, { headers: { 'X-Kai-Tenant': TENANT_B_SLUG } });
    const withQuery = await getPublic(issued.verificationCode, { query: `?tenant=${TENANT_B_SLUG}` });

    expect(withHeader.status).toBe(plain.status);
    expect(withHeader.body).toEqual(plain.body);
    expect(withQuery.body).toEqual(plain.body);
  });

  it('a tenant B session cannot read a tenant A certificate, by number or by code', async () => {
    const { enrollment, person } = await enrolment('completed');
    const issued = await issue(enrollment.id, {});
    const chairman = await principalFor(ISSUER);
    const inB = authFor(chairman, { tenantId: tenantB });

    const err = await expectReject(() => asPrincipal(inB, () => verifyCertificate(issued.verificationCode)));
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.message).not.toContain(issued.number);
    expect(err.message).not.toContain(person.fullName);

    // Either refused outright or answered with nothing; never with the tenant A row.
    const listed = await asPrincipal(inB, () =>
      listCertificates(enrollment.id).then(
        (rows) => rows,
        (e: Error) => e,
      ),
    );
    expect(JSON.stringify(listed)).not.toContain(issued.number);
    expect(JSON.stringify(listed)).not.toContain(issued.verificationCode);
  });

  it('a certificate cannot be written against an enrolment that does not exist', async () => {
    // Refused on the pre-fix code: Certificate.enrollmentId had no foreign key,
    // so the insert succeeded. Under the migration it fails with P2003.
    const err = await asSystem(tenantA, () =>
      expectReject(() =>
        prisma.certificate.create({
          data: {
            tenantId: tenantA,
            number: `FX80-FK-${stamp()}`,
            enrollmentId: `missing-enrolment-${stamp()}`,
            kind: 'completion',
            snapshot: {},
            verificationCode: `fx80-fk-${stamp()}`,
          },
        }),
      ),
    );
    expect(err.code).toBe('P2003');
  });
});
