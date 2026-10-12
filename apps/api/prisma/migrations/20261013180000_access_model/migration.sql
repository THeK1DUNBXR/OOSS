-- Level-based access, PR11a: the eight tables an assignment is built from (Wave 6;
-- ACCESS-MODEL-PLAN s.2, s.5-s.7; P11-DESIGN a, O1-O5, O8, O15, O17).
--
-- The name sorts after 20261010235900_tenant_rls, so the tenant tables created here
-- are policed by this file itself (rlsMigrationOrder.test.ts checks that). The
-- CREATE TABLE and index statements are what `prisma migrate diff` writes for
-- prisma/schema/access.prisma; everything below the hand-written line is an
-- invariant Prisma cannot express, and each one holds for every writer.
--
-- No DML here: the tables start empty, so the FORCE RLS backfill loop does not apply.
-- A confirmed assignment grants nothing until PR11b compiles it into Grant rows.

-- CreateTable
CREATE TABLE "access_verticals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "businessLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_verticals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_levels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "reach" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_level_limits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "authorityClass" TEXT NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_level_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_capability_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL DEFAULT '',
    "resource" TEXT NOT NULL,
    "verbs" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_capability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_resource_bindings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "bindingKind" TEXT NOT NULL,
    "column" TEXT,
    "verticalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_resource_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "identityType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "suggestedById" TEXT NOT NULL,
    "suggestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "expiredById" TEXT,
    "expiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_placements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "verticalId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_duties" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "dutyCode" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_duties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_verticals_tenantId_code_key" ON "access_verticals"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "access_verticals_tenantId_id_key" ON "access_verticals"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "access_levels_tenantId_code_key" ON "access_levels"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "access_levels_tenantId_rank_key" ON "access_levels"("tenantId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "access_levels_tenantId_id_key" ON "access_levels"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "access_level_limits_tenantId_levelId_authorityClass_key" ON "access_level_limits"("tenantId", "levelId", "authorityClass");

-- CreateIndex
CREATE INDEX "access_capability_rules_tenantId_verticalId_levelId_idx" ON "access_capability_rules"("tenantId", "verticalId", "levelId");

-- CreateIndex
CREATE UNIQUE INDEX "access_capability_rules_tenantId_verticalId_levelId_unitCod_key" ON "access_capability_rules"("tenantId", "verticalId", "levelId", "unitCode", "resource");

-- CreateIndex
CREATE UNIQUE INDEX "access_resource_bindings_tenantId_resource_key" ON "access_resource_bindings"("tenantId", "resource");

-- CreateIndex
CREATE INDEX "access_assignments_tenantId_personId_status_idx" ON "access_assignments"("tenantId", "personId", "status");

-- CreateIndex
CREATE INDEX "access_assignments_tenantId_status_expiresAt_idx" ON "access_assignments"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "access_assignments_tenantId_id_key" ON "access_assignments"("tenantId", "id");

-- CreateIndex
CREATE INDEX "access_placements_tenantId_personId_idx" ON "access_placements"("tenantId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "access_placements_tenantId_assignmentId_verticalId_unitCode_key" ON "access_placements"("tenantId", "assignmentId", "verticalId", "unitCode");

-- CreateIndex
CREATE UNIQUE INDEX "access_duties_tenantId_assignmentId_dutyCode_key" ON "access_duties"("tenantId", "assignmentId", "dutyCode");

-- AddForeignKey
ALTER TABLE "access_level_limits" ADD CONSTRAINT "access_level_limits_tenantId_levelId_fkey" FOREIGN KEY ("tenantId", "levelId") REFERENCES "access_levels"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_capability_rules" ADD CONSTRAINT "access_capability_rules_tenantId_verticalId_fkey" FOREIGN KEY ("tenantId", "verticalId") REFERENCES "access_verticals"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_capability_rules" ADD CONSTRAINT "access_capability_rules_tenantId_levelId_fkey" FOREIGN KEY ("tenantId", "levelId") REFERENCES "access_levels"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_resource_bindings" ADD CONSTRAINT "access_resource_bindings_tenantId_verticalId_fkey" FOREIGN KEY ("tenantId", "verticalId") REFERENCES "access_verticals"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_placements" ADD CONSTRAINT "access_placements_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "access_assignments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_placements" ADD CONSTRAINT "access_placements_tenantId_verticalId_fkey" FOREIGN KEY ("tenantId", "verticalId") REFERENCES "access_verticals"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_placements" ADD CONSTRAINT "access_placements_tenantId_levelId_fkey" FOREIGN KEY ("tenantId", "levelId") REFERENCES "access_levels"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "access_duties" ADD CONSTRAINT "access_duties_tenantId_assignmentId_fkey" FOREIGN KEY ("tenantId", "assignmentId") REFERENCES "access_assignments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express.
-- ---------------------------------------------------------------------------

-- The closed lists are the vocabularies in the domain (domains/access/rules.ts) and
-- the verb catalogue in packages/shared (VERBS plus approve and merge).
ALTER TABLE "access_verticals"
  ADD CONSTRAINT "access_verticals_kind_check" CHECK ("kind" IN ('business', 'shared')),
  -- A business vertical is one BusinessLine; a shared function has none.
  ADD CONSTRAINT "access_verticals_line_check" CHECK (("kind" = 'business') = ("businessLineId" IS NOT NULL)),
  ADD CONSTRAINT "access_verticals_code_check" CHECK (btrim("code") <> '');

ALTER TABLE "access_levels"
  ADD CONSTRAINT "access_levels_reach_check" CHECK ("reach" IN ('own', 'team', 'unit', 'vertical', 'company')),
  ADD CONSTRAINT "access_levels_rank_check" CHECK ("rank" >= 0);

-- Paise, never negative (CLAUDE.md rule 1).
ALTER TABLE "access_level_limits"
  ADD CONSTRAINT "access_level_limits_minor_check" CHECK ("limitMinor" >= 0),
  ADD CONSTRAINT "access_level_limits_currency_check" CHECK (btrim("currency") <> '');

ALTER TABLE "access_capability_rules"
  ADD CONSTRAINT "access_capability_rules_verbs_check" CHECK (
    cardinality("verbs") > 0
    AND "verbs" <@ ARRAY['view', 'create', 'edit', 'delete', 'assign', 'export', 'financial', 'approve', 'merge']::text[]
  ),
  ADD CONSTRAINT "access_capability_rules_resource_check" CHECK (btrim("resource") <> '');

ALTER TABLE "access_resource_bindings"
  ADD CONSTRAINT "access_resource_bindings_kind_check" CHECK ("bindingKind" IN ('field', 'fixed', 'derived', 'none')),
  ADD CONSTRAINT "access_resource_bindings_field_check" CHECK ("bindingKind" <> 'field' OR "column" IS NOT NULL),
  ADD CONSTRAINT "access_resource_bindings_fixed_check" CHECK ("bindingKind" <> 'fixed' OR "verticalId" IS NOT NULL);

-- An assignment's status decides which audit fields must be present. A non-employee's
-- expiry is capped at twelve months plus one day of slack here; the domain counts
-- IST days exactly (CLAUDE.md rule 3), so this only catches a writer that skips it.
ALTER TABLE "access_assignments"
  ADD CONSTRAINT "access_assignments_identity_check" CHECK ("identityType" IN ('employee', 'founder', 'non_employee')),
  ADD CONSTRAINT "access_assignments_status_check" CHECK ("status" IN ('suggested', 'confirmed', 'expired')),
  ADD CONSTRAINT "access_assignments_reason_check" CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "access_assignments_confirmed_check" CHECK (
    "status" <> 'confirmed' OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "access_assignments_expired_check" CHECK (
    "status" <> 'expired' OR ("expiredById" IS NOT NULL AND "expiredAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "access_assignments_non_employee_expiry_check" CHECK (
    "identityType" <> 'non_employee'
    OR ("expiresAt" IS NOT NULL AND "expiresAt" <= COALESCE("confirmedAt", "suggestedAt") + interval '12 months 1 day')
  );

ALTER TABLE "access_duties"
  ADD CONSTRAINT "access_duties_code_check" CHECK (btrim("dutyCode") <> '');

-- ---------------------------------------------------------------------------
-- Row-level security on every table, written out so that
-- rlsMigrationOrder.test.ts can read it.
-- ---------------------------------------------------------------------------

ALTER TABLE "access_verticals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_verticals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_verticals";
CREATE POLICY "tenant_isolation" ON "access_verticals"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_levels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_levels";
CREATE POLICY "tenant_isolation" ON "access_levels"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_level_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_level_limits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_level_limits";
CREATE POLICY "tenant_isolation" ON "access_level_limits"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_capability_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_capability_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_capability_rules";
CREATE POLICY "tenant_isolation" ON "access_capability_rules"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_resource_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_resource_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_resource_bindings";
CREATE POLICY "tenant_isolation" ON "access_resource_bindings"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_assignments";
CREATE POLICY "tenant_isolation" ON "access_assignments"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_placements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_placements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_placements";
CREATE POLICY "tenant_isolation" ON "access_placements"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "access_duties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_duties" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "access_duties";
CREATE POLICY "tenant_isolation" ON "access_duties"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The application role reads, adds and corrects these rows. It does not delete: a
-- withdrawn assignment is expired, so its history stays readable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      "access_verticals", "access_levels", "access_level_limits", "access_capability_rules",
      "access_resource_bindings", "access_assignments", "access_placements", "access_duties"
      TO "kaizen_app";
  END IF;
END
$$;
