/**
 * Money out needs a second person (payments:approve; owner ruling 2026-10-13, C-005).
 *
 * A vendor bill payment, a manual or asset cash-out, a recurring out-rule (approved once,
 * as a rule), and a reversal of an inward row are all requests here. A request writes no
 * Transaction and moves no vendor bill. The approval writes both, in one database
 * transaction, under the request's row lock, so the figure approved is the figure written.
 *
 * Money in is not gated: a receipt or a bank credit is recorded at once.
 *
 * The requester may not approve. The founder is exempt: a founder's request counts at
 * once, and the audit meta says so (founderOverride payment_second_approver). An agent
 * principal may neither request nor approve (AI_PROHIBITED_ACTIONS, shared/src/ai.ts).
 */
import type { PayoutRequest, Transaction, VendorBill } from '@prisma/client';
import { EVENTS, decimalToMinor, formatMinor, parseMinor } from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { governedWrite } from '../platform/governedWrite.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { runHooks } from '../platform/hooks.js';
import { registerGovernedEntities, auditWrite } from '../platform/audit.js';
import { assertStepUpForApprove } from './compliance/corporate/security.js';
import { isFounder } from './statutory.js';
import { reverseTransactionIn, writeTransactionMinor, type TransactionInputMinor } from './books.js';

registerGovernedEntities('fin', ['payout_request']);

export type PayoutKind = 'payment' | 'reversal' | 'recurring_rule';

export interface PayoutDraft {
  kind: PayoutKind;
  source: string;
  txnDate: Date;
  amountMinor: bigint;
  accountId: string;
  categoryId?: string | null;
  division?: string | null;
  counterparty?: string | null;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  vendorBillId?: string | null;
  fixedAssetId?: string | null;
  recurringRuleId?: string | null;
  reversesTransactionId?: string | null;
  intercompanyTenantId?: string | null;
}

/** What an approval (or a founder's request) wrote. Null where the kind writes no cashbook row. */
export interface PayoutSettlement {
  request: PayoutRequest;
  transaction: Transaction | null;
  bill: VendorBill | null;
}

const FOUNDER_OVERRIDE = { founderOverride: ['payment_second_approver'] } as const;

/** Refused on the way in, before any row is read: an agent may not move money out on its own. */
function refuseAgent(action: string): void {
  if (currentAuth().principalType === 'agent') {
    throw ApiError.forbidden(`An AI principal may never ${action}.`);
  }
}

/**
 * Asks for money to go out. The caller has already checked its own grant and the period
 * (checkTransactionAllowed or the vendor bill checks). A founder's request is settled in
 * the same transaction, so it counts at once.
 */
export async function requestPayout(draft: PayoutDraft): Promise<PayoutRequest> {
  refuseAgent('request a payment');
  await assertCan({ resource: 'payments', verb: 'create' });
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.forbidden('A payment request needs a person behind it.');
  if (draft.amountMinor <= 0n) {
    throw ApiError.unprocessable('An amount is always positive — `direction` says which way the money went.');
  }
  const founder = await isFounder();

  return governedWrite(async (tx) => {
    const recordCode = await nextRecordCode('PO', new Date(), tx);
    const row = await tx.payoutRequest.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        kind: draft.kind,
        source: draft.source,
        state: 'requested',
        direction: 'out',
        txnDate: draft.txnDate,
        amountMinor: draft.amountMinor,
        accountId: draft.accountId,
        categoryId: draft.categoryId ?? null,
        division: draft.division ?? null,
        counterparty: draft.counterparty ?? null,
        method: draft.method ?? null,
        reference: draft.reference ?? null,
        note: draft.note ?? null,
        vendorBillId: draft.vendorBillId ?? null,
        fixedAssetId: draft.fixedAssetId ?? null,
        recurringRuleId: draft.recurringRuleId ?? null,
        reversesTransactionId: draft.reversesTransactionId ?? null,
        intercompanyTenantId: draft.intercompanyTenantId ?? null,
        requestedById: auth.partyId as string,
        founderWaived: founder,
      },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'payout_request',
      subjectId: row.id,
      after: {
        recordCode,
        kind: row.kind,
        source: row.source,
        state: 'requested',
        amount: formatMinor(row.amountMinor),
      },
      ...(founder ? { meta: FOUNDER_OVERRIDE } : {}),
      tx,
    });
    await emit({
      name: EVENTS.PAYOUT_REQUESTED,
      subject: { entityType: 'payout_request', entityId: row.id, recordCode },
      newState: { state: 'requested', kind: row.kind, amount: formatMinor(row.amountMinor) },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
    if (!founder) return row;
    const settled = await settleInTx(tx, row, {
      decidedById: auth.partyId as string,
      decisionNote: null,
      founderWaived: true,
    });
    return settled.request;
  });
}

