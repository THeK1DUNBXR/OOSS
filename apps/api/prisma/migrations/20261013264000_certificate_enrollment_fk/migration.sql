-- Certificate.enrollmentId becomes a foreign key to enrollments.id (FX-80).
--
-- Until now the column was a bare string: a certificate could name an enrolment
-- that did not exist, and the verification page would then have had nothing to
-- check it against. ON DELETE RESTRICT, not CASCADE: an issued certificate is a
-- record, and deleting the enrolment behind it must be refused, not take the
-- certificate with it.
--
-- GUARD BEGIN
-- Nothing is deleted or rewritten here. If any certificate already names an
-- enrolment that is not there, the migration stops and says which tenant holds
-- it, so the row can be dealt with by hand. A bare ADD CONSTRAINT would fail too,
-- but with no tenant in the message.
--
-- Both tables are under FORCE RLS (20261010235900_tenant_rls), and this runs as
-- the table owner, so a read with no tenant set sees no rows and the guard would
-- pass vacuously. It walks the tenants and sets the tenant on each pass, as the
-- pipeline money guard does.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF EXISTS (
      SELECT 1
        FROM "compliance_certificates" c
       WHERE NOT EXISTS (SELECT 1 FROM "enrollments" e WHERE e."id" = c."enrollmentId")
    ) THEN
      RAISE EXCEPTION 'Tenant % has a certificate whose enrollmentId names no enrolment. This migration will not delete or re-point it. Correct or revoke the certificate and re-run.', tenant."id"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

ALTER TABLE "compliance_certificates" ADD CONSTRAINT "compliance_certificates_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
