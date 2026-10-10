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
import { asUser, prisma, withFixtureRole } from './helpers.js';
import { stageImport, importRows } from '../imports/service.js';
import { TEMPLATES, buildTemplateWorkbook } from '../imports/templates.js';

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

  it('committing purges the raw cells, keeps the rows and their status, and audits the purge', async () => {
    const { commitStagedImport } = await import('../imports/service.js');

    await asUser('chairman@kaizen.co.in', async () => {
      const staged = await stageMinorStudent(GUARDIAN_PHONE);
      const before = await prisma.importRow.count({ where: { batchId: staged.batchId } });

      await commitStagedImport(staged.batchId);

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
});
