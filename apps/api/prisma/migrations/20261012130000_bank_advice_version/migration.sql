-- One bank advice per payroll run (FIXES.md FX-35; hcm/payrollops.ts
-- generateBankAdvice). generateBankAdvice created a row on every call, so a
-- second generate sent a second NEFT file for the same pay.
--
-- The column and index are Prisma's DDL, below a guard: if any run already
-- has two advices, this migration refuses to finish and names the count. Which
-- one a bank acted on is a finding for a person, not a row this migration may
-- delete or renumber (the migrations contract: schema, never rows).

-- Guard: refuse if a run already has more than one advice ----------------------
-- Runs before the index is built, so the failure names the problem instead of
-- a generic unique-violation.
DO $$
DECLARE
  duplicated BIGINT;
BEGIN
  SELECT COUNT(*) INTO duplicated FROM (
    SELECT "tenantId", "payrollRunId" FROM "hcm_bank_advices"
    GROUP BY "tenantId", "payrollRunId" HAVING COUNT(*) > 1
  ) d;
  IF duplicated > 0 THEN
    RAISE EXCEPTION 'hcm_bank_advices has % run(s) with more than one advice; resolve them before this migration', duplicated;
  END IF;
END
$$;

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "hcm_bank_advices" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "hcm_bank_advices_tenantId_payrollRunId_version_key" ON "hcm_bank_advices"("tenantId", "payrollRunId", "version");
