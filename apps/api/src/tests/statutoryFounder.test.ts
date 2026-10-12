/**
 * The founder (owner ruling, 2026-10-12). "The founder (unless changed during onboarding)"
 * holds the statutory approver duty, and "the founder is end all be all, he can do whatever he
 * wants". The owner then accepted an audited exemption. It waives three checks: the author may
 * approve a rule he wrote, the founder may approve without holding the approver duty, and the
 * founder may name himself to a duty. Each waived check is recorded in the audit row's meta as
 * founderOverride.
 *
 * It never waives the citation rule (an UNVERIFIED source is data, not authority), the audit
 * trail, tenant scope, period close or posted-entry immutability. Those are not checks this file
 * can waive, and nothing here reaches them.
 *
 * The founder is the seeded OWNER account's person, found by the seed through the affiliation
 * bootstrap writes. The non-founder cases are fixture principals. Real Postgres, no mocks.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import {
  approveStatutoryRule,
  assignDuty,
  createStatutoryRule,
  endDuty,
  FOUNDER_DUTY,
  isFounder,
  resolveDutyHolder,
  STATUTORY_APPROVER_DUTY,
} from '../domains/statutory.js';
import { seedFounderDuty } from '../seed/compliance/statutory.js';
import { asPrincipal, asUser, authFor, tenantId, withFixtureRole } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const OWNER_ROLE = 'chairman';
const JURISDICTION = 'TEST-W1K-FOUNDER';
const KEY = 'test.founder_rate';
const VERIFIED_SOURCE = 'fixture: obviously fake, W1K founder';
const UNVERIFIED_SOURCE = 'UNVERIFIED: fixture, obviously fake, W1K founder';
const MAKER_GRANTS = [{ resource: 'rate_tables', verbs: ['view', 'edit'] }];
const APPROVER_GRANTS = [{ resource: 'rate_tables', verbs: ['view', 'edit', 'approve'] }];
const ASSIGNER_GRANTS = [{ resource: 'access_assignments', verbs: ['approve'] }];
const PAST = new Date('2026-01-01T00:00:00.000Z');

let tid: string;

function dateOnly(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function clearAll() {
  await unscopedPrisma.statutoryRule.deleteMany({ where: { jurisdiction: JURISDICTION } });
  await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: STATUTORY_APPROVER_DUTY } });
}

/** A tenant with neither duty held: the state a fresh bootstrap starts from. */
/** The seed as bootstrap runs it: the owner's person is the one the owner account is written to. */
async function seedFounder() {
  const owner = await asUser(CHAIRMAN, async (c) => c.partyId);
  return asUser(CHAIRMAN, () => seedFounderDuty(owner, OWNER_ROLE));
}

async function clearBothDuties() {
  await unscopedPrisma.dutyAssignment.deleteMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, STATUTORY_APPROVER_DUTY] } },
  });
}

/** The fixture write the approver duty is held by here: the duty's own grant is tested elsewhere. */
async function holdApproverDirectly(partyId: string) {
  return unscopedPrisma.dutyAssignment.create({
    data: { tenantId: tid, dutyKey: STATUTORY_APPROVER_DUTY, partyId, effectiveFrom: PAST, assignedBy: 'fixture' },
  });
}

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

async function approvalAudit(ruleId: string) {
  const audit = await unscopedPrisma.auditRecord.findMany({
    where: { subjectType: 'statutory_rule', subjectId: ruleId, action: 'update' },
    orderBy: { seq: 'asc' },
  });
  const last = audit.at(-1);
  if (!last) throw new Error('No approval audit row was written.');
  return last;
}

async function createdAudit(subjectType: string, subjectId: string) {
  const row = await unscopedPrisma.auditRecord.findFirst({
    where: { subjectType, subjectId, action: 'create' },
    orderBy: { seq: 'desc' },
  });
  if (!row) throw new Error(`No create audit row for ${subjectType} ${subjectId}.`);
  return row;
}

beforeEach(async () => {
  tid = await tenantId();
  // The founder is in place before each test (the seed assigns it when none is current), and
  // the approver duty is cleared, so each test states the approver it needs.
  await seedFounder();
  await clearAll();
});

afterEach(clearAll);

afterAll(async () => {
  await clearAll();
  await seedFounder();
});

