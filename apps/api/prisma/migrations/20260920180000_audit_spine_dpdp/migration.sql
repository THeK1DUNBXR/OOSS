-- Phase 2 audit spine and DPDP evidence.

ALTER TABLE "audit_records"
  ADD COLUMN "retentionClass" TEXT NOT NULL DEFAULT 'audit_record';

ALTER TABLE "consents"
  ADD COLUMN "noticeVersion" INTEGER;

CREATE TABLE "consent_ledger" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "dataPrincipalId" TEXT NOT NULL,
  "consentId" TEXT,
  "purpose" TEXT NOT NULL,
  "noticeVersion" INTEGER,
  "channel" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "givenAt" TIMESTAMP(3),
  "withdrawnAt" TIMESTAMP(3),
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consent_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_ledger_tenantId_dataPrincipalId_purpose_createdAt_idx"
  ON "consent_ledger" ("tenantId", "dataPrincipalId", "purpose", "createdAt");
CREATE INDEX "consent_ledger_tenantId_consentId_createdAt_idx"
  ON "consent_ledger" ("tenantId", "consentId", "createdAt");

-- Audit evidence is append-only. The only permitted update is the one-time
-- null-hash backfill used when an older tenant is brought onto the chain.
REVOKE UPDATE, DELETE ON "audit_records" FROM PUBLIC;
CREATE OR REPLACE FUNCTION "audit_record_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit records are append-only';
  END IF;
  IF OLD."hash" IS NULL
     AND NEW."hash" IS NOT NULL
     AND NEW."tenantId" = OLD."tenantId"
     AND NEW."action" = OLD."action"
     AND NEW."subjectType" = OLD."subjectType"
     AND NEW."subjectId" = OLD."subjectId"
     AND NEW."timestamp" = OLD."timestamp"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit records are immutable';
END;
$$;
CREATE TRIGGER "audit_record_immutable"
BEFORE UPDATE OR DELETE ON "audit_records"
FOR EACH ROW EXECUTE FUNCTION "audit_record_immutable"();

REVOKE UPDATE, DELETE ON "consent_ledger" FROM PUBLIC;
CREATE OR REPLACE FUNCTION "consent_ledger_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent ledger is append-only';
END;
$$;
CREATE TRIGGER "consent_ledger_immutable"
BEFORE UPDATE OR DELETE ON "consent_ledger"
FOR EACH ROW EXECUTE FUNCTION "consent_ledger_immutable"();
