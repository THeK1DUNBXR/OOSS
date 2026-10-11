/**
 * Defects the characterisation of finance.ts exposed, each with the paisa or
 * the words that show it. Each fails on the code as it was before the fix that
 * follows it in this branch.
 */

import { describe, expect, it } from 'vitest';
import { amountInWords, depreciationSchedule } from '@kaizen/shared';

describe('straight-line depreciation writes off the whole cost (finance.ts depreciationSchedule)', () => {
  // A ₹100.00 asset over three months charges 33.33 a month, which leaves 0.01
  // after the third month. The code's own comment says the final period should
  // absorb the rounding; it does not, so the asset carries ₹0.01 forever and the
  // register never reaches salvage. The fix is to let the last month take the rest.
  it('ends at salvage when the cost does not divide evenly into the life', () => {
    const rows = depreciationSchedule({
      cost: 100,
      salvageValue: 0,
      usefulLifeMonths: 3,
      purchaseDate: new Date('2026-01-01T00:00:00Z'),
      method: 'straight_line',
    });
    expect(rows.map((r) => r.charge)).toEqual([33.33, 33.33, 33.34]);
    expect(rows[rows.length - 1]!.closing).toBe(0);
  });
});

describe('amount in words above 99 crore (finance.ts amountInWords)', () => {
  // twoDigits(100) indexes past the ONES table, so an invoice for one hundred
  // crore prints "undefined Crore" in the words that settle a dispute.
  it('spells a crore count of 100 or more', () => {
    expect(amountInWords(1_000_000_000)).toBe('Rupees One Hundred Crore Only');
    // "and" before the last two-digit group, as the rest of the words do:
    // "One Thousand Two Hundred and Thirty Four".
    expect(amountInWords(1_240_000_000)).toBe('Rupees One Hundred and Twenty Four Crore Only');
    expect(amountInWords(1_234_000_000)).toBe('Rupees One Hundred and Twenty Three Crore Forty Lakh Only');
    expect(amountInWords(120_000_000_000)).toBe('Rupees Twelve Thousand Crore Only');
  });
});
