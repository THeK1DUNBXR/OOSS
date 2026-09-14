/**
 * Contracts: stamp duty, e-signature, retention (docs/plan/compliance.md, H).
 *
 * Stamp duty is checked at the point an MoU/Contract/PartnerAgreement is
 * signed — `agreements.ts` calls `assertStampDutySatisfied` from inside its
 * own `signed` transition, rather than this module reaching into that one's
 * state machine from outside.
 *
 * E-signature is a pluggable adapter, the same posture the plan takes with
 * GST e-invoicing: `NotConfiguredProvider` is what every tenant has until it
 * sets up a real one, and it fails with a named reason rather than pretending
 * to have sent something.
 */

import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { auditWrite } from '../../../platform/audit.js';
import type { AgreementKind } from '../../agreements.js';

// ---------------------------------------------------------------------------
// Stamp duty
// ---------------------------------------------------------------------------

/**
 * Refuses a `signed` transition when a stamp duty rule applies to this
 * agreement kind and no attached Document carries a `stampDutyRef` yet.
 * Silent when no rule is configured for the kind — there is nothing to gate
 * on, and a tenant that has not seeded its stamp duty table should not be
 * blocked from signing anything at all.
 */
export async function assertStampDutySatisfied(kind: AgreementKind, agreementId: string): Promise<void> {
  const auth = currentAuth();
  const rule = await prisma.stampDutyRule.findFirst({
    where: { tenantId: auth.tenantId, agreementKind: kind, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!rule) return;

  const stamped = await prisma.document.findFirst({
    where: {
      tenantId: auth.tenantId,
      attachedToType: kind,
      attachedToId: agreementId,
      deletedAt: null,
      stampDutyRef: { not: null },
    },
  });

  if (!stamped) {
    throw ApiError.unprocessable(
      `Stamp duty applies to this ${kind.replace('_', ' ')} (rule in force since ${rule.effectiveFrom.toISOString().slice(0, 10)}). ` +
        'Attach the stamped document with its stamp duty reference before marking it signed.',
      { reasonCode: 'stamp_duty_document_required', ruleId: rule.id },
    );
  }
}

export async function listStampDutyRules() {
  const auth = currentAuth();
  return prisma.stampDutyRule.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ agreementKind: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

// ---------------------------------------------------------------------------
// E-signature adapter
// ---------------------------------------------------------------------------

export interface ESignSigner {
  name: string;
  email: string;
}

export interface ESignRequestResult {
  envelopeRef: string;
}

export interface ESignStatusResult {
  status: 'sent' | 'signed' | 'declined' | 'expired';
}

export interface ESignProvider {
  key: string;
  request(documentId: string, signers: ESignSigner[]): Promise<ESignRequestResult>;
  status(envelopeRef: string): Promise<ESignStatusResult>;
}

/**
 * What every tenant has until it configures a real Aadhaar-eSign-or-DSC
 * provider. Fails with a named reason rather than pretending to send
 * anything — the same discipline the plan applies to e-invoicing without a
 * configured GSP adapter.
 */
export class NotConfiguredProvider implements ESignProvider {
  key = 'not_configured';
  async request(): Promise<ESignRequestResult> {
    throw ApiError.unprocessable('No e-signature provider is configured for this tenant.', { reasonCode: 'ESIGN_NOT_CONFIGURED' });
  }
  async status(): Promise<ESignStatusResult> {
    throw ApiError.unprocessable('No e-signature provider is configured for this tenant.', { reasonCode: 'ESIGN_NOT_CONFIGURED' });
  }
}

const PROVIDERS: Record<string, ESignProvider> = {
  not_configured: new NotConfiguredProvider(),
};

export async function resolveESignProvider(): Promise<ESignProvider> {
  const auth = currentAuth();
  const config = await prisma.eSignConfig.findFirst({ where: { tenantId: auth.tenantId, active: true } });
  if (!config) return new NotConfiguredProvider();
  return PROVIDERS[config.provider] ?? new NotConfiguredProvider();
}

export async function requestESignature(documentId: string, signers: ESignSigner[]) {
  const auth = currentAuth();
  const document = await prisma.document.findFirst({ where: { id: documentId, tenantId: auth.tenantId, deletedAt: null } });
  if (!document) throw ApiError.notFound('Document');

  const provider = await resolveESignProvider();
  const result = await provider.request(documentId, signers);

  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { eSignProvider: provider.key, eSignRef: result.envelopeRef },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'document',
    subjectId: documentId,
    before: { eSignProvider: document.eSignProvider, eSignRef: document.eSignRef },
    after: { eSignProvider: updated.eSignProvider, eSignRef: updated.eSignRef },
    meta: { signers: signers.map((s) => s.email) },
  });

  return updated;
}

export async function markESigned(documentId: string): Promise<void> {
  const auth = currentAuth();
  const document = await prisma.document.findFirst({ where: { id: documentId, tenantId: auth.tenantId } });
  if (!document || !document.eSignRef) throw ApiError.unprocessable('No e-signature request is in progress for this document.');
  await prisma.document.update({ where: { id: documentId }, data: { eSignedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Document retention
// ---------------------------------------------------------------------------

export async function listRetentionRules() {
  const auth = currentAuth();
  return prisma.documentRetentionRule.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ documentKind: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

/**
 * Sets `Document.retainUntil` from the seeded rule for its kind. The anchor
 * date is supplied by the caller — "8 years after expiry" needs to know when
 * the contract expired, which this module does not itself track.
 */
export async function applyRetention(documentId: string, anchorDate: Date) {
  const auth = currentAuth();
  const document = await prisma.document.findFirst({ where: { id: documentId, tenantId: auth.tenantId, deletedAt: null } });
  if (!document) throw ApiError.notFound('Document');

  const rule = await prisma.documentRetentionRule.findFirst({
    where: { tenantId: auth.tenantId, documentKind: document.documentKind, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!rule) {
    throw ApiError.unprocessable(`No retention rule is seeded for document kind '${document.documentKind}'.`);
  }

  const retainUntil = new Date(anchorDate);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + rule.years);

  const updated = await prisma.document.update({ where: { id: documentId }, data: { retainUntil } });

  await auditWrite({
    action: 'update',
    subjectType: 'document',
    subjectId: documentId,
    before: { retainUntil: document.retainUntil },
    after: { retainUntil: updated.retainUntil },
    meta: { ruleId: rule.id, anchor: rule.anchor },
  });

  return updated;
}
