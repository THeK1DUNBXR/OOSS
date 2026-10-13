/**
 * FX-33: paying a refund is one transaction, and a retry after a failed update
 * pays once (archive phase-1-ledger.md; FIXES.md row FX-33,
 * domains/compliance/corporate/refunds.ts:104-122 before the fix).
 *
 * The failure is real: the owner installs a trigger that refuses the refund's
 * update to 'paid', runs the first payment, and removes the trigger before the
 * retry. No mock. Before the fix, the outward transaction was committed on its
 * own, so the failed update left a payment booked against an approved refund,
 * and the retry booked a second one.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, tenantId, unscopedPrisma } from '../helpers.js';
import { payRefund } from '../../domains/compliance/corporate/refunds.js';
import { generateTotpSecret } from '../../domains/compliance/corporate/totp.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const INJECTED_TRIGGER = 'fx33_refuse_paid';

let TENANT: string;
let accountId: string;
const refundIds: string[] = [];

beforeAll(async () => {
  TENANT = await tenantId();
  const account = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: TENANT, name: `FX-33 bank ${randomUUID().slice(0, 8)}`, accountType: 'bank' },
  });
  accountId = account.id;

  // Paying is gated by MFA for the chairman role, as in CMP-COR-004.
  const chairman = await unscopedPrisma.user.findFirstOrThrow({ where: { email: CHAIRMAN, tenantId: TENANT } });
  await unscopedPrisma.user.update({
    where: { id: chairman.id },
    data: { mfaSecret: generateTotpSecret(), mfaEnabledAt: new Date() },
  });
});

afterAll(async () => {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${INJECTED_TRIGGER}" ON "compliance_refunds"`);
  const chairman = await unscopedPrisma.user.findFirstOrThrow({ where: { email: CHAIRMAN, tenantId: TENANT } });
  await unscopedPrisma.user.update({
    where: { id: chairman.id },
    data: { mfaSecret: null, mfaEnabledAt: null },
  });
});

/** An approved refund, written directly: the approval path is covered by CMP-COR-004. */
async function approvedRefund(amount = 500) {
  const refund = await unscopedPrisma.refund.create({
    data: {
      tenantId: TENANT,
      recordCode: `N-FX33-${randomUUID().slice(0, 8)}`,
      receiptId: 'REC-fixture-0001',
      amountMinor: BigInt(amount) * 100n,
      reason: 'FX-33 fixture',
      status: 'approved',
      requestedById: 'fx33-requester',
      approvedById: 'fx33-approver',
      approvedAt: new Date(),
    },
  });
  refundIds.push(refund.id);
  return refund;
}

/** The outward transactions booked for a refund, read as the owner so the test sees them all. */
function outwardFor(recordCode: string) {
  return unscopedPrisma.transaction.count({
    where: { tenantId: TENANT, source: 'refund', direction: 'out', reference: recordCode },
  });
}

describe('FX-33: a refund payment is one transaction with the refund update', () => {
  it('a failed refund update books no payment, and the retry books exactly one', async () => {
    const refund = await approvedRefund();

    // The owner refuses the update to 'paid' for this refund only, once.
    await unscopedPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fx33_refuse_paid() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fx33 injected failure'; END $$`);
    await unscopedPrisma.$executeRawUnsafe(`
      CREATE TRIGGER "${INJECTED_TRIGGER}" BEFORE UPDATE ON "compliance_refunds"
      FOR EACH ROW WHEN (NEW."id" = '${refund.id}' AND NEW."status" = 'paid')
      EXECUTE FUNCTION fx33_refuse_paid()`);

    const failure = await asUser(CHAIRMAN, () => expectReject(() => payRefund(refund.id, { accountId })));
    expect(failure.message).toMatch(/fx33 injected failure/);
    await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER "${INJECTED_TRIGGER}" ON "compliance_refunds"`);

    // The failed attempt is rolled back as a whole: no outward movement, still approved.
    expect(await outwardFor(refund.recordCode)).toBe(0);
    const afterFailure = await unscopedPrisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(afterFailure.status).toBe('approved');
    expect(afterFailure.paidPaymentId).toBeNull();

    // The retry pays once.
    const paid = await asUser(CHAIRMAN, () => payRefund(refund.id, { accountId }));
    expect(paid.status).toBe('paid');
    expect(await outwardFor(refund.recordCode)).toBe(1);
  });

  it('a second payment of a paid refund is refused and books nothing', async () => {
    const refund = await approvedRefund(750);
    await asUser(CHAIRMAN, () => payRefund(refund.id, { accountId }));

    const again = await asUser(CHAIRMAN, () => expectReject(() => payRefund(refund.id, { accountId })));
    expect(again.message).toMatch(/not 'approved'/);
    expect(await outwardFor(refund.recordCode)).toBe(1);
  });
});
