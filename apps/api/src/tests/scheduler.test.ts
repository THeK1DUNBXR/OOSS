/**
 * The scheduler fires what the cron says, and once.
 *
 * The defect: `startScheduler(intervalMs = 3_600_000)` fired *every* registered
 * job on a single hourly interval and never read the `cron` each job declares.
 * Thirteen of the sixteen are daily, so they ran twenty-four times a day — the
 * escalation ladders sent a day of notifications every day — and the one
 * half-hourly job ran at half its declared rate.
 *
 * These assert against the schedule calculator rather than the clock: a
 * simulated day of one-minute ticks, which is the only way to test "once per
 * day" without waiting one.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  TICK_MS,
  backoffMs,
  dueOccurrence,
  isValidCron,
  leaseFor,
  nextFireAfter,
  occurrencesBetween,
} from '../jobs/schedule.js';
import { ALL_JOBS } from '../jobs/scheduler.js';

/** Drives `dueOccurrence` the way the live tick does: every minute, for a span. */
function simulate(cron: string, from: Date, hours: number): Date[] {
  const fired: Date[] = [];
  const seen = new Set<number>();
  // Exclusive of the far endpoint: 24 hours is 1440 ticks, not 1441, or an
  // hourly job appears to fire 25 times because both midnights are counted.
  for (let t = 0; t < hours * 60; t++) {
    const now = new Date(from.getTime() + t * TICK_MS);
    const due = dueOccurrence(cron, now, new Date(now.getTime() - TICK_MS));
    // The claim's uniqueness is what makes a repeat a no-op in production; the
    // set stands in for it here so this stays a test of the calculator.
    if (due && !seen.has(due.getTime())) {
      seen.add(due.getTime());
      fired.push(due);
    }
  }
  return fired;
}

// Midnight IST, so a "06:00" job lands inside the simulated window.
const midnightIst = new Date('2026-09-11T18:30:00.000Z');

describe('the schedule calculator', () => {
  it('fires a daily job once per day, not twenty-four times', () => {
    const fired = simulate('0 6 * * *', midnightIst, 24);
    expect(fired).toHaveLength(1);
  });

  it('fires a daily job once per day across three days', () => {
    const fired = simulate('0 6 * * *', midnightIst, 72);
    expect(fired).toHaveLength(3);
  });

  it('fires a half-hourly job 48 times a day, not 24', () => {
    // The old scheduler ran this at half its declared rate.
    const fired = simulate('*/30 * * * *', midnightIst, 24);
    expect(fired).toHaveLength(48);
  });

  it('fires an hourly job 24 times a day', () => {
    const fired = simulate('0 * * * *', midnightIst, 24);
    expect(fired).toHaveLength(24);
  });

  it('reads the cron as IST, not UTC', () => {
    // 06:00 IST is 00:30 UTC. Under UTC this lands on the wrong side of
    // midnight, which is the same class of bug as the tax-period one.
    const next = nextFireAfter('0 6 * * *', new Date('2026-09-11T18:30:00.000Z'));
    expect(next?.toISOString()).toBe('2026-09-12T00:30:00.000Z');
  });

  it('gives two instances ticking a second apart the same occurrence to claim', () => {
    // This is what makes the unique constraint a lock: both compute the same
    // value, so the second insert collides. Deriving it from `now` would not.
    const a = new Date('2026-09-12T00:30:20.000Z');
    const b = new Date('2026-09-12T00:30:21.000Z');
    const dueA = dueOccurrence('0 6 * * *', a, new Date(a.getTime() - TICK_MS));
    const dueB = dueOccurrence('0 6 * * *', b, new Date(b.getTime() - TICK_MS));
    expect(dueA).not.toBeNull();
    expect(dueA?.getTime()).toBe(dueB?.getTime());
  });

  it('is silent when nothing is due in the window', () => {
    const quiet = new Date('2026-09-12T09:17:00.000Z'); // 14:47 IST
    expect(dueOccurrence('0 6 * * *', quiet, new Date(quiet.getTime() - TICK_MS))).toBeNull();
  });

  it('does not replay a backlog after an outage', () => {
    // Down for six hours, then back. It should fire the current occurrence, not
    // six hours of missed hourly ones.
    //
    // `0 * * * *` is minute zero of each *IST* hour, which is :30 past each UTC
    // hour — so the most recent occurrence before 06:00:30Z is 05:30Z, not
    // 06:00Z. That offset is the whole reason rule 3 exists.
    const now = new Date('2026-09-12T06:00:30.000Z');
    const due = dueOccurrence('0 * * * *', now, new Date(now.getTime() - 6 * 3600_000));
    expect(due?.toISOString()).toBe('2026-09-12T05:30:00.000Z');
  });

  it('enumerates occurrences for a window', () => {
    const all = occurrencesBetween('0 6 * * *', midnightIst, new Date(midnightIst.getTime() + 72 * 3600_000));
    expect(all).toHaveLength(3);
  });
});

describe('retry and lease arithmetic', () => {
  it('backs off further on each attempt and caps', () => {
    const steps = [1, 2, 3, 4].map(backoffMs);
    expect(steps).toEqual([60_000, 240_000, 540_000, 960_000]);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    expect(backoffMs(99)).toBeLessThanOrEqual(30 * 60_000);
  });

  it('holds a lease past the job timeout, so a slow run is not stolen from', () => {
    const now = new Date('2026-09-12T00:30:00.000Z');
    const timeout = 5 * 60_000;
    expect(leaseFor(now, timeout).getTime()).toBeGreaterThan(now.getTime() + timeout);
  });

  it('gives up after MAX_ATTEMPTS rather than retrying for ever', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThan(10);
  });
});

describe('every registered job', () => {
  it('declares a cron that parses', () => {
    // A cron that does not parse would silently never fire, which is the same
    // invisible failure the rewrite exists to remove. `startScheduler` throws
    // at boot on this; the test says which one.
    const bad = ALL_JOBS.filter((j) => !isValidCron(j.cron));
    expect(bad.map((j) => `${j.name}: ${j.cron}`)).toEqual([]);
  });

  it('declares a cron at all', () => {
    expect(ALL_JOBS.every((j) => typeof j.cron === 'string' && j.cron.length > 0)).toBe(true);
    expect(ALL_JOBS.length).toBeGreaterThan(10);
  });

  it('fires at its declared rate rather than hourly', () => {
    // The regression, stated directly: under the old scheduler every one of
    // these ran 24 times a day regardless of what it asked for.
    const perDay = new Map(ALL_JOBS.map((j) => [j.name, simulate(j.cron, midnightIst, 24).length]));
    const daily = ALL_JOBS.filter((j) => /^\d+ \d+ \* \* \*$/.test(j.cron));
    expect(daily.length).toBeGreaterThan(5);
    for (const j of daily) expect(perDay.get(j.name)).toBe(1);
  });
});
