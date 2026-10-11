/**
 * Pins the CURRENT outputs of the money-bearing exports of
 * packages/shared/src/finance.ts, before any of them moves to bigint paise
 * (Wave 3, step "shared finance.ts").
 *
 * Every expected value here was produced by the pre-conversion code. Where the
 * current code is wrong by a paisa, the wrong value is pinned and marked
 * KNOWN, so the conversion cannot change it silently. A GST figure that is
 * wrong is an accountant's decision (D-02) before it is a code change.
 */

import { describe, expect, it } from 'vitest';
import {
  amortisationSchedule,
  amountInWords,
  bookValueAt,
  computeGst,
  computePaymentSchedule,
  depreciationSchedule,
  emi,
  financialYearOf,
  financialYearRange,
  gstinCheckDigit,
  invoicePayable,
  isDivision,
  isInterState,
  isTrading,
  loanBalanceAt,
  monthKey,
  monthRange,
  monthsBack,
  outstandingOf,
  paymentTypeFor,
  placeOfSupplyLabel,
  round2,
  runwayMonths,
  setOffInputCredit,
  stateCodeOf,
  stateNameFor,
  supplyTypeOf,
} from '@kaizen/shared';

const ZERO_GST = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, total: 0, roundOff: 0, grandTotal: 0 };

describe('round2 (float; GST depends on it, D-02)', () => {
  it('rounds positive half-up on ties that are exact in binary', () => {
    expect(round2(0.125)).toBe(0.13);
    expect(round2(2.5)).toBe(2.5);
  });

  it('rounds positive half-up on ties that are not exact in binary, at small magnitude', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.285)).toBe(0.29);
    expect(round2(0.045)).toBe(0.05);
    expect(round2(0.035)).toBe(0.04);
    expect(round2(1.0049999)).toBe(1);
  });

  it('rounds negative ties toward +infinity, so -0.045 is -0.04 where +0.045 is +0.05', () => {
    expect(round2(-0.125)).toBe(-0.12);
    expect(round2(-0.045)).toBe(-0.04);
    expect(round2(-1.005)).toBe(-1);
    expect(round2(-2.5)).toBe(-2.5);
  });

  // KNOWN DEFECT (D-02). 83377588.725 is a decimal tie; the float nearest it is
  // just below the tie, so the epsilon does nothing at this magnitude and the
  // result is one paisa low. Fixing it changes GST figures on the same inputs.
  it('KNOWN: at crore magnitudes a positive tie can land one paisa low', () => {
    expect(round2(83377588.725)).toBe(83377588.72);
    expect(round2(4973275.225)).toBe(4973275.22);
  });
});

