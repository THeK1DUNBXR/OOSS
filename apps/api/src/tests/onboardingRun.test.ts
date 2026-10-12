/**
 * The tenant onboarding run and its transitions (Wave 6 PR10; SPINE-CONTRACT 1.8,
 * item 10; OPUS decisions on the vocabulary, the preconditions and the command).
 *
 * The properties below each have a reason, and each is checked against real
 * Postgres with real contexts:
 *   - the vocabulary is the seven states of TENANT_ONBOARDING_STATES, including
 *     `blocked`, and the table moves along it one step per command;
 *   - a resume returns to the state the run was blocked from, not to the start;
 *   - a command applies one transition and never cascades: the row counts that
 *     satisfy several steps at once still move the run one step per call;
 *   - an unmet precondition is a 422 that names the condition, and writes nothing;
 *   - a move the caller did not read (a stale state, or a concurrent advance) is
 *     a 409 that leaves the run and its history alone;
 *   - a read never writes, so the run and the tenant row are the same after it;
 *   - the backfill maps the JSON status of every tenant onto its run, and any
 *     status that is not a state (or no status at all) onto draft;
 *   - the transition history cannot be updated or deleted, by any role;
 *   - another tenant can neither see nor move a run;
 *   - each advance commits with its audit row and its event, or neither does;
 *   - tenant policy reads onboardingComplete from the run, not from the JSON.
 *
 * The backfill test runs the statement between the BACKFILL markers in the
 * migration itself, so the test and the migration cannot drift apart.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  resolveTenantOnboardingTransition,
  TENANT_ONBOARDING_STATES,
  type TenantOnboardingEvent,
  type TenantOnboardingState,
} from '@kaizen/shared';
import { advanceOnboarding, onboardingState, tenantOnboardingRun } from '../domains/onboarding.js';
import { resolveTenantRuntimePolicy } from '../platform/tenantPolicy.js';
import { asPrincipal, authFor, expectReject, unscopedPrisma, type TestPrincipal } from './helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const MIGRATION = new URL('../../prisma/migrations/20261013140000_onboarding_run/migration.sql', import.meta.url);

const FORWARD: Array<[TenantOnboardingState, TenantOnboardingEvent, TenantOnboardingState]> = [
  ['draft', 'START', 'company_profile'],
  ['company_profile', 'SETUP_COMPANY', 'statutory_configured'],
  ['statutory_configured', 'CONFIGURE_STATUTORY', 'openings_imported'],
  ['openings_imported', 'IMPORT_OPENINGS', 'verified'],
  ['verified', 'VERIFY', 'active'],
  ['active', 'ACTIVATE', 'active'],
];
const NOT_BLOCKED = TENANT_ONBOARDING_STATES.filter((s) => s !== 'blocked');

let seq = 0;
function uniq(): string {
  seq += 1;
  return `${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A tenant of its own, with a role that holds company_profile view and edit, and one human in it. */
async function fixtureTenant(
  config: Record<string, unknown> = {},
): Promise<{ tenantId: string; principal: TestPrincipal }> {
  const slug = `onb-${uniq()}`;
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Onboarding ${slug}`, slug, config: config as never },
  });
  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tenant.id,
      slug,
      name: `Onboarding fixture ${slug}`,
      description: 'Created by onboardingRun.test. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: 'internal',
      isSystem: false,
    },
  });
  await unscopedPrisma.grant.create({
    data: {
      tenantId: tenant.id,
      principalType: 'role',
      roleId: role.id,
      resource: 'company_profile',
      verbs: ['view', 'edit'],
      scope: 'all',
      scopeResolver: null,
    },
  });
  const email = `${slug}@onb.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tenant.id,
      recordCode: `PER-${slug.toUpperCase()}`,
      fullName: slug,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tenant.id,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: slug,
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tenant.id, personId: person.id, email, passwordHash: 'not-a-login', branch: 'Chennai' },
  });
  return {
    tenantId: tenant.id,
    principal: {
      tenantId: tenant.id,
      partyId: person.id,
      userId: user.id,
      affiliationId: affiliation.id,
      roleSlug: slug,
      branch: 'Chennai',
    },
  };
}

