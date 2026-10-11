/**
 * FX-31: a fee split into instalments sums to the fee, to the paisa
 * (archive phase-1-ledger.md section 1.6; FIXES.md row FX-31; the split was
 * round2(total * share) in events/handlers.ts before this).
 *
 * Acceptance from FIXES.md: a fee of 100000.01 split three ways sums exactly.
 * The default plan (40/30/30) is three instalments; the 33.34/33.33/33.33 plan is
 * the same three-way split as money.ts allocate() gives it.
 */

import { describe, expect, it } from 'vitest';
import { parseMinor } from '@kaizen/shared';
import { instalmentAmounts, instalmentPlan } from '../events/handlers.js';

/** Sums rupee amounts as paise, which is the only way to check a total to the paisa. */
function paiseSum(amounts: number[]): bigint {
  return amounts.reduce((total, a) => total + parseMinor(a.toFixed(2)), 0n);
}

describe('FX-31: a fee split into instalments sums to the fee exactly', () => {
  it('a fee of 100000.01 on the default 40/30/30 plan sums to the fee, the leftover paisa on the first instalment', () => {
    const plan = instalmentPlan(undefined);
    const amounts = instalmentAmounts(100000.01, plan);

    expect(amounts).toHaveLength(3);
    expect(paiseSum(amounts)).toBe(parseMinor('100000.01'));
    expect(amounts.map((a) => a.toFixed(2))).toEqual(['40000.01', '30000.00', '30000.00']);
  });

  it('a fee of 100000.01 split three ways (33.34, 33.33, 33.33) sums to the fee', () => {
    const plan = instalmentPlan([
      { share: 0.3334, dueInDays: 7 },
      { share: 0.3333, dueInDays: 45 },
      { share: 0.3333, dueInDays: 90 },
    ]);
    const amounts = instalmentAmounts(100000.01, plan);

    expect(paiseSum(amounts)).toBe(parseMinor('100000.01'));
    expect(amounts.map((a) => a.toFixed(2))).toEqual(['33340.01', '33330.00', '33330.00']);
  });

  it('a plan whose shares do not add up to the whole falls back to the default, not to a rounded guess', () => {
    const plan = instalmentPlan([
      { share: 0.5, dueInDays: 7 },
      { share: 0.3, dueInDays: 45 },
    ]);
    expect(plan).toEqual(instalmentPlan(undefined));
  });
});
