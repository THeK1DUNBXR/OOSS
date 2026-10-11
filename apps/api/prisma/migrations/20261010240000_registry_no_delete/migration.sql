-- The business-line registry is history (VERTICAL-TAXONOMY s.6; the
-- business-line contract s.5): a line, successor or distribution is closed by
-- its dates, never deleted. The tenant_rls migration grants every privilege on
-- every table, so this revoke must sort after it to hold.
--
-- Immutable keys are refused by the trigger in 20261010235800_business_lines,
-- which the application role cannot bypass, so UPDATE stays granted for the
-- columns that may change (name, effectiveTo, and the dated fields).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    REVOKE DELETE ON "business_lines", "business_line_successors", "line_distributions", "line_distribution_lines" FROM "kaizen_app";
  END IF;
END
$$;
