/**
 * Thresholds as typed values (Wave 6, SPINE-CONTRACT 1.10; the Float `value`
 * column is retired by 20261013160000_threshold_minor). Each property below is
 * one the thresholds must keep on every path that reads or writes them:
 *   - a currency threshold is bigint paise in `valueMinor` and round-trips above
 *     2^53 paise, both through the database and on the wire as a digit string;
 *   - every consumer compares a money threshold as bigint, so a value a float
 *     cannot tell apart from its neighbour is still compared exactly;
 *   - a threshold row that is missing is reported as not measured or refused with
 *     a typed error, never replaced by a literal in the code;
 *   - the admin write is refused for the wrong field and for a value of the wrong
 *     shape, and a successful write is audited and emitted;
 *   - the migration refuses a fractional-paise currency value and a fractional
 *     day count, under the application role, and converts the rest exactly.
 *
 * Real Postgres and real contexts, no mocks. The migration runs from its file on
 * scratch databases built from the migrations that precede it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import * as commandCenter from '../domains/commandCenter.js';
import * as health from '../domains/health.js';
import * as winLoss from '../domains/winLoss.js';
import { createApp } from '../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public';
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? TEST_DB_URL.replace('//kaizen:kaizen@', '//kaizen_app:kaizen_app@');
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const THRESHOLD_MIGRATION = '20261013160000_threshold_minor';

const MATERIALITY = 'command_center.materiality_floor';
const WINDOW = 'command_center.narrative_window_hours';
const WIN_LOSS = 'win_loss_review.value_threshold';
const QUARTER = 'h_com.quarter_target';
const K_ANONYMITY = 'people.k_anonymity_floor';
const TWO_POW_53 = 9007199254740992n;

let KAIZEN: string;
const originals = new Map<string, Record<string, unknown>>();

async function thresholdRow(key: string) {
  return unscopedPrisma.threshold.findFirst({ where: { tenantId: KAIZEN, thresholdKey: key } });
}

/** Sets the typed columns of a seeded row for one test. Restored in afterAll. */
async function setTyped(key: string, data: { valueMinor?: bigint | null; valueInt?: number | null }) {
  await unscopedPrisma.threshold.updateMany({ where: { tenantId: KAIZEN, thresholdKey: key }, data });
}

function suffix(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

beforeAll(async () => {
  KAIZEN = await tenantId();
  for (const key of [MATERIALITY, WINDOW, WIN_LOSS, QUARTER, K_ANONYMITY]) {
    const row = await thresholdRow(key);
    if (row) originals.set(key, { ...row });
  }
}, 120_000);

afterAll(async () => {
  for (const [key, row] of originals) {
    await unscopedPrisma.threshold.updateMany({
      where: { tenantId: KAIZEN, thresholdKey: key },
      data: { valueMinor: row.valueMinor as bigint | null, valueInt: row.valueInt as number | null },
    });
  }
});

describe('a currency threshold is bigint paise, above 2^53 too', () => {
  it('round-trips 2^53+1 paise through the column without a float', async () => {
    const big = TWO_POW_53 + 1n;
    await setTyped(MATERIALITY, { valueMinor: big });
    const row = await thresholdRow(MATERIALITY);
    expect(typeof row?.valueMinor).toBe('bigint');
    expect(row?.valueMinor).toBe(big);
  });

  it('the admin route takes paise as a digit string and returns it as one, above 2^53', async () => {
    const server: Server = createApp().listen(0);
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}/api`;
      const principal = await principalFor(CHAIRMAN);
      const token = await sessionToken({
        userId: principal.userId,
        tenantId: principal.tenantId,
        affiliationId: principal.affiliationId,
        stepUp: true,
      });
      const big = '9007199254740993';
      const res = await fetch(`${base}/admin/thresholds/${encodeURIComponent(MATERIALITY)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ valueMinor: big }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { valueMinor: string };
      expect(body.valueMinor).toBe(big);

      const list = await fetch(`${base}/admin/thresholds`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows = (await list.json()) as { thresholdKey: string; valueMinor: string }[];
      expect(rows.find((r) => r.thresholdKey === MATERIALITY)?.valueMinor).toBe(big);
    } finally {
      server.close();
    }
  });
});

