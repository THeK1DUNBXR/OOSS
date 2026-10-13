-- FX-24 (D-16): consumer idempotency and the EventRecord / AuditRecord cross-anchor.
--
-- 1. event_consumer_receipts: one row per (tenant, subscriber, event) once the
--    subscriber has returned without error. The outbox dispatcher checks it before
--    calling a subscriber, so a redelivery (a crash between the subscriber's effect
--    and the outbox settle, or a replayed dead letter) does not act twice.
--
-- 2. event_records.auditRecordId: the AuditRecord written for the same governed
--    write. It is a plain column, outside the chain hash, so no existing row's hash
--    changes. The verifier (verifyEventAuditAnchors) checks it against audit_records.
--
-- The Prisma DDL is written by hand to match the schema (CI's drift check confirms it); everything
-- below it is hand-written: row-level security and grants.

-- Prisma DDL -----------------------------------------------------------------
-- CreateTable
CREATE TABLE "event_consumer_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consumerKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_consumer_receipts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "event_records" ADD COLUMN "auditRecordId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "event_consumer_receipts_tenantId_consumerKey_eventId_key" ON "event_consumer_receipts"("tenantId", "consumerKey", "eventId");

-- CreateIndex
CREATE INDEX "event_records_tenantId_auditRecordId_idx" ON "event_records"("tenantId", "auditRecordId");

-- Hand-written ----------------------------------------------------------------

-- Row-level security (same policy as 20261010235900_tenant_rls; FORCE binds the owner too).
ALTER TABLE "event_consumer_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_consumer_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "event_consumer_receipts";
CREATE POLICY "tenant_isolation" ON "event_consumer_receipts"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- A receipt is kept. The application may record one and read it back; it may not
-- change or remove one. A second recording of the same event fails on the unique
-- key, which the dispatcher treats as already recorded.
REVOKE ALL ON "event_consumer_receipts" FROM PUBLIC;
REVOKE ALL ON "event_consumer_receipts" FROM "kaizen_app";
GRANT SELECT, INSERT ON "event_consumer_receipts" TO "kaizen_app";
