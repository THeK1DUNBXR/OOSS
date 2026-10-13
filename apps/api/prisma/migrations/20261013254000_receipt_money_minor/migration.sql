-- Payment, receipt and receivables money to bigint paise (ORDERED-PLAN 1.6, slice S3).
--
-- Four Decimal(18,2) money columns become paise in place, each renamed to the `<name>Minor`
-- convention the other paise columns follow:
--
--   payments.amount                          -> amountMinor (NOT NULL)
--   receipts.allocatedAmount                 -> allocatedAmountMinor (NOT NULL)
--   receipts.subjectTotal                    -> subjectTotalMinor (NOT NULL, default 0)
--   receipts.balanceAfter                    -> balanceAfterMinor (NOT NULL, default 0)
--   receivables_projections.amountOutstanding -> amountOutstandingMinor (nullable)
--
-- payments.foreignAmount is NOT converted here. It is in a foreign currency, whose minor unit
-- is not necessarily paise, so it stays Decimal until that is settled.
--
-- The rename does not reach plpgsql. The receipt allocation function
-- (20261013212000_receipt_allocation_bounds) reads "amount" and "allocatedAmount" by name, so it
-- is replaced below with the paise names, or the bound would stop being checked at all. The
-- CHECK constraint and the trigger column list follow the rename by themselves, except that
-- Postgres refuses to change the type of a column named in a trigger's UPDATE OF list, so that
-- trigger is dropped first and re-created on the renamed column.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only be there if
-- a column drifted to an unconstrained type or a restore brought one in. Rounding it here would
-- hide exactly that, so the migration stops instead.

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
    IF EXISTS (SELECT 1 FROM "payments" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "receipts" WHERE "allocatedAmount" <> round("allocatedAmount", 2) OR "subjectTotal" <> round("subjectTotal", 2) OR "balanceAfter" <> round("balanceAfter", 2))
       OR EXISTS (SELECT 1 FROM "receivables_projections" WHERE "amountOutstanding" <> round("amountOutstanding", 2))
    THEN
      RAISE EXCEPTION 'A payment, receipt or receivables money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- The payment trigger names "amount" in its column list. Dropped for the type change and
-- re-created on the renamed column once the rename is done.
DROP TRIGGER "payment_amount_covers_receipts" ON "payments";

-- payments
ALTER TABLE "payments" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "payments" RENAME COLUMN "amount" TO "amountMinor";

-- receipts
ALTER TABLE "receipts" ALTER COLUMN "allocatedAmount" TYPE BIGINT USING (round("allocatedAmount" * 100))::BIGINT;
ALTER TABLE "receipts" RENAME COLUMN "allocatedAmount" TO "allocatedAmountMinor";

ALTER TABLE "receipts" ALTER COLUMN "subjectTotal" DROP DEFAULT;
ALTER TABLE "receipts" ALTER COLUMN "subjectTotal" TYPE BIGINT USING (round("subjectTotal" * 100))::BIGINT;
ALTER TABLE "receipts" ALTER COLUMN "subjectTotal" SET DEFAULT 0;
ALTER TABLE "receipts" RENAME COLUMN "subjectTotal" TO "subjectTotalMinor";

ALTER TABLE "receipts" ALTER COLUMN "balanceAfter" DROP DEFAULT;
ALTER TABLE "receipts" ALTER COLUMN "balanceAfter" TYPE BIGINT USING (round("balanceAfter" * 100))::BIGINT;
ALTER TABLE "receipts" ALTER COLUMN "balanceAfter" SET DEFAULT 0;
ALTER TABLE "receipts" RENAME COLUMN "balanceAfter" TO "balanceAfterMinor";

-- The positive-amount CHECK keeps its expression across the rename; its name carries the old
-- column name, so it is renamed to match.
ALTER TABLE "receipts" RENAME CONSTRAINT "receipts_allocatedAmount_positive" TO "receipts_allocatedAmountMinor_positive";

-- receivables_projections (nullable, so no default to carry)
ALTER TABLE "receivables_projections" ALTER COLUMN "amountOutstanding" TYPE BIGINT USING (round("amountOutstanding" * 100))::BIGINT;
ALTER TABLE "receivables_projections" RENAME COLUMN "amountOutstanding" TO "amountOutstandingMinor";

-- The allocation bound, on paise. The sum is taken as BIGINT, and the message keeps its
-- wording so the refusal reads the same to a person, with the figures in paise.
CREATE OR REPLACE FUNCTION "payment_allocation_within_amount"(pid TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_amount BIGINT;
  allocated BIGINT;
BEGIN
  SELECT "amountMinor" INTO payment_amount FROM "payments" WHERE "id" = pid FOR UPDATE;
  -- RLS hides another tenant's payment from this query, so a missing row here is a receipt
  -- naming a payment this tenant cannot see. Refused, not passed: NULL > NULL is not a refusal.
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt names a payment this tenant cannot see'; END IF;

  SELECT COALESCE(SUM("allocatedAmountMinor"), 0)::BIGINT INTO allocated FROM "receipts" WHERE "paymentId" = pid;
  IF allocated > payment_amount THEN
    RAISE EXCEPTION 'receipts allocate more than the payment amount: % paise against % paise', allocated, payment_amount;
  END IF;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_amount_covers_receipts"
AFTER UPDATE OF "amountMinor" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "payment_amount_covers_receipts"();