describe('computeGst (per-line tax, odd paisa to CGST, rupee round-off)', () => {
  it('splits an intra-state 18% line evenly', () => {
    expect(computeGst([{ taxableValue: 100, gstRate: 18 }], false)).toEqual({
      taxableValue: 100,
      cgst: 9,
      sgst: 9,
      igst: 0,
      tax: 18,
      total: 118,
      roundOff: 0,
      grandTotal: 118,
    });
  });

  it('puts an inter-state line wholly in IGST', () => {
    const r = computeGst([{ taxableValue: 100, gstRate: 18 }], true);
    expect([r.cgst, r.sgst, r.igst, r.tax]).toEqual([0, 0, 18, 18]);
  });

  it('gives the odd paisa of an intra-state split to CGST', () => {
    const r = computeGst([{ taxableValue: 1000.5, gstRate: 18 }], false);
    expect([r.cgst, r.sgst, r.tax]).toEqual([90.05, 90.04, 180.09]);
  });

  it('rounds a sub-paisa tax to the nearest paisa and rounds the split the same way', () => {
    expect(computeGst([{ taxableValue: 0.05, gstRate: 18 }], false)).toMatchObject({ cgst: 0.01, sgst: 0, tax: 0.01 });
    expect(computeGst([{ taxableValue: 0.25, gstRate: 18 }], false)).toMatchObject({
      cgst: 0.03,
      sgst: 0.02,
      tax: 0.05,
    });
    expect(computeGst([{ taxableValue: 0.01, gstRate: 5 }], false)).toMatchObject({ tax: 0 });
    expect(computeGst([{ taxableValue: 0.1, gstRate: 5 }], false)).toMatchObject({ cgst: 0.01, sgst: 0, tax: 0.01 });
  });

  it('rounds each line before summing, so ten 0.10 lines at 18% are 0.20 of tax, not 0.18', () => {
    const lines = Array.from({ length: 10 }, () => ({ taxableValue: 0.1, gstRate: 18 }));
    expect(computeGst(lines, true)).toMatchObject({ taxableValue: 1, igst: 0.2, tax: 0.2, total: 1.2, grandTotal: 1 });
    expect(computeGst(lines, false)).toMatchObject({ cgst: 0.1, sgst: 0.1, tax: 0.2 });
  });

  it('sums a mixed-rate invoice per line', () => {
    const r = computeGst(
      [
        { taxableValue: 33.33, gstRate: 18 },
        { taxableValue: 33.33, gstRate: 18 },
        { taxableValue: 33.34, gstRate: 18 },
      ],
      false,
    );
    expect(r).toMatchObject({ taxableValue: 100, cgst: 9, sgst: 9, tax: 18, total: 118, grandTotal: 118 });
  });

  it('rounds the grand total to the nearest rupee and carries the difference as round-off', () => {
    expect(computeGst([{ taxableValue: 99.5, gstRate: 18 }], true)).toMatchObject({
      tax: 17.91,
      total: 117.41,
      roundOff: -0.41,
      grandTotal: 117,
    });
    expect(computeGst([{ taxableValue: 1000.5, gstRate: 18 }], true)).toMatchObject({
      total: 1180.59,
      roundOff: 0.41,
      grandTotal: 1181,
    });
    expect(computeGst([{ taxableValue: 0.25, gstRate: 18 }], false)).toMatchObject({
      total: 0.3,
      roundOff: -0.3,
      grandTotal: 0,
    });
  });

  it('rounds a rupee tie upward on a positive total and toward +infinity on a negative one', () => {
    expect(computeGst([{ taxableValue: 0.5, gstRate: 0 }], true)).toMatchObject({ roundOff: 0.5, grandTotal: 1 });
    // Math.round(-0.5) is -0, so a -0.50 credit note is presented as 0, not -1.
    // Checked with === because the value is -0, which Object.is tells apart from 0.
    const credit = computeGst([{ taxableValue: -0.5, gstRate: 0 }], true);
    expect(credit.roundOff).toBe(0.5);
    expect(credit.grandTotal === 0).toBe(true);
  });

  it('keeps a negative (credit note) line negative through the split and the round-off', () => {
    expect(computeGst([{ taxableValue: -99.99, gstRate: 5 }], true)).toMatchObject({
      igst: -5,
      tax: -5,
      total: -104.99,
      roundOff: -0.01,
      grandTotal: -105,
    });
    expect(computeGst([{ taxableValue: -0.25, gstRate: 18 }], true)).toMatchObject({ igst: -0.04, tax: -0.04 });
  });

  it('returns zeros for no lines', () => {
    expect(computeGst([], false)).toEqual(ZERO_GST);
  });

  // KNOWN DEFECT (D-02). 42.70 at 5% is a tax of 2.135. The rule the code states
  // (half away from zero per line) gives 2.14; the float path gives 2.13. Changing
  // it changes a GST figure, so it waits for the accountant.
  it('KNOWN (D-02): a 42.70 line at 5% is taxed at 2.13, where half-up gives 2.14', () => {
    expect(computeGst([{ taxableValue: 42.7, gstRate: 5 }], true)).toMatchObject({
      igst: 2.13,
      tax: 2.13,
      total: 44.83,
    });
    expect(computeGst([{ taxableValue: 42.7, gstRate: 5 }], false)).toMatchObject({
      cgst: 1.07,
      sgst: 1.06,
      tax: 2.13,
    });
  });
});

describe('isInterState', () => {
  it('compares the first two digits of the GSTINs', () => {
    expect(isInterState('27AAAPL1234C1Z5', '29AAAPL1234C1Z5')).toBe(true);
    expect(isInterState('27X', '27Y')).toBe(false);
  });

  it('returns null when either side is unknown, so the caller has to say rather than guess', () => {
    expect(isInterState(null, '27')).toBeNull();
    expect(isInterState('2', '27')).toBeNull();
  });
});

