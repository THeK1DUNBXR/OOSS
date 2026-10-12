-- Thresholds as typed values (Wave 6, SPINE-CONTRACT 1.10; rule 1 of CLAUDE.md).
--
-- `value` is a Float, so a rupee amount was held as an inexact binary number and
-- compared as one. The column splits by unit: a currency threshold is bigint paise
-- in "valueMinor", and every other unit (hours, days, count, points, seconds) is a
-- whole number in "valueInt". A CHECK holds the split, so no writer can put a
-- money figure in the count column or the reverse.
--
-- The guard refuses rather than rounds. A rupee value with a third decimal, a
-- paise value that is not whole, or a day count with a fraction means the data
-- is wrong, and converting it would hide that.

-- 1. The typed columns. Both are nullable until the backfill has run; the CHECK
--    below is what makes exactly one of them required.
ALTER TABLE "thresholds" ADD COLUMN "valueMinor" BIGINT;
ALTER TABLE "thresholds" ADD COLUMN "valueInt" INTEGER;

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, thresholds shows no rows,
-- so the guard walks the tenants and sets the tenant on each pass. CI's owner is
-- a superuser that bypasses RLS, which is why only a run as the application role
-- shows the difference (thresholdMinor.test.ts).
DO $$
DECLARE
  tenant RECORD;
  fractional_paise BIGINT := 0;
  fractional_days BIGINT := 0;
  out_of_range BIGINT := 0;
  unknown_unit BIGINT := 0;
  counted BIGINT;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);

    SELECT count(*) INTO counted FROM "thresholds"
      WHERE "unit" = 'currency'
        AND ("value"::numeric * 100) <> trunc("value"::numeric * 100);
    fractional_paise := fractional_paise + counted;

    SELECT count(*) INTO counted FROM "thresholds"
      WHERE "unit" <> 'currency' AND "value"::numeric <> trunc("value"::numeric);
    fractional_days := fractional_days + counted;

    SELECT count(*) INTO counted FROM "thresholds"
      WHERE "unit" <> 'currency'
        AND ("value" > 2147483647 OR "value" < -2147483648);
    out_of_range := out_of_range + counted;

    SELECT count(*) INTO counted FROM "thresholds"
      WHERE "unit" NOT IN ('currency', 'hours', 'days', 'count', 'points', 'seconds');
    unknown_unit := unknown_unit + counted;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);

  IF fractional_paise > 0 THEN
    RAISE EXCEPTION '% currency threshold(s) hold a value with fractional paise; this migration will not round them. Correct the value and re-run.', fractional_paise
      USING ERRCODE = 'data_exception';
  END IF;
  IF fractional_days > 0 THEN
    RAISE EXCEPTION '% non-currency threshold(s) hold a value that is not a whole number; this migration will not round them. Correct the value and re-run.', fractional_days
      USING ERRCODE = 'data_exception';
  END IF;
  IF out_of_range > 0 THEN
    RAISE EXCEPTION '% non-currency threshold(s) hold a value outside the 32-bit integer range', out_of_range
      USING ERRCODE = 'data_exception';
  END IF;
  IF unknown_unit > 0 THEN
    RAISE EXCEPTION '% threshold(s) have an unknown unit; the list in this migration and in packages/shared/src/thresholds.ts must change together', unknown_unit
      USING ERRCODE = 'data_exception';
  END IF;
END
$$;
-- GUARD END

-- BACKFILL BEGIN
-- 2. Backfill, under the same tenant walk, so FORCE RLS cannot hide a row.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    UPDATE "thresholds"
      SET "valueMinor" = ("value"::numeric * 100)::BIGINT
      WHERE "unit" = 'currency';
    UPDATE "thresholds"
      SET "valueInt" = "value"::INTEGER
      WHERE "unit" <> 'currency';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- BACKFILL END

-- 3. The split holds for every writer. A row with no unit, or with the wrong
--    column for its unit, is refused. A row whose tenant is not in "tenants" is
--    not reached by the walk above, so it stays NULL in both columns and this
--    CHECK refuses the migration rather than leaving it unconverted.
ALTER TABLE "thresholds"
  ADD CONSTRAINT "thresholds_unit_known"
  CHECK ("unit" IN ('currency', 'hours', 'days', 'count', 'points', 'seconds'));

ALTER TABLE "thresholds"
  ADD CONSTRAINT "thresholds_value_matches_unit"
  CHECK (
    ("unit" = 'currency' AND "valueMinor" IS NOT NULL AND "valueInt" IS NULL)
    OR ("unit" <> 'currency' AND "valueInt" IS NOT NULL AND "valueMinor" IS NULL)
  );

-- 4. The Float column goes last, once every row has its typed value.
ALTER TABLE "thresholds" DROP COLUMN "value";
