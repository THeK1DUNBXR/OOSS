-- 0.6: a tenant's chain has exactly one genesis record.
--
-- `@@unique([tenantId, prevHash])` does not cover the genesis: Postgres treats
-- NULLs as distinct in a unique index, so any number of rows with a NULL
-- predecessor were accepted for one tenant. The append path serialises writers
-- with an advisory lock, so this is a backstop for a write that bypasses it,
-- not the mechanism that normally prevents a second genesis. This index is
-- hand-written because Prisma cannot express a partial unique index.
CREATE UNIQUE INDEX "event_records_tenantId_genesis_key" ON "event_records"("tenantId") WHERE "prevHash" IS NULL;
