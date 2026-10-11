-- Decision links and the paise money column (Wave 6, SPINE-CONTRACT 1.5; OPUS
-- DECISIONS: a DecisionLink join table; money columns to bigint paise).
--
-- Two changes in one file, because the link table's composite foreign key needs
-- decisions(tenantId, id), and the money conversion is the same table's column.
-- The CREATE TABLE, index and foreign key statements are the shape
-- `prisma migrate diff` produces from the schema; everything below the line of
-- hand-written SQL is an invariant Prisma cannot express, and each must hold for
-- every writer, not only for the domain.

-- CreateIndex: the composite foreign key below needs this unique key on the parent.
CREATE UNIQUE INDEX "decisions_tenantId_id_key" ON "decisions"("tenantId", "id");

-- CreateTable
CREATE TABLE "decision_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "createdByPartyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_links_tenantId_decisionId_linkType_linkId_key" ON "decision_links"("tenantId", "decisionId", "linkType", "linkId");

-- AddForeignKey
ALTER TABLE "decision_links" ADD CONSTRAINT "decision_links_tenantId_decisionId_fkey" FOREIGN KEY ("tenantId", "decisionId") REFERENCES "decisions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Hand-written from here down.
-- ---------------------------------------------------------------------------

-- 1. The link types are closed. The list is DECISION_LINK_TYPES in
--    packages/shared/src/decisionLinks.ts; a new kind is a migration, because
--    the domain's existence check and this list must change together.
ALTER TABLE "decision_links"
  ADD CONSTRAINT "decision_links_link_type_known"
  CHECK ("linkType" IN ('task', 'commitment', 'case', 'exception', 'document', 'subject'));

-- 2. A link names something. An empty id would match no target and would still
--    take the unique slot for that type.
ALTER TABLE "decision_links"
  ADD CONSTRAINT "decision_links_link_id_present"
  CHECK (length("linkId") > 0);

-- 3. The history is append-only. A trigger refuses UPDATE and DELETE for every
--    role, the table owner included, in addition to the REVOKE below for the
--    application role. A link that was wrong stays, and a correction is a new row.
CREATE OR REPLACE FUNCTION "decision_links_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'decision links are append-only; a correction is a new link'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "decision_links_immutable"
  BEFORE UPDATE OR DELETE ON "decision_links"
  FOR EACH ROW EXECUTE FUNCTION "decision_links_immutable"();

-- 4. Row-level security. Written out, as in 20261013120000_case_record, so
--    rlsMigrationOrder.test.ts can read it.
ALTER TABLE "decision_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_links";
CREATE POLICY "tenant_isolation" ON "decision_links"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- 5. The application role inserts and reads, and cannot update or delete. Guarded,
--    as in the case migration: on a fresh database the role is created by
--    tenant_rls, which sorts before this file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    GRANT SELECT, INSERT ON "decision_links" TO "kaizen_app";
    REVOKE UPDATE, DELETE ON "decision_links" FROM "kaizen_app";
  END IF;
END
$$;

-- 6. The money column. The Decimal(18,2) column becomes paise in place, and the
--    name follows the convention of the other paise columns (balanceMinor,
--    amountMinor, remedyAmountMinor).
--
--    The guard reads the stored digits, not the declared type. A numeric(18,2)
--    rounds a third decimal away on insert, so a value that has one can only be
--    there if the column drifted to an unconstrained type or a restore brought
--    one in. Rounding it here would hide exactly that, so the migration stops.
-- GUARD BEGIN
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "decisions"
    WHERE "requiredAuthorityValue" <> round("requiredAuthorityValue", 2)
  ) THEN
    RAISE EXCEPTION 'decisions.requiredAuthorityValue holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
      USING ERRCODE = 'data_exception';
  END IF;
END
$$;
-- GUARD END

ALTER TABLE "decisions"
  ALTER COLUMN "requiredAuthorityValue" TYPE BIGINT
  USING (round("requiredAuthorityValue" * 100))::BIGINT;

ALTER TABLE "decisions"
  RENAME COLUMN "requiredAuthorityValue" TO "requiredAuthorityMinor";
