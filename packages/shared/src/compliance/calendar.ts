/**
 * Compliance calendar — types and the pure due-date arithmetic
 * (docs/plan/compliance.md, workstream A).
 *
 * `nextDueDates` takes a type's due-date rule and produces the periods and
 * due dates a horizon covers. It needs no database — every statutory number
 * (which day, which month) lives in `dueRule`, never as a constant here
 * (Principle 1) — so it is exercised directly by unit tests in
 * `apps/api/src/tests/compliance/calendar.test.ts`.
 */

import { financialYearOf, monthKey } from '../finance.js';

export const COMPLIANCE_DOMAINS = ['fin', 'hr', 'gov', 'edu'] as const;
export type ComplianceDomain = (typeof COMPLIANCE_DOMAINS)[number];

export const COMPLIANCE_RECURRENCES = ['monthly', 'quarterly', 'half_yearly', 'annual', 'one_off'] as const;
export type ComplianceRecurrence = (typeof COMPLIANCE_RECURRENCES)[number];

export const COMPLIANCE_OBLIGATION_STATUSES = ['upcoming', 'due', 'filed', 'overdue', 'waived'] as const;
export type ComplianceObligationStatus = (typeof COMPLIANCE_OBLIGATION_STATUSES)[number];

/** A single `{month, day}` calendar date, `month` 1-12. */
export interface MonthDay {
  month: number;
  day: number;
  /** The due date falls in the year after the period's own year — used for a
   * quarter or half whose deadline lands in the following calendar year
   * (Oct-Dec TDS returns, due the following 31 January). */
  yearOffset?: number;
}

/**
 * The due-date rule, stored as `ComplianceObligationType.dueRule`. Which
 * shape applies follows from the type's `recurrence`:
 *
 *   monthly     — `{ day }`: due on `day` of the month after the one the
 *                 obligation covers. `overrides` keys a source month
 *                 (`"3"`-`"12"`, 1-indexed, no leading zero) to a different
 *                 due `{ month, day }` entirely — TDS deposit is the 7th of
 *                 next month except for March, due 30 April.
 *   quarterly   — `{ quarterDates: [Q1, Q2, Q3, Q4] }`, one `MonthDay` per
 *                 calendar quarter (Q1 Jan-Mar ... Q4 Oct-Dec) the period
 *                 covers.
 *   half_yearly — `{ halfYearDates: [H1, H2] }`, one `MonthDay` per FY half
 *                 (H1 Apr-Sep, H2 Oct-Mar) the period covers.
 *   annual      — either `{ month, day }`, a fixed calendar date every year,
 *                 or `{ monthsAfterFyEnd, day }`, a date computed as `day` of
 *                 the month `monthsAfterFyEnd` months after the financial
 *                 year's end (31 March).
 *   one_off     — `{ date }`, an ISO date string; fires once, if it falls
 *                 inside the horizon.
 */
export type ComplianceDueRule =
  | { day: number; overrides?: Record<string, MonthDay> }
  | { month: number; day: number }
  | { monthsAfterFyEnd: number; day: number }
  | { quarterDates: [MonthDay, MonthDay, MonthDay, MonthDay] }
  | { halfYearDates: [MonthDay, MonthDay] }
  | { date: string };

export interface DueDateOccurrence {
  /** `YYYY-MM` (monthly), `YYYY-QN` (quarterly), `YYYY-HN` (half-yearly),
   * `YYYY` (annual, calendar-year rule) or `FY2026-27` (annual,
   * FY-end-relative rule, and one-off). */
  period: string;
  dueAt: Date;
}

