/**
 * FX-06 — exception acknowledge and resolve are permissioned, owner-scoped,
 * state-guarded and audited.
 *
 * Before this fix both functions wrote straight through: any caller who could
 * reach the route could resolve any exception in the tenant, from any state,
 * with no audit row. Rule 5 of CLAUDE.md applies to every write.
 */

import { randomUUID } from 'node:crypto';
import { EVENTS } from '@kaizen/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { acknowledgeException, resolveException } from '../platform/exceptions.js';
import { unscopedPrisma } from '../platform/db.js';
import { expectReject, tenantId, withFixtureRole } from './helpers.js';

const createdExceptionIds: string[] = [];

async function openException(tid: string, ownerPartyId: string | null) {
  const rec = await unscopedPrisma.exceptionRecord.create({
    data: {
      tenantId: tid,
      recordCode: `EXC-FX06-${randomUUID().slice(0, 8)}`,
      code: 'FX06-TEST',
      label: 'FX-06 fixture exception',
      severity: 'S2',
      state: 'open',
      subjectType: 'invoice',
      subjectId: `fx06-${randomUUID()}`,
      ownerPartyId,
    },
  });
  createdExceptionIds.push(rec.id);
  return rec;
}

afterAll(async () => {
  await unscopedPrisma.exceptionRecord.deleteMany({ where: { id: { in: createdExceptionIds } } }).catch(() => {});
});

describe('FX-06 exception acknowledge / resolve', () => {
  it('refuses a caller without edit on exceptions, and leaves the state unchanged', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx06_viewer', grants: [{ resource: 'exceptions', verbs: ['view'], scope: 'all' }] },
      async (p) => {
        const rec = await openException(tid, p.partyId);

        const ack = await expectReject(() => acknowledgeException(rec.id));
        expect(ack.status).toBe(403);

        const res = await expectReject(() => resolveException(rec.id, 'closed by a viewer'));
        expect(res.status).toBe(403);

        const after = await unscopedPrisma.exceptionRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.state).toBe('open');
        expect(after.resolvedAt).toBeNull();
      },
    );
  });

  it('refuses an editor who is not the owner of the exception (own scope)', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx06_own_editor', grants: [{ resource: 'exceptions', verbs: ['edit'], scope: 'own' }] },
      async () => {
        const rec = await openException(tid, `someone-else-${randomUUID()}`);

        const res = await expectReject(() => resolveException(rec.id, 'not mine'));
        expect(res.status).toBe(403);

        const after = await unscopedPrisma.exceptionRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.state).toBe('open');
      },
    );
  });

  it('lets the owner acknowledge then resolve, audits each step, and refuses a second resolve', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx06_owner', grants: [{ resource: 'exceptions', verbs: ['edit'], scope: 'own' }] },
      async (p) => {
        const rec = await openException(tid, p.partyId);

        await acknowledgeException(rec.id, 'looking');
        await resolveException(rec.id, 'fixed at source');

        const after = await unscopedPrisma.exceptionRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.state).toBe('resolved');
        expect(after.resolutionNote).toBe('fixed at source');

        const again = await expectReject(() => resolveException(rec.id, 'again'));
        expect(again.status).toBe(409);

        const audit = await unscopedPrisma.auditRecord.findMany({
          where: { tenantId: tid, subjectType: 'exception', subjectId: rec.id },
        });
        expect(audit.length).toBe(2);

        // The event for each move is on the record, not only the audit row: an
        // exception closed without its event is invisible to every subscriber.
        const events = await unscopedPrisma.eventRecord.findMany({
          where: { tenantId: tid, subjectEntityId: rec.id },
          orderBy: { seq: 'asc' },
        });
        expect(events.map((e) => e.eventName)).toEqual([EVENTS.EXCEPTION_ACKNOWLEDGED, EVENTS.EXCEPTION_RESOLVED]);
      },
    );
  });
});
