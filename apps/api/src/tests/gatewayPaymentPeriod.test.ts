/**
 * Interim policy, pending the accountant's confirmation: money that has
 * actually arrived is never refused. A gateway payment (a principal with no
 * human behind it, so `partyId` is null, as on `Payment.recordedById`) dated in
 * a closed accounting period is recorded in the current open period, keeps its
 * original date as `valueDate`, and raises EX-FIN-007 for the accountant. A
 * payment a member of staff enters is still refused in a closed period.
 *
 * Real Postgres. The file runs in a books tenant of its own (booksTenant), so
 * the months it closes are not read by any other file. Its closes are windows:
 * closeThrough closes the months a probe needs in ascending order, and
 * reopenLatestFirst reopens them latest first when the window ends.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  reopenLatestFirst,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { recordPayment } from '../domains/finance.js';
import { runWithContext, systemContext } from '../platform/context.js';

const CLOSED = '2017-10';

let FIXTURE: BooksTenant;
let TENANT: string;

beforeAll(async () => {
  FIXTURE = await booksTenant('gateway-payment-period');
  TENANT = FIXTURE.tenantId;
  // A run that stopped inside a close window leaves months closed. Reopen them before this run writes.
  await reopenLatestFirst(FIXTURE, 'Test fixture reset at the start of the run');
  await closeThrough(FIXTURE, CLOSED);
});

afterAll(async () => {
  await reopenLatestFirst(FIXTURE, 'Gateway payment period tests finished; reopening the months they closed');
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
    await closeThrough(FIXTURE, today);
    try {
      const payment = await asGateway(() =>
        recordPayment({ amount: 800, gatewayReference: unique('W2 gateway today') }),
      );
      expect(monthKey(payment.receivedAt)).not.toBe(today);
      expect(payment.receivedAt.getTime()).toBeGreaterThan(new Date().getTime() - 60_000);
      expect(valueDateOf(payment)).not.toBeNull();
    } finally {
      await reopenLatestFirst(FIXTURE, 'W2 probe finished; reopening the months it closed');
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
  beforeAll(async () => {
    // The probe needs the closed month closed; the test above reopens every month its window closed.
    await closeThrough(FIXTURE, CLOSED);
  });

  it('a staff payment dated in the closed period is refused, and no payment row is written', async () => {
    const reference = unique('W2 staff closed');
    const err = await expectReject(() =>
      asUser(FIXTURE.finance, () =>
        recordPayment({ amount: 500, gatewayReference: reference, receivedAt: new Date('2017-10-15T06:00:00Z') }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } })).toBe(0);
  });
});
