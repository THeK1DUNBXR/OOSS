-- ORDERED-PLAN Wave 6, item 1.0 (ledger half): journal_lines.costCentreId
-- becomes a foreign key to hcm_workforce_cost_centres(tenantId, id).
--
-- Before this the column was a plain string (compliance-books.prisma, JournalLine),
-- so a line could name a cost centre that did not exist, or one that belonged to
-- another tenant, and nothing refused it. The key is composite with tenantId, as
-- lineId already is (journal_lines_tenantId_lineId_fkey): a single-column key
-- would accept another tenant's id, and "belongs to the same tenant" is the fact
-- this column has to carry. A NULL costCentreId is not checked (MATCH SIMPLE),
-- which is the intent: most lines carry no cost-centre dimension.
--
-- Posted lines are immutable. The app role has no UPDATE, and a trigger refuses
-- UPDATE and DELETE for every role, so an orphan that is already posted cannot be
-- repaired here, and nulling it would move a posted amount onto no dimension at
-- all. The guard below refuses the migration instead. Each orphan is a human
-- decision, made by reversal, and the migration is re-run once none remain.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, journal_lines shows no
-- rows at all, so a guard that read once would pass over every orphan the owner
-- cannot see. The guard walks the tenants and sets the tenant on each pass. The
-- foreign key below is the backstop: its check is not filtered by RLS, so an
-- orphan in a tenant this loop did not reach still stops the ALTER.
DO $$
DECLARE
  tenant RECORD;
  orphans BIGINT;
  total BIGINT := 0;
  tenants_affected INTEGER := 0;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    SELECT count(*) INTO orphans
    FROM "journal_lines" jl
    WHERE jl."costCentreId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "hcm_workforce_cost_centres" cc
        WHERE cc."tenantId" = jl."tenantId" AND cc."id" = jl."costCentreId"
      );
    IF orphans > 0 THEN
      total := total + orphans;
      tenants_affected := tenants_affected + 1;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  IF total > 0 THEN
    RAISE EXCEPTION 'journal_lines.costCentreId names % journal line(s) with no cost centre of their own tenant (across % tenant(s)). Posted lines are immutable, so this migration will not null them: decide each by reversal, then re-run.', total, tenants_affected
      USING ERRCODE = 'data_exception';
  END IF;
END
$$;
-- GUARD END

-- The index serves the RESTRICT check on a cost-centre delete, which looks up
-- the lines that name the centre; without it that check scans the journal.
CREATE INDEX "journal_lines_tenantId_costCentreId_idx" ON "journal_lines"("tenantId", "costCentreId");

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenantId_costCentreId_fkey" FOREIGN KEY ("tenantId", "costCentreId") REFERENCES "hcm_workforce_cost_centres"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
