-- Level-based access, PR11b: tag a Grant with the assignment it was compiled from
-- (ACCESS-MODEL-PLAN s.5.5; P11-DESIGN a, O4).
--
-- A typed column, not conditions.assignmentId: roleAssignment.ts compares conditions
-- for equality, so a tag there would make a confirmed Head grant uncovered for its own
-- confirmer. Null for every existing row, so the legacy path is untouched.
--
-- The name sorts after 20261013180000_access_model and before 20261013190000, so the
-- grants table is already under RLS when this runs. No DML: every existing row keeps
-- the null tag, so the FORCE RLS backfill loop does not apply.
--
-- The composite foreign key is nullable as a whole: Postgres skips the check when
-- accessAssignmentId is null (MATCH SIMPLE), so role and individual grants pass.

-- AlterTable
ALTER TABLE "grants" ADD COLUMN     "accessAssignmentId" TEXT;

-- CreateIndex
CREATE INDEX "grants_tenantId_accessAssignmentId_idx" ON "grants"("tenantId", "accessAssignmentId");

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_tenantId_accessAssignmentId_fkey" FOREIGN KEY ("tenantId", "accessAssignmentId") REFERENCES "access_assignments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
