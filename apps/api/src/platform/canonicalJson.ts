/**
 * The canonical serialisation both hash chains hash. It lives apart from
 * audit.ts and eventBus.ts so that neither has to import the other.
 */

/** Deep-sorts object keys so the hash is independent of how a JSON column happens to have stored them. */
function sortDeep(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    // A Decimal (or anything else with its own JSON representation) is
    // serialised through that representation rather than walked as a plain
    // object — walking a Decimal's own keys would silently produce `{}`.
    const toJSON = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return sortDeep(toJSON.call(v));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}
