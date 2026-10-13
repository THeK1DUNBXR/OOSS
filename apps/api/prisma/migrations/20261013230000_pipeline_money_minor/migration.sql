-- Marketing and pipeline money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S6).
--
-- Thirteen Decimal(18,2) money columns become paise in place, each renamed to the
-- `<name>Minor` convention the other paise columns follow:
--
--   pipeline_definitions.commitApprovalThreshold              -> commitApprovalThresholdMinor (nullable)
--   mkt_campaigns.budgetPlanned, budgetCommitted, budgetActual -> ...Minor (default 0)
--   mkt_campaigns.targetPipelineValue                          -> targetPipelineValueMinor (nullable)
--   mkt_campaign_approvals.thresholdAmount                     -> thresholdAmountMinor (nullable)
--   mkt_touchpoints.cost                                       -> costMinor (nullable)
--   mkt_events.costPlanned, costActual                         -> ...Minor (default 0)
--   mkt_referral_programs.rewardAmount                         -> rewardAmountMinor (nullable)
--   mkt_budgets.planned, committed                             -> ...Minor (default 0)
--   mkt_spends.amount                                          -> amountMinor
--
-- The baseline (20260901000000_baseline) holds the only DDL that names these
-- columns: no view, trigger, function or CHECK constraint depends on them, and no
-- index includes a money column, so the type change is not blocked by a dependent
-- object.
--
-- Not in this migration, on purpose: the authority ceiling (authority_grants) and
-- approval steps (approval_steps), which the demo dataset writes, and the quote
-- arithmetic, which is its own slice.
--
-- The GUARD is the part that matters: a stored value with a third decimal can
-- only be there if the column drifted to an unconstrained type or a restore
-- brought one in. Rounding it here would hide exactly that, so the migration
-- stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, the marketing tables show
-- no rows, so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "pipeline_definitions" WHERE "commitApprovalThreshold" <> round("commitApprovalThreshold", 2))
       OR EXISTS (SELECT 1 FROM "mkt_campaigns" WHERE "budgetPlanned" <> round("budgetPlanned", 2) OR "budgetCommitted" <> round("budgetCommitted", 2) OR "budgetActual" <> round("budgetActual", 2) OR "targetPipelineValue" <> round("targetPipelineValue", 2))
       OR EXISTS (SELECT 1 FROM "mkt_campaign_approvals" WHERE "thresholdAmount" <> round("thresholdAmount", 2))
       OR EXISTS (SELECT 1 FROM "mkt_touchpoints" WHERE "cost" <> round("cost", 2))
       OR EXISTS (SELECT 1 FROM "mkt_events" WHERE "costPlanned" <> round("costPlanned", 2) OR "costActual" <> round("costActual", 2))
       OR EXISTS (SELECT 1 FROM "mkt_referral_programs" WHERE "rewardAmount" <> round("rewardAmount", 2))
       OR EXISTS (SELECT 1 FROM "mkt_budgets" WHERE "planned" <> round("planned", 2) OR "committed" <> round("committed", 2))
       OR EXISTS (SELECT 1 FROM "mkt_spends" WHERE "amount" <> round("amount", 2))
    THEN
      RAISE EXCEPTION 'A marketing or pipeline money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- pipeline_definitions
ALTER TABLE "pipeline_definitions" ALTER COLUMN "commitApprovalThreshold" TYPE BIGINT USING (round("commitApprovalThreshold" * 100))::BIGINT;
ALTER TABLE "pipeline_definitions" RENAME COLUMN "commitApprovalThreshold" TO "commitApprovalThresholdMinor";

