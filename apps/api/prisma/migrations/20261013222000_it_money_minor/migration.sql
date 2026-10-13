-- IT money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S8-IT).
--
-- Six Decimal(18,2) columns in the Technology workstream become paise in place,
-- and each is renamed to the `<name>Minor` convention the other paise columns
-- follow (balanceMinor, amountMinor, remedyAmountMinor, requiredAuthorityMinor):
--
--   it_assets.purchaseCost                       -> purchaseCostMinor (nullable)
--   it_initiatives.budget                        -> budgetMinor
--   it_budget_lines.planned                      -> plannedMinor
--   it_licences.costPerPeriod                    -> costPerPeriodMinor
--   it_licences.pendingRenewalCostPerPeriod      -> pendingRenewalCostPerPeriodMinor (nullable)
--   it_vendor_contracts.value                    -> valueMinor
--
-- Nothing in the migration history (views, triggers, functions, CHECK
-- constraints) names these columns, so no dependent object blocks the type change.
--
-- Everything below is an invariant Prisma cannot express, and the GUARD is the
-- part that matters: a stored value with a third decimal can only be there if
-- the column drifted to an unconstrained type or a restore brought one in.
-- Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, the IT tables show no
-- rows, so the guard walks the tenants and sets the tenant on each pass. CI's
-- owner is a superuser that bypasses RLS, which is why only a run as the
-- application role shows the difference.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "it_assets" WHERE "purchaseCost" <> round("purchaseCost", 2))
       OR EXISTS (SELECT 1 FROM "it_initiatives" WHERE "budget" <> round("budget", 2))
       OR EXISTS (SELECT 1 FROM "it_budget_lines" WHERE "planned" <> round("planned", 2))
       OR EXISTS (SELECT 1 FROM "it_licences" WHERE "costPerPeriod" <> round("costPerPeriod", 2))
       OR EXISTS (SELECT 1 FROM "it_licences" WHERE "pendingRenewalCostPerPeriod" <> round("pendingRenewalCostPerPeriod", 2))
       OR EXISTS (SELECT 1 FROM "it_vendor_contracts" WHERE "value" <> round("value", 2))
    THEN
      RAISE EXCEPTION 'An IT money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

ALTER TABLE "it_assets"
  ALTER COLUMN "purchaseCost" TYPE BIGINT
  USING (round("purchaseCost" * 100))::BIGINT;
ALTER TABLE "it_assets"
  RENAME COLUMN "purchaseCost" TO "purchaseCostMinor";

ALTER TABLE "it_initiatives"
  ALTER COLUMN "budget" TYPE BIGINT
  USING (round("budget" * 100))::BIGINT;
ALTER TABLE "it_initiatives"
  RENAME COLUMN "budget" TO "budgetMinor";

ALTER TABLE "it_budget_lines"
  ALTER COLUMN "planned" TYPE BIGINT
  USING (round("planned" * 100))::BIGINT;
ALTER TABLE "it_budget_lines"
  RENAME COLUMN "planned" TO "plannedMinor";

ALTER TABLE "it_licences"
  ALTER COLUMN "costPerPeriod" TYPE BIGINT
  USING (round("costPerPeriod" * 100))::BIGINT;
ALTER TABLE "it_licences"
  RENAME COLUMN "costPerPeriod" TO "costPerPeriodMinor";

ALTER TABLE "it_licences"
  ALTER COLUMN "pendingRenewalCostPerPeriod" TYPE BIGINT
  USING (round("pendingRenewalCostPerPeriod" * 100))::BIGINT;
ALTER TABLE "it_licences"
  RENAME COLUMN "pendingRenewalCostPerPeriod" TO "pendingRenewalCostPerPeriodMinor";

ALTER TABLE "it_vendor_contracts"
  ALTER COLUMN "value" TYPE BIGINT
  USING (round("value" * 100))::BIGINT;
ALTER TABLE "it_vendor_contracts"
  RENAME COLUMN "value" TO "valueMinor";