/** The rows the six-state preconditions count: a company profile, a ledger account, a committed import. */
async function seedSetUp(tenantId: string, parts: { profile?: boolean; ledger?: boolean; imported?: boolean } = {}) {
  if (parts.profile) await unscopedPrisma.companyProfile.create({ data: { tenantId, legalName: `Co ${uniq()}` } });
  if (parts.ledger) await unscopedPrisma.ledgerAccount.create({ data: { tenantId, name: `Bank ${uniq()}` } });
  if (parts.imported) {
    await unscopedPrisma.importBatch.create({
      data: {
        tenantId,
        recordCode: `IMP-${uniq()}`,
        fileName: 'openings.csv',
        fileSize: 1,
        contentHash: uniq(),
        kind: 'openings',
        sourceFormat: 'csv',
        status: 'committed',
      },
    });
  }
}

/** Every precondition met, so that any forward step is legal and allowed. */
const ALL_SET_UP = { profile: true, ledger: true, imported: true } as const;

function as<T>(p: TestPrincipal, fn: () => Promise<T>): Promise<T> {
  return asPrincipal(authFor(p), fn);
}

async function advance(p: TestPrincipal, event: TenantOnboardingEvent, fromState: TenantOnboardingState) {
  return as(p, () => advanceOnboarding({ event, fromState }));
}

async function runRow(tenantId: string) {
  return unscopedPrisma.tenantOnboardingRun.findUnique({ where: { tenantId } });
}

async function historyOf(tenantId: string) {
  return unscopedPrisma.onboardingTransition.findMany({ where: { tenantId }, orderBy: { at: 'asc' } });
}

/** The statement between the BACKFILL markers, exactly as the migration carries it. */
function backfillStatement(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = /-- BACKFILL-BEGIN[\s\S]*?\n([\s\S]*?)-- BACKFILL-END/.exec(sql);
  if (!block) throw new Error('the migration carries no BACKFILL block');
  return block[1]!;
}

/** Runs the backfill as the owner, which is how a migration runs. */
async function runBackfill(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(backfillStatement());
}

describe('the vocabulary and the transition table', () => {
  it('the run vocabulary is the seven states, blocked included', () => {
    expect([...TENANT_ONBOARDING_STATES]).toEqual([
      'draft',
      'company_profile',
      'statutory_configured',
      'openings_imported',
      'verified',
      'active',
      'blocked',
    ]);
  });

  it.each(FORWARD)('%s --%s--> %s is legal, and that is the only target', (from, event, to) => {
    expect(resolveTenantOnboardingTransition(from, event)).toBe(to);
  });

  it.each(NOT_BLOCKED)('BLOCK is legal from %s, and a blocked run cannot be blocked again', (from) => {
    expect(resolveTenantOnboardingTransition(from, 'BLOCK')).toBe('blocked');
    expect(resolveTenantOnboardingTransition('blocked', 'BLOCK')).toBeUndefined();
  });

  it.each(NOT_BLOCKED)('RESUME from blocked returns to %s, the state the run was blocked from', (from) => {
    expect(resolveTenantOnboardingTransition('blocked', 'RESUME', from)).toBe(from);
  });

  it('a resume with no known origin is refused, and so is a resume from any other state', () => {
    expect(resolveTenantOnboardingTransition('blocked', 'RESUME')).toBeUndefined();
    expect(resolveTenantOnboardingTransition('blocked', 'RESUME', 'blocked')).toBeUndefined();
    expect(resolveTenantOnboardingTransition('draft', 'RESUME', 'verified')).toBeUndefined();
  });

  it.each<[TenantOnboardingState, TenantOnboardingEvent]>([
    ['draft', 'VERIFY'],
    ['draft', 'SETUP_COMPANY'],
    ['company_profile', 'START'],
    ['verified', 'START'],
    ['active', 'START'],
    ['blocked', 'VERIFY'],
  ])('%s --%s is not a move the table allows', (from, event) => {
    expect(resolveTenantOnboardingTransition(from, event)).toBeUndefined();
  });
});

