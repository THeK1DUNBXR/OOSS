-- Phase 0, invoice posting: an invoice's issue and each receipt post to the journal
-- (ORDERED-PLAN, owner decision 2026-10-13). Two things the invoice data did not hold:
--
--   1. invoice_division_lines: finance's map from an invoice's division to the business
--      line its revenue is booked under. Nothing on an invoice line names a line, and
--      the payroll map is payroll's vocabulary, so this is a table of its own. An issue
--      in a division with no line on the issue day refuses, and names the division.
--   2. invoices.ledgerEntityId: the ledger entity the invoice is booked to. The ledger
--      needs an entity on every entry, and an invoice did not name one.
--
-- The Prisma DDL is shaped as the 20261013214000 migration's, which passed the drift
-- check. Everything below it is hand-written: the backfill, row-level security, grants
-- and the guard.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "ledgerEntityId" TEXT;

-- CreateTable
CREATE TABLE "invoice_division_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_division_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_division_lines_tenantId_division_idx" ON "invoice_division_lines"("tenantId", "division");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_division_lines_tenantId_division_effectiveFrom_key" ON "invoice_division_lines"("tenantId", "division", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "invoice_division_lines" ADD CONSTRAINT "invoice_division_lines_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "business_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_ledgerEntityId_fkey" FOREIGN KEY ("tenantId", "ledgerEntityId") REFERENCES "ledger_entities"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ----------------------------------------------------------------

-- Backfill: an invoice takes the tenant's ledger entity when the tenant has exactly one.
-- A tenant with none or several keeps the invoice unmapped, and posting refuses it
-- rather than picking one. This runs as the table owner under FORCE RLS, so each tenant
-- is read with its own id set, as the employment backfill in 20261013214000 does.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    UPDATE "invoices" i
    SET "ledgerEntityId" = (
      SELECT le."id" FROM "ledger_entities" le WHERE le."tenantId" = i."tenantId"
    )
    WHERE i."tenantId" = tenant."id"
      AND i."ledgerEntityId" IS NULL
      AND (
        SELECT count(*) FROM "ledger_entities" le WHERE le."tenantId" = i."tenantId"
      ) = 1;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;

-- A mapping window must end after it starts.
ALTER TABLE "invoice_division_lines" ADD CONSTRAINT "invoice_division_lines_effective_window"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- Row-level security (same policy as 20261010235900_tenant_rls; FORCE binds the owner too).
ALTER TABLE "invoice_division_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_division_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "invoice_division_lines";
CREATE POLICY "tenant_isolation" ON "invoice_division_lines"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The application may read a mapping, add one, and end one. Nothing else: the guard
-- below refuses any other change for every role.
REVOKE ALL ON "invoice_division_lines" FROM PUBLIC;
REVOKE ALL ON "invoice_division_lines" FROM "kaizen_app";
GRANT SELECT, INSERT ON "invoice_division_lines" TO "kaizen_app";
GRANT UPDATE ("effectiveTo") ON "invoice_division_lines" TO "kaizen_app";

-- A mapping is kept. It is ended once, by setting effectiveTo on an open row; a change
-- of division, line or start date is a new row with its own effectiveFrom. DELETE is
-- refused for every role, the owner included.
CREATE OR REPLACE FUNCTION "invoice_division_line_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice division lines are kept: DELETE refused; end the mapping by setting effectiveTo';
  END IF;
  IF OLD."effectiveTo" IS NOT NULL OR NEW."effectiveTo" IS NULL
     OR NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."division" <> OLD."division" OR NEW."lineId" <> OLD."lineId"
     OR NEW."effectiveFrom" <> OLD."effectiveFrom"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'an invoice division line may only be ended once, by setting effectiveTo on an open row';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "invoice_division_lines_guard"
BEFORE UPDATE OR DELETE ON "invoice_division_lines"
FOR EACH ROW EXECUTE FUNCTION "invoice_division_line_guard"();
