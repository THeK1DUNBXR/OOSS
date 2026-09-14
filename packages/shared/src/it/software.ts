/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B).
 *
 * The pure arithmetic `apps/api/src/domains/it/software.ts` and its screens
 * share, and the lifecycle machine an application's status runs through.
 * Nothing here reads a database: annualised cost, seat utilisation and which
 * renewal-ladder rung a term has crossed are all computed from numbers
 * passed in (IT-LIC-004 and friends), so they are tested without one.
 *
 * The platform does not meter SaaS logins (docs/plan/cio.md Principle 7):
 * `seatsInUse` is typed in by whoever manages the licence, never read off a
 * login count, and every screen that shows it says so.
 */

import { createMachine, type Machine } from '../hr.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const IT_APPLICATION_HOSTING = ['saas', 'on_prem', 'cloud'] as const;
export type ItApplicationHosting = (typeof IT_APPLICATION_HOSTING)[number];

export const IT_DATA_CLASSIFICATIONS = ['internal', 'confidential', 'restricted', 'regulated'] as const;
export type ItDataClassification = (typeof IT_DATA_CLASSIFICATIONS)[number];

export const IT_LICENCE_KINDS = ['per_seat', 'site', 'perpetual', 'usage'] as const;
export type ItLicenceKind = (typeof IT_LICENCE_KINDS)[number];

export const IT_BILLING_CYCLES = ['monthly', 'quarterly', 'annual', 'one_off'] as const;
export type ItBillingCycle = (typeof IT_BILLING_CYCLES)[number];

export const IT_LICENCE_STATUSES = ['active', 'expiring', 'expired', 'cancelled'] as const;
export type ItLicenceStatus = (typeof IT_LICENCE_STATUSES)[number];

