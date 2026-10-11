-- AlterTable
ALTER TABLE "mkt_webhooks_inbound" ADD COLUMN     "eventId" TEXT;

-- CreateTable
CREATE TABLE "mkt_webhook_endpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordCode" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mkt_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mkt_webhook_endpoints_token_key" ON "mkt_webhook_endpoints"("token");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_webhook_endpoints_tenantId_recordCode_key" ON "mkt_webhook_endpoints"("tenantId", "recordCode");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_webhook_endpoints_tenantId_provider_key" ON "mkt_webhook_endpoints"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_webhooks_inbound_tenantId_provider_eventId_key" ON "mkt_webhooks_inbound"("tenantId", "provider", "eventId");

