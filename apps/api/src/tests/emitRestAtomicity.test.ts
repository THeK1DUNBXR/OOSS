/**
 * The agent layer's governed writes commit with their audit row and event, or
 * not at all.
 *
 * `propose` and `revokeAuthority` used to write the domain row, then call
 * `auditWrite` and `emit` in their own transactions. A failure in between left
 * a changed row with no audit record or no outbox event. These tests make the
 * audit insert fail on purpose (a test-only trigger on audit_records, installed
 * for one call) and check the domain row and the outbox are unchanged.
 *
 * Real Postgres and the real decision paths. The trigger is a fault injection:
 * the insert really is refused by the database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { propose, revokeAuthority } from '../agents/index.js';
import { prisma } from '../platform/db.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const INJECTED = 'injected audit failure';

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION emit_rest_refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER emit_rest_refuse_audit_insert BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION emit_rest_refuse_audit_insert()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS emit_rest_refuse_audit_insert ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS emit_rest_refuse_audit_insert()`);
}

afterEach(restoreAuditInserts);

async function outboxCount(eventName: string): Promise<number> {
  return unscopedPrisma.outboxEvent.count({ where: { tenantId: await tenantId(), eventName } });
}

async function agentActionCount(): Promise<number> {
  return unscopedPrisma.agentAction.count({ where: { tenantId: await tenantId() } });
}

describe('agent governed writes commit with their audit row and event, or not at all', () => {
  it('propose: an audit failure leaves no proposal row and writes no outbox event', async () => {
    const opportunity = await prisma.opportunity.findFirstOrThrow({});
    const actionsBefore = await agentActionCount();
    const outboxBefore = await outboxCount(EVENTS.AGENT_ACTION_PROPOSED);

    await refuseAuditInserts();
    await expect(
      asUser('chairman@kaizen.co.in', () =>
        propose({
          agentKey: 'agent.forecast',
          tool: 'tool.crm.suggest_forecast_category',
          action: 'opportunity.suggest_forecast',
          subjectType: 'opportunity',
          subjectId: opportunity.id,
          proposal: { to: 'commit' },
          rationale: 'Atomicity probe.',
        }),
      ),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    expect(await agentActionCount()).toBe(actionsBefore);
    expect(await outboxCount(EVENTS.AGENT_ACTION_PROPOSED)).toBe(outboxBefore);
  });

  it('revoke authority: an audit failure leaves the grant active and writes no outbox event', async () => {
    const grant = await unscopedPrisma.authorityGrant.findFirstOrThrow({
      where: { tenantId: await tenantId(), status: 'active' },
    });
    const outboxBefore = await outboxCount(EVENTS.GRANT_CHANGED);

    await refuseAuditInserts();
    await expect(asUser('chairman@kaizen.co.in', () => revokeAuthority(grant.id, 'atomicity probe'))).rejects.toThrow(
      INJECTED,
    );
    await restoreAuditInserts();

    const after = await unscopedPrisma.authorityGrant.findFirstOrThrow({ where: { id: grant.id } });
    expect(after.status).toBe(grant.status);
    expect(after.revokedAt).toBeNull();
    expect(await outboxCount(EVENTS.GRANT_CHANGED)).toBe(outboxBefore);
  });
});
