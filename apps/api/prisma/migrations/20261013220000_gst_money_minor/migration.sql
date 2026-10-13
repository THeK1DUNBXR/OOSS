-- ORDERED-PLAN 1.6, slice S4: the GST filing, reverse-charge, debit-note and
-- GSTR-2B match money columns become paise. Same shape as
-- 20261013150000_decision_links_money: a guard that refuses rather than rounds,
-- then the type change, then the rename.
--
-- Columns: gst_filings (taxableValue, cgstAmount, sgstAmount, igstAmount,
-- inputTaxCredit, netPayable), rcm_self_invoices (taxableValue, cgstAmount,
-- sgstAmount, igstAmount), debit_notes (amount), gstr2b_matches (difference).

-- GUARD BEGIN
-- Runs as the table owner, and FORCE RLS binds the owner, so with no tenant set
-- these tables show no rows. The guard walks the tenants and sets the tenant on
-- each pass, the same as the decision-links guard.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (
      SELECT 1 FROM "gst_filings"
      WHERE "taxableValue" <> round("taxableValue", 2)
         OR "cgstAmount" <> round("cgstAmount", 2)
         OR "sgstAmount" <> round("sgstAmount", 2)
         OR "igstAmount" <> round("igstAmount", 2)
         OR "inputTaxCredit" <> round("inputTaxCredit", 2)
         OR "netPayable" <> round("netPayable", 2)
    ) OR EXISTS (
      SELECT 1 FROM "rcm_self_invoices"
      WHERE "taxableValue" <> round("taxableValue", 2)
         OR "cgstAmount" <> round("cgstAmount", 2)
         OR "sgstAmount" <> round("sgstAmount", 2)
         OR "igstAmount" <> round("igstAmount", 2)
    ) OR EXISTS (
      SELECT 1 FROM "debit_notes" WHERE "amount" <> round("amount", 2)
    ) OR EXISTS (
      SELECT 1 FROM "gstr2b_matches" WHERE "difference" <> round("difference", 2)
    ) THEN
      RAISE EXCEPTION 'A GST money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- gst_filings
ALTER TABLE "gst_filings"
  ALTER COLUMN "taxableValue" TYPE BIGINT USING (round("taxableValue" * 100))::BIGINT,
  ALTER COLUMN "cgstAmount" TYPE BIGINT USING (round("cgstAmount" * 100))::BIGINT,
  ALTER COLUMN "sgstAmount" TYPE BIGINT USING (round("sgstAmount" * 100))::BIGINT,
  ALTER COLUMN "igstAmount" TYPE BIGINT USING (round("igstAmount" * 100))::BIGINT,
  ALTER COLUMN "inputTaxCredit" TYPE BIGINT USING (round("inputTaxCredit" * 100))::BIGINT,
  ALTER COLUMN "netPayable" TYPE BIGINT USING (round("netPayable" * 100))::BIGINT;

ALTER TABLE "gst_filings"
  ALTER COLUMN "taxableValue" SET DEFAULT 0,
  ALTER COLUMN "cgstAmount" SET DEFAULT 0,
  ALTER COLUMN "sgstAmount" SET DEFAULT 0,
  ALTER COLUMN "igstAmount" SET DEFAULT 0,
  ALTER COLUMN "inputTaxCredit" SET DEFAULT 0,
  ALTER COLUMN "netPayable" SET DEFAULT 0;

ALTER TABLE "gst_filings" RENAME COLUMN "taxableValue" TO "taxableValueMinor";
ALTER TABLE "gst_filings" RENAME COLUMN "cgstAmount" TO "cgstAmountMinor";
ALTER TABLE "gst_filings" RENAME COLUMN "sgstAmount" TO "sgstAmountMinor";
ALTER TABLE "gst_filings" RENAME COLUMN "igstAmount" TO "igstAmountMinor";
ALTER TABLE "gst_filings" RENAME COLUMN "inputTaxCredit" TO "inputTaxCreditMinor";
ALTER TABLE "gst_filings" RENAME COLUMN "netPayable" TO "netPayableMinor";

-- rcm_self_invoices
ALTER TABLE "rcm_self_invoices"
  ALTER COLUMN "taxableValue" TYPE BIGINT USING (round("taxableValue" * 100))::BIGINT,
  ALTER COLUMN "cgstAmount" TYPE BIGINT USING (round("cgstAmount" * 100))::BIGINT,
  ALTER COLUMN "sgstAmount" TYPE BIGINT USING (round("sgstAmount" * 100))::BIGINT,
  ALTER COLUMN "igstAmount" TYPE BIGINT USING (round("igstAmount" * 100))::BIGINT;

ALTER TABLE "rcm_self_invoices"
  ALTER COLUMN "cgstAmount" SET DEFAULT 0,
  ALTER COLUMN "sgstAmount" SET DEFAULT 0,
  ALTER COLUMN "igstAmount" SET DEFAULT 0;

ALTER TABLE "rcm_self_invoices" RENAME COLUMN "taxableValue" TO "taxableValueMinor";
ALTER TABLE "rcm_self_invoices" RENAME COLUMN "cgstAmount" TO "cgstAmountMinor";
ALTER TABLE "rcm_self_invoices" RENAME COLUMN "sgstAmount" TO "sgstAmountMinor";
ALTER TABLE "rcm_self_invoices" RENAME COLUMN "igstAmount" TO "igstAmountMinor";

-- debit_notes
ALTER TABLE "debit_notes"
  ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;

ALTER TABLE "debit_notes" RENAME COLUMN "amount" TO "amountMinor";

-- gstr2b_matches
ALTER TABLE "gstr2b_matches"
  ALTER COLUMN "difference" TYPE BIGINT USING (round("difference" * 100))::BIGINT;

ALTER TABLE "gstr2b_matches"
  ALTER COLUMN "difference" SET DEFAULT 0;

ALTER TABLE "gstr2b_matches" RENAME COLUMN "difference" TO "differenceMinor";
