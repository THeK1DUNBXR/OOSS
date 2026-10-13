/**
 * Audit coverage for the platform and import writes that had no audit row (FX-22 ratchet,
 * CLAUDE.md rule 5). One representative write per area, each asserting that the write left
 * an AuditRecord for the subject it changed: an import commit, a grant sync, a tenant policy
 * change and an identity merge. Real database, real domain functions, no mocks.
 *
 * Each test makes its own records: its own tenant where the function works per tenant, and
 * its own people, file and course otherwise, so no test depends on the shared demo rows.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '../platform/context.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { syncTenantPolicy } from '../platform/tenantPolicy.js';
import { findOrCreatePerson, mergePersons } from '../domains/identity.js';
import { stageImport } from '../imports/service.js';
import { commitImport } from '../imports/commit.js';
import { asUser, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

/** A tenant of its own, so per-tenant functions write only rows this test made. */
async function isolatedTenant(tag: string): Promise<string> {
  const t = await unscopedPrisma.tenant.create({
    data: { name: `Audit coverage ${tag}`, slug: `audit-cov-${tag}`.toLowerCase() },
    select: { id: true },
  });
  return t.id;
}

describe('grant sync audits each grant it adds', () => {
  it('one permission_change audit row exists for every grant addMissingGrants created', async () => {
    const tag = `${Date.now()}`;
    const tid = await isolatedTenant(`grant-${tag}`);
    await unscopedPrisma.accessRole.create({ data: { tenantId: tid, slug: 'employee', name: 'Employee' } });

    const added = await addMissingGrants(tid);
    expect(added.length).toBeGreaterThan(0);

    const audits = await unscopedPrisma.auditRecord.count({
      where: { tenantId: tid, subjectType: 'grant', action: 'permission_change' },
    });
    expect(audits).toBe(added.length);
  });
});

describe('tenant policy sync audits the policy change', () => {
  it('one update audit row exists for the tenant whose policy was synced', async () => {
    const tag = `${Date.now()}`;
    const tid = await isolatedTenant(`policy-${tag}`);

    await asSystem(tid, () => syncTenantPolicy(tid, { dataResidency: 'india' }));

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: tid, subjectType: 'tenant', subjectId: tid, action: 'update' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.diff)).toContain('tier');
  });
});

describe('an identity merge audits the merged-away person', () => {
  it('one merge audit row exists for the source person', async () => {
    const tag = `${Date.now()}`;
    await asUser(CHAIRMAN, async (p) => {
      const source = await findOrCreatePerson({
        fullName: `Audit Merge Source ${tag}`,
        primaryPhone: `8${tag.slice(-9)}`,
      });
      const target = await findOrCreatePerson({
        fullName: `Audit Merge Target ${tag}`,
        primaryPhone: `7${tag.slice(-9)}`,
      });

      await mergePersons(source.person.id, target.person.id, `Audit coverage ${tag}`);

      const audit = await unscopedPrisma.auditRecord.findFirst({
        where: { tenantId: p.tenantId, subjectType: 'person', subjectId: source.person.id, action: 'merge' },
      });
      expect(audit).not.toBeNull();
    });
  });
});

describe('an import commit audits the batch it committed', () => {
  let HEADER: string[];

  beforeAll(() => {
    HEADER = [
      'NAME',
      'REGISTRATION NUMBER',
      'CONTACT',
      'MAIL-ID',
      'COURSE',
      'ACTUAL FEES',
      'Excluding GST',
      'GST',
      'Discount of Rs',
      'DISCOUNT',
      'Including GST',
      'REGISTRATION DATE',
      'COURSE START DATE',
      'COURSE END DATE',
      'IST INSTALLMENT',
      'DATE',
      'Receipt NUMBER',
      '2ND INSTALLMENT',
      'DATE',
      'Receipt NUMBER',
      '3RD  INSTALLMENT',
      'DATE',
      'Receipt NUMBER',
    ];
  });

  it('one update audit row exists for the batch, recording the committed status', async () => {
    const tag = `${Date.now()}`;
    await asUser(CHAIRMAN, async (p) => {
      const XLSX = await import('xlsx');
      const course = `Audit Coverage Course ${tag}`;
      const learner = (n: number) => [
        `Audit Coverage Learner ${n} ${tag}`,
        `KI-AUD/${tag}/${n}`,
        `9${tag.slice(-9)}`,
        '',
        course,
        '24000',
        '15000',
        '2700',
        '6300',
        '26.25%',
        '17700',
        '7/8/26',
        '7/8/26',
        '9/9/26',
        '10000',
        '7/8/26',
        `KIPL/AUD/${tag}/${n}`,
        '',
        '',
        '',
        '',
        '',
        '',
        'Yes',
      ];
      const sheet = XLSX.utils.aoa_to_sheet([[...HEADER, 'Adult (18 or over)'], learner(1)]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
      const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as ArrayBuffer);

      const staged = await stageImport({ fileName: `audit-coverage-${tag}.xlsx`, buffer });
      await commitImport(staged.batchId);

      // The purge that follows a commit is also an update of the batch, so look for the commit's row
      // among them rather than taking the newest.
      const audits = await unscopedPrisma.auditRecord.findMany({
        where: { tenantId: p.tenantId, subjectType: 'import_batch', subjectId: staged.batchId, action: 'update' },
      });
      expect(audits.some((a) => JSON.stringify(a.diff).includes('committed'))).toBe(true);
    });
  });
});
