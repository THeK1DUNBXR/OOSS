/**
 * The durable scheduler, against the real database.
 *
 * `scheduler.test.ts` checks the schedule calculator. This file checks what
 * happens when the calculator's answer meets claims, fences, leases and
 * backoff in Postgres: two workers racing for one occurrence, a stale holder
 * trying to write after a takeover, a body that outlives its timeout, and a
 * job that keeps failing until it is dead-lettered.
 *
 * The job bodies here are probes: small functions that count their calls and
 * record the tenant in context. They are not mocks of the scheduler or the
 * database. Every claim, fence and backoff is a real row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { unscopedPrisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { tenantId } from './helpers.js';
import {
  ALL_JOBS,
  assertSchedulable,
  claimAttempt,
  finishAttempt,
  heartbeatAttempt,
  runAllTenants,
  runClaimedOccurrence,
  runManualJobs,
  tickOnce,
  type JobDefinition,
  type JobResult,
} from '../jobs/scheduler.js';
import { CATCH_UP_MS, MAX_ATTEMPTS } from '../jobs/schedule.js';

const SIX_AM_IST = '0 6 * * *';
const ok: JobResult = { processed: 1, notified: 0, skippedIdempotent: 0, errors: [] };
/** Midnight IST on 11 September 2026. */
const MIDNIGHT_IST = new Date('2026-09-10T18:30:00.000Z');

let kaizen = '';
let seq = 0;
const probeNames: string[] = [];

