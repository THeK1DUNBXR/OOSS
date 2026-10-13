/**
 * The rupee side of paise columns (CLAUDE.md rule 1). A `<name>Minor` BigInt
 * column is the money; a route that already sent the rupee number keeps sending
 * it, so these helpers print both places from the one paise value and never
 * read the number back into a sum.
 *
 * Moved here from domains/it/money.ts (MONEY-S8-HCM), which re-exports them so
 * the IT call sites are unchanged. The equity and corporate columns (MONEY-S7)
 * use the same helpers.
 */

import { poundsOf } from './allocation.js';
import { minorString, type WithMinorPair } from '../platform/wire.js';
import { mulRatio } from '@kaizen/shared';

/** A paise column as the rupee number a legacy field carries. */
export function minorToRupees(minor: bigint): number {
  return poundsOf(minor);
}

/** As minorToRupees, with a null or missing column read as null. */
export function minorToRupeesOrNull(minor: bigint | null | undefined): number | null {
  return minor === null || minor === undefined ? null : minorToRupees(minor);
}

/**
 * A row with paise columns, shaped for a path that already sent the rupee
 * number: each `<name>` is a JavaScript number, and `<name>Minor` is the paise
 * string.
 */
export function withNumberMinor<T extends object, N extends string>(
  row: T,
  names: readonly N[],
): WithMinorPair<T, N, number | null> {
  const out = { ...row } as Record<string, unknown>;
  for (const name of names) {
    const minor = (row as Record<string, unknown>)[`${name}Minor`] as bigint | null | undefined;
    out[name] = minorToRupeesOrNull(minor);
    out[`${name}Minor`] = minorString(minor);
  }
  return out as WithMinorPair<T, N, number | null>;
}

/**
 * Withholds money from a viewer who cannot see it: each named field and its
 * `<name>Minor` sibling become null together. A masked row that still carried
 * the paise string would leak the figure the mask exists to hide.
 */
export function maskMoney<T extends object>(row: T, canSee: boolean, names: readonly string[]): T {
  if (canSee) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const name of names) {
    out[name] = null;
    out[`${name}Minor`] = null;
  }
  return out as T;
}

/**
 * An exact fraction for a JavaScript number, read from its shortest decimal
 * form (the digits a person typed), so 0.25 is 25/100 and not a binary double.
 */
export function fractionOf(n: number): { num: bigint; den: bigint } {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new RangeError(`fractionOf takes a finite number, got ${String(n)}`);
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  if (!match) throw new SyntaxError(`unexpected number form: ${String(n)}`);
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = BigInt(whole! + fraction);
  const scale = fraction.length - parseInt(exponent, 10);
  const magnitude = scale >= 0 ? digits : digits * 10n ** BigInt(-scale);
  const den = scale >= 0 ? 10n ** BigInt(scale) : 1n;
  return { num: sign === '-' ? -magnitude : magnitude, den };
}

/**
 * `amount` grown by `percent` (a JavaScript number such as 7.5), in paise,
 * rounded half away from zero. The percentage is read exactly, so a tie at the
 * half paisa is rounded up in magnitude and not by a float's error.
 */
export function grownByPercent(amount: bigint, percent: number): bigint {
  const pct = fractionOf(percent);
  return amount + mulRatio(amount, pct.num, pct.den * 100n);
}
