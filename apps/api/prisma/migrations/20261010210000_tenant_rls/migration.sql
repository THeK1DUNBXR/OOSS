-- FX-51: row-level security on every table that carries a "tenantId" column.
--
-- Why this exists: the Prisma tenant extension (platform/db.ts) is the first
-- line and rewrites every where clause. It is not the only line. A raw client,
-- a new query path that forgets the extension, or a `select` that omits the
-- tenant column all reach the table unfiltered unless the database refuses.
-- Policies make that refusal the database's job.
--
-- The policy reads current_setting('app.tenant_id'). It is set per transaction
-- by platform/db.ts; an unset or empty setting matches no row (default deny).
-- FORCE makes the policy bind the table owner too; BYPASSRLS roles are the only
-- ones it does not bind, which is why the application role must not have it
-- (platform/rlsGuard.ts refuses to boot otherwise).
--
-- Tables without a "tenantId" column are not covered here: they are listed in
-- the FX-51 report, and the cross-tenant ones (tenants, principals) are read
-- through the scoped client's exemption list in db.ts.

-- 1. The application role. Created without a login: deployment sets the
--    password (see scripts/test-db.sh for the test database). It is never the
--    owner, because the owner bypasses nothing and is the role that may run
--    migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    CREATE ROLE "kaizen_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA "public" TO "kaizen_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "kaizen_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "kaizen_app";
-- Tables and sequences created by later migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "kaizen_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO "kaizen_app";

-- The migration history is not application data. Guarded: a shadow database
-- replayed by `migrate diff --from-migrations` has no such table yet.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON "_prisma_migrations" FROM "kaizen_app"';
  END IF;
END
$$;

-- Posted journal lines are never changed or removed (CLAUDE.md rule 2). The
-- entry-level trigger guards journal_entries; these grants are the role's
-- own refusal for lines and for deletion of entries.
REVOKE UPDATE, DELETE ON "journal_lines" FROM "kaizen_app";
REVOKE DELETE ON "journal_entries" FROM "kaizen_app";

-- 2. Enable, force and police every table that has a tenantId column. Generated
--    rather than listed so that the set cannot drift from the schema on this
--    migration; RLS-003 in the suite is the check for tables added later.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name AS name
      FROM information_schema.columns c
      JOIN pg_class k ON k.relname = c.table_name AND k.relkind = 'r'
      JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
     WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.name);
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation" ON %I', t.name);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I '
      'USING ("tenantId" = current_setting(''app.tenant_id'', true)) '
      'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
      t.name
    );
  END LOOP;
END
$$;
