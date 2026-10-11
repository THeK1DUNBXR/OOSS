-- Bank statement lines are keyed by a fingerprint, so a re-import of the same
-- statement adds nothing (FIXES.md FX-34; domains/compliance/books.ts
-- importBankStatement). The column was never written, and nothing enforced
-- uniqueness, so each re-import doubled the statement.
--
-- Existing rows have no fingerprint (NULL). A unique index admits any number of
-- NULLs, so they stay as they are; a re-import of an old statement adds its
-- lines once, under their keys, and does not touch the rows already there.

-- Prisma DDL -----------------------------------------------------------------
-- AlterTable
ALTER TABLE "cmp_bank_statement_lines" ADD COLUMN     "fingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "cmp_bank_statement_lines_tenantId_accountId_fingerprint_key" ON "cmp_bank_statement_lines"("tenantId", "accountId", "fingerprint");

