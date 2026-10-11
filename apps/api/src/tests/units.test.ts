/**
 * Business-line units (Zen 360 Phase 0 Wave 6, PR 1; SPINE-CONTRACT s.1.0 and
 * Opus decision 12). A unit is a dated row. It moves between business lines by
 * closing its row and opening another, never by editing lineId.
 *
 * Real Postgres, real contexts, no mocks. The database refusals are asserted
 * against raw writes as well as the governed writers, so a future writer that
 * skips the domain still meets them.
 *
 * Every date is an IST calendar day stored as UTC midnight (CLAUDE.md rule 3).
 * The one test that depends on the clock fakes only `Date`, so the boundary is
 * exact.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { unscopedPrisma } from '../platform/db.js';
import { isGoverned } from '../platform/audit.js';
import { createBusinessLine, retireBusinessLine } from '../domains/businessLines.js';
import { closeUnit, listUnits, moveUnit, openUnit } from '../domains/units.js';
import { asUser, expectReject, tenantId } from './helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';
const EMPLOYEE = 'employee@kaizen.co.in';

/** A `@db.Date` value for an IST calendar day. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Unit codes are keys across every version of a unit. A random suffix keeps reruns apart. */
function uniqueCode(): string {
  const rand = Math.random()
    .toString(36)
    .slice(2, 9)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X');
  return `U${rand}`;
}

let tid: string;
const createdLineIds: string[] = [];
const createdUnitCodes: string[] = [];
const createdTenantIds: string[] = [];

async function line(overrides: { effectiveFrom?: string } = {}) {
  const row = await asUser(CHAIRMAN, () =>
    createBusinessLine({
      code: `L${uniqueCode().slice(1)}`,
      name: 'Unit test line',
      payerKind: 'test_payer',
      revenueModel: 'test_model',
      effectiveFrom: overrides.effectiveFrom ?? '2030-01-01',
      reason: 'fixture',
    }),
  );
  createdLineIds.push(row.id);
  return row;
}

async function unit(overrides: { code?: string; lineId?: string | null; parentUnitId?: string | null; effectiveFrom?: string } = {}) {
  const code = overrides.code ?? uniqueCode();
  const row = await asUser(CHAIRMAN, () =>
    openUnit({
      code,
      name: 'Test unit',
      lineId: overrides.lineId ?? null,
      parentUnitId: overrides.parentUnitId ?? null,
      effectiveFrom: overrides.effectiveFrom ?? '2030-01-01',
      reason: 'fixture',
    }),
  );
  createdUnitCodes.push(code);
  return row;
}

beforeAll(async () => {
  tid = await tenantId();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  // A unit names its line and its parent, so the rows go first, children before
  // parents, and the lines after. Nothing in the audit or event tables is removed.
  for (let pass = 0; pass < 6; pass++) {
    await unscopedPrisma.unit.deleteMany({
      where: { code: { in: createdUnitCodes }, children: { none: {} } },
    });
  }
  for (const id of createdTenantIds) await unscopedPrisma.tenant.deleteMany({ where: { id } });
  await unscopedPrisma.businessLine.deleteMany({ where: { id: { in: createdLineIds } } });
});

