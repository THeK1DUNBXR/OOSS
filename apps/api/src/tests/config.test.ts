/**
 * The environment gate.
 *
 * These assert refusals, which is the whole point of the module: the bug this
 * replaces was a fallback that let a misconfigured deploy start. A test that
 * only checked the happy path would have passed against the old code too.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { config, ConfigError, parseEnv } from '../platform/config.js';

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

  it('refuses to boot in production without UNSCOPED_DATABASE_URL, and names it', () => {
    // Without it the cross-tenant jobs, the audit hash chain and the outbox
    // drain have no role that can read across tenants, so they see nothing.
    const production = { ...valid, NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: 'k'.repeat(32) };
    expect(() => parseEnv(production)).toThrow(/UNSCOPED_DATABASE_URL/);
    expect(() => parseEnv({ ...production, UNSCOPED_DATABASE_URL: valid.DATABASE_URL })).not.toThrow();
  });

  it('allows an absent UNSCOPED_DATABASE_URL outside production', () => {
    expect(() => parseEnv(valid)).not.toThrow();
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

describe('field encryption key and marketing unsubscribe secret', () => {
  it('refuses to boot in production without FIELD_ENCRYPTION_KEY, and names it', () => {
    // The dev key is a public constant in privacy.ts. Under it, every PAN and
    // bank value written by a production deploy is encrypted with a key anyone
    // with the source can compute, so the encryption protects nothing.
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      parseEnv({ ...valid, NODE_ENV: 'production' });
    } catch (err) {
      expect((err as ConfigError).message).toContain('FIELD_ENCRYPTION_KEY');
    }
  });

  it('refuses an absent FIELD_ENCRYPTION_KEY in development and test too, and names it', () => {
    // Outside production this used to fall back to a constant printed in
    // privacy.ts. Encryption under a public key protects nothing, so every
    // environment supplies its own key; dev and CI do so in their own config.
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => parseEnv({ ...valid, NODE_ENV })).toThrow(ConfigError);
      try {
        parseEnv({ ...valid, NODE_ENV });
      } catch (err) {
        expect((err as ConfigError).message).toContain('FIELD_ENCRYPTION_KEY');
      }
    }
  });

  it('does not sign marketing unsubscribe tokens with the literal dev-secret-change-me', async () => {
    // Old code: `process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET
    // || 'dev-secret-change-me'`, so a process with no JWT_SECRET in its
    // environment signed unsubscribe links with a string printed in this repo.
    const { unsubscribeToken } = await import('../domains/marketing/preferences.js');
    const saved = { m: process.env.MARKETING_UNSUBSCRIBE_SECRET, j: process.env.JWT_SECRET };
    delete process.env.MARKETING_UNSUBSCRIBE_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const token = unsubscribeToken('person-1');
      const literal = createHmac('sha256', 'dev-secret-change-me').update('person-1').digest('hex');
      expect(token).not.toBe(literal);
      expect(token).toBe(createHmac('sha256', config.JWT_SECRET).update('person-1').digest('hex'));
    } finally {
      if (saved.m !== undefined) process.env.MARKETING_UNSUBSCRIBE_SECRET = saved.m;
      if (saved.j !== undefined) process.env.JWT_SECRET = saved.j;
    }
  });
});
