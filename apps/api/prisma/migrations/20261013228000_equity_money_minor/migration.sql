-- Equity and corporate money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S7).
--
-- Fourteen Decimal money columns across ten tables become paise in place, and each
-- is renamed to the `<name>Minor` convention the other paise columns follow:
--
--   share_classes.faceValue                   -> faceValueMinor
--   share_transactions.pricePerShare          -> pricePerShareMinor (nullable)
--   share_certificates.stampDutyPaid          -> stampDutyPaidMinor (nullable)
--   valuations.equityValue                    -> equityValueMinor (nullable)
--   funding_rounds.preMoneyValuation          -> preMoneyValuationMinor (nullable)
--   funding_rounds.postMoneyValuation         -> postMoneyValuationMinor (nullable)
--   funding_rounds.raised                     -> raisedMinor (nullable)
--   esop_plans.exercisePriceDefault           -> exercisePriceDefaultMinor (nullable)
--   option_grants.exercisePrice               -> exercisePriceMinor
--   option_exercises.exercisePrice            -> exercisePriceMinor
--   option_exercises.fmvPerShare              -> fmvPerShareMinor (nullable)
--   option_exercises.perquisite               -> perquisiteMinor (nullable)
--   documents.stampDutyAmount                 -> stampDutyAmountMinor (nullable, Decimal(14,2))
--   compliance_refunds.amount                 -> amountMinor (Decimal(14,2))
--
-- Nothing in the migration history (views, triggers, functions, CHECK
-- constraints) names these columns, so no dependent object blocks the type change.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only
-- be there if the column drifted to an unconstrained type or a restore brought one
-- in. Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, the tables show no rows,
-- so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (SELECT 1 FROM "share_classes" WHERE "faceValue" <> round("faceValue", 2))
       OR EXISTS (SELECT 1 FROM "share_transactions" WHERE "pricePerShare" <> round("pricePerShare", 2))
       OR EXISTS (SELECT 1 FROM "share_certificates" WHERE "stampDutyPaid" <> round("stampDutyPaid", 2))
       OR EXISTS (SELECT 1 FROM "valuations" WHERE "equityValue" <> round("equityValue", 2))
       OR EXISTS (SELECT 1 FROM "funding_rounds" WHERE "preMoneyValuation" <> round("preMoneyValuation", 2))
       OR EXISTS (SELECT 1 FROM "funding_rounds" WHERE "postMoneyValuation" <> round("postMoneyValuation", 2))
       OR EXISTS (SELECT 1 FROM "funding_rounds" WHERE "raised" <> round("raised", 2))
       OR EXISTS (SELECT 1 FROM "esop_plans" WHERE "exercisePriceDefault" <> round("exercisePriceDefault", 2))
       OR EXISTS (SELECT 1 FROM "option_grants" WHERE "exercisePrice" <> round("exercisePrice", 2))
       OR EXISTS (SELECT 1 FROM "option_exercises" WHERE "exercisePrice" <> round("exercisePrice", 2))
       OR EXISTS (SELECT 1 FROM "option_exercises" WHERE "fmvPerShare" <> round("fmvPerShare", 2))
       OR EXISTS (SELECT 1 FROM "option_exercises" WHERE "perquisite" <> round("perquisite", 2))
       OR EXISTS (SELECT 1 FROM "documents" WHERE "stampDutyAmount" <> round("stampDutyAmount", 2))
       OR EXISTS (SELECT 1 FROM "compliance_refunds" WHERE "amount" <> round("amount", 2))
    THEN
      RAISE EXCEPTION 'An equity or corporate money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

ALTER TABLE "share_classes"
  ALTER COLUMN "faceValue" TYPE BIGINT USING (round("faceValue" * 100))::BIGINT;
ALTER TABLE "share_classes" RENAME COLUMN "faceValue" TO "faceValueMinor";

ALTER TABLE "share_transactions"
  ALTER COLUMN "pricePerShare" TYPE BIGINT USING (round("pricePerShare" * 100))::BIGINT;
ALTER TABLE "share_transactions" RENAME COLUMN "pricePerShare" TO "pricePerShareMinor";

ALTER TABLE "share_certificates"
  ALTER COLUMN "stampDutyPaid" TYPE BIGINT USING (round("stampDutyPaid" * 100))::BIGINT;
ALTER TABLE "share_certificates" RENAME COLUMN "stampDutyPaid" TO "stampDutyPaidMinor";

ALTER TABLE "valuations"
  ALTER COLUMN "equityValue" TYPE BIGINT USING (round("equityValue" * 100))::BIGINT;
ALTER TABLE "valuations" RENAME COLUMN "equityValue" TO "equityValueMinor";

ALTER TABLE "funding_rounds"
  ALTER COLUMN "preMoneyValuation" TYPE BIGINT USING (round("preMoneyValuation" * 100))::BIGINT;
ALTER TABLE "funding_rounds" RENAME COLUMN "preMoneyValuation" TO "preMoneyValuationMinor";

ALTER TABLE "funding_rounds"
  ALTER COLUMN "postMoneyValuation" TYPE BIGINT USING (round("postMoneyValuation" * 100))::BIGINT;
ALTER TABLE "funding_rounds" RENAME COLUMN "postMoneyValuation" TO "postMoneyValuationMinor";

ALTER TABLE "funding_rounds"
  ALTER COLUMN "raised" TYPE BIGINT USING (round("raised" * 100))::BIGINT;
ALTER TABLE "funding_rounds" RENAME COLUMN "raised" TO "raisedMinor";

ALTER TABLE "esop_plans"
  ALTER COLUMN "exercisePriceDefault" TYPE BIGINT USING (round("exercisePriceDefault" * 100))::BIGINT;
ALTER TABLE "esop_plans" RENAME COLUMN "exercisePriceDefault" TO "exercisePriceDefaultMinor";

ALTER TABLE "option_grants"
  ALTER COLUMN "exercisePrice" TYPE BIGINT USING (round("exercisePrice" * 100))::BIGINT;
ALTER TABLE "option_grants" RENAME COLUMN "exercisePrice" TO "exercisePriceMinor";

ALTER TABLE "option_exercises"
  ALTER COLUMN "exercisePrice" TYPE BIGINT USING (round("exercisePrice" * 100))::BIGINT;
ALTER TABLE "option_exercises" RENAME COLUMN "exercisePrice" TO "exercisePriceMinor";

ALTER TABLE "option_exercises"
  ALTER COLUMN "fmvPerShare" TYPE BIGINT USING (round("fmvPerShare" * 100))::BIGINT;
ALTER TABLE "option_exercises" RENAME COLUMN "fmvPerShare" TO "fmvPerShareMinor";

ALTER TABLE "option_exercises"
  ALTER COLUMN "perquisite" TYPE BIGINT USING (round("perquisite" * 100))::BIGINT;
ALTER TABLE "option_exercises" RENAME COLUMN "perquisite" TO "perquisiteMinor";

ALTER TABLE "documents"
  ALTER COLUMN "stampDutyAmount" TYPE BIGINT USING (round("stampDutyAmount" * 100))::BIGINT;
ALTER TABLE "documents" RENAME COLUMN "stampDutyAmount" TO "stampDutyAmountMinor";

ALTER TABLE "compliance_refunds"
  ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "compliance_refunds" RENAME COLUMN "amount" TO "amountMinor";
