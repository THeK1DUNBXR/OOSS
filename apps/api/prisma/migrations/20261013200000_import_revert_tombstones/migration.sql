-- FX-71a: an import revert tombstones the pay and attendance rows it wrote
-- instead of deleting them (LEDGER-CONSUMERS-CONTRACT section 5.3, decision O6).
--
-- A voided row keeps its id and its figures, so the register of what was paid
-- and what was worked still holds the fact; the four columns say that a batch
-- voided it, who did, and why. Every reader leaves voided rows out. Both tables
-- are tenant tables under FORCE RLS already (20261010235900_tenant_rls), and
-- ADD COLUMN does not change their policies.
--
-- No row is written or changed here, so there is no backfill and no DML under
-- FORCE RLS to run as the owner.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "compensation_records" ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidBatchId" TEXT;

-- AlterTable
ALTER TABLE "work_attendances" ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidBatchId" TEXT;

-- CreateIndex
CREATE INDEX "compensation_records_tenantId_voidBatchId_idx" ON "compensation_records"("tenantId", "voidBatchId");

-- CreateIndex
CREATE INDEX "work_attendances_tenantId_voidBatchId_idx" ON "work_attendances"("tenantId", "voidBatchId");
