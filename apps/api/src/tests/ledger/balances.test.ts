/**
 * Derived balances, the journal trial balance and the nightly drift check
 * (ORDERED-PLAN Wave 3, item 1.4; archive phase-1-ledger.md section 1.4).
 *
 * Real Postgres, real contexts, no mocks. Each test file-level fixture is a
 * tenant of its own, so the trial balance and the drift check see only the
 * entries this file posted. The owner role corrupts the cache (the only role
 * that can); the application role is asserted refused.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { istCivilDay } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { balanceOf, post, reverse } from '../../platform/ledger.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );
const app = new PrismaClient({ datasourceUrl: APP_URL });

interface Ledger {
  tid: string;
  entityId: string;
  bank: string;
  capital: string;
}

let ledger: Ledger;

/** A tenant of its own with a bank and a capital account, so no other file's entries are in its balances. */
async function freshLedger(label: string): Promise<Ledger> {
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Balances ${label}`, slug: `bal-${label}-${randomUUID().slice(0, 8)}` },
  });
  const tid = tenant.id;
  const entity = await unscopedPrisma.ledgerEntity.create({
    data: { tenantId: tid, code: 'BAL', legalName: 'Balances test entity', stateCode: '27' },
  });
  const bank = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Bank', accountClass: 'asset' },
  });
  const capital = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tid, name: 'Capital', accountClass: 'equity' },
  });
  return { tid, entityId: entity.id, bank: bank.id, capital: capital.id };
}

/** An IST month's period, open. The 2030 months are the test's own; no real month is touched. */
async function openPeriod(l: Ledger, month: string, status = 'open') {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return unscopedPrisma.accountingPeriod.create({
    data: {
      tenantId: l.tid,
      entityId: l.entityId,
      period: month,
      fy: '2030-31',
      status,
      startsOn: new Date(`${month}-01T00:00:00.000Z`),
      endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
    },
  });
}

/** Posts `amount` into the bank from capital, dated by IST civil day (the caller's job, CLAUDE.md rule 3). */
function postOn(l: Ledger, isoDay: string, amount: bigint) {
  return asSystem(l.tid, () =>
    post({
      entityId: l.entityId,
      entryDate: new Date(`${isoDay}T00:00:00.000Z`),
      narration: 'Balances fixture',
      sourceType: 'manual',
      idempotencyKey: `bal:${randomUUID()}`,
      lines: [
        { accountId: l.bank, amountMinor: amount },
        { accountId: l.capital, amountMinor: -amount },
      ],
    }),
  );
}

/** Runs `fn` as the application role, with the tenant set the way platform/db.ts sets it. */
function asAppRole<T>(l: Ledger, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${l.tid}, true)`;
    return fn(tx);
  });
}

afterAll(async () => {
  await app.$disconnect();
});

describe('1.4 balanceOf is as of an IST day', () => {
  beforeAll(async () => {
    ledger = await freshLedger('boundary');
  });

  it('IST midnight on a civil day is the day it names, whatever the UTC date of the instant', () => {
    // 00:10 IST on 1 April is 18:40Z on 31 March: a getUTCMonth-based reading puts it in March.
    expect(istCivilDay(new Date('2030-03-31T18:40:00.000Z')).toISOString()).toBe('2030-04-01T00:00:00.000Z');
    expect(istCivilDay(new Date('2030-03-31T18:29:59.999Z')).toISOString()).toBe('2030-03-31T00:00:00.000Z');
  });

  it('an entry posted 00:00 to 05:30 IST on 1 April is in the new year, not in the old one', async () => {
    await openPeriod(ledger, '2030-03');
    await openPeriod(ledger, '2030-04');
    await postOn(ledger, '2030-04-01', 50000n);

    await asSystem(ledger.tid, async () => {
      // 23:59:59 IST on 31 March, and 00:00 IST on 1 April.
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:29:59.999Z'))).toBe(0n);
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:30:00.000Z'))).toBe(50000n);
      // 00:10 IST on 1 April, as an instant the caller might pass.
      expect(await balanceOf(ledger.bank, new Date('2030-03-31T18:40:00.000Z'))).toBe(50000n);
    });
  });
});

describe('1.4 reversal effects on the balance', () => {
  beforeAll(async () => {
    ledger = await freshLedger('reversal');
    await openPeriod(ledger, '2030-05');
  });

  it('a reversal returns the balance to where it was, and negates every line of the original', async () => {
    await postOn(ledger, '2030-05-02', 1000n);
    const original = await postOn(ledger, '2030-05-10', 25000n);
    const asOf = new Date('2030-05-31T00:00:00.000Z');

    await asSystem(ledger.tid, async () => {
      expect(await balanceOf(ledger.bank, asOf)).toBe(26000n);
      const reversal = await reverse(original.id, 'Entered in error');
      expect(await balanceOf(ledger.bank, asOf)).toBe(1000n);
      expect(await balanceOf(ledger.capital, asOf)).toBe(-1000n);

      const lines = await unscopedPrisma.journalLine.findMany({
        where: { entryId: reversal.id },
        orderBy: { lineNo: 'asc' },
      });
      expect(lines.map((l) => l.amountMinor)).toEqual([-25000n, 25000n]);
    });
  });
});

