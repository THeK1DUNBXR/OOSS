-- Document store (Wave 6 PR 2; CAP-DOC-01; SPINE-CONTRACT 1.3 and decision 5).
--
-- Why Document stays one table and gets no DocumentVersion table: a re-upload
-- already writes a new row under the same documentGroupId (schema comment on
-- Document). A second table for versions would hold the same file metadata
-- twice and leave two places that could say which version is current. The
-- chain is previousVersionId on the row itself, and the one-head rule is the
-- unique (tenantId, documentGroupId, version) key below.
--
-- The guard refuses to run over existing rows: no writer has ever created one,
-- so a row here was put there outside the application, and a hash cannot be
-- invented for bytes nobody checked. Repair it by hand, then re-run.

DO $$
DECLARE
  existing BIGINT;
BEGIN
  SELECT COUNT(*) INTO existing FROM "documents";
  IF existing > 0 THEN
    RAISE EXCEPTION 'documents has % row(s) and no content hash: record each one''s hash from its bytes, then re-run this migration', existing;
  END IF;
END
$$;

-- Prisma DDL -----------------------------------------------------------------
-- DropIndex
DROP INDEX "documents_tenantId_documentGroupId_version_idx";

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "contentSha256" TEXT NOT NULL,
ADD COLUMN     "lifecycleStatus" TEXT NOT NULL DEFAULT 'draft',
ADD COLUMN     "ownerPartyId" TEXT,
ADD COLUMN     "previousVersionId" TEXT,
ADD COLUMN     "retentionClass" TEXT,
ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'upload';

-- CreateIndex
CREATE INDEX "documents_tenantId_ownerPartyId_lifecycleStatus_idx" ON "documents"("tenantId", "ownerPartyId", "lifecycleStatus");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenantId_id_key" ON "documents"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenantId_documentGroupId_version_key" ON "documents"("tenantId", "documentGroupId", "version");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_previousVersionId_fkey" FOREIGN KEY ("tenantId", "previousVersionId") REFERENCES "documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written from here down. Prisma cannot model these, and each is an
-- invariant every writer must meet, not only domains/documents.ts.
-- ---------------------------------------------------------------------------

-- 1. The enumerations are checked by the database too. The writer's table is
--    the rule; these refuse a raw write that names a status it does not know.
ALTER TABLE "documents" ADD CONSTRAINT "documents_lifecycleStatus_check"
  CHECK ("lifecycleStatus" IN ('draft', 'active', 'superseded', 'archived'));
ALTER TABLE "documents" ADD CONSTRAINT "documents_sourceType_check"
  CHECK ("sourceType" IN ('upload', 'import', 'generated'));
-- A SHA-256 is 64 lowercase hex characters. Anything else is not a hash of anything.
ALTER TABLE "documents" ADD CONSTRAINT "documents_contentSha256_check"
  CHECK ("contentSha256" ~ '^[0-9a-f]{64}$');

-- 2. One active version per group. Two active versions would answer "which
--    document is in force" twice; activating a successor supersedes the prior
--    one in the same transaction, and this index is what makes a missed step a
--    refused write instead of a silent second head.
CREATE UNIQUE INDEX "documents_one_active_per_group"
  ON "documents" ("tenantId", "documentGroupId")
  WHERE "lifecycleStatus" = 'active';

-- 3. A recorded version's identity and content cannot change, for any role.
--    The hash is a claim about the bytes at storageKey; if either could be
--    edited afterwards, the claim would say nothing. Lifecycle and retention
--    are not in the list: they are the state of a version, not its content.
--    Ownership is in the list because changing it needs its own audited writer,
--    which this PR does not add.
CREATE OR REPLACE FUNCTION "documents_content_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."tenantId", NEW."recordCode", NEW."filename", NEW."storageKey", NEW."mimeType", NEW."size",
      NEW."contentSha256", NEW."attachedToType", NEW."attachedToId", NEW."version", NEW."documentGroupId",
      NEW."previousVersionId", NEW."ownerPartyId", NEW."sourceType")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."recordCode", OLD."filename", OLD."storageKey", OLD."mimeType", OLD."size",
      OLD."contentSha256", OLD."attachedToType", OLD."attachedToId", OLD."version", OLD."documentGroupId",
      OLD."previousVersionId", OLD."ownerPartyId", OLD."sourceType")
  THEN
    RAISE EXCEPTION 'document content and identity are immutable: this UPDATE is refused; record a new version instead';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "documents_content_immutable"
BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_content_immutable"();

-- 4. No delete, for any role. The application role has no DELETE privilege at
--    all (the REVOKE below is its refusal); the trigger binds the table owner,
--    which the privilege does not. A document that should go away is archived,
--    and the archive is what the record of the business says happened.
CREATE OR REPLACE FUNCTION "documents_never_deleted"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'documents are never deleted: archive the document instead';
END;
$$;
CREATE TRIGGER "documents_never_deleted"
BEFORE DELETE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_never_deleted"();

REVOKE DELETE ON "documents" FROM "kaizen_app";
