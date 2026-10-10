import { describe, expect, it } from 'vitest';
import {
  fyFor,
  fyWindow,
  istEndOfDay,
  istFinancialYearStart,
  istMidnight,
  nextDueDates,
  trailingMonths,
  type ComplianceDueRule,
} from '@kaizen/shared';
import { fyOf, fyRange } from '../domains/compliance/tax.js';
import { recordCodeYear } from '../platform/recordCode.js';
import { lastCompleteMonthKey } from '../domains/group.js';
import { lastFullMonthPeriod } from '../domains/it/continuity.js';
import { latestHalfYearEnd } from '../domains/filings.js';
import { periodFor } from '../domains/marketing/budget.js';

// 19:00Z on 31 March is 00:30 IST on 1 April: the first half hour of a new
// period. A UTC-derived month or FY still reads it as the old one.
const FIRST_HALF_HOUR_OF_APRIL = new Date('2026-03-31T19:00:00Z');
const FIRST_HALF_HOUR_OF_MAY = new Date('2026-04-30T19:00:00Z');
// 19:00Z on 31 December is 00:30 IST on 1 January.
const FIRST_HALF_HOUR_OF_JANUARY = new Date('2025-12-31T19:00:00Z');

describe('IST civil periods at the first half hour of a month', () => {
  it('FY start year and FY label follow IST, not UTC', () => {
    expect(istFinancialYearStart(FIRST_HALF_HOUR_OF_APRIL)).toBe(2026);
    expect(istFinancialYearStart(new Date('2026-03-31T18:00:00Z'))).toBe(2025);
  });

  it('IST midnight and end-of-day instants bound a civil date', () => {
    expect(istMidnight(2026, 4, 1).toISOString()).toBe('2026-03-31T18:30:00.000Z');
    expect(istEndOfDay(2026, 3, 31).toISOString()).toBe('2026-03-31T18:29:59.999Z');
    expect(istEndOfDay(2026, 6, 15).toISOString()).toBe('2026-06-15T18:29:59.999Z');
  });

  it('portfolio FY label and FY window start on IST midnight (it/portfolio.ts:120-139)', () => {
    expect(fyFor(FIRST_HALF_HOUR_OF_APRIL)).toBe('FY2026-27');
    expect(fyFor(FIRST_HALF_HOUR_OF_MAY)).toBe('FY2026-27');
    expect(fyFor(new Date('2026-03-31T18:00:00Z'))).toBe('FY2025-26');
    expect(fyWindow('FY2026-27').start.toISOString()).toBe('2026-03-31T18:30:00.000Z');
  });

  it('tax FY label and FY range start on IST midnight (compliance/tax.ts:60-73)', () => {
    expect(fyOf(FIRST_HALF_HOUR_OF_APRIL)).toBe('2026-27');
    expect(fyOf(FIRST_HALF_HOUR_OF_MAY)).toBe('2026-27');
    expect(fyRange('2026-27').from.toISOString()).toBe('2026-03-31T18:30:00.000Z');
  });

  it('record code year is the IST year (platform/recordCode.ts:35, corporate/codes.ts:16)', () => {
    expect(recordCodeYear(FIRST_HALF_HOUR_OF_JANUARY)).toBe(2026);
    expect(recordCodeYear(new Date('2025-12-31T18:00:00Z'))).toBe(2025);
  });

  it('compliance due-date horizon starts from the IST month (shared compliance/calendar.ts:77, :101)', () => {
    const rule = { day: 7 } as ComplianceDueRule;
    expect(nextDueDates(rule, 'monthly', FIRST_HALF_HOUR_OF_APRIL, 1)).toEqual([
      { period: '2026-03', dueAt: new Date('2026-04-07T00:00:00Z') },
    ]);
  });

  it('trailing month keys are IST months (shared hcm/analytics.ts:68-75)', () => {
    expect(trailingMonths(2, FIRST_HALF_HOUR_OF_APRIL)).toEqual(['2026-03', '2026-04']);
    expect(trailingMonths(1, FIRST_HALF_HOUR_OF_MAY)).toEqual(['2026-05']);
  });

  it('group last complete month is the IST previous month (domains/group.ts:101-106)', () => {
    expect(lastCompleteMonthKey(FIRST_HALF_HOUR_OF_APRIL)).toBe('2026-03');
    expect(lastCompleteMonthKey(FIRST_HALF_HOUR_OF_MAY)).toBe('2026-04');
  });

  it('continuity last full month is the IST previous month (domains/it/continuity.ts:611-617)', () => {
    expect(lastFullMonthPeriod(FIRST_HALF_HOUR_OF_APRIL)).toBe('2026-03');
    expect(lastFullMonthPeriod(FIRST_HALF_HOUR_OF_MAY)).toBe('2026-04');
  });

  it('half-year boundary is the IST end of 31 March, not 23:59:59 UTC (domains/filings.ts:368-379)', () => {
    expect(latestHalfYearEnd(FIRST_HALF_HOUR_OF_APRIL).toISOString()).toBe('2026-03-31T18:29:59.999Z');
  });

  it('marketing spend period key is the IST month (domains/marketing/budget.ts:267-269)', () => {
    expect(periodFor(FIRST_HALF_HOUR_OF_APRIL)).toBe('2026-04');
    expect(periodFor(FIRST_HALF_HOUR_OF_MAY)).toBe('2026-05');
  });
});
