/**
 * The tenant RLS migration must run after every table it polices exists.
 *
 * It discovers tables when it runs, so a migration that sorts before a later
 * migration's CREATE TABLE leaves that table without a policy on a fresh
 * database. Asserting the order here keeps the failure out of production.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('RLS migration ordering', () => {
  it('sorts the tenant RLS migration after every other migration', () => {
    const dirs = readdirSync(new URL('../../prisma/migrations', import.meta.url))
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    const rls = dirs.filter((d) => d.endsWith('_tenant_rls'));
    expect(rls).toHaveLength(1);
    expect(rls[0]).toBe(dirs[dirs.length - 1]);
  });
});
