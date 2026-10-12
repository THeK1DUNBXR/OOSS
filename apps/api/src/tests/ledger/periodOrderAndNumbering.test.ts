/**
 * Two rules the ledger and the books hold together (ORDERED-PLAN Phase 0 Wave 7,
 * the L1 property suite's two defects).
 *
 * 1. Journal entry numbers are gapless per legal entity per financial year. A
 *    tenant with two ledger entities numbers each from 1, not from one shared
 *    tenant series that leaves gaps in each entity's list.
 * 2. Accounting periods close in order and reopen in reverse order. A closed
 *    month's snapshot is cumulative, so closing a later month while an earlier
 *    one is open, or reopening an earlier month under a closed later one, lets
 *    a backdated posting change figures that were already frozen.
 *
 * Each test runs in a tenant of its own, as balances.test.ts does, so the
 * months here are this file's own and no other file's open or closed rows leak
 * in. The system context is used for the close and reopen calls: the rules under
 * test are the ledger's, not the permission matrix's, and the permission path is
 * covered by the books suites.
 *
 * Real Postgres, real contexts, no mocks.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { post } from '../../platform/ledger.js';
import { lockLegacyPeriod } from '../../platform/periodLock.js';
import { closePeriod, reopenPeriod, requestClosePeriod } from '../../domains/compliance/books.js';
import { expectReject } from '../helpers.js';

interface Fixture {
  tid: string;
  bank: string;
  capital: string;
}

/** A tenant of its own, with the two accounts every fixture entry uses. */
async function freshTenant(label: string): Promise<Fixture> {
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Period order ${label}`, slug: `pord-${label}-${randomUUID().slice(0, 8)}` },
  });
  const bank = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tenant.id, name: 'Bank', accountClass: 'asset' },
  });
  const capital = await unscopedPrisma.ledgerAccount.create({
    data: { tenantId: tenant.id, name: 'Capital', accountClass: 'equity' },
  });
  return { tid: tenant.id, bank: bank.id, capital: capital.id };
}

async function addEntity(tid: string, code: string): Promise<string> {
  const entity = await unscopedPrisma.ledgerEntity.create({
    data: { tenantId: tid, code, legalName: `Entity ${code}`, stateCode: '27' },
  });
  return entity.id;
}

/** An IST month's period row, in `status`, as the books' own rows carry it. */
async function openMonth(tid: string, month: string, status = 'open') {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startYear = m >= 4 ? y : y - 1;
  return unscopedPrisma.accountingPeriod.create({
    data: {
      tenantId: tid,
      period: month,
      fy: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
      status,
      startsOn: new Date(`${month}-01T00:00:00.000Z`),
      endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
    },
  });
}

async function statusOf(tid: string, month: string): Promise<string> {
  const row = await unscopedPrisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: tid, period: month } });
  return row.status;
}

/** Posts a balanced entry for `entityId` on an IST civil day, and returns the entry. */
function postOn(f: Fixture, entityId: string, isoDay: string, amount = 100n) {
  return asSystem(f.tid, () =>
    post({
      entityId,
      entryDate: new Date(`${isoDay}T00:00:00.000Z`),
      narration: 'Numbering fixture',
      sourceType: 'manual',
      idempotencyKey: `num:${randomUUID()}`,
      lines: [
        { accountId: f.bank, amountMinor: amount },
        { accountId: f.capital, amountMinor: -amount },
      ],
    }),
  );
}

const requestClose = (tid: string, month: string) => asSystem(tid, () => requestClosePeriod(month));
const closeMonth = (tid: string, month: string) => asSystem(tid, () => closePeriod(month));
const reopenMonth = (tid: string, month: string) =>
  asSystem(tid, () => reopenPeriod(month, 'Backdated correction found after close'));

/** Requests and approves the close of one month, in the order the rule allows. */
async function closeInOrder(tid: string, month: string) {
  await requestClose(tid, month);
  return closeMonth(tid, month);
}

describe('journal entry numbers are gapless per legal entity per financial year', () => {
  it('two entities in one tenant each number their entries 1 to n', async () => {
    const f = await freshTenant('two-entities');
    const a = await addEntity(f.tid, 'PA');
    const b = await addEntity(f.tid, 'PB');
    await openMonth(f.tid, '2040-06');

    const numbersA: string[] = [];
    const numbersB: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      numbersA.push((await postOn(f, a, `2040-06-${10 + i}`)).entryNumber);
      numbersB.push((await postOn(f, b, `2040-06-${10 + i}`)).entryNumber);
    }

    expect(numbersA).toEqual(['JRN-2040-00001', 'JRN-2040-00002', 'JRN-2040-00003']);
    expect(numbersB).toEqual(['JRN-2040-00001', 'JRN-2040-00002', 'JRN-2040-00003']);
  });

  it('an entity that already holds numbers continues after its highest one, with no collision', async () => {
    const f = await freshTenant('existing-numbers');
    const a = await addEntity(f.tid, 'PA');
    const other = await addEntity(f.tid, 'PB');
    await openMonth(f.tid, '2040-06');

    const first = await postOn(f, a, '2040-06-10');
    await postOn(f, other, '2040-06-11');
    const second = await postOn(f, a, '2040-06-12');
    expect(first.entryNumber).toBe('JRN-2040-00001');
    expect(second.entryNumber).toBe('JRN-2040-00002');

    // The state an entity is in when its numbers were issued before the per-entity
    // sequence existed: entries present, no sequence row for the entity in this year.
    await unscopedPrisma.recordSequence.deleteMany({
      where: { tenantId: f.tid, entityType: `JRN:${a}`, year: 2040 },
    });

    const third = await postOn(f, a, '2040-06-13');
    expect(third.entryNumber).toBe('JRN-2040-00003');
  });

  it('two first-of-year posts for one entity, racing, get different numbers', async () => {
    const f = await freshTenant('first-of-year-race');
    const a = await addEntity(f.tid, 'PA');
    await openMonth(f.tid, '2041-04');

    const [x, y] = await Promise.all([postOn(f, a, '2041-04-03'), postOn(f, a, '2041-04-04')]);
    expect([x.entryNumber, y.entryNumber].sort()).toEqual(['JRN-2041-00001', 'JRN-2041-00002']);
  });
});

describe('accounting periods close in order and reopen in reverse order', () => {
  it('refuses to close a month while an earlier month is open', async () => {
    const f = await freshTenant('close-while-earlier-open');
    await openMonth(f.tid, '2040-02');
    await openMonth(f.tid, '2040-03', 'closing');

    const err = await expectReject(() => closeMonth(f.tid, '2040-03'));
    expect(err.status).toBe(422);
    expect(err.message).toContain('2040-02');
    expect(await statusOf(f.tid, '2040-03')).toBe('closing');
  });

  it('refuses a close request while an earlier month is open', async () => {
    const f = await freshTenant('request-while-earlier-open');
    await openMonth(f.tid, '2040-02');
    await openMonth(f.tid, '2040-03');

    const err = await expectReject(() => requestClose(f.tid, '2040-03'));
    expect(err.status).toBe(422);
    expect(err.message).toContain('2040-02');
    expect(await statusOf(f.tid, '2040-03')).toBe('open');
  });

  it('refuses to reopen a month while a later month is closed', async () => {
    const f = await freshTenant('reopen-under-closed-later');
    await openMonth(f.tid, '2040-02');
    await openMonth(f.tid, '2040-03');
    await closeInOrder(f.tid, '2040-02');
    await closeInOrder(f.tid, '2040-03');

    const err = await expectReject(() => reopenMonth(f.tid, '2040-02'));
    expect(err.status).toBe(422);
    expect(err.message).toContain('2040-03');
    expect(await statusOf(f.tid, '2040-02')).toBe('closed');
    expect(await statusOf(f.tid, '2040-03')).toBe('closed');
  });

  it('still closes in order and reopens in reverse order', async () => {
    const f = await freshTenant('in-order-and-reverse');
    await openMonth(f.tid, '2040-02');
    await openMonth(f.tid, '2040-03');
    await closeInOrder(f.tid, '2040-02');
    await closeInOrder(f.tid, '2040-03');

    await reopenMonth(f.tid, '2040-03');
    await reopenMonth(f.tid, '2040-02');
    expect(await statusOf(f.tid, '2040-02')).toBe('reopened');
    expect(await statusOf(f.tid, '2040-03')).toBe('reopened');
  });
});

describe('a month with no period row under a closed month counts as closed', () => {
  // The legacy cashbook write creates a month's row when it has none (lockLegacyPeriod).
  // Under a closed later month that creation would put an open row beneath a closed
  // one, which the order rule forbids: a later reopen of the month would then sit
  // under a closed month it should never have been written into.
  it('a legacy write into it is refused, and no open row is created under the closed month', async () => {
    const f = await freshTenant('no-row-under-closed');
    await openMonth(f.tid, '2040-03');
    await closeInOrder(f.tid, '2040-03');

    const err = await expectReject(() =>
      asSystem(f.tid, () => prisma.$transaction((tx) => lockLegacyPeriod(tx, f.tid, new Date('2040-02-15T06:00:00Z')))),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.accountingPeriod.count({ where: { tenantId: f.tid, period: '2040-02' } })).toBe(0);
  });
});
