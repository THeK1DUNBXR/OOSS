/**
 * FEMA — foreign receipts and their inward remittance certificate (FIRC).
 *
 * `Payment.foreignCurrency/foreignAmount/fircNumber/fircDate` already exist
 * on `main.prisma` (workstream H fields). This is the update path — a
 * regular, audited edit to those four fields, and the monthly sweep that
 * raises an exception on a foreign receipt still missing its FIRC after
 * thirty days.
 */

import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { raiseException } from '../../../platform/exceptions.js';

export interface ForeignReceiptInput {
  foreignCurrency?: string | null;
  foreignAmount?: number | null;
  fircNumber?: string | null;
  fircDate?: Date | null;
}

export async function setForeignReceiptDetails(paymentId: string, input: ForeignReceiptInput) {
  await assertCan({ resource: 'payments', verb: 'edit' });
  const auth = currentAuth();
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, tenantId: auth.tenantId } });
  if (!payment) throw ApiError.notFound('Payment');

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      ...(input.foreignCurrency !== undefined ? { foreignCurrency: input.foreignCurrency } : {}),
      ...(input.foreignAmount !== undefined ? { foreignAmount: input.foreignAmount } : {}),
      ...(input.fircNumber !== undefined ? { fircNumber: input.fircNumber } : {}),
      ...(input.fircDate !== undefined ? { fircDate: input.fircDate } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'payment',
    subjectId: paymentId,
    before: {
      foreignCurrency: payment.foreignCurrency,
      foreignAmount: payment.foreignAmount,
      fircNumber: payment.fircNumber,
      fircDate: payment.fircDate,
    },
    after: {
      foreignCurrency: updated.foreignCurrency,
      foreignAmount: updated.foreignAmount,
      fircNumber: updated.fircNumber,
      fircDate: updated.fircDate,
    },
    force: true,
  });

  return updated;
}

const FIRC_GRACE_DAYS = 30;

/** Monthly sweep: a foreign receipt older than thirty days with no FIRC number raises CMP_FEMA_FIRC_MISSING. */
export async function detectMissingFircs(): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - FIRC_GRACE_DAYS * 86_400_000);

  const overdue = await prisma.payment.findMany({
    where: {
      tenantId: auth.tenantId,
      foreignCurrency: { not: null },
      fircNumber: null,
      receivedAt: { lt: cutoff },
    },
    take: 200,
  });

  for (const payment of overdue) {
    const owner = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug: 'finance_head', status: 'active' },
      select: { partyId: true },
    });
    await raiseException({
      code: 'CMP_FEMA_FIRC_MISSING',
      label: 'Foreign receipt has no FIRC on file',
      severity: 'S2_WARNING',
      subjectType: 'payment',
      subjectId: payment.id,
      subjectLabel: `${payment.recordCode} — ${payment.foreignCurrency} ${payment.foreignAmount ?? ''}`.trim(),
      domain: 'cmp',
      detail: `Received ${payment.receivedAt.toISOString().slice(0, 10)}, more than ${FIRC_GRACE_DAYS} days ago, with no inward remittance certificate number recorded.`,
      ownerPartyId: owner?.partyId ?? null,
      triggerFingerprint: 'fema_firc_missing',
      ladderRung: 1,
    });
  }

  return overdue.length;
}