/**
 * Asks for a reversal of an inward row. A reversal of a receipt writes an outward row, so
 * it is a request like any other money out. The checks reverseTransactionIn makes at
 * approval are made here too, so a refusal is given up front and not at approval time.
 */
export async function requestReversalOfInward(originalId: string, reason: string): Promise<PayoutRequest> {
  const auth = currentAuth();
  const original = await prisma.transaction.findFirst({
    where: { id: originalId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!original) throw ApiError.notFound('Transaction');
  if (original.reversedById) {
    throw ApiError.conflict('This entry has already been reversed.', { reversalId: original.reversedById });
  }
  if (original.reversalOfId) {
    throw ApiError.unprocessable('This entry is itself a reversal. Reversing it would restore the original error.');
  }
  const pending = await prisma.payoutRequest.findFirst({
    where: { tenantId: auth.tenantId, reversesTransactionId: originalId, state: 'requested' },
  });
  if (pending) {
    throw ApiError.conflict('A reversal of this entry is already waiting for approval.', { requestId: pending.id });
  }
  return requestPayout({
    kind: 'reversal',
    source: 'reversal',
    txnDate: new Date(),
    amountMinor: parseMinor(original.amount.toFixed(2)),
    accountId: original.accountId,
    categoryId: original.categoryId,
    division: original.division,
    counterparty: original.counterparty,
    method: original.method,
    reference: original.reference,
    note: reason,
    reversesTransactionId: original.id,
  });
}

/**
 * A recurring out-rule's amount, direction and account, approved once. Approval writes no
 * Transaction: each occurrence posts without another approval while the rule's values are
 * the ones approved. A change to any of the three needs a fresh approval (generateRecurring).
 */
export async function requestRecurringRuleApproval(ruleId: string): Promise<PayoutRequest> {
  const auth = currentAuth();
  await assertScopeAll('transactions', 'create');
  const rule = await prisma.recurringRule.findFirst({ where: { id: ruleId, tenantId: auth.tenantId } });
  if (!rule) throw ApiError.notFound('Recurring rule');
  if (rule.direction !== 'out') {
    throw ApiError.unprocessable('Only a recurring cash-out needs approval. A recurring receipt posts without one.');
  }
  return requestPayout({
    kind: 'recurring_rule',
    source: 'recurring_rule',
    txnDate: rule.startDate,
    amountMinor: rule.amountMinor,
    accountId: rule.accountId,
    categoryId: rule.categoryId,
    division: rule.division,
    note: rule.label,
    recurringRuleId: rule.id,
  });
}

/** The approved snapshot a recurring out-rule must match before it posts. Null if none does. */
export async function approvedRuleSnapshot(ruleId: string): Promise<PayoutRequest | null> {
  const auth = currentAuth();
  return prisma.payoutRequest.findFirst({
    where: { tenantId: auth.tenantId, recurringRuleId: ruleId, kind: 'recurring_rule', state: 'approved' },
    orderBy: { decidedAt: 'desc' },
  });
}

/**
 * Approves a request. Needs payments:approve and a second person: the requester may not
 * approve. The period, and a vendor bill's own pre-payment checks, run again here because
 * the bill or the period may have changed since the request.
 */
export async function approvePayout(id: string, note?: string | null): Promise<PayoutSettlement> {
  refuseAgent('approve a payment');
  await assertStepUpForApprove('Approving a payment');
  await assertCan({ resource: 'payments', verb: 'approve' });
  const auth = currentAuth();
  const row = await prisma.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Payment request');
  if (row.state !== 'requested') {
    throw ApiError.conflict(`This payment request is '${row.state}'. Only a requested one can be approved.`);
  }
  if (row.requestedById === auth.partyId) {
    throw ApiError.forbidden('The person who asked for a payment cannot also approve it.', [
      { axis: 'WHO', passed: false, reason: 'self_approval_barred' },
    ]);
  }

  // Outside the transaction: the hooks read through the scoped client, which cannot run inside one.
  if (row.kind !== 'recurring_rule') {
    await runHooks('transaction.before_record', {
      txnDate: row.kind === 'reversal' ? new Date() : row.txnDate,
      source: row.source,
    });
  }
  if (row.vendorBillId) {
    const bill = await prisma.vendorBill.findFirst({ where: { id: row.vendorBillId, tenantId: auth.tenantId } });
    if (bill) await runHooks('vendor_bill.before_pay', { bill, amount: formatMinor(row.amountMinor) });
  }

  return governedWrite(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payout_requests" WHERE "tenantId" = ${auth.tenantId} AND "id" = ${id} FOR UPDATE`;
    const locked = await tx.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!locked || locked.state !== 'requested') {
      throw ApiError.conflict(
        `This payment request is '${locked?.state ?? 'missing'}'. Only a requested one can be approved.`,
      );
    }
    return settleInTx(tx, locked, {
      decidedById: auth.partyId as string,
      decisionNote: note ?? null,
      founderWaived: false,
    });
  });
}

