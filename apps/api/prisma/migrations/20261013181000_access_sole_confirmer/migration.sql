-- The founder's sole-confirmer reason (Wave 6, PR11a follow-up; owner answer O7;
-- ACCESS-MODEL-PLAN s.8: "record the overlap with a named compensating reviewer").
--
-- A suggestion is normally confirmed by someone other than the person and the answerer.
-- Where the founder is the only person who can confirm, the founder may confirm what
-- they answered, with a logged reason. The reason lives here, on the assignment, so
-- the record of why the answerer confirmed their own answer is in the same row.
--
-- This is a new migration, not an edit to 20261013180000_access_model: that one has
-- been applied to databases, and an applied migration never changes.

-- AlterTable
ALTER TABLE "access_assignments" ADD COLUMN "soleConfirmerReason" TEXT;

-- The reason is only ever set by a confirmation, and a blank one is not a reason. An
-- assignment that was confirmed and later expired keeps its reason: the history stays.
ALTER TABLE "access_assignments"
  ADD CONSTRAINT "access_assignments_sole_confirmer_check" CHECK (
    "soleConfirmerReason" IS NULL
    OR ("status" IN ('confirmed', 'expired') AND btrim("soleConfirmerReason") <> '')
  );
