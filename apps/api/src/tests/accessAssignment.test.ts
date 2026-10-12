/**
 * PR11a: access assignments and their lifecycle (ACCESS-MODEL-PLAN s.2, s.7,
 * s.11; design P11-DESIGN section e, tests 1-9).
 *
 * Real Postgres, real request contexts, no mocks. The commands are called as
 * the people who would call them: HR suggests, the founder confirms, and a
 * refused write is checked against the state it left behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { unscopedPrisma } from '../platform/db.js';
import { can } from '../platform/permissions.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { confirmAssignment, expireAssignment, suggestAssignment } from '../domains/access/assignments.js';
import { asPrincipal, asUser, expectReject, principalFor, tenantId } from './helpers.js';
import {
  authOf,
  grantIndividual,
  makeConfirmedPlacement,
  makeFounderPlacement,
  makeLevel,
  makeLevelLimit,
  makePerson,
  makeResourceBinding,
  makeCapabilityRule,
  makeVertical,
  uniqCode,
  uniqRank,
} from './access/factories.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';
const ACCESS_TABLES = [
  'access_verticals',
  'access_levels',
  'access_level_limits',
  'access_capability_rules',
  'access_resource_bindings',
  'access_assignments',
  'access_placements',
  'access_duties',
] as const;

let tid: string;
let founderId: string;
let hrId: string;
let staffVertical: string;
let staffVerticalId: string;
let otherVertical: string;
let staffLevel: string;
let headLevel: string;
let headLevelId: string;
let app: PrismaClient;

/**
 * HR answers mappings and is the Head of the staff vertical. It holds the
 * access-assignment verbs through individual grants, and no role.
 */
async function makeHr(): Promise<string> {
  const hr = await makePerson(tid, 'HR');
  await grantIndividual(tid, hr.id, 'access_assignments', ['view', 'create', 'edit', 'approve'], 'all');
  await makeConfirmedPlacement(tid, hr.id, staffVerticalId, headLevelId);
  return hr.id;
}

const plc = (verticalCode: string, levelCode: string) => ({ verticalCode, levelCode, unitCode: null });

/** Runs as HR, the person with individual grants above. */
const asHr = <T>(fn: () => Promise<T>) => asPrincipal(authOf(tid, hrId), fn);

beforeAll(async () => {
  tid = await tenantId();
  // A release adds the new resources to ALL_RESOURCES; tenants that already
  // exist get their chairman rows from the same boot path (grantSync.ts).
  await addMissingGrants(tid);
  founderId = (await principalFor(CHAIRMAN)).partyId;
  await makeFounderPlacement(tid, founderId);

  const sv = await makeVertical(tid, 'shared');
  const ov = await makeVertical(tid, 'shared');
  const staff = await makeLevel(tid, 'own');
  const head = await makeLevel(tid, 'vertical');
  staffVerticalId = sv.id;
  staffVertical = sv.code;
  otherVertical = ov.code;
  staffLevel = staff.code;
  headLevelId = head.id;
  headLevel = head.code;
  hrId = await makeHr();

  app = new PrismaClient({ datasourceUrl: APP_URL });
});

afterAll(async () => {
  await app.$disconnect();
});

describe('PR11a suggest', () => {
  it('T1: a suggestion grants nothing', async () => {
    const subject = await makePerson(tid);
    const row = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T1 suggestion',
      }),
    );
    expect(row.status).toBe('suggested');
    expect(await unscopedPrisma.grant.count({ where: { tenantId: tid, principalId: subject.id } })).toBe(0);
    const held = await asPrincipal(authOf(tid, subject.id), () =>
      can({ resource: 'access_assignments', verb: 'view' }),
    );
    expect(held).toBe(false);
  });
});

