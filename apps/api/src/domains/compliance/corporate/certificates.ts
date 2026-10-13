/**
 * Certificates — final once issued, like every document in this platform. A
 * correction is a new certificate, never an edit to one already handed out.
 *
 * Two ways in to a certificate's status. `GET .../verify/:code` is the staff
 * check, behind sign-in like every route under `/api/compliance`. The public
 * page is `publicCertificateStatus`, mounted outside `requireAuth` in
 * `routes/compliance/publicCertificates.routes.ts`; it answers with four fields
 * and nothing else (see that function's note on how it finds the tenant).
 *
 * Nothing that leaves this file carries `snapshot`. The snapshot is whatever the
 * issuer typed in, unvalidated, so it is not something a reader should be given
 * back as if it were the record.
 */

import { randomBytes } from 'node:crypto';
import type { CertificateKind } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../../platform/db.js';
import { asSystem, currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';
import { documentPrefix } from '../../companyProfile.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../../platform/documentNumber.js';

// Issue, revoke and verify all turn on a certificate's status, so every change
// to it is a governed write, and a revocation can be proved to have happened.
registerGovernedEntities('cmp_corporate', ['certificate']);

function verificationCode(): string {
  // Not the certificate number itself — a certificate number is sequential
  // and guessable, a verification code should not let somebody walk the
  // whole series by incrementing it.
  return randomBytes(9).toString('base64url');
}

/**
 * The row as a staff screen reads it. Every authenticated read and write returns
 * this, never the Prisma row, so the snapshot and the tenant and issuer ids stay
 * inside the domain. Adding a field here is a decision about what a screen shows.
 */
interface CertificateReadModel {
  id: string;
  number: string;
  enrollmentId: string;
  kind: string;
  status: string;
  issuedAt: Date;
  verificationCode: string;
  revokedAt: Date | null;
  revokedReason: string | null;
}

function toCertificateReadModel(row: {
  id: string;
  number: string;
  enrollmentId: string;
  kind: string;
  status: string;
  issuedAt: Date;
  verificationCode: string;
  revokedAt: Date | null;
  revokedReason: string | null;
}): CertificateReadModel {
  return {
    id: row.id,
    number: row.number,
    enrollmentId: row.enrollmentId,
    kind: row.kind,
    status: row.status,
    issuedAt: row.issuedAt,
    verificationCode: row.verificationCode,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  };
}

export async function listCertificates(enrollmentId?: string): Promise<CertificateReadModel[]> {
  await assertCan({ resource: 'certificates', verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.certificate.findMany({
    where: { tenantId: auth.tenantId, ...(enrollmentId ? { enrollmentId } : {}) },
    orderBy: { issuedAt: 'desc' },
  });
  return rows.map(toCertificateReadModel);
}

export async function issueCertificate(input: {
  enrollmentId: string;
  kind: CertificateKind;
  snapshot: Record<string, unknown>;
}) {
  await assertCan({ resource: 'certificates', verb: 'create' });
  const auth = currentAuth();

  // A certificate says the holder completed something. Issuing one for an
  // enrolment that has not completed is a false statement on a document that
  // will be checked by someone outside the company.
  const enrollment = await prisma.enrollment.findFirst({ where: { id: input.enrollmentId, tenantId: auth.tenantId } });
  if (!enrollment) throw ApiError.notFound('Enrollment');
  if (enrollment.status !== 'completed') {
    throw ApiError.unprocessable(
      `The enrolment is ${enrollment.status}. A certificate is issued once it is completed.`,
    );
  }

  const prefix = await documentPrefix();
  // Its own transaction: the number is taken where the document is written, so a
  // failed write does not leave a hole. This caller has not yet moved its write in.
  // The number and the row it names commit together. Taken on the global client it
  // stayed taken when this write was refused, and the series had a hole in it.
  const { number, certificate } = await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, DOCUMENT_SERIES.certificate, prefix);
    const certificate = await tx.certificate.create({
      data: {
        tenantId: auth.tenantId,
        number,
        enrollmentId: input.enrollmentId,
        kind: input.kind,
        snapshot: input.snapshot as never,
        verificationCode: verificationCode(),
        issuedById: auth.partyId,
      },
    });
    return { number, certificate };
  });

  await auditWrite({
    action: 'create',
    subjectType: 'certificate',
    subjectId: certificate.id,
    after: { number, enrollmentId: input.enrollmentId },
  });
  return toCertificateReadModel(certificate);
}

