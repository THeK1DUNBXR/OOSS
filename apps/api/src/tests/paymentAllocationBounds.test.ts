/**
 * The database refuses a receipt that allocates more than its payment, or allocates
 * nothing (ORDERED-PLAN "Payment allocation"; migration 20261013210000_receipt_allocation_bounds).
 *
 * The rule spans rows: a payment carries many receipts and their sum is what may not
 * pass the payment's amount. A CHECK sees one row, so the sum is a deferred constraint
 * trigger. These writes go in as the table owner, through raw SQL with the tenant
 * setting applied the way platform/db.ts applies it, so the refusal is the database's
 * own and not allocatePayment's guard (finance.ts:275).
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMinor } from '@kaizen/shared';
import { booksTenant, unscopedPrisma, type BooksTenant } from './helpers.js';

// The table owner has BYPASSRLS, so row-level security only shows a cross-tenant row to
// kaizen_app. The cross-tenant case below therefore runs as that role.
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );
const app = new PrismaClient({ datasourceUrl: APP_URL });

let FIX: BooksTenant;

beforeAll(async () => {
  FIX = await booksTenant('payment-allocation-bounds');
});

afterAll(async () => {
  await app.$disconnect();
});

/** Runs `fn` as the table owner with this tenant's setting, as db.ts applies it. */
function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return unscopedPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${FIX.tenantId}, true)`;
    return fn(tx);
  });
}

/** Runs `fn` as the application role with this tenant's setting, as db.ts applies it. */
function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${FIX.tenantId}, true)`;
    return fn(tx);
  });
}

async function aPayment(amount: string, tenantId = FIX.tenantId) {
  return unscopedPrisma.payment.create({
    data: {
      tenantId,
      recordCode: `PAYB-${randomUUID().slice(0, 8)}`,
      amountMinor: parseMinor(amount),
      gatewayReference: `BOUNDS-${randomUUID()}`,
      receivedAt: new Date('2030-06-15T00:00:00.000Z'),
    },
  });
}

function insertReceipt(tx: Prisma.TransactionClient, paymentId: string, amount: string) {
  return tx.$executeRaw`INSERT INTO "receipts" ("id","tenantId","recordCode","paymentId","allocatedAmountMinor") VALUES (${randomUUID()}, ${FIX.tenantId}, ${'RCPB-' + randomUUID().slice(0, 8)}, ${paymentId}, ${parseMinor(amount)}::bigint)`;
}

describe('the database refuses a receipt that over-allocates its payment or allocates nothing', () => {
  it('accepts receipts that add up to exactly the payment amount', async () => {
    const p = await aPayment('100.00');
    await asOwner(async (tx) => {
      await insertReceipt(tx, p.id, '60.00');
      await insertReceipt(tx, p.id, '40.00');
    });
    const sum = await unscopedPrisma.receipt.aggregate({
      where: { paymentId: p.id },
      _sum: { allocatedAmountMinor: true },
    });
    expect(sum._sum.allocatedAmountMinor).toBe(10_000n);
  });

  it('refuses a receipt that takes its payment past the amount', async () => {
    const p = await aPayment('100.00');
    await expect(asOwner((tx) => insertReceipt(tx, p.id, '150.00'))).rejects.toThrow(/more than the payment amount/);
  });

  it('refuses the second of two receipts in one transaction whose sum passes the amount', async () => {
    const p = await aPayment('100.00');
    await expect(
      asOwner(async (tx) => {
        await insertReceipt(tx, p.id, '60.00');
        await insertReceipt(tx, p.id, '60.00');
      }),
    ).rejects.toThrow(/more than the payment amount/);
    expect(await unscopedPrisma.receipt.count({ where: { paymentId: p.id } })).toBe(0);
  });

  it('a second transaction waits on the payment lock, so two that each fit alone cannot both commit past the amount', async () => {
    const p = await aPayment('100.00');
    let markInserted!: () => void;
    const inserted = new Promise<void>((r) => (markInserted = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first transaction checks at once, so it holds the payment lock until it ends. The second
    // checks at commit and cannot read the first's receipt until the first has committed. Without
    // the lock the second commits while the first is still open, and both pass.
    const first = asOwner(async (tx) => {
      await tx.$executeRaw`SET CONSTRAINTS "receipt_allocation_within_payment" IMMEDIATE`;
      await insertReceipt(tx, p.id, '60.00');
      markInserted();
      await gate;
    });
    await inserted;
    const second = asOwner((tx) => insertReceipt(tx, p.id, '60.00'));
    const secondOutcome = second.then(
      () => 'committed',
      () => 'refused',
    );
    const whileFirstOpen = await Promise.race([
      secondOutcome,
      new Promise<string>((r) => setTimeout(() => r('still waiting'), 500)),
    ]);
    release();
    await first;
    expect(whileFirstOpen).toBe('still waiting');
    await expect(second).rejects.toThrow(/more than the payment amount/);
    const sum = await unscopedPrisma.receipt.aggregate({
      where: { paymentId: p.id },
      _sum: { allocatedAmountMinor: true },
    });
    expect(sum._sum.allocatedAmountMinor).toBe(6_000n);
  });

  it('refuses an update that raises a receipt past the payment amount', async () => {
    const p = await aPayment('100.00');
    await asOwner((tx) => insertReceipt(tx, p.id, '60.00'));
    await expect(
      asOwner((tx) => tx.$executeRaw`UPDATE "receipts" SET "allocatedAmountMinor" = 15000 WHERE "paymentId" = ${p.id}`),
    ).rejects.toThrow(/more than the payment amount/);
  });

  it('refuses a payment amount lowered below what its receipts already allocate, and names both in paise', async () => {
    const p = await aPayment('100.00');
    await asOwner((tx) => insertReceipt(tx, p.id, '60.00'));
    // The trigger is re-created on "amountMinor" (migration 20261013254000), so a paise write is what it watches.
    await expect(
      asOwner((tx) => tx.$executeRaw`UPDATE "payments" SET "amountMinor" = 5000 WHERE "id" = ${p.id}`),
    ).rejects.toThrow(/more than the payment amount: 6000 paise against 5000 paise/);
  });

  it('refuses a receipt of zero or less', async () => {
    const p = await aPayment('100.00');
    await expect(asOwner((tx) => insertReceipt(tx, p.id, '0.00'))).rejects.toThrow(/check constraint/);
    await expect(asOwner((tx) => insertReceipt(tx, p.id, '-5.00'))).rejects.toThrow(/check constraint/);
  });

  it('refuses a receipt that names a payment of another tenant', async () => {
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'Allocation bounds other tenant', slug: `alloc-bounds-${randomUUID().slice(0, 8)}` },
    });
    const foreign = await aPayment('100.00', other.id);
    await expect(asAppRole((tx) => insertReceipt(tx, foreign.id, '10.00'))).rejects.toThrow(/cannot see/);
    await unscopedPrisma.tenant.deleteMany({ where: { id: other.id } });
  });
});