describe('PR11a confirm', () => {
  it('T2: a person cannot confirm their own assignment (403, state unchanged)', async () => {
    const row = await asHr(() =>
      suggestAssignment({
        personId: founderId,
        identityType: 'founder',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T2 self',
      }),
    );
    const before = await unscopedPrisma.auditRecord.count({
      where: { tenantId: tid, subjectType: 'access_assignment', subjectId: row.id },
    });
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => confirmAssignment({ assignmentId: row.id, reason: 'T2 self check' })),
    );
    expect(err.status).toBe(403);
    const after = await unscopedPrisma.accessAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('suggested');
    expect(after.confirmedById).toBeNull();
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: tid, subjectType: 'access_assignment', subjectId: row.id },
      }),
    ).toBe(before);
  });

  it('T3: the confirmer rules refuse and allow (AMP s.7; design O7, O12)', async () => {
    // a. the answerer may not confirm the mapping they answered
    const subjA = await makePerson(tid);
    const a = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subjA.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T3a',
      }),
    );
    const refusedAnswerer = await asUser(CHAIRMAN, () =>
      expectReject(() => confirmAssignment({ assignmentId: a.id, reason: 'refusal check' })),
    );
    expect(refusedAnswerer.status).toBe(403);

    // b. the Head of a vertical may not confirm a Head placement
    const subjB = await makePerson(tid);
    const b = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subjB.id,
        identityType: 'employee',
        placements: [plc(staffVertical, headLevel)],
        reason: 'T3b',
      }),
    );
    const refusedHead = await asPrincipal(authOf(tid, hrId), () =>
      expectReject(() => confirmAssignment({ assignmentId: b.id, reason: 'refusal check' })),
    );
    expect(refusedHead.status).toBe(403);

    // c. the Head of the vertical confirms a staff placement in it
    const subjC = await makePerson(tid);
    const c = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subjC.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T3c',
      }),
    );
    const confirmed = await asHr(() => confirmAssignment({ assignmentId: c.id, reason: 'staff in own vertical' }));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedById).toBe(hrId);

    // d. the Head of one vertical may not confirm a placement in another
    const subjD = await makePerson(tid);
    const d = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subjD.id,
        identityType: 'employee',
        placements: [plc(otherVertical, staffLevel)],
        reason: 'T3d',
      }),
    );
    const refusedOther = await asHr(() =>
      expectReject(() => confirmAssignment({ assignmentId: d.id, reason: 'refusal check' })),
    );
    expect(refusedOther.status).toBe(403);

    // e. a sensitive duty needs the founder, even inside the Head's vertical
    const subjE = await makePerson(tid);
    const e = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subjE.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        duties: [{ dutyCode: 'approve_payments' }],
        reason: 'T3e',
      }),
    );
    const refusedDuty = await asHr(() =>
      expectReject(() => confirmAssignment({ assignmentId: e.id, reason: 'refusal check' })),
    );
    expect(refusedDuty.status).toBe(403);

    // f. the founder confirms that sensitive duty, answered by HR
    const subjF = await makePerson(tid);
    const f = await asHr(() =>
      suggestAssignment({
        personId: subjF.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        duties: [{ dutyCode: 'approve_payments' }],
        reason: 'T3f',
      }),
    );
    const byFounder = await asUser(CHAIRMAN, () => confirmAssignment({ assignmentId: f.id, reason: 'founder duty' }));
    expect(byFounder.status).toBe('confirmed');
  });

  it('T4: a non-employee needs an expiry no more than twelve months out', async () => {
    const subject = await makePerson(tid);
    const day = 86_400_000;
    const noExpiry = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        suggestAssignment({
          personId: subject.id,
          identityType: 'non_employee',
          placements: [plc(staffVertical, staffLevel)],
          reason: 'T4 none',
        }),
      ),
    );
    expect(noExpiry.status).toBe(422);
    const tooLong = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        suggestAssignment({
          personId: subject.id,
          identityType: 'non_employee',
          placements: [plc(staffVertical, staffLevel)],
          expiresAt: new Date(Date.now() + 400 * day).toISOString(),
          reason: 'T4 too long',
        }),
      ),
    );
    expect(tooLong.status).toBe(422);
    expect(await unscopedPrisma.accessAssignment.count({ where: { tenantId: tid, personId: subject.id } })).toBe(0);
    const ok = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'non_employee',
        placements: [plc(staffVertical, staffLevel)],
        expiresAt: new Date(Date.now() + 330 * day).toISOString(),
        reason: 'T4 within cap',
      }),
    );
    expect(ok.status).toBe('suggested');
  });

  it('T5: expire moves a suggestion to expired, and a second expiry is refused', async () => {
    const subject = await makePerson(tid);
    const row = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T5 withdrawn',
      }),
    );
    const expired = await asUser(CHAIRMAN, () => expireAssignment({ assignmentId: row.id, reason: 'withdrawn' }));
    expect(expired.status).toBe('expired');
    expect(expired.expiredById).toBeTruthy();
    const again = await asUser(CHAIRMAN, () =>
      expectReject(() => expireAssignment({ assignmentId: row.id, reason: 'again' })),
    );
    expect(again.status).toBe(422);
  });
});