describe('advanceOnboarding', () => {
  it('walks the forward path one transition per call, even when every precondition holds at once', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, ALL_SET_UP);

    expect((await advance(t.principal, 'START', 'draft')).state).toBe('company_profile');
    expect((await advance(t.principal, 'SETUP_COMPANY', 'company_profile')).state).toBe('statutory_configured');
    expect((await advance(t.principal, 'CONFIGURE_STATUTORY', 'statutory_configured')).state).toBe('openings_imported');
    expect((await advance(t.principal, 'IMPORT_OPENINGS', 'openings_imported')).state).toBe('verified');
    const active = await advance(t.principal, 'VERIFY', 'verified');
    expect(active.state).toBe('active');
    expect(active.revision).toBe(5);

    const history = await historyOf(t.tenantId);
    // Five moves: ACTIVATE is the self-loop on active, which a run only takes once it is active.
    expect(history.map((h) => [h.fromState, h.toState])).toEqual(FORWARD.slice(0, 5).map(([from, , to]) => [from, to]));
  });

  it('a precondition that is not met is a 422 naming the condition, and writes no row', async () => {
    const t = await fixtureTenant();
    const err = await expectReject(() => advance(t.principal, 'START', 'draft'));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/company profile/i);
    expect(await runRow(t.tenantId)).toBeNull();
    expect(await historyOf(t.tenantId)).toHaveLength(0);
  });

  it('a step whose precondition is missing names that step, and leaves the run where it was', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, { profile: true });
    await advance(t.principal, 'START', 'draft');
    const err = await expectReject(() => advance(t.principal, 'SETUP_COMPANY', 'company_profile'));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/ledger account/i);
    expect((await runRow(t.tenantId))!.state).toBe('company_profile');
    expect(await historyOf(t.tenantId)).toHaveLength(1);
  });

  it('a move the table does not allow is a 409 and writes nothing', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, ALL_SET_UP);
    const err = await expectReject(() => advance(t.principal, 'VERIFY', 'draft'));
    expect(err.status).toBe(409);
    expect(await runRow(t.tenantId)).toBeNull();
  });

  it('a caller who read a stale state gets a 409, and the run keeps the state it really has', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, ALL_SET_UP);
    await advance(t.principal, 'START', 'draft');
    const err = await expectReject(() => advance(t.principal, 'START', 'draft'));
    expect(err.status).toBe(409);
    const row = await runRow(t.tenantId);
    expect(row!.state).toBe('company_profile');
    expect(row!.revision).toBe(1);
    expect(await historyOf(t.tenantId)).toHaveLength(1);
  });

  it('two concurrent advances from the same state: one wins, the other is a 409', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, ALL_SET_UP);
    await advance(t.principal, 'START', 'draft');

    const results = await Promise.allSettled([
      advance(t.principal, 'SETUP_COMPANY', 'company_profile'),
      advance(t.principal, 'SETUP_COMPANY', 'company_profile'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as { status?: number }).status).toBe(409);
    expect((await runRow(t.tenantId))!.state).toBe('statutory_configured');
    expect(await historyOf(t.tenantId)).toHaveLength(2);
  });

  it('a block records the state it came from, and a resume returns the run to that state, not to the start', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, ALL_SET_UP);
    await advance(t.principal, 'START', 'draft');
    await advance(t.principal, 'SETUP_COMPANY', 'company_profile');
    await advance(t.principal, 'CONFIGURE_STATUTORY', 'statutory_configured');

    expect((await advance(t.principal, 'BLOCK', 'openings_imported')).state).toBe('blocked');
    expect((await as(t.principal, () => tenantOnboardingRun())).blockedFrom).toBe('openings_imported');

    expect((await advance(t.principal, 'RESUME', 'blocked')).state).toBe('openings_imported');
  });
});

describe('a read writes nothing', () => {
  it('the checklist and the run reader leave the run, its history and the tenant row unchanged', async () => {
    const t = await fixtureTenant({ tier: 'starter' });
    await seedSetUp(t.tenantId, ALL_SET_UP);
    await advance(t.principal, 'START', 'draft');

    const snapshot = async () => ({
      run: await runRow(t.tenantId),
      history: (await historyOf(t.tenantId)).length,
      tenant: await unscopedPrisma.tenant.findUnique({ where: { id: t.tenantId } }),
    });
    const before = await snapshot();

    await as(t.principal, () => onboardingState());
    await as(t.principal, () => tenantOnboardingRun());
    await as(t.principal, () => onboardingState());

    expect(await snapshot()).toEqual(before);
  });

  it('a tenant with no run reads as draft, and the read does not create one', async () => {
    const t = await fixtureTenant();
    const view = await as(t.principal, () => tenantOnboardingRun());
    expect(view).toMatchObject({ id: null, state: 'draft', revision: 0, blockedFrom: null });
    expect(await runRow(t.tenantId)).toBeNull();
    await as(t.principal, () => onboardingState());
    expect(await runRow(t.tenantId)).toBeNull();
  });
});