describe('Unit: opening, listing and the end date', () => {
  it('lists a unit under a line in force on its day, and not before its start', async () => {
    const l = await line({ effectiveFrom: '2030-01-01' });
    const u = await unit({ lineId: l.id, effectiveFrom: '2030-01-01' });
    const onStart = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-01-01' }));
    expect(onStart.map((r) => r.id)).toContain(u.id);
    const before = await asUser(CHAIRMAN, () => listUnits({ asOf: '2029-12-31' }));
    expect(before.map((r) => r.id)).not.toContain(u.id);
  });

  it('refuses a unit under a line that is retired on its effective day, and writes no row', async () => {
    const l = await line({ effectiveFrom: '2030-01-01' });
    await asUser(CHAIRMAN, () => retireBusinessLine({ id: l.id, effectiveTo: '2031-01-01', reason: 'exit' }));
    const code = uniqueCode();
    const onRetirement = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        openUnit({ code, name: 'Closed line', lineId: l.id, effectiveFrom: '2031-01-01', reason: 'fixture' }),
      ),
    );
    expect(onRetirement.status).toBe(409);
    const later = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        openUnit({ code, name: 'Closed line', lineId: l.id, effectiveFrom: '2031-06-01', reason: 'fixture' }),
      ),
    );
    expect(later.status).toBe(409);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code } })).toBe(0);
  });

  it('refuses a code already used, retired rows included', async () => {
    const code = uniqueCode();
    await unit({ code });
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        openUnit({ code, name: 'Reuse', lineId: null, effectiveFrom: '2030-03-01', reason: 'fixture' }),
      ),
    );
    expect(err.status).toBe(409);
  });

  it('treats effectiveTo as exclusive: closed on D it is not listed asOf D, and is listed asOf D-1', async () => {
    const u = await unit({ effectiveFrom: '2030-01-01' });
    await asUser(CHAIRMAN, () => closeUnit({ id: u.id, effectiveTo: '2030-06-30', reason: 'wound down' }));
    const onD = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-06-30' }));
    expect(onD.map((r) => r.id)).not.toContain(u.id);
    const dayBefore = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-06-29' }));
    expect(dayBefore.map((r) => r.id)).toContain(u.id);
  });

  it('refuses a close on or before the day the unit starts, and a backdated close', async () => {
    const u = await unit({ effectiveFrom: '2030-02-01' });
    const onStart = await expectReject(() =>
      asUser(CHAIRMAN, () => closeUnit({ id: u.id, effectiveTo: '2030-02-01', reason: 'fixture' })),
    );
    expect(onStart.status).toBe(400);
    // Started in the past, so only the no-backdating rule can refuse a close in the past.
    const old = await unit({ effectiveFrom: '2026-01-01' });
    const backdated = await expectReject(() =>
      asUser(CHAIRMAN, () => closeUnit({ id: old.id, effectiveTo: '2026-02-01', reason: 'fixture' })),
    );
    expect(backdated.status).toBe(400);
    expect(backdated.message).toMatch(/backdated/);
    const row = await unscopedPrisma.unit.findFirst({ where: { id: u.id } });
    expect(row?.effectiveTo).toBeNull();
  });
});

describe('Unit: moving between lines closes one row and opens another', () => {
  it('leaves the old row on its line and opens the new row on the new line, under the same code', async () => {
    const from = await line({ effectiveFrom: '2030-01-01' });
    const to = await line({ effectiveFrom: '2030-01-01' });
    const u = await unit({ lineId: from.id, effectiveFrom: '2030-01-01' });
    const { closed, opened } = await asUser(CHAIRMAN, () =>
      moveUnit({ id: u.id, toLineId: to.id, effectiveFrom: '2030-07-01', reason: 'realignment' }),
    );
    expect(closed.id).toBe(u.id);
    expect(closed.effectiveTo?.toISOString()).toBe('2030-07-01T00:00:00.000Z');
    expect(closed.status).toBe('closed');
    expect(opened.code).toBe(u.code);
    expect(opened.lineId).toBe(to.id);
    expect(opened.effectiveFrom.toISOString()).toBe('2030-07-01T00:00:00.000Z');
    expect(opened.effectiveTo).toBeNull();
    expect(opened.status).toBe('active');
    const oldRow = await unscopedPrisma.unit.findFirst({ where: { id: u.id } });
    expect(oldRow?.lineId).toBe(from.id);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code: u.code } })).toBe(2);
  });

  it('answers the move for the day with the new line, and the old line before it', async () => {
    const from = await line({ effectiveFrom: '2030-01-01' });
    const to = await line({ effectiveFrom: '2030-01-01' });
    const u = await unit({ lineId: from.id, effectiveFrom: '2030-01-01' });
    const { opened } = await asUser(CHAIRMAN, () =>
      moveUnit({ id: u.id, toLineId: to.id, effectiveFrom: '2030-07-01', reason: 'realignment' }),
    );
    const before = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-06-30' }));
    expect(before.filter((r) => r.code === u.code).map((r) => r.lineId)).toEqual([from.id]);
    const after = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-07-01' }));
    expect(after.filter((r) => r.code === u.code).map((r) => r.id)).toEqual([opened.id]);
  });

  it('refuses a move onto a line retired on the move day, and leaves the unit where it was', async () => {
    const from = await line({ effectiveFrom: '2030-01-01' });
    const to = await line({ effectiveFrom: '2030-01-01' });
    await asUser(CHAIRMAN, () => retireBusinessLine({ id: to.id, effectiveTo: '2030-09-01', reason: 'exit' }));
    const u = await unit({ lineId: from.id, effectiveFrom: '2030-01-01' });
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () => moveUnit({ id: u.id, toLineId: to.id, effectiveFrom: '2030-09-01', reason: 'late' })),
    );
    expect(err.status).toBe(409);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code: u.code } })).toBe(1);
    const row = await unscopedPrisma.unit.findFirst({ where: { id: u.id } });
    expect(row?.effectiveTo).toBeNull();
  });
});

