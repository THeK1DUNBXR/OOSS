/**
 * PR12: separation of duties at confirm, and the founder's recorded override
 * (ACCESS-MODEL-PLAN s.8; P11-DESIGN section e, tests 1-5 and section f O11).
 *
 * Real Postgres, real request contexts, no mocks. Grants that form a blocked pair
 * are written as data through the factories, and the confirm under test is the
 * command the founder would run. The refusal is checked against the state it
 * left behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BUILT_IN_SOD_PAIRS, type SodPair } from '@kaizen/shared';
import { unscopedPrisma } from '../platform/db.js';
import { ALL_RESOURCES } from '../seed/grants.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { confirmAssignment, suggestAssignment } from '../domains/access/assignments.js';
import { recordSodOverride, sodFindings } from '../domains/access/sod.js';
import { founderView } from '../domains/founderView.js';
import { asPrincipal, asUser, expectReject, principalFor, tenantId } from './helpers.js';
import {
  authOf,
  grantIndividual,
  makeCapabilityRule,
  makeConfirmedPlacement,
  makeFounderPlacement,
  makeLevel,
  makePerson,
  makeVertical,
  uniqCode,
} from './access/factories.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';

let tid: string;
let founderId: string;
let hrId: string;
let staffVertical: string;
let staffLevel: string;
let app: PrismaClient;

/** HR answers mappings. It holds the access verbs through individual grants and no role. */
async function makeHr(): Promise<string> {
  const hr = await makePerson(tid, 'HR');
  await grantIndividual(tid, hr.id, 'access_assignments', ['view', 'create', 'edit', 'approve'], 'all');
  const head = await makeLevel(tid, 'vertical');
  const sv = await makeVertical(tid, 'shared');
  await makeConfirmedPlacement(tid, hr.id, sv.id, head.id);
  return hr.id;
}

const plc = (verticalCode: string, levelCode: string) => ({ verticalCode, levelCode, unitCode: null });
const asHr = <T>(fn: () => Promise<T>) => asPrincipal(authOf(tid, hrId), fn);
const asFounder = <T>(fn: () => Promise<T>) => asUser(CHAIRMAN, async () => fn());

/** The first verb of each side of a built-in pair: the minimal grant pair that forms it. */
function minimalGrants(pair: SodPair): { resource: string; verb: string }[] {
  return [
    { resource: pair.a.resource, verb: pair.a.verbs[0]! },
    { resource: pair.b.resource, verb: pair.b.verbs[0]! },
  ];
}

/** A suggestion for a fresh person at the staff vertical, answered by HR. */
async function suggestFor(personId: string, reason = 'PR12 suite') {
  return asHr(() =>
    suggestAssignment({
      personId,
      identityType: 'employee',
      placements: [plc(staffVertical, staffLevel)],
      reason,
    }),
  );
}

async function overrideCount(assignmentId: string): Promise<number> {
  return unscopedPrisma.accessSodOverride.count({ where: { tenantId: tid, assignmentId } });
}

beforeAll(async () => {
  tid = await tenantId();
  await addMissingGrants(tid);
  founderId = (await principalFor(CHAIRMAN)).partyId;
  await makeFounderPlacement(tid, founderId);

  const sv = await makeVertical(tid, 'shared');
  const staff = await makeLevel(tid, 'own');
  staffVertical = sv.code;
  staffLevel = staff.code;
  hrId = await makeHr();

  app = new PrismaClient({ datasourceUrl: APP_URL });
});

afterAll(async () => {
  await app.$disconnect();
});

