-- Ledger gates (ORDERED-PLAN Wave 3, items 1.1 to 1.3; MONEY-LEDGER-CONTRACT
-- decisions 7 to 11).
--
-- Why this migration exists, and not an edit of 20260920173000_ledger_invariants:
-- that migration has been applied, and its posted-to-reversed exception has
-- already been granted. Changing it would rewrite history on any database that
-- ran it. This one takes the exception away and says so.
--
-- The schema lines (lineId, journal_reversals) are Prisma's own DDL. The rest
-- is what Prisma cannot express, and is hand-written below the DDL.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "lineId" TEXT;

-- CreateTable
CREATE TABLE "journal_reversals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reversedEntryId" TEXT NOT NULL,
    "reversalEntryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "journal_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journal_reversals_tenantId_reversedEntryId_key" ON "journal_reversals"("tenantId", "reversedEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_reversals_tenantId_reversalEntryId_key" ON "journal_reversals"("tenantId", "reversalEntryId");

-- CreateIndex
CREATE INDEX "journal_lines_tenantId_lineId_idx" ON "journal_lines"("tenantId", "lineId");

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "business_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "journal_reversals" ADD CONSTRAINT "journal_reversals_reversedEntryId_fkey" FOREIGN KEY ("reversedEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_reversals" ADD CONSTRAINT "journal_reversals_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: reversal state moves from the status UPDATE to a link row ---------
-- Every entry the old code marked reversed gets the row that now says so. The
-- entry itself is not touched: it is immutable from this point, so `status`
-- keeps what it said when it was posted-and-reversed, and reads derive the
-- reversal from journal_reversals. A reversed entry without its reversal link
-- would read as unreversed, so the migration refuses to finish if one exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "journal_entries" WHERE "status" = 'reversed' AND "reversedById" IS NULL) THEN
    RAISE EXCEPTION 'journal entries marked reversed have no reversedById; repair them before this migration';
  END IF;
END
$$;

INSERT INTO "journal_reversals" ("id", "tenantId", "reversedEntryId", "reversalEntryId", "reason", "createdAt", "createdById")
SELECT 'jrv_' || o."id", o."tenantId", o."id", o."reversedById", r."narration", COALESCE(r."postedAt", CURRENT_TIMESTAMP), NULL
FROM "journal_entries" o
JOIN "journal_entries" r ON r."id" = o."reversedById" AND r."tenantId" = o."tenantId"
WHERE o."reversedById" IS NOT NULL
ON CONFLICT DO NOTHING;

-- A reversal cannot be reversed (decision 7, L2) -------------------------------
-- post() refuses this with a 409 first. The trigger is the backstop for any
-- writer that skips post(). The check is on the reversed entry's source type
-- and on whether it is already a reversal link's reversal, so both the
-- reversal-of-reversal and the reversed-twice paths are covered.
CREATE OR REPLACE FUNCTION "journal_reversal_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "journal_entries"
    WHERE "id" = NEW."reversedEntryId" AND "sourceType" = 'reversal'
  ) OR EXISTS (
    SELECT 1 FROM "journal_reversals"
    WHERE "reversalEntryId" = NEW."reversedEntryId"
  ) THEN
    RAISE EXCEPTION 'a reversal entry cannot be reversed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_reversal_guard"
BEFORE INSERT ON "journal_reversals"
FOR EACH ROW EXECUTE FUNCTION "journal_reversal_guard"();

-- Immutability: no UPDATE or DELETE on posted rows, for any role (decision 7) --
-- The old journal_entry_immutable allowed posted-to-reversed. Nothing is
-- allowed now, including the table owner: a correction is a reversal entry.
-- The privilege revokes are the app role's refusal; the triggers also bind the
-- owner, which the privileges do not.
REVOKE UPDATE ON "journal_entries" FROM PUBLIC;
REVOKE UPDATE ("status", "reversedById") ON "journal_entries" FROM PUBLIC;
REVOKE UPDATE, DELETE ON "journal_entries", "journal_lines" FROM "kaizen_app";
REVOKE UPDATE, DELETE ON "journal_reversals" FROM "kaizen_app";

CREATE OR REPLACE FUNCTION "journal_row_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal rows are immutable: % on % refused; post a reversal instead', TG_OP, TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS "journal_entry_immutable" ON "journal_entries";
DROP FUNCTION IF EXISTS "journal_entry_immutable"();
CREATE TRIGGER "journal_entry_immutable"
BEFORE UPDATE OR DELETE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION "journal_row_immutable"();
CREATE TRIGGER "journal_line_immutable"
BEFORE UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW EXECUTE FUNCTION "journal_row_immutable"();
CREATE TRIGGER "journal_reversal_immutable"
BEFORE UPDATE OR DELETE ON "journal_reversals"
FOR EACH ROW EXECUTE FUNCTION "journal_row_immutable"();

-- Period: postings only into open or reopened (decision 9) -----------------------
-- Replaces the 'closed'-only refusal. closing is refused too: a close in progress
-- has taken its snapshot position and must not move under it.
CREATE OR REPLACE FUNCTION "journal_entry_period_open"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "cmp_accounting_periods"
    WHERE "id" = NEW."periodId" AND "status" IN ('open', 'reopened')
  ) THEN
    RAISE EXCEPTION 'cannot post into an accounting period that is not open (open or reopened)';
  END IF;
  RETURN NEW;
END;
$$;

-- An entry must have two lines and balance, checked for the entry itself -------
-- journal_entry_balanced fires only for entries that have lines, so an entry
-- inserted with no lines committed without any check. This closes that case.
CREATE OR REPLACE FUNCTION "journal_entry_lines_check"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_count INTEGER;
  total BIGINT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM("amountMinor"), 0) INTO line_count, total
  FROM "journal_lines" WHERE "entryId" = NEW."id";
  IF line_count < 2 THEN RAISE EXCEPTION 'journal entry must have at least two lines'; END IF;
  IF total <> 0 THEN RAISE EXCEPTION 'journal entry is not balanced'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "journal_entry_lines_check"
AFTER INSERT ON "journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "journal_entry_lines_check"();

-- Row-level security for the new tenant table (same policy as 20261010235900) ---
ALTER TABLE "journal_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_reversals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_reversals";
CREATE POLICY "tenant_isolation" ON "journal_reversals"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
