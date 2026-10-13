-- FX-73: payroll accrual. A run's liabilities reach the ledger, one balanced
-- entry per ledger entity, which needs two mappings the payroll data did not hold:
--
--   1. hcm_payroll_division_lines: finance's map from a payroll division (or
--      'shared' for an instruction with none) to the business line its pay cost is
--      booked under. An expense line without a business line is refused by the
--      ledger (ledger.ts writeEntry), and nothing on the instruction names one.
--   2. employment_relationships.ledgerEntityId: the ledger entity an employee's pay
--      is booked to. EmploymentRelationship.legalEntity is free text, and nothing
--      joined it to a LedgerEntity.
--
-- The Prisma DDL is what `prisma migrate diff` produced for the schema. Everything
-- below it is hand-written: the backfill, row-level security, grants and the guard.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "employment_relationships" ADD COLUMN     "ledgerEntityId" TEXT;

-- CreateTable
CREATE TABLE "hcm_payroll_division_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hcm_payroll_division_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hcm_payroll_division_lines_tenantId_division_idx" ON "hcm_payroll_division_lines"("tenantId", "division");

-- CreateIndex
CREATE UNIQUE INDEX "hcm_payroll_division_lines_tenantId_division_effectiveFrom_key" ON "hcm_payroll_division_lines"("tenantId", "division", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entities_tenantId_id_key" ON "ledger_entities"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "hcm_payroll_division_lines" ADD CONSTRAINT "hcm_payroll_division_lines_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "business_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_relationships" ADD CONSTRAINT "employment_relationships_tenantId_ledgerEntityId_fkey" FOREIGN KEY ("tenantId", "ledgerEntityId") REFERENCES "ledger_entities"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ----------------------------------------------------------------

-- Backfill: an employee takes the ledger entity whose legal name matches their
-- legalEntity text exactly, and only when exactly one entity in the tenant has
-- that name. An ambiguous name stays unmapped, so the run refuses rather than
-- picking one. This runs as the table owner under FORCE RLS, so each tenant is
-- read with its own id set, as the journal_lines migration does.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    UPDATE "employment_relationships" er
    SET "ledgerEntityId" = (
      SELECT le."id" FROM "ledger_entities" le
      WHERE le."tenantId" = er."tenantId" AND le."legalName" = er."legalEntity"
    )
    WHERE er."tenantId" = tenant."id"
      AND er."ledgerEntityId" IS NULL
      AND (
        SELECT count(*) FROM "ledger_entities" le
        WHERE le."tenantId" = er."tenantId" AND le."legalName" = er."legalEntity"
      ) = 1;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;

-- A mapping window must end after it starts.
ALTER TABLE "hcm_payroll_division_lines" ADD CONSTRAINT "hcm_payroll_division_lines_effective_window"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- Row-level security (same policy as 20261010235900_tenant_rls; FORCE binds the owner too).
ALTER TABLE "hcm_payroll_division_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hcm_payroll_division_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "hcm_payroll_division_lines";
CREATE POLICY "tenant_isolation" ON "hcm_payroll_division_lines"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The application may read a mapping, add one, and end one. Nothing else: the
-- guard below refuses any other change for every role.
REVOKE ALL ON "hcm_payroll_division_lines" FROM PUBLIC;
REVOKE ALL ON "hcm_payroll_division_lines" FROM "kaizen_app";
GRANT SELECT, INSERT ON "hcm_payroll_division_lines" TO "kaizen_app";
GRANT UPDATE ("effectiveTo") ON "hcm_payroll_division_lines" TO "kaizen_app";

-- A mapping is kept. It is ended once, by setting effectiveTo on an open row; a
-- change of division, line or start date is a new row with its own effectiveFrom.
-- DELETE is refused for every role, the owner included.
CREATE OR REPLACE FUNCTION "hcm_payroll_division_line_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll division lines are kept: DELETE refused; end the mapping by setting effectiveTo';
  END IF;
  IF OLD."effectiveTo" IS NOT NULL OR NEW."effectiveTo" IS NULL
     OR NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."division" <> OLD."division" OR NEW."lineId" <> OLD."lineId"
     OR NEW."effectiveFrom" <> OLD."effectiveFrom"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'a payroll division line may only be ended once, by setting effectiveTo on an open row';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "hcm_payroll_division_lines_guard"
BEFORE UPDATE OR DELETE ON "hcm_payroll_division_lines"
FOR EACH ROW EXECUTE FUNCTION "hcm_payroll_division_line_guard"();