-- mkt_campaigns (defaults are kept as paise)
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetPlanned" DROP DEFAULT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetPlanned" TYPE BIGINT USING (round("budgetPlanned" * 100))::BIGINT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetPlanned" SET DEFAULT 0;
ALTER TABLE "mkt_campaigns" RENAME COLUMN "budgetPlanned" TO "budgetPlannedMinor";
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetCommitted" DROP DEFAULT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetCommitted" TYPE BIGINT USING (round("budgetCommitted" * 100))::BIGINT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetCommitted" SET DEFAULT 0;
ALTER TABLE "mkt_campaigns" RENAME COLUMN "budgetCommitted" TO "budgetCommittedMinor";
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetActual" DROP DEFAULT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetActual" TYPE BIGINT USING (round("budgetActual" * 100))::BIGINT;
ALTER TABLE "mkt_campaigns" ALTER COLUMN "budgetActual" SET DEFAULT 0;
ALTER TABLE "mkt_campaigns" RENAME COLUMN "budgetActual" TO "budgetActualMinor";
ALTER TABLE "mkt_campaigns" ALTER COLUMN "targetPipelineValue" TYPE BIGINT USING (round("targetPipelineValue" * 100))::BIGINT;
ALTER TABLE "mkt_campaigns" RENAME COLUMN "targetPipelineValue" TO "targetPipelineValueMinor";

-- mkt_campaign_approvals
ALTER TABLE "mkt_campaign_approvals" ALTER COLUMN "thresholdAmount" TYPE BIGINT USING (round("thresholdAmount" * 100))::BIGINT;
ALTER TABLE "mkt_campaign_approvals" RENAME COLUMN "thresholdAmount" TO "thresholdAmountMinor";

-- mkt_touchpoints
ALTER TABLE "mkt_touchpoints" ALTER COLUMN "cost" TYPE BIGINT USING (round("cost" * 100))::BIGINT;
ALTER TABLE "mkt_touchpoints" RENAME COLUMN "cost" TO "costMinor";

-- mkt_events
ALTER TABLE "mkt_events" ALTER COLUMN "costPlanned" DROP DEFAULT;
ALTER TABLE "mkt_events" ALTER COLUMN "costPlanned" TYPE BIGINT USING (round("costPlanned" * 100))::BIGINT;
ALTER TABLE "mkt_events" ALTER COLUMN "costPlanned" SET DEFAULT 0;
ALTER TABLE "mkt_events" RENAME COLUMN "costPlanned" TO "costPlannedMinor";
ALTER TABLE "mkt_events" ALTER COLUMN "costActual" DROP DEFAULT;
ALTER TABLE "mkt_events" ALTER COLUMN "costActual" TYPE BIGINT USING (round("costActual" * 100))::BIGINT;
ALTER TABLE "mkt_events" ALTER COLUMN "costActual" SET DEFAULT 0;
ALTER TABLE "mkt_events" RENAME COLUMN "costActual" TO "costActualMinor";

-- mkt_referral_programs
ALTER TABLE "mkt_referral_programs" ALTER COLUMN "rewardAmount" TYPE BIGINT USING (round("rewardAmount" * 100))::BIGINT;
ALTER TABLE "mkt_referral_programs" RENAME COLUMN "rewardAmount" TO "rewardAmountMinor";

-- mkt_budgets
ALTER TABLE "mkt_budgets" ALTER COLUMN "planned" DROP DEFAULT;
ALTER TABLE "mkt_budgets" ALTER COLUMN "planned" TYPE BIGINT USING (round("planned" * 100))::BIGINT;
ALTER TABLE "mkt_budgets" ALTER COLUMN "planned" SET DEFAULT 0;
ALTER TABLE "mkt_budgets" RENAME COLUMN "planned" TO "plannedMinor";
ALTER TABLE "mkt_budgets" ALTER COLUMN "committed" DROP DEFAULT;
ALTER TABLE "mkt_budgets" ALTER COLUMN "committed" TYPE BIGINT USING (round("committed" * 100))::BIGINT;
ALTER TABLE "mkt_budgets" ALTER COLUMN "committed" SET DEFAULT 0;
ALTER TABLE "mkt_budgets" RENAME COLUMN "committed" TO "committedMinor";

-- mkt_spends
ALTER TABLE "mkt_spends" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "mkt_spends" RENAME COLUMN "amount" TO "amountMinor";
