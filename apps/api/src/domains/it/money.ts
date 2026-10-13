/**
 * The rupee side of the IT money columns (MONEY-S8-IT). The columns are paise;
 * a legacy field keeps the rupee number it has always carried, so the wire
 * stays unchanged for one wave. The conversion is `poundsOf` (allocation.ts),
 * which prints the two places and reads them back, rather than a second copy
 * of the same float conversion.
 */

import { poundsOf } from '../allocation.js';
import { minorString, type WithMinorPair } from '../../platform/wire.js';

/** A paise column as the rupee number a legacy field carries. */
export function minorToRupees(minor: bigint): number {
  return poundsOf(minor);
}

/**
 * A row with paise columns, shaped for a path that already sent the rupee
 * number: each `<name>` is a JavaScript number, and `<name>Minor` is the
 * paise string.
 */
export function withNumberMinor<T extends object, N extends string>(
  row: T,
  names: readonly N[],
): WithMinorPair<T, N, number | null> {
  const out = { ...row } as Record<string, unknown>;
  for (const name of names) {
    const minor = (row as Record<string, unknown>)[`${name}Minor`] as bigint | null | undefined;
    out[name] = minor === null || minor === undefined ? null : minorToRupees(minor);
    out[`${name}Minor`] = minorString(minor);
  }
  return out as WithMinorPair<T, N, number | null>;
}
