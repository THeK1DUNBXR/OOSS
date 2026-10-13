/**
 * Statutory approval is a duty, not a permission (round 27 c; round 23 d). The
 * approver of a statutory rule is whoever holds STATUTORY_APPROVER_DUTY at the
 * instant of approval. A tenant with no holder gets no APPROVED rows, and the
 * refusal says so.
 *
 * Holder rows are written through assignDuty, as the chairman, so the grant that
 * governs granting a duty is exercised too. Fixture principals hold rate_tables
 * approve and nothing else, which is the case the duty check exists for.
 *
 * Every test here touches the one holder row a tenant can have for the statutory
 * approver duty, so each one clears it. The test files run serially
 * (vitest.config.ts), so the rows do not collide across files.
 */

import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { createApp } from '../server.js';
import {
  approveStatutoryRule,
  assignDuty,
  createStatutoryRule,
  endDuty,
  getDutyHolder,
  ruleAt,
  resolveDutyHolder,
  StatutoryRuleNotFoundError,
  STATUTORY_APPROVER_DUTY,
} from '../domains/statutory.js';
import { seedStatutory, SEED_CREATED_BY } from '../seed/compliance/statutory.js';
import {
  asPrincipal,
  asUser,
  authFor,
  sessionToken,
  tenantId,
  withFixtureRole,
  type TestPrincipal,
} from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const JURISDICTION = 'TEST-W1K-DUTY';
const KEY = 'test.example_rate';
const APPROVER_GRANTS = [{ resource: 'rate_tables', verbs: ['view', 'edit', 'approve'] }];
const PAST = new Date('2026-01-01T00:00:00.000Z');
const UNVERIFIED_SOURCE = 'UNVERIFIED: fixture, obviously fake, W1K';

let tid: string;
let server: Server;
let base: string;

beforeAll(() => {
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  server?.close();
  await clearAll();
});

function dateOnly(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function clearAll() {
  await unscopedPrisma.statutoryRule.deleteMany({ where: { jurisdiction: JURISDICTION } });
  await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: STATUTORY_APPROVER_DUTY } });
}

/** The approval's audit row: the last update to the rule, by sequence. */
async function lastApprovalAudit(ruleId: string) {
  const audit = await unscopedPrisma.auditRecord.findMany({
    where: { subjectType: 'statutory_rule', subjectId: ruleId, action: 'update' },
    orderBy: { seq: 'asc' },
  });
  const last = audit.at(-1);
  if (!last) throw new Error('No approval audit row was written.');
  return last;
}

async function draftRule(source = 'fixture: obviously fake, W1K') {
  return asUser(CHAIRMAN, () =>
    createStatutoryRule({
      domain: 'test',
      key: KEY,
      jurisdiction: JURISDICTION,
      effectiveFrom: dateOnly('2026-04-01'),
      value: 2,
      source,
    }),
  );
}

async function holdDuty(partyId: string, effectiveFrom: Date = PAST) {
  return asUser(CHAIRMAN, () => assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId, effectiveFrom }));
}

