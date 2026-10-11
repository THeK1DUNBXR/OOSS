-- The typed task source (Wave 6, OP:118; SPINE-CONTRACT 1.4; OPUS decision 6).
--
-- A task named its source with relatedType and relatedId, two strings nothing
-- checked. This adds sourceKind (a closed list, TASK_SOURCE_KINDS in
-- packages/shared/src/tasks.ts) and sourceId. relatedType and relatedId stay: the
-- legacy pair is what interactions wrote, and dropping it would lose the link
-- for every row the backfill below does not map.
--
-- No foreign key on sourceId. Its target table depends on the kind, and a
-- polymorphic FK cannot be expressed in Postgres. The domain checks existence at
-- the write boundary, and the backfill checks it here.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "sourceId" TEXT;

-- ---------------------------------------------------------------------------
-- Hand-written from here down.
-- ---------------------------------------------------------------------------

-- 1. The kind is closed. A new kind is a migration, because the registry and this
--    list must change together. The test in taskSource.test.ts compares the two.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_source_kind_known"
  CHECK ("sourceKind" IN ('commitment', 'case', 'decision', 'exception', 'onboarding_task', 'manual'));

-- 2. A typed task names its row. A manual task has none. Without this a typed
--    task could point at nothing and read as a task with no source at all.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_source_id_when_typed"
  CHECK ("sourceKind" = 'manual' OR "sourceId" IS NOT NULL);

-- 3. Backfill. Only the relatedType values that name a registry kind are mapped,
--    and only when the named row exists in the same tenant. Everything else keeps
--    the default, manual, with no sourceId. An interaction's relatedType is the
--    entityType of its first reference (domains/interactions.ts), so 'lead' and
--    'person' rows stay manual: an interaction's next action is a manual task.
--
--    The loop sets the tenant per pass, so the updates see that tenant's rows
--    under the FORCE RLS policy on tasks, whichever role runs the migration. A
--    single unscoped UPDATE would quietly match nothing for a role without
--    BYPASSRLS.
-- BACKFILL:BEGIN
DO $$
DECLARE
  tenant_row RECORD;
BEGIN
  FOR tenant_row IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant_row."id", true);

    UPDATE "tasks" AS task
    SET "sourceKind" = 'commitment', "sourceId" = task."relatedId"
    WHERE task."tenantId" = tenant_row."id"
      AND task."relatedType" = 'commitment'
      AND task."relatedId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "commitments" AS s
                  WHERE s."tenantId" = task."tenantId" AND s."id" = task."relatedId");

    UPDATE "tasks" AS task
    SET "sourceKind" = 'case', "sourceId" = task."relatedId"
    WHERE task."tenantId" = tenant_row."id"
      AND task."relatedType" = 'case'
      AND task."relatedId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "cases" AS s
                  WHERE s."tenantId" = task."tenantId" AND s."id" = task."relatedId");

    UPDATE "tasks" AS task
    SET "sourceKind" = 'decision', "sourceId" = task."relatedId"
    WHERE task."tenantId" = tenant_row."id"
      AND task."relatedType" = 'decision'
      AND task."relatedId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "decisions" AS s
                  WHERE s."tenantId" = task."tenantId" AND s."id" = task."relatedId");

    -- Both spellings are the same kind. ExceptionRecord is the model; the snake
    -- form is what an interaction reference would carry.
    UPDATE "tasks" AS task
    SET "sourceKind" = 'exception', "sourceId" = task."relatedId"
    WHERE task."tenantId" = tenant_row."id"
      AND task."relatedType" IN ('exception', 'exception_record')
      AND task."relatedId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "exception_records" AS s
                  WHERE s."tenantId" = task."tenantId" AND s."id" = task."relatedId");

    UPDATE "tasks" AS task
    SET "sourceKind" = 'onboarding_task', "sourceId" = task."relatedId"
    WHERE task."tenantId" = tenant_row."id"
      AND task."relatedType" = 'onboarding_task'
      AND task."relatedId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "hcm_recruiting_onboarding_tasks" AS s
                  WHERE s."tenantId" = task."tenantId" AND s."id" = task."relatedId");
  END LOOP;
END
$$;
-- BACKFILL:END
