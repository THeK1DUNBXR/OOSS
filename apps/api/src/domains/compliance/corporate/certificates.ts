/**
 * Certificates — final once issued, like every document in this platform. A
 * correction is a new certificate, never an edit to one already handed out.
 *
 * `GET .../verify/:code` is written to read the way a public verification
 * page would — no PII beyond what the certificate itself already carries —
 * but it sits behind `requireAuth` like everything else under
 * `/api/compliance`, so it is not actually reachable without a session. That
 * is stated here rather than left to be discovered: a genuinely public
 * verification page needs its own unauthenticated route, which is outside
 * this router's mount.
 */

import { randomBytes } from 'node:crypto';
import type { CertificateKind } from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { documentPrefix } from '../../companyProfile.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../../platform/documentNumber.js';

function verificationCode(): string {
  // Not the certificate number itself — a certificate number is sequential
  // and guessable, a verification code should not let somebody walk the
  // whole series by incrementing it.
  return randomBytes(9).toString('base64url');
}

export async function listCertificates(enrollmentId?: string) {
  await assertCan({ resource: 'certificates', verb: 'view' });
  const auth = currentAuth();
  return prisma.certificate.findMany({
    where: { tenantId: auth.tenantId, ...(enrollmentId ? { enrollmentId } : {}) },
    orderBy: { issuedAt: 'desc' },
  });
}

export async function issueCertificate(input: {
  enrollmentId: string;
  kind: CertificateKind;
  snapshot: Record<string, unknown>;
}) {
  await assertCan({ resource: 'certificates', verb: 'create' });
  const auth = currentAuth();
  const prefix = await documentPrefix();
  const number = await nextDocumentNumber(DOCUMENT_SERIES.certificate, prefix);

  const certificate = await prisma.certificate.create({
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

  await auditWrite({ action: 'create', subjectType: 'certificate', subjectId: certificate.id, after: { number, enrollmentId: input.enrollmentId } });
  return certificate;
}

/** What a verifier sees: enough to confirm authenticity, nothing that was not already on the certificate face. */
export async function verifyCertificate(code: string) {
  await assertCan({ resource: 'certificates', verb: 'view' });
  const auth = currentAuth();
  const certificate = await prisma.certificate.findFirst({ where: { tenantId: auth.tenantId, verificationCode: code } });
  if (!certificate) throw ApiError.notFound('Certificate');
  return {
    number: certificate.number,
    kind: certificate.kind,
    issuedAt: certificate.issuedAt,
    snapshot: certificate.snapshot,
    valid: true,
  };
}
