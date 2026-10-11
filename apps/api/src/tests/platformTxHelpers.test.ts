/**
 * The helpers that used to open their own writes can run inside the caller's
 * transaction.
 *
 * raiseException, issueLetter, auditExport, auditBulkOperation and
 * auditRegulatedRead each wrote through the outer scoped client. Inside an
 * interactive transaction that client throws (db.ts refuseOuterClientInTransaction),
 * so a domain write that was meant to commit with its audit row and event could
 * not call them at all. Each test below runs the helper inside a transaction that
 * then throws, and checks that the helper used that transaction: the row is
 * visible through `tx` while the transaction is open, and nothing is left behind
 * once it rolls back. The committing control proves the same path works when the
 * transaction does commit.
 *
 * Real Postgres throughout; the rollback is the real database rolling back.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { auditBulkOperation, auditExport, auditRegulatedRead } from '../platform/audit.js';
import { prisma, unscopedPrisma, type DbTx } from '../platform/db.js';
import { raiseException } from '../platform/exceptions.js';
import { issueLetter } from '../domains/compliance/labour.js';
import { asUser, principalFor, tenantId } from './helpers.js';

const ROLLBACK = 'deliberate rollback for the atomicity probe';

/**
 * Runs `work` in a transaction and then rolls it back. A failure other than the
 * deliberate rollback is rethrown, so a helper that cannot run inside the
 * transaction fails the test with its own error instead of passing vacuously.
 */
async function rollingBack(work: (tx: DbTx) => Promise<void>): Promise<void> {
  await asUser('chairman@kaizen.co.in', () =>
    prisma.$transaction(async (tx) => {
      await work(tx);
      throw new Error(ROLLBACK);
    }),
  ).catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err;
  });
}

async function eventCountMentioning(tid: string, eventName: string, needle: string): Promise<number> {
  const rows = await unscopedPrisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox_events
    WHERE "tenantId" = ${tid} AND "eventName" = ${eventName} AND payload::text LIKE ${`%${needle}%`}`;
  return Number(rows[0]?.n ?? 0);
}

describe('exception raise runs inside the caller transaction', () => {
  it('a rolled-back transaction leaves no exception, audit row, notification or event from raiseException', async () => {
    const tid = await tenantId();
    const owner = await principalFor('finance@kaizen.co.in');
    const token = randomUUID().slice(0, 8);
    const subjectId = `ptx-subject-${token}`;
    const code = `PTX-${token}`;
    const label = `PTX probe ${token}`;

    await rollingBack(async (tx) => {
      const row = await raiseException(
        {
          code,
          label,
          severity: 'S2_WARNING',
          subjectType: 'invoice',
          subjectId,
          detail: 'tx probe',
          ownerPartyId: owner.partyId,
        },
        tx,
      );
      expect(await tx.exceptionRecord.findFirst({ where: { id: row.id } })).not.toBeNull();
    });

    expect(await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code } })).toBe(0);
    expect(await unscopedPrisma.notification.count({ where: { tenantId: tid, title: label } })).toBe(0);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: tid, subjectType: 'exception', diff: { path: ['code'], equals: code } },
      }),
    ).toBe(0);
    expect(await eventCountMentioning(tid, EVENTS.EXCEPTION_RAISED, subjectId)).toBe(0);
  });

  it('control: a committed transaction keeps the exception, its audit row, notification and event', async () => {
    const tid = await tenantId();
    const owner = await principalFor('finance@kaizen.co.in');
    const token = randomUUID().slice(0, 8);
    const subjectId = `ptx-commit-${token}`;
    const code = `PTX-C-${token}`;

    await asUser('chairman@kaizen.co.in', () =>
      prisma.$transaction(async (tx) => {
        await raiseException(
          {
            code,
            label: `PTX commit ${token}`,
            severity: 'S2_WARNING',
            subjectType: 'invoice',
            subjectId,
            detail: 'tx control',
            ownerPartyId: owner.partyId,
          },
          tx,
        );
      }),
    );

    expect(await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code } })).toBe(1);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: tid, subjectType: 'exception', diff: { path: ['code'], equals: code } },
      }),
    ).toBe(1);
    expect(await eventCountMentioning(tid, EVENTS.EXCEPTION_RAISED, subjectId)).toBe(1);
  });
});

describe('letter issue and audit helpers run inside the caller transaction', () => {
  it('a rolled-back transaction leaves no HR letter from issueLetter', async () => {
    const tid = await tenantId();
    const name = `PTX Letter ${randomUUID().slice(0, 8)}`;

    await asUser('operations@kaizen.co.in', () =>
      rollingBack(async (tx) => {
        const letter = await issueLetter(
          { kind: 'confirmation', employeeName: name, legalEntity: 'Kaizen Infinities Pvt Ltd' },
          tx,
        );
        expect(await tx.hrLetter.findFirst({ where: { id: letter.id } })).not.toBeNull();
      }),
    );

    expect(
      await unscopedPrisma.hrLetter.count({
        where: { tenantId: tid, snapshot: { path: ['employeeName'], equals: name } },
      }),
    ).toBe(0);
  });

  it('a rolled-back transaction leaves no export, bulk or regulated-read audit rows', async () => {
    const tid = await tenantId();
    const token = randomUUID().slice(0, 8);
    const scope = `ptx-export-${token}`;
    const operation = `ptx-bulk-${token}`;
    const readSubject = `ptx-read-${token}`;

    await asUser('chairman@kaizen.co.in', () =>
      rollingBack(async (tx) => {
        await auditExport('invoice', scope, 3, tx);
        await auditBulkOperation('invoice', operation, { rows: 3 }, tx);
        await auditRegulatedRead('employee', readSubject, ['pan'], tx);
        expect(await tx.auditRecord.count({ where: { tenantId: tid, subjectId: readSubject } })).toBe(1);
      }),
    );

    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: tid, action: 'export', meta: { path: ['scope'], equals: scope } },
      }),
    ).toBe(0);
    expect(await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectId: `bulk:${operation}` } })).toBe(
      0,
    );
    expect(await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectId: readSubject } })).toBe(0);
  });
});