export const IT_LICENCE_EVENT_KINDS = [
  'seats_changed',
  'renewal_proposed',
  'renewal_approved',
  'renewal_declined',
  'cancelled',
] as const;
export type ItLicenceEventKind = (typeof IT_LICENCE_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Application lifecycle — evaluating -> active -> sunsetting -> retired
// ---------------------------------------------------------------------------

export type ItApplicationStatus = 'evaluating' | 'active' | 'sunsetting' | 'retired';

export type ItApplicationEvent = 'ACTIVATE' | 'SUNSET' | 'RETIRE' | 'REJECT';

/** Past-tense verb per transition, for the event name and the audit trail. */
export const IT_APPLICATION_EVENT_VERB: Record<ItApplicationEvent, string> = {
  ACTIVATE: 'activated',
  SUNSET: 'sunset',
  RETIRE: 'retired',
  REJECT: 'rejected',
};

/**
 * `retired` is the only terminal state and is reachable from every other
 * state — a live application can be cut off directly, an application still
 * being evaluated can be rejected outright, and the ordinary path runs
 * through `sunsetting` first. There is no way back out of `retired`.
 */
export const itApplicationMachine: Machine<ItApplicationStatus, ItApplicationEvent> = createMachine<
  ItApplicationStatus,
  ItApplicationEvent
>('ItApplication', {
  evaluating: { ACTIVATE: 'active', REJECT: 'retired' },
  active: { SUNSET: 'sunsetting', RETIRE: 'retired' },
  sunsetting: { RETIRE: 'retired', ACTIVATE: 'active' },
  retired: {},
});

// ---------------------------------------------------------------------------
// Annualised cost (pure arithmetic, no DB — IT-LIC-004)
// ---------------------------------------------------------------------------

const BILLING_PERIODS_PER_YEAR: Record<ItBillingCycle, number> = {
  monthly: 12,
  quarterly: 4,
  annual: 1,
  // A one-off cost has no period to annualise — it is what it is, once.
  one_off: 1,
};

/**
 * Normalises a licence's cost-per-period to one annual figure, whatever the
 * billing cycle, so applications and licences can be compared and summed on
 * one basis (IT-LIC-004).
 */
export function annualisedCost(costPerPeriod: number, billingCycle: ItBillingCycle): number {
  if (!Number.isFinite(costPerPeriod) || costPerPeriod < 0) return 0;
  return costPerPeriod * BILLING_PERIODS_PER_YEAR[billingCycle];
}

// ---------------------------------------------------------------------------
// Seat utilisation (pure arithmetic, no DB — IT-LIC-002)
// ---------------------------------------------------------------------------

export interface SeatUtilisation {
  /** null when nothing has been purchased — "not yet measured", not 0%. */
  percent: number | null;
  overAllocated: boolean;
}

/** Seats in use against seats purchased. Over-allocation (in use > purchased)
 * is a plain fact regardless of whether a percentage can be computed. */
export function seatUtilisation(purchased: number, inUse: number): SeatUtilisation {
  const overAllocated = inUse > purchased;
  const percent = purchased > 0 ? Math.round((inUse / purchased) * 1000) / 10 : null;
  return { percent, overAllocated };
}

/**
 * A licence is under-used when its utilisation falls below the dated
 * threshold's percentage, and only when it carries at least the threshold's
 * minimum seat count — a two-seat licence at 50% is not a finding worth
 * raising.
 */
export function isUnderUsed(
  purchased: number,
  inUse: number,
  underUsePercent: number,
  underUseMinSeats: number,
): boolean {
  if (purchased < underUseMinSeats) return false;
  const { percent } = seatUtilisation(purchased, inUse);
  return percent !== null && percent < underUsePercent;
}

// ---------------------------------------------------------------------------
// Renewal ladder (pure arithmetic, no DB — IT-LIC-001)
// ---------------------------------------------------------------------------

/** Only used when a tenant's `ItSoftwareThreshold` row is unavailable at the
 * call site — the seeded row is the one actually in force (Principle 4). */
export const DEFAULT_IT_LICENCE_RENEWAL_RUNGS = [90, 60, 30, 7, 0] as const;

/**
 * Which renewal-ladder rung `daysLeft` has crossed — the tightest (smallest)
 * rung still at or above `daysLeft`, or `null` when the renewal is outside
 * every rung. `rungs` need not be pre-sorted. Mirrors `CALENDAR_LADDER_RUNGS`
 * reasoning in `packages/shared/src/compliance/calendar.ts`: the widest rung
 * crossed is mildest, the tightest is what describes the situation now.
 */
export function renewalRung(daysLeft: number, rungs: readonly number[] = DEFAULT_IT_LICENCE_RENEWAL_RUNGS): number | null {
  const sorted = [...rungs].sort((a, b) => b - a);
  const crossed = sorted.filter((r) => daysLeft <= r);
  if (!crossed.length) return null;
  return crossed[crossed.length - 1];
}

/** Whole days between `now` and `date` — negative once `date` has passed. */
export function daysUntilLicenceDate(date: Date, now: Date = new Date()): number {
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Summary aggregation (pure arithmetic, no DB)
// ---------------------------------------------------------------------------

/** Sums annualised cost across licences — the caller passes each licence's
 * own `costPerPeriod`/`billingCycle` pair already resolved to a number. */
export function totalAnnualisedSpend(licences: Array<{ costPerPeriod: number; billingCycle: ItBillingCycle }>): number {
  return licences.reduce((sum, l) => sum + annualisedCost(l.costPerPeriod, l.billingCycle), 0);
}

// ---------------------------------------------------------------------------
// View types shared between the API and the screens
// ---------------------------------------------------------------------------

export interface ItApplicationsSummary {
  notYetMeasured: boolean;
  byTier: Record<string, number>;
  byHosting: Record<ItApplicationHosting, number>;
  byStatus: Record<ItApplicationStatus, number>;
  unowned: number;
}

export interface ItLicencesSummary {
  notYetMeasured: boolean;
  annualisedSpend: number;
  annualisedSpendByApplication: Array<{ applicationId: string; applicationName: string; annualisedCost: number }>;
  renewingIn90Days: number;
  overAllocated: number;
  underUsed: number;
  seatsPurchased: number;
  seatsInUse: number;
}
