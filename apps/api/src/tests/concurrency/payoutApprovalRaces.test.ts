/**
 * Two approvals of one money-out request, racing (domains/payouts.ts approvePayout).
 *
 * The approval takes the request's row FOR UPDATE and re-reads its state under
 * the lock before it settles the bill (the comment at that lock). Without the
 * re-read, both approvals pass the state check that runs before the lock, and both
 * settle: the bill is paid twice and two out rows reach the cashbook.
 *
 * The approver's MFA enrolment is switched on once around the whole race. Each
 * approval would otherwise switch it on and off around itself (withMfaEnrolled),
 * and the first to finish would take it away while the second still needed it,
 * so the second could fail on step-up and pass for the wrong reason.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asSystem } from '../../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant, unscopedPrisma, withMfaEnrolled } from '../helpers.js';
import { payVendorBill, recordVendorBill } from '../../domains/books.js';
import { approvePayout } from '../../domains/payouts.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('two approvals of one payout request, racing', () => {
  it('one approval settles the bill and the other is refused: one out row, the bill paid once', async () => {
    // A tenant of its own: this request, bill and cashbook are the only ones the
    // assertions count.
    const f = await booksTenant(`conc-payout-${randomUUID().slice(0, 8)}`);
    const bill = await asUser(f.finance, () =>
      recordVendorBill({ vendorName: `Race vendor ${stamp()}`, billDate: new Date(), subtotal: 5_000 }),
    );
    const request = await asUser(f.finance, () =>
      payVendorBill(bill.id, { amount: 5_000, accountId: f.bankAccountId, paidOn: new Date() }),
    );

    const settled = await withMfaEnrolled(f.chairman, () =>
      Promise.allSettled([1, 2].map(() => asUser(f.chairman, () => approvePayout(request.id)))),
    );

    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is refused as already approved (approvePayout's conflict, 409).
    expect(lost[0]!.reason).toMatchObject({ status: 409 });

    const after = await unscopedPrisma.payoutRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.state).toBe('approved');
    expect(after.transactionId).not.toBeNull();

    const outRows = await unscopedPrisma.transaction.findMany({
      where: { tenantId: f.tenantId, vendorBillId: bill.id, direction: 'out' },
    });
    expect(outRows).toHaveLength(1);
    expect(outRows[0]!.id).toBe(after.transactionId);
    expect(String(outRows[0]!.amount)).toBe('5000');

    const paid = await unscopedPrisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(paid.status).toBe('paid');

    assertTrialBalance(await asSystem(f.tenantId, () => journalTrialBalance(new Date())));
  });
});
