-- Books money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S5), first subset:
-- the whole of BudgetLine, FixedAsset, Loan and RecurringRule. Each Decimal(18,2)
-- column becomes paise in place and is renamed to the `<name>Minor` convention:
--
--   budget_lines.amount                -> amountMinor
--   fixed_assets.cost                  -> costMinor
--   fixed_assets.salvageValue          -> salvageValueMinor (default 0)
--   fixed_assets.disposalValue         -> disposalValueMinor (nullable)
--   loans.principal                    -> principalMinor
--   recurring_rules.amount             -> amountMinor
--
-- Nothing in the migration history (views, triggers, functions, CHECK
-- constraints, indexes) names these columns, so no dependent object blocks the
-- type change.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only
-- be there if the column drifted to an unconstrained type or a restore brought one
-- in. Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, these tables show no
-- rows, so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "budget_lines" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "fixed_assets" WHERE "cost" <> round("cost", 2))
       OR EXISTS (SELECT 1 FROM "fixed_assets" WHERE "salvageValue" <> round("salvageValue", 2))
       OR EXISTS (SELECT 1 FROM "fixed_assets" WHERE "disposalValue" <> round("disposalValue", 2))
       OR EXISTS (SELECT 1 FROM "loans" WHERE "principal" <> round("principal", 2))
       OR EXISTS (SELECT 1 FROM "recurring_rules" WHERE "amount" <> round("amount", 2))
    THEN
      RAISE EXCEPTION 'A books money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

ALTER TABLE "budget_lines"
  ALTER COLUMN "amount" TYPE BIGINT
  USING (round("amount" * 100))::BIGINT;
ALTER TABLE "budget_lines"
  RENAME COLUMN "amount" TO "amountMinor";

ALTER TABLE "fixed_assets"
  ALTER COLUMN "cost" TYPE BIGINT
  USING (round("cost" * 100))::BIGINT;
ALTER TABLE "fixed_assets"
  RENAME COLUMN "cost" TO "costMinor";

ALTER TABLE "fixed_assets" ALTER COLUMN "salvageValue" DROP DEFAULT;
ALTER TABLE "fixed_assets"
  ALTER COLUMN "salvageValue" TYPE BIGINT
  USING (round("salvageValue" * 100))::BIGINT;
ALTER TABLE "fixed_assets" ALTER COLUMN "salvageValue" SET DEFAULT 0;
ALTER TABLE "fixed_assets"
  RENAME COLUMN "salvageValue" TO "salvageValueMinor";

ALTER TABLE "fixed_assets"
  ALTER COLUMN "disposalValue" TYPE BIGINT
  USING (round("disposalValue" * 100))::BIGINT;
ALTER TABLE "fixed_assets"
  RENAME COLUMN "disposalValue" TO "disposalValueMinor";

ALTER TABLE "loans"
  ALTER COLUMN "principal" TYPE BIGINT
  USING (round("principal" * 100))::BIGINT;
ALTER TABLE "loans"
  RENAME COLUMN "principal" TO "principalMinor";

ALTER TABLE "recurring_rules"
  ALTER COLUMN "amount" TYPE BIGINT
  USING (round("amount" * 100))::BIGINT;
ALTER TABLE "recurring_rules"
  RENAME COLUMN "amount" TO "amountMinor";
