-- Scheduler hardening (ORDERED-PLAN 0.5).
--
-- `leaseUntil` carried two meanings: the lease while a job ran, and the
-- "do not retry before" gate after a failure. A backoff could then pass for a
-- live lease, and a lease for a backoff. The retry gate now lives in `runAfter`.
--
-- `workerId` joins `attempt` as the fence: a finish or heartbeat writes only
-- while it still names the attempt that holds the claim. The completion write
-- used to match on id alone, so a stale holder could overwrite a newer attempt.

ALTER TABLE "job_claims" ADD COLUMN "workerId" TEXT,
ADD COLUMN "runAfter" TIMESTAMP(3);

-- Failed rows stored their backoff in leaseUntil. Carry it across so a claim
-- that was already waiting does not become retriable early.
UPDATE "job_claims" SET "runAfter" = "leaseUntil" WHERE "status" = 'failed';

-- The takeover scan finds abandoned claims by lease expiry across all tenants.
CREATE INDEX "job_claims_status_leaseUntil_idx" ON "job_claims"("status", "leaseUntil");
