/**
 * Money is signed bigint paise (CLAUDE.md rule 1). These tests pin the helper
 * in packages/shared/src/money.ts that every money path will call.
 *
 * Lives here rather than in packages/shared: shared has no test runner, and
 * its build (tsc over src/**) would pull in vitest types if a test sat beside
 * the source. istPeriods.test.ts follows the same pattern.
 *
 * Property tests use a seeded PRNG rather than fast-check, which needs a new
 * dependency. The seed is in every assertion message so a failing run can be
 * replayed exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  abs,
  add,
  allocate,
  applyBps,
  compare,
  convertPpm,
  formatMinor,
  isZero,
  mulRatio,
  neg,
  parseMinor,
  sub,
} from '@kaizen/shared';

const INT64_MAX = 9223372036854775807n;

function prng(seed: number) {
  let s = seed >>> 0;
  const next32 = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  // Uniform-enough in [0, max]: 128 random bits reduced modulo max + 1.
  const bigBelow = (max: bigint): bigint => {
    let r = 0n;
    for (let i = 0; i < 4; i++) r = (r << 32n) | BigInt(next32());
    return r % (max + 1n);
  };
  const int = (lo: number, hi: number): number => lo + (next32() % (hi - lo + 1));
  return { bigBelow, int };
}

describe('parseMinor', () => {
  it('reads decimal strings into paise without a float', () => {
    expect(parseMinor('12.34')).toBe(1234n);
    expect(parseMinor('0')).toBe(0n);
    expect(parseMinor('0.5')).toBe(50n);
    expect(parseMinor('12')).toBe(1200n);
    expect(parseMinor('-12.34')).toBe(-1234n);
    expect(parseMinor('-0.01')).toBe(-1n);
    expect(parseMinor('1000000.00')).toBe(100000000n);
  });

  it('rejects a third decimal place rather than rounding it', () => {
    expect(() => parseMinor('1.234')).toThrow();
    expect(() => parseMinor('1.005')).toThrow();
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['abc', '', ' 1', '1 ', '+1', '1e3', 'NaN', 'Infinity', '.5', '1.', '--1', '1,000.00']) {
      expect(() => parseMinor(bad), `accepted ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('refuses a JavaScript number, which may already be a rounded float', () => {
    expect(() => parseMinor(12.34 as unknown as string)).toThrow();
  });

  it('refuses values outside the signed 64-bit range the database column holds', () => {
    expect(parseMinor('92233720368547758.07')).toBe(INT64_MAX);
    expect(() => parseMinor('92233720368547758.08')).toThrow();
    expect(parseMinor('-92233720368547758.07')).toBe(-INT64_MAX);
    expect(() => parseMinor('-92233720368547758.08')).toThrow();
  });
});

describe('formatMinor', () => {
  it('writes two decimal places, with a sign only when negative', () => {
    expect(formatMinor(1234n)).toBe('12.34');
    expect(formatMinor(0n)).toBe('0.00');
    expect(formatMinor(5n)).toBe('0.05');
    expect(formatMinor(-1n)).toBe('-0.01');
    expect(formatMinor(-1234n)).toBe('-12.34');
    expect(formatMinor(100000000n)).toBe('1000000.00');
  });
});

describe('arithmetic', () => {
  it('add, sub, neg, abs, compare and isZero are exact on bigint', () => {
    expect(add(1234n, 66n)).toBe(1300n);
    expect(sub(100n, 250n)).toBe(-150n);
    expect(neg(-7n)).toBe(7n);
    expect(abs(-7n)).toBe(7n);
    expect(compare(1n, 2n)).toBeLessThan(0);
    expect(compare(2n, 2n)).toBe(0);
    expect(compare(3n, 2n)).toBeGreaterThan(0);
    expect(isZero(0n)).toBe(true);
    expect(isZero(-1n)).toBe(false);
  });

  it('handles totals near 2^62 without loss', () => {
    const big = 2n ** 62n;
    expect(add(big, big)).toBe(2n ** 63n);
    expect(sub(big, 1n)).toBe(big - 1n);
  });
});

describe('mulRatio', () => {
  it('rounds half away from zero, on both signs', () => {
    expect(mulRatio(5n, 1n, 2n)).toBe(3n);
    expect(mulRatio(-5n, 1n, 2n)).toBe(-3n);
    expect(mulRatio(4n, 1n, 2n)).toBe(2n);
    expect(mulRatio(-4n, 1n, 2n)).toBe(-2n);
  });

  it('rounds sub-half remainders toward zero', () => {
    expect(mulRatio(1n, 1n, 3n)).toBe(0n);
    expect(mulRatio(-1n, 1n, 3n)).toBe(0n);
    expect(mulRatio(2n, 1n, 3n)).toBe(1n);
    expect(mulRatio(-2n, 1n, 3n)).toBe(-1n);
  });

  it('computes a percentage exactly', () => {
    expect(mulRatio(1000n, 18n, 100n)).toBe(180n);
  });

  it('carries the sign of a negative denominator', () => {
    expect(mulRatio(5n, 1n, -2n)).toBe(-3n);
  });

  it('refuses a zero denominator', () => {
    expect(() => mulRatio(5n, 1n, 0n)).toThrow();
  });
});

describe('allocate', () => {
  it('gives the leftover paisa to the first line: 10000 split three ways is 3334/3333/3333', () => {
    expect(allocate(10000n, [1n, 1n, 1n])).toEqual([3334n, 3333n, 3333n]);
    expect(allocate(100n, [1, 1, 1])).toEqual([34n, 33n, 33n]);
  });

  it('gives the leftover to the first line that has a fraction, not to a line whose share is exact', () => {
    // 100 by [1,2] is 33.33 and 66.67. The first line is owed a fraction, so it takes the paisa.
    expect(allocate(100n, [1n, 2n])).toEqual([34n, 66n]);
    // 100 by [1,0,1,1]: the zero-weight middle line takes nothing and the paisa goes to line 0.
    expect(allocate(100n, [1n, 0n, 1n, 1n])).toEqual([34n, 0n, 33n, 33n]);
  });

  it('returns the whole total for a single line', () => {
    expect(allocate(12345n, [7n])).toEqual([12345n]);
  });

  it('returns zeros for a zero total', () => {
    expect(allocate(0n, [1n, 2n, 3n])).toEqual([0n, 0n, 0n]);
  });

  it('splits a negative total as the sign times the split of its magnitude', () => {
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocate(-10000n, [1n, 1n, 1n])).toEqual([-3334n, -3333n, -3333n]);
  });

  it('gives a zero weight nothing, even in the middle', () => {
    expect(allocate(100n, [1n, 0n, 1n])).toEqual([50n, 0n, 50n]);
  });

  it('accepts integer number weights as well as bigint', () => {
    expect(allocate(100n, [1, 2])).toEqual(allocate(100n, [1n, 2n]));
  });

  it('refuses empty, all-zero, negative and non-integer weights', () => {
    expect(() => allocate(100n, [])).toThrow();
    expect(() => allocate(100n, [0n, 0n])).toThrow();
    expect(() => allocate(100n, [1n, -1n])).toThrow();
    expect(() => allocate(100n, [1.5])).toThrow();
    expect(() => allocate(100n, [Number.NaN])).toThrow();
  });

  it('does not overflow for totals up to 2^62', () => {
    const big = 2n ** 62n;
    expect(allocate(big, [1n, 1n])).toEqual([2n ** 61n, 2n ** 61n]);
    const odd = big + 1n;
    const parts = allocate(odd, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(odd);
  });
});

describe('applyBps and convertPpm', () => {
  it('applies basis points with half-away rounding', () => {
    expect(applyBps(10000n, 1800n)).toBe(1800n);
    expect(applyBps(333n, 1800n)).toBe(60n);
    expect(applyBps(-333n, 1800n)).toBe(-60n);
  });

  it('converts at a ppm rate', () => {
    // 83.5 per unit, expressed as 83_500_000 ppm.
    expect(convertPpm(10000n, 83_500_000n)).toBe(835000n);
  });
});

describe('property tests (seeded, no new dependency)', () => {
  const SEED = 0x5eed1600;
  const ITERATIONS = 2000;

  it('allocate sums exactly to the total, every part is within one paisa of its exact share, and the order is deterministic', () => {
    const rng = prng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const ctx = `seed=${SEED} iteration=${i}`;
      const magnitude = rng.bigBelow(2n * 10n ** 12n) - 10n ** 12n;
      const k = rng.int(1, 50);
      const weights: bigint[] = Array.from({ length: k }, () => BigInt(rng.int(0, 1000)));
      // An explicit boolean return: TS infers `w is 0n` from `w === 0n`, which
      // narrows `weights` to `0n[]` in the branch below and refuses the 1n.
      if (weights.every((w): boolean => w === 0n)) weights[0] = 1n;
      const total = magnitude;

      const parts = allocate(total, weights);
      const sum = parts.reduce((a, b) => a + b, 0n);
      expect(sum === total, `${ctx}: sum ${sum} != total ${total}`).toBe(true);

      const W = weights.reduce((a, b) => a + b, 0n);
      for (let j = 0; j < k; j++) {
        // |parts[j] - total*w/W| < 1  <=>  |parts[j]*W - total*w| < W, in exact integers.
        const diff = abs(parts[j]! * W - total * weights[j]!);
        expect(diff < W, `${ctx}: line ${j} is more than one paisa from its exact share`).toBe(true);
      }

      expect(allocate(total, weights), `${ctx}: not deterministic`).toEqual(parts);
    }
  });

  it('allocate does not sort: reversing the weights moves only the leftover paisa, and every line stays within one paisa of its earlier value', () => {
    // Input order decides who takes a leftover paisa, so reversal is not an exact
    // mirror of the original split. What must hold is that the total is still exact
    // and no line moves by more than a paisa.
    const rng = prng(SEED + 1);
    for (let i = 0; i < 500; i++) {
      const ctx = `seed=${SEED + 1} iteration=${i}`;
      const total = rng.bigBelow(10n ** 12n) - 5n * 10n ** 11n;
      const k = rng.int(2, 12);
      const weights: bigint[] = Array.from({ length: k }, () => BigInt(rng.int(1, 100)));
      const parts = allocate(total, weights);
      const reversedParts = allocate(total, [...weights].reverse()).reverse();
      const sum = reversedParts.reduce((a, b) => a + b, 0n);
      expect(sum === total, `${ctx}: reversed split does not sum to the total`).toBe(true);
      for (let j = 0; j < k; j++) {
        const moved = abs(reversedParts[j]! - parts[j]!);
        expect(moved <= 1n, `${ctx}: line ${j} moved by ${moved} paise on reversal`).toBe(true);
      }
    }
  });

  it('parseMinor(formatMinor(x)) === x for signed values across the int64 range', () => {
    const rng = prng(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const ctx = `seed=${SEED + 2} iteration=${i}`;
      const magnitude = rng.bigBelow(INT64_MAX);
      const x = rng.int(0, 1) === 0 ? magnitude : -magnitude;
      const text = formatMinor(x);
      expect(parseMinor(text) === x, `${ctx}: ${x} -> "${text}" -> ${parseMinor(text)}`).toBe(true);
    }
  });
});
