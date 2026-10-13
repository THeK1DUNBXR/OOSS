-- Final invoice, credit note, fee instalment and course catalogue money columns to
-- bigint paise (ORDERED-PLAN 1.6, slice S3 fees; after 20261013246000_invoice_posting).
--
-- Eleven Decimal(18,2) money columns become paise in place, each renamed to the
-- `<name>Minor` convention the other paise columns follow:
--
--   final_invoices.totalPayable        -> totalPayableMinor (NOT NULL, DEFAULT 0)
--   final_invoices.totalReceived       -> totalReceivedMinor (NOT NULL, DEFAULT 0)
--   final_invoices.creditNoted         -> creditNotedMinor (NOT NULL, DEFAULT 0)
--   final_invoices.balance             -> balanceMinor (NOT NULL, DEFAULT 0)
--   credit_notes.amount                -> amountMinor (NOT NULL)
--   fee_instalments.amount             -> amountMinor (NOT NULL)
--   courses.feeAmount                  -> feeAmountMinor (nullable)
--   course_fee_plans.monthlyFee        -> monthlyFeeMinor (NOT NULL)
--   course_addons.price                -> priceMinor (NOT NULL)
--
-- Rates and hours are not money and stay as they are: courses.gstRate,
-- course_addons.gstRate, courses.hours.
--
-- The figures are computed in paise from here on, each rounded once, half away from
-- zero (owner decision, 2026-10-13). The old float path let Postgres round each stored
-- figure to two places, so every stored value is already exact in paise and the USING
-- clause changes no figure.
--
-- Checked, not assumed: no CHECK constraint, index, view, trigger or function names
-- these columns (the baseline primary keys and indexes on these tables cover ids,
-- tenantId, recordCode, invoiceId, status and dueDate only), so the type change is not
-- blocked by a dependent object.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only
-- be there if the column drifted to an unconstrained type or a restore brought one
-- in. Rounding it here would hide exactly that, so the migration stops instead.

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
    IF EXISTS (SELECT 1 FROM "final_invoices" WHERE "totalPayable" <> round("totalPayable", 2) OR "totalReceived" <> round("totalReceived", 2) OR "creditNoted" <> round("creditNoted", 2) OR "balance" <> round("balance", 2))
       OR EXISTS (SELECT 1 FROM "credit_notes" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "fee_instalments" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "courses" WHERE "feeAmount" <> round("feeAmount", 2))
       OR EXISTS (SELECT 1 FROM "course_fee_plans" WHERE "monthlyFee" <> round("monthlyFee", 2))
       OR EXISTS (SELECT 1 FROM "course_addons" WHERE "price" <> round("price", 2))
    THEN
      RAISE EXCEPTION 'A final invoice, credit note, fee instalment or course money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- final_invoices
ALTER TABLE "final_invoices" ALTER COLUMN "totalPayable" TYPE BIGINT USING (round("totalPayable" * 100))::BIGINT;
ALTER TABLE "final_invoices" RENAME COLUMN "totalPayable" TO "totalPayableMinor";
ALTER TABLE "final_invoices" ALTER COLUMN "totalReceived" TYPE BIGINT USING (round("totalReceived" * 100))::BIGINT;
ALTER TABLE "final_invoices" RENAME COLUMN "totalReceived" TO "totalReceivedMinor";
ALTER TABLE "final_invoices" ALTER COLUMN "creditNoted" TYPE BIGINT USING (round("creditNoted" * 100))::BIGINT;
ALTER TABLE "final_invoices" RENAME COLUMN "creditNoted" TO "creditNotedMinor";
ALTER TABLE "final_invoices" ALTER COLUMN "balance" TYPE BIGINT USING (round("balance" * 100))::BIGINT;
ALTER TABLE "final_invoices" RENAME COLUMN "balance" TO "balanceMinor";

-- credit_notes
ALTER TABLE "credit_notes" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "credit_notes" RENAME COLUMN "amount" TO "amountMinor";

-- fee_instalments
ALTER TABLE "fee_instalments" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "fee_instalments" RENAME COLUMN "amount" TO "amountMinor";

-- courses
ALTER TABLE "courses" ALTER COLUMN "feeAmount" TYPE BIGINT USING (round("feeAmount" * 100))::BIGINT;
ALTER TABLE "courses" RENAME COLUMN "feeAmount" TO "feeAmountMinor";

-- course_fee_plans
ALTER TABLE "course_fee_plans" ALTER COLUMN "monthlyFee" TYPE BIGINT USING (round("monthlyFee" * 100))::BIGINT;
ALTER TABLE "course_fee_plans" RENAME COLUMN "monthlyFee" TO "monthlyFeeMinor";

-- course_addons
ALTER TABLE "course_addons" ALTER COLUMN "price" TYPE BIGINT USING (round("price" * 100))::BIGINT;
ALTER TABLE "course_addons" RENAME COLUMN "price" TO "priceMinor";
