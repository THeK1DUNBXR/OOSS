-- Commercial money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S6 part 2).
--
-- Ten Decimal(18,2) money columns become paise in place, each renamed to the
-- `<name>Minor` convention the other paise columns follow:
--
--   authority_grants.ceilingValue                       -> ceilingValueMinor (nullable)
--   approval_steps.requestedValue                       -> requestedValueMinor (nullable)
--   leads.estimatedValue                                -> estimatedValueMinor (nullable)
--   opportunities.expectedValue                         -> expectedValueMinor (nullable)
--   proposals.totalValue                                -> totalValueMinor (nullable)
--   mous.commercialValue                                -> commercialValueMinor (nullable)
--   contracts.commercialValue                           -> commercialValueMinor (NOT NULL)
--   partner_agreements.commercialValue                  -> commercialValueMinor (nullable)
--   win_loss_reviews.commercialValueSnapshot            -> commercialValueSnapshotMinor (nullable)
--   win_loss_reviews.thresholdUsedSnapshot              -> thresholdUsedSnapshotMinor (nullable)
--
-- Not in this migration, on purpose: quotes (subtotal, discountTotal, grandTotal),
-- quote_lines (listUnitPrice, discountAmount, lineTotal) and price_book_entries
-- (unitPrice). Their arithmetic rounds an exact half paisa by float noise, so a
-- stored figure would move by a paisa; that slice is stopped and reported.
--
-- Checked, not assumed: no CHECK constraint, index, view, trigger or function in
-- any migration names these columns (the only money references in the baseline are
-- on invoices and vendor bills), so the type change is not blocked by a dependent
-- object.
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
    IF EXISTS (SELECT 1 FROM "authority_grants" WHERE "ceilingValue" <> round("ceilingValue", 2))
       OR EXISTS (SELECT 1 FROM "approval_steps" WHERE "requestedValue" <> round("requestedValue", 2))
       OR EXISTS (SELECT 1 FROM "leads" WHERE "estimatedValue" <> round("estimatedValue", 2))
       OR EXISTS (SELECT 1 FROM "opportunities" WHERE "expectedValue" <> round("expectedValue", 2))
       OR EXISTS (SELECT 1 FROM "proposals" WHERE "totalValue" <> round("totalValue", 2))
       OR EXISTS (SELECT 1 FROM "mous" WHERE "commercialValue" <> round("commercialValue", 2))
       OR EXISTS (SELECT 1 FROM "contracts" WHERE "commercialValue" <> round("commercialValue", 2))
       OR EXISTS (SELECT 1 FROM "partner_agreements" WHERE "commercialValue" <> round("commercialValue", 2))
       OR EXISTS (SELECT 1 FROM "win_loss_reviews" WHERE "commercialValueSnapshot" <> round("commercialValueSnapshot", 2) OR "thresholdUsedSnapshot" <> round("thresholdUsedSnapshot", 2))
    THEN
      RAISE EXCEPTION 'A commercial money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- authority_grants
ALTER TABLE "authority_grants" ALTER COLUMN "ceilingValue" TYPE BIGINT USING (round("ceilingValue" * 100))::BIGINT;
ALTER TABLE "authority_grants" RENAME COLUMN "ceilingValue" TO "ceilingValueMinor";

-- approval_steps
ALTER TABLE "approval_steps" ALTER COLUMN "requestedValue" TYPE BIGINT USING (round("requestedValue" * 100))::BIGINT;
ALTER TABLE "approval_steps" RENAME COLUMN "requestedValue" TO "requestedValueMinor";

-- leads
ALTER TABLE "leads" ALTER COLUMN "estimatedValue" TYPE BIGINT USING (round("estimatedValue" * 100))::BIGINT;
ALTER TABLE "leads" RENAME COLUMN "estimatedValue" TO "estimatedValueMinor";

-- opportunities
ALTER TABLE "opportunities" ALTER COLUMN "expectedValue" TYPE BIGINT USING (round("expectedValue" * 100))::BIGINT;
ALTER TABLE "opportunities" RENAME COLUMN "expectedValue" TO "expectedValueMinor";

-- proposals
ALTER TABLE "proposals" ALTER COLUMN "totalValue" TYPE BIGINT USING (round("totalValue" * 100))::BIGINT;
ALTER TABLE "proposals" RENAME COLUMN "totalValue" TO "totalValueMinor";

-- mous
ALTER TABLE "mous" ALTER COLUMN "commercialValue" TYPE BIGINT USING (round("commercialValue" * 100))::BIGINT;
ALTER TABLE "mous" RENAME COLUMN "commercialValue" TO "commercialValueMinor";

-- contracts
ALTER TABLE "contracts" ALTER COLUMN "commercialValue" TYPE BIGINT USING (round("commercialValue" * 100))::BIGINT;
ALTER TABLE "contracts" RENAME COLUMN "commercialValue" TO "commercialValueMinor";

-- partner_agreements
ALTER TABLE "partner_agreements" ALTER COLUMN "commercialValue" TYPE BIGINT USING (round("commercialValue" * 100))::BIGINT;
ALTER TABLE "partner_agreements" RENAME COLUMN "commercialValue" TO "commercialValueMinor";

-- win_loss_reviews
ALTER TABLE "win_loss_reviews" ALTER COLUMN "commercialValueSnapshot" TYPE BIGINT USING (round("commercialValueSnapshot" * 100))::BIGINT;
ALTER TABLE "win_loss_reviews" RENAME COLUMN "commercialValueSnapshot" TO "commercialValueSnapshotMinor";
ALTER TABLE "win_loss_reviews" ALTER COLUMN "thresholdUsedSnapshot" TYPE BIGINT USING (round("thresholdUsedSnapshot" * 100))::BIGINT;
ALTER TABLE "win_loss_reviews" RENAME COLUMN "thresholdUsedSnapshot" TO "thresholdUsedSnapshotMinor";
