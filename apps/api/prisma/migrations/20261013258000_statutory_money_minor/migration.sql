-- Statutory rate and slab money columns to bigint paise (ORDERED-PLAN 1.6; the last
-- money columns in the platform, after 20261013256000_final_invoice_fee_money_minor).
--
-- Rupee amounts in the statutory parameter tables move to paise. The VALUES do not
-- change: each stored rupee figure is multiplied by 100 once, and the Decimal scale
-- of each column already guarantees two places, so the USING clause is exact.
--
--   cmp_pay_pf_rate_tables.wageCeiling            -> wageCeilingMinor (NOT NULL)
--   cmp_pay_esi_rate_tables.wageCeiling           -> wageCeilingMinor (NOT NULL)
--   cmp_pay_lwf_rate_tables.employeeAmount        -> employeeAmountMinor (NOT NULL)
--   cmp_pay_lwf_rate_tables.employerAmount        -> employerAmountMinor (NOT NULL)
--   cmp_pay_minimum_wage_tables.monthlyAmount     -> monthlyAmountMinor (NOT NULL)
--   tds_section_rates.thresholdPerTransaction     -> thresholdPerTransactionMinor (NOT NULL, default 0)
--   tds_section_rates.thresholdPerFy              -> thresholdPerFyMinor (NOT NULL, default 0)
--   income_tax_slab_tables.standardDeduction      -> standardDeductionMinor (NOT NULL, default 0)
--   income_tax_slab_tables.rebate87ALimit         -> rebate87ALimitMinor (NOT NULL, default 0)
--   income_tax_slab_tables.rebate87AMaxAmount     -> rebate87AMaxAmountMinor (NOT NULL, default 0)
--   compliance_stamp_duty_rules.flatAmount        -> flatAmountMinor (nullable)
--   gst_rate_tables.lateFeePerDayCgst             -> lateFeePerDayCgstMinor (NOT NULL)
--   gst_rate_tables.lateFeePerDaySgst             -> lateFeePerDaySgstMinor (NOT NULL)
--   gst_rate_tables.cap                           -> capMinor (NOT NULL)
--
-- `cap` is the rupee ceiling on a single return's late fee (Sec 47), applied as
-- min(perDay * daysLate, cap) in packages/shared/src/compliance/gst.ts:175, so it is
-- money, not a percentage. Rates, percentages, hours and days stay Decimal or Int.
--
-- Every table here carries "tenantId", so 20261010235900_tenant_rls forces row-level
-- security on each of them, the table owner included. The guard below therefore walks
-- the tenants and sets the tenant on each pass, as the earlier money migrations do.
--
-- Checked, not assumed: no CHECK constraint, view, trigger or function names these
-- columns, and no index does either. The indexes on these tables cover tenantId,
-- effectiveFrom, state, category and agreementKind only, so the type change is not
-- blocked by a dependent object.
--
-- The GUARD is the part that matters: a stored rupee value with a third decimal can
-- only be there if a column drifted to an unconstrained type or a restore brought one
-- in. Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "cmp_pay_pf_rate_tables" WHERE "wageCeiling" <> round("wageCeiling", 2))
       OR EXISTS (SELECT 1 FROM "cmp_pay_esi_rate_tables" WHERE "wageCeiling" <> round("wageCeiling", 2))
       OR EXISTS (SELECT 1 FROM "cmp_pay_lwf_rate_tables" WHERE "employeeAmount" <> round("employeeAmount", 2) OR "employerAmount" <> round("employerAmount", 2))
       OR EXISTS (SELECT 1 FROM "cmp_pay_minimum_wage_tables" WHERE "monthlyAmount" <> round("monthlyAmount", 2))
       OR EXISTS (SELECT 1 FROM "tds_section_rates" WHERE "thresholdPerTransaction" <> round("thresholdPerTransaction", 2) OR "thresholdPerFy" <> round("thresholdPerFy", 2))
       OR EXISTS (SELECT 1 FROM "income_tax_slab_tables" WHERE "standardDeduction" <> round("standardDeduction", 2) OR "rebate87ALimit" <> round("rebate87ALimit", 2) OR "rebate87AMaxAmount" <> round("rebate87AMaxAmount", 2))
       OR EXISTS (SELECT 1 FROM "compliance_stamp_duty_rules" WHERE "flatAmount" <> round("flatAmount", 2))
       OR EXISTS (SELECT 1 FROM "gst_rate_tables" WHERE "lateFeePerDayCgst" <> round("lateFeePerDayCgst", 2) OR "lateFeePerDaySgst" <> round("lateFeePerDaySgst", 2) OR "cap" <> round("cap", 2))
    THEN
      RAISE EXCEPTION 'A statutory rate or slab money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- cmp_pay_pf_rate_tables
ALTER TABLE "cmp_pay_pf_rate_tables" ALTER COLUMN "wageCeiling" TYPE BIGINT USING (round("wageCeiling" * 100))::BIGINT;
ALTER TABLE "cmp_pay_pf_rate_tables" RENAME COLUMN "wageCeiling" TO "wageCeilingMinor";

