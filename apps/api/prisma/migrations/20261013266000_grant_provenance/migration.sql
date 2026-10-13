-- C-015 stopgap IT owner grant (DECISIONS round 24 item c; ACCESS-MODEL-PLAN Wave 4 IT-owner conflict).
--
-- grants.provenance tags a grant the founder created before onboarding names an IT admin.
-- Only 'to_migrate' is a value the database accepts: the stopgap is replaced at onboarding,
-- and a row tagged with anything else would be a grant nobody is listed to migrate.
-- Null is every other grant, so existing rows need no backfill.
--
-- No DML here, so the FORCE RLS loop (BRIEF, migration DML) does not apply. grants already
-- carries its RLS policy; adding a column does not change it.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "grants" ADD COLUMN "provenance" TEXT;

-- CreateIndex
CREATE INDEX "grants_tenantId_provenance_idx" ON "grants"("tenantId", "provenance");

-- Invariants Prisma cannot express. ----------------------------------------
ALTER TABLE "grants"
  ADD CONSTRAINT "grants_provenance_check" CHECK ("provenance" IS NULL OR "provenance" = 'to_migrate');
