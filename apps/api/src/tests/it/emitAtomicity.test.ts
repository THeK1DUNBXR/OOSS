/**
 * Technology — a governed write, its audit row and its event commit together.
 *
 * Before the conversion, the domain row committed first and `auditWrite` /
 * `emit` ran afterwards, so an audit failure left a changed row with no audit
 * record and no event. These tests make the audit insert fail on purpose (a
 * test-only trigger on audit_records, installed for the length of one call)
 * and check that the domain row is where it was and that no outbox event was
 * written. Two functions from each group: governance (risks, findings) and
 * the technology domain (vendors, change freezes).
 *
 * The trigger is a fault injection, not a mock: the insert really is refused
 * by the database. Real Postgres and the real decision paths throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import { createRisk } from '../../domains/it/governance/risks.js';
import { createFinding, transitionFinding } from '../../domains/it/governance/findings.js';
import { createVendor } from '../../domains/it/vendors.js';
import { declareFreeze } from '../../domains/it/itsm.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const INJECTED = 'injected audit failure';
const TRIGGER = 'it_emit_refuse_audit_insert';

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON audit_records FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
}

afterEach(restoreAuditInserts);

async function outboxCount(eventName: string): Promise<number> {
  return unscopedPrisma.outboxEvent.count({ where: { tenantId: await tenantId(), eventName } });
}

describe('IT governed writes commit with their audit row and event, or not at all', () => {
  it('governance control: a risk with audit available is written with its event', async () => {
    const tid = await tenantId();
    const title = `Atomic control risk ${stamp()}`;
    const ownerPartyId = (
      await unscopedPrisma.affiliation.findFirstOrThrow({
        where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' },
      })
    ).partyId;
    const before = await outboxCount(EVENTS.IT_RISK_CREATED);

    await asUser('operations@kaizen.co.in', () =>
      createRisk({
        title,
        category: 'infrastructure',
        ownerPartyId,
        likelihoodInherent: 2,
        impactInherent: 2,
        treatment: 'accept',
      }),
    );

    expect(await unscopedPrisma.itRisk.count({ where: { tenantId: tid, title } })).toBe(1);
    expect(await outboxCount(EVENTS.IT_RISK_CREATED)).toBe(before + 1);
  });

  it('governance risk: an audit failure leaves no risk row and writes no outbox event', async () => {
    const tid = await tenantId();
    const title = `Atomic probe risk ${stamp()}`;
    const ownerPartyId = (
      await unscopedPrisma.affiliation.findFirstOrThrow({
        where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' },
      })
    ).partyId;
    const before = await outboxCount(EVENTS.IT_RISK_CREATED);

    await refuseAuditInserts();
    await expect(
      asUser('operations@kaizen.co.in', () =>
        createRisk({
          title,
          category: 'infrastructure',
          ownerPartyId,
          likelihoodInherent: 2,
          impactInherent: 2,
          treatment: 'accept',
        }),
      ),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    expect(await unscopedPrisma.itRisk.count({ where: { tenantId: tid, title } })).toBe(0);
    expect(await outboxCount(EVENTS.IT_RISK_CREATED)).toBe(before);
  });

  it('governance finding: an audit failure on a transition leaves the status open and writes no outbox event', async () => {
    const finding = await asUser('operations@kaizen.co.in', () =>
      createFinding({ title: `Atomic probe finding ${stamp()}`, source: 'scan', severity: 'medium' }),
    );
    const before = await outboxCount(EVENTS.IT_FINDING_TRANSITIONED);

    await refuseAuditInserts();
    await expect(
      asUser('operations@kaizen.co.in', () => transitionFinding(finding.id, 'START' as never)),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    const after = await unscopedPrisma.itSecurityFinding.findFirstOrThrow({ where: { id: finding.id } });
    expect(after.status).toBe('open');
    expect(await outboxCount(EVENTS.IT_FINDING_TRANSITIONED)).toBe(before);
  });

  it('technology vendor: an audit failure leaves no vendor row and writes no outbox event', async () => {
    const tid = await tenantId();
    const name = `Atomic probe vendor ${stamp()}`;
    const before = await outboxCount(EVENTS.IT_VENDOR_CREATED);

    await refuseAuditInserts();
    await expect(
      asUser('operations@kaizen.co.in', () => createVendor({ name, category: 'saas', tier: 2 })),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    expect(await unscopedPrisma.itVendor.count({ where: { tenantId: tid, name } })).toBe(0);
    expect(await outboxCount(EVENTS.IT_VENDOR_CREATED)).toBe(before);
  });

  it('technology change freeze: an audit failure leaves no freeze row and writes no outbox event', async () => {
    const tid = await tenantId();
    // Far enough out that a probe that did commit could not overlap any window
    // the change-scheduling tests use.
    const name = `Atomic probe freeze ${stamp()}`;
    const before = await outboxCount(EVENTS.IT_CHANGE_FREEZE_DECLARED);

    await refuseAuditInserts();
    await expect(
      asUser('operations@kaizen.co.in', () =>
        declareFreeze({
          name,
          startsAt: new Date('2200-01-01T00:00:00.000Z'),
          endsAt: new Date('2200-01-02T00:00:00.000Z'),
          reason: 'Atomicity probe.',
        }),
      ),
    ).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    expect(await unscopedPrisma.itChangeFreeze.count({ where: { tenantId: tid, name } })).toBe(0);
    expect(await outboxCount(EVENTS.IT_CHANGE_FREEZE_DECLARED)).toBe(before);
  });
});
