-- VendorBill money columns to bigint paise (ORDERED-PLAN 1.6, slice S5 vendor bills; after
-- 20261013244000_quote_money_minor).
--
-- Six Decimal(18,2) money columns become paise in place, each renamed to the `<name>Minor`
-- convention the other paise columns follow:
--
--   vendor_bills.subtotal      -> subtotalMinor (NOT NULL DEFAULT 0)
--   vendor_bills.taxAmount     -> taxAmountMinor (NOT NULL DEFAULT 0)
--   vendor_bills.total         -> totalMinor (NOT NULL DEFAULT 0)
--   vendor_bills.paidAmount    -> paidAmountMinor (NOT NULL DEFAULT 0)
--   vendor_bills.rcmTaxAmount  -> rcmTaxAmountMinor (NOT NULL DEFAULT 0)
--   vendor_bills.tdsAmount     -> tdsAmountMinor (NOT NULL DEFAULT 0)
--
-- tdsRate is a rate, not money, and stays Decimal(5,2).
--
-- Every stored value is already exact to two places, so the USING clause changes no figure.
-- Checked, not assumed: the baseline (20260901000000_baseline) gives vendor_bills no CHECK
-- constraint, view or trigger naming these columns; its indexes cover tenantId, status,
-- dueDate, vendorName and recordCode only.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only be there
-- if the column drifted to an unconstrained type or a restore brought one in. Rounding it here
-- would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, vendor_bills shows no rows, so the
-- guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (
      SELECT 1 FROM "vendor_bills"
       WHERE "subtotal" <> round("subtotal", 2)
          OR "taxAmount" <> round("taxAmount", 2)
          OR "total" <> round("total", 2)
          OR "paidAmount" <> round("paidAmount", 2)
          OR "rcmTaxAmount" <> round("rcmTaxAmount", 2)
          OR "tdsAmount" <> round("tdsAmount", 2)
    )
    THEN
      RAISE EXCEPTION 'A vendor bill money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- Defaults are dropped, the column converted, and the default set again as paise. A numeric
-- DEFAULT 0 does not survive the type change on its own as the zero the column needs.
ALTER TABLE "vendor_bills" ALTER COLUMN "subtotal" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "subtotal" TYPE BIGINT USING (round("subtotal" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "subtotal" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "subtotal" TO "subtotalMinor";

ALTER TABLE "vendor_bills" ALTER COLUMN "taxAmount" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "taxAmount" TYPE BIGINT USING (round("taxAmount" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "taxAmount" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "taxAmount" TO "taxAmountMinor";

ALTER TABLE "vendor_bills" ALTER COLUMN "total" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "total" TYPE BIGINT USING (round("total" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "total" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "total" TO "totalMinor";

ALTER TABLE "vendor_bills" ALTER COLUMN "paidAmount" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "paidAmount" TYPE BIGINT USING (round("paidAmount" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "paidAmount" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "paidAmount" TO "paidAmountMinor";

ALTER TABLE "vendor_bills" ALTER COLUMN "rcmTaxAmount" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "rcmTaxAmount" TYPE BIGINT USING (round("rcmTaxAmount" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "rcmTaxAmount" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "rcmTaxAmount" TO "rcmTaxAmountMinor";

ALTER TABLE "vendor_bills" ALTER COLUMN "tdsAmount" DROP DEFAULT;
ALTER TABLE "vendor_bills" ALTER COLUMN "tdsAmount" TYPE BIGINT USING (round("tdsAmount" * 100))::BIGINT;
ALTER TABLE "vendor_bills" ALTER COLUMN "tdsAmount" SET DEFAULT 0;
ALTER TABLE "vendor_bills" RENAME COLUMN "tdsAmount" TO "tdsAmountMinor";
