-- GSTR-2B match versions (Wave 5, FX-71c; LEDGER-CONSUMERS-CONTRACT section 5.3).
--
-- A recompute used to delete the period's match rows and write the new set.
-- Now it marks the current rows superseded and writes the new set beside them,
-- so an ITC reading the portal once gave stays provable after a re-import.
--
-- The DDL below is Prisma's own (prisma migrate diff). The REVOKE is hand-written.

-- AlterTable
ALTER TABLE "gstr2b_matches" ADD COLUMN     "importId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "gstr2b_matches_tenantId_period_supersededAt_idx" ON "gstr2b_matches"("tenantId", "period", "supersededAt");

-- The application role may not delete a match row. The default privileges from
-- 20261010235900_tenant_rls grant DELETE on every table, so this table had it.
-- Safe to take away because the only delete on this table was the recompute
-- this change removes (domains/compliance/gst.ts). Tenant wipes use TRUNCATE,
-- which this does not touch, through the owner.
REVOKE DELETE ON "gstr2b_matches" FROM "kaizen_app";
