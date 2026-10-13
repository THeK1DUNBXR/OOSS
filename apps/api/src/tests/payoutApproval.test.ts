/**
 * payments:approve on money out (owner ruling 2026-10-13; C-005, round 23b).
 *
 * A money-out request writes no Transaction and moves no vendor bill until a second person
 * with payments:approve approves it. The requester may not approve; the founder's request
 * counts at once, with the waiver in the audit meta; an agent may neither ask nor approve.
 * Money in is recorded at once. A recurring out-rule is approved once as a rule.
 *
 * The approver in these tests is the chairman, who is both the founder and the only
 * payments:approve holder. Self-approval is tested with a fixture role that holds
 * payments:approve but is not the founder, so the refusal comes from the requester check
 * and not from a missing grant.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { formatMinor, parseMinor } from '@kaizen/shared';
import {
  asPrincipal,
  asUser,
  authFor,
  expectReject,
  principalFor,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
} from './helpers.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';
import {
  accountBalances,
  recordTransaction,
  recordVendorBill,
  reverseTransaction,
  payVendorBill,
  generateRecurring,
} from '../domains/books.js';
import {
  approvePayout,
  declinePayout,
  requestPayout,
  requestRecurringRuleApproval,
  withdrawPayout,
} from '../domains/payouts.js';

const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');

let TENANT: string;
beforeAll(async () => {
  TENANT = await tenantId();
});

let uniq = 0;
function unique(label: string): string {
  uniq += 1;
  return `${label} ${Date.now()}-${uniq}`;
}

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

async function newBill(subtotal = 5_000) {
  return asUser(FINANCE, () =>
    recordVendorBill({ vendorName: unique('Payout Vendor'), billDate: new Date(), subtotal }),
  );
}

async function requestsFor(where: { vendorBillId?: string; transactionId?: string; state?: string }) {
  return unscopedPrisma.payoutRequest.findMany({ where: { tenantId: TENANT, ...where } });
}

async function outRowsFor(vendorBillId: string) {
  return unscopedPrisma.transaction.findMany({ where: { tenantId: TENANT, vendorBillId, direction: 'out' } });
}

describe('a money-out request writes nothing until a second person approves it', () => {
  it('pending request writes no Transaction and leaves the bill unpaid', async () => {
    const account = await bankAccount();
    const bill = await newBill(5_000);
    const request = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 5_000, accountId: account.id, paidOn: new Date() }),
    );

    expect(request.state).toBe('requested');
    expect(request.founderWaived).toBe(false);
    expect(request.transactionId).toBeNull();
    expect(await outRowsFor(bill.id)).toHaveLength(0);
    const after = await unscopedPrisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.status).toBe('open');
    expect(after.paidAmount?.toFixed(2) ?? '0.00').toBe('0.00');
  });

  it('approval by the second holder writes exactly one Transaction and pays the bill once', async () => {
    const account = await bankAccount();
    const bill = await newBill(5_000);
    const request = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 5_000, accountId: account.id, paidOn: new Date() }),
    );

    const settled = await asUser(CHAIRMAN, () => approvePayout(request.id));

    expect(settled.request.state).toBe('approved');
    expect(settled.transaction?.direction).toBe('out');
    expect(settled.bill?.status).toBe('paid');
    const rows = await outRowsFor(bill.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(settled.transaction?.id);
    expect(String(rows[0].amount)).toBe('5000');
  });

  it('approval re-checks what is outstanding: a second request cannot pay the bill past its total', async () => {
    const account = await bankAccount();
    const bill = await newBill(5_000);
    const first = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 3_000, accountId: account.id, paidOn: new Date() }),
    );
    const second = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 3_000, accountId: account.id, paidOn: new Date() }),
    );
    await asUser(CHAIRMAN, () => approvePayout(first.id));

    const err = await expectReject(() => asUser(CHAIRMAN, () => approvePayout(second.id)));
    expect(err.status).toBe(422);
    expect(err.message).toContain('outstanding');
    expect((await requestsFor({ vendorBillId: bill.id, state: 'requested' })).map((r) => r.id)).toEqual([second.id]);
    expect(await outRowsFor(bill.id)).toHaveLength(1);
  });

  it('decline and withdraw write no Transaction, and a decided request cannot be decided again', async () => {
    const account = await bankAccount();
    const declinedBill = await newBill(2_000);
    const declined = await asUser(FINANCE, () =>
      payVendorBill(declinedBill.id, { amount: 2_000, accountId: account.id, paidOn: new Date() }),
    );
    const refused = await asUser(CHAIRMAN, () => declinePayout(declined.id, 'Vendor not yet verified'));
    expect(refused.state).toBe('declined');

    const withdrawnBill = await newBill(2_000);
    const withdrawn = await asUser(FINANCE, () =>
      payVendorBill(withdrawnBill.id, { amount: 2_000, accountId: account.id, paidOn: new Date() }),
    );
    const taken = await asUser(FINANCE, () => withdrawPayout(withdrawn.id));
    expect(taken.state).toBe('withdrawn');

    expect(await outRowsFor(declinedBill.id)).toHaveLength(0);
    expect(await outRowsFor(withdrawnBill.id)).toHaveLength(0);
    const again = await expectReject(() => asUser(CHAIRMAN, () => approvePayout(declined.id)));
    expect(again.status).toBe(409);
  });

  it('self-approval by a non-founder is refused, with no Transaction and no state change', async () => {
    const account = await bankAccount();
    const bill = await newBill(1_000);
    await withFixtureRole(
      {
        slug: 'payout_self',
        grants: [
          { resource: 'payments', verbs: ['view', 'create', 'approve'] },
          { resource: 'transactions', verbs: ['view', 'create', 'edit'] },
          { resource: 'vendor_bills', verbs: ['view', 'edit'] },
        ],
      },
      async () => {
        const request = await payVendorBill(bill.id, { amount: 1_000, accountId: account.id, paidOn: new Date() });
        const err = await expectReject(() => approvePayout(request.id));
        expect(err.status).toBe(403);
        expect(err.message).toContain('cannot also approve');
        const after = await unscopedPrisma.payoutRequest.findUniqueOrThrow({ where: { id: request.id } });
        expect(after.state).toBe('requested');
      },
    );
    expect(await outRowsFor(bill.id)).toHaveLength(0);
  });

  it('founder creates and the payment counts at once, audited with founderOverride payment_second_approver', async () => {
    const account = await bankAccount();
    const bill = await newBill(4_000);
    const request = await asUser(CHAIRMAN, () =>
      payVendorBill(bill.id, { amount: 4_000, accountId: account.id, paidOn: new Date() }),
    );

    expect(request.state).toBe('approved');
    expect(request.founderWaived).toBe(true);
    expect(request.transactionId).not.toBeNull();
    expect(await outRowsFor(bill.id)).toHaveLength(1);
    const bill2 = await unscopedPrisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(bill2.status).toBe('paid');

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'payout_request', subjectId: request.id, action: 'create' },
    });
    expect(audit?.meta).toEqual({ founderOverride: ['payment_second_approver'] });
  });

  it('an agent principal may neither request a payment nor approve one', async () => {
    const account = await bankAccount();
    const bill = await newBill(900);
    const request = await asUser(FINANCE, () =>
      payVendorBill(bill.id, { amount: 900, accountId: account.id, paidOn: new Date() }),
    );
    const chairman = await principalFor(CHAIRMAN);
    const agent = authFor(chairman, { principalType: 'agent', agentId: 'agent-payout-test', userId: null });

    const asked = await expectReject(() =>
      asPrincipal(agent, () =>
        requestPayout({
          kind: 'payment',
          source: 'manual',
          txnDate: new Date(),
          amountMinor: 100n,
          accountId: account.id,
        }),
      ),
    );
    expect(asked.status).toBe(403);
    expect(asked.message).toContain('AI principal');

    const decided = await expectReject(() => asPrincipal(agent, () => approvePayout(request.id)));
    expect(decided.status).toBe(403);
    expect(decided.message).toContain('AI principal');
    expect(await outRowsFor(bill.id)).toHaveLength(0);
  });

  it('money in is still recorded at once, with no request', async () => {
    const account = await bankAccount();
    const before = await unscopedPrisma.payoutRequest.count({ where: { tenantId: TENANT } });
    const txn = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'in',
        amount: 7_777,
        accountId: account.id,
        note: unique('Receipt at once'),
      }),
    );
    expect(txn.direction).toBe('in');
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, id: txn.id } })).toBe(1);
    expect(await unscopedPrisma.payoutRequest.count({ where: { tenantId: TENANT } })).toBe(before);
  });

  it('a manual cash-out is a request, and the cashbook and trial balance are unchanged until approval', async () => {
    const account = await bankAccount();
    const outSum = async () =>
      (
        await unscopedPrisma.transaction.aggregate({
          where: { tenantId: TENANT, accountId: account.id, direction: 'out', deletedAt: null },
          _sum: { amount: true },
        })
      )._sum.amount?.toFixed(2) ?? '0.00';
    const balancesBefore = await asUser(FINANCE, () => accountBalances());
    const sumBefore = await outSum();
    const note = unique('Manual cash-out');

    const request = await asUser(FINANCE, () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 1_234.5, accountId: account.id, note }),
    );

    expect(request.state).toBe('requested');
    expect(await outSum()).toBe(sumBefore);
    expect(await asUser(FINANCE, () => accountBalances())).toEqual(balancesBefore);
    assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));

    await asUser(CHAIRMAN, () => approvePayout(request.id));

    expect(await outSum()).toBe(formatMinor(parseMinor(sumBefore) + parseMinor('1234.50')));
    assertTrialBalance(await asUser(CHAIRMAN, () => journalTrialBalance(ALL_TIME)));
  });

  it('reversal of an inward row is a request; approval writes the reversal, which is outward', async () => {
    const account = await bankAccount();
    const original = await asUser(FINANCE, () =>
      recordTransaction({ txnDate: new Date(), direction: 'in', amount: 1_500, accountId: account.id, note: unique('Receipt to reverse') }),
    );

    const asked = await asUser(FINANCE, () => reverseTransaction(original.id, 'Receipt was a duplicate'));
    expect('amountMinor' in asked).toBe(true);
    if (!('amountMinor' in asked)) throw new Error('expected a request');
    expect(asked.kind).toBe('reversal');
    expect(asked.reversesTransactionId).toBe(original.id);
    const stillOpen = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: original.id } });
    expect(stillOpen.reversedById).toBeNull();

    const settled = await asUser(CHAIRMAN, () => approvePayout(asked.id));
    expect(settled.transaction?.direction).toBe('out');
    const reversed = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: original.id } });
    expect(reversed.reversedById).toBe(settled.transaction?.id);
  });

  it('reversal of an outward row brings money back and is not a request', async () => {
    const account = await bankAccount();
    const original = await asUser(FINANCE, () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 300,
        accountId: account.id,
        note: unique('Entry to reverse'),
      }),
    );
    expect('amountMinor' in original).toBe(true);
    if (!('amountMinor' in original)) throw new Error('expected a request');
    await asUser(CHAIRMAN, () => approvePayout(original.id));
    const row = await unscopedPrisma.payoutRequest.findUniqueOrThrow({ where: { id: original.id } });
    const cashRow = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: row.transactionId! } });

    const reversal = await asUser(FINANCE, () => reverseTransaction(cashRow.id, 'Entered twice'));
    expect('amountMinor' in reversal).toBe(false);
    expect(reversal.direction).toBe('in');
  });
});

describe('recurring cash-outs are approved once, as a rule', () => {
  it('an unapproved out-rule generates nothing, then posts once its rule is approved, without another approval', async () => {
    const account = await bankAccount();
    const label = unique('Rent rule');
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label,
        accountId: account.id,
        direction: 'out',
        amount: 800,
        cadence: 'monthly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });

    await asUser(FINANCE, () => generateRecurring('2026-11'));
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, note: label } })).toBe(0);

    const asked = await asUser(FINANCE, () => requestRecurringRuleApproval(rule.id));
    expect(asked.state).toBe('requested');
    await asUser(FINANCE, () => generateRecurring('2026-11'));
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, note: label } })).toBe(0);

    await asUser(CHAIRMAN, () => approvePayout(asked.id));
    const requestsBefore = await unscopedPrisma.payoutRequest.count({ where: { tenantId: TENANT, recurringRuleId: rule.id } });
    await asUser(FINANCE, () => generateRecurring('2026-11'));

    const posted = await unscopedPrisma.transaction.findMany({ where: { tenantId: TENANT, note: label } });
    expect(posted).toHaveLength(1);
    expect(posted[0].direction).toBe('out');
    expect(String(posted[0].amount)).toBe('800');
    expect(await unscopedPrisma.payoutRequest.count({ where: { tenantId: TENANT, recurringRuleId: rule.id } })).toBe(
      requestsBefore,
    );
  });

  it('changing the rule amount needs a fresh approval before the next occurrence posts', async () => {
    const account = await bankAccount();
    const label = unique('Lease rule');
    const rule = await unscopedPrisma.recurringRule.create({
      data: {
        tenantId: TENANT,
        label,
        accountId: account.id,
        direction: 'out',
        amount: 500,
        cadence: 'monthly',
        dayOfMonth: 1,
        startDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    const first = await asUser(FINANCE, () => requestRecurringRuleApproval(rule.id));
    await asUser(CHAIRMAN, () => approvePayout(first.id));
    await asUser(FINANCE, () => generateRecurring('2026-11'));
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, note: label } })).toBe(1);

    await unscopedPrisma.recurringRule.update({ where: { id: rule.id }, data: { amount: 650 } });
    await asUser(FINANCE, () => generateRecurring('2026-12'));
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: TENANT, note: label } })).toBe(1);

    const second = await asUser(FINANCE, () => requestRecurringRuleApproval(rule.id));
    await asUser(CHAIRMAN, () => approvePayout(second.id));
    await asUser(FINANCE, () => generateRecurring('2026-12'));
    const posted = await unscopedPrisma.transaction.findMany({
      where: { tenantId: TENANT, note: label },
      orderBy: { txnDate: 'asc' },
    });
    expect(posted.map((t) => String(t.amount))).toEqual(['500', '650']);
  });
});
