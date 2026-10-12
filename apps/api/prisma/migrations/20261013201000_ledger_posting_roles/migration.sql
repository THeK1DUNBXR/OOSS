-- Ledger posting roles (contract FX-70, decision O3; ORDERED-PLAN Wave 5 PR6).
--
-- The table maps a posting role (packages/shared postingRules.ts) to a ledger
-- account for one scope and one IST day. It holds data only: no seed rows, since
-- the account for each role is the finance head's decision (contract A1 to A4).
--
-- The Prisma DDL is what `prisma migrate diff` produced for the model in
-- schema/compliance-books.prisma. Everything below it is hand-written, because
-- Prisma cannot express RLS, grants, triggers or CHECK constraints.

-- Prisma DDL -----------------------------------------------------------------
-- CreateTable
CREATE TABLE "ledger_posting_roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "ledgerAccountId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "setById" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_posting_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_posting_roles_tenantId_role_scopeKey_effectiveFrom_key" ON "ledger_posting_roles"("tenantId", "role", "scopeKey", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "ledger_posting_roles" ADD CONSTRAINT "ledger_posting_roles_tenantId_ledgerAccountId_fkey" FOREIGN KEY ("tenantId", "ledgerAccountId") REFERENCES "ledger_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written ----------------------------------------------------------------

-- A window must end after it starts. An empty or inverted window would never
-- resolve, and the resolver would read it as unmapped rather than as a mistake.
ALTER TABLE "ledger_posting_roles" ADD CONSTRAINT "ledger_posting_roles_effective_window"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- Row-level security (same policy as 20261010235900_tenant_rls; FORCE binds the owner too).
ALTER TABLE "ledger_posting_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_posting_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ledger_posting_roles";
CREATE POLICY "tenant_isolation" ON "ledger_posting_roles"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The default privileges grant every verb on new tables to kaizen_app. A
-- mapping the application can rewrite is a mapping nobody can audit, so the
-- application gets exactly what it needs to read and to add a mapping.
REVOKE ALL ON "ledger_posting_roles" FROM PUBLIC;
REVOKE ALL ON "ledger_posting_roles" FROM "kaizen_app";
GRANT SELECT, INSERT ON "ledger_posting_roles" TO "kaizen_app";

-- Insert-only for every role, the owner included. The privilege revoke above is
-- the application's refusal; this trigger is the same refusal for any role that
-- holds UPDATE or DELETE (a migration, a script, a superuser). A correction is a
-- new row with a later effectiveFrom, never an edit of an old one.
CREATE OR REPLACE FUNCTION "ledger_posting_role_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger posting roles are insert-only: % refused; map the role again with a later effectiveFrom', TG_OP;
END;
$$;
CREATE TRIGGER "ledger_posting_roles_immutable"
BEFORE UPDATE OR DELETE ON "ledger_posting_roles"
FOR EACH ROW EXECUTE FUNCTION "ledger_posting_role_immutable"();
