-- Tenant-composite references from the journal (rule 6: tenant scope is never
-- optional). journal_lines and journal_reversals referred to journal_entries
-- by id alone, so a row of one tenant could name an entry of another: RLS
-- checks only each row's own tenantId. The composite (tenantId, id) makes the
-- reference itself tenant-bound.
--
-- A cross-tenant reference that already exists is a finding, not something to
-- repair silently: the migration refuses to run and names the rows.
--
-- Row security is switched off for the check, so it sees every row. A role
-- that cannot bypass RLS gets an error here, not a clean-looking zero.

SET LOCAL row_security = off;

DO $$
DECLARE
  bad_lines BIGINT;
  bad_reversals BIGINT;
BEGIN
  SELECT COUNT(*) INTO bad_lines
  FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."entryId"
  WHERE l."tenantId" <> e."tenantId";
  SELECT COUNT(*) INTO bad_reversals
  FROM "journal_reversals" r
  LEFT JOIN "journal_entries" a ON a."id" = r."reversedEntryId"
  LEFT JOIN "journal_entries" b ON b."id" = r."reversalEntryId"
  WHERE a."tenantId" IS DISTINCT FROM r."tenantId" OR b."tenantId" IS DISTINCT FROM r."tenantId";
  IF bad_lines > 0 OR bad_reversals > 0 THEN
    RAISE EXCEPTION 'cross-tenant journal references exist (lines: %, reversal links: %); find and resolve them before this migration', bad_lines, bad_reversals;
  END IF;
END
$$;

-- Prisma DDL -----------------------------------------------------------------
-- DropForeignKey
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_entryId_fkey";

-- DropForeignKey
ALTER TABLE "journal_reversals" DROP CONSTRAINT "journal_reversals_reversalEntryId_fkey";

-- DropForeignKey
ALTER TABLE "journal_reversals" DROP CONSTRAINT "journal_reversals_reversedEntryId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_id_key" ON "journal_entries"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenantId_entryId_fkey" FOREIGN KEY ("tenantId", "entryId") REFERENCES "journal_entries"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_reversals" ADD CONSTRAINT "journal_reversals_tenantId_reversedEntryId_fkey" FOREIGN KEY ("tenantId", "reversedEntryId") REFERENCES "journal_entries"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_reversals" ADD CONSTRAINT "journal_reversals_tenantId_reversalEntryId_fkey" FOREIGN KEY ("tenantId", "reversalEntryId") REFERENCES "journal_entries"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

