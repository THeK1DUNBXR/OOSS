-- Entity snapshot history: a sequence per source, replacing the content-hash key
-- (JOB-IDEMPOTENCY.md rows #18, #19).
--
-- The content-hash key rejected a return to an earlier payload (A -> B -> A
-- lost the third row). The key is now (tenant, source, seq), and the publisher
-- skips only when the payload equals the latest row's payload.
--
-- seq is backfilled in createdAt order per (tenant, source), so the existing
-- history keeps its order and no row is removed.
DROP INDEX "entity_snapshot_history_tenantId_sourceTenantId_contentHash_key";

ALTER TABLE "entity_snapshot_history" ADD COLUMN "seq" INTEGER;

UPDATE "entity_snapshot_history" h
SET "seq" = n.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenantId", "sourceTenantId" ORDER BY "createdAt", "id") AS rn
  FROM "entity_snapshot_history"
) n
WHERE h."id" = n."id";

ALTER TABLE "entity_snapshot_history" ALTER COLUMN "seq" SET NOT NULL;

CREATE UNIQUE INDEX "entity_snapshot_history_tenantId_sourceTenantId_seq_key" ON "entity_snapshot_history"("tenantId", "sourceTenantId", "seq");
