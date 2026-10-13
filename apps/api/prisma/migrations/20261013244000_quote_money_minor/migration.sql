-- Quote and price book money columns to bigint paise (ORDERED-PLAN 1.6; the last
-- commercial slice, after 20261013234000_commercial_money_minor).
--
-- Six Decimal(18,2) money columns become paise in place, each renamed to the
-- `<name>Minor` convention the other paise columns follow:
--
--   quotes.subtotal                    -> subtotalMinor (nullable)
--   quotes.discountTotal               -> discountTotalMinor (nullable)
--   quotes.grandTotal                  -> grandTotalMinor (nullable)
--   quote_lines.listUnitPrice          -> listUnitPriceMinor (NOT NULL)
--   quote_lines.discountAmount         -> discountAmountMinor (nullable)
--   quote_lines.lineTotal              -> lineTotalMinor (nullable)
--   price_book_entries.unitPrice       -> unitPriceMinor (NOT NULL)
--
-- The figures are computed in paise from here on, each rounded once, half away from
-- zero (owner decision, 2026-10-13). The old float path let Postgres round each stored
-- figure to two places, so every stored value is already exact in paise and the USING
-- clause changes no figure.
--
-- Checked, not assumed: no CHECK constraint, index, view, trigger or function names
-- these columns (the baseline indexes on quotes and quote_lines cover tenantId,
-- recordCode, opportunityId and quoteId only, and price_book_entries' indexes cover
-- offeringId, priceBookId, currency and version), so the type change is not blocked by
-- a dependent object.
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
    IF EXISTS (SELECT 1 FROM "quotes" WHERE "subtotal" <> round("subtotal", 2) OR "discountTotal" <> round("discountTotal", 2) OR "grandTotal" <> round("grandTotal", 2))
       OR EXISTS (SELECT 1 FROM "quote_lines" WHERE "listUnitPrice" <> round("listUnitPrice", 2) OR "discountAmount" <> round("discountAmount", 2) OR "lineTotal" <> round("lineTotal", 2))
       OR EXISTS (SELECT 1 FROM "price_book_entries" WHERE "unitPrice" <> round("unitPrice", 2))
    THEN
      RAISE EXCEPTION 'A quote or price book money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- quotes
ALTER TABLE "quotes" ALTER COLUMN "subtotal" TYPE BIGINT USING (round("subtotal" * 100))::BIGINT;
ALTER TABLE "quotes" RENAME COLUMN "subtotal" TO "subtotalMinor";
ALTER TABLE "quotes" ALTER COLUMN "discountTotal" TYPE BIGINT USING (round("discountTotal" * 100))::BIGINT;
ALTER TABLE "quotes" RENAME COLUMN "discountTotal" TO "discountTotalMinor";
ALTER TABLE "quotes" ALTER COLUMN "grandTotal" TYPE BIGINT USING (round("grandTotal" * 100))::BIGINT;
ALTER TABLE "quotes" RENAME COLUMN "grandTotal" TO "grandTotalMinor";

-- quote_lines
ALTER TABLE "quote_lines" ALTER COLUMN "listUnitPrice" TYPE BIGINT USING (round("listUnitPrice" * 100))::BIGINT;
ALTER TABLE "quote_lines" RENAME COLUMN "listUnitPrice" TO "listUnitPriceMinor";
ALTER TABLE "quote_lines" ALTER COLUMN "discountAmount" TYPE BIGINT USING (round("discountAmount" * 100))::BIGINT;
ALTER TABLE "quote_lines" RENAME COLUMN "discountAmount" TO "discountAmountMinor";
ALTER TABLE "quote_lines" ALTER COLUMN "lineTotal" TYPE BIGINT USING (round("lineTotal" * 100))::BIGINT;
ALTER TABLE "quote_lines" RENAME COLUMN "lineTotal" TO "lineTotalMinor";

-- price_book_entries
ALTER TABLE "price_book_entries" ALTER COLUMN "unitPrice" TYPE BIGINT USING (round("unitPrice" * 100))::BIGINT;
ALTER TABLE "price_book_entries" RENAME COLUMN "unitPrice" TO "unitPriceMinor";
