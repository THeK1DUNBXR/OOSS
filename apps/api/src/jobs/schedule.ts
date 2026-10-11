/**
 * When a job is actually due.
 *
 * `startScheduler` took an interval — one hour by default — and fired *every*
 * registered job on it, for every tenant, ignoring the `cron` string each job
 * declares. Sixteen jobs declare one. Thirteen of them are daily, so they ran
 * twenty-four times a day; the escalation ladders sent a day's worth of
 * notifications every day. One job asks to run every thirty
 * minutes and therefore ran at *half* the rate it asked for. `AutomationDefinition.cronExpression` is
 * persisted and shown in the admin UI the whole time, so the product reported a
 * schedule that did not exist.
 *
 * Everything here is pure and takes an explicit `now`, so the behaviour can be
 * tested by simulating a day of ticks rather than waiting one.
 */

import { Cron } from 'croner';

/** IST. Every declared cron in this product means a local wall-clock time. */
export const SCHEDULE_TZ = 'Asia/Kolkata';

/** How often the scheduler wakes. Fine enough for a half-hourly job. */
export const TICK_MS = 60_000;

/** Retries before a claim is dead-lettered rather than tried again. */
export const MAX_ATTEMPTS = 4;

const parsed = new Map<string, Cron>();

/**
 * Parsed once per expression. Croner objects are cheap but not free, and the
 * tick runs this for every job on every tenant.
 */
function cron(expression: string): Cron {
  let c = parsed.get(expression);
  if (!c) {
    // `noOverwrite` keeps croner from scheduling anything itself: this is used
    // as a calculator, never as a timer. The timer is the caller's.
    c = new Cron(expression, { timezone: SCHEDULE_TZ, paused: true });
    parsed.set(expression, c);
  }
  return c;
}

/** True when the expression parses. Used to fail a bad job definition loudly. */
export function isValidCron(expression: string): boolean {
  try {
    cron(expression);
    return true;
  } catch {
    return false;
  }
}

/** The next time this expression fires strictly after `from`. */
export function nextFireAfter(expression: string, from: Date): Date | null {
  return cron(expression).nextRun(from) ?? null;
}

/**
 * The most recent occurrence at or before `now`, and never earlier than
 * `notBefore`.
 *
 * This is the value that gets claimed, and it is why two instances ticking a
 * second apart agree: both compute the same occurrence, so the second one's
 * insert collides with the first one's and it stands down. Deriving the claim
 * from `now` instead would give them different keys and let both run.
 *
 * `notBefore` is `now - CATCH_UP_MS`. A scheduler that was down for hours
 * should not fire the missed occurrences on restart; it fires the one that is
 * genuinely current, if any. The window must be wide enough to hold the
 * occurrence a late tick is catching up, which is why it is hours, not a tick.
 */
export function dueOccurrence(expression: string, now: Date, notBefore: Date): Date | null {
  const c = cron(expression);
  // croner has no "previous run" for a paused instance, so walk forward from
  // the window's start. The window is at most CATCH_UP_MS, which is bounded
  // by the walk limit below for every cadence the product uses.
  let cursor = c.nextRun(new Date(notBefore.getTime() - 1));
  let last: Date | null = null;
  // Bounded: a window wider than a handful of occurrences means the scheduler
  // was down, and firing the most recent one is the right answer anyway.
  for (let i = 0; i < 1000 && cursor && cursor.getTime() <= now.getTime(); i++) {
    last = cursor;
    cursor = c.nextRun(cursor);
  }
  return last;
}

/**
 * Every occurrence in `[from, to]`. Only used by the tests, which simulate a
 * day of ticking to assert a daily job fires once rather than twenty-four
 * times — the exact defect this module replaces.
 */
export function occurrencesBetween(expression: string, from: Date, to: Date): Date[] {
  const c = cron(expression);
  const out: Date[] = [];
  let cursor = c.nextRun(new Date(from.getTime() - 1));
  while (cursor && cursor.getTime() <= to.getTime() && out.length < 10_000) {
    out.push(cursor);
    cursor = c.nextRun(cursor);
  }
  return out;
}

/**
 * Exponential backoff with a cap, in milliseconds: 1m, 4m, 9m, 16m.
 *
 * Quadratic rather than doubling because these jobs are minutes-scale and a
 * doubling ladder reaches hours by the fourth attempt, which is past the point
 * where a daily job's next occurrence makes the retry moot.
 */
export function backoffMs(attempt: number): number {
  const capped = Math.min(Math.max(attempt, 1), MAX_ATTEMPTS);
  return Math.min(capped * capped * 60_000, 30 * 60_000);
}

/**
 * How far back a tick looks for an occurrence it has not yet run.
 *
 * A one-tick window meant a tick that landed 90 seconds after 06:00 found no
 * due occurrence and the daily job did not run that day. Six hours covers any
 * realistic restart or deploy window. It is capped at one occurrence per job
 * (`dueOccurrence` returns the latest), so an outage never replays a backlog.
 */
export const CATCH_UP_MS = 6 * 60 * 60_000;

/**
 * The lease proves the holder is alive. It is renewed every `HEARTBEAT_MS`, so
 * a holder that dies is noticed within one lease. It is not the job timeout:
 * a long but healthy job keeps its lease by heartbeating, and a hung one stops
 * heartbeating and is timed out separately.
 */
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
