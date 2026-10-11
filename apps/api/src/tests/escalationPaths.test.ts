/**
 * The non-HTTP paths that set a role on an affiliation. Each one must refuse a
 * role its caller does not cover, and must write nothing for the refused
 * person. The caller holds the verb the path asserts (so the refusal comes from
 * the coverage check, not from assertCan), and the role is one the caller
 * cannot hold.
 */

import { describe, expect, it } from 'vitest';
import { authFor, asPrincipal, expectReject, unscopedPrisma, withFixtureRole } from './helpers.js';

describe('sign-in path — no escalation', () => {
  it('refuses a board-meeting creator naming a director sign-in, and writes no user or affiliation', async () => {
    const { createOrResetSignIn } = await import('../domains/signIns.js');
    await withFixtureRole(
      { slug: 'w1a_signin_caller', grants: [{ resource: 'board_meetings', verbs: ['create'] }] },
      async (caller) => {
        await withFixtureRole({ slug: 'w1a_signin_target', grants: [] }, async (target) => {
          const email = `w1a-signin-${Date.now()}@fixture.test`;

          const err = await expectReject(() =>
            asPrincipal(authFor(caller), () =>
              createOrResetSignIn({ personId: target.partyId, roleSlug: 'director', email }),
            ),
          );
          expect(err.status).toBe(403);

          expect(await unscopedPrisma.user.count({ where: { email } })).toBe(0);
          expect(
            await unscopedPrisma.affiliation.count({ where: { partyId: target.partyId, roleSlug: 'director' } }),
          ).toBe(0);
        });
      },
    );
  });
});

describe('import path — no escalation', () => {
  it('refuses an importer who does not cover the employee role, and writes no person or affiliation for the row', async () => {
    const { stageImport } = await import('../imports/service.js');
    const { commitImport } = await import('../imports/commit.js');
    const XLSX = await import('xlsx');
    const { TEMPLATES, buildTemplateWorkbook } = await import('../imports/templates.js');

    await withFixtureRole(
      {
        slug: 'w1a_import_caller',
        grants: [{ resource: 'imports', verbs: ['view', 'create', 'edit'] }],
      },
      async (importer) => {
        // A random name, because commitEmployeeRow matches people by fuzzy name.
        // A repeated fixed name matches an earlier run's person, who already has
        // an employee affiliation, and the row then takes the update path, which
        // is correctly not an assignment.
        const name = `Zq${Math.random().toString(36).slice(2, 10)}Import`;
        const email = `w1a-import-${Date.now()}@fixture.test`;
        const book = XLSX.read(buildTemplateWorkbook(TEMPLATES.staff!), { type: 'buffer' });
        // Staff template columns, in order: name, code, designation, division,
        // branch, phone, email, date of birth, joining date, blood group.
        XLSX.utils.sheet_add_aoa(book.Sheets.Data!, [[name, '', '', '', 'Chennai', '', email, '', '', '']], {
          origin: 'A2',
        });
        book.Sheets.Data!['!ref'] = 'A1:J2';
        const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

        const result = await asPrincipal(authFor(importer), async () => {
          const staged = await stageImport({ fileName: 'staff.xlsx', buffer });
          expect(staged.kind).toBe('template_staff');
          return commitImport(staged.batchId);
        });

        expect(result.errors.length).toBeGreaterThan(0);
        // The refusal is checked before the person row is written, so the
        // person is absent as well as the employee affiliation.
        expect(await unscopedPrisma.person.findFirst({ where: { primaryEmail: email } })).toBeNull();
      },
    );
  });
});