describe('setOffInputCredit (statutory order: IGST first, then CGST and SGST each against their own head)', () => {
  it('uses IGST credit against IGST, then CGST, then SGST', () => {
    const r = setOffInputCredit({ cgst: 20, sgst: 5, igst: 5 }, { cgst: 0, sgst: 0, igst: 40 });
    expect(r.utilised).toEqual({ cgst: 0, sgst: 0, igst: 30 });
    expect(r.payable).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    expect(r.carriedForward).toEqual({ cgst: 0, sgst: 0, igst: 10 });
    expect(r.totalPayable).toBe(0);
    expect(r.totalUtilised).toBe(30);
  });

  it('never lets CGST credit reach SGST output', () => {
    const r = setOffInputCredit({ cgst: 100, sgst: 50, igst: 0 }, { cgst: 40, sgst: 70, igst: 0 });
    expect(r.utilised).toEqual({ cgst: 40, sgst: 50, igst: 0 });
    expect(r.payable).toEqual({ cgst: 60, sgst: 0, igst: 0 });
    expect(r.carriedForward).toEqual({ cgst: 0, sgst: 20, igst: 0 });
    expect(r.totalPayable).toBe(60);
    expect(r.totalUtilised).toBe(90);
  });

  it('spends IGST credit on IGST output before any other head', () => {
    const r = setOffInputCredit({ cgst: 100, sgst: 50, igst: 10 }, { cgst: 0, sgst: 0, igst: 30 });
    expect(r.utilised).toEqual({ cgst: 0, sgst: 0, igst: 30 });
    expect(r.payable).toEqual({ cgst: 80, sgst: 50, igst: 0 });
    expect(r.totalPayable).toBe(130);
  });
});

describe('outstandingOf', () => {
  it('is payable less allocated and credit noted, floored at zero', () => {
    expect(outstandingOf(100, 40, 60)).toBe(0);
    expect(outstandingOf(100, 120)).toBe(0);
    expect(outstandingOf(10.1, 0.2, 0.3)).toBe(9.6);
    expect(outstandingOf(0, 0)).toBe(0);
  });

  it('is exact for two-place inputs where float subtraction is not (0.3 - 0.1)', () => {
    expect(outstandingOf(0.3, 0.1)).toBe(0.2);
    expect(outstandingOf(100, 33.33, 33.33)).toBe(33.34);
  });

  it('rounds a three-place payable half-up before subtracting', () => {
    expect(outstandingOf(1.005, 0)).toBe(1.01);
  });
});

describe('paymentTypeFor', () => {
  it('is credit when nothing or less than nothing is being collected', () => {
    expect(paymentTypeFor(100, 0)).toBe('credit');
    expect(paymentTypeFor(100, -5)).toBe('credit');
    expect(paymentTypeFor(100, 0.004)).toBe('credit');
    expect(paymentTypeFor(0, 0)).toBe('credit');
  });

  it('is full at or above the payable, and part below it', () => {
    expect(paymentTypeFor(100, 100)).toBe('full');
    expect(paymentTypeFor(100, 100.01)).toBe('full');
    expect(paymentTypeFor(100, 99.99)).toBe('part');
    expect(paymentTypeFor(100, 99.9949)).toBe('part');
  });

  it('compares after rounding the payment, so 99.999 is a full payment of 100', () => {
    expect(paymentTypeFor(100, 99.999)).toBe('full');
  });

  it('is full for a float sum that equals the payable to the paisa', () => {
    expect(paymentTypeFor(0.3, 0.1 + 0.2)).toBe('full');
  });
});

describe('invoicePayable', () => {
  it('uses the grand total whenever it is set and positive', () => {
    expect(invoicePayable(100.5, 1)).toBe(100.5);
    expect(invoicePayable(1.005, 0)).toBe(1.01);
  });

  it('falls back to the line total when the grand total is zero, null or negative', () => {
    expect(invoicePayable(0, 99.99)).toBe(99.99);
    expect(invoicePayable(null, 99.99)).toBe(99.99);
    expect(invoicePayable(-5, 12.3)).toBe(12.3);
    expect(invoicePayable(null, 2.675)).toBe(2.68);
  });
});