/** The error a call rejects with, with its details, so reasonCode can be asserted. */
async function errorOf(
  fn: () => Promise<unknown>,
): Promise<{ status?: number; message: string; details?: { reasonCode?: string } }> {
  try {
    await fn();
  } catch (err) {
    return err as { status?: number; message: string; details?: { reasonCode?: string } };
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

async function tokenFor(p: TestPrincipal): Promise<string> {
  return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
}

beforeEach(async () => {
  tid = await tenantId();
  await clearAll();
});

afterEach(clearAll);

describe('statutory approval is held as a duty (round 27 c)', () => {
  it('refuses approval by a principal who does not hold the statutory approver duty, with 403', async () => {
    const draft = await draftRule();
    await withFixtureRole({ slug: 'w1k_holder', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);
      await withFixtureRole({ slug: 'w1k_not_holder', grants: APPROVER_GRANTS }, async () => {
        const err = await errorOf(() => approveStatutoryRule(draft.id));
        expect(err.status).toBe(403);
        expect(err.details?.reasonCode).toBe('not_statutory_approver');
      });
    });
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('with no holder, refuses approval with 422 "awaiting the accountant\'s setup", and the row stays DRAFT', async () => {
    const draft = await draftRule();
    await withFixtureRole({ slug: 'w1k_no_holder', grants: APPROVER_GRANTS }, async () => {
      const err = await errorOf(() => approveStatutoryRule(draft.id));
      expect(err.status).toBe(422);
      expect(err.message).toContain("awaiting the accountant's setup");
      expect(err.details?.reasonCode).toBe('statutory_approver_not_set');
    });
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
    expect(after.approvedBy).toBeNull();
  });

  it('a holder approves: the row is APPROVED, and the audit record carries approver, time and rule version', async () => {
    const draft = await draftRule();
    await withFixtureRole({ slug: 'w1k_holder_ok', grants: APPROVER_GRANTS }, async (holder) => {
      const holderRow = await holdDuty(holder.partyId);
      const approved = await approveStatutoryRule(draft.id);
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedBy).toBe(holder.partyId);
      expect(approved.approvedAt).toBeInstanceOf(Date);

      const approval = await lastApprovalAudit(draft.id);
      const meta = approval.meta as Record<string, unknown>;
      expect(meta.approver).toEqual({
        partyId: holder.partyId,
        dutyKey: STATUTORY_APPROVER_DUTY,
        dutyAssignmentId: holderRow.id,
      });
      const diff = approval.diff as Record<string, { from: unknown; to: unknown }>;
      expect(diff.approvedBy?.to).toBe(holder.partyId);
      expect(diff.approvedAt?.to).toBeDefined();
      expect(diff.status).toEqual({ from: 'DRAFT', to: 'APPROVED' });
      const version = meta.ruleVersion as Record<string, unknown>;
      expect(version).toMatchObject({
        id: draft.id,
        key: KEY,
        jurisdiction: JURISDICTION,
        domain: 'test',
        value: 2,
      });
      expect(version.effectiveFrom).toBeDefined();
    });
  });

  it('a holder who created the row cannot approve it', async () => {
    await withFixtureRole({ slug: 'w1k_maker_holder', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);
      const own = await asPrincipal(authFor(holder), () =>
        createStatutoryRule({
          domain: 'test',
          key: KEY,
          jurisdiction: JURISDICTION,
          effectiveFrom: dateOnly('2026-04-01'),
          value: 2,
          source: 'fixture: obviously fake, W1K',
        }),
      );
      const err = await errorOf(() => asPrincipal(authFor(holder), () => approveStatutoryRule(own.id)));
      expect(err.status).toBe(403);
      const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: own.id } });
      expect(after.status).toBe('DRAFT');
    });
  });

  // The principal is a fixture, not the chairman: the chairman is the founder, and the founder
  // may name himself (owner ruling 2026-10-12, statutoryFounder.test.ts). The refusal for a
  // person who is not the founder is the assertion kept here.
  it('a person who is not the founder cannot name themselves the statutory approver, even holding the grant to assign duties', async () => {
    await withFixtureRole(
      { slug: 'w1k_self_namer', grants: [{ resource: 'access_assignments', verbs: ['approve'] }] },
      async (self) => {
        const err = await errorOf(() =>
          asPrincipal(authFor(self), () => assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId: self.partyId })),
        );
        expect(err.status).toBe(403);
        expect(err.details?.reasonCode).toBe('duty_self_assignment');
      },
    );
    const holders = await unscopedPrisma.dutyAssignment.count({
      where: { tenantId: tid, dutyKey: STATUTORY_APPROVER_DUTY },
    });
    expect(holders).toBe(0);
  });

  it('an UNVERIFIED source is refused without a replacement, accepted with one, and the audit shows old and new', async () => {
    const draft = await draftRule(UNVERIFIED_SOURCE);
    await withFixtureRole({ slug: 'w1k_unverified', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);

      const refused = await errorOf(() => approveStatutoryRule(draft.id));
      expect(refused.status).toBe(422);
      expect(refused.details?.reasonCode).toBe('source_unverified');
      expect((await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');

      const blank = await errorOf(() => approveStatutoryRule(draft.id, { source: '   ' }));
      expect(blank.status).toBe(422);

      const stillUnverified = await errorOf(() =>
        approveStatutoryRule(draft.id, { source: 'UNVERIFIED: still a brief' }),
      );
      expect(stillUnverified.status).toBe(422);

      const verified = 'fixture: verified citation W1K-42';
      const approved = await approveStatutoryRule(draft.id, { source: verified });
      expect(approved.status).toBe('APPROVED');
      expect(approved.source).toBe(verified);

      const approval = await lastApprovalAudit(draft.id);
      const diff = approval.diff as Record<string, { from: unknown; to: unknown }>;
      expect(diff.source).toEqual({ from: UNVERIFIED_SOURCE, to: verified });
    });
  });

  it('a replacement source is refused for a rule whose source is already verified', async () => {
    const draft = await draftRule('fixture: verified citation W1K-7');
    await withFixtureRole({ slug: 'w1k_verified_repl', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);
      const err = await errorOf(() => approveStatutoryRule(draft.id, { source: 'fixture: another' }));
      expect(err.status).toBe(422);
      expect(err.details?.reasonCode).toBe('source_replacement_not_needed');
    });
  });
});

