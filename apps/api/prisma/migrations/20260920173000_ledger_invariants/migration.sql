-- Phase 1 ledger foundations. This migration is intentionally hand-written:
-- Prisma cannot express deferred balance/minimum-line checks or the journal
-- immutability boundary.

CREATE TYPE "LedgerAccountType" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

ALTER TABLE "ledger_accounts"
  ADD COLUMN "accountClass" "LedgerAccountType" NOT NULL DEFAULT 'asset',
  ADD COLUMN "normalBalance" TEXT NOT NULL DEFAULT 'debit',
  ADD COLUMN "isPostable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "requiresParty" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requiresCostCentre" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ledger_accounts"
SET "accountClass" = CASE "ledgerGroup"
  WHEN 'liability' THEN 'liability'::"LedgerAccountType"
  WHEN 'equity' THEN 'equity'::"LedgerAccountType"
  ELSE 'asset'::"LedgerAccountType"
END,
"normalBalance" = CASE WHEN "ledgerGroup" IN ('liability', 'equity') THEN 'credit' ELSE 'debit' END;

ALTER TABLE "cmp_accounting_periods"
  ADD COLUMN "entityId" TEXT,
  ADD COLUMN "startsOn" DATE,
  ADD COLUMN "endsOn" DATE;
CREATE UNIQUE INDEX "cmp_accounting_periods_tenantId_entityId_startsOn_key"
  ON "cmp_accounting_periods" ("tenantId", "entityId", "startsOn");

CREATE TABLE "ledger_entities" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "legalName" TEXT NOT NULL,
  "gstin" TEXT,
  "pan" TEXT,
  "tan" TEXT,
  "stateCode" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL DEFAULT 'INR',
  CONSTRAINT "ledger_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_entities_tenantId_code_key" ON "ledger_entities" ("tenantId", "code");

CREATE TABLE "journal_entries" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "entryNumber" TEXT NOT NULL,
  "entryDate" DATE NOT NULL,
  "postedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'posted',
  "narration" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "reversalOfId" TEXT,
  "reversedById" TEXT,
  "idempotencyKey" TEXT,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "journal_entries_tenantId_entityId_entryNumber_key"
  ON "journal_entries" ("tenantId", "entityId", "entryNumber");
CREATE UNIQUE INDEX "journal_entries_tenantId_idempotencyKey_key"
  ON "journal_entries" ("tenantId", "idempotencyKey");
CREATE INDEX "journal_entries_tenantId_entityId_entryDate_idx"
  ON "journal_entries" ("tenantId", "entityId", "entryDate");

CREATE TABLE "journal_lines" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "accountId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "baseAmountMinor" BIGINT NOT NULL,
  "fxRate" DECIMAL(18,8),
  "division" TEXT,
  "costCentreId" TEXT,
  "projectId" TEXT,
  "partyId" TEXT,
  "taxCodeId" TEXT,
  "memo" TEXT,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journal_lines_tenantId_accountId_entryId_idx"
  ON "journal_lines" ("tenantId", "accountId", "entryId");
CREATE INDEX "journal_lines_tenantId_partyId_idx"
  ON "journal_lines" ("tenantId", "partyId");

ALTER TABLE "cmp_accounting_periods"
  ADD CONSTRAINT "cmp_accounting_periods_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "ledger_entities" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "ledger_entities" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_entries_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "cmp_accounting_periods" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_lines_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ledger_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

ALTER TABLE "ledger_entities", "cmp_accounting_periods", "journal_entries", "journal_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entities", "cmp_accounting_periods", "journal_entries", "journal_lines" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ledger_entities', 'cmp_accounting_periods', 'journal_entries', 'journal_lines']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', table_name || '_tenant', table_name);
  END LOOP;
END;
$$;
