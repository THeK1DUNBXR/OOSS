/**
 * Reruns of the scheduled jobs that write history or artefacts (job audit
 * rows #18, #19, #23, #24 and #29 in JOB-IDEMPOTENCY.md).
 *
 * Each block states the defect it guards. The dump tests inject failure
 * through `PG_DUMP_BIN`, so no real `pg_dump` run is needed to exercise the
 * failure path.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedBootstrap } from '../seed/bootstrap.js';
import { asSystem } from '../platform/context.js';
import { publishEntitySnapshot } from '../domains/group.js';
import { computeDailyMetrics } from '../jobs/scheduler.js';
import { healthAsOfDay } from '../domains/health.js';
import { runBackup, runManualBackup, listBackups } from '../domains/compliance/corporate/security.js';
import { asPrincipal, authFor, expectReject, withFixtureRole } from './helpers.js';
import { JOBS as CORPORATE_JOBS } from '../jobs/compliance/corporate.js';
import { istDayStart } from '@kaizen/shared';
import { tenantId, unscopedPrisma } from './helpers.js';

const cleanupTenantSlugs: string[] = [];
let KAIZEN: string;

beforeAll(async () => {
  KAIZEN = await tenantId();
});

afterAll(async () => {
  const tenants = await unscopedPrisma.tenant.findMany({ where: { slug: { in: cleanupTenantSlugs } } });
  for (const t of tenants) {
    await unscopedPrisma.entitySnapshot.deleteMany({ where: { sourceTenantId: t.id } }).catch(() => {});
    await unscopedPrisma.entitySnapshotHistory.deleteMany({ where: { sourceTenantId: t.id } }).catch(() => {});
    await unscopedPrisma.dailyMetric.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
    await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
});

async function freshSubsidiary(label: string): Promise<string> {
  const slug = `${label}-${Date.now()}`;
  cleanupTenantSlugs.push(slug);
  const { tenantId: id } = await seedBootstrap({
    tenantSlug: slug,
    tenantName: `${label} sub`,
    parentTenantSlug: 'kaizen',
  });
  return id;
}

/** Backups are gzipped on the way to disk; this reads back what pg_dump wrote. */
function dumpText(path: string): string {
  return gunzipSync(readFileSync(path)).toString('utf8');
}