describe('the backfill', () => {
  it('maps every tenant: each of the seven JSON statuses to itself, anything else and no status to draft', async () => {
    const cases: Array<[string, Record<string, unknown>, TenantOnboardingState]> = [
      ...TENANT_ONBOARDING_STATES.map(
        (s) => [s, { onboarding: { status: s } }, s] as [string, Record<string, unknown>, TenantOnboardingState],
      ),
      ['no onboarding key', {}, 'draft'],
      ['a status that is not a state', { onboarding: { status: 'half_done' } }, 'draft'],
    ];
    const made = new Map<string, { id: string; expected: TenantOnboardingState }>();
    for (const [label, config, expected] of cases) {
      const t = await fixtureTenant(config);
      made.set(label, { id: t.tenantId, expected });
    }

    await runBackfill();
    for (const [label, { id, expected }] of made) {
      const row = await runRow(id);
      expect(row, label).not.toBeNull();
      expect(row!.state, label).toBe(expected);
      expect(row!.revision, label).toBe(0);
    }
  });

  it('a second run changes nothing, and no tenant ends up with two runs', async () => {
    const t = await fixtureTenant({ onboarding: { status: 'verified' } });
    await runBackfill();
    const first = await runRow(t.tenantId);
    await runBackfill();
    expect(await runRow(t.tenantId)).toEqual(first);
    expect(await unscopedPrisma.tenantOnboardingRun.count({ where: { tenantId: t.tenantId } })).toBe(1);
  });
});

/**
 * The backfill runs as the migration does, under the application role, which row-level
 * security binds. The owner in CI is a superuser, and a superuser is not bound by FORCE
 * RLS, so a backfill that only works for the owner would pass there and abort
 * `prisma migrate deploy` on a server whose owner is not one. The backfill sets the
 * tenant per pass, as 20261013130000_task_source_kind does; this test is what makes
 * dropping that loop fail.
 */
describe('the backfill under the application role', () => {
  it('writes one run per tenant, with the mapped state, when row-level security binds it', async () => {
    const seeded = [
      { label: 'verified', config: { onboarding: { status: 'verified' } }, expected: 'verified' },
      { label: 'blocked', config: { onboarding: { status: 'blocked' } }, expected: 'blocked' },
      { label: 'no status', config: {}, expected: 'draft' },
    ] as const;
    const made: Array<{ id: string; expected: string; label: string }> = [];
    for (const c of seeded) {
      const t = await fixtureTenant(c.config as Record<string, unknown>);
      made.push({ id: t.tenantId, expected: c.expected, label: c.label });
    }

    class Rollback extends Error {}
    const block = backfillStatement();
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    let observed: Array<{ label: string; rows: Array<{ state: string }> }> = [];
    try {
      const failure = await app
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(block);
          const seen: typeof observed = [];
          for (const m of made) {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${m.id}, true)`;
            const rows = await tx.$queryRaw<Array<{ state: string }>>`
              SELECT "state" FROM "tenant_onboarding_runs" WHERE "tenantId" = ${m.id}`;
            seen.push({ label: m.label, rows });
          }
          observed = seen;
          throw new Rollback();
        })
        .catch((e: unknown) => e);
      if (!(failure instanceof Rollback)) throw failure;
    } finally {
      await app.$disconnect();
    }

    for (const [i, m] of made.entries()) {
      const rows = observed[i]!.rows;
      expect(rows, m.label).toHaveLength(1);
      expect(rows[0]!.state, m.label).toBe(m.expected);
    }
  });
});

describe('the transition history is immutable', () => {
  it('an UPDATE of a transition is refused for every role that owns the table', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, { profile: true });
    await advance(t.principal, 'START', 'draft');
    await expect(
      unscopedPrisma.$executeRaw`UPDATE "onboarding_transitions" SET "reason" = 'rewritten' WHERE "tenantId" = ${t.tenantId}`,
    ).rejects.toThrow(/immutable/i);
  });

  it('a DELETE of a transition is refused for every role that owns the table', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, { profile: true });
    await advance(t.principal, 'START', 'draft');
    await expect(
      unscopedPrisma.$executeRaw`DELETE FROM "onboarding_transitions" WHERE "tenantId" = ${t.tenantId}`,
    ).rejects.toThrow(/immutable/i);
    expect(await historyOf(t.tenantId)).toHaveLength(1);
  });

  it('the application role cannot delete or update a transition at all', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, { profile: true });
    await advance(t.principal, 'START', 'draft');
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.tenantId}, true)`;
          return tx.$executeRaw`DELETE FROM "onboarding_transitions" WHERE "tenantId" = ${t.tenantId}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/i);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.tenantId}, true)`;
          return tx.$executeRaw`UPDATE "onboarding_transitions" SET "reason" = 'x' WHERE "tenantId" = ${t.tenantId}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/i);
    } finally {
      await app.$disconnect();
    }
    expect(await historyOf(t.tenantId)).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it("another tenant reads its own run, not this one's, and cannot move this run", async () => {
    const mine = await fixtureTenant();
    await seedSetUp(mine.tenantId, ALL_SET_UP);
    await advance(mine.principal, 'START', 'draft');
    const intruder = await fixtureTenant();

    expect((await as(intruder.principal, () => tenantOnboardingRun())).state).toBe('draft');
    const err = await expectReject(() => advance(intruder.principal, 'START', 'draft'));
    expect(err.status).toBe(422);
    expect((await runRow(mine.tenantId))!.state).toBe('company_profile');
    expect(await historyOf(intruder.tenantId)).toHaveLength(0);
  });

  it('the application role sees no run or transition of another tenant, because row-level security refuses it', async () => {
    const mine = await fixtureTenant();
    await seedSetUp(mine.tenantId, { profile: true });
    await advance(mine.principal, 'START', 'draft');
    const run = (await runRow(mine.tenantId))!;
    const intruder = await fixtureTenant();

    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      const counts = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${intruder.tenantId}, true)`;
        const runs = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM "tenant_onboarding_runs" WHERE "id" = ${run.id}`;
        const moves = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM "onboarding_transitions" WHERE "runId" = ${run.id}`;
        return [Number(runs[0]!.n), Number(moves[0]!.n)];
      });
      expect(counts).toEqual([0, 0]);
    } finally {
      await app.$disconnect();
    }
  });
});

