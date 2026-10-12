-- Duty assignments (round 27 c; round 23 d). Who holds a named tenant-level duty,
-- and from which instant to which. The statutory approver is resolved from this
-- table at runtime, so no person or role name is in code.
--
-- Prisma part first, then the hand-written invariants, in the business_lines style.

-- CreateTable
CREATE TABLE "duty_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dutyKey" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "assignedBy" TEXT NOT NULL,
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duty_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duty_assignments_tenantId_dutyKey_effectiveFrom_idx" ON "duty_assignments"("tenantId", "dutyKey", "effectiveFrom");

-- ---------------------------------------------------------------------------
-- Hand-written from here down.
-- ---------------------------------------------------------------------------

-- btree_gist lets a GiST exclusion compare the plain equality columns (as
-- statutory_rules_no_overlap does).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. A dated holder ends after it starts. A NULL end is open-ended.
ALTER TABLE "duty_assignments"
  ADD CONSTRAINT "duty_assignments_dates_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- 2. One holder per (tenant, duty) at any instant. Half-open ranges, so handing
--    the duty over on day D is an end at D and a start at D, not an overlap. The
--    database refuses an overlap for every writer, not only assignDuty.
ALTER TABLE "duty_assignments"
  ADD CONSTRAINT "duty_assignments_one_holder"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "dutyKey" WITH =,
    tsrange("effectiveFrom", "effectiveTo", '[)') WITH &&
  );

-- 3. Row-level security, as tenant_rls does for every other table with a tenantId.
--    The table is created after that migration ran, so it is enabled here.
ALTER TABLE "duty_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duty_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "duty_assignments";
CREATE POLICY "tenant_isolation" ON "duty_assignments"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- 4. Grants. History is kept: the application role may end a holder (UPDATE)
--    but may not remove a row.
GRANT SELECT, INSERT, UPDATE ON "duty_assignments" TO "kaizen_app";
REVOKE DELETE ON "duty_assignments" FROM "kaizen_app";
