-- ORDERED-PLAN 1.6, slice S3A: the invoice header and invoice line money
-- columns become paise. Same shape as 20261013220000_gst_money_minor: a guard
-- that refuses rather than rounds, then the type change, then the rename.
--
-- Columns: invoices (taxableValue, cgstAmount, sgstAmount, igstAmount,
-- roundOff, grandTotal, amountPayableNow), invoice_lines (unitPrice, amount,
-- discountAmount, taxAmount). Payment, Receipt and the receivables tables are
-- untouched: the receipt-allocation triggers in 20261013212000 read them.

-- GUARD BEGIN
-- Runs as the table owner, and FORCE RLS binds the owner, so with no tenant set
-- these tables show no rows. The guard walks the tenants and sets the tenant on
-- each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (
      SELECT 1 FROM "invoices"
      WHERE "taxableValue" <> round("taxableValue", 2)
         OR "cgstAmount" <> round("cgstAmount", 2)
         OR "sgstAmount" <> round("sgstAmount", 2)
         OR "igstAmount" <> round("igstAmount", 2)
         OR "roundOff" <> round("roundOff", 2)
         OR "grandTotal" <> round("grandTotal", 2)
         OR "amountPayableNow" <> round("amountPayableNow", 2)
    ) OR EXISTS (
      SELECT 1 FROM "invoice_lines"
      WHERE "unitPrice" <> round("unitPrice", 2)
         OR "amount" <> round("amount", 2)
         OR "discountAmount" <> round("discountAmount", 2)
         OR "taxAmount" <> round("taxAmount", 2)
    ) THEN
      RAISE EXCEPTION 'An invoice money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- invoices
ALTER TABLE "invoices"
  ALTER COLUMN "taxableValue" TYPE BIGINT USING (round("taxableValue" * 100))::BIGINT,
  ALTER COLUMN "cgstAmount" TYPE BIGINT USING (round("cgstAmount" * 100))::BIGINT,
  ALTER COLUMN "sgstAmount" TYPE BIGINT USING (round("sgstAmount" * 100))::BIGINT,
  ALTER COLUMN "igstAmount" TYPE BIGINT USING (round("igstAmount" * 100))::BIGINT,
  ALTER COLUMN "roundOff" TYPE BIGINT USING (round("roundOff" * 100))::BIGINT,
  ALTER COLUMN "grandTotal" TYPE BIGINT USING (round("grandTotal" * 100))::BIGINT,
  ALTER COLUMN "amountPayableNow" TYPE BIGINT USING (round("amountPayableNow" * 100))::BIGINT;

ALTER TABLE "invoices"
  ALTER COLUMN "taxableValue" SET DEFAULT 0,
  ALTER COLUMN "cgstAmount" SET DEFAULT 0,
  ALTER COLUMN "sgstAmount" SET DEFAULT 0,
  ALTER COLUMN "igstAmount" SET DEFAULT 0,
  ALTER COLUMN "roundOff" SET DEFAULT 0,
  ALTER COLUMN "grandTotal" SET DEFAULT 0,
  ALTER COLUMN "amountPayableNow" SET DEFAULT 0;

ALTER TABLE "invoices" RENAME COLUMN "taxableValue" TO "taxableValueMinor";
ALTER TABLE "invoices" RENAME COLUMN "cgstAmount" TO "cgstAmountMinor";
ALTER TABLE "invoices" RENAME COLUMN "sgstAmount" TO "sgstAmountMinor";
ALTER TABLE "invoices" RENAME COLUMN "igstAmount" TO "igstAmountMinor";
ALTER TABLE "invoices" RENAME COLUMN "roundOff" TO "roundOffMinor";
ALTER TABLE "invoices" RENAME COLUMN "grandTotal" TO "grandTotalMinor";
ALTER TABLE "invoices" RENAME COLUMN "amountPayableNow" TO "amountPayableNowMinor";

-- invoice_lines. amount has no default in the schema and none here.
ALTER TABLE "invoice_lines"
  ALTER COLUMN "unitPrice" TYPE BIGINT USING (round("unitPrice" * 100))::BIGINT,
  ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT,
  ALTER COLUMN "discountAmount" TYPE BIGINT USING (round("discountAmount" * 100))::BIGINT,
  ALTER COLUMN "taxAmount" TYPE BIGINT USING (round("taxAmount" * 100))::BIGINT;

ALTER TABLE "invoice_lines"
  ALTER COLUMN "unitPrice" SET DEFAULT 0,
  ALTER COLUMN "discountAmount" SET DEFAULT 0,
  ALTER COLUMN "taxAmount" SET DEFAULT 0;

ALTER TABLE "invoice_lines" RENAME COLUMN "unitPrice" TO "unitPriceMinor";
ALTER TABLE "invoice_lines" RENAME COLUMN "amount" TO "amountMinor";
ALTER TABLE "invoice_lines" RENAME COLUMN "discountAmount" TO "discountAmountMinor";
ALTER TABLE "invoice_lines" RENAME COLUMN "taxAmount" TO "taxAmountMinor";