describe('PR12 built-in pairs (vocabulary)', () => {
  it('the four owner-confirmed pairs are present, with stable snake_case codes', () => {
    expect(BUILT_IN_SOD_PAIRS.map((p) => p.pairCode).sort()).toEqual(
      [
        'access_manage_approve',
        'payment_create_approve',
        'payroll_run_approve',
        'statutory_rule_change_signoff',
      ].sort(),
    );
  });

  it('every pair side names a resource that is in the seed ALL_RESOURCES, so a typo cannot pass silently', () => {
    const known = new Set<string>(ALL_RESOURCES);
    for (const pair of BUILT_IN_SOD_PAIRS) {
      expect(known.has(pair.a.resource), `${pair.pairCode} side a`).toBe(true);
      expect(known.has(pair.b.resource), `${pair.pairCode} side b`).toBe(true);
      expect(pair.a.verbs.length, `${pair.pairCode} side a verbs`).toBeGreaterThan(0);
      expect(pair.b.verbs.length, `${pair.pairCode} side b verbs`).toBeGreaterThan(0);
    }
  });
});

describe('PR12 sodFindings (pure)', () => {
  const granted = (rows: [string, string][]) => rows.map(([resource, verb]) => ({ resource, verb: verb as never }));

  it('a pair fires only when both sides are held', () => {
    const payroll = BUILT_IN_SOD_PAIRS.find((p) => p.pairCode === 'payroll_run_approve')!;
    expect(sodFindings([payroll], granted([['payroll', 'edit']]))).toEqual([]);
    expect(
      sodFindings(
        [payroll],
        granted([
          ['payroll', 'edit'],
          ['payroll', 'approve'],
        ]),
      ),
    ).toEqual([{ pairCode: 'payroll_run_approve' }]);
  });

  it('a side matches when the person holds ANY of its verbs', () => {
    const access = BUILT_IN_SOD_PAIRS.find((p) => p.pairCode === 'access_manage_approve')!;
    expect(
      sodFindings(
        [access],
        granted([
          ['access_model', 'edit'],
          ['access_assignments', 'approve'],
        ]),
      ),
    ).toEqual([{ pairCode: 'access_manage_approve' }]);
    expect(
      sodFindings(
        [access],
        granted([
          ['access_model', 'view'],
          ['access_assignments', 'approve'],
        ]),
      ),
    ).toEqual([]);
  });

  it('the same verb on a different resource does not form a pair', () => {
    const statutory = BUILT_IN_SOD_PAIRS.find((p) => p.pairCode === 'statutory_rule_change_signoff')!;
    expect(
      sodFindings(
        [statutory],
        granted([
          ['rate_tables', 'edit'],
          ['payroll', 'approve'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('PR12 confirm refuses a blocked pair', () => {
  it.each(BUILT_IN_SOD_PAIRS.map((p) => [p.pairCode, p] as const))(
    '%s is refused at confirm with 409, naming the pair, and the status is unchanged',
    async (pairCode, pair) => {
      const subject = await makePerson(tid);
      for (const g of minimalGrants(pair)) await grantIndividual(tid, subject.id, g.resource, [g.verb]);
      const row = await suggestFor(subject.id, `PR12 ${pairCode}`);

      const err = await asFounder(() =>
        expectReject(() => confirmAssignment({ assignmentId: row.id, reason: 'pair' })),
      );
      expect(err.status).toBe(409);
      expect(err.message).toContain(pairCode);

      const after = await unscopedPrisma.accessAssignment.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe('suggested');
      expect(after.confirmedById).toBeNull();
    },
  );

  it('a legacy-role grant plus a compiled grant forming a pair is refused', async () => {
    const roleSlug = `sod_legacy_${uniqCode('').toLowerCase()}`;
    const role = await unscopedPrisma.accessRole.create({
      data: { tenantId: tid, slug: roleSlug, name: 'PR12 legacy role' },
      select: { id: true },
    });
    await unscopedPrisma.grant.create({
      data: {
        tenantId: tid,
        principalType: 'role',
        roleId: role.id,
        resource: 'payments',
        verbs: ['create'],
        scope: 'all',
      },
    });
    const subject = await makePerson(tid);
    await unscopedPrisma.affiliation.create({
      data: { tenantId: tid, partyId: subject.id, affiliationType: 'employee', roleSlug, status: 'active' },
    });
    // A vertical and level of its own, so the rule does not reach the other tests' placements.
    // Its rule compiles to payments:approve on confirm: the other half of the pair.
    const ownVertical = await makeVertical(tid, 'shared');
    const ownLevel = await makeLevel(tid, 'own');
    await makeCapabilityRule(tid, ownVertical.id, ownLevel.id, 'payments', ['approve']);

    const row = await asHr(() =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(ownVertical.code, ownLevel.code)],
        reason: 'PR12 legacy plus compiled',
      }),
    );
    const err = await asFounder(() => expectReject(() => confirmAssignment({ assignmentId: row.id, reason: 'mixed' })));
    expect(err.status).toBe(409);
    expect(err.message).toContain('payment_create_approve');
    const after = await unscopedPrisma.accessAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('suggested');
  });
});

describe('PR12 founder override', () => {
  it('an override without a reason is refused, and nothing is written', async () => {
    const subject = await makePerson(tid);
    for (const g of minimalGrants(BUILT_IN_SOD_PAIRS[0]!)) await grantIndividual(tid, subject.id, g.resource, [g.verb]);
    const row = await suggestFor(subject.id, 'PR12 blank reason');

    for (const reason of ['', '   ']) {
      const err = await asFounder(() =>
        expectReject(() => recordSodOverride({ assignmentId: row.id, pairCode: 'payment_create_approve', reason })),
      );
      expect(err.status).toBe(400);
    }
    expect(await overrideCount(row.id)).toBe(0);
  });

  it('an override by a non-founder returns 403, and nothing changes', async () => {
    const subject = await makePerson(tid);
    for (const g of minimalGrants(BUILT_IN_SOD_PAIRS[0]!)) await grantIndividual(tid, subject.id, g.resource, [g.verb]);
    const row = await suggestFor(subject.id, 'PR12 non-founder override');

    const err = await asHr(() =>
      expectReject(() =>
        recordSodOverride({ assignmentId: row.id, pairCode: 'payment_create_approve', reason: 'HR tries it' }),
      ),
    );
    expect(err.status).toBe(403);
    expect(await overrideCount(row.id)).toBe(0);
    const exceptions = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, subjectType: 'access_assignment', subjectId: row.id },
    });
    expect(exceptions).toBe(0);
  });

  it('an override is audited, emitted, and its exception appears in the founder view', async () => {
    const subject = await makePerson(tid);
    for (const g of minimalGrants(BUILT_IN_SOD_PAIRS[0]!)) await grantIndividual(tid, subject.id, g.resource, [g.verb]);
    const row = await suggestFor(subject.id, 'PR12 audited override');

    const override = await asFounder(() =>
      recordSodOverride({
        assignmentId: row.id,
        pairCode: 'payment_create_approve',
        reason: 'Two-person team; founder is the only approver today',
      }),
    );
    expect(override.exceptionId).toBeTruthy();
    expect(override.pairCode).toBe('payment_create_approve');

    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: tid, subjectType: 'access_sod_override', subjectId: override.id, action: 'create' },
    });
    expect(JSON.stringify(audit.diff)).toContain('Two-person team');

    const event = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: tid, eventName: 'kz.gov.access_sod_override.recorded', subjectEntityId: override.id },
    });
    expect(event.subjectEntityType).toBe('access_sod_override');

    // The view reads the oldest 50 open exceptions (founderView.ts ROW_CAP). Other runs leave older
    // open items in this tenant, so the fixture row sorts first, as founderView.test.ts does (FV-002).
    await unscopedPrisma.exceptionRecord.update({
      where: { id: override.exceptionId! },
      data: { raisedAt: new Date('2001-01-01T00:00:00Z') },
    });
    const view = await asFounder(() => founderView());
    const exception = view.rows.find((r) => r.sourceKind === 'exception' && r.sourceId === override.exceptionId);
    expect(exception).toBeDefined();
  });

  it('the founder cannot override a pair on their own assignment: 403, and nothing is written', async () => {
    // The founder is the subject here. Nobody accepts their own overlap, as nobody confirms their own access.
    const row = await asFounder(() =>
      suggestAssignment({
        personId: founderId,
        identityType: 'founder',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'PR12 self-override',
      }),
    );
    const auditBefore = await unscopedPrisma.auditRecord.count({
      where: { tenantId: tid, subjectType: 'access_sod_override' },
    });
    const eventsBefore = await unscopedPrisma.eventRecord.count({
      where: { tenantId: tid, eventName: 'kz.gov.access_sod_override.recorded' },
    });

    const err = await asFounder(() =>
      expectReject(() =>
        recordSodOverride({ assignmentId: row.id, pairCode: 'payment_create_approve', reason: 'my own overlap' }),
      ),
    );
    expect(err.status).toBe(403);
    expect(await overrideCount(row.id)).toBe(0);
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: tid, subjectType: 'access_assignment', subjectId: row.id },
      }),
    ).toBe(0);
    expect(
      await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectType: 'access_sod_override' } }),
    ).toBe(auditBefore);
    expect(
      await unscopedPrisma.eventRecord.count({
        where: { tenantId: tid, eventName: 'kz.gov.access_sod_override.recorded' },
      }),
    ).toBe(eventsBefore);
  });

  it('a confirm with an override passes, for the overridden pair only', async () => {
    const subject = await makePerson(tid);
    // Two pairs: payments create+approve, and payroll edit+approve.
    await grantIndividual(tid, subject.id, 'payments', ['create']);
    await grantIndividual(tid, subject.id, 'payments', ['approve']);
    await grantIndividual(tid, subject.id, 'payroll', ['edit']);
    await grantIndividual(tid, subject.id, 'payroll', ['approve']);
    const row = await suggestFor(subject.id, 'PR12 override then confirm');

    await asFounder(() =>
      recordSodOverride({
        assignmentId: row.id,
        pairCode: 'payment_create_approve',
        reason: 'Accepted for the small team',
      }),
    );

    // The payroll pair is not overridden, so the confirm still refuses, and names only that pair.
    const err = await asFounder(() =>
      expectReject(() => confirmAssignment({ assignmentId: row.id, reason: 'partial' })),
    );
    expect(err.status).toBe(409);
    expect(err.message).toContain('payroll_run_approve');
    expect(err.message).not.toContain('payment_create_approve');

    await asFounder(() =>
      recordSodOverride({ assignmentId: row.id, pairCode: 'payroll_run_approve', reason: 'Founder runs both halves' }),
    );
    const confirmed = await asFounder(() => confirmAssignment({ assignmentId: row.id, reason: 'all overridden' }));
    expect(confirmed.status).toBe('confirmed');
  });
});

