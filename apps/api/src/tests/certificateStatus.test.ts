/**
 * FX-80 — a certificate's validity is its status, not an assumption.
 *
 * Before this fix `verifyCertificate` returned `valid: true` for any code it
 * found, `issueCertificate` did not look at the enrolment at all, and there was
 * no way to revoke a certificate once handed out.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { issueCertificate, revokeCertificate, verifyCertificate } from '../domains/compliance/corporate.js';
import { unscopedPrisma } from '../platform/db.js';
import { asUser, expectReject, tenantId } from './helpers.js';

const createdCertificateIds: string[] = [];
const restorers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const restore of restorers.reverse()) await restore().catch(() => {});
  await unscopedPrisma.certificate.deleteMany({ where: { id: { in: createdCertificateIds } } }).catch(() => {});
});

/** Sets an enrolment's status for one test and restores it afterwards. */
async function setEnrolmentStatus(tid: string, status: string) {
  const original = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { tenantId: tid } });
  await unscopedPrisma.enrollment.update({
    where: { id: original.id },
    data: { status, completedAt: status === 'completed' ? new Date() : null },
  });
  restorers.push(async () => {
    await unscopedPrisma.enrollment.update({
      where: { id: original.id },
      data: { status: original.status, completedAt: original.completedAt },
    });
  });
  return original.id;
}

describe('FX-80 certificate status', () => {
  it('refuses to issue a certificate for an enrolment that has not completed', async () => {
    const tid = await tenantId();
    const enrollmentId = await setEnrolmentStatus(tid, 'active');

    const err = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () =>
        issueCertificate({ enrollmentId, kind: 'completion', snapshot: { learnerName: 'Not Yet' } }),
      ),
    );
    expect(err.status).toBe(422);
  });

  it('a revoked certificate verifies as invalid, with its reason on record', async () => {
    const tid = await tenantId();
    const enrollmentId = await setEnrolmentStatus(tid, 'completed');

    const certificate = await asUser('chairman@kaizen.co.in', () =>
      issueCertificate({ enrollmentId, kind: 'completion', snapshot: { learnerName: 'Issued In Error' } }),
    );
    createdCertificateIds.push(certificate.id);

    const before = await asUser('chairman@kaizen.co.in', () => verifyCertificate(certificate.verificationCode));
    expect(before.valid).toBe(true);

    await asUser('chairman@kaizen.co.in', () => revokeCertificate(certificate.id, 'issued against the wrong cohort'));

    const after = await asUser('chairman@kaizen.co.in', () => verifyCertificate(certificate.verificationCode));
    expect(after.valid).toBe(false);
    expect(after.status).toBe('revoked');

    const row = await unscopedPrisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('issued against the wrong cohort');
  });

  it('verifies as invalid once the enrolment behind it is no longer completed', async () => {
    const tid = await tenantId();
    const enrollmentId = await setEnrolmentStatus(tid, 'completed');

    const certificate = await asUser('chairman@kaizen.co.in', () =>
      issueCertificate({ enrollmentId, kind: 'completion', snapshot: { learnerName: 'Withdrawn Later' } }),
    );
    createdCertificateIds.push(certificate.id);

    await unscopedPrisma.enrollment.update({ where: { id: enrollmentId }, data: { status: 'withdrawn' } });

    const verified = await asUser('chairman@kaizen.co.in', () => verifyCertificate(certificate.verificationCode));
    expect(verified.valid).toBe(false);
  });
});
