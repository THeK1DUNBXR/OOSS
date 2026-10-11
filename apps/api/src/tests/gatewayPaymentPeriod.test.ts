/**
 * Interim policy, pending the accountant's confirmation: money that has
 * actually arrived is never refused. A gateway payment (a principal with no
 * human behind it, so `partyId` is null, as on `Payment.recordedById`) dated in
 * a closed accounting period is recorded in the current open period, keeps its
 * original date as `valueDate`, and raises EX-FIN-007 for the accountant. A
 * payment a member of staff enters is still refused in a closed period.
 *
 * Real Postgres. Periods are closed here and reopened after, as in the other
 * period suites.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { recordPayment } from '../domains/finance.js';
import { runWithContext, systemContext } from '../platform/context.js';
import { requestClosePeriod, closePeriod, reopenPeriod } from '../domains/compliance/books.js';

const CLOSED = '2017-10';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
});

/** A gateway webhook: the system principal, no human behind it. */
function asGateway<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(runWithContext(systemContext(TENANT), fn));
}

/** `valueDate` is added by this round's migration; read through a cast so the test typechecks before it exists. */
function valueDateOf(payment: object): Date | null | undefined {
  return (payment as { valueDate?: Date | null }).valueDate;
}

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

describe('Money received — a gateway payment is never refused by a closed period', () => {
  it('a gateway payment dated in the closed period is recorded in the open period, with its date kept as valueDate', async () => {
    const received = new Date('2017-10-15T06:00:00Z');
    const payment = await asGateway(() =>
      recordPayment({ amount: 1500, gatewayReference: unique('W2 gateway closed'), receivedAt: received }),
    );

    expect(monthKey(payment.receivedAt)).toBe(monthKey(new Date()));
    expect(valueDateOf(payment)?.toISOString()).toBe(received.toISOString());

    const raised = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: TENANT, code: 'EX-FIN-007', subjectType: 'payment', subjectId: payment.id },
    });
    expect(raised).toBe(1);
  });

  it('a gateway payment received while this month is closed is recorded in a later open month', async () => {
    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const payment = await asGateway(() =>
        recordPayment({ amount: 800, gatewayReference: unique('W2 gateway today') }),
      );
      expect(monthKey(payment.receivedAt)).not.toBe(today);
      expect(payment.receivedAt.getTime()).toBeGreaterThan(new Date().getTime() - 60_000);
      expect(valueDateOf(payment)).not.toBeNull();
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
  });

  it('a gateway payment dated 00:30 IST on 1 November is in an open month, so it is not moved and no exception is raised', async () => {
    const payment = await asGateway(() =>
      recordPayment({
        amount: 300,
        gatewayReference: unique('W2 gateway boundary'),
        receivedAt: new Date('2017-11-01T00:30:00+05:30'),
      }),
    );
    expect(payment.receivedAt.toISOString()).toBe('2017-10-31T19:00:00.000Z');
    expect(valueDateOf(payment)).toBeNull();
  });
});

describe('Money received — a payment a member of staff enters is still refused', () => {
  it('a staff payment dated in the closed period is refused, and no payment row is written', async () => {
    const reference = unique('W2 staff closed');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordPayment({ amount: 500, gatewayReference: reference, receivedAt: new Date('2017-10-15T06:00:00Z') }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } })).toBe(0);
  });
});
