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
import { auditWrite, registerGovernedEntities } from '../../../platform/audit.js';
import { assertStepUpForApprove } from './security.js';
import { documentPrefix } from '../../companyProfile.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../../platform/documentNumber.js';
import { checkTransactionAllowed, writeTransactionMinor } from '../../books.js';
import { rupeesToMinor, withDecimalMinor } from '../../../platform/wire.js';
import { isFounder, type FounderOverride } from '../../statutory.js';

// Registered beside the writer for the reason given in corporate/board.ts.
registerGovernedEntities('cmp_corporate', ['refund', 'refund_policy']);

export async function listRefunds(status?: string) {
  await assertCan({ resource: 'refunds', verb: 'view' });
  const auth = currentAuth();
  const rows = await prisma.refund.findMany({
    where: { tenantId: auth.tenantId, ...(status ? { status } : {}) },
    orderBy: { requestedAt: 'desc' },
  });
  return rows.map((row) => withDecimalMinor(row, ['amount'] as const));
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
  // The number and the row it names commit together. Taken on the global client it
  // stayed taken when this write was refused, and the series had a hole in it.
  const { recordCode, refund } = await prisma.$transaction(async (tx) => {
    const recordCode = await nextDocumentNumber(tx, DOCUMENT_SERIES.refund, prefix);
    const refund = await tx.refund.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        invoiceId: input.invoiceId ?? null,
        receiptId: input.receiptId ?? null,
        amountMinor: rupeesToMinor(input.amount),
        reason: input.reason,
        status: 'requested',
        requestedById: auth.partyId!,
      },
    });
    return { recordCode, refund };
  });

  await auditWrite({
    action: 'create',
    subjectType: 'refund',
    subjectId: refund.id,
    after: { recordCode, amount: input.amount },
  });
  return withDecimalMinor(refund, ['amount'] as const);
}

/** CMP-COR-004 / the proposer-never-approves rule: approver cannot be the requester. */
export async function approveRefund(id: string) {
  await assertStepUpForApprove('Approving a refund');
  await assertCan({ resource: 'refunds', verb: 'approve' });
  const auth = currentAuth();
  const refund = await prisma.refund.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!refund) throw ApiError.notFound('Refund');
  if (refund.status !== 'requested') {
    throw ApiError.unprocessable(
      `This refund is '${refund.status}', not 'requested'. Only a requested refund can be approved.`,
    );
  }
  // The founder is exempt (owner ruling 2026-10-12), and the waiver is audited as
  // author_is_approver, so the exemption is on the record rather than silent.
  const founderOverride: FounderOverride[] = [];
  if (refund.requestedById === auth.partyId) {
    if (!(await isFounder())) {
      throw ApiError.forbidden('The person who requested a refund cannot also approve it.', [
        { axis: 'WHO', passed: false, reason: 'self_approval_barred' },
      ]);
    }
    founderOverride.push('author_is_approver');
  }

  const updated = await prisma.refund.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'refund',
    subjectId: id,
    before: { status: 'requested' },
    after: { status: 'approved' },
    ...(founderOverride.length > 0 ? { meta: { founderOverride } } : {}),
  });
  return withDecimalMinor(updated, ['amount'] as const);
}

/**
 * Books the outward movement. Never touches the original invoice/receipt —
 * `writeTransactionMinor` writes a new row, direction `out`, source `refund`, inside the
 * payment's own transaction. The refund amount stays bigint paise end to end: the row's
 * `amountMinor` is the figure written, never a Decimal read back as a JavaScript number.
 */
export async function payRefund(id: string, input: { accountId: string; method?: string; reference?: string | null }) {
  await assertStepUpForApprove('Paying a refund');
  await assertCan({ resource: 'refunds', verb: 'edit' });
  const auth = currentAuth();
  const refund = await prisma.refund.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!refund) throw ApiError.notFound('Refund');
  if (refund.status !== 'approved') {
    throw ApiError.unprocessable(
      `This refund is '${refund.status}', not 'approved'. Only an approved refund can be paid.`,
    );
  }

  await checkTransactionAllowed({ txnDate: new Date(), source: 'refund' });

  // One transaction, so the outward movement and the refund's own move to paid
  // commit together or not at all. The row lock is the idempotency guard: a second
  // payment waits on it, then reads 'paid' and is refused, so a retry after a
  // failed update books one payment, not two (FX-33).
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "compliance_refunds"
      WHERE "id" = ${id} AND "tenantId" = ${auth.tenantId}
      FOR UPDATE`;
    if (locked?.status !== 'approved') {
      throw ApiError.unprocessable(
        `This refund is '${locked?.status ?? 'missing'}', not 'approved'. Only an approved refund can be paid.`,
      );
    }

    const txn = await writeTransactionMinor(
      {
        txnDate: new Date(),
        direction: 'out',
        amount: refund.amountMinor,
        accountId: input.accountId,
        method: input.method ?? 'bank_transfer',
        reference: input.reference ?? refund.recordCode,
        note: `Refund ${refund.recordCode} — ${refund.reason}`,
        source: 'refund',
      },
      tx,
    );

    const updated = await tx.refund.update({
      where: { id },
      data: { status: 'paid', paidPaymentId: txn.id, paidAt: new Date() },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'refund',
      subjectId: id,
      before: { status: 'approved' },
      after: { status: 'paid', paidPaymentId: txn.id },
      tx,
    });
    return withDecimalMinor(updated, ['amount'] as const);
  });
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
  const last = await prisma.refundPolicy.findFirst({
    where: { tenantId: auth.tenantId },
    orderBy: { version: 'desc' },
  });
  const version = (last?.version ?? 0) + 1;
  const policy = await prisma.refundPolicy.create({
    data: {
      tenantId: auth.tenantId,
      version,
      text: input.text,
      rules: input.rules as never,
      effectiveFrom: new Date(),
    },
  });
  await auditWrite({ action: 'create', subjectType: 'refund_policy', subjectId: policy.id, after: { version } });
  return policy;
}
