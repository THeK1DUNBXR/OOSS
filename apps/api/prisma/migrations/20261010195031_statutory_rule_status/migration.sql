-- CreateEnum
CREATE TYPE "StatutoryRuleStatus" AS ENUM ('DRAFT', 'APPROVED', 'HOLD');

-- AlterTable
ALTER TABLE "statutory_rules" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "status" "StatutoryRuleStatus" NOT NULL DEFAULT 'DRAFT';

-- Hand-written from here down. Prisma cannot model EXCLUDE constraints, and the
-- rules below are statutory invariants that must hold for every writer, not
-- only for the domain function that checks them today.

-- btree_gist lets a GiST exclusion constraint compare plain equality columns
-- (text, tenant, key) alongside a range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Two rules for the same (tenant or platform pack, jurisdiction, key) may not
-- share a day. The range is half-open, so a rule ending on 1 June and one
-- starting on 1 June are adjacent and both allowed. A NULL effectiveTo is an
-- open-ended range. COALESCE folds a platform row (tenantId NULL) into one
-- group, because NULLs never compare equal and would otherwise let platform
-- rows overlap silently.
ALTER TABLE "statutory_rules"
  ADD CONSTRAINT "statutory_rules_no_overlap"
  EXCLUDE USING gist (
    (COALESCE("tenantId", '')) WITH =,
    "jurisdiction" WITH =,
    "key" WITH =,
    daterange("effectiveFrom", "effectiveTo", '[)') WITH &&
  );

-- A rule with no citation cannot be resolved into a calculation. Blank and
-- whitespace-only sources are refused too.
ALTER TABLE "statutory_rules"
  ADD CONSTRAINT "statutory_rules_source_cited"
  CHECK (length(btrim("source")) > 0);

-- An empty or inverted range is never a valid rule.
ALTER TABLE "statutory_rules"
  ADD CONSTRAINT "statutory_rules_range_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- An approver and an approval time exist exactly when the row is APPROVED.
-- Anything else would let a DRAFT or HOLD row look reviewed.
ALTER TABLE "statutory_rules"
  ADD CONSTRAINT "statutory_rules_approval_consistent"
  CHECK (
    ("status" = 'APPROVED' AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL)
    OR
    ("status" <> 'APPROVED' AND "approvedBy" IS NULL AND "approvedAt" IS NULL)
  );
