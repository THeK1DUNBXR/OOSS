-- Compliance and books money columns to bigint paise (ORDERED-PLAN 1.6, slice S5
-- compliance; the same pattern as 20261013244000_quote_money_minor).
--
-- Four Decimal(·,2) money columns become paise in place, each renamed to the
-- `<name>Minor` convention the other paise columns follow:
--
--   cmp_bank_statement_lines.amount      -> amountMinor (NOT NULL, signed)
--   tds_challans.amount                  -> amountMinor (NOT NULL, default 0)
--   advance_tax_payments.amount          -> amountMinor (NOT NULL, default 0)
--   ledger_accounts.openingBalance       -> openingBalanceMinor (NOT NULL, default 0)
--
-- Rates and statutory parameters in the same schema are not touched.
--
-- Checked, not assumed: no CHECK constraint, index, view, trigger or function names
-- these columns (the baseline indexes on cmp_bank_statement_lines cover tenantId,
-- accountId, date, matchedAt and, from 20261012140000, fingerprint; no index names
-- amount), so the type change is not blocked by a dependent object.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only be
-- there if the column drifted to an unconstrained type or a restore brought one in.
-- Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, these tables show no rows,
-- so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "cmp_bank_statement_lines" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "tds_challans" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "advance_tax_payments" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "ledger_accounts" WHERE "openingBalance" <> round("openingBalance", 2))
    THEN
      RAISE EXCEPTION 'A compliance or books money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- cmp_bank_statement_lines
ALTER TABLE "cmp_bank_statement_lines" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "cmp_bank_statement_lines" RENAME COLUMN "amount" TO "amountMinor";

-- tds_challans
ALTER TABLE "tds_challans" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "tds_challans" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "tds_challans" ALTER COLUMN "amount" SET DEFAULT 0;
ALTER TABLE "tds_challans" RENAME COLUMN "amount" TO "amountMinor";

-- advance_tax_payments
ALTER TABLE "advance_tax_payments" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "advance_tax_payments" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "advance_tax_payments" ALTER COLUMN "amount" SET DEFAULT 0;
ALTER TABLE "advance_tax_payments" RENAME COLUMN "amount" TO "amountMinor";

-- ledger_accounts
ALTER TABLE "ledger_accounts" ALTER COLUMN "openingBalance" DROP DEFAULT;
ALTER TABLE "ledger_accounts" ALTER COLUMN "openingBalance" TYPE BIGINT USING (round("openingBalance" * 100))::BIGINT;
ALTER TABLE "ledger_accounts" ALTER COLUMN "openingBalance" SET DEFAULT 0;
ALTER TABLE "ledger_accounts" RENAME COLUMN "openingBalance" TO "openingBalanceMinor";
