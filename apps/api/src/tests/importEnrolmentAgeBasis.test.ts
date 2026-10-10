/**
 * The student register import applies the same age rule as a typed enrolment
 * (FX-64): a learner with no date of birth and no guardian is a row error,
 * unless the row carries an explicit adult attestation. The refusal happens
 * before the row's course or batch is written, so a refused row leaves nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { stageImport } from '../imports/service.js';
import { commitImport } from '../imports/commit.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const HEADER = [
  'NAME', 'REGISTRATION NUMBER', 'CONTACT', 'MAIL-ID', 'COURSE', 'ACTUAL FEES', 'Excluding GST', 'GST',
  'Discount of Rs', 'DISCOUNT', 'Including GST', 'REGISTRATION DATE', 'COURSE START DATE', 'COURSE END DATE',
  'IST INSTALLMENT', 'DATE', 'Receipt NUMBER', '2ND INSTALLMENT', 'DATE', 'Receipt NUMBER',
  '3RD  INSTALLMENT', 'DATE', 'Receipt NUMBER',
];

function row(name: string, reg: string, phone: string, course: string): string[] {
  return [
    name, reg, phone, '', course, '24000', '15000', '2700', '6300', '26.25%', '17700', '7/8/26', '7/8/26', '9/9/26',
    '10000', '7/8/26', `KIPL/AGE/${reg}`, '', '', '', '', '', '',
  ];
}

async function stageAndCommit(tag: string, attestation: 'absent' | 'Yes' | 'No') {
  const XLSX = await import('xlsx');
  const course = `Age Rule Course ${tag}`;
  const rows = [
    row('Age Rule Learner One', `KI-AGE/${tag}/1`, `96${tag.slice(-8)}`, course),
    row('Age Rule Learner Two', `KI-AGE/${tag}/2`, `95${tag.slice(-8)}`, course),
  ];
  const withAttest =
    attestation === 'absent'
      ? [[...HEADER], ...rows]
      : [[...HEADER, 'Adult (18 or over)'], ...rows.map((r) => [...r, attestation])];
  const sheet = XLSX.utils.aoa_to_sheet(withAttest);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
  const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer);
  const staged = await stageImport({ fileName: `age-${tag}.xlsx`, buffer });
  expect(staged.kind).toBe('student_register');
  return { course, result: await commitImport(staged.batchId) };
}

describe('FX-64: a register row with no date of birth and no guardian is a row error unless attested', () => {
  it('refuses both rows with a clear message, and writes no course, batch or enrolment for them', async () => {
    const tag = `${Date.now()}`;
    await asUser(CHAIRMAN, async () => {
      const { course, result } = await stageAndCommit(tag, 'absent');
      expect(result.created.enrollment ?? 0).toBe(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].message).toMatch(/no date of birth and no guardian/i);
      expect(result.errors[0].message).toMatch(/Adult \(18 or over\)/);
      expect(await prisma.course.count({ where: { tenantId: TENANT, name: course } })).toBe(0);
      expect(await unscopedPrisma.enrollment.count({ where: { tenantId: TENANT, legacyReference: `KI-AGE/${tag}/1` } })).toBe(0);
    });
  });

  it('a row whose attestation column says No is refused the same way', async () => {
    const tag = `${Date.now() + 1}`;
    await asUser(CHAIRMAN, async () => {
      const { result } = await stageAndCommit(tag, 'No');
      expect(result.created.enrollment ?? 0).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toMatch(/no date of birth and no guardian/i);
    });
  });

  it('a row attested Yes is enrolled, and the attestation is recorded on the enrolment audit row', async () => {
    const tag = `${Date.now() + 2}`;
    await asUser(CHAIRMAN, async () => {
      const { result } = await stageAndCommit(tag, 'Yes');
      expect(result.errors).toEqual([]);
      expect(result.created.enrollment).toBe(2);
      const enrolments = await unscopedPrisma.enrollment.findMany({
        where: { tenantId: TENANT, legacyReference: { startsWith: `KI-AGE/${tag}/` } },
      });
      expect(enrolments).toHaveLength(2);
      const audit = await unscopedPrisma.auditRecord.findFirst({
        where: { tenantId: TENANT, subjectType: 'enrollment', subjectId: enrolments[0].id, action: 'create' },
      });
      expect(audit?.meta).toMatchObject({ adultAttestedBy: expect.any(String) });
    });
  });
});

describe('FX-64: the students template follows the same rule', () => {
  async function templateCommit(tag: string, attestation: string) {
    const XLSX = await import('xlsx');
    const { TEMPLATES, buildTemplateWorkbook } = await import('../imports/templates.js');
    const { nextRecordCode } = await import('../platform/recordCode.js');
    const batch = `Template Batch ${tag}`;
    await asUser(CHAIRMAN, async () => {
      const course = await prisma.course.create({
        data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `Template Course ${tag}`, code: `TC${tag}`.slice(0, 16) },
      });
      await prisma.cohort.create({
        data: { tenantId: TENANT, recordCode: await nextRecordCode('COH'), courseId: course.id, name: batch, startDate: new Date(), capacity: 30 },
      });
    });
    const book = XLSX.read(buildTemplateWorkbook(TEMPLATES.students), { type: 'buffer' });
    // No date of birth and no guardian: only the attestation column can release the rule.
    XLSX.utils.sheet_add_aoa(
      book.Sheets.Data,
      [[`Template Learner ${tag}`, `94${tag.slice(-8)}`, '', batch, '', '', attestation, '', '']],
      { origin: 'A2' },
    );
    book.Sheets.Data['!ref'] = 'A1:I2';
    const staged = await asUser(CHAIRMAN, () =>
      stageImport({ fileName: `template-${tag}.xlsx`, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer }),
    );
    expect(staged.kind).toBe('template_students');
    return { name: `Template Learner ${tag}`, result: await asUser(CHAIRMAN, () => commitImport(staged.batchId)) };
  }

  it('a row with no date of birth, no guardian and no attestation is a row error, and no person is created', async () => {
    const { name, result } = await templateCommit(`${Date.now()}`, 'No');
    expect(result.created.enrollment ?? 0).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/no date of birth and no guardian/i);
    expect(await unscopedPrisma.person.count({ where: { tenantId: TENANT, fullName: name } })).toBe(0);
  });

  it('the same row attested Yes is enrolled', async () => {
    const { result } = await templateCommit(`${Date.now() + 3}`, 'Yes');
    expect(result.errors).toEqual([]);
    expect(result.created.enrollment).toBe(1);
  });
});
