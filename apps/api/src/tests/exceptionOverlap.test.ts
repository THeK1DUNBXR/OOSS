/**
 * Overlapping job runs must not double-raise or double-escalate an exception.
 *
 * 46 external jobs call raiseException and rely on its open-exception dedupe.
 * That dedupe was a findFirst followed by a create, so two runs that overlapped
 * both saw "no open exception" and both created one: two rows, two owner
 * notifications. escalateException had no state guard at all, so two overlapping
 * SLA sweeps each bumped the rung and each notified the escalation owner.
 *
 * The database is the arbiter here: a partial unique index on the open
 * exception's natural key, and a conditional UPDATE on the rung. These tests
 * drive real concurrency against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { escalateException, raiseException, type RaiseExceptionInput } from '../platform/exceptions.js';
import { unscopedPrisma } from '../platform/db.js';
import { withFixtureRole } from './helpers.js';

const createdSubjectIds: string[] = [];

function raiseInput(ownerPartyId: string | null, overrides: Partial<RaiseExceptionInput> = {}): RaiseExceptionInput {
  const subjectId = `overlap-${randomUUID()}`;
  createdSubjectIds.push(subjectId);
  return {
    code: 'OVERLAP-TEST',
    label: 'Overlap fixture exception',
    severity: 'S2_WARNING',
    subjectType: 'invoice',
    subjectId,
    subjectLabel: 'fixture subject',
    detail: 'fixture detail',
    ownerPartyId,
    ...overrides,
  };
}

async function exceptionRowsFor(subjectId: string) {
  return unscopedPrisma.exceptionRecord.findMany({ where: { subjectId, code: 'OVERLAP-TEST' } });
}

async function notificationsFor(recipientPartyId: string, exceptionId: string) {
  return unscopedPrisma.notification.findMany({
    where: { recipientPartyId, subjectType: 'exception', subjectId: exceptionId },
  });
}

afterAll(async () => {
  await unscopedPrisma.exceptionRecord.deleteMany({ where: { subjectId: { in: createdSubjectIds } } }).catch(() => {});
});

describe('exception raise is overlap-safe', () => {
  it('concurrent raises for the same key create one open row and notify the owner once', async () => {
    await withFixtureRole(
      { slug: 'ovl_owner', grants: [{ resource: 'exceptions', verbs: ['view'], scope: 'all' }] },
      async (p) => {
        const input = raiseInput(p.partyId);

        const results = await Promise.all(Array.from({ length: 5 }, () => raiseException(input)));

        const rows = await exceptionRowsFor(input.subjectId);
        expect(rows).toHaveLength(1);
        const ids = new Set(results.map((r) => r.id));
        expect(ids).toEqual(new Set([rows[0].id]));

        const notes = await notificationsFor(p.partyId, rows[0].id);
        expect(notes).toHaveLength(1);
      },
    );
  });

  it('a resolved exception does not block raising a new one for the same key', async () => {
    await withFixtureRole(
      { slug: 'ovl_reraise', grants: [{ resource: 'exceptions', verbs: ['view'], scope: 'all' }] },
      async (p) => {
        const input = raiseInput(p.partyId);

        const first = await raiseException(input);
        await unscopedPrisma.exceptionRecord.update({
          where: { id: first.id },
          data: { state: 'resolved', resolvedAt: new Date() },
        });

        const second = await raiseException(input);

        expect(second.id).not.toBe(first.id);
        expect(second.state).toBe('open');
        const rows = await exceptionRowsFor(input.subjectId);
        expect(rows.map((r) => r.state).sort()).toEqual(['open', 'resolved']);
      },
    );
  });
});

describe('exception escalation is overlap-safe', () => {
  it('concurrent escalations of one exception bump the rung once and notify once', async () => {
    await withFixtureRole(
      { slug: 'ovl_escal', grants: [{ resource: 'exceptions', verbs: ['view'], scope: 'all' }] },
      async (p) => {
        const escalateTo = `esc-${randomUUID()}`;
        const rec = await raiseException(raiseInput(p.partyId));
        // Three SLA sweeps each listed the row at rung 0 before any of them ran.
        const observedRung = rec.escalationRung ?? 0;

        await Promise.all(
          Array.from({ length: 3 }, () => escalateException(rec.id, 'sla_expiry', undefined, escalateTo, observedRung)),
        );

        const after = await unscopedPrisma.exceptionRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.escalationRung).toBe(1);
        expect(after.state).toBe('escalated');

        const notes = await notificationsFor(escalateTo, rec.id);
        expect(notes).toHaveLength(1);
      },
    );
  });

  it('does not escalate a resolved exception', async () => {
    await withFixtureRole(
      { slug: 'ovl_escal_closed', grants: [{ resource: 'exceptions', verbs: ['view'], scope: 'all' }] },
      async (p) => {
        const rec = await raiseException(raiseInput(p.partyId));
        await unscopedPrisma.exceptionRecord.update({
          where: { id: rec.id },
          data: { state: 'resolved', resolvedAt: new Date(), resolvedById: p.partyId, resolutionNote: 'closed' },
        });

        await escalateException(rec.id, 'sla_expiry');

        const after = await unscopedPrisma.exceptionRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.state).toBe('resolved');
        expect(after.escalationRung).toBe(0);
      },
    );
  });
});
