import { decimalToMinor, parseMinor, type DecimalLike } from '@kaizen/shared';

export type { DecimalLike };

/**
 * BigInt has no JSON form, and JSON.stringify throws on one, so a BigInt column
 * that reaches a response has to become a string at the boundary. Strings, not
 * numbers: `seq` is small today, but nothing stops it passing 2^53, and a
 * JavaScript client would then round it without any error.
 */

/** A BigInt column as it goes on the wire. */
export function wireInt(value: bigint): string {
  return value.toString();
}

/**
 * The replacer Express's `res.json` uses for every response (set in server.ts).
 * It is the backstop for a route that returns a raw row; the explicit mapping
 * in a route is still the contract a client reads.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * A Decimal money column as paise on the wire. Computed from the Decimal's own
 * two-place string and never from a JavaScript number: a number that reached
 * here has already been rounded by whoever made it, and a rounded float is
 * exactly what the paise field exists to avoid.
 */
export function minorOf(value: DecimalLike): string;
export function minorOf(value: DecimalLike | null | undefined): string | null;
export function minorOf(value: DecimalLike | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') throw new TypeError('minorOf takes a Decimal, not a JavaScript number');
  return wireInt(decimalToMinor(value));
}

export type MinorFields<T, K extends keyof T> = { [P in K as `${P & string}Minor`]: string | null };

/**
 * A row with a `<field>Minor` sibling for each listed money field. The original
 * field is kept as it was: the numeric field is dual-emitted for one wave, so a
 * client can move across without a flag day.
 */
export function withMinor<T extends object, K extends keyof T & string>(
  row: T,
  keys: readonly K[],
): T & MinorFields<T, K> {
  const out = { ...row } as Record<string, unknown>;
  for (const key of keys) {
    out[`${key}Minor`] = minorOf(row[key] as unknown as DecimalLike | null | undefined);
  }
  return out as T & MinorFields<T, K>;
}

/**
 * The sum of Decimal money columns, exact in paise. Returned as bigint so a caller
 * can subtract another sum from it; the wire string is `wireInt` of the result.
 */
export function paiseSum(values: readonly DecimalLike[]): bigint {
  return values.reduce((total, value) => total + parseMinor(value.toFixed(2)), 0n);
}
