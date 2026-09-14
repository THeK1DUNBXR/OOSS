/**
 * Technology workstream `continuity` (docs/plan/cio.md, workstream H).
 *
 * Pure arithmetic and the view types the API and the screens share. Nothing
 * here touches a database — every function takes plain values in and returns
 * a plain value out, so the acceptance tests exercise the maths without a
 * fixture.
 */

import { createMachine, type Machine } from '../hr.js';
import type { ItSummaryBase, ItTier } from './common.js';

// ---------------------------------------------------------------------------
// Dated defaults — data, not constants buried in domain code (Principle 4).
// ---------------------------------------------------------------------------

/** Default DR-test cadence when a plan does not name its own: 180 days for a
 * tier-1 application, 365 for everything else. Applied once, at plan
 * creation, by the domain layer — never recomputed later against a plan's
 * stored `testCadenceDays`. */
export const DEFAULT_TEST_CADENCE_DAYS: Record<'tier1' | 'other', number> = {
  tier1: 180,
  other: 365,
};

export function defaultTestCadenceDays(applicationTier: number): number {
  return applicationTier === 1 ? DEFAULT_TEST_CADENCE_DAYS.tier1 : DEFAULT_TEST_CADENCE_DAYS.other;
}

/** The DR-test-overdue ladder: days relative to the due date
 * (`lastTestedAt + testCadenceDays`). -7 fires a week before the cadence
 * runs out, 0 fires the day it does, +30 fires a month past it — ascending,
 * the mirror image of `CALENDAR_LADDER_RUNGS`'s descending shape, because
 * this ladder is read as "how overdue", not "how soon". */
export const TEST_OVERDUE_LADDER_RUNGS = [-7, 0, 30] as const;
export type TestOverdueRung = (typeof TEST_OVERDUE_LADDER_RUNGS)[number];

const MS_PER_DAY = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

/**
 * Uptime %, computed over the minutes in the given calendar month —
 * never stored (IT-AVL-001). `period` is `YYYY-MM`. Clamped to [0, 100]:
 * `minutesDown` beyond the month's own length is a data-entry problem, not a
 * negative uptime.
 */
export function uptimePercent(minutesDown: number, period: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`uptimePercent: period must be YYYY-MM, got "${period}"`);
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-12
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const totalMinutes = daysInMonth * 24 * 60;
  const down = Math.min(Math.max(minutesDown, 0), totalMinutes);
  const pct = ((totalMinutes - down) / totalMinutes) * 100;
  return Math.round(pct * 100) / 100;
}

/**
 * Which rung of the DR-test-overdue ladder `now` has crossed, given the plan
 * was last tested `lastTestedAt` (or never) on a `cadenceDays` cycle.
 * Returns `undefined` before the earliest rung (not yet due for a test).
 * A plan never tested is treated as already at the due date (day zero of the
 * cadence) — nothing to measure the cadence from, so it is due now, not
 * indefinitely in the future.
 */
export function testOverdueRung(lastTestedAt: Date | null, cadenceDays: number, now: Date): number | undefined {
  const dueAt = lastTestedAt ? new Date(lastTestedAt.getTime() + cadenceDays * MS_PER_DAY) : now;
  const daysOverdue = daysBetween(now, dueAt); // positive once past due, negative before
  const crossed = TEST_OVERDUE_LADDER_RUNGS.filter((r) => daysOverdue >= r);
  return crossed.length ? crossed[crossed.length - 1] : undefined;
}

/**
 * Whether a recorded test breached its plan's promise — either the recovery
 * took longer than the RTO, or more data was lost than the RPO allows. Pure:
 * takes the two figures in, never re-reads the database.
 */
export function rtoBreached(
  test: { actualRecoveryMinutes?: number | null; actualDataLossMinutes?: number | null },
  plan: { rtoMinutes: number; rpoMinutes: number },
): boolean {
  const rtoExceeded = test.actualRecoveryMinutes != null && test.actualRecoveryMinutes > plan.rtoMinutes;
  const rpoExceeded = test.actualDataLossMinutes != null && test.actualDataLossMinutes > plan.rpoMinutes;
  return rtoExceeded || rpoExceeded;
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export type ContinuityPlanStatus = 'draft' | 'active' | 'retired';
export type ContinuityTestKind = 'restore' | 'failover' | 'tabletop';
export type ContinuityTestOutcome = 'pass' | 'fail' | 'partial';
export type MaintenanceWindowStatus = 'planned' | 'in_progress' | 'done' | 'cancelled';
export type AvailabilityReadingSource = 'typed' | 'incidents';

// ---------------------------------------------------------------------------
// Lifecycle: the continuity plan's status machine, run through
// `platform/lifecycle.ts`'s generic `transition`/`availableTransitions` so
// the domain layer never hand-rolls a transition table (and a button on
// screen can never drift from what this machine actually allows).
// ---------------------------------------------------------------------------

export type ContinuityPlanEvent = 'ACTIVATE' | 'RETIRE';

/** `draft -> active -> retired`, retired terminal — a plan needed again is a
 * new plan, the same "correction is a new row" discipline the platform
 * keeps for anything append-only adjacent. */
export const itContinuityPlanMachine: Machine<ContinuityPlanStatus, ContinuityPlanEvent> = createMachine(
  'ItContinuityPlan',
  {
    draft: { ACTIVATE: 'active' },
    active: { RETIRE: 'retired' },
    retired: {},
  },
);

export interface ContinuitySummary extends ItSummaryBase {
  plansByTier: Record<number, number>;
  plansByStatus: Record<ContinuityPlanStatus, number>;
  tier1Tested: { count: number; total: number; fraction: number | null };
  testsOverdue: number;
  availabilityLastMonth: {
    notYetMeasured: boolean;
    period: string | null;
    meanUptimePercent: number | null;
    worstApplication: { applicationId: string; applicationName: string; uptimePercent: number } | null;
  };
  nextMaintenanceWindows: number;
}

export const CONTINUITY_TIERS: readonly ItTier[] = [1, 2, 3, 4] as const;