describe('each advance commits with its audit row and its event', () => {
  it('one audit row and one event, both on the run, for a clean advance', async () => {
    const t = await fixtureTenant();
    await seedSetUp(t.tenantId, { profile: true });
    await advance(t.principal, 'START', 'draft');
    const run = (await runRow(t.tenantId))!;

    const audits = await unscopedPrisma.auditRecord.findMany({
      where: { subjectType: 'tenant_onboarding_run', subjectId: run.id, action: 'update' },
    });
    expect(audits).toHaveLength(1);

    const events = await unscopedPrisma.eventRecord.findMany({
      where: { subjectEntityId: run.id, eventName: 'kz.sys.onboarding.company_profile_recorded' },
    });
    expect(events).toHaveLength(1);
  });

  it('a refused advance writes no audit row and no event', async () => {
    const t = await fixtureTenant();
    await expectReject(() => advance(t.principal, 'START', 'draft'));
    const audits = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: t.tenantId, subjectType: 'tenant_onboarding_run' },
    });
    const events = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: t.tenantId, eventName: { startsWith: 'kz.sys.onboarding.' } },
    });
    expect(audits).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('tenant policy reads onboarding from the run', () => {
  it('a tenant with a run at active is complete, and one with no JSON status and a draft run is not', async () => {
    const done = await fixtureTenant({ onboarding: { status: 'active', step: 'Activated' } });
    const fresh = await fixtureTenant({});
    await runBackfill();

    const doneRun = await as(done.principal, () => tenantOnboardingRun());
    const freshRun = await as(fresh.principal, () => tenantOnboardingRun());
    expect(
      resolveTenantRuntimePolicy({ onboarding: { status: 'active', step: 'Activated' } }, doneRun.state)
        .onboardingComplete,
    ).toBe(true);
    expect(resolveTenantRuntimePolicy({}, freshRun.state).onboardingComplete).toBe(false);
  });

  it('the JSON status alone no longer makes a tenant complete: the run decides', () => {
    expect(
      resolveTenantRuntimePolicy({ onboarding: { status: 'active', step: 'Activated' } }, 'draft').onboardingComplete,
    ).toBe(false);
    expect(resolveTenantRuntimePolicy({ onboardingComplete: true }, 'draft').onboardingComplete).toBe(true);
  });
});
