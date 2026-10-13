/**
 * Pins what the money-bearing exports return at a half-paise tie, through the
 * module that holds each private round2 copy (ORDERED-PLAN 1.6, slice S1).
 *
 * Before the copies were removed there were two families: the Number.EPSILON
 * variant (finance.ts:150) and a plain Math.round(n * 100) / 100. They disagree
 * at a decimal tie that the float lands just below (1.005 is 1.01 under the
 * first and 1 under the second). Each test below names which family its module
 * used before the change, so a change in output is visible here, not discovered
 * on a payslip.
 */

import { describe, expect, it } from 'vitest';
import {
  creditableWithinCap,
  encashmentAmount,
  leaveEncashment,
  overtimeAmount,
  perDayWage26,
  waterfall,
} from '@kaizen/shared';

// Changed by S1: these were 1.00 under the plain copy, and are 1.01 now, the
// EPSILON family of the export. Old values, per the characterisation run
// before the copies were removed: encashmentAmount 1, overtimeAmount 1,
// waterfall exitValue 1 and commonPayout 1.
describe('half-paise ties through the copies that changed (plain Math.round family before S1)', () => {
  // labour.ts:99 was the plain copy. 104.52 / 26 * 0.25 is exactly 1.005 in
  // decimal; the float is a hair below it, so plain rounding gave 1.00.
  it('encashmentAmount rounds 1.005 to 1.01 (labour.ts; was 1.00 under the plain copy)', () => {
    expect(encashmentAmount(104.52, 0.25)).toBe(1.01);
  });

  // labour.ts:96 again: 104.52 / 208 * 2 * 1 is 1.005 in decimal.
  it('overtimeAmount rounds 1.005 to 1.01 (labour.ts; was 1.00 under the plain copy)', () => {
    expect(overtimeAmount(104.52, 1)).toBe(1.01);
  });

  // equity.ts:456 was the plain copy. An exit of 1.005 to one common holder.
  it('waterfall rounds the exit value 1.005 to 1.01 (equity.ts; was 1.00 under the plain copy)', () => {
    const out = waterfall(
      [{ holderId: 'h1', holderName: 'Holder One', shareClassId: 'common', count: 1, preference: null }],
      { common: 0 },
      1.005,
    );
    expect(out.exitValue).toBe(1.01);
    expect(out.rows[0]?.commonPayout).toBe(1.01);
  });
});

describe('half-paise ties through the copies that did not change', () => {
  // compliance/payroll.ts:9 is the EPSILON family and stays so: 26.13 / 26 is
  // 1.005 in decimal and must come out 1.01.
  it('perDayWage26 rounds 1.005 up to 1.01 (EPSILON family, unchanged)', () => {
    expect(perDayWage26(26.13)).toBe(1.01);
    expect(leaveEncashment(26.13, 1)).toBe(1.01);
  });

  // hcm/leavepolicy.ts:29 is the plain family and is deliberately kept: its
  // callers round leave days, which are a QUANTITY, not money. Changing it
  // would move leave balances at centi-day ties on a non-money decision.
  it('creditableWithinCap keeps the plain family for leave days (leavepolicy.ts, unchanged)', () => {
    expect(creditableWithinCap(0, 1.005, null)).toBe(1);
  });
});
