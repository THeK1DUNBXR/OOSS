-- Job reruns (JOB-IDEMPOTENCY.md rows #18, #19, #23, #24).
--
-- Daily metrics and health scores were bucketed at UTC midnight. CLAUDE.md
-- rule 3 makes the day IST, so every stored bucket moves back 5h30m to the
-- IST midnight that starts the same civil day. The shift is uniform, so the
-- health unique key still holds and no bucket collides with another.
UPDATE "daily_metrics" SET "date" = "date" - INTERVAL '330 minutes';
UPDATE "health_scores" SET "asOf" = "asOf" - INTERVAL '330 minutes';

-- A rerun used to add a metric row each time it raced another rerun. Keep the
-- newest row per (tenant, day, metric). These are metrics, not audit records;
-- the duplicates carry no information the kept row does not.
DELETE FROM "daily_metrics" a
USING "daily_metrics" b
WHERE a."tenantId" = b."tenantId"
  AND a."date" = b."date"
  AND a."metric" = b."metric"
  AND (a."computedAt" < b."computedAt" OR (a."computedAt" = b."computedAt" AND a."id" < b."id"));

DROP INDEX "daily_metrics_tenantId_date_metric_idx";
CREATE UNIQUE INDEX "daily_metrics_tenantId_date_metric_key" ON "daily_metrics"("tenantId", "date", "metric");

-- AlterTable
ALTER TABLE "entity_snapshot_history" ADD COLUMN "contentHash" TEXT;
