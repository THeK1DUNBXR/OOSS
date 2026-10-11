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
