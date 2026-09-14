/**
 * Technology — portfolio and budget (docs/plan/cio.md, workstream G).
 *
 * Pure types and pure arithmetic only: the state machines an initiative and
 * a tech-debt item run through, and the maths a financial year, its elapsed
 * fraction and a burn-ahead margin need — none of it touches a database, so
 * the same functions decide what a screen renders and what the job and the
 * tests check.
 */

import { createMachine, type Machine } from '../hr.js';
import type { ItSummaryBase } from './common.js';

// ---------------------------------------------------------------------------
// Themes, categories, RAG
// ---------------------------------------------------------------------------

export const IT_THEMES = ['run', 'grow', 'transform'] as const;
export type ItTheme = (typeof IT_THEMES)[number];

export const IT_RAG_STATUSES = ['green', 'amber', 'red'] as const;
export type ItRagStatus = (typeof IT_RAG_STATUSES)[number];

export const IT_BUDGET_CATEGORIES = ['licences', 'hardware', 'vendors', 'cloud', 'people', 'other'] as const;
export type ItBudgetCategory = (typeof IT_BUDGET_CATEGORIES)[number];

export const IT_BUDGET_KINDS = ['run', 'grow'] as const;
export type ItBudgetKind = (typeof IT_BUDGET_KINDS)[number];

export const IT_BUDGET_LINE_STATUSES = ['draft', 'approved'] as const;
export type ItBudgetLineStatus = (typeof IT_BUDGET_LINE_STATUSES)[number];