describe('the founder is the owner account, seeded (owner ruling 2026-10-12)', () => {
  it('after the seed, the holders of FOUNDER_DUTY and STATUTORY_APPROVER_DUTY are the OWNER account person', async () => {
    await clearBothDuties();
    await seedFounder();
    const owner = await asUser(CHAIRMAN, async (chairman) => chairman.partyId);
    const founder = await asUser(CHAIRMAN, () => resolveDutyHolder(FOUNDER_DUTY));
    const approver = await asUser(CHAIRMAN, () => resolveDutyHolder(STATUTORY_APPROVER_DUTY));
    expect(founder?.partyId).toBe(owner);
    expect(founder?.assignedBy).toBe('system:statutory-seed');
    expect(approver?.partyId).toBe(owner);
    expect(approver?.assignedBy).toBe('system:statutory-seed');
  });

  it('the seed is idempotent: a second run adds no holder rows', async () => {
    await clearBothDuties();
    await seedFounder();
    await seedFounder();
    const founders = await unscopedPrisma.dutyAssignment.count({
      where: { tenantId: tid, dutyKey: FOUNDER_DUTY, effectiveTo: null },
    });
    const approvers = await unscopedPrisma.dutyAssignment.count({
      where: { tenantId: tid, dutyKey: STATUTORY_APPROVER_DUTY, effectiveTo: null },
    });
    expect(founders).toBe(1);
    expect(approvers).toBe(1);
  });

  it('with no founder, takes the founder from the owner account but leaves an approver onboarding named', async () => {
    await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: FOUNDER_DUTY } });
    await withFixtureRole({ slug: 'w1k_named_later', grants: [] }, async (named) => {
      await holdApproverDirectly(named.partyId);
      await seedFounder();
      const owner = await asUser(CHAIRMAN, async (c) => c.partyId);
      expect((await asUser(CHAIRMAN, () => resolveDutyHolder(FOUNDER_DUTY)))?.partyId).toBe(owner);
      expect((await asUser(CHAIRMAN, () => resolveDutyHolder(STATUTORY_APPROVER_DUTY)))?.partyId).toBe(named.partyId);
    });
  });

  it('isFounder is true for the founder and false for any other principal', async () => {
    expect(await asUser(CHAIRMAN, () => isFounder())).toBe(true);
    await withFixtureRole({ slug: 'w1k_not_founder', grants: [] }, async (other) => {
      expect(await asPrincipal(authFor(other), () => isFounder())).toBe(false);
    });
  });
});

describe('the founder approves a statutory rule', () => {
  it('approves a rule he authored: passes, and the audit meta names the waived check', async () => {
    const owner = await asUser(CHAIRMAN, async (c) => c.partyId);
    await holdApproverDirectly(owner);
    const draft = await asUser(CHAIRMAN, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: JURISDICTION,
        effectiveFrom: dateOnly('2026-04-01'),
        value: 2,
        source: VERIFIED_SOURCE,
      }),
    );
    const approved = await asUser(CHAIRMAN, () => approveStatutoryRule(draft.id));
    expect(approved.status).toBe('APPROVED');
    const meta = (await approvalAudit(draft.id)).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['author_is_approver']);
  });

  it('approves without holding the approver duty: passes, and the audit meta names not_duty_holder', async () => {
    await withFixtureRole({ slug: 'w1k_founder_maker', grants: MAKER_GRANTS }, async (maker) => {
      const draft = await asPrincipal(authFor(maker), () =>
        createStatutoryRule({
          domain: 'test',
          key: KEY,
          jurisdiction: JURISDICTION,
          effectiveFrom: dateOnly('2026-04-01'),
          value: 2,
          source: VERIFIED_SOURCE,
        }),
      );
      const approved = await asUser(CHAIRMAN, () => approveStatutoryRule(draft.id));
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedBy).toBe(await asUser(CHAIRMAN, async (c) => c.partyId));
      const meta = (await approvalAudit(draft.id)).meta as Record<string, unknown>;
      expect(meta.founderOverride).toEqual(['not_duty_holder']);
      // Whoever does hold the duty is not recorded as the approver of a row they never approved.
      expect(meta.approver).toBeNull();
    });
  });

  it('an UNVERIFIED rule with no replacement citation is still refused 422 source_unverified', async () => {
    await withFixtureRole({ slug: 'w1k_founder_unverified', grants: MAKER_GRANTS }, async (maker) => {
      const draft = await asPrincipal(authFor(maker), () =>
        createStatutoryRule({
          domain: 'test',
          key: KEY,
          jurisdiction: JURISDICTION,
          effectiveFrom: dateOnly('2026-04-01'),
          value: 2,
          source: UNVERIFIED_SOURCE,
        }),
      );
      const err = await errorOf(() => asUser(CHAIRMAN, () => approveStatutoryRule(draft.id)));
      expect(err.status).toBe(422);
      expect(err.details?.reasonCode).toBe('source_unverified');
      const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
      expect(after.status).toBe('DRAFT');
    });
  });

  it('a non-founder author approving his own rule is still refused 403', async () => {
    await withFixtureRole({ slug: 'w1k_non_founder_maker', grants: APPROVER_GRANTS }, async (maker) => {
      await holdApproverDirectly(maker.partyId);
      const own = await asPrincipal(authFor(maker), () =>
        createStatutoryRule({
          domain: 'test',
          key: KEY,
          jurisdiction: JURISDICTION,
          effectiveFrom: dateOnly('2026-04-01'),
          value: 2,
          source: VERIFIED_SOURCE,
        }),
      );
      const err = await errorOf(() => asPrincipal(authFor(maker), () => approveStatutoryRule(own.id)));
      expect(err.status).toBe(403);
      const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: own.id } });
      expect(after.status).toBe('DRAFT');
    });
  });
});

