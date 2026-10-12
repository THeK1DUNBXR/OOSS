-- FX-71b (Wave 5 PR5, decision O8 (a)): a spin-out revert reverses and marks;
-- it no longer deletes. The rows it used to hard-delete stay, and this file adds
-- the two things that say so.
--
-- The CREATE TABLE and index statements are what `prisma migrate diff` generates
-- from the schema; everything below the line of hand-written SQL is an invariant
-- Prisma cannot express. The tenant table is policed by this file itself, so
-- rlsMigrationOrder.test.ts reads it as covering the table.

-- 1. The marker on each of the nine register and enrolment models the revert
--    used to delete from. Transaction is not in the list: a reversed transaction
--    is marked by its reversedById, which the table already carries.
ALTER TABLE "organizations" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "share_classes" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "holders" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "share_transactions" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "share_certificates" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "courses" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "cohorts" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "enrollments" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);
ALTER TABLE "employment_relationships" ADD COLUMN "spinOutRevertedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "spinout_tombstones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "holdingTenantId" TEXT NOT NULL,
    "revertedById" TEXT,
    "revertedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed" JSONB NOT NULL,

    CONSTRAINT "spinout_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spinout_tombstones_tenantId_batchId_key" ON "spinout_tombstones"("tenantId", "batchId");

-- ---------------------------------------------------------------------------
-- Hand-written from here down.
-- ---------------------------------------------------------------------------

-- 2. A tombstone is a record of a revert and is never edited or removed. The
--    trigger refuses both for every role, the owner included, as the commitment
--    history does (20261013100000_commitment_record).
CREATE OR REPLACE FUNCTION "spinout_tombstones_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spin-out tombstones are immutable; a correction is a new revert, which the batch refuses'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "spinout_tombstones_immutable"
  BEFORE UPDATE OR DELETE ON "spinout_tombstones"
  FOR EACH ROW EXECUTE FUNCTION "spinout_tombstones_immutable"();

-- 3. Row-level security on the new table, written out so that
--    rlsMigrationOrder.test.ts can read it.
ALTER TABLE "spinout_tombstones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spinout_tombstones" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spinout_tombstones";
CREATE POLICY "tenant_isolation" ON "spinout_tombstones"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
