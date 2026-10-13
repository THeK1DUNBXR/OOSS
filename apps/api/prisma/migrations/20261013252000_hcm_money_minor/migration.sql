-- HCM compensation and learning money columns to bigint paise (ORDERED-PLAN 1.6, the
-- HCM slice that 20261013226000_hcm_money_minor and 20261013232000_payroll_money_minor
-- both left for later: "compensation_records and learning_activities ... are read by
-- the HCM compensation and import paths as well as payroll").
--
-- Three Decimal money columns become paise in place, each renamed to the `<name>Minor`
-- convention the other paise columns follow:
--
--   compensation_records.amount      -> amountMinor      (NOT NULL, as before)
--   compensation_records.basicPay    -> basicPayMinor    (nullable, as before)
--   learning_activities.cost         -> costMinor        (NOT NULL, default 0 kept as paise)
--
-- The figures are the same paise the Decimal held: each stored value is already exact to
-- two places, so the USING clause changes no figure.
--
-- Checked, not assumed: no CHECK constraint, view, trigger or function in the migration
-- history names these columns. The indexes on compensation_records cover
-- (tenantId, employmentRelationshipId, status) and (tenantId, voidBatchId), and the index
-- on learning_activities covers tenantId, so the type change is not blocked by a
-- dependent object.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only be
-- there if the column drifted to an unconstrained type or a restore brought one in.
-- Rounding it here would hide exactly that, so the migration stops instead.

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
    IF EXISTS (SELECT 1 FROM "compensation_records" WHERE "amount" <> round("amount", 2) OR "basicPay" <> round("basicPay", 2))
       OR EXISTS (SELECT 1 FROM "learning_activities" WHERE "cost" <> round("cost", 2))
    THEN
      RAISE EXCEPTION 'A compensation or learning money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- compensation_records
ALTER TABLE "compensation_records" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "compensation_records" RENAME COLUMN "amount" TO "amountMinor";
ALTER TABLE "compensation_records" ALTER COLUMN "basicPay" TYPE BIGINT USING (round("basicPay" * 100))::BIGINT;
ALTER TABLE "compensation_records" RENAME COLUMN "basicPay" TO "basicPayMinor";

-- learning_activities (a default of 0 is kept, as paise)
ALTER TABLE "learning_activities" ALTER COLUMN "cost" DROP DEFAULT;
ALTER TABLE "learning_activities" ALTER COLUMN "cost" TYPE BIGINT USING (round("cost" * 100))::BIGINT;
ALTER TABLE "learning_activities" ALTER COLUMN "cost" SET DEFAULT 0;
ALTER TABLE "learning_activities" RENAME COLUMN "cost" TO "costMinor";
