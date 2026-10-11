-- Account balance snapshots (ORDERED-PLAN Wave 3, item 1.4; archive
-- phase-1-ledger.md section 1.4). A period-end cache that the nightly drift
-- check compares with journal_lines. It is never read as a balance.
--
-- The DDL below is Prisma's own (prisma migrate diff). The tenant RLS, the
-- privilege revoke and the note on tenant composites are hand-written under it.
-- Composite foreign keys with tenantId follow 20261012110000_journal_tenant_fks:
-- a snapshot can only name an account and a period of its own tenant.

-- Prisma DDL -----------------------------------------------------------------
-- CreateTable
CREATE TABLE "account_balance_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "asOf" DATE NOT NULL,
    "balanceMinor" BIGINT NOT NULL,
    "derivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_balance_snapshots_tenantId_accountId_periodId_versi_key" ON "account_balance_snapshots"("tenantId", "accountId", "periodId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "cmp_accounting_periods_tenantId_id_key" ON "cmp_accounting_periods"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_tenantId_id_key" ON "ledger_accounts"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "ledger_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_tenantId_periodId_fkey" FOREIGN KEY ("tenantId", "periodId") REFERENCES "cmp_accounting_periods"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security for the new tenant table (same policy as 20261010235900) ---
ALTER TABLE "account_balance_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_balance_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "account_balance_snapshots";
CREATE POLICY "tenant_isolation" ON "account_balance_snapshots"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Insert-only for the application role -------------------------------------
-- A cache the application can overwrite is a cache nobody can trust. The
-- default privileges grant UPDATE and DELETE to kaizen_app on every new table;
-- this takes them back. The owner keeps them, which is how a test corrupts a
-- row to prove the drift check raises (and does not correct it).
REVOKE UPDATE, DELETE ON "account_balance_snapshots" FROM "kaizen_app";
