-- Payout approval (owner ruling 2026-10-13; C-005, round 23b). payments:approve gates money
-- out: a vendor bill payment, a manual or asset cash-out, a recurring out-rule's approval,
-- and a reversal of an inward row. The request is written here; the Transaction is written
-- only when a second person approves it (domains/payouts.ts).
--
-- Prisma part first, then the hand-written invariants, in the duty_assignments style.

-- CreateTable
CREATE TABLE "payout_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "direction" TEXT NOT NULL DEFAULT 'out',
    "txnDate" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "division" TEXT,
    "counterparty" TEXT,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "vendorBillId" TEXT,
    "fixedAssetId" TEXT,
    "recurringRuleId" TEXT,
    "reversesTransactionId" TEXT,
    "intercompanyTenantId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "transactionId" TEXT,
    "founderWaived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_requests_tenantId_recordCode_key" ON "payout_requests"("tenantId", "recordCode");

-- CreateIndex
CREATE INDEX "payout_requests_tenantId_state_idx" ON "payout_requests"("tenantId", "state");

-- CreateIndex
CREATE INDEX "payout_requests_tenantId_vendorBillId_idx" ON "payout_requests"("tenantId", "vendorBillId");

-- CreateIndex
CREATE INDEX "payout_requests_tenantId_recurringRuleId_state_idx" ON "payout_requests"("tenantId", "recurringRuleId", "state");

-- CreateIndex
CREATE INDEX "payout_requests_tenantId_reversesTransactionId_idx" ON "payout_requests"("tenantId", "reversesTransactionId");

-- ---------------------------------------------------------------------------
-- Hand-written from here down.
-- ---------------------------------------------------------------------------

-- 1. An amount is positive: the direction carries the sign, as it does on transactions.
ALTER TABLE "payout_requests"
  ADD CONSTRAINT "payout_requests_amount_positive"
  CHECK ("amountMinor" > 0);

-- 2. A request is for money out. Money in has no request (owner ruling 2026-10-13).
ALTER TABLE "payout_requests"
  ADD CONSTRAINT "payout_requests_direction_out"
  CHECK ("direction" = 'out');

-- 3. The states and kinds are closed sets; a new one is a migration, not a typo.
ALTER TABLE "payout_requests"
  ADD CONSTRAINT "payout_requests_state_known"
  CHECK ("state" IN ('requested', 'approved', 'declined', 'withdrawn'));
ALTER TABLE "payout_requests"
  ADD CONSTRAINT "payout_requests_kind_known"
  CHECK ("kind" IN ('payment', 'reversal', 'recurring_rule'));

-- 4. Row-level security, as duty_assignments does.
ALTER TABLE "payout_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payout_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payout_requests";
CREATE POLICY "tenant_isolation" ON "payout_requests"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- 5. Grants. The application role creates a request, and changes only its decision
--    columns. The amount, account, bill and direction cannot change after creation, so
--    an approval always approves the figure that was asked for. A request is never
--    removed: a withdrawn or declined one stays as the record.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    GRANT SELECT, INSERT ON "payout_requests" TO "kaizen_app";
    GRANT UPDATE ("state", "decidedById", "decidedAt", "decisionNote", "transactionId", "founderWaived", "updatedAt")
      ON "payout_requests" TO "kaizen_app";
    REVOKE DELETE ON "payout_requests" FROM "kaizen_app";
  END IF;
END
$$;