/**
 * The staff check. `valid` is true only while the certificate is unrevoked AND
 * the enrolment it was issued for is still completed. The second check is there
 * because an enrolment can be reversed after issue; a certificate for one that is
 * no longer completed must not keep verifying as genuine.
 */
export async function verifyCertificate(code: string) {
  await assertCan({ resource: 'certificates', verb: 'view' });
  const auth = currentAuth();
  const certificate = await prisma.certificate.findFirst({
    where: { tenantId: auth.tenantId, verificationCode: code },
  });
  if (!certificate) throw ApiError.notFound('Certificate');
  const enrollment = await prisma.enrollment.findFirst({
    where: { id: certificate.enrollmentId, tenantId: auth.tenantId },
    select: { status: true },
  });
  const valid = certificate.status === 'valid' && enrollment?.status === 'completed';
  return {
    number: certificate.number,
    kind: certificate.kind,
    issuedAt: certificate.issuedAt,
    status: certificate.status,
    revokedAt: certificate.revokedAt,
    revokedReason: certificate.revokedReason,
    valid,
  };
}

/** What a verifier outside the company is shown. Nothing else leaves the public route. */
export interface PublicCertificateStatus {
  holderName: string | null;
  courseName: string | null;
  issuedAt: Date;
  /**
   * `valid`, `revoked`, or `invalid`. `invalid` is the enrolment-reversed case:
   * the certificate was not revoked, but the completion it certifies has been
   * undone. `expired` is not produced: no expiry is recorded on a certificate.
   */
  status: 'valid' | 'revoked' | 'invalid';
}

/**
 * The public verification lookup. Unauthenticated, so there is no session to
 * take a tenant from, and the tenant is not taken from the caller either. The
 * verification code is random and globally unique, so it names exactly one
 * certificate and that row names its tenant. The certificate number cannot do
 * this job: it is unique only within a tenant, and sequential. Everything after
 * the first lookup runs inside `asSystem(tenantId)`, the pattern marketing's
 * public form submission uses (domains/marketing/capture.ts:376).
 *
 * The names come from the enrolment, not the snapshot. The snapshot is free-form
 * and issuer-supplied; the enrolment is the record the certificate says was
 * completed. An enrolment with no person or course on it yields null, not a guess.
 */
export async function publicCertificateStatus(code: string): Promise<PublicCertificateStatus> {
  const located = await unscopedPrisma.certificate.findUnique({
    where: { verificationCode: code },
    select: { tenantId: true, enrollmentId: true, status: true, issuedAt: true },
  });
  if (!located) throw ApiError.notFound('Certificate');

  return asSystem(located.tenantId, async () => {
    const enrollment = await prisma.enrollment.findFirst({
      where: { id: located.enrollmentId, tenantId: located.tenantId },
      select: { status: true, personId: true, cohort: { select: { course: { select: { name: true } } } } },
    });
    const person = enrollment
      ? await prisma.person.findFirst({
          where: { id: enrollment.personId, tenantId: located.tenantId },
          select: { fullName: true },
        })
      : null;

    let status: PublicCertificateStatus['status'];
    if (located.status === 'revoked') status = 'revoked';
    else if (enrollment?.status === 'completed') status = 'valid';
    else status = 'invalid';

    return {
      holderName: person?.fullName ?? null,
      courseName: enrollment?.cohort.course.name ?? null,
      issuedAt: located.issuedAt,
      status,
    };
  });
}

/**
 * Revocation changes the status and records why; the row stays, so a verifier
 * who was shown the certificate can be told it was withdrawn and by what
 * reason. A revoked certificate is never reissued in place. A correction is a
 * new certificate.
 */
export async function revokeCertificate(id: string, reason: string) {
  await assertCan({ resource: 'certificates', verb: 'edit' });
  const auth = currentAuth();
  const existing = await prisma.certificate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Certificate');

  const now = new Date();
  const { count } = await prisma.certificate.updateMany({
    where: { id, tenantId: auth.tenantId, status: 'valid' },
    data: { status: 'revoked', revokedAt: now, revokedReason: reason },
  });
  if (count !== 1) throw ApiError.conflict(`Certificate is already ${existing.status}.`);

  await auditWrite({
    action: 'update',
    subjectType: 'certificate',
    subjectId: id,
    before: { status: existing.status },
    after: { status: 'revoked', revokedReason: reason },
  });

  return toCertificateReadModel(await prisma.certificate.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } }));
}
