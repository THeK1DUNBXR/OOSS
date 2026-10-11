-- A recovered sign-in must change its one-time password before anything else
-- works (Wave 6, account recovery; lib/http.ts enforces it per request).
--
-- `principals` holds one row per email across every entity, so it is exempt
-- from tenant scoping and carries no tenantId: platform/db.ts TENANT_EXEMPT_MODELS
-- lists `Principal`, and migration 20261010235900_tenant_rls names principals as
-- one of the cross-tenant tables it leaves without a policy. The statement below
-- is DDL only, so no tenant loop is needed.
--
-- NOT NULL with a default of false, so every existing row is a sign-in that
-- has no pending recovery. Nothing is backfilled.

-- AlterTable
ALTER TABLE "principals" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
