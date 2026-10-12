/**
 * The boot refusal, exercised by a real process.
 *
 * config.test.ts asserts the schema refuses (parseEnv throws). That does not
 * prove the process ends, or that an operator reading the terminal learns which
 * variable to set. These run the loader in a child process, the way a deploy
 * does, and assert on the exit status and on what is printed.
 *
 * The child gets an explicit environment and not this process's own: vitest
 * injects a complete, valid environment into its workers, and a child that
 * inherited it would boot even with the variable under test removed.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../..');
const entry = resolve(here, 'bootConfigEntry.ts');

// Distinct, recognisable values, so an assertion that the output never echoes
// a secret can fail on a real leak and not on a coincidence.
const JWT_SECRET = 'ProbeJwtSecretNotToBeEchoed'.padEnd(32, '#');
const FIELD_ENCRYPTION_KEY = 'ProbeFieldKeyNotToBeEchoed'.padEnd(32, '#');
const SECRETS = [JWT_SECRET, FIELD_ENCRYPTION_KEY];

const complete: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db?schema=public',
  JWT_SECRET,
  FIELD_ENCRYPTION_KEY,
  // Keeps a developer's own apps/api/.env from supplying a variable this test
  // removes. See platform/config.ts loadDotEnv.
  KAIZEN_SKIP_DOTENV: '1',
};

function boot(env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd: apiRoot,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function without(env: Record<string, string>, name: string): Record<string, string> {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

describe('boot refusal in a real process', () => {
  it('boots with the complete environment (positive control, so the refusals below mean something)', () => {
    const run = boot(complete);
    expect(run.output).toContain('config-ok development');
    expect(run.status).toBe(0);
  });

  for (const name of ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY']) {
    it(`exits non-zero without ${name}, names it, and prints no secret`, () => {
      const run = boot(without(complete, name));
      expect(run.status).not.toBe(0);
      expect(run.output).not.toContain('config-ok');
      expect(run.output).toContain(name);
      for (const secret of SECRETS) expect(run.output).not.toContain(secret);
    });
  }

  for (const NODE_ENV of ['development', 'test']) {
    it(`refuses without FIELD_ENCRYPTION_KEY when NODE_ENV=${NODE_ENV}`, () => {
      const run = boot({ ...without(complete, 'FIELD_ENCRYPTION_KEY'), NODE_ENV });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('FIELD_ENCRYPTION_KEY');
    });
  }

  it('exits non-zero with a 31-character JWT_SECRET, names it, and prints no secret', () => {
    const short = 'ProbeJwtSecretNotToBeEchoed'.padEnd(31, '#');
    expect(short).toHaveLength(31);
    const run = boot({ ...complete, JWT_SECRET: short });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('JWT_SECRET');
    expect(run.output).toContain('at least 32 characters');
    expect(run.output).not.toContain(short);
  });
});