describe('assigning and ending duties under the founder rule', () => {
  it('the founder names himself to a duty: passes, and the create audit meta names self_assignment', async () => {
    const owner = await asUser(CHAIRMAN, async (c) => c.partyId);
    const row = await asUser(CHAIRMAN, () => assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId: owner }));
    expect(row.partyId).toBe(owner);
    const meta = (await createdAudit('duty_assignment', row.id)).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['self_assignment']);
  });

  it('a non-founder who names himself to a duty is still refused 403', async () => {
    await withFixtureRole({ slug: 'w1k_self_namer', grants: ASSIGNER_GRANTS }, async (self) => {
      const err = await errorOf(() =>
        asPrincipal(authFor(self), () => assignDuty({ dutyKey: STATUTORY_APPROVER_DUTY, partyId: self.partyId })),
      );
      expect(err.status).toBe(403);
      expect(err.details?.reasonCode).toBe('duty_self_assignment');
    });
  });

  it('a non-founder with access_assignments approve cannot assign FOUNDER_DUTY: 403', async () => {
    await withFixtureRole({ slug: 'w1k_assigner', grants: ASSIGNER_GRANTS }, async (assigner) => {
      await withFixtureRole({ slug: 'w1k_would_be_founder', grants: [] }, async (other) => {
        const err = await errorOf(() =>
          asPrincipal(authFor(assigner), () => assignDuty({ dutyKey: FOUNDER_DUTY, partyId: other.partyId })),
        );
        expect(err.status).toBe(403);
        expect(err.details?.reasonCode).toBe('founder_only');
      });
    });
    const holders = await unscopedPrisma.dutyAssignment.count({
      where: { tenantId: tid, dutyKey: FOUNDER_DUTY, effectiveTo: null },
    });
    expect(holders).toBe(1);
  });

  it('a non-founder with access_assignments approve cannot end FOUNDER_DUTY: 403, and the founder stands', async () => {
    const founderRow = await asUser(CHAIRMAN, () => resolveDutyHolder(FOUNDER_DUTY));
    expect(founderRow).not.toBeNull();
    await withFixtureRole({ slug: 'w1k_ender', grants: ASSIGNER_GRANTS }, async (ender) => {
      const err = await errorOf(() => asPrincipal(authFor(ender), () => endDuty(founderRow!.id)));
      expect(err.status).toBe(403);
      expect(err.details?.reasonCode).toBe('founder_only');
    });
    const still = await asUser(CHAIRMAN, () => resolveDutyHolder(FOUNDER_DUTY));
    expect(still?.id).toBe(founderRow!.id);
  });

  it('with no founder in the tenant, assigning FOUNDER_DUTY is refused 422 founder_not_set', async () => {
    await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: FOUNDER_DUTY } });
    await withFixtureRole({ slug: 'w1k_no_founder_target', grants: [] }, async (target) => {
      const err = await errorOf(() =>
        asUser(CHAIRMAN, () => assignDuty({ dutyKey: FOUNDER_DUTY, partyId: target.partyId })),
      );
      expect(err.status).toBe(422);
      expect(err.details?.reasonCode).toBe('founder_not_set');
    });
  });
});