describe('amountInWords (Indian grouping; below 100 crore, see the defects file for above)', () => {
  it('spells out rupees and paise', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(1)).toBe('Rupees One Only');
    expect(amountInWords(0.5)).toBe('Rupees Zero and Fifty Paise Only');
    expect(amountInWords(1234.56)).toBe('Rupees One Thousand Two Hundred and Thirty Four and Fifty Six Paise Only');
  });

  it('rounds to the paisa first, so 1.005 is one rupee and one paisa and 0.995 is one rupee', () => {
    expect(amountInWords(1.005)).toBe('Rupees One and One Paise Only');
    expect(amountInWords(0.005)).toBe('Rupees Zero and One Paise Only');
    expect(amountInWords(0.995)).toBe('Rupees One Only');
    expect(amountInWords(99.999)).toBe('Rupees One Hundred Only');
  });

  it('uses lakh and crore, not million', () => {
    expect(amountInWords(100000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(10000000)).toBe('Rupees One Crore Only');
    expect(amountInWords(12345678.9)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred and Seventy Eight and Ninety Paise Only',
    );
  });

  it('prefixes a negative amount with Minus and writes the magnitude', () => {
    expect(amountInWords(-2.5)).toBe('Minus Rupees Two and Fifty Paise Only');
    expect(amountInWords(-1234.5)).toBe('Minus Rupees One Thousand Two Hundred and Thirty Four and Fifty Paise Only');
  });
});

describe('depreciationSchedule and bookValueAt', () => {
  it('straight line with an exact division runs to salvage', () => {
    const rows = depreciationSchedule({
      cost: 1000,
      salvageValue: 100,
      usefulLifeMonths: 3,
      purchaseDate: new Date('2026-01-15T00:00:00Z'),
      method: 'straight_line',
    });
    expect(rows).toEqual([
      { period: '2026-01', opening: 1000, charge: 300, closing: 700 },
      { period: '2026-02', opening: 700, charge: 300, closing: 400 },
      { period: '2026-03', opening: 400, charge: 300, closing: 100 },
    ]);
  });

  it('writing-down-value charges a monthly rate on the balance above salvage', () => {
    const rows = depreciationSchedule({
      cost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 4,
      purchaseDate: new Date('2026-04-01T00:00:00Z'),
      method: 'wdv',
      wdvRate: 25,
    });
    expect(rows.map((r) => [r.period, r.charge, r.closing])).toEqual([
      ['2026-04', 187.5, 9812.5],
      ['2026-05', 183.59, 9628.91],
      ['2026-06', 179.77, 9449.14],
      ['2026-07', 176.02, 9273.12],
    ]);
  });

  it('a cost that does not divide evenly ends at zero when the paise divide exactly', () => {
    const rows = depreciationSchedule({
      cost: 1,
      salvageValue: 0,
      usefulLifeMonths: 8,
      purchaseDate: new Date('2026-01-01T00:00:00Z'),
      method: 'straight_line',
    });
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ charge: 0.13, closing: 0.87 });
    expect(rows[7]).toMatchObject({ charge: 0.09, closing: 0 });
  });

  it('returns an empty schedule for zero life or zero cost', () => {
    const base = { salvageValue: 0, purchaseDate: new Date('2026-01-01T00:00:00Z'), method: 'straight_line' as const };
    expect(depreciationSchedule({ ...base, cost: 100, usefulLifeMonths: 0 })).toEqual([]);
    expect(depreciationSchedule({ ...base, cost: 0, usefulLifeMonths: 3 })).toEqual([]);
  });

  it('bookValueAt reads the schedule as at the month of the date', () => {
    const input = {
      cost: 1000,
      salvageValue: 100,
      usefulLifeMonths: 3,
      purchaseDate: new Date('2026-01-15T00:00:00Z'),
      method: 'straight_line' as const,
    };
    expect(bookValueAt(input, new Date('2026-02-10T00:00:00Z'))).toBe(400);
    expect(bookValueAt(input, new Date('2025-12-10T00:00:00Z'))).toBe(1000);
    expect(bookValueAt(input, new Date('2030-01-10T00:00:00Z'))).toBe(100);
  });
});

