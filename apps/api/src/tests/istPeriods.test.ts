/**
 * Periods are civil periods in IST. Between 00:00 and 05:30 IST on the 1st of a
 * month the UTC calendar is still on the previous month, so a UTC derivation
 * puts an invoice, a tax period or a document series one month early — and on
 * 1 April, one financial year early.
 *
 * The instant used throughout is 2026-03-31T19:00Z, which is 1 April 2026 00:30
 * IST. Each of the three call sites is asserted against it, with a control at
 * 18:00Z (23:30 IST on 31 March) to show the boundary is where expected.
 */

import { describe, expect, it } from 'vitest';
import { istFinancialYear, istMinuteOfDay, istMonthKey, istPeriodOf } from '@kaizen/shared';
import { yesterdayIst } from '../domains/hcm/time.js';
import { currentAccrualPeriod } from '../domains/hcm/leavepolicy.js';
import { fyOf } from '../domains/compliance/tax.js';
import { filingPeriodOf } from '../domains/invoicing.js';
import { financialYearStart } from '../platform/documentNumber.js';

const APRIL_1_0030_IST = new Date('2026-03-31T19:00:00Z');
const MARCH_31_2330_IST = new Date('2026-03-31T18:00:00Z');

describe('shared IST helpers', () => {
  it('places 00:30 IST on 1 April in April and the next financial year', () => {
    expect(istMonthKey(APRIL_1_0030_IST)).toBe('2026-04');
    expect(istFinancialYear(APRIL_1_0030_IST)).toBe('FY2026-27');
    expect(istPeriodOf(APRIL_1_0030_IST)).toEqual({ month: '2026-04', financialYear: 'FY2026-27' });
  });

  it('keeps 23:30 IST on 31 March in March and the previous financial year', () => {
    expect(istMonthKey(MARCH_31_2330_IST)).toBe('2026-03');
    expect(istFinancialYear(MARCH_31_2330_IST)).toBe('FY2025-26');
  });
});

describe('tax financial year (FX-41)', () => {
  it('names 00:30 IST on 1 April as 2026-27', () => {
    expect(fyOf(APRIL_1_0030_IST)).toBe('2026-27');
  });

  it('names 23:30 IST on 31 March as 2025-26', () => {
    expect(fyOf(MARCH_31_2330_IST)).toBe('2025-26');
  });
});

describe('document-number financial year (FX-40)', () => {
  it('starts the sequence year 2026 for 00:30 IST on 1 April', () => {
    expect(financialYearStart(APRIL_1_0030_IST)).toBe(2026);
  });

  it('starts the sequence year 2025 for 23:30 IST on 31 March', () => {
    expect(financialYearStart(MARCH_31_2330_IST)).toBe(2025);
  });
});

describe('invoice period lock (FX-42)', () => {
  it('checks April 2026 for an invoice dated 00:30 IST on 1 April, not March', () => {
    expect(filingPeriodOf(APRIL_1_0030_IST)).toBe('2026-04');
  });

  it('checks March 2026 for an invoice dated 23:30 IST on 31 March', () => {
    expect(filingPeriodOf(MARCH_31_2330_IST)).toBe('2026-03');
  });
});

describe('HCM civil defaults (CLAUDE.md rule 3)', () => {
  // 21:45Z is 03:15 IST on the 12th: the UTC date is still the 11th, so a
  // "yesterday" derived from UTC getters lands on the 10th.
  it('derives attendance for yesterday in IST at 03:15 IST on 12 October', () => {
    expect(yesterdayIst(new Date('2026-10-11T21:45:00Z')).toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });

  // 20:45Z on the 31st is 02:15 IST on 1 November: monthly accrual runs for
  // the month that has just begun in IST, not the one UTC still shows.
  it('accrues for November at 02:15 IST on 1 November, not October', () => {
    expect(currentAccrualPeriod(new Date('2026-10-31T20:45:00Z'))).toBe('2026-11');
  });

  // 03:45Z is 09:15 IST: the roster's HH:MM is IST wall-clock, so a punch
  // must be read in IST before it is compared with the shift.
  it('reads a punch at 03:45Z as 09:15 IST minutes-of-day', () => {
    expect(istMinuteOfDay(new Date('2026-10-11T03:45:00Z'))).toBe(9 * 60 + 15);
  });
});