describe('every consumer compares a money threshold as bigint', () => {
  it('the materiality floor is read from the typed column as bigint', async () => {
    await setTyped(MATERIALITY, { valueMinor: TWO_POW_53 + 1n });
    const floor = await asUser(CHAIRMAN, () => commandCenter.materialityFloorMinor());
    expect(floor).toBe(TWO_POW_53 + 1n);
  });

  it('a materiality one paise either side of the floor is decided exactly', () => {
    // 9007199254740993 and 9007199254740992 are the same float; the floor must still tell them apart.
    expect(commandCenter.clearsMaterialityFloor('90071992547409.93', TWO_POW_53)).toBe(true);
    expect(commandCenter.clearsMaterialityFloor('90071992547409.92', TWO_POW_53 + 1n)).toBe(false);
  });

  it('a materiality that is not a two-place amount is not measured, so it does not clear the floor', () => {
    expect(commandCenter.clearsMaterialityFloor('1.005', 1n)).toBe(false);
    expect(commandCenter.clearsMaterialityFloor(0.30000000000000004, 1n)).toBe(false);
  });

  it('the win/loss value threshold is read as bigint, and the mandatory test is exact', async () => {
    await setTyped(WIN_LOSS, { valueMinor: TWO_POW_53 + 1n });
    const threshold = await asUser(CHAIRMAN, () => winLoss.valueThresholdMinor());
    expect(threshold).toBe(TWO_POW_53 + 1n);
    expect(winLoss.commercialClearsThreshold(TWO_POW_53, TWO_POW_53 + 1n)).toBe(false);
    expect(winLoss.commercialClearsThreshold(TWO_POW_53 + 1n, TWO_POW_53 + 1n)).toBe(true);
    expect(winLoss.commercialClearsThreshold(null, 1n)).toBe(false);
  });

  it('the quarter target is read as bigint paise', async () => {
    await setTyped(QUARTER, { valueMinor: 2_000_000_000n });
    expect(await asUser(CHAIRMAN, () => health.quarterTargetMinor())).toBe(2_000_000_000n);
  });

  it('a count threshold is read from the integer column', async () => {
    await setTyped(WINDOW, { valueInt: 5 });
    expect(await asUser(CHAIRMAN, () => commandCenter.narrativeWindowHours())).toBe(5);
  });
});

describe('a missing threshold is reported, never replaced by a literal', () => {
  async function withoutRow<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const row = await thresholdRow(key);
    await unscopedPrisma.threshold.deleteMany({ where: { tenantId: KAIZEN, thresholdKey: key } });
    try {
      return await fn();
    } finally {
      if (row) await unscopedPrisma.threshold.create({ data: { ...row } as never });
    }
  }

  it('the materiality floor refuses with a typed 409 when its row is missing', async () => {
    await withoutRow(MATERIALITY, () =>
      expect(asUser(CHAIRMAN, () => commandCenter.materialityFloorMinor())).rejects.toMatchObject({ status: 409 }),
    );
  });

  it('the quarter target is null, which the health domain reports as not measured', async () => {
    await withoutRow(QUARTER, async () => {
      expect(await asUser(CHAIRMAN, () => health.quarterTargetMinor())).toBeNull();
    });
  });
});

