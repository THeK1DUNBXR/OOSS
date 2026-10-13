import { Prisma } from '@prisma/client';
import { decimalToMinor, formatMinor, parseMinor, toMinorHalfUp, type DecimalLike } from '@kaizen/shared';

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

/**
 * A paise column as the Decimal a raw Prisma row used to carry. Its JSON form
 * is the same two-place string the Decimal column produced, so a raw-row path
 * keeps the type a client already reads.
 */
export function minorToDecimal(minor: bigint): Prisma.Decimal;
export function minorToDecimal(minor: bigint | null | undefined): Prisma.Decimal | null;
export function minorToDecimal(minor: bigint | null | undefined): Prisma.Decimal | null {
  if (minor === null || minor === undefined) return null;
  return new Prisma.Decimal(formatMinor(minor));
}

/** The paise column's wire string, or null. */
export function minorString(minor: bigint | null | undefined): string | null {
  return minor === null || minor === undefined ? null : wireInt(minor);
}

/** T with each named paise column replaced by the wire pair: `<name>` (value V) and `<name>Minor` (string). */
export type WithMinorPair<T, N extends string, V> = Omit<T, `${N}Minor`> & {
  [K in N]: V;
} & { [K in N as `${K}Minor`]: string | null };

/**
 * A raw Prisma row with paise columns, shaped as it was before the conversion:
 * each `<name>` is the Decimal the column used to return, and `<name>Minor`
 * is its paise string. Every raw-row return path of a converted model passes
 * through here, so the wire type does not change.
 */
export function withDecimalMinor<T extends object, N extends string>(
  row: T,
  names: readonly N[],
  options: { canSee?: boolean } = {},
): WithMinorPair<T, N, Prisma.Decimal | null> {
  const out = { ...row } as Record<string, unknown>;
  for (const name of names) {
    const minor = (row as Record<string, unknown>)[`${name}Minor`] as bigint | null | undefined;
    out[name] = minorToDecimal(minor);
    // The rupee field is left as the caller had it; only the paise sibling is withheld.
    out[`${name}Minor`] = options.canSee === false ? null : minorString(minor);
  }
  return out as WithMinorPair<T, N, Prisma.Decimal | null>;
}

/**
 * A rupee number from a request body, as paise. Rounded half away from zero to
 * two places and refused for NaN or infinity, so the write never goes through a
 * float sum.
 */
export function rupeesToMinor(rupees: number): bigint {
  return toMinorHalfUp(rupees);
}

/** As rupeesToMinor, with `undefined` left undefined (the column is not touched) and `null` as null. */
export function rupeesToMinorOrNull(rupees: number | null | undefined): bigint | null | undefined {
  if (rupees === undefined) return undefined;
  return rupees === null ? null : toMinorHalfUp(rupees);
}

/**
 * A paise value as the rupee string Prisma's Decimal printed for the same figure:
 * the same digits with trailing zeros dropped ("1234.5", "1000", "0"). A route
 * that used to return a raw Decimal row keeps its JSON this way, with the paise
 * sibling added beside it.
 */
export function decimalWire(minor: bigint): string {
  const magnitude = minor < 0n ? -minor : minor;
  const whole = (magnitude / 100n).toString();
  const fraction = (magnitude % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return minor < 0n ? `-${body}` : body;
}

/**
 * Paise as a JavaScript number in rupees, for the places that have always sent
 * one (a list of figures, the arguments of the shared GST functions). Exact for
 * any figure a GST return can hold: the quotient of two exact integers is the
 * nearest double to the two-place decimal, which is what Number() of Prisma's
 * string gives. Kept off the write path: money goes in as paise.
 */
export function rupeesOf(minor: bigint): number {
  return Number(minor) / 100;
}

/** A paise column as the rupee number a legacy field carries, null when the column is null. */
export function rupeesOrNull(minor: bigint | null | undefined): number | null {
  return minor === null || minor === undefined ? null : rupeesOf(minor);
}

/** A paise column as rupees for a sum: zero when the figure is not held. */
export function rupeesOrZero(minor: bigint | null | undefined): number {
  return minor === null || minor === undefined ? 0 : rupeesOf(minor);
}

/**
 * A row whose paise columns (`<key>Minor`, bigint) go back out as the Decimal-string
 * rupee fields they were, with the paise sibling beside each. The rupee fields
 * are the ones the web reads; the sibling is the one a new client should use.
 */
export function withRupeeWire<T extends object>(row: T, keys: readonly string[]): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of keys) {
    const minor = source[`${key}Minor`] as bigint;
    out[key] = decimalWire(minor);
    out[`${key}Minor`] = wireInt(minor);
  }
  return out;
}
