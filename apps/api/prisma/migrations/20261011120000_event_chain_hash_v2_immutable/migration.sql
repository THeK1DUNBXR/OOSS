-- 0.6: hash version 2 for event records, and an append-only event trail.
--
-- Existing rows get hashVersion 1 from the ADD COLUMN default, which is the
-- algorithm they were written with. Their hashes are not rewritten: history
-- stays as written, and the verifier checks each row by its own version. The
-- column default becomes 2 afterwards, so new rows take the full-body hash
-- unless a writer says otherwise.
ALTER TABLE "event_records" ADD COLUMN "hashVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "event_records" ALTER COLUMN "hashVersion" SET DEFAULT 2;

-- Event records are append-only. No application path updates or deletes one
-- (the outbox writes outbox_events, not event_records), so the trigger refuses
-- both for every role, the table owner included. A tenant cascade delete is
-- refused too, which is intended: the trail is not hard-deleted.
CREATE OR REPLACE FUNCTION "event_record_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event records are immutable';
END;
$$;
CREATE TRIGGER "event_record_immutable"
BEFORE UPDATE OR DELETE ON "event_records"
FOR EACH ROW EXECUTE FUNCTION "event_record_immutable"();
