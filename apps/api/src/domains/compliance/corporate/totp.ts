/**
 * TOTP (RFC 6238) over HMAC-SHA1 (RFC 4226), implemented on `node:crypto`
 * rather than an added dependency — the platform's MFA second factor.
 *
 * Default period 30s, 6 digits, matching every authenticator app (Google
 * Authenticator, Authy, 1Password) a person would actually use.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the shape every authenticator app expects a secret in. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 20-byte (160-bit) secret — the size every RFC 6238 test vector and app assumes. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * HOTP (RFC 4226) over a raw key buffer. Exposed at this level, rather than
 * only via the base32-secret-facing `totp()`, so the RFC 6238 Appendix B test
 * vectors — published against the raw ASCII key — can be checked directly.
 */
export function hotpRaw(key: Buffer, counter: number | bigint, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const str = String(binCode % 10 ** digits);
  return str.padStart(digits, '0');
}

export function totpRaw(key: Buffer, atSeconds: number, step = 30, digits = 6): string {
  const counter = Math.floor(atSeconds / step);
  return hotpRaw(key, counter, digits);
}

export function totp(secretBase32: string, at: Date = new Date(), step = 30, digits = 6): string {
  return totpRaw(base32Decode(secretBase32), Math.floor(at.getTime() / 1000), step, digits);
}

/**
 * Accepts a code from one step early or late (clock drift, the walk from
 * generating the code to typing it), never wider — a bigger window is a
 * bigger replay surface.
 */
export function verifyTotp(secretBase32: string, code: string, at: Date = new Date(), window = 1, step = 30, digits = 6): boolean {
  const clean = code.trim();
  if (!/^\d+$/.test(clean) || clean.length !== digits) return false;
  const key = base32Decode(secretBase32);
  const nowSeconds = Math.floor(at.getTime() / 1000);
  for (let w = -window; w <= window; w += 1) {
    const candidate = totpRaw(key, nowSeconds + w * step, step, digits);
    const a = Buffer.from(candidate);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function otpauthUri(secretBase32: string, accountLabel: string, issuer = 'KaiERP'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
