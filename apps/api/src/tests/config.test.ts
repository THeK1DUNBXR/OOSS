/**
 * The environment gate.
 *
 * These assert refusals, which is the whole point of the module: the bug this
 * replaces was a fallback that let a misconfigured deploy start. A test that
 * only checked the happy path would have passed against the old code too.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../platform/config.js';

/** A minimal environment that parses, so each case can break exactly one thing. */
const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db?schema=public',
  JWT_SECRET: 'x'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('environment config', () => {
  it('refuses to start without JWT_SECRET, and names it', () => {
    const { JWT_SECRET: _omitted, ...withoutSecret } = valid;
    expect(() => parseEnv(withoutSecret)).toThrow(ConfigError);
    try {
      parseEnv(withoutSecret);
    } catch (err) {
      // Naming the variable is the requirement. "Invalid environment" sends
      // somebody reading a Zod stack trace at 2am.
      expect((err as ConfigError).message).toContain('JWT_SECRET');
      expect((err as ConfigError).message).toContain('is not set');
    }
  });

  it('refuses a JWT_SECRET shorter than 32 characters', () => {
    // The exact failure that shipped: `dev-secret-change-me` is 20.
    expect(() => parseEnv({ ...valid, JWT_SECRET: 'dev-secret-change-me' })).toThrow(/at least 32 characters/);
  });

  it('has no fallback secret at all', () => {
    const { JWT_SECRET: _omitted, ...withoutSecret } = valid;
    let parsed: unknown = null;
    try {
      parsed = parseEnv(withoutSecret);
    } catch {
      /* expected */
    }
    // Guards the regression directly: nothing may produce a usable config
    // without a secret supplied from outside.
    expect(parsed).toBeNull();
  });

  it('refuses a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = valid;
    expect(() => parseEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('refuses an unrecognised NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every problem at once, not just the first', () => {
    // A deploy missing three variables should learn that in one restart.
    const issues = (() => {
      try {
        parseEnv({ NODE_ENV: 'test' });
        return [];
      } catch (err) {
        return (err as ConfigError).issues;
      }
    })();
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.join(' ')).toContain('JWT_SECRET');
    expect(issues.join(' ')).toContain('DATABASE_URL');
  });

  it('applies defaults for everything optional', () => {
    const parsed = parseEnv(valid);
    expect(parsed.PORT).toBe(4000);
    expect(parsed.JOBS_ENABLED).toBe(false);
    expect(parsed.GRANT_AUTOSYNC).toBe(true);
    expect(parsed.TENANT_SLUG).toBe('kaizen');
  });

  it('reads booleanish variables the way a shell writes them', () => {
    expect(parseEnv({ ...valid, JOBS_ENABLED: 'true' }).JOBS_ENABLED).toBe(true);
    expect(parseEnv({ ...valid, GRANT_AUTOSYNC: 'off' }).GRANT_AUTOSYNC).toBe(false);
  });

  it('freezes the result, so nothing can rewrite config at runtime', () => {
    const parsed = parseEnv(valid);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('has no TENANT_ENFORCE_MODE — the tenant gate has no off switch', () => {
    const parsed = parseEnv({ ...valid, TENANT_ENFORCE_MODE: 'warn' }) as Record<string, unknown>;
    expect(parsed.TENANT_ENFORCE_MODE).toBeUndefined();
  });
});
