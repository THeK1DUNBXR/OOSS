-- One open exception per (tenant, subject, code). Before this, raiseException
-- was a findFirst followed by a create, so two overlapping job runs could each
-- insert one: duplicate open rows and a second owner notification each.
--
-- Step 1 closes duplicates that already exist. Nothing is deleted: this is an
-- audit-path table. In each group the earliest-raised open row is kept and each
-- later one is closed as resolved, with a note naming the kept row appended to
-- any note it already had (an acknowledgement note is not overwritten).
-- resolvedById stays NULL: no person closed these, and the note says so.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "subjectType", "subjectId", "code"
      ORDER BY "raisedAt" ASC, "id" ASC
    ) AS rn,
    FIRST_VALUE("id") OVER (
      PARTITION BY "tenantId", "subjectType", "subjectId", "code"
      ORDER BY "raisedAt" ASC, "id" ASC
    ) AS keeper_id
  FROM "exception_records"
  WHERE "state" IN ('open', 'acknowledged', 'escalated')
)
UPDATE "exception_records" AS e
SET
  "state" = 'resolved',
  "resolvedAt" = now(),
  "resolutionNote" = COALESCE(e."resolutionNote" || ' ', '')
    || 'Closed by migration 20261011120000 as a duplicate open exception; kept row ' || r.keeper_id || '.',
  "updatedAt" = now()
FROM ranked AS r
WHERE e."id" = r."id" AND r.rn > 1;

-- Step 2: the natural key. The predicate must match OPEN_STATES in
-- apps/api/src/platform/exceptions.ts. A resolved row releases the key, so the
-- same problem can be raised again after it was closed.
CREATE UNIQUE INDEX "exception_records_open_natural_key"
  ON "exception_records" ("tenantId", "subjectType", "subjectId", "code")
  WHERE "state" IN ('open', 'acknowledged', 'escalated');