describe('ruleAt fails closed with a typed error (round 27 c)', () => {
  it("with no APPROVED row in force, throws 422 awaiting the accountant's setup, and never returns null", async () => {
    const err = await asUser(CHAIRMAN, () =>
      errorOf(() => ruleAt('test', KEY, JURISDICTION, new Date('2026-06-01T00:00:00.000Z'))),
    );
    expect(err).toBeInstanceOf(StatutoryRuleNotFoundError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("awaiting the accountant's setup");
    expect(err.details?.reasonCode).toBe('statutory_rule_not_approved');
  });
});

describe('the seeded pack holds no APPROVED row (G10 c(3))', () => {
  it('the two figures moved out of code (share-transfer stamp rate, gratuity factor) are seeded as DRAFT with UNVERIFIED citations', async () => {
    await asUser(CHAIRMAN, () => seedStatutory());
    const moved = await unscopedPrisma.statutoryRule.findMany({
      where: { tenantId: tid, domain: { in: ['stamp_duty', 'gratuity'] }, createdBy: SEED_CREATED_BY },
    });
    expect(moved.map((r) => r.key).sort()).toEqual(['gratuity.factor', 'stamp_duty.share_transfer_rate']);
    for (const row of moved) {
      expect(row.status).toBe('DRAFT');
      expect(row.source.startsWith('UNVERIFIED:')).toBe(true);
    }
  });

  it('after seeding, no seeded row is APPROVED, every seeded row is DRAFT with the marker author, and every source is UNVERIFIED', async () => {
    await asUser(CHAIRMAN, () => seedStatutory());
    const seeded = await unscopedPrisma.statutoryRule.findMany({
      where: { tenantId: tid, source: { startsWith: 'UNVERIFIED:' } },
    });
    expect(seeded.length).toBeGreaterThanOrEqual(5);
    for (const row of seeded) {
      expect(row.status).toBe('DRAFT');
      expect(row.createdBy).toBe(SEED_CREATED_BY);
    }
    const approvedSeeded = await unscopedPrisma.statutoryRule.count({
      where: { tenantId: tid, createdBy: SEED_CREATED_BY, status: 'APPROVED' },
    });
    expect(approvedSeeded).toBe(0);
  });
});

describe('the duty holder (round 27 c; one active holder at a time)', () => {
  it('one holder per duty at a time: an overlapping assign is refused 409; ending then assigning hands over', async () => {
    await withFixtureRole({ slug: 'w1k_first', grants: [] }, async (first) => {
      await withFixtureRole({ slug: 'w1k_second', grants: [] }, async (second) => {
        const firstRow = await holdDuty(first.partyId);
        const clash = await asUser(CHAIRMAN, () =>
          errorOf(() => assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId: second.partyId })),
        );
        expect(clash.status).toBe(409);

        await asUser(CHAIRMAN, () => endDuty(firstRow.id));
        const again = await asUser(CHAIRMAN, () => errorOf(() => endDuty(firstRow.id)));
        expect(again.status).toBe(409);

        const handover = await asUser(CHAIRMAN, () =>
          assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId: second.partyId }),
        );
        expect(handover.partyId).toBe(second.partyId);
        const holder = await asUser(CHAIRMAN, () => resolveDutyHolder(STATUTORY_APPROVER_DUTY));
        expect(holder?.partyId).toBe(second.partyId);
      });
    });
  });

  it('resolves the holder at an instant: none before the start, the holder during, none after an end', async () => {
    await withFixtureRole({ slug: 'w1k_instant', grants: [] }, async (holder) => {
      const from = new Date(Date.now() - 60_000);
      const row = await holdDuty(holder.partyId, from);
      await asUser(CHAIRMAN, async () => {
        expect(await resolveDutyHolder(STATUTORY_APPROVER_DUTY, new Date(from.getTime() - 1000))).toBeNull();
        expect((await resolveDutyHolder(STATUTORY_APPROVER_DUTY, new Date()))?.id).toBe(row.id);
      });
      await asUser(CHAIRMAN, () => endDuty(row.id));
      await asUser(CHAIRMAN, async () => {
        expect(await resolveDutyHolder(STATUTORY_APPROVER_DUTY, new Date(Date.now() + 60_000))).toBeNull();
      });
    });
  });

  it('reading the holder needs the access_assignments view verb: a principal without it gets 403', async () => {
    await withFixtureRole({ slug: 'w1k_read_none', grants: [] }, async () => {
      const err = await errorOf(() => getDutyHolder(STATUTORY_APPROVER_DUTY));
      expect(err.status).toBe(403);
    });
    await withFixtureRole(
      { slug: 'w1k_read_view', grants: [{ resource: 'access_assignments', verbs: ['view'] }] },
      async (reader) => {
        const holder = await withFixtureRole({ slug: 'w1k_read_holder', grants: [] }, async (h) => holdDuty(h.partyId));
        const read = await asPrincipal(authFor(reader), () => getDutyHolder(STATUTORY_APPROVER_DUTY));
        expect(read?.id).toBe(holder.id);
      },
    );
  });

  it('a holder that has not yet started cannot be ended', async () => {
    await withFixtureRole({ slug: 'w1k_future', grants: [] }, async (holder) => {
      const future = new Date(Date.now() + 86_400_000);
      const row = await holdDuty(holder.partyId, future);
      const err = await asUser(CHAIRMAN, () => errorOf(() => endDuty(row.id)));
      expect(err.status).toBe(422);
      expect(err.details?.reasonCode).toBe('duty_not_yet_started');
    });
  });

  it("tenant B cannot see or use tenant A's holder, and may hold its own", async () => {
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'W1K duty tenant B', slug: `w1k-duty-b-${Date.now()}` },
    });
    try {
      await withFixtureRole({ slug: 'w1k_tenant_a', grants: [] }, async (holderA) => {
        await holdDuty(holderA.partyId);

        const bPrincipal: TestPrincipal = {
          tenantId: other.id,
          partyId: 'w1k-tenant-b-person',
          userId: 'w1k-tenant-b-user',
          affiliationId: 'w1k-tenant-b-affiliation',
          roleSlug: 'w1k_tenant_b',
          branch: null,
        };
        const seenByB = await asPrincipal(authFor(bPrincipal), () => resolveDutyHolder(STATUTORY_APPROVER_DUTY));
        expect(seenByB).toBeNull();

        // A's holder is not B's holder, so B may hold the same duty at the same time.
        const bRow = await unscopedPrisma.dutyAssignment.create({
          data: {
            tenantId: other.id,
            dutyKey: STATUTORY_APPROVER_DUTY,
            partyId: 'w1k-tenant-b-person',
            effectiveFrom: PAST,
            assignedBy: 'fixture',
          },
        });
        const holdsB = await asPrincipal(authFor(bPrincipal), () => resolveDutyHolder(STATUTORY_APPROVER_DUTY));
        expect(holdsB?.id).toBe(bRow.id);
        expect(holdsB?.partyId).not.toBe(holderA.partyId);
      });
    } finally {
      await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: other.id } });
    }
  });
});

describe('statutory routes over HTTP (round 27 c)', () => {
  it('the current holder approves through the route: 200 and APPROVED', async () => {
    const draft = await draftRule();
    await withFixtureRole({ slug: 'w1k_http_holder', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);
      const res = await fetch(`${base}/compliance/statutory/rules/${draft.id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await tokenFor(holder)}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; approvedBy: string };
      expect(body.status).toBe('APPROVED');
      expect(body.approvedBy).toBe(holder.partyId);
    });
  });

  it('a principal who is not the holder is refused 403 through the route, and the row stays DRAFT', async () => {
    const draft = await draftRule();
    await withFixtureRole({ slug: 'w1k_http_holder_b', grants: APPROVER_GRANTS }, async (holder) => {
      await holdDuty(holder.partyId);
      await withFixtureRole({ slug: 'w1k_http_other', grants: APPROVER_GRANTS }, async (other) => {
        const res = await fetch(`${base}/compliance/statutory/rules/${draft.id}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await tokenFor(other)}`, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
      });
    });
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
  });
});
