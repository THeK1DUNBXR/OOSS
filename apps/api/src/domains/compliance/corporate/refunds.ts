/**
 * Refunds (docs/plan/compliance.md, H — CMP-COR-004).
 *
 * A refund is its own Movement fact: requesting and approving are decisions
 * recorded on the `Refund` row itself; paying books an outward transaction
 * through `books.recordTransaction` (source `'refund'`) rather than editing
 * the original invoice or receipt. Nothing about the original document ever
 * changes — a refunded invoice stays exactly what it said on the day it was
 * issued, and the refund is a second, separate fact standing next to it.
 *
 * The proposer never approves (Canon-wide rule, restated here explicitly):
 * `approvedById` is compared against `requestedById`, not inferred from role.
 */

import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { assertStepUpForApprove } from './security.js';
import { documentPrefix } from '../../companyProfile.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../../platform/documentNumber.js';
import { recordTransaction } from '../../books.js';

export async function listRefunds(status?: string) {
  await assertCan({ resource: 'refunds', verb: 'view' });
  const auth = currentAuth();
  return prisma.refund.findMany({
    where: { tenantId: auth.tenantId, ...(status ? { status } : {}) },
    orderBy: { requestedAt: 'desc' },
  });
}

export async function requestRefund(input: {
  invoiceId?: string | null;
  receiptId?: string | null;
  amount: number;
  reason: string;
}) {
  await assertCan({ resource: 'refunds', verb: 'create' });
  const auth = currentAuth();

  if (!input.invoiceId && !input.receiptId) {
    throw ApiError.badRequest('A refund needs at least one of invoiceId or receiptId — what it is a refund of.');
  }
  if (!(input.amount > 0)) {
    throw ApiError.unprocessable('A refund amount is always positive.');
  }

  const prefix = await documentPrefix();
  const recordCode = await nextDocumentNumber(DOCUMENT_SERIES.refund, prefix);

  const refund = await prisma.refund.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      invoiceId: input.invoiceId ?? null,
      receiptId: input.receiptId ?? null,
      amount: input.amount,
      reason: input.reason,
      status: 'requested',
      requestedById: auth.partyId!,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'refund', subjectId: refund.id, after: { recordCode, amount: input.amount } });
  return refund;
}

/** CMP-COR-004 / the proposer-never-approves rule: approver cannot be the requester. */
export async function approveRefund(id: string) {
  await assertStepUpForApprove('Approving a refund');
  await assertCan({ resource: 'refunds', verb: 'approve' });
  const auth = currentAuth();
  const refund = await prisma.refund.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!refund) throw ApiError.notFound('Refund');
  if (refund.status !== 'requested') {
    throw ApiError.unprocessable(`This refund is '${refund.status}', not 'requested'. Only a requested refund can be approved.`);
  }
  if (refund.requestedById === auth.partyId) {
    throw ApiError.forbidden('The person who requested a refund cannot also approve it.', [
      { axis: 'WHO', passed: false, reason: 'self_approval_barred' },
    ]);
  }

  const updated = await prisma.refund.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'refund', subjectId: id, before: { status: 'requested' }, after: { status: 'approved' } });
  return updated;
}

/**
 * Books the outward movement. Never touches the original invoice/receipt —
 * `recordTransaction` writes a new row, direction `out`, source `refund`.
 */
export async function payRefund(id: string, input: { accountId: string; method?: string; reference?: string | null }) {
  await assertStepUpForApprove('Paying a refund');
  await assertCan({ resource: 'refunds', verb: 'edit' });
  const auth = currentAuth();
  const refund = await prisma.refund.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!refund) throw ApiError.notFound('Refund');
  if (refund.status !== 'approved') {
    throw ApiError.unprocessable(`This refund is '${refund.status}', not 'approved'. Only an approved refund can be paid.`);
  }

  const txn = await recordTransaction({
    txnDate: new Date(),
    direction: 'out',
    amount: Number(refund.amount.toString()),
    accountId: input.accountId,
    method: input.method ?? 'bank_transfer',
    reference: input.reference ?? refund.recordCode,
    note: `Refund ${refund.recordCode} — ${refund.reason}`,
    source: 'refund',
  });

  const updated = await prisma.refund.update({
    where: { id },
    data: { status: 'paid', paidPaymentId: txn.id, paidAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'refund', subjectId: id, before: { status: 'approved' }, after: { status: 'paid', paidPaymentId: txn.id } });
  return updated;
}

// ---------------------------------------------------------------------------
// Refund policy — versioned, never edited in place
// ---------------------------------------------------------------------------

export async function currentRefundPolicy() {
  const auth = currentAuth();
  return prisma.refundPolicy.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { version: 'desc' } });
}

export async function listRefundPolicyVersions() {
  const auth = currentAuth();
  return prisma.refundPolicy.findMany({ where: { tenantId: auth.tenantId }, orderBy: { version: 'desc' } });
}

export async function publishRefundPolicy(input: {
  text: string;
  rules: { fullWithinDays: number; partialPercent: number; noneAfterStartDays: number };
}) {
  await assertCan({ resource: 'refunds', verb: 'create' });
  const auth = currentAuth();
  const last = await prisma.refundPolicy.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const policy = await prisma.refundPolicy.create({
    data: { tenantId: auth.tenantId, version, text: input.text, rules: input.rules as never, effectiveFrom: new Date() },
  });
  await auditWrite({ action: 'create', subjectType: 'refund_policy', subjectId: policy.id, after: { version } });
  return policy;
}
