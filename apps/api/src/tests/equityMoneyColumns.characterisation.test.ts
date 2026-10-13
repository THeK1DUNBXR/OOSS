/**
 * Characterisation of the equity and corporate money columns (ORDERED-PLAN 1.6,
 * MONEY-S7). Pins the figures a caller reads back, and the refund amount through
 * request, approval and payment, as `res.json` would send them. These assertions
 * pass on the Decimal columns and, unchanged, on the BigInt `*Minor` columns, so
 * no figure moves by a paisa and no client sees a field change type.
 *
 * The per-share and perquisite figures, the funding round, the cap table and
 * the ESOP perquisite are pinned by equityRegister, equityRounds, esop and
 * equityFilings; this file adds the refund (the one S7 column with a payment
 * behind it) and the two-place round trip of a share class and a valuation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../platform/balances.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { bigintReplacer } from '../platform/wire.js';
import { createShareClass, recordValuation } from '../domains/equity.js';
import {
  requestRefund,
  approveRefund,
  payRefund,
  listRefunds,
} from '../domains/compliance/corporate/refunds.js';
import { generateTotpSecret } from '../domains/compliance/corporate/totp.js';

/** What `res.json` would send: Prisma Decimals become their two-place string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';
const ALL_TIME = new Date('2100-01-01T00:00:00Z');

let TID: string;
let accountId: string;

beforeAll(async () => {
  TID = await tenantId();
  const account = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: TID, name: `S7 bank ${stamp()}`, accountType: 'bank' },
  });
  accountId = account.id;

  // Approving and paying are gated by MFA for the finance and chairman roles, as in
  // CMP-COR-004 (refundPayment.test.ts).
  for (const email of [CHAIRMAN, FINANCE]) {
    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email, tenantId: TID } });
    await unscopedPrisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: generateTotpSecret(), mfaEnabledAt: new Date() },
    });
  }
});

afterAll(async () => {
  for (const email of [CHAIRMAN, FINANCE]) {
    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email, tenantId: TID } });
    await unscopedPrisma.user.update({ where: { id: user.id }, data: { mfaSecret: null, mfaEnabledAt: null } });
  }
});

describe('S7 money columns — refund amount, request to payment (CMP-COR-004)', () => {
  it('keeps the two-place amount on the row, through approval, and books the same figure as the outward payment', async () => {
    const requested = await asUser(CHAIRMAN, () =>
      requestRefund({ receiptId: `REC-S7-${stamp()}`, amount: 1234.56, reason: 'S7 characterisation' }),
    );
    expect(wire(requested).amount).toBe('1234.56');
    expect(requested.status).toBe('requested');

    const listed = await asUser(CHAIRMAN, () => listRefunds());
    expect(wire(listed.find((r) => r.id === requested.id))!.amount).toBe('1234.56');

    await asUser(FINANCE, () => approveRefund(requested.id));

    const paid = await asUser(CHAIRMAN, () => payRefund(requested.id, { accountId }));
    expect(paid.status).toBe('paid');
    expect(wire(paid).amount).toBe('1234.56');

    const txn = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: paid.paidPaymentId! } });
    expect(txn.amount.toFixed(2)).toBe('1234.56');
    expect(txn.direction).toBe('out');
    expect(txn.source).toBe('refund');

    assertTrialBalance(await asSystem(TID, () => journalTrialBalance(ALL_TIME)));
  });

  it('refuses a non-positive amount with the same message as before', async () => {
    await expect(
      asUser(CHAIRMAN, () => requestRefund({ receiptId: `REC-S7-${stamp()}`, amount: 0, reason: 'S7 zero' })),
    ).rejects.toThrow(/A refund amount is always positive/);
  });
});

describe('S7 money columns — share class face value and valuation equity value round-trip', () => {
  it('a face value of 10.25 and an equity value of 1234567.89 come back as the numbers they were written as', async () => {
    const shareClass = await asUser(CHAIRMAN, () =>
      createShareClass({
        name: `S7 char ${stamp()}`,
        kind: 'equity',
        instrument: 'equity',
        faceValue: 10.25,
      }),
    );
    expect(shareClass.faceValue).toBe(10.25);

    const valuation = await asUser(FINANCE, () =>
      recordValuation({
        asOf: new Date().toISOString(),
        // Not merchant_banker: the ESOP perquisite lookup reads that basis within 180 days,
        // and this file shares the default tenant with esop.test.ts.
        basis: 'registered_valuer',
        perShareByClass: { [shareClass.id]: 50.5 },
        equityValue: 1234567.89,
      }),
    );
    expect(valuation.equityValue).toBe(1234567.89);
  });
});
