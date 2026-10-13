/**
 * Two requests carrying one gateway reference, at the same time.
 *
 * Both pass the sequential check on the reference (none on file yet), and both reach
 * the insert. One commits; the other's insert raises the unique violation. That loser
 * is a replay, not a server fault: recordPayment returns the winner's payment, and a
 * collection refuses with the same 409 the sequential check gives.
 */
import { describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import { collectInvoicePayment, createInvoice } from '../../domains/invoicing.js';
import { recordPayment } from '../../domains/finance.js';
import { ApiError } from '../../platform/errors.js';

const EMAIL = 'latha@kaizen.co.in';

const stamp = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

async function anIssuedInvoice(organizationId: string) {
  return createInvoice({
    division: 'education',
    organizationId,
    placeOfSupply: '33',
    lines: [{ description: 'Programme', unitPrice: 10_000, gstRate: 18 }],
  });
}

describe('concurrent recordPayment with one gateway reference', () => {
  it('six parallel calls all fulfil with the same payment id, and one row is written', async () => {
    const TENANT = await tenantId();
    const reference = stamp('RACE-RP');
    const settled = await asUser(EMAIL, () =>
      Promise.allSettled(
        Array.from({ length: 6 }, () =>
          asUser(EMAIL, () => recordPayment({ amount: 400, gatewayReference: reference })),
        ),
      ),
    );

    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const ids = new Set(settled.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    const rows = await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } });
    expect(rows).toBe(1);
  });
});

describe('concurrent collectInvoicePayment with one gateway reference', () => {
  it('two collections on two invoices: one fulfils, the other is a 409 ApiError, not a 500', async () => {
    const TENANT = await tenantId();
    const reference = stamp('RACE-CIP');
    const account = await unscopedPrisma.account.findFirstOrThrow({
      where: { tenantId: TENANT, gstin: { not: null } },
    });
    const outcome = await asUser(EMAIL, async () => {
      const first = await anIssuedInvoice(account.organizationId!);
      const second = await anIssuedInvoice(account.organizationId!);
      return Promise.allSettled([
        asUser(EMAIL, () => collectInvoicePayment(first.id, { amount: 1_000, mode: 'cash', reference })),
        asUser(EMAIL, () => collectInvoicePayment(second.id, { amount: 1_000, mode: 'cash', reference })),
      ]);
    });

    const fulfilled = outcome.filter((r) => r.status === 'fulfilled');
    const rejected = outcome.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0].reason;
    expect(loser).toBeInstanceOf(ApiError);
    expect((loser as ApiError).status).toBe(409);
    const rows = await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } });
    expect(rows).toBe(1);
  });
});
