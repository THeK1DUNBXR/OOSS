import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { moneyField, rupeesOnWire } from './zodForm.js';

/**
 * The money field turns typed rupees into bigint paise inside the schema, so the
 * forms never see a float. These cases pin the four things a person can do wrong:
 * type a third decimal, type a sign the field does not allow, leave it blank, and
 * type thousands separators.
 */
const positive = moneyField({ positive: true });
const signed = moneyField();
const optional = moneyField({ optional: true });

function parsed(schema: z.ZodTypeAny, text: string) {
  return schema.safeParse(text);
}

describe('moneyField', () => {
  it('reads plain and grouped rupee text as bigint paise', () => {
    expect(parsed(positive, '1234.56')).toEqual({ success: true, data: 123456n });
    expect(parsed(positive, '1,234.56')).toEqual({ success: true, data: 123456n });
  });

  it('reads whole rupees and a single decimal', () => {
    expect(parsed(positive, '1250')).toEqual({ success: true, data: 125000n });
    expect(parsed(positive, '1250.5')).toEqual({ success: true, data: 125050n });
    expect(parsed(positive, '0.01')).toEqual({ success: true, data: 1n });
  });

  it('trims surrounding space before reading', () => {
    expect(parsed(positive, '  1250  ')).toEqual({ success: true, data: 125000n });
  });

  it('reads Indian lakh and crore grouping as well as western grouping', () => {
    expect(parsed(positive, '1,23,456.78')).toEqual({ success: true, data: 12345678n });
    expect(parsed(positive, '1,23,45,678')).toEqual({ success: true, data: 1234567800n });
  });

  it('refuses a third decimal instead of rounding it', () => {
    for (const text of ['1250.499', '1250.505', '0.001']) {
      const result = parsed(positive, text);
      expect(result.success, text).toBe(false);
    }
  });

  it('refuses text that is not an amount, including commas that are not in thousands groups', () => {
    for (const text of ['abc', '12,34.56', '1,23.45', '1,2345', '1.2.3', '1e3']) {
      const result = parsed(positive, text);
      expect(result.success, text).toBe(false);
    }
  });

  it('with positive, refuses zero and negatives', () => {
    for (const text of ['0', '0.00', '-5', '-0.01']) {
      const result = parsed(positive, text);
      expect(result.success, text).toBe(false);
    }
  });

  it('without positive, refuses negatives and accepts zero', () => {
    expect(parsed(signed, '-5').success).toBe(false);
    expect(parsed(signed, '-0.01').success).toBe(false);
    expect(parsed(signed, '0')).toEqual({ success: true, data: 0n });
  });

  it('refuses a blank amount unless the field is optional', () => {
    expect(parsed(positive, '').success).toBe(false);
    expect(parsed(positive, '   ').success).toBe(false);
  });

  it('accepts a blank amount when the field is optional', () => {
    expect(parsed(optional, '').success).toBe(true);
    expect(parsed(optional, '   ').success).toBe(true);
  });
});

describe('rupeesOnWire', () => {
  it('writes paise as the exact rupee number the Books routes read', () => {
    expect(rupeesOnWire(123456n)).toBe(1234.56);
    expect(rupeesOnWire(10n)).toBe(0.1);
    expect(rupeesOnWire(0n)).toBe(0);
    expect(rupeesOnWire(-250n)).toBe(-2.5);
  });
});
