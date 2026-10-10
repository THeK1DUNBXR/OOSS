/**
 * A staged import holds the file's cells until somebody commits it, so the
 * regulated ones (a guardian's phone, a PAN, a bank account) must not sit in
 * clear while they wait, must not come back out in clear to a viewer below the
 * regulated ceiling, and must not outlive the commit that used them.
 *
 * Real Postgres, real contexts, no mocks: the assertions read the ImportRow
 * table itself, so a fix that only changed the response shape would fail here.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { asUser, prisma, unscopedPrisma, withFixtureRole } from './helpers.js';
import { stageImport, importRows } from '../imports/service.js';
import { commitImport } from '../imports/commit.js';
import { TEMPLATES, buildTemplateWorkbook, type TemplateSpec } from '../imports/templates.js';
import { readRegulated } from '../domains/compliance/privacy.js';

const GUARDIAN_PHONE = '9876543210';
const GUARDIAN_NAME = 'Lakshmi Guardian';
const MASK = '••••••';

/** Stages a minor student whose guardian contact is the regulated part of the row. */
async function stageMinorStudent(guardianPhone: string) {
  const book = XLSX.read(buildTemplateWorkbook(TEMPLATES.students), { type: 'buffer' });
  const name = `Minor Student ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  XLSX.utils.sheet_add_aoa(
    book.Sheets.Data,
    [[name, '', '', 'FSD — Sept 2026, Madurai', '', 'Yes', GUARDIAN_NAME, guardianPhone]],
    { origin: 'A2' },
  );
  book.Sheets.Data['!ref'] = 'A1:H2';
  return stageImport({
    fileName: 'students.xlsx',
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  });
}

/** Stages rows under a template's own headings, so the file is recognised as that template. */
async function stageRows(spec: TemplateSpec, rows: unknown[][]) {
  const book = XLSX.read(buildTemplateWorkbook(spec), { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(book.Sheets.Data, rows, { origin: 'A2' });
  book.Sheets.Data['!ref'] = `A1:${XLSX.utils.encode_col(spec.columns.length - 1)}${rows.length + 1}`;
  return stageImport({
    fileName: `${spec.slug}.xlsx`,
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  });
}

describe('Staged import rows and regulated cells', () => {
  it('a guardian phone and name are not stored in clear while the import is staged', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const staged = await stageMinorStudent(GUARDIAN_PHONE);
      const rows = await prisma.importRow.findMany({ where: { batchId: staged.batchId } });
      expect(rows.length).toBeGreaterThan(0);

      const stored = JSON.stringify(rows.map((r) => ({ raw: r.raw, normalised: r.normalised })));
      expect(stored).not.toContain(GUARDIAN_PHONE);
      expect(stored).not.toContain(GUARDIAN_NAME);
    });
  });

  it('a caller below the regulated ceiling reads the guardian contact masked, and a regulated caller reads it in full', async () => {
    const staged = await asUser('chairman@kaizen.co.in', () => stageMinorStudent(GUARDIAN_PHONE));

    await withFixtureRole({ slug: 'import_viewer', grants: [{ resource: 'imports', verbs: ['view'] }] }, async () => {
      const rows = await importRows(staged.batchId);
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(GUARDIAN_PHONE);
      expect(serialised).not.toContain(GUARDIAN_NAME);
      expect(rows[0].raw).toMatchObject({ 'Guardian phone': MASK, 'Guardian name': MASK });
    });

    await asUser('chairman@kaizen.co.in', async () => {
      const rows = await importRows(staged.batchId);
      expect(rows[0].raw).toMatchObject({ 'Guardian phone': GUARDIAN_PHONE, 'Guardian name': GUARDIAN_NAME });
    });
  });

  it('committing purges the raw cells when commitImport itself is called, keeps the rows, and audits the purge', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const staged = await stageMinorStudent(GUARDIAN_PHONE);
      const before = await prisma.importRow.count({ where: { batchId: staged.batchId } });

      await commitImport(staged.batchId);

      const rows = await prisma.importRow.findMany({ where: { batchId: staged.batchId } });
      expect(rows).toHaveLength(before);
      expect(rows.every((r) => JSON.stringify(r.raw) === '{}')).toBe(true);
      expect(rows.every((r) => r.status !== 'pending')).toBe(true);

      const audit = await prisma.auditRecord.findFirst({
        where: { subjectType: 'import_batch', subjectId: staged.batchId, action: 'update' },
      });
      expect(audit).not.toBeNull();
    });
  });

  it('a committed guardian phone reaches the enrolment encrypted once, as the original value', async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const courseCode = `FSD${stamp}`;
    const batchName = `Batch ${stamp}`;
    await asUser('chairman@kaizen.co.in', async () => {
      const course = await stageRows(TEMPLATES.courses, [[`Course ${stamp}`, courseCode, '12', '']]);
      expect((await commitImport(course.batchId)).errors).toEqual([]);
      const batch = await stageRows(TEMPLATES.batches, [[courseCode, batchName, '15/09/2026', '', '', '']]);
      expect((await commitImport(batch.batchId)).errors).toEqual([]);

      const staged = await stageRows(TEMPLATES.students, [
        [`Minor ${stamp}`, '', '', batchName, '', 'Yes', GUARDIAN_NAME, GUARDIAN_PHONE],
      ]);
      const result = await commitImport(staged.batchId);
      expect(result.errors).toEqual([]);

      const cohort = await prisma.cohort.findFirst({ where: { name: batchName } });
      const enrollment = await prisma.enrollment.findFirst({ where: { cohortId: cohort!.id } });
      const stored = enrollment!.guardianPhone!;
      expect(stored.match(/enc:v1:/g)?.length).toBe(1);
      expect(readRegulated(stored)).toBe(GUARDIAN_PHONE);
    });
  });

  it('a committed blood group reaches the person as the original value, not as staging ciphertext', async () => {
    const name = `Staff ${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await asUser('chairman@kaizen.co.in', async () => {
      const staged = await stageRows(TEMPLATES.staff, [[name, '', '', 'Software', 'Madurai', '', '', '', '', 'O+']]);
      const result = await commitImport(staged.batchId);
      expect(result.errors).toEqual([]);
      const person = await prisma.person.findFirst({ where: { fullName: name } });
      expect(person?.bloodGroup).toBe('O+');
    });
  });

  it('a read of unmasked staged values writes one read audit per request, and a masked read writes none', async () => {
    const staged = await asUser('chairman@kaizen.co.in', () => stageMinorStudent(GUARDIAN_PHONE));
    const readsAudited = () =>
      prisma.auditRecord.count({ where: { subjectType: 'import_batch', subjectId: staged.batchId, action: 'read' } });

    const before = await asUser('chairman@kaizen.co.in', readsAudited);
    await asUser('chairman@kaizen.co.in', () => importRows(staged.batchId));
    expect(await asUser('chairman@kaizen.co.in', readsAudited)).toBe(before + 1);

    await withFixtureRole({ slug: 'import_viewer_audit', grants: [{ resource: 'imports', verbs: ['view'] }] }, () =>
      importRows(staged.batchId),
    );
    expect(await asUser('chairman@kaizen.co.in', readsAudited)).toBe(before + 1);
  });

  it('a purge that fails after the commit is logged, and the commit stands', async () => {
    // A trigger that refuses the blanking write is the real failure, not a
    // stub: the purge's own transaction is what rolls back.
    const fn = 'kz_test_refuse_purge';
    await asUser('chairman@kaizen.co.in', async () => {
      const staged = await stageMinorStudent(GUARDIAN_PHONE);
      await unscopedPrisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW.raw = '{}'::jsonb THEN RAISE EXCEPTION 'purge refused for test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
      );
      await unscopedPrisma.$executeRawUnsafe(
        `CREATE TRIGGER ${fn} BEFORE UPDATE ON import_rows FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      try {
        // The row's own error (no batch of that name) is not what this test is
        // about. What matters is that the commit returns rather than throwing.
        await commitImport(staged.batchId);

        const batch = await prisma.importBatch.findFirst({ where: { id: staged.batchId } });
        expect(batch?.status).toBe('committed');
        const rows = await prisma.importRow.findMany({ where: { batchId: staged.batchId } });
        expect(rows.some((r) => JSON.stringify(r.raw) !== '{}')).toBe(true);
      } finally {
        await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON import_rows`);
        await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
    });
  });
});
