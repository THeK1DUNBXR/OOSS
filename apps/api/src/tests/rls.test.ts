/**
 * Row-level security (FX-51) — the database refusing, not the application.
 *
 * The Prisma extension already injects tenantId into every where clause, so a
 * test that goes through it proves nothing about RLS: it would pass with the
 * policies removed. These tests connect as the dedicated app role with a raw
 * client and ask the database directly, because the question is what Postgres
 * does when the application forgets, which is the only case RLS exists for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertAppRoleRestricted, assertUnscopedRoleBypasses } from '../platform/rlsGuard.js';
import { asUser, tenantId } from './helpers.js';
import { prisma } from '../platform/db.js';

const OWNER_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public';
const APP_URL = process.env.TEST_APP_DATABASE_URL ?? OWNER_URL.replace('//kaizen:kaizen@', '//kaizen_app:kaizen_app@');

let app: PrismaClient;
let owner: PrismaClient;
let tenantA: string;

beforeAll(async () => {
  app = new PrismaClient({ datasourceUrl: APP_URL });
  owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  tenantA = await tenantId();
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('RLS-001 default deny', () => {
  it('returns zero rows from a tenant table when app.tenant_id is unset', async () => {
    const [{ n: seeded }] = await owner.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "users"`;
    expect(Number(seeded)).toBeGreaterThan(0);
    const [{ n }] = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "users"`;
    expect(Number(n)).toBe(0);
  });

  it('refuses a write with no tenant set', async () => {
    await expect(
      app.$executeRaw`INSERT INTO "record_sequences" ("id","tenantId","entityType","year","nextSequence") VALUES ('rls-x', ${tenantA}, 'RLS', 2000, 1)`,
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('RLS-002 tenant isolation', () => {
  it('shows tenant A only its own rows and tenant B none of them', async () => {
    const readAs = (t: string) =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
        return tx.$queryRaw<{ tenantId: string }[]>`SELECT "tenantId" FROM "users"`;
      });
    const a = await readAs(tenantA);
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a.map((r) => r.tenantId))).toEqual(new Set([tenantA]));
    expect(await readAs('tenant-that-does-not-exist')).toHaveLength(0);
  });

  it('refuses a row written into another tenant', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx.$executeRaw`INSERT INTO "record_sequences" ("id","tenantId","entityType","year","nextSequence") VALUES ('rls-y', 'some-other-tenant', 'RLS', 2000, 1)`;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the setting does not leak to the next transaction on the same connection', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
    });
    const [{ n }] = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "users"`;
    expect(Number(n)).toBe(0);
  });
});

describe('RLS-003 every tenant table is covered', () => {
  // Checked against the database, not the migration files: a table added by a
  // later migration without RLS fails here, in CI, rather than in production.
  it('has ENABLE, FORCE and the tenant_isolation policy on every table that carries a tenantId column', async () => {
    const uncovered = await owner.$queryRaw<{ t: string }[]>`
      SELECT c.table_name AS t
        FROM information_schema.columns c
        JOIN pg_class k ON k.relname = c.table_name AND k.relkind = 'r'
        JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
       WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
         AND NOT (
           k.relrowsecurity AND k.relforcerowsecurity
           AND EXISTS (
             SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.table_name AND p.policyname = 'tenant_isolation'
           )
         )`;
    expect(uncovered.map((r) => r.t)).toEqual([]);
  });
});

describe('RLS-007 the scoped client is refused inside an interactive transaction', () => {
  // The outer client's statement would run on the pool, outside the transaction
  // that set the tenant, and read zero rows without an error. Refusing it is the
  // only way the mistake is visible.
  it('throws for prisma.* used inside prisma.$transaction, and does not return an empty result', async () => {
    await expect(
      asUser('chairman@kaizen.co.in', async () =>
        prisma.$transaction(async () => prisma.user.count()),
      ),
    ).rejects.toThrow(/interactive transaction/i);
  });

  it('still counts rows through the transaction client', async () => {
    const count = await asUser('chairman@kaizen.co.in', async () =>
      prisma.$transaction(async (tx) => tx.user.count()),
    );
    expect(count).toBeGreaterThan(0);
  });
});

describe('RLS-004 the Prisma tenant path sets app.tenant_id', () => {
  it('reads through the scoped client inside a request context as the app role', async () => {
    const count = await asUser('chairman@kaizen.co.in', async () => prisma.user.count());
    expect(count).toBeGreaterThan(0);
  });
});

describe('RLS-005 boot check', () => {
  it('accepts the app role', async () => {
    await expect(assertAppRoleRestricted(app)).resolves.toBeUndefined();
  });

  it('refuses a role that is superuser or bypasses RLS', async () => {
    const [{ rolsuper, rolbypassrls }] = await owner.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    // The migration-owner role is deliberately privileged; if a deployment's is
    // not, there is nothing here to refuse and the assertion would be vacuous.
    expect(rolsuper || rolbypassrls).toBe(true);
    await expect(assertAppRoleRestricted(owner)).rejects.toThrow(/rolsuper|rolbypassrls/);
  });
});

describe('RLS-006 the unscoped role must bypass RLS', () => {
  // The jobs, the audit hash chain and the outbox drain read across tenants
  // through the unscoped client. Under the application role they would see no
  // rows and fail silently, so the boot check requires the bypass to be there.
  it('accepts the owner, which has BYPASSRLS', async () => {
    await expect(assertUnscopedRoleBypasses(owner)).resolves.toBeUndefined();
  });

  it('refuses the application role, which does not', async () => {
    await expect(assertUnscopedRoleBypasses(app)).rejects.toThrow(/rolbypassrls/);
  });
});