describe('Unit: immutability at the database', () => {
  it('refuses a raw UPDATE of lineId, code, tenantId, id and effectiveFrom, whatever the writer', async () => {
    const l = await line();
    const u = await unit({ lineId: l.id });
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET "lineId" = ${null} WHERE id = ${u.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET code = ${'ZZZZZ'} WHERE id = ${u.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET "tenantId" = ${'other'} WHERE id = ${u.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET id = ${'moved-' + u.id} WHERE id = ${u.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET "effectiveFrom" = ${day('2029-01-01')} WHERE id = ${u.id}`,
    ).rejects.toThrow(/immutable/);
    const still = await unscopedPrisma.unit.findFirst({ where: { id: u.id } });
    expect(still?.lineId).toBe(l.id);
  });

  it('refuses a closed status without an end date, at the database', async () => {
    const u = await unit();
    await expect(
      unscopedPrisma.$executeRaw`UPDATE units SET status = 'closed' WHERE id = ${u.id}`,
    ).rejects.toThrow(/units_status_end_agree|check constraint/);
  });

  it('refuses a DELETE from the application role', async () => {
    const u = await unit();
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
          await tx.$executeRaw`DELETE FROM "units" WHERE "id" = ${u.id}`;
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }
    expect(await unscopedPrisma.unit.count({ where: { id: u.id } })).toBe(1);
  });
});

describe('Unit: parent cycles are refused', () => {
  it('refuses a move that would make a unit its own ancestor, and a unit as its own parent', async () => {
    const a = await unit({ effectiveFrom: '2030-01-01' });
    const b = await unit({ parentUnitId: a.id, effectiveFrom: '2030-01-01' });
    // A under B, while B already sits under A: a loop across versions of the code.
    const loop = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        moveUnit({ id: a.id, toLineId: null, parentUnitId: b.id, effectiveFrom: '2030-02-01', reason: 'loop' }),
      ),
    );
    expect(loop.status).toBe(400);
    const self = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        moveUnit({ id: a.id, toLineId: null, parentUnitId: a.id, effectiveFrom: '2030-02-01', reason: 'self' }),
      ),
    );
    expect(self.status).toBe(400);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code: a.code } })).toBe(1);
    const bRow = await unscopedPrisma.unit.findFirst({ where: { id: b.id } });
    expect(bRow?.parentUnitId).toBe(a.id);
  });
});

describe('Unit: permission, audit and events', () => {
  it('refuses open, close and move by a principal without org_design, with state unchanged', async () => {
    const u = await unit({ effectiveFrom: '2030-01-01' });
    const auditBefore = await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectType: 'unit' } });
    const code = uniqueCode();
    const opened = await expectReject(() =>
      asUser(EMPLOYEE, () => openUnit({ code, name: 'Refused', lineId: null, effectiveFrom: '2030-01-01', reason: 'x' })),
    );
    expect(opened.status).toBe(403);
    const closed = await expectReject(() =>
      asUser(EMPLOYEE, () => closeUnit({ id: u.id, effectiveTo: '2030-06-30', reason: 'x' })),
    );
    expect(closed.status).toBe(403);
    const moved = await expectReject(() =>
      asUser(EMPLOYEE, () => moveUnit({ id: u.id, toLineId: null, effectiveFrom: '2030-06-30', reason: 'x' })),
    );
    expect(moved.status).toBe(403);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code } })).toBe(0);
    expect(await unscopedPrisma.unit.count({ where: { tenantId: tid, code: u.code } })).toBe(1);
    const row = await unscopedPrisma.unit.findFirst({ where: { id: u.id } });
    expect(row?.effectiveTo).toBeNull();
    expect(await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectType: 'unit' } })).toBe(auditBefore);
  });

  it('registers the unit subject type and writes an audit row and a kz.org event for each step', async () => {
    expect(isGoverned('unit')).toBe(true);
    const l = await line();
    const to = await line();
    const u = await unit({ lineId: l.id, effectiveFrom: '2030-01-01' });
    const created = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: tid, subjectType: 'unit', subjectId: u.id, action: 'create' },
    });
    expect(created).not.toBeNull();
    const opened = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.unit.opened', subjectEntityId: u.id },
    });
    expect(opened).not.toBeNull();

    await asUser(CHAIRMAN, () => closeUnit({ id: u.id, effectiveTo: '2030-05-01', reason: 'wound down' }));
    expect(
      await unscopedPrisma.auditRecord.findFirst({
        where: { tenantId: tid, subjectType: 'unit', subjectId: u.id, action: 'update' },
      }),
    ).not.toBeNull();
    expect(
      await unscopedPrisma.eventRecord.findFirst({
        where: { tenantId: tid, eventName: 'kz.org.unit.closed', subjectEntityId: u.id },
      }),
    ).not.toBeNull();

    const v = await unit({ lineId: l.id, effectiveFrom: '2030-01-01' });
    const { opened: next } = await asUser(CHAIRMAN, () =>
      moveUnit({ id: v.id, toLineId: to.id, effectiveFrom: '2030-08-01', reason: 'realignment' }),
    );
    expect(
      await unscopedPrisma.eventRecord.findFirst({
        where: { tenantId: tid, eventName: 'kz.org.unit.moved', subjectEntityId: v.id },
      }),
    ).not.toBeNull();
    expect(next.id).not.toBe(v.id);
  });
});

describe('Unit: IST dates and the tenant', () => {
  it('reads the default effective day in IST: 20:00 UTC on 31 March is 1 April, and is listed from 1 April', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-31T19:00:00.000Z') });
    const code = uniqueCode();
    const row = await asUser(CHAIRMAN, () =>
      openUnit({ code, name: 'Clock unit', lineId: null, reason: 'fixture' }),
    );
    createdUnitCodes.push(code);
    expect(row.effectiveFrom.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    const today = await asUser(CHAIRMAN, () => listUnits());
    expect(today.map((r) => r.id)).toContain(row.id);
    const march = await asUser(CHAIRMAN, () => listUnits({ asOf: '2026-03-31' }));
    expect(march.map((r) => r.id)).not.toContain(row.id);
  });

  it("lists only the caller's tenant, and refuses a line that belongs to another tenant", async () => {
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'Other unit tenant', slug: `unit-other-${uniqueCode().toLowerCase()}` },
    });
    createdTenantIds.push(other.id);
    const theirs = await unscopedPrisma.unit.create({
      data: { tenantId: other.id, code: uniqueCode(), name: 'Theirs', effectiveFrom: day('2030-01-01') },
    });
    const visible = await asUser(CHAIRMAN, () => listUnits({ asOf: '2030-06-01' }));
    expect(visible.map((r) => r.id)).not.toContain(theirs.id);

    const theirLine = await unscopedPrisma.businessLine.create({
      data: {
        tenantId: other.id,
        code: `O${uniqueCode().slice(1)}`,
        name: 'Theirs',
        payerKind: 'x',
        revenueModel: 'y',
        effectiveFrom: day('2030-01-01'),
      },
    });
    await expect(
      unscopedPrisma.unit.create({
        data: { tenantId: tid, code: uniqueCode(), name: 'Mine', lineId: theirLine.id, effectiveFrom: day('2030-01-01') },
      }),
    ).rejects.toThrow(/[Ff]oreign key/);
    await unscopedPrisma.unit.deleteMany({ where: { id: theirs.id } });
    await unscopedPrisma.businessLine.deleteMany({ where: { id: theirLine.id } });
  });

  it('turns on, forces and polices the units table', async () => {
    const rows = await unscopedPrisma.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policy: string | null }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname AS policy
        FROM pg_class c
        LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
       WHERE c.relname = 'units'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
    expect(rows[0]!.policy).toBe('tenant_isolation');
  });
});