describe('PR12 RLS isolation for access_sod_overrides', () => {
  it('rows are visible only inside their own tenant, and a cross-tenant insert is refused', async () => {
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'PR12 other tenant', slug: `pr12-x-${uniqCode('').toLowerCase()}` },
    });
    const subject = await makePerson(tid);
    for (const g of minimalGrants(BUILT_IN_SOD_PAIRS[0]!)) await grantIndividual(tid, subject.id, g.resource, [g.verb]);
    const row = await suggestFor(subject.id, 'PR12 rls');
    await asFounder(() =>
      recordSodOverride({ assignmentId: row.id, pairCode: 'payment_create_approve', reason: 'RLS fixture' }),
    );

    const visible = (t: string) =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
        const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "access_sod_overrides" WHERE "tenantId" = $1`,
          tid,
        );
        return rows[0]!.n;
      });
    expect(await visible(tid)).toBeGreaterThan(0);
    expect(await visible(other.id)).toBe(0);

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${other.id}, true)`;
        await tx.$executeRaw`INSERT INTO "access_sod_overrides" ("id","tenantId","assignmentId","pairCode","reason","overriddenById","overriddenAt") VALUES (${`rls-${uniqCode('')}`}, ${tid}, ${row.id}, 'payment_create_approve', 'x', ${founderId}, CURRENT_TIMESTAMP)`;
      }),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});
