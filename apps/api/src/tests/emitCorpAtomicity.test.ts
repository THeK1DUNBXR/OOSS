/**
 * Register writes commit with their audit row and event, or not at all.
 *
 * Before this, createShareClass wrote the row, then auditWrite and emit ran in
 * their own transactions. An audit failure left a share class with no record
 * of who created it, and the event never went out. The test makes the audit
 * insert fail on purpose (a test-only trigger on audit_records, installed for
 * one call) and checks that no share class row and no outbox event survive.
 *
 * Real Postgres and the real decision path. The trigger is fault injection:
 * the insert really is refused by the database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { createShareClass } from '../domains/equity.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const INJECTED = 'injected audit failure';

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION emit_corp_refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER emit_corp_refuse_audit_insert BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION emit_corp_refuse_audit_insert()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS emit_corp_refuse_audit_insert ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS emit_corp_refuse_audit_insert()`);
}

afterEach(restoreAuditInserts);

describe('register writes commit with their audit row and event, or not at all', () => {
  it('share class creation: an audit failure leaves no share class row and no outbox event', async () => {
    const tid = await tenantId();
    const name = `EMIT-CORP-ATOM-${Date.now()}`;
    const beforeEvents = await unscopedPrisma.outboxEvent.count({
      where: { tenantId: tid, eventName: EVENTS.SHARE_CLASS_CREATED },
    });

    await refuseAuditInserts();
    await expect(
      asUser('chairman@kaizen.co.in', () =>
        createShareClass({ name, kind: 'equity', instrument: 'equity_shares', faceValue: 10 }),
      ),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    expect(await unscopedPrisma.shareClass.count({ where: { tenantId: tid, name } })).toBe(0);
    expect(
      await unscopedPrisma.outboxEvent.count({ where: { tenantId: tid, eventName: EVENTS.SHARE_CLASS_CREATED } }),
    ).toBe(beforeEvents);
  });

  it('control: share class creation with audit available writes the row, the audit row and the event', async () => {
    const tid = await tenantId();
    const name = `EMIT-CORP-OK-${Date.now()}`;
    const beforeEvents = await unscopedPrisma.outboxEvent.count({
      where: { tenantId: tid, eventName: EVENTS.SHARE_CLASS_CREATED },
    });

    await asUser('chairman@kaizen.co.in', () =>
      createShareClass({ name, kind: 'equity', instrument: 'equity_shares', faceValue: 10 }),
    );

    expect(await unscopedPrisma.shareClass.count({ where: { tenantId: tid, name } })).toBe(1);
    expect(
      await unscopedPrisma.outboxEvent.count({ where: { tenantId: tid, eventName: EVENTS.SHARE_CLASS_CREATED } }),
    ).toBe(beforeEvents + 1);
  });
});