export const IT_TECH_DEBT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ItTechDebtSeverity = (typeof IT_TECH_DEBT_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Initiative stage machine
// ---------------------------------------------------------------------------

export type ItInitiativeStage =
  | 'idea' | 'assessed' | 'approved' | 'in_flight' | 'delivered' | 'benefits_realised' | 'cancelled';

export type ItInitiativeEvent = 'ASSESS' | 'APPROVE' | 'START' | 'DELIVER' | 'REALISE_BENEFITS' | 'CANCEL';

/** Past-tense verb per transition, for the event name and the UI label. */
export const IT_INITIATIVE_VERBS: Record<ItInitiativeEvent, string> = {
  ASSESS: 'assessed',
  APPROVE: 'approved',
  START: 'started',
  DELIVER: 'delivered',
  REALISE_BENEFITS: 'benefits_realised',
  CANCEL: 'cancelled',
};

/**
 * `benefits_realised` is reachable only through `delivered` — there is no
 * arrow from `in_flight` straight to it (IT-INI-002), and `cancelled` is
 * reachable from every state short of `delivered`/`benefits_realised`, which
 * are terminal successes.
 */
export const itInitiativeMachine: Machine<ItInitiativeStage, ItInitiativeEvent> = createMachine<
  ItInitiativeStage,
  ItInitiativeEvent
>('ItInitiative', {
  idea: { ASSESS: 'assessed', CANCEL: 'cancelled' },
  assessed: { APPROVE: 'approved', CANCEL: 'cancelled' },
  approved: { START: 'in_flight', CANCEL: 'cancelled' },
  in_flight: { DELIVER: 'delivered', CANCEL: 'cancelled' },
  delivered: { REALISE_BENEFITS: 'benefits_realised' },
  benefits_realised: {},
  cancelled: {},
});

// ---------------------------------------------------------------------------
// Tech-debt status machine
// ---------------------------------------------------------------------------

export type ItTechDebtStatus = 'open' | 'planned' | 'in_progress' | 'retired' | 'accepted';
export type ItTechDebtEvent = 'PLAN' | 'START' | 'RETIRE' | 'ACCEPT' | 'REOPEN';

export const IT_TECH_DEBT_VERBS: Record<ItTechDebtEvent, string> = {
  PLAN: 'planned',
  START: 'started',
  RETIRE: 'retired',
  ACCEPT: 'accepted',
  REOPEN: 'reopened',
};

export const itTechDebtMachine: Machine<ItTechDebtStatus, ItTechDebtEvent> = createMachine<
  ItTechDebtStatus,
  ItTechDebtEvent
>('ItTechDebt', {
  open: { PLAN: 'planned', RETIRE: 'retired', ACCEPT: 'accepted' },
  planned: { START: 'in_progress', RETIRE: 'retired', ACCEPT: 'accepted' },
  in_progress: { RETIRE: 'retired', ACCEPT: 'accepted' },
  accepted: { RETIRE: 'retired', REOPEN: 'open' },
  retired: {},
});

// ---------------------------------------------------------------------------
// Financial-year arithmetic — pure, no DB
// ---------------------------------------------------------------------------

/** `FY2026-27` -> the calendar year the FY starts in, `2026`. */
export function parseFy(fy: string): number | null {
  const m = /^FY(\d{4})-(\d{2})$/.exec(fy.trim());
  if (!m) return null;
  const startYear = Number(m[1]);
  const shortEnd = Number(m[2]);
  // The second half must be the next year's last two digits.
  if ((startYear + 1) % 100 !== shortEnd) return null;
  return startYear;
}

export function formatFy(startYear: number): string {
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The FY containing `at` (India's April-March year), as `FY2026-27`. */
export function fyFor(at: Date): string {
  const y = at.getUTCFullYear();
  const startYear = at.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April, 0-indexed
  return formatFy(startYear);
}

export interface FyWindow {
  start: Date;
  end: Date;
}

/** 1 April of the FY's start year (inclusive) to 1 April the following year (exclusive). */
export function fyWindow(fy: string): FyWindow {
  const startYear = parseFy(fy);
  if (startYear === null) throw new Error(`Not a financial year in the FYyyyy-yy shape: '${fy}'.`);
  return {
    start: new Date(Date.UTC(startYear, 3, 1)),
    end: new Date(Date.UTC(startYear + 1, 3, 1)),
  };
}

/**
 * The fraction of the FY elapsed as of `now`, clamped to `[0, 1]` — 0 before
 * the FY starts, 1 once it has ended.
 */
export function fyElapsedFraction(fy: string, now: Date): number {
  const { start, end } = fyWindow(fy);
  if (now.getTime() <= start.getTime()) return 0;
  if (now.getTime() >= end.getTime()) return 1;
  return (now.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}

export interface BurnAheadResult {
  /** planned > 0 ? actual / planned : (actual > 0 ? Infinity : 0) */
  burnFraction: number;
  /** burnFraction - elapsedFraction, as a plain fraction (0.15 = 15 points ahead). */
  aheadBy: number;
  /** Whether `aheadBy` exceeds `marginPct` (a percentage, e.g. 15). */
  exceeds: boolean;
}

/**
 * Whether spend is running ahead of the FY's own elapsed clock by more than
 * `marginPct` — e.g. 60% of the year gone but 80% of the budget spent, on a
 * 15% margin, is 20 points ahead and exceeds it.
 */
export function burnAhead(planned: number, actual: number, elapsedFraction: number, marginPct: number): BurnAheadResult {
  const burnFraction = planned > 0 ? actual / planned : actual > 0 ? Infinity : 0;
  const aheadBy = burnFraction - elapsedFraction;
  return { burnFraction, aheadBy, exceeds: aheadBy > marginPct / 100 };
}

export interface ParsedQuarter {
  fy: string;
  quarter: 1 | 2 | 3 | 4;
}

/** `'FY2026-27 Q3'` -> `{ fy: 'FY2026-27', quarter: 3 }`, or `null` if malformed. */
export function parseQuarter(value: string): ParsedQuarter | null {
  const m = /^(FY\d{4}-\d{2})\s+Q([1-4])$/.exec(value.trim());
  if (!m) return null;
  if (parseFy(m[1]) === null) return null;
  return { fy: m[1], quarter: Number(m[2]) as 1 | 2 | 3 | 4 };
}

export function formatQuarter(fy: string, quarter: 1 | 2 | 3 | 4): string {
  return `${fy} Q${quarter}`;
}

// ---------------------------------------------------------------------------
// RAG rollup
// ---------------------------------------------------------------------------

export interface RagCounts {
  green: number;
  amber: number;
  red: number;
  total: number;
  /** The worst band present — red beats amber beats green — or null with nothing to roll up. */
  worst: ItRagStatus | null;
}

const RAG_RANK: Record<ItRagStatus, number> = { green: 0, amber: 1, red: 2 };

/** Rolls a set of RAG-carrying rows into counts and the worst band present. */
export function ragRollup(rows: Array<{ rag: string | null }>): RagCounts {
  const counts: RagCounts = { green: 0, amber: 0, red: 0, total: 0, worst: null };
  for (const row of rows) {
    if (row.rag !== 'green' && row.rag !== 'amber' && row.rag !== 'red') continue;
    counts[row.rag] += 1;
    counts.total += 1;
    if (counts.worst === null || RAG_RANK[row.rag] > RAG_RANK[counts.worst]) counts.worst = row.rag;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// View shapes shared between the domain and the web (documented, not enforced)
// ---------------------------------------------------------------------------

export interface ItPortfolioSummary extends ItSummaryBase {
  byStage: Record<ItInitiativeStage, number>;
  byRag: RagCounts;
}

/**
 * `planned`/`actual`/`variance` are `null` rather than a number whenever the
 * viewer does not hold `it_budgets:F` — present-but-withheld, the platform's
 * usual masking shape, never a silently zeroed figure (see
 * `maskBudgetMoney` in `domains/it/portfolio.ts`).
 */
export interface ItBudgetCategoryLine {
  category: ItBudgetCategory;
  planned: number | null;
  actual: number | null;
  variance: number | null;
}

export interface ItBudgetDivisionLine {
  division: string;
  planned: number | null;
  actual: number | null;
  variance: number | null;
  run: number;
  grow: number;
}

export interface ItBudgetSummary extends ItSummaryBase {
  fy: string | null;
  plannedTotal: number | null;
  actualTotal: number | null;
  byCategory: ItBudgetCategoryLine[];
  byDivision: ItBudgetDivisionLine[];
  runTotal: number;
  growTotal: number;
}

export interface ItTechDebtSummary extends ItSummaryBase {
  bySeverity: Record<ItTechDebtSeverity, number>;
  openCount: number;
}