-- cmp_pay_esi_rate_tables
ALTER TABLE "cmp_pay_esi_rate_tables" ALTER COLUMN "wageCeiling" TYPE BIGINT USING (round("wageCeiling" * 100))::BIGINT;
ALTER TABLE "cmp_pay_esi_rate_tables" RENAME COLUMN "wageCeiling" TO "wageCeilingMinor";

-- cmp_pay_lwf_rate_tables
ALTER TABLE "cmp_pay_lwf_rate_tables" ALTER COLUMN "employeeAmount" TYPE BIGINT USING (round("employeeAmount" * 100))::BIGINT;
ALTER TABLE "cmp_pay_lwf_rate_tables" RENAME COLUMN "employeeAmount" TO "employeeAmountMinor";
ALTER TABLE "cmp_pay_lwf_rate_tables" ALTER COLUMN "employerAmount" TYPE BIGINT USING (round("employerAmount" * 100))::BIGINT;
ALTER TABLE "cmp_pay_lwf_rate_tables" RENAME COLUMN "employerAmount" TO "employerAmountMinor";

-- cmp_pay_minimum_wage_tables
ALTER TABLE "cmp_pay_minimum_wage_tables" ALTER COLUMN "monthlyAmount" TYPE BIGINT USING (round("monthlyAmount" * 100))::BIGINT;
ALTER TABLE "cmp_pay_minimum_wage_tables" RENAME COLUMN "monthlyAmount" TO "monthlyAmountMinor";

-- tds_section_rates
ALTER TABLE "tds_section_rates"
  ALTER COLUMN "thresholdPerTransaction" TYPE BIGINT USING (round("thresholdPerTransaction" * 100))::BIGINT,
  ALTER COLUMN "thresholdPerFy" TYPE BIGINT USING (round("thresholdPerFy" * 100))::BIGINT;

ALTER TABLE "tds_section_rates"
  ALTER COLUMN "thresholdPerTransaction" SET DEFAULT 0,
  ALTER COLUMN "thresholdPerFy" SET DEFAULT 0;

ALTER TABLE "tds_section_rates" RENAME COLUMN "thresholdPerTransaction" TO "thresholdPerTransactionMinor";
ALTER TABLE "tds_section_rates" RENAME COLUMN "thresholdPerFy" TO "thresholdPerFyMinor";

-- income_tax_slab_tables
ALTER TABLE "income_tax_slab_tables"
  ALTER COLUMN "standardDeduction" TYPE BIGINT USING (round("standardDeduction" * 100))::BIGINT,
  ALTER COLUMN "rebate87ALimit" TYPE BIGINT USING (round("rebate87ALimit" * 100))::BIGINT,
  ALTER COLUMN "rebate87AMaxAmount" TYPE BIGINT USING (round("rebate87AMaxAmount" * 100))::BIGINT;

ALTER TABLE "income_tax_slab_tables"
  ALTER COLUMN "standardDeduction" SET DEFAULT 0,
  ALTER COLUMN "rebate87ALimit" SET DEFAULT 0,
  ALTER COLUMN "rebate87AMaxAmount" SET DEFAULT 0;

ALTER TABLE "income_tax_slab_tables" RENAME COLUMN "standardDeduction" TO "standardDeductionMinor";
ALTER TABLE "income_tax_slab_tables" RENAME COLUMN "rebate87ALimit" TO "rebate87ALimitMinor";
ALTER TABLE "income_tax_slab_tables" RENAME COLUMN "rebate87AMaxAmount" TO "rebate87AMaxAmountMinor";

-- compliance_stamp_duty_rules (flatAmount is nullable; a null stays null)
ALTER TABLE "compliance_stamp_duty_rules" ALTER COLUMN "flatAmount" TYPE BIGINT USING (round("flatAmount" * 100))::BIGINT;
ALTER TABLE "compliance_stamp_duty_rules" RENAME COLUMN "flatAmount" TO "flatAmountMinor";

-- gst_rate_tables
ALTER TABLE "gst_rate_tables"
  ALTER COLUMN "lateFeePerDayCgst" TYPE BIGINT USING (round("lateFeePerDayCgst" * 100))::BIGINT,
  ALTER COLUMN "lateFeePerDaySgst" TYPE BIGINT USING (round("lateFeePerDaySgst" * 100))::BIGINT,
  ALTER COLUMN "cap" TYPE BIGINT USING (round("cap" * 100))::BIGINT;

ALTER TABLE "gst_rate_tables" RENAME COLUMN "lateFeePerDayCgst" TO "lateFeePerDayCgstMinor";
ALTER TABLE "gst_rate_tables" RENAME COLUMN "lateFeePerDaySgst" TO "lateFeePerDaySgstMinor";
ALTER TABLE "gst_rate_tables" RENAME COLUMN "cap" TO "capMinor";