function utc(year: number, month1: number, day: number): Date {
  // `month1` is 1-indexed; `Date.UTC` wants 0-indexed, and rolls a day past
  // the month's end forward automatically — never a wall we hit here since
  // every rule is a statutory calendar date.
  return new Date(Date.UTC(year, month1 - 1, day));
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function inHorizon(dueAt: Date, from: Date, to: Date): boolean {
  return dueAt.getTime() >= from.getTime() && dueAt.getTime() < to.getTime();
}

/** Calendar quarter (1-4) a UTC month (0-indexed) falls in. */
function quarterOfMonth0(month0: number): number {
  return Math.floor(month0 / 3) + 1;
}

/**
 * Produces every occurrence whose due date falls inside
 * `[fromDate, fromDate + months)`, given `rule` and the type's `recurrence`.
 *
 * A short lookback beyond `fromDate` is scanned on the source side (the
 * period a due date is computed *from*) so a period that started before
 * `fromDate` but whose due date still lands inside the horizon is not missed
 * — GSTR-3B for August is due the 20th of September, so scanning only
 * September-onward source months would miss it if `fromDate` fell early in
 * September.
 */
export function nextDueDates(
  rule: ComplianceDueRule,
  recurrence: ComplianceRecurrence,
  fromDate: Date,
  months: number,
): DueDateOccurrence[] {
  const horizonEnd = addMonthsUtc(fromDate, months);
  const out: DueDateOccurrence[] = [];

  if (recurrence === 'monthly' && 'day' in rule) {
    const monthlyRule = rule as { day: number; overrides?: Record<string, MonthDay> };
    // Scan one month either side of the horizon: the source month behind
    // `fromDate` can still have a due date inside it.
    let cursor = addMonthsUtc(fromDate, -1);
    while (cursor.getTime() < horizonEnd.getTime()) {
      const sourceMonth1 = cursor.getUTCMonth() + 1;
      const override = monthlyRule.overrides?.[String(sourceMonth1)];
      const due = override
        ? utc(cursor.getUTCFullYear(), override.month, override.day)
        : (() => {
            const next = addMonthsUtc(cursor, 1);
            return utc(next.getUTCFullYear(), next.getUTCMonth() + 1, monthlyRule.day);
          })();
      // An override due date can land in the following calendar year's
      // reckoning only via `overrides` naming the month directly, so no year
      // roll is needed beyond what `utc()` above already does.
      if (inHorizon(due, fromDate, horizonEnd)) {
        out.push({ period: monthKey(cursor), dueAt: due });
      }
      cursor = addMonthsUtc(cursor, 1);
    }
    return out;
  }

  if (recurrence === 'quarterly' && 'quarterDates' in rule) {
    let cursor = addMonthsUtc(fromDate, -3);
    while (cursor.getTime() < horizonEnd.getTime()) {
      const q = quarterOfMonth0(cursor.getUTCMonth());
      const md = rule.quarterDates[q - 1];
      const dueYear = cursor.getUTCFullYear() + (md.yearOffset ?? 0);
      const due = utc(dueYear, md.month, md.day);
      if (inHorizon(due, fromDate, horizonEnd)) {
        out.push({ period: `${cursor.getUTCFullYear()}-Q${q}`, dueAt: due });
      }
      cursor = addMonthsUtc(cursor, 3);
    }
    return out;
  }

  if (recurrence === 'half_yearly' && 'halfYearDates' in rule) {
    let cursor = addMonthsUtc(fromDate, -6);
    while (cursor.getTime() < horizonEnd.getTime()) {
      // H1 = Apr-Sep, H2 = Oct-Mar, following the Indian financial year.
      const month0 = cursor.getUTCMonth();
      const fyStartYear = month0 >= 3 ? cursor.getUTCFullYear() : cursor.getUTCFullYear() - 1;
      const half = month0 >= 3 && month0 <= 8 ? 1 : 2;
      const md = rule.halfYearDates[half - 1];
      const dueYear = fyStartYear + (md.yearOffset ?? 0);
      const due = utc(dueYear, md.month, md.day);
      if (inHorizon(due, fromDate, horizonEnd)) {
        out.push({ period: `FY${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}-H${half}`, dueAt: due });
      }
      cursor = addMonthsUtc(cursor, 6);
    }
    return out;
  }

  if (recurrence === 'annual' && 'month' in rule && 'day' in rule) {
    let year = fromDate.getUTCFullYear() - 1;
    const endYear = horizonEnd.getUTCFullYear() + 1;
    while (year <= endYear) {
      const due = utc(year, rule.month, rule.day);
      if (inHorizon(due, fromDate, horizonEnd)) {
        out.push({ period: String(year), dueAt: due });
      }
      year += 1;
    }
    return out;
  }

  if (recurrence === 'annual' && 'monthsAfterFyEnd' in rule) {
    // The financial year ends 31 March; `monthsAfterFyEnd` months after that,
    // on `rule.day`.
    let fyStartYear = fromDate.getUTCFullYear() - 2;
    const endYear = horizonEnd.getUTCFullYear() + 1;
    while (fyStartYear <= endYear) {
      const fyEnd = utc(fyStartYear + 1, 3, 31);
      const dueMonthDate = addMonthsUtc(fyEnd, rule.monthsAfterFyEnd);
      const due = utc(dueMonthDate.getUTCFullYear(), dueMonthDate.getUTCMonth() + 1, rule.day);
      if (inHorizon(due, fromDate, horizonEnd)) {
        out.push({ period: financialYearOf(utc(fyStartYear, 6, 1)), dueAt: due });
      }
      fyStartYear += 1;
    }
    return out;
  }

  if (recurrence === 'one_off' && 'date' in rule) {
    const due = new Date(rule.date);
    if (inHorizon(due, fromDate, horizonEnd)) {
      out.push({ period: rule.date.slice(0, 10), dueAt: due });
    }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// View shapes shared between the API and the web screen.
// ---------------------------------------------------------------------------

export interface ComplianceObligationTypeView {
  id: string;
  code: string;
  label: string;
  governingLaw: string;
  section: string | null;
  domain: ComplianceDomain;
  recurrence: ComplianceRecurrence;
  dueRule: ComplianceDueRule;
  ownerRoleSlug: string;
  evidenceRequired: boolean;
  active: boolean;
  note: string | null;
}

export interface ComplianceObligationView {
  id: string;
  recordCode: string | null;
  typeId: string;
  typeCode: string;
  typeLabel: string;
  domain: ComplianceDomain;
  governingLaw: string;
  section: string | null;
  ownerRoleSlug: string;
  period: string;
  dueAt: string;
  status: ComplianceObligationStatus;
  evidenceRequired: boolean;
  filedAt: string | null;
  filedById: string | null;
  evidenceDocumentId: string | null;
  reference: string | null;
  note: string | null;
}

export interface ComplianceCalendarSummary {
  /** `true` when the tenant has no obligation types materialised yet — "not
   * yet measured", not a claim that nothing is due. */
  notYetMeasured: boolean;
  byStatus: Record<ComplianceObligationStatus, number>;
  byDomain: Record<ComplianceDomain, number>;
  /** Filed within the financial year in progress, for the "filed this FY" tile. */
  filedThisFy: number;
}

/** Ladder rungs (days before due, and one after) the daily job fires on. */
export const CALENDAR_LADDER_RUNGS = [30, 7, 1, -1] as const;
