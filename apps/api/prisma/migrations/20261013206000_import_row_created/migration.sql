-- FX-71a: an import row records every record it created, so a revert undoes
-- exactly those and nothing a batch merely matched or touched.
--
-- ADD COLUMN only, nullable, with no default and no backfill: rows committed
-- before this column exists keep NULL, and a revert takes them by entityType as
-- it always did. Nothing is written under FORCE RLS here, so no tenant loop is
-- needed (import_rows is a tenant table under 20261010235900_tenant_rls, which
-- ADD COLUMN leaves alone).

-- AlterTable
ALTER TABLE "import_rows" ADD COLUMN "created" JSONB;