describe('the admin write is audited, emitted and shape-checked', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(() => {
    server?.close();
  });

  async function token(): Promise<string> {
    const p = await principalFor(CHAIRMAN);
    return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
  }

  function patch(key: string, body: unknown) {
    return token().then((t) =>
      fetch(`${base}/admin/thresholds/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('a successful write leaves an audit row and an emitted event, and both name the threshold', async () => {
    const before = await thresholdRow(WINDOW);
    const res = await patch(WINDOW, { valueInt: 48 });
    expect(res.status).toBe(200);
    const after = await thresholdRow(WINDOW);
    expect(after?.valueInt).toBe(48);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { subjectType: 'threshold', subjectId: before!.id, action: 'update' },
    });
    expect(audit).not.toBeNull();

    const event = await unscopedPrisma.eventRecord.findFirst({
      where: { eventName: 'kz.org.threshold.updated', subjectEntityId: before!.id },
    });
    expect(event).not.toBeNull();
    await setTyped(WINDOW, { valueInt: 72 });
  });

  it('refuses paise for a count threshold and leaves the row unchanged', async () => {
    await setTyped(K_ANONYMITY, { valueInt: 5 });
    const res = await patch(K_ANONYMITY, { valueMinor: '500' });
    expect(res.status).toBe(400);
    expect((await thresholdRow(K_ANONYMITY))?.valueInt).toBe(5);
  });

  it('refuses a whole-number field for a currency threshold and leaves the row unchanged', async () => {
    await setTyped(MATERIALITY, { valueMinor: 10_000_000n });
    const res = await patch(MATERIALITY, { valueInt: 999 });
    expect(res.status).toBe(400);
    expect((await thresholdRow(MATERIALITY))?.valueMinor).toBe(10_000_000n);
  });

  it('refuses a JavaScript number where the paise string belongs', async () => {
    const res = await patch(MATERIALITY, { valueMinor: 12345.67 });
    expect(res.status).toBe(400);
  });
});

describe('the threshold migration (20261013160000_threshold_minor)', () => {
  const stamp = suffix().toLowerCase();
  const PRE_DB = `kaizen_w6thr_pre_${stamp}`;
  const migrationFile = join(MIGRATIONS_DIR, THRESHOLD_MIGRATION, 'migration.sql');
  const priorMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d) && d < THRESHOLD_MIGRATION)
    .sort();

  function dbUrl(name: string): string {
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${name}`;
    url.search = '';
    return url.toString();
  }

  function appDbUrl(name: string): string {
    const url = new URL(APP_URL);
    url.pathname = `/${name}`;
    url.search = '';
    return url.toString();
  }

  function psql(url: string, args: string[], input?: string): string {
    return execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8',
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      input,
    });
  }

  /** The guard block as the migration writes it, between its GUARD markers. */
  function guardBlock(): string {
    const sql = readFileSync(migrationFile, 'utf8');
    const start = sql.indexOf('-- GUARD BEGIN');
    const end = sql.indexOf('-- GUARD END');
    if (start < 0 || end < 0) throw new Error('the migration has no GUARD BEGIN / GUARD END markers');
    return sql.slice(start, end);
  }

  function admin(sql: string): void {
    psql(dbUrl(new URL(TEST_DB_URL).pathname.slice(1)), ['-c', sql]);
  }

  function copyOfPre(name: string): string {
    admin(`CREATE DATABASE "${name}" TEMPLATE "${PRE_DB}" OWNER kaizen`);
    return name;
  }

  function dropDb(name: string): void {
    admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }

  async function seedThreshold(
    client: PrismaClient,
    id: string,
    key: string,
    value: number,
    unit: string,
    tenant = 'migration-fixture',
  ): Promise<void> {
    await client.$executeRaw`INSERT INTO "thresholds" ("id", "tenantId", "thresholdKey", "value", "unit", "updatedAt")
      VALUES (${id}, ${tenant}, ${key}, ${value}::float8, ${unit}, now())`;
  }

  /** A migration section between two marker lines, as the migration file holds it. */
  function section(begin: string, end: string): string {
    const sql = readFileSync(migrationFile, 'utf8');
    const start = sql.indexOf(begin);
    const stop = sql.indexOf(end);
    if (start < 0 || stop < 0) throw new Error(`the migration has no ${begin} / ${end} markers`);
    return sql.slice(start, stop + end.length);
  }

  beforeAll(() => {
    admin(`CREATE DATABASE "${PRE_DB}" OWNER kaizen`);
    for (const dir of priorMigrations) {
      psql(dbUrl(PRE_DB), ['-f', join(MIGRATIONS_DIR, dir, 'migration.sql')]);
    }
    // The guard and the backfill walk the tenants table, so the fixture tenants are rows in it.
    psql(dbUrl(PRE_DB), [
      '-c',
      `INSERT INTO "tenants" ("id", "name", "slug", "updatedAt") VALUES
         ('migration-fixture', 'Migration fixture', 'migration-fixture', now()),
         ('migration-fixture-2', 'Migration fixture two', 'migration-fixture-2', now())`,
    ]);
  }, 600_000);

  afterAll(() => {
    dropDb(PRE_DB);
  });

  it('converts currency to paise exactly and other units to integers, then drops the Float column', async () => {
    const name = copyOfPre(`kaizen_w6thr_conv_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedThreshold(client, 'thr-a', 'cur.a', 12345.67, 'currency');
      await seedThreshold(client, 'thr-b', 'cur.b', 0.07, 'currency');
      await seedThreshold(client, 'thr-big', 'cur.big', 100000000000000, 'currency');
      await seedThreshold(client, 'thr-days', 'days.a', 14, 'days');
      await seedThreshold(client, 'thr-count', 'count.a', 5, 'count');
      await client.$disconnect();

      psql(dbUrl(name), ['-1', '-f', migrationFile]);

      const after = new PrismaClient({ datasourceUrl: dbUrl(name) });
      try {
        const rows = await after.$queryRaw<{ id: string; minor: string | null; int: number | null }[]>`
          SELECT "id", "valueMinor"::text AS minor, "valueInt" AS int FROM "thresholds" ORDER BY "id"`;
        expect(Object.fromEntries(rows.map((r) => [r.id, [r.minor, r.int]]))).toEqual({
          'thr-a': ['1234567', null],
          'thr-b': ['7', null],
          'thr-big': ['10000000000000000', null],
          'thr-days': [null, 14],
          'thr-count': [null, 5],
        });

        const [column] = await after.$queryRaw<{ data_type: string }[]>`
          SELECT data_type FROM information_schema.columns WHERE table_name = 'thresholds' AND column_name = 'valueMinor'`;
        expect(column?.data_type).toBe('bigint');

        const [old] = await after.$queryRaw<{ present: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'thresholds' AND column_name = 'value') AS present`;
        expect(old?.present).toBe(false);

        // The CHECK holds after the migration: a currency row without valueMinor is refused
        // by the constraint itself, not by some other error on the insert.
        await expect(
          after.$executeRaw`INSERT INTO "thresholds" ("id", "tenantId", "thresholdKey", "unit", "updatedAt")
            VALUES ('thr-bad', 'migration-fixture', 'cur.bad', 'currency', now())`,
        ).rejects.toThrow(/thresholds_value_matches_unit/);
        // And the reverse: paise on a count row is refused too.
        await expect(
          after.$executeRaw`INSERT INTO "thresholds" ("id", "tenantId", "thresholdKey", "unit", "valueMinor", "updatedAt")
            VALUES ('thr-bad2', 'migration-fixture', 'count.bad', 'count', 500, now())`,
        ).rejects.toThrow(/thresholds_value_matches_unit/);
      } finally {
        await after.$disconnect();
      }
    } finally {
      await client.$disconnect();
      dropDb(name);
    }
  });

  it('refuses a currency value with fractional paise under the application role, and changes nothing', async () => {
    const name = copyOfPre(`kaizen_w6thr_frac_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedThreshold(client, 'thr-frac', 'cur.frac', 12.345, 'currency');
      await client.$disconnect();

      let stderr = '';
      try {
        psql(appDbUrl(name), ['-f', '-'], guardBlock());
      } catch (err) {
        stderr = String((err as { stderr?: string }).stderr ?? err);
      }
      expect(stderr).toMatch(/fractional paise/);

      const after = new PrismaClient({ datasourceUrl: dbUrl(name) });
      try {
        const [row] = await after.$queryRaw<{ value: number }[]>`SELECT "value" FROM "thresholds" WHERE "id" = 'thr-frac'`;
        expect(row?.value).toBe(12.345);
      } finally {
        await after.$disconnect();
      }
    } finally {
      await client.$disconnect();
      dropDb(name);
    }
  });

  it('converts under the application role across two tenants, and the CHECKs then hold', async () => {
    const name = copyOfPre(`kaizen_w6thr_app_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedThreshold(client, 'app-a', 'cur.app', 12345.67, 'currency');
      await seedThreshold(client, 'app-b', 'days.app', 14, 'days');
      // Second tenant: a backfill that does not walk the tenants would leave this row NULL.
      await seedThreshold(client, 'app-c', 'cur.app2', 0.07, 'currency', 'migration-fixture-2');
      await seedThreshold(client, 'app-d', 'count.app2', 5, 'count', 'migration-fixture-2');
    } finally {
      await client.$disconnect();
    }

    // Columns are owner DDL, so they run as the owner; the guard and the backfill run as the application role.
    const sql = readFileSync(migrationFile, 'utf8');
    const columns = sql.slice(0, sql.indexOf('-- GUARD BEGIN'));
    const tail = sql.slice(sql.indexOf('-- BACKFILL END') + '-- BACKFILL END'.length);
    try {
      psql(dbUrl(name), ['-1', '-f', '-'], columns);
      psql(
        appDbUrl(name),
        ['-1', '-f', '-'],
        `${section('-- GUARD BEGIN', '-- GUARD END')}\n${section('-- BACKFILL BEGIN', '-- BACKFILL END')}`,
      );
      psql(dbUrl(name), ['-1', '-f', '-'], tail);

      const after = new PrismaClient({ datasourceUrl: dbUrl(name) });
      try {
        const rows = await after.$queryRaw<{ id: string; minor: string | null; int: number | null }[]>`
          SELECT "id", "valueMinor"::text AS minor, "valueInt" AS int FROM "thresholds" ORDER BY "id"`;
        expect(Object.fromEntries(rows.map((r) => [r.id, [r.minor, r.int]]))).toEqual({
          'app-a': ['1234567', null],
          'app-b': [null, 14],
          'app-c': ['7', null],
          'app-d': [null, 5],
        });
      } finally {
        await after.$disconnect();
      }
    } finally {
      dropDb(name);
    }
  });

  it('refuses a day count with a fraction under the application role, with RAISE', async () => {
    const name = copyOfPre(`kaizen_w6thr_days_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedThreshold(client, 'thr-days', 'days.frac', 2.5, 'days');
    } finally {
      await client.$disconnect();
    }

    let stderr = '';
    try {
      psql(appDbUrl(name), ['-f', '-'], guardBlock());
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? err);
    } finally {
      dropDb(name);
    }
    expect(stderr).toMatch(/not a whole number/);
  });

  it('refuses a unit the code does not know, under the application role', async () => {
    const name = copyOfPre(`kaizen_w6thr_unit_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedThreshold(client, 'thr-unit', 'unit.bad', 3, 'furlongs');
    } finally {
      await client.$disconnect();
    }

    let stderr = '';
    try {
      psql(appDbUrl(name), ['-f', '-'], guardBlock());
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? err);
    } finally {
      dropDb(name);
    }
    expect(stderr).toMatch(/unknown unit/);
  });
});
