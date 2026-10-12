/**
 * No fallback secret in the API source.
 *
 * A fallback is a literal that a secret takes when the environment does not
 * supply it: `process.env.JWT_SECRET || 'dev-secret-change-me'`, or the old
 * `secret ?? DEV_ENCRYPTION_KEY`. That is the defect FX-60 and the JWT incident
 * both were. Placeholder denylists (lib/auth.ts FALLBACK_JWT_SECRETS) are
 * refusals, not fallbacks, and are deliberately not matched.
 *
 * A text scan is blunt, but the failure it guards is a single line, and a
 * violation prints the file and line, so the fix is never a search.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const self = 'secretFallbacks.test.ts';

const FORBIDDEN_TEXT = [
  // The development encryption key, removed in favour of refusing to boot.
  'DEV_ENCRYPTION_KEY',
  'kaizen-dev-field-encryption-key',
];

// A secret-named value read with a literal default: `process.env.JWT_SECRET ||
// 'literal'`, or a camel-case `secret ?? "literal"`. Environment-style names
// only for KEY: `channelKey ?? 'website'` is a business value, not a secret.
const LITERAL_DEFAULT_FOR_SECRET = /\b(?:[A-Z][A-Z0-9_]*(?:SECRET|KEY)|\w*[Ss]ecret\w*)\s*(?:\|\||\?\?)\s*['"`]/;

// A placeholder used as a default, whatever the variable is called.
const PLACEHOLDER_DEFAULT = /(\|\||\?\?)\s*['"`][^'"`]*(change-me|dev-secret)/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== self ? [path] : [];
  });
}

/** True when a line reads a secret with a literal default, or carries a known fallback. */
function flags(line: string): boolean {
  // Comments quote the old code to explain why it is gone; only code can read a secret.
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) return false;
  return (
    FORBIDDEN_TEXT.some((text) => line.includes(text)) ||
    LITERAL_DEFAULT_FOR_SECRET.test(line) ||
    PLACEHOLDER_DEFAULT.test(line)
  );
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(srcRoot)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (flags(line)) found.push(`${relative(srcRoot, file)}:${index + 1}: ${line.trim()}`);
      });
  }
  return found;
}

describe('apps/api/src carries no fallback secret', () => {
  it('flags the planted shapes it exists to catch', () => {
    // Without these the scan could pass by matching nothing at all.
    expect(flags("const k = process.env.JWT_SECRET || 'dev-secret-change-me';")).toBe(true);
    expect(flags("const k = config.FIELD_ENCRYPTION_KEY ?? 'literal-fallback-value';")).toBe(true);
    expect(flags('const material = secret ?? DEV_ENCRYPTION_KEY;')).toBe(true);
    expect(flags("const token = signingKey || 'change-me-in-production';")).toBe(true);
    expect(flags("const bucketKey = `${w.campaignId ?? 'none'}`;")).toBe(false);
    expect(flags("channelKey: link.channelKey ?? 'website',")).toBe(false);
  });

  it('has no hardcoded development key and no secret read with a literal default', () => {
    expect(sourceFiles(srcRoot).length).toBeGreaterThan(100);
    expect(violations()).toEqual([]);
  });
});
