/**
 * Money is a signed bigint count of minor units (paise). No `number`, no float,
 * no Decimal: a float here is the sub-paisa error that finance.ts accepted with
 * `>= x - 0.001` epsilons, and num() in platform/db.ts is where it entered.
 *
 * Every rounding in this file is half away from zero, because credit notes and
 * reversals are negative and Math.round(-2.5) === -2 would round them the other
 * way from the positive invoice they reverse.
 */

/** Postgres BIGINT ceiling. A value that does not fit the column cannot be stored, so it is refused at parse. */
const INT64_MAX = 9223372036854775807n;

const DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function add(a: bigint, b: bigint): bigint {
  return a + b;
}

export function sub(a: bigint, b: bigint): bigint {
  return a - b;
}

export function neg(a: bigint): bigint {
  return -a;
}

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compare(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isZero(a: bigint): boolean {
  return a === 0n;
}

/**
 * Parses a decimal string of at most two places. Strict on purpose: "1.234"
 * is refused rather than rounded, because a third decimal in an input is
 * almost always a unit mistake (rupees typed as paise, or a rate pasted into
 * an amount field) and rounding it would hide that.
 */
export function parseMinor(text: string): bigint {
  if (typeof text !== 'string') {
    throw new TypeError('parseMinor takes a decimal string; a JavaScript number may already be a rounded float');
  }
  const match = DECIMAL.exec(text);
  if (!match) throw new SyntaxError(`not a decimal amount: ${JSON.stringify(text)}`);
  const [, sign, whole, fraction = ''] = match;
  const paise = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (paise > INT64_MAX) throw new RangeError(`amount out of the 64-bit range: ${text}`);
  return sign === '-' ? -paise : paise;
}

/** Two decimal places always, a leading minus only when negative. No grouping: display formatting is the caller's. */
export function formatMinor(amount: bigint): string {
  if (typeof amount !== 'bigint') throw new TypeError('formatMinor takes bigint paise');
  const magnitude = abs(amount);
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${amount < 0n ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Multiplies by num/den and rounds half away from zero. Written as an integer
 * remainder test rather than adding half the denominator first, because the
 * latter rounds -5/2 to -2 once the sign is folded in.
 */
export function mulRatio(amount: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError('mulRatio: zero denominator');
  const product = amount * num;
  const negative = product < 0n !== den < 0n;
  const p = abs(product);
  const d = abs(den);
  let quotient = p / d;
  if (2n * (p % d) >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

/**
 * Splits `total` in proportion to `weights`, so the parts sum exactly to the
 * total and each part is strictly less than one paisa from its exact share.
 *
 * The leftover paise go to the first line, in input order, whose share has a
 * fraction. A line whose share is exact is skipped: giving it a paisa would put
 * it a full paisa from its share, outside the bound. The caller is responsible
 * for a stable input order (sort by id before calling); allocate never sorts,
 * so the same weights in a different order yield a different, still-exact split.
 *
 * A negative total is the sign times the split of its magnitude, so -100 by
 * three equal weights is -34/-33/-33, matching the positive case.
 */
export function allocate(total: bigint, weights: readonly (bigint | number)[]): bigint[] {
  if (typeof total !== 'bigint') throw new TypeError('allocate takes a bigint total');
  if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
  const w = weights.map(weightOf);
  const sumWeights = w.reduce((a, b) => a + b, 0n);
  if (sumWeights === 0n) throw new RangeError('allocate: all weights are zero');

  const magnitude = abs(total);
  const parts = w.map((wi) => (magnitude * wi) / sumWeights);
  const remainders = w.map((wi) => (magnitude * wi) % sumWeights);
  let leftover = magnitude - parts.reduce((a, b) => a + b, 0n);
  for (let i = 0; i < parts.length && leftover > 0n; i++) {
    if (remainders[i]! > 0n) {
      parts[i] = parts[i]! + 1n;
      leftover -= 1n;
    }
  }
  // Each remainder is below the weight sum, and their total is leftover times the
  // weight sum, so there are always enough fractional lines to place every paisa.
  if (leftover !== 0n) throw new Error('allocate: leftover paise not placed');

  return total < 0n ? parts.map(neg) : parts;
}

/** Basis points: 1800 is 18%. Rounds half away from zero. */
export function applyBps(amount: bigint, bps: bigint | number): bigint {
  return mulRatio(amount, integerArg(bps, 'bps'), 10_000n);
}

/**
 * Converts at a rate in integer parts per million. A float rate such as 83.5 is
 * stored as 83_500_000: the fraction is fixed at the point the rate is entered,
 * not decided by floating-point multiplication at posting time.
 */
export function convertPpm(amount: bigint, ratePpm: bigint | number): bigint {
  return mulRatio(amount, integerArg(ratePpm, 'ratePpm'), 1_000_000n);
}

function weightOf(value: bigint | number): bigint {
  const w = integerArg(value, 'weight');
  if (w < 0n) throw new RangeError('allocate: weights must not be negative');
  return w;
}

function integerArg(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer`);
}
