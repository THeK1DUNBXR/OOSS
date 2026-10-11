/**
 * Every tenant table created by a migration must end up under RLS.
 *
 * The tenant RLS migration discovers tables when it runs, so it covers every
 * table created by a migration that sorts before it. A migration that sorts
 * after it and creates a tenant table must enable, force and police that table
 * itself — otherwise a fresh database leaves the table open.
 *
 * This used to assert that the RLS migration sorts last. That cannot hold:
 * every later migration sorts after it, including ones that only add a column
 * to a table it already covers (the 0.2 session columns broke CI that way).
 * rls.test.ts RLS-003 checks the migrated database; this checks the files, so
 * the failure names the migration that forgot.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);

function createdTenantTables(sql: string): string[] {
  const tables: string[] = [];
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"public"\.)?"([^"]+)"\s*\(([\s\S]*?)\n\);/gi;
  for (const m of sql.matchAll(re)) {
    if (/"tenantId"/.test(m[2])) tables.push(m[1]);
  }
  return tables;
}

describe('RLS migration ordering', () => {
  const dirs = readdirSync(migrationsDir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  const rlsIndex = dirs.findIndex((d) => d.endsWith('_tenant_rls'));

  it('has exactly one tenant RLS migration', () => {
    expect(dirs.filter((d) => d.endsWith('_tenant_rls'))).toHaveLength(1);
  });

  it('a migration after the RLS migration polices every tenant table it creates', () => {
    const open: string[] = [];
    for (const dir of dirs.slice(rlsIndex + 1)) {
      const sql = readFileSync(new URL(`${dir}/migration.sql`, migrationsDir), 'utf8');
      for (const table of createdTenantTables(sql)) {
        const enabled = new RegExp(`"${table}"\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sql);
        const forced = new RegExp(`"${table}"\\s+FORCE ROW LEVEL SECURITY`, 'i').test(sql);
        const policed = new RegExp(`CREATE POLICY[\\s\\S]*?ON\\s+(?:"public"\\.)?"${table}"`, 'i').test(sql);
        if (!(enabled && forced && policed)) open.push(`${dir}: ${table}`);
      }
    }
    expect(open).toEqual([]);
  });
});
