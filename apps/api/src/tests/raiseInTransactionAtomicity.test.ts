/**
 * An exception raised as a consequence of a governed write commits or vanishes
 * with that write.
 *
 * When a write and the exception it implies were separate transactions, the
 * write could commit and the raise then fail, leaving a changed row with no
 * exception to act on. These tests make the audit insert for `exception` rows
 * fail on purpose (a test-only trigger, installed for one call) and check that
 * the domain row is back where it was once the call rejects.
 *
 * The trigger is scoped to exception audit rows, so the domain write's own audit
 * row still succeeds: on the old code the domain write commits and only the
 * raise fails, which is the orphan this file is about.
 *
 * Real Postgres and the real decision paths. The trigger is a fault injection,
 * not a mock: the insert really is refused by the database.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { markChallanPaid } from '../domains/compliance/tax.js';
import { closeRound, createRound } from '../domains/rounds.js';
import { requestClosePeriod, closePeriod } from '../domains/compliance/books.js';

const CLOSED = '2017-10';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';
const INJECTED = 'injected exception audit failure';

let TENANT: string;

async function refuseExceptionAudit(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2_refuse_exception_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2_refuse_exception_audit BEFORE INSERT ON audit_records
     FOR EACH ROW WHEN (NEW."subjectType" = 'exception')
     EXECUTE FUNCTION w2_refuse_exception_audit()`,
  );
}

async function restoreExceptionAudit(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_refuse_exception_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_refuse_exception_audit()`);
}

afterEach(restoreExceptionAudit);

beforeAll(async () => {
  TENANT = await tenantId();
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

describe('a challan paid in a closed period raises EX-FIN-008 in the same transaction', () => {
  it('when the raise cannot be recorded, the challan stays unpaid and the call rejects', async () => {
    const challan = await unscopedPrisma.tdsChallan.create({
      data: {
        tenantId: TENANT,
        recordCode: unique('W2-ATOMIC-CHALLAN'),
        month: '2026-09',
        sectionGroup: '194C_IND',
        amount: 100,
        deducteeCount: 1,
      },
    });

    await refuseExceptionAudit();
    await expectReject(() =>
      asUser(CHAIRMAN, () =>
        markChallanPaid(challan.id, {
          bsrCode: '0000000',
          challanNo: unique('W2-ATOMIC'),
          paidOn: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );

    const after = await unscopedPrisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } });
    expect(after.status).not.toBe('paid');
    expect(after.paidOn).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-FIN-008', subjectId: challan.id },
      }),
    ).toBe(0);
  });
});

describe('closing a funding round raises the PAS-3 return exception in the same transaction', () => {
  it('when the raise cannot be recorded, the round stays open and the call rejects', async () => {
    const round = await asUser(CHAIRMAN, () => createRound({ name: unique('W2-ATOMIC-ROUND'), kind: 'rights_issue' }));
    await unscopedPrisma.fundingRound.update({ where: { id: round.id }, data: { status: 'open' } });

    await refuseExceptionAudit();
    await expectReject(() => asUser(CHAIRMAN, () => closeRound(round.id)));

    const after = await unscopedPrisma.fundingRound.findUniqueOrThrow({ where: { id: round.id } });
    expect(after.status).toBe('open');
    expect(after.closedOn).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-EQT-003', subjectId: round.id },
      }),
    ).toBe(0);
  });
});
