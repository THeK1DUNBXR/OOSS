/**
 * The single-writer rule (CLAUDE.md rule 2) as a lint rule, tested by running
 * the real ESLint configuration over fixture source text. If the rule is
 * removed or its selector drifts, a domain file that writes the journal passes
 * lint, and this test is the thing that says so.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, 'eslint.config.js') });

async function restricted(source: string, relPath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(repoRoot, relPath) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

describe('single writer lint rule', () => {
  it('flags a Prisma journal write in a domain module', async () => {
    const msgs = await restricted(
      'export async function f(tx: any) { return tx.journalEntry.create({ data: {} }); }\n',
      'apps/api/src/domains/fixture.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('flags a journal line update or delete in a route', async () => {
    const msgs = await restricted(
      'export async function f(tx: any) { await tx.journalLine.update({ where: {}, data: {} }); await tx.journalLine.deleteMany({}); }\n',
      'apps/api/src/routes/fixture.routes.ts',
    );
    expect(msgs.length).toBe(2);
  });

  it('flags raw SQL that inserts into a journal table in a job', async () => {
    const msgs = await restricted(
      'export async function f(tx: any) { await tx.$executeRaw`INSERT INTO "journal_lines" ("id") VALUES (${1})`; }\n',
      'apps/api/src/jobs/fixture.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('flags a plain string that inserts into a journal table in a job', async () => {
    // A string, not a template: the template rule above never sees it, so a
    // write assembled from a plain literal passed lint.
    const msgs = await restricted(
      "export async function f(tx: any) { await tx.$executeRawUnsafe('INSERT INTO \"journal_lines\" (\"id\") VALUES (1)'); }\n",
      'apps/api/src/jobs/fixture.ts',
    );
    expect(msgs.length).toBe(1);
  });

  it('flags a plain string that updates a journal table in a domain module', async () => {
    const msgs = await restricted(
      "export async function f(tx: any) { await tx.$executeRawUnsafe('UPDATE journal_entries SET status = \\'void\\''); }\n",
      'apps/api/src/domains/fixture.ts',
    );
    expect(msgs.length).toBe(1);
  });

  it('allows a read-only string that names a journal table outside the ledger', async () => {
    const msgs = await restricted(
      "export async function f(tx: any) { return tx.$queryRawUnsafe('SELECT count(*) FROM journal_lines'); }\n",
      'apps/api/src/domains/reports/fixture.ts',
    );
    expect(msgs).toEqual([]);
  });

  it('allows the posting service to hold a plain journal write string', async () => {
    const msgs = await restricted(
      "export async function f(tx: any) { await tx.$executeRawUnsafe('INSERT INTO journal_lines (id) VALUES (1)'); }\n",
      'apps/api/src/platform/ledger.ts',
    );
    expect(msgs).toEqual([]);
  });

  it('allows reads of the journal outside the ledger', async () => {
    const msgs = await restricted(
      'export async function f(tx: any) { return tx.journalLine.aggregate({ where: {} }); }\n',
      'apps/api/src/domains/reports/fixture.ts',
    );
    expect(msgs).toEqual([]);
  });

  it('allows the posting service itself', async () => {
    const msgs = await restricted(
      'export async function f(tx: any) { await tx.journalEntry.create({ data: {} }); await tx.$executeRaw`INSERT INTO "journal_entries" ("id") VALUES (${1})`; }\n',
      'apps/api/src/platform/ledger.ts',
    );
    expect(msgs).toEqual([]);
  });
});