describe('PR11a database invariants', () => {
  it('T6: row-level security isolates the eight new tables (the app role)', async () => {
    const other = `tenant-b-${uniqCode('')}`;
    // A row in every table, so the isolation check is not vacuous.
    const v = await makeVertical(tid, 'shared');
    const l = await makeLevel(tid, 'own');
    await makeLevelLimit(tid, l.id, 'approve_payment', 1n);
    await makeCapabilityRule(tid, v.id, l.id, 'access_assignments', ['view']);
    await makeResourceBinding(tid, `leads-${uniqCode('')}`, 'none');
    const placed = await makeConfirmedPlacement(tid, hrId, v.id, l.id);
    await unscopedPrisma.accessDuty.create({
      data: { tenantId: tid, assignmentId: placed.assignmentId, dutyCode: 'approve_payments', sensitive: true },
    });

    for (const table of ACCESS_TABLES) {
      const visible = (t: string) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
          const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`,
            tid,
          );
          return rows[0]!.n;
        });
      expect(await visible(tid), table).toBeGreaterThan(0);
      expect(await visible(other), table).toBe(0);
    }

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${other}, true)`;
        await tx.$executeRaw`INSERT INTO "access_verticals" ("id","tenantId","code","name","kind","updatedAt") VALUES (${`rls-${uniqCode('')}`}, ${tid}, ${uniqCode('V')}, 'x', 'shared', CURRENT_TIMESTAMP)`;
      }),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('T7: CHECK constraints refuse invalid values, whatever writes them', async () => {
    const l = await makeLevel(tid, 'own');
    const v = await makeVertical(tid, 'shared');
    await expect(
      unscopedPrisma.accessLevel.create({
        data: { tenantId: tid, code: uniqCode('B'), name: 'bad', rank: uniqRank(), reach: 'boss' },
      }),
    ).rejects.toThrow();
    await expect(
      unscopedPrisma.accessCapabilityRule.create({
        data: {
          tenantId: tid,
          verticalId: v.id,
          levelId: l.id,
          unitCode: '',
          resource: 'access_assignments',
          verbs: [],
        },
      }),
    ).rejects.toThrow();
    await expect(
      unscopedPrisma.accessResourceBinding.create({
        data: { tenantId: tid, resource: `r-${uniqCode('')}`, bindingKind: 'guess', column: null, verticalId: null },
      }),
    ).rejects.toThrow();
    const subject = await makePerson(tid);
    await expect(
      unscopedPrisma.accessAssignment.create({
        data: {
          tenantId: tid,
          personId: subject.id,
          identityType: 'contractor',
          status: 'suggested',
          suggestedById: hrId,
          reason: 'bad type',
        },
      }),
    ).rejects.toThrow();
    await expect(
      unscopedPrisma.accessAssignment.create({
        data: {
          tenantId: tid,
          personId: subject.id,
          identityType: 'employee',
          status: 'confirmed',
          suggestedById: hrId,
          confirmedById: null,
          confirmedAt: null,
          reason: 'confirmed without a confirmer',
        },
      }),
    ).rejects.toThrow();
  });

  it('T8: a limit is a bigint in paise and survives values past 2^53', async () => {
    const l = await makeLevel(tid, 'own');
    const big = 9_007_199_254_740_993n;
    const created = await makeLevelLimit(tid, l.id, `cls-${uniqCode('')}`, big);
    const read = await unscopedPrisma.accessLevelLimit.findUniqueOrThrow({ where: { id: created.id } });
    expect(typeof read.limitMinor).toBe('bigint');
    expect(read.limitMinor).toBe(big);
  });

  it('T9: every write is audited and emits its event', async () => {
    const subject = await makePerson(tid);
    const row = await asUser(CHAIRMAN, () =>
      suggestAssignment({
        personId: subject.id,
        identityType: 'employee',
        placements: [plc(staffVertical, staffLevel)],
        reason: 'T9 suggestion',
      }),
    );
    await asHr(() => confirmAssignment({ assignmentId: row.id, reason: 'T9 confirm' }));
    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'access_assignment', subjectId: row.id },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'update']);
    const events = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: tid, subjectEntityId: row.id },
      select: { eventName: true },
    });
    expect(events.map((e) => e.eventName).sort()).toEqual([
      'kz.gov.access_assignment.confirmed',
      'kz.gov.access_assignment.suggested',
    ]);
  });
});
