-- Separation of duties at confirm, and the founder's recorded override (Wave 6, PR12;
-- ACCESS-MODEL-PLAN s.8; P11-DESIGN section a).
--
-- access_sod_overrides holds one founder override of one built-in pair on one
-- assignment. The pair is code (packages/shared sod.ts), so the row names it by code and
-- the reason is the founder's logged justification. A row is written once and never
-- changed: an override that was a mistake is answered by expiring the assignment, not by
-- editing the record.
--
-- access_assignments.hrCaseId links a mapping to the HR case that records it (O9 A).
--
-- This is a new migration, not an edit to 20261013180000_access_model or
-- 20261013181000_access_sole_confirmer: those have been applied, and an applied migration
-- never changes. No DML here, so the FORCE RLS loop (BRIEF, migration DML) does not apply.

-- AlterTable
ALTER TABLE "access_assignments" ADD COLUMN "hrCaseId" TEXT;

-- CreateTable
CREATE TABLE "access_sod_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "pairCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "overriddenById" TEXT NOT NULL,
    "overriddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exceptionId" TEXT,

    CONSTRAINT "access_sod_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_sod_overrides_tenantId_assignmentId_pairCode_key" ON "access_sod_overrides"("tenantId", "assignmentId", "pairCode");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_engagement_hr_cases_tenantId_id_key" ON "hcm_engagement_hr_cases"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "access_assignments" ADD CONSTRAINT "access_assignments_tenantId_hrCaseId_fkey" FOREIGN KEY ("tenantId", "hrCaseId") REFERENCES "hcm_engagement_hr_cases"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_sod_overrides" ADD CONSTRAINT "access_sod_overrides_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "access_assignments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express.
-- ---------------------------------------------------------------------------

-- A blank reason is not a reason, and a blank pair code names nothing.
ALTER TABLE "access_sod_overrides"
  ADD CONSTRAINT "access_sod_overrides_reason_check" CHECK (btrim("reason") <> '');

ALTER TABLE "access_sod_overrides"
  ADD CONSTRAINT "access_sod_overrides_pair_code_check" CHECK (btrim("pairCode") <> '');

-- ---------------------------------------------------------------------------
-- Row-level security, written out so that rlsMigrationOrder.test.ts can read it.
-- ---------------------------------------------------------------------------

ALTER TABLE "access_sod_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_sod_overrides" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_sod_overrides";
CREATE POLICY "tenant_isolation" ON "access_sod_overrides"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The application role reads and adds overrides. It cannot change or remove one: an
-- override is part of the record of why an assignment was confirmed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    GRANT SELECT, INSERT ON "access_sod_overrides" TO "kaizen_app";
  END IF;
END
$$;
