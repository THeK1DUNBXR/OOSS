-- Phase 1 ledger invariants. Applied after 20260901000000_baseline, which
-- carries every table, column, index and foreign key this file used to create.
-- What remains here is only what Prisma cannot express: deferred balance and
-- minimum-line checks, the closed-period guard, the immutability boundary, and
-- tenant row-level security.

-- Backfill for rows that predate the accountClass/normalBalance columns. On a
-- fresh database the table is empty and this is a no-op.
UPDATE "ledger_accounts"
SET "accountClass" = CASE "ledgerGroup"
  WHEN 'liability' THEN 'liability'::"LedgerAccountType"
  WHEN 'equity' THEN 'equity'::"LedgerAccountType"
  ELSE 'asset'::"LedgerAccountType"
END,
"normalBalance" = CASE WHEN "ledgerGroup" IN ('liability', 'equity') THEN 'credit' ELSE 'debit' END;

CREATE OR REPLACE FUNCTION "journal_entry_period_open"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "cmp_accounting_periods"
    WHERE "id" = NEW."periodId" AND "status" = 'closed'
  ) THEN
    RAISE EXCEPTION 'cannot post into a closed accounting period';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_entry_period_open"
BEFORE INSERT ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION "journal_entry_period_open"();

CREATE OR REPLACE FUNCTION "journal_entry_balanced"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_id TEXT := COALESCE(NEW."entryId", OLD."entryId");
  line_count INTEGER;
  total BIGINT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM("amountMinor"), 0) INTO line_count, total
  FROM "journal_lines" WHERE "entryId" = entry_id;
  IF line_count < 2 THEN RAISE EXCEPTION 'journal entry must have at least two lines'; END IF;
  IF total <> 0 THEN RAISE EXCEPTION 'journal entry is not balanced'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "journal_entry_balanced"
AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "journal_entry_balanced"();

REVOKE UPDATE, DELETE ON "journal_entries", "journal_lines" FROM PUBLIC;
CREATE OR REPLACE FUNCTION "journal_entry_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'posted'
     OR NEW."status" <> 'reversed'
     OR NEW."reversedById" IS NULL
     OR NEW."id" <> OLD."id"
     OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."entityId" <> OLD."entityId"
     OR NEW."periodId" <> OLD."periodId"
     OR NEW."entryNumber" <> OLD."entryNumber"
     OR NEW."entryDate" <> OLD."entryDate"
     OR NEW."narration" <> OLD."narration"
     OR NEW."sourceType" <> OLD."sourceType"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
  THEN RAISE EXCEPTION 'posted journal entries are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_entry_immutable"
BEFORE UPDATE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION "journal_entry_immutable"();
GRANT UPDATE ("status", "reversedById") ON "journal_entries" TO PUBLIC;

-- Tenant row-level security for these tables is held in prisma/pending/ledger_rls.sql
-- and is not applied here. See that file for why.