function probe(
  cron: string,
  body: (signal: AbortSignal) => Promise<JobResult> = async () => ok,
  shape: Pick<JobDefinition, 'sideEffects' | 'idempotent'> = {},
) {
  const name = `probe.job${++seq}.${randomUUID().slice(0, 8)}`;
  probeNames.push(name);
  const calls: Array<{ tenantId: string; signal: AbortSignal }> = [];
  const job: JobDefinition = {
    name,
    label: name,
    automationClass: 'probe',
    cron,
    ...shape,
    run: async (signal) => {
      calls.push({ tenantId: currentAuth().tenantId, signal });
      return body(signal);
    },
  };
  return { job, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rowFor(jobName: string, scheduledFor: Date) {
  return unscopedPrisma.jobClaim.findFirst({ where: { jobName, scheduledFor } });
}

beforeAll(async () => {
  kaizen = await tenantId();
});

afterAll(async () => {
  await unscopedPrisma.jobClaim.deleteMany({ where: { jobName: { startsWith: 'probe.' } } });
  await unscopedPrisma.jobRun.deleteMany({ where: { jobName: { startsWith: 'probe.' } } });
  await unscopedPrisma.automationDefinition.deleteMany({ where: { jobName: { startsWith: 'probe.' } } });
});

describe('the cron fires once per IST day through real ticks', () => {
  it("fires '0 6 * * *' once per IST day over three simulated days", async () => {
    const { job, calls } = probe(SIX_AM_IST);
    const fired: string[] = [];
    // One tick a minute, the live cadence. 72 hours of them.
    for (let t = 0; t < 72 * 60; t++) {
      const now = new Date(MIDNIGHT_IST.getTime() + t * 60_000);
      const out = await tickOnce(now, { jobs: [job], tenantIds: [kaizen] });
      for (const r of out.ran) fired.push(r.scheduledFor.toISOString());
    }
    expect(fired).toEqual(['2026-09-11T00:30:00.000Z', '2026-09-12T00:30:00.000Z', '2026-09-13T00:30:00.000Z']);
    expect(calls).toHaveLength(3);
  }, 300_000);

  it('a tick a minute and a half late still fires the 06:00 occurrence, once', async () => {
    const { job } = probe(SIX_AM_IST);
    const late = await tickOnce(new Date('2026-09-12T00:31:30.000Z'), { jobs: [job], tenantIds: [kaizen] });
    expect(late.ran.map((r) => r.scheduledFor.toISOString())).toEqual(['2026-09-12T00:30:00.000Z']);
    const later = await tickOnce(new Date('2026-09-12T00:45:00.000Z'), { jobs: [job], tenantIds: [kaizen] });
    expect(later.ran).toEqual([]);
  });

  it('a scheduler down for hours fires the latest hourly occurrence once, not the backlog', async () => {
    // Down from 06:30 IST, back at 12:30 IST. Hourly on the IST hour, so the
    // latest occurrence is 12:00 IST, which is 06:30Z.
    const { job, calls } = probe('0 * * * *');
    const out = await tickOnce(new Date('2026-09-12T07:00:00.000Z'), { jobs: [job], tenantIds: [kaizen] });
    expect(out.ran.map((r) => r.scheduledFor.toISOString())).toEqual(['2026-09-12T06:30:00.000Z']);
    expect(calls).toHaveLength(1);
  });

  it('does not fire an occurrence once the catch-up window has closed', async () => {
    const { job } = probe(SIX_AM_IST);
    const occurrence = new Date('2026-09-12T00:30:00.000Z');
    const closed = new Date(occurrence.getTime() + CATCH_UP_MS + 60_000);
    const out = await tickOnce(closed, { jobs: [job], tenantIds: [kaizen] });
    expect(out.ran).toEqual([]);
  });
});

describe('two workers, one occurrence', () => {
  it('two workers ticking the same instant run an occurrence once', async () => {
    const { job, calls } = probe(SIX_AM_IST, async () => {
      await sleep(150);
      return ok;
    });
    const [a, b] = await Promise.all([
      tickOnce(new Date('2026-09-12T00:30:20.000Z'), { jobs: [job], tenantIds: [kaizen], workerId: 'worker-a' }),
      tickOnce(new Date('2026-09-12T00:30:20.000Z'), { jobs: [job], tenantIds: [kaizen], workerId: 'worker-b' }),
    ]);
    expect(a.ran.length + b.ran.length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('a worker one second behind computes the same occurrence and stands down', async () => {
    const { job, calls } = probe(SIX_AM_IST);
    const first = await tickOnce(new Date('2026-09-12T00:30:20.000Z'), { jobs: [job], tenantIds: [kaizen] });
    const second = await tickOnce(new Date('2026-09-12T00:30:21.000Z'), { jobs: [job], tenantIds: [kaizen] });
    expect(first.ran).toHaveLength(1);
    expect(second.ran).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a stale attempt cannot finish after another worker has taken over', async () => {
    const { job } = probe(SIX_AM_IST);
    const occurrence = new Date('2026-09-12T00:30:00.000Z');
    const a = await claimAttempt(kaizen, job.name, occurrence, 'worker-a');
    expect(a).toMatchObject({ attempt: 1 });

    // A stops renewing, its lease lapses, and B takes the claim over.
    await unscopedPrisma.jobClaim.update({ where: { id: a!.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const b = await claimAttempt(kaizen, job.name, occurrence, 'worker-b');
    expect(b).toMatchObject({ attempt: 2 });

    // A wakes up and tries to record its completion. It must not land.
    expect(await finishAttempt({ id: a!.id, workerId: 'worker-a', attempt: 1 }, 5)).toBe(false);
    expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'running', attempt: 2, workerId: 'worker-b' });

    expect(await finishAttempt({ id: b!.id, workerId: 'worker-b', attempt: 2 }, 5)).toBe(true);
    expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'completed', attempt: 2 });
  });

  it('a holder whose lease was taken over learns so from its next heartbeat', async () => {
    const { job } = probe(SIX_AM_IST);
    const occurrence = new Date('2026-09-12T00:30:00.000Z');
    const a = await claimAttempt(kaizen, job.name, occurrence, 'worker-a');
    await unscopedPrisma.jobClaim.update({ where: { id: a!.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const b = await claimAttempt(kaizen, job.name, occurrence, 'worker-b');

    expect(await heartbeatAttempt({ id: a!.id, workerId: 'worker-a', attempt: 1 })).toBe(false);
    expect(await heartbeatAttempt({ id: b!.id, workerId: 'worker-b', attempt: 2 })).toBe(true);
  });

  it('tenant A holding an occurrence does not block tenant B for the same job', async () => {
    const { job } = probe(SIX_AM_IST);
    const occurrence = new Date('2026-09-12T00:30:00.000Z');
    const a = await claimAttempt(`tenant-iso-a-${randomUUID()}`, job.name, occurrence, 'worker-a');
    const b = await claimAttempt(`tenant-iso-b-${randomUUID()}`, job.name, occurrence, 'worker-b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe('failure, timeout and dead-letter', () => {
  it('a failure waits out its backoff, and the fourth failure dead-letters', async () => {
    const { job, calls } = probe('* * * * *', async () => {
      throw new Error('boom');
    });
    const occurrence = new Date('2026-09-12T00:31:00.000Z');
    const expireBackoff = () =>
      unscopedPrisma.$executeRaw`UPDATE job_claims SET "runAfter" = now() - interval '1 second' WHERE "jobName" = ${job.name}`;

    const first = await runClaimedOccurrence(kaizen, job, occurrence);
    expect(first.status).toBe('failed');
    const afterFirst = await rowFor(job.name, occurrence);
    expect(afterFirst).toMatchObject({ status: 'failed', attempt: 1, lastError: 'boom' });
    // Backoff for attempt 1 is one minute.
    expect(afterFirst!.runAfter!.getTime() - Date.now()).toBeGreaterThan(50_000);

    // Not before its backoff.
    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('skipped');
    expect(calls).toHaveLength(1);

    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++) {
      await expireBackoff();
      expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('failed');
      expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'failed', attempt });
    }

    await expireBackoff();
    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('dead');
    const dead = await rowFor(job.name, occurrence);
    expect(dead).toMatchObject({ status: 'dead', attempt: MAX_ATTEMPTS });
    expect(dead!.deadAt).not.toBeNull();
    expect(calls).toHaveLength(MAX_ATTEMPTS);

    // Dead is terminal. Nothing retakes it, however long it waits.
    await expireBackoff();
    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('skipped');
    expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'dead', attempt: MAX_ATTEMPTS });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('a body that outlives its timeout is marked timed_out, and its signal aborts', async () => {
    let aborted = false;
    const { job } = probe('* * * * *', (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      // Ignores the signal and finishes late, the way a body without
      // checkpoints would. Its late success must not overwrite the claim.
      return new Promise<JobResult>((resolve) => setTimeout(() => resolve(ok), 400));
    });
    const occurrence = new Date('2026-09-12T00:32:00.000Z');

    const out = await runClaimedOccurrence(kaizen, job, occurrence, { timeoutMs: 100 });
    expect(out.status).toBe('timed_out');
    expect(aborted).toBe(true);

    await sleep(500);
    const row = await rowFor(job.name, occurrence);
    expect(row).toMatchObject({ status: 'timed_out' });
    expect(row!.runAfter).not.toBeNull();
  });

  it('a job body runs in its tenant context', async () => {
    const { job, calls } = probe('* * * * *');
    await runClaimedOccurrence(kaizen, job, new Date('2026-09-12T00:33:00.000Z'));
    expect(calls.map((c) => c.tenantId)).toEqual([kaizen]);
  });
});

describe('side effects decide how often a body may run', () => {
  const boom = async (): Promise<JobResult> => {
    throw new Error('gateway 503');
  };

  it('an external job that is not idempotent is dead-lettered on its first failure', async () => {
    const { job, calls } = probe('* * * * *', boom, { sideEffects: 'external', idempotent: false });
    const occurrence = new Date('2026-09-12T00:40:00.000Z');

    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('dead');
    expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'dead', attempt: 1 });
    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('an external job that is not idempotent is not re-run after a timeout either', async () => {
    const { job, calls } = probe('* * * * *', () => new Promise<JobResult>((r) => setTimeout(() => r(ok), 400)), {
      sideEffects: 'external',
      idempotent: false,
    });
    const occurrence = new Date('2026-09-12T00:41:00.000Z');

    expect((await runClaimedOccurrence(kaizen, job, occurrence, { timeoutMs: 100 })).status).toBe('dead');
    await sleep(500);
    expect((await runClaimedOccurrence(kaizen, job, occurrence)).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('an external job that declares itself idempotent keeps the retry ladder', async () => {
    const { job } = probe('* * * * *', boom, { sideEffects: 'external', idempotent: true });
    expect((await runClaimedOccurrence(kaizen, job, new Date('2026-09-12T00:42:00.000Z'))).status).toBe('failed');
  });

  it('an internal job keeps the retry ladder after a failure', async () => {
    const { job } = probe('* * * * *', boom, { sideEffects: 'internal', idempotent: false });
    expect((await runClaimedOccurrence(kaizen, job, new Date('2026-09-12T00:43:00.000Z'))).status).toBe('failed');
  });

  it('a crashed external attempt is dead-lettered by the sweep rather than taken over', async () => {
    const { job, calls } = probe('* * * * *', undefined, { sideEffects: 'external', idempotent: false });
    const occurrence = new Date('2026-09-12T00:44:00.000Z');
    const a = await claimAttempt(kaizen, job.name, occurrence, 'worker-a');
    await unscopedPrisma.jobClaim.update({ where: { id: a!.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });

    await tickOnce(occurrence, { jobs: [job], tenantIds: [kaizen] });

    expect(calls).toHaveLength(0);
    expect(await rowFor(job.name, occurrence)).toMatchObject({ status: 'dead', attempt: 1 });
  });
});

describe('manual runs and the registry', () => {
  it('two concurrent manual runs of one job for one instant run it once', async () => {
    const { job, calls } = probe(SIX_AM_IST, async () => {
      await sleep(150);
      return ok;
    });
    const at = new Date('2026-09-12T10:05:00.000Z');
    const [a, b] = await Promise.all([
      runManualJobs(kaizen, { jobs: [job], at }),
      runManualJobs(kaizen, { jobs: [job], at }),
    ]);
    expect(calls).toHaveLength(1);
    expect([a, b].filter((r) => r[job.name] !== undefined)).toHaveLength(1);
  });

  it('a manual run claims its instant, so a repeat of the same instant is skipped', async () => {
    const { job, calls } = probe(SIX_AM_IST);
    const at = new Date('2026-09-12T10:00:00.000Z');
    const first = await runAllTenants({ tenantId: kaizen, jobs: [job], at });
    const second = await runAllTenants({ tenantId: kaizen, jobs: [job], at });
    expect(first[kaizen][job.name]).toBeDefined();
    expect(second[kaizen]).toEqual({});
    expect(calls).toHaveLength(1);
    expect(await rowFor(job.name, at)).toMatchObject({ status: 'completed' });
  });

  it('a malformed cron fails the boot check, naming the job', () => {
    const bad: JobDefinition = {
      name: 'probe.badcron',
      label: 'bad',
      automationClass: 'probe',
      cron: 'every tuesday',
      run: async () => ok,
    };
    expect(() => assertSchedulable([bad])).toThrow(/probe\.badcron/);
  });

  it('every job definition under jobs/ is registered, or is one of the known unregistered HCM jobs', async () => {
    // The HCM job definitions were declared and never scheduled. Their fate is
    // an open decision, so this test names them rather than deciding for them.
    // A new unregistered definition fails here, and so does a registration
    // that retires one of these names without the list being updated.
    const PENDING_DECISION = [
      'hcm_engagement_hr_case_sla_check',
      'hcm_learning_certification_expiry',
      'hcm_learning_mandatory_overdue',
      'runLeaveAccrualJob',
      'runDeriveAttendanceFromClockEventsJob',
      'runCompOffExpiryJob',
    ];
    const jobsDir = fileURLToPath(new URL('../jobs', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) files.push(full);
      }
    };
    walk(jobsDir);

    const registered = new Set(ALL_JOBS.map((j) => j.name));
    const unregistered: string[] = [];
    for (const file of files) {
      if (/\/(scheduler|schedule|runOnce)\.ts$/.test(file)) continue;
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(mod)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        if (!value.every((v) => v && typeof v === 'object' && 'cron' in v && 'name' in v)) continue;
        for (const job of value as JobDefinition[]) {
          if (!registered.has(job.name)) unregistered.push(`${job.name} (${relative(jobsDir, file)}:${exportName})`);
        }
      }
    }
    expect(unregistered.map((u) => u.split(' ')[0]).sort()).toEqual([...PENDING_DECISION].sort());
  });
});
