-- 0.6: the AuditRecord chain gets a sequence, a fork guard and a genesis guard.
--
-- Ordering by timestamp is ambiguous when rows share a millisecond, and the
-- verifier and the append head both read by timestamp. A sequence column is
-- monotonic by construction, so both read by it from now on.
--
-- Backfill: each hashed row takes its position by walking the chain from its
-- genesis along prevHash, so the sequence follows the links that were actually
-- written, not the clock. Rows the walk cannot reach (unhashed rows, and any
-- row on a fork) come after the chain, in timestamp then id order.
--
-- If a tenant already holds a fork or two genesis rows, the unique indexes
-- below fail the migration. That is intended: it is a chain integrity problem
-- to resolve by hand, not one for the migration to paper over.

ALTER TABLE "audit_records" ADD COLUMN "seq" BIGSERIAL;

-- The backfill rewrites hashed rows, which the append-only trigger refuses.
-- Disabling it here is the one-time exception, run by the owner role inside
-- this migration's transaction; the trigger is re-enabled before the migration
-- ends.
ALTER TABLE "audit_records" DISABLE TRIGGER "audit_record_immutable";

WITH RECURSIVE walk("tenantId", id, hash, depth) AS (
  SELECT "tenantId", id, hash, 1
  FROM "audit_records"
  WHERE hash IS NOT NULL AND "prevHash" IS NULL
  UNION ALL
  SELECT r."tenantId", r.id, r.hash, w.depth + 1
  FROM walk w
  JOIN "audit_records" r ON r."tenantId" = w."tenantId" AND r."prevHash" = w.hash
),
depth_of AS (
  SELECT id, MIN(depth) AS depth FROM walk GROUP BY id
),
ordered AS (
  SELECT a.id,
         ROW_NUMBER() OVER (
           PARTITION BY a."tenantId"
           ORDER BY (d.depth IS NULL), d.depth, a."timestamp", a.id
         ) AS rn
  FROM "audit_records" a
  LEFT JOIN depth_of d ON d.id = a.id
)
UPDATE "audit_records" a SET "seq" = o.rn FROM ordered o WHERE a.id = o.id;

ALTER TABLE "audit_records" ENABLE TRIGGER "audit_record_immutable";

-- New rows take nextval, which must be above every backfilled value.
SELECT setval(pg_get_serial_sequence('audit_records', 'seq'), COALESCE((SELECT MAX("seq") FROM "audit_records"), 0) + 1, false);

-- Prisma can express these two; the genesis index it cannot. It is partial on
-- hash as well as prevHash, because unhashed rows also have a NULL predecessor
-- and any number of them is legitimate.
CREATE UNIQUE INDEX "audit_records_tenantId_seq_key" ON "audit_records"("tenantId", "seq");
CREATE UNIQUE INDEX "audit_records_tenantId_prevHash_key" ON "audit_records"("tenantId", "prevHash");
CREATE UNIQUE INDEX "audit_records_tenantId_genesis_key" ON "audit_records"("tenantId") WHERE "prevHash" IS NULL AND "hash" IS NOT NULL;
