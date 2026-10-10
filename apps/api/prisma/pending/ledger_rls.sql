-- Tenant row-level security for the ledger tables. NOT APPLIED. Owned by FX-51
-- (Wave 1) and item 1.2 (Wave 3); do not add this to a migration until then.
--
-- Why it is held back:
--   The policies read current_setting('app.tenant_id'). Only platform/ledger.ts
--   sets that setting (inside post()). The Prisma tenant path does not set it, so
--   with FORCE enabled, domains/compliance/books.ts:84 (accountingPeriod.create,
--   reached from requestClosePeriod) is refused with 42501. That breaks
--   CMP-AUD-003 in compliance/books.test.ts. Enabling this file is safe only once
--   the tenant extension sets app.tenant_id on every ledger-touching transaction.
--
-- History: the original migration applied all four tables in one ALTER TABLE
-- statement. Postgres rejects that syntax, so the migration never ran and RLS
-- was never live. The per-table form below is the corrected statement.

ALTER TABLE "ledger_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cmp_accounting_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
-- FORCE matters: without it the table owner (the app role) bypasses the policy.
ALTER TABLE "ledger_entities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cmp_accounting_periods" FORCE ROW LEVEL SECURITY;
ALTER TABLE "journal_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines" FORCE ROW LEVEL SECURITY;

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
