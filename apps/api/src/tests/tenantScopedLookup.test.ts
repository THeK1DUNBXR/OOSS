/**
 * A unique lookup is tenant-scoped in the statement itself (FX-51).
 *
 * The extension used to fetch a row by id and only then compare its tenantId,
 * and only if the select happened to return one. A `select` without tenantId
 * therefore loaded whatever row the id named. RLS hides a foreign row from the
 * application role, so the refusal a user sees is the database's, and this
 * test asserts the statement itself: the Person lookup carries tenantId in its
 * WHERE clause. Observing the SQL needs a process that logs it, so this spawns
 * tenantScopedLookup.child.ts rather than replacing anything in-process.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { tenantId } from './helpers.js';

const FOREIGN_PERSON_ID = 'cforeignpersonprobe000000';

let output = '';
let status: number | null = null;

beforeAll(async () => {
  const tid = await tenantId();
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./tenantScopedLookup.child.ts', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        PRISMA_LOG: 'query',
        PROBE_TENANT_ID: tid,
        PROBE_FOREIGN_ID: FOREIGN_PERSON_ID,
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  status = child.status;
  output = `${child.stdout}\n${child.stderr}`;
}, 130_000);

describe('FX-51: a unique lookup carries the tenant in its statement', () => {
  it('runs the child to completion, so the statements below are real', () => {
    expect(status, output.slice(-2000)).toBe(0);
    expect(output).toContain('PROBE-RESULT null');
  });

  it('every Person lookup sent to Postgres filters on tenantId, not only on id', () => {
    const personLookups = output.split('\n').filter((line) => /SELECT .*FROM "public"\."people"/.test(line));
    // Positive control: the lookup did reach the database and was logged.
    expect(personLookups.length).toBeGreaterThan(0);
    for (const line of personLookups) {
      expect(line, line).toContain('"tenantId"');
    }
  });
});