describe('emi, amortisationSchedule and loanBalanceAt', () => {
  it('computes the level instalment, rounded to the paisa', () => {
    expect(emi(100000, 12, 12)).toBe(8884.88);
    expect(emi(1000, 0, 3)).toBe(333.33);
    expect(emi(1234567.89, 9.5, 36)).toBe(39546.85);
    expect(emi(100000, 10.5, 0)).toBe(0);
    expect(emi(0.01, 0, 3)).toBe(0);
  });

  it('clears the loan on the last instalment, absorbing rounding', () => {
    const rows = amortisationSchedule({
      principal: 100000,
      annualRate: 12,
      tenureMonths: 3,
      startDate: new Date('2026-01-01T00:00:00Z'),
    });
    expect(rows).toEqual([
      {
        period: '2026-01',
        opening: 100000,
        instalment: 34002.21,
        interest: 1000,
        principal: 33002.21,
        closing: 66997.79,
      },
      {
        period: '2026-02',
        opening: 66997.79,
        instalment: 34002.21,
        interest: 669.98,
        principal: 33332.23,
        closing: 33665.56,
      },
      { period: '2026-03', opening: 33665.56, instalment: 34002.22, interest: 336.66, principal: 33665.56, closing: 0 },
    ]);
  });

  it('a zero-rate loan splits the principal evenly with the remainder on the last instalment', () => {
    const rows = amortisationSchedule({
      principal: 1000,
      annualRate: 0,
      tenureMonths: 3,
      startDate: new Date('2026-01-01T00:00:00Z'),
    });
    expect(rows.map((r) => [r.instalment, r.principal, r.closing])).toEqual([
      [333.33, 333.33, 666.67],
      [333.33, 333.33, 333.34],
      [333.34, 333.34, 0],
    ]);
  });

  it('loanBalanceAt is the principal before the first month and zero after the last', () => {
    const loan = { principal: 100000, annualRate: 12, tenureMonths: 3, startDate: new Date('2026-01-01T00:00:00Z') };
    expect(loanBalanceAt(loan, new Date('2026-02-15T00:00:00Z'))).toBe(33665.56);
    expect(loanBalanceAt(loan, new Date('2025-06-15T00:00:00Z'))).toBe(100000);
    expect(loanBalanceAt(loan, new Date('2027-06-15T00:00:00Z'))).toBe(0);
  });
});

describe('runwayMonths', () => {
  it('divides cash by net burn, and is null when the company is not burning', () => {
    expect(runwayMonths(100, 3)).toBe(33.33);
    expect(runwayMonths(1000, 333)).toBe(3);
    expect(runwayMonths(100, 0.3)).toBe(333.33);
    expect(runwayMonths(100, -1)).toBeNull();
    expect(runwayMonths(1, 0)).toBeNull();
  });

  it('is zero, not negative, when overdrawn', () => {
    expect(runwayMonths(0, 5)).toBe(0);
    expect(runwayMonths(-5, 3)).toBe(0);
  });
});

describe('dates, divisions and places (not money; pinned because the same module holds them)', () => {
  it('reads the month and financial year in IST', () => {
    expect(monthKey(new Date('2026-03-31T18:29:00Z'))).toBe('2026-03');
    expect(monthKey(new Date('2026-03-31T20:00:00Z'))).toBe('2026-04');
    expect(financialYearOf(new Date('2026-03-31T18:00:00Z'))).toBe('FY2025-26');
    expect(financialYearOf(new Date('2026-03-31T19:00:00Z'))).toBe('FY2026-27');
    expect(monthRange('2026-04')).toEqual({
      from: new Date('2026-03-31T18:30:00Z'),
      to: new Date('2026-04-30T18:30:00Z'),
    });
    expect(financialYearRange(2026)).toEqual({
      from: new Date('2026-03-31T18:30:00Z'),
      to: new Date('2027-03-31T18:30:00Z'),
    });
    expect(monthsBack('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('answers the division, trading and GST place questions', () => {
    expect(isDivision('software')).toBe(true);
    expect(isDivision('x')).toBe(false);
    expect(isTrading('income')).toBe(true);
    expect(isTrading('transfer')).toBe(false);
    expect(isTrading(null)).toBe(true);
    expect(stateNameFor('07')).toBe('Delhi');
    expect(stateNameFor('99')).toBeNull();
    expect(placeOfSupplyLabel('07')).toBe('07-Delhi');
    expect(stateCodeOf('27AAAPL1234C1Z5')).toBe('27');
    expect(stateCodeOf(null)).toBeNull();
    expect(supplyTypeOf('27AAAPL1234C1Z5')).toBe('b2c');
    expect(gstinCheckDigit('27AAAPL1234C1Z')).toBe('E');
    expect(gstinCheckDigit('27AAAPL1234C1')).toBeNull();
  });

  it('states the instalment schedule of a course sold on instalments', () => {
    expect(computePaymentSchedule('2026-01-20')).toEqual({
      firstPaymentDue: '2026-01-23',
      subsequentFrom: '2026-03-01',
    });
    expect(computePaymentSchedule('2026-01-10')).toEqual({
      firstPaymentDue: '2026-01-13',
      subsequentFrom: '2026-02-01',
    });
    expect(computePaymentSchedule('2026-02-28')).toEqual({
      firstPaymentDue: '2026-03-03',
      subsequentFrom: '2026-04-01',
    });
    expect(computePaymentSchedule(null)).toBeNull();
  });
});