/** Declines a request. The approver declines; the requester withdraws (withdrawPayout). */
export async function declinePayout(id: string, note: string): Promise<PayoutRequest> {
  refuseAgent('decline a payment');
  await assertCan({ resource: 'payments', verb: 'approve' });
  const auth = currentAuth();
  if (!note.trim()) throw ApiError.unprocessable('Say why the payment is declined.');
  const row = await prisma.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Payment request');
  if (row.requestedById === auth.partyId) {
    throw ApiError.forbidden('The person who asked for a payment cannot also decline it. They may withdraw it.');
  }

  return governedWrite(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payout_requests" WHERE "tenantId" = ${auth.tenantId} AND "id" = ${id} FOR UPDATE`;
    const locked = await tx.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!locked || locked.state !== 'requested') {
      throw ApiError.conflict(`This payment request is '${locked?.state ?? 'missing'}', not 'requested'.`);
    }
    const updated = await tx.payoutRequest.update({
      where: { id },
      data: { state: 'declined', decidedById: auth.partyId, decidedAt: new Date(), decisionNote: note },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'payout_request',
      subjectId: id,
      before: { state: 'requested' },
      after: { state: 'declined', decisionNote: note },
      tx,
    });
    await emit({
      name: EVENTS.PAYOUT_DECLINED,
      subject: { entityType: 'payout_request', entityId: id, recordCode: updated.recordCode },
      newState: { state: 'declined' },
      reason: { reasonCode: 'declined', note },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
    return updated;
  });
}

/** The requester takes a request back before it is decided. Nothing is written to the books. */
export async function withdrawPayout(id: string): Promise<PayoutRequest> {
  refuseAgent('withdraw a payment request');
  await assertCan({ resource: 'payments', verb: 'create' });
  const auth = currentAuth();
  const row = await prisma.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Payment request');
  if (row.requestedById !== auth.partyId) {
    throw ApiError.forbidden('Only the person who asked for a payment can withdraw it.');
  }

  return governedWrite(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payout_requests" WHERE "tenantId" = ${auth.tenantId} AND "id" = ${id} FOR UPDATE`;
    const locked = await tx.payoutRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!locked || locked.state !== 'requested') {
      throw ApiError.conflict(`This payment request is '${locked?.state ?? 'missing'}', not 'requested'.`);
    }
    const updated = await tx.payoutRequest.update({
      where: { id },
      data: { state: 'withdrawn', decidedById: auth.partyId, decidedAt: new Date() },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'payout_request',
      subjectId: id,
      before: { state: 'requested' },
      after: { state: 'withdrawn' },
      tx,
    });
    await emit({
      name: EVENTS.PAYOUT_WITHDRAWN,
      subject: { entityType: 'payout_request', entityId: id, recordCode: updated.recordCode },
      newState: { state: 'withdrawn' },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
    return updated;
  });
}

