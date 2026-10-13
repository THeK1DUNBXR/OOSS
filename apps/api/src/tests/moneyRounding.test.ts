/**
 * packages/shared/src/money.ts: the number-to-paise rounding and the Decimal
 * read. The suite lives in apps/api because it is the only package with a test
 * runner; packages/shared has none, and it is imported here through @kaizen/shared.
 *
 * The half-paise cases are the ones the ten private round2 copies disagreed on
 * (see moneyHalfPaise.test.ts for the copies that changed).
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { decimalToMinor, toMinorHalfUp } from '@kaizen/shared';
import { minorOf } from '../platform/wire.js';

describe('toMinorHalfUp: a number as paise, half away from zero, no float arithmetic', () => {
  it('reads a decimal tie as a tie, where x * 100 in floating point falls under it', () => {
    expect(toMinorHalfUp(1.005)).toBe(101n);
    expect(toMinorHalfUp(1.255)).toBe(126n);
    expect(toMinorHalfUp(0.285)).toBe(29n);
    expect(toMinorHalfUp(0.145)).toBe(15n);
    expect(toMinorHalfUp(2.675)).toBe(268n);
  });

  it('rounds negative ties away from zero, so a credit note reverses its invoice', () => {
    expect(toMinorHalfUp(-1.005)).toBe(-101n);
    expect(toMinorHalfUp(-0.145)).toBe(-15n);
    expect(toMinorHalfUp(-0.045)).toBe(-5n);
  });

  it('leaves a value that is not a tie where it is', () => {
    expect(toMinorHalfUp(1.004)).toBe(100n);
    expect(toMinorHalfUp(1.0049999)).toBe(100n);
    expect(toMinorHalfUp(1.006)).toBe(101n);
  });

  it('handles the exponent form String() prints for very small magnitudes', () => {
    expect(String(1e-7)).toBe('1e-7');
    expect(toMinorHalfUp(1e-7)).toBe(0n);
    expect(toMinorHalfUp(-1e-7)).toBe(0n);
    expect(toMinorHalfUp(1.5e-7)).toBe(0n);
    expect(toMinorHalfUp(5e-3)).toBe(1n);
    expect(toMinorHalfUp(2.5e-3)).toBe(0n);
  });

  it('handles the exponent form for large magnitudes that still fit a paise column', () => {
    expect(String(1e15)).toBe('1000000000000000');
    expect(toMinorHalfUp(1e15)).toBe(100000000000000000n);
    expect(toMinorHalfUp(1.5e15)).toBe(150000000000000000n);
    expect(toMinorHalfUp(9e16)).toBe(9000000000000000000n);
  });

  it('rounds a large value with a tie at the last place, at crore magnitude', () => {
    // 83377588.725 is the case the export round2 gets one paisa low (financeCharacterisation KNOWN).
    expect(toMinorHalfUp(83377588.725)).toBe(8337758873n);
    expect(toMinorHalfUp(4973275.225)).toBe(497327523n);
    expect(toMinorHalfUp(99999999999.995)).toBe(10000000000000n);
    expect(toMinorHalfUp(99999999999.994)).toBe(9999999999999n);
  });

  it('returns integers and zero exactly', () => {
    expect(toMinorHalfUp(0)).toBe(0n);
    expect(toMinorHalfUp(-0)).toBe(0n);
    expect(toMinorHalfUp(7)).toBe(700n);
    expect(toMinorHalfUp(-3)).toBe(-300n);
  });

  it('refuses NaN and the infinities', () => {
    expect(() => toMinorHalfUp(Number.NaN)).toThrow(RangeError);
    expect(() => toMinorHalfUp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMinorHalfUp(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('refuses a value outside the 64-bit paise range rather than storing a wrong one', () => {
    // 1e17 rupees is 1e19 paise, above INT64_MAX (9223372036854775807).
    expect(() => toMinorHalfUp(1e17)).toThrow(RangeError);
    expect(() => toMinorHalfUp(1e21)).toThrow(RangeError);
    expect(() => toMinorHalfUp(-1e21)).toThrow(RangeError);
  });

  it('refuses a string, which is the caller passing a Decimal or text by mistake', () => {
    expect(() => toMinorHalfUp('1.005' as unknown as number)).toThrow(RangeError);
  });
});

describe('decimalToMinor: a Decimal column as paise, read through its own two places', () => {
  it('reads a Decimal string exactly, with no float on the way', () => {
    expect(decimalToMinor(new Prisma.Decimal('1234567890.5'))).toBe(123456789050n);
    expect(decimalToMinor(new Prisma.Decimal('-0.10'))).toBe(-10n);
    expect(decimalToMinor(new Prisma.Decimal('0'))).toBe(0n);
  });

  it('refuses a JavaScript number, which may already be a rounded float', () => {
    expect(() => decimalToMinor(1.5 as unknown as Prisma.Decimal)).toThrow(TypeError);
  });

  it('keeps minorOf on the wire unchanged: the same string, and null for null', () => {
    expect(minorOf(new Prisma.Decimal('12.30'))).toBe('1230');
    expect(minorOf(new Prisma.Decimal('-0.05'))).toBe('-5');
    expect(minorOf(null)).toBeNull();
    expect(() => minorOf(1.5 as unknown as Prisma.Decimal)).toThrow(TypeError);
  });
});
