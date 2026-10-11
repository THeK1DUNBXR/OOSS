-- The author of a rule, so approval can refuse the author (maker-checker).
ALTER TABLE "statutory_rules" ADD COLUMN "createdBy" TEXT;

-- Overlap is checked among APPROVED rows only. Before, every status was in the
-- exclusion, so a DRAFT for next year could not be staged while this year's
-- open-ended rule was APPROVED, even though a DRAFT never resolves.
--
-- domain is in the key. Two domains may legitimately carry the same key and
-- jurisdiction; without the column they collide and the second row is refused
-- for a conflict it does not have.
--
-- Dropped and recreated rather than altered: Postgres cannot change an
-- exclusion constraint's columns or predicate in place.
ALTER TABLE "statutory_rules" DROP CONSTRAINT "statutory_rules_no_overlap";

ALTER TABLE "statutory_rules"
  ADD CONSTRAINT "statutory_rules_no_overlap"
  EXCLUDE USING gist (
    (COALESCE("tenantId", '')) WITH =,
    "domain" WITH =,
    "jurisdiction" WITH =,
    "key" WITH =,
    daterange("effectiveFrom", "effectiveTo", '[)') WITH &&
  )
  WHERE ("status" = 'APPROVED');