/** A tiny executable standing in for pg_dump: prints `body`, exits with `code`. */
function fakeDump(dir: string, name: string, body: string, code: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${body}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('#29 runComplianceBackupJob — a failed rerun never touches an earlier backup', () => {
  const saved = { BACKUP_DIR: process.env.BACKUP_DIR, PG_DUMP_BIN: process.env.PG_DUMP_BIN };
  const backupRunIds: string[] = [];
  let backupDir: string;
  let binDir: string;

  afterEach(async () => {
    await unscopedPrisma.backupRun.deleteMany({ where: { id: { in: backupRunIds.splice(0) } } }).catch(() => {});
    process.env.BACKUP_DIR = saved.BACKUP_DIR;
    process.env.PG_DUMP_BIN = saved.PG_DUMP_BIN;
    if (saved.BACKUP_DIR === undefined) delete process.env.BACKUP_DIR;
    if (saved.PG_DUMP_BIN === undefined) delete process.env.PG_DUMP_BIN;
  });

  beforeAll(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'kz-backup-'));
    binDir = mkdtempSync(join(tmpdir(), 'kz-pgdump-'));
  });

  it('a same-day rerun whose dump fails leaves the completed backup on disk byte-for-byte', async () => {
    process.env.BACKUP_DIR = backupDir;
    process.env.PG_DUMP_BIN = fakeDump(binDir, 'ok', 'GOOD-DUMP', 0);
    const first = await asSystem(KAIZEN, () => runBackup(KAIZEN));
    expect(first.status).toBe('completed');
    backupRunIds.push((await unscopedPrisma.backupRun.findFirstOrThrow({ where: { path: first.path } })).id);
    expect(dumpText(first.path!)).toBe('GOOD-DUMP');

    process.env.PG_DUMP_BIN = fakeDump(binDir, 'fail', 'partial', 1);
    const rerun = await asSystem(KAIZEN, () => runBackup(KAIZEN));
    expect(rerun.status).toBe('failed');
    if (rerun.path)
      backupRunIds.push((await unscopedPrisma.backupRun.findFirstOrThrow({ where: { path: rerun.path } })).id);

    expect(existsSync(first.path!)).toBe(true);
    expect(dumpText(first.path!)).toBe('GOOD-DUMP');
    const leftovers = readdirSync(backupDir, { recursive: true }) as string[];
    expect(leftovers.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it("pg_dump is handed a URL it accepts: Prisma's ?schema= parameter is stripped", async () => {
    process.env.BACKUP_DIR = backupDir;
    const echo = join(binDir, 'echo-url');
    writeFileSync(echo, '#!/bin/sh\nprintf \'%s\' "$1"\n');
    chmodSync(echo, 0o755);
    process.env.PG_DUMP_BIN = echo;
    const outcome = await asSystem(KAIZEN, () => runBackup(KAIZEN));
    backupRunIds.push((await unscopedPrisma.backupRun.findFirstOrThrow({ where: { path: outcome.path } })).id);
    // Real pg_dump 16 exits with `invalid URI query parameter: "schema"` on the same URL.
    expect(outcome.status).toBe('completed');
    expect(dumpText(outcome.path!)).not.toContain('schema=');
  });

  it('the scheduled job takes one platform dump per IST day, not one per tenant', async () => {
    process.env.BACKUP_DIR = backupDir;
    process.env.PG_DUMP_BIN = fakeDump(binDir, 'ok2', 'ONE-DUMP', 0);
    const job = CORPORATE_JOBS.find((j) => j.name === 'runComplianceBackupJob')!;
    // The once-per-day guard looks at every tenant's completed backups, so
    // earlier tests' rows (or a stale run's) must not count as today's dump.
    await unscopedPrisma.backupRun.deleteMany({
      where: { status: 'completed', startedAt: { gte: istDayStart(new Date()) } },
    });
    const startedAfter = new Date();

    const first = await asSystem(KAIZEN, () => job.run());
    const second = await asSystem(KAIZEN, () => job.run());

    const runs = await unscopedPrisma.backupRun.findMany({ where: { startedAt: { gte: startedAfter } } });
    backupRunIds.push(...runs.map((r) => r.id));
    expect(first.processed).toBe(1);
    expect(second.skippedIdempotent).toBe(1);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(1);
  });
});

describe('#18 / #19 publish_entity_snapshots — a publish with nothing new adds no history row', () => {
  it('two publishes of an unchanged subsidiary leave one history row', async () => {
    const subId = await freshSubsidiary('idem-snap');
    await publishEntitySnapshot(subId);
    await publishEntitySnapshot(subId);

    const count = await unscopedPrisma.entitySnapshotHistory.count({ where: { sourceTenantId: subId } });
    expect(count).toBe(1);
  });

  it('two publishes racing each other, with the same content, leave one history row', async () => {
    const subId = await freshSubsidiary('idem-snap-race');
    await Promise.all([publishEntitySnapshot(subId), publishEntitySnapshot(subId)]);

    const count = await unscopedPrisma.entitySnapshotHistory.count({ where: { sourceTenantId: subId } });
    expect(count).toBe(1);
  });

  it('the database refuses a second history row with the same source and content hash', async () => {
    const subId = await freshSubsidiary('idem-snap-key');
    await publishEntitySnapshot(subId);
    const row = await unscopedPrisma.entitySnapshotHistory.findFirstOrThrow({ where: { sourceTenantId: subId } });
    const { id: _id, createdAt: _createdAt, ...rest } = row;
    await expect(
      unscopedPrisma.entitySnapshotHistory.create({
        // Json columns read back as JsonValue and need the same cast group.ts applies on write.
        data: { ...rest, recordCode: `${rest.recordCode}-dup` } as never,
      }),
    ).rejects.toThrow();
  });
});

describe('#29 manual backup and backup listing are admin actions, not tenant-wide', () => {
  it('a user without security_settings edit cannot start a platform dump, and no run is recorded', async () => {
    const saved = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = mkdtempSync(join(tmpdir(), 'kz-backup-perm-'));
    try {
      const before = await unscopedPrisma.backupRun.count({ where: { tenantId: KAIZEN } });
      await withFixtureRole(
        { slug: 'backup_viewer', grants: [{ resource: 'security_settings', verbs: ['view'] }] },
        (p) =>
          asPrincipal(authFor(p), async () => {
            const err = await expectReject(() => runManualBackup(KAIZEN));
            expect(err.status).toBe(403);
          }),
      );
      expect(await unscopedPrisma.backupRun.count({ where: { tenantId: KAIZEN } })).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = saved;
    }
  });

  it('a view-only user cannot list the platform backup log', async () => {
    await withFixtureRole(
      { slug: 'backup_lister', grants: [{ resource: 'security_settings', verbs: ['view'] }] },
      (p) =>
        asPrincipal(authFor(p), async () => {
          const err = await expectReject(() => listBackups());
          expect(err.status).toBe(403);
        }),
    );
  });
});

describe('#23 runDailyMetricsJob — one row per metric per IST day, bucketed in IST', () => {
  it('a run at 2026-10-11T19:00Z buckets into 2026-10-12 (IST), not 2026-10-11 (UTC)', async () => {
    const subId = await freshSubsidiary('idem-metric');
    await asSystem(subId, () => computeDailyMetrics(new Date('2026-10-11T19:00:00Z')));

    const rows = await unscopedPrisma.dailyMetric.findMany({ where: { tenantId: subId } });
    expect(rows.length).toBeGreaterThan(0);
    // 00:00 IST on 12 October is 18:30Z on 11 October.
    expect(new Set(rows.map((r) => r.date.toISOString()))).toEqual(new Set(['2026-10-11T18:30:00.000Z']));
  });

  it('running twice writes one row per metric for the IST day', async () => {
    const subId = await freshSubsidiary('idem-metric2');
    const now = new Date('2026-10-11T19:00:00Z');
    await asSystem(subId, () => computeDailyMetrics(now));
    await asSystem(subId, () => computeDailyMetrics(now));

    const rows = await unscopedPrisma.dailyMetric.findMany({ where: { tenantId: subId } });
    const perMetric = new Map<string, number>();
    for (const r of rows) perMetric.set(r.metric, (perMetric.get(r.metric) ?? 0) + 1);
    expect([...perMetric.values()].every((n) => n === 1)).toBe(true);
  });

  it('the database refuses a second row for the same tenant, IST day and metric', async () => {
    const subId = await freshSubsidiary('idem-metric3');
    const date = new Date('2026-10-11T18:30:00Z');
    await unscopedPrisma.dailyMetric.create({ data: { tenantId: subId, date, metric: 'deals_won', value: 1 } });
    await expect(
      unscopedPrisma.dailyMetric.create({ data: { tenantId: subId, date, metric: 'deals_won', value: 2 } }),
    ).rejects.toThrow();
  });
});

describe('#24 runHealthScoreJob — health asOf is the IST day', () => {
  it('a run at 2026-10-11T19:00Z is keyed to IST midnight of 12 October', () => {
    expect(healthAsOfDay(new Date('2026-10-11T19:00:00Z')).toISOString()).toBe('2026-10-11T18:30:00.000Z');
  });
});