export async function listPayoutRequests(filter: { state?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payments', verb: 'view' });
  return prisma.payoutRequest.findMany({
    where: { tenantId: auth.tenantId, ...(filter.state ? { state: filter.state } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: 200,
  });
}

/**
 * The write half of an approval, and of a founder's request. Runs in the caller's
 * transaction: the cashbook row (or the reversal, or the bill's payment), the request's
 * own state, and then the audit and event, in that order (CLAUDE.md rule 5).
 */
async function settleInTx(
  tx: DbTx,
  row: PayoutRequest,
  opts: { decidedById: string; decisionNote: string | null; founderWaived: boolean },
): Promise<PayoutSettlement> {
  const auth = currentAuth();
  let transaction: Transaction | null = null;
  let bill: VendorBill | null = null;

  if (row.kind === 'payment' && row.vendorBillId) {
    // The bill's row lock, then the outstanding check in paise: two requests against one
    // bill cannot both pass it, because the second waits here and reads the first's payment.
    await tx.$queryRaw`SELECT "id" FROM "vendor_bills" WHERE "tenantId" = ${auth.tenantId} AND "id" = ${row.vendorBillId} FOR UPDATE`;
    const current = await tx.vendorBill.findFirst({
      where: { id: row.vendorBillId, tenantId: auth.tenantId, deletedAt: null },
    });
    if (!current) throw ApiError.notFound('Vendor bill');
    if (current.status === 'cancelled') throw ApiError.unprocessable('This bill was cancelled.');
    const paidBefore = current.paidAmount ? decimalToMinor(current.paidAmount) : 0n;
    const total = decimalToMinor(current.total);
    const outstanding = total - paidBefore;
    if (row.amountMinor > outstanding) {
      throw ApiError.unprocessable(
        `That is more than is outstanding on ${current.recordCode} (₹${formatMinor(outstanding)}). ` +
          'An overpayment needs a credit note rather than a larger payment.',
      );
    }
    transaction = await writeTransactionMinor(cashOutOf(row), tx);
    const paidAfter = paidBefore + row.amountMinor;
    const status = paidAfter >= total ? 'paid' : 'part_paid';
    bill = await tx.vendorBill.update({
      where: { id: current.id },
      data: { paidAmount: formatMinor(paidAfter), status },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'vendor_bill',
      subjectId: current.id,
      before: { paidAmount: formatMinor(paidBefore), status: current.status },
      after: { paidAmount: formatMinor(paidAfter), status },
      tx,
    });
    await emit({
      name: EVENTS.VENDOR_BILL_PAID,
      subject: { entityType: 'vendor_bill', entityId: current.id, recordCode: current.recordCode },
      newState: { amount: formatMinor(row.amountMinor), paidAmount: formatMinor(paidAfter), status },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
  } else if (row.kind === 'payment') {
    transaction = await writeTransactionMinor(cashOutOf(row), tx);
  } else if (row.kind === 'reversal') {
    if (!row.reversesTransactionId) throw ApiError.conflict('This reversal names no entry to reverse.');
    transaction = await reverseTransactionIn(tx, row.reversesTransactionId, {
      reason: row.note ?? 'Reversal approved',
    });
  }
  // A recurring_rule approval writes no Transaction: it approves the rule's values.

  const decided = await tx.payoutRequest.update({
    where: { id: row.id },
    data: {
      state: 'approved',
      decidedById: opts.decidedById,
      decidedAt: new Date(),
      decisionNote: opts.decisionNote,
      transactionId: transaction?.id ?? null,
      founderWaived: opts.founderWaived,
    },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'payout_request',
    subjectId: row.id,
    before: { state: row.state },
    after: { state: 'approved', transactionId: transaction?.id ?? null },
    ...(opts.founderWaived ? { meta: FOUNDER_OVERRIDE } : {}),
    tx,
  });
  await emit({
    name: EVENTS.PAYOUT_APPROVED,
    subject: { entityType: 'payout_request', entityId: row.id, recordCode: row.recordCode },
    newState: { state: 'approved', amount: formatMinor(row.amountMinor), transactionId: transaction?.id ?? null },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
    tx,
  });
  return { request: decided, transaction, bill };
}

/** The cashbook row a request writes on approval. The figure is the request's own bigint. */
function cashOutOf(row: PayoutRequest): TransactionInputMinor {
  return {
    txnDate: row.txnDate,
    direction: 'out',
    amount: row.amountMinor,
    accountId: row.accountId,
    categoryId: row.categoryId,
    division: row.division,
    counterparty: row.counterparty,
    method: row.method ?? undefined,
    reference: row.reference,
    note: row.note,
    source: row.source,
    vendorBillId: row.vendorBillId,
    fixedAssetId: row.fixedAssetId,
    intercompanyTenantId: row.intercompanyTenantId,
  };
}
