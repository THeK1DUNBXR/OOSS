/**
 * An HCM governed write, its audit row and its event commit or vanish together.
 *
 * Before this, createDelegation and revokeDelegation (domains/hcm/workflow.ts)
 * wrote the domain row, then emitted, then audited, each in its own statement.
 * An audit failure left the delegation changed with its event already in the
 * outbox. These tests install a test-only trigger on audit_records that refuses
 * every insert, call the function, and check that the domain row is back where
 * it was and that no outbox row was written for the event.
 *
 * Real Postgres and the real decision paths. The trigger is a fault injection:
 * the insert really is refused by the database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asUser, principalFor, tenantId, unscopedPrisma } from '../helpers.js';
import { createDelegation, revokeDelegation } from '../../domains/hcm/workflow.js';

const INJECTED = 'injected audit failure';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION hcm_refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER hcm_refuse_audit_insert BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION hcm_refuse_audit_insert()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS hcm_refuse_audit_insert ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS hcm_refuse_audit_insert()`);
}

afterEach(restoreAuditInserts);

async function outboxCount(eventName: string): Promise<number> {
  return unscopedPrisma.outboxEvent.count({ where: { tenantId: await tenantId(), eventName } });
}

const window = () => ({
  fromDate: new Date(Date.now() - 86_400_000),
  toDate: new Date(Date.now() + 7 * 86_400_000),
});

describe('HCM governed writes commit with their audit row and event, or not at all', () => {
  it('control: a delegation created with audit available writes the row, the audit row and the event', async () => {
    const delegate = await principalFor('finance@kaizen.co.in');
    const before = await outboxCount(EVENTS.AUTHORITY_DELEGATION_CREATED);

    const row = await asUser('operations@kaizen.co.in', () =>
      createDelegation({ toPartyId: delegate.partyId, ...window(), scope: 'all', note: `control-${stamp()}` }),
    );

    expect(await unscopedPrisma.delegationOfAuthority.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await outboxCount(EVENTS.AUTHORITY_DELEGATION_CREATED)).toBe(before + 1);
  });

  it('createDelegation: an audit failure leaves no delegation and writes no outbox event', async () => {
    const delegate = await principalFor('finance@kaizen.co.in');
    const note = `atomic-create-${stamp()}`;
    const before = await outboxCount(EVENTS.AUTHORITY_DELEGATION_CREATED);

    await refuseAuditInserts();
    await expect(
      asUser('operations@kaizen.co.in', () =>
        createDelegation({ toPartyId: delegate.partyId, ...window(), scope: 'all', note }),
      ),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    const leftover = await unscopedPrisma.delegationOfAuthority.findMany({
      where: { tenantId: await tenantId(), note },
    });
    expect(leftover).toHaveLength(0);
    expect(await outboxCount(EVENTS.AUTHORITY_DELEGATION_CREATED)).toBe(before);
  });

  it('revokeDelegation: an audit failure leaves the delegation unrevoked and writes no outbox event', async () => {
    const delegator = await principalFor('operations@kaizen.co.in');
    const delegate = await principalFor('finance@kaizen.co.in');
    const tid = await tenantId();
    const delegation = await unscopedPrisma.delegationOfAuthority.create({
      data: {
        tenantId: tid,
        fromPartyId: delegator.partyId,
        toPartyId: delegate.partyId,
        ...window(),
        scope: 'all',
        note: `atomic-revoke-${stamp()}`,
      },
    });
    const before = await outboxCount(EVENTS.AUTHORITY_DELEGATION_ENDED);

    await refuseAuditInserts();
    await expect(asUser('operations@kaizen.co.in', () => revokeDelegation(delegation.id))).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    const row = await unscopedPrisma.delegationOfAuthority.findUniqueOrThrow({ where: { id: delegation.id } });
    expect(row.revokedAt).toBeNull();
    expect(await outboxCount(EVENTS.AUTHORITY_DELEGATION_ENDED)).toBe(before);
  });
});
