-- HCM money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S8-HCM).
--
-- Twenty-three Decimal money columns in the HCM workstream become paise in place,
-- each renamed to the `<name>Minor` convention the other paise columns follow:
--
--   hcm_assets_assets.cost                                   -> costMinor (nullable)
--   hcm_assets_travel_requests.estimatedCost                 -> estimatedCostMinor
--   hcm_assets_travel_requests.advanceRequested              -> advanceRequestedMinor (nullable)
--   hcm_compensation_pay_grades.minPay, midPay, maxPay       -> minPayMinor, midPayMinor, maxPayMinor
--   hcm_compensation_revision_lines.currentCtc, proposedCtc  -> currentCtcMinor, proposedCtcMinor
--   hcm_compensation_revision_lines.approvedCtc              -> approvedCtcMinor (nullable)
--   hcm_compensation_variable_payouts.computedAmount         -> computedAmountMinor
--   hcm_compensation_variable_payouts.approvedAmount         -> approvedAmountMinor (nullable)
--   hcm_compensation_benefit_plans.employerContribution      -> employerContributionMinor
--   hcm_compensation_benefit_plans.employeeContribution      -> employeeContributionMinor
--   hcm_compensation_employee_loans.principal, emi,
--     outstandingPrincipal                                   -> principalMinor, emiMinor, outstandingPrincipalMinor
--   hcm_compensation_expense_claims.amount                   -> amountMinor
--   hcm_learning_training_programs.cost                      -> costMinor (default 0)
--   hcm_learning_training_budgets.amount                     -> amountMinor
--   hcm_recruiting_candidate_profiles.currentCtc, expectedCtc -> currentCtcMinor, expectedCtcMinor (nullable)
--   hcm_recruiting_offer_letters.ctc                         -> ctcMinor
--   hcm_recruiting_referrals.bonusAmount                     -> bonusAmountMinor (nullable)
--
-- Nothing in the migration history (views, triggers, functions, CHECK
-- constraints) names these columns, so no dependent object blocks the type change.
-- The compensation records (compensation_records) and learning activities
-- (learning_activities) are a later slice and are not touched here.
--
-- The GUARD is the part that matters: a stored value with a third decimal can
-- only be there if the column drifted to an unconstrained type or a restore
-- brought one in. Rounding it here would hide exactly that, so the migration
-- stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, the HCM tables show no
-- rows, so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "hcm_assets_assets" WHERE "cost" <> round("cost", 2))
       OR EXISTS (SELECT 1 FROM "hcm_assets_travel_requests" WHERE "estimatedCost" <> round("estimatedCost", 2) OR "advanceRequested" <> round("advanceRequested", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_pay_grades" WHERE "minPay" <> round("minPay", 2) OR "midPay" <> round("midPay", 2) OR "maxPay" <> round("maxPay", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_revision_lines" WHERE "currentCtc" <> round("currentCtc", 2) OR "proposedCtc" <> round("proposedCtc", 2) OR "approvedCtc" <> round("approvedCtc", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_variable_payouts" WHERE "computedAmount" <> round("computedAmount", 2) OR "approvedAmount" <> round("approvedAmount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_benefit_plans" WHERE "employerContribution" <> round("employerContribution", 2) OR "employeeContribution" <> round("employeeContribution", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_employee_loans" WHERE "principal" <> round("principal", 2) OR "emi" <> round("emi", 2) OR "outstandingPrincipal" <> round("outstandingPrincipal", 2))
       OR EXISTS (SELECT 1 FROM "hcm_compensation_expense_claims" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_learning_training_programs" WHERE "cost" <> round("cost", 2))
       OR EXISTS (SELECT 1 FROM "hcm_learning_training_budgets" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_recruiting_candidate_profiles" WHERE "currentCtc" <> round("currentCtc", 2) OR "expectedCtc" <> round("expectedCtc", 2))
       OR EXISTS (SELECT 1 FROM "hcm_recruiting_offer_letters" WHERE "ctc" <> round("ctc", 2))
       OR EXISTS (SELECT 1 FROM "hcm_recruiting_referrals" WHERE "bonusAmount" <> round("bonusAmount", 2))
    THEN
      RAISE EXCEPTION 'An HCM money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- hcm_assets_assets
ALTER TABLE "hcm_assets_assets" ALTER COLUMN "cost" TYPE BIGINT USING (round("cost" * 100))::BIGINT;
ALTER TABLE "hcm_assets_assets" RENAME COLUMN "cost" TO "costMinor";

-- hcm_assets_travel_requests
ALTER TABLE "hcm_assets_travel_requests" ALTER COLUMN "estimatedCost" TYPE BIGINT USING (round("estimatedCost" * 100))::BIGINT;
ALTER TABLE "hcm_assets_travel_requests" RENAME COLUMN "estimatedCost" TO "estimatedCostMinor";
ALTER TABLE "hcm_assets_travel_requests" ALTER COLUMN "advanceRequested" TYPE BIGINT USING (round("advanceRequested" * 100))::BIGINT;
ALTER TABLE "hcm_assets_travel_requests" RENAME COLUMN "advanceRequested" TO "advanceRequestedMinor";

-- hcm_compensation_pay_grades
ALTER TABLE "hcm_compensation_pay_grades" ALTER COLUMN "minPay" TYPE BIGINT USING (round("minPay" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_pay_grades" RENAME COLUMN "minPay" TO "minPayMinor";
ALTER TABLE "hcm_compensation_pay_grades" ALTER COLUMN "midPay" TYPE BIGINT USING (round("midPay" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_pay_grades" RENAME COLUMN "midPay" TO "midPayMinor";
ALTER TABLE "hcm_compensation_pay_grades" ALTER COLUMN "maxPay" TYPE BIGINT USING (round("maxPay" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_pay_grades" RENAME COLUMN "maxPay" TO "maxPayMinor";

-- hcm_compensation_revision_lines
ALTER TABLE "hcm_compensation_revision_lines" ALTER COLUMN "currentCtc" TYPE BIGINT USING (round("currentCtc" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_revision_lines" RENAME COLUMN "currentCtc" TO "currentCtcMinor";
ALTER TABLE "hcm_compensation_revision_lines" ALTER COLUMN "proposedCtc" TYPE BIGINT USING (round("proposedCtc" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_revision_lines" RENAME COLUMN "proposedCtc" TO "proposedCtcMinor";
ALTER TABLE "hcm_compensation_revision_lines" ALTER COLUMN "approvedCtc" TYPE BIGINT USING (round("approvedCtc" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_revision_lines" RENAME COLUMN "approvedCtc" TO "approvedCtcMinor";

-- hcm_compensation_variable_payouts
ALTER TABLE "hcm_compensation_variable_payouts" ALTER COLUMN "computedAmount" TYPE BIGINT USING (round("computedAmount" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_variable_payouts" RENAME COLUMN "computedAmount" TO "computedAmountMinor";
ALTER TABLE "hcm_compensation_variable_payouts" ALTER COLUMN "approvedAmount" TYPE BIGINT USING (round("approvedAmount" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_variable_payouts" RENAME COLUMN "approvedAmount" TO "approvedAmountMinor";

-- hcm_compensation_benefit_plans
ALTER TABLE "hcm_compensation_benefit_plans" ALTER COLUMN "employerContribution" TYPE BIGINT USING (round("employerContribution" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_benefit_plans" RENAME COLUMN "employerContribution" TO "employerContributionMinor";
ALTER TABLE "hcm_compensation_benefit_plans" ALTER COLUMN "employeeContribution" TYPE BIGINT USING (round("employeeContribution" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_benefit_plans" RENAME COLUMN "employeeContribution" TO "employeeContributionMinor";

-- hcm_compensation_employee_loans
ALTER TABLE "hcm_compensation_employee_loans" ALTER COLUMN "principal" TYPE BIGINT USING (round("principal" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_employee_loans" RENAME COLUMN "principal" TO "principalMinor";
ALTER TABLE "hcm_compensation_employee_loans" ALTER COLUMN "emi" TYPE BIGINT USING (round("emi" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_employee_loans" RENAME COLUMN "emi" TO "emiMinor";
ALTER TABLE "hcm_compensation_employee_loans" ALTER COLUMN "outstandingPrincipal" TYPE BIGINT USING (round("outstandingPrincipal" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_employee_loans" RENAME COLUMN "outstandingPrincipal" TO "outstandingPrincipalMinor";

-- hcm_compensation_expense_claims
ALTER TABLE "hcm_compensation_expense_claims" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "hcm_compensation_expense_claims" RENAME COLUMN "amount" TO "amountMinor";

-- hcm_learning_training_programs (a default of 0 is kept, as paise)
ALTER TABLE "hcm_learning_training_programs" ALTER COLUMN "cost" DROP DEFAULT;
ALTER TABLE "hcm_learning_training_programs" ALTER COLUMN "cost" TYPE BIGINT USING (round("cost" * 100))::BIGINT;
ALTER TABLE "hcm_learning_training_programs" ALTER COLUMN "cost" SET DEFAULT 0;
ALTER TABLE "hcm_learning_training_programs" RENAME COLUMN "cost" TO "costMinor";

-- hcm_learning_training_budgets
ALTER TABLE "hcm_learning_training_budgets" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "hcm_learning_training_budgets" RENAME COLUMN "amount" TO "amountMinor";

-- hcm_recruiting_candidate_profiles
ALTER TABLE "hcm_recruiting_candidate_profiles" ALTER COLUMN "currentCtc" TYPE BIGINT USING (round("currentCtc" * 100))::BIGINT;
ALTER TABLE "hcm_recruiting_candidate_profiles" RENAME COLUMN "currentCtc" TO "currentCtcMinor";
ALTER TABLE "hcm_recruiting_candidate_profiles" ALTER COLUMN "expectedCtc" TYPE BIGINT USING (round("expectedCtc" * 100))::BIGINT;
ALTER TABLE "hcm_recruiting_candidate_profiles" RENAME COLUMN "expectedCtc" TO "expectedCtcMinor";

-- hcm_recruiting_offer_letters
ALTER TABLE "hcm_recruiting_offer_letters" ALTER COLUMN "ctc" TYPE BIGINT USING (round("ctc" * 100))::BIGINT;
ALTER TABLE "hcm_recruiting_offer_letters" RENAME COLUMN "ctc" TO "ctcMinor";

-- hcm_recruiting_referrals
ALTER TABLE "hcm_recruiting_referrals" ALTER COLUMN "bonusAmount" TYPE BIGINT USING (round("bonusAmount" * 100))::BIGINT;
ALTER TABLE "hcm_recruiting_referrals" RENAME COLUMN "bonusAmount" TO "bonusAmountMinor";
