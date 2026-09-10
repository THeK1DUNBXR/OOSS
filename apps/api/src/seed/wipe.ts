/**
 * `pnpm wipe` — empty the company, keep the platform.
 *
 * Every business record goes: people, organisations, leads, the ledger,
 * employment, enrolments, imports, events, the lot. What comes back is what
 * `pnpm seed` would have produced on a fresh database — the permission matrix,
 * the pipeline definitions, the navigation registry, statutory leave types and
 * one account to sign in with.
 *
 * Implemented as truncate-then-bootstrap rather than as a list of deletions in
 * dependency order. A hand-maintained delete list is wrong the first time
 * somebody adds a table and forgets to add it here, and the failure is silent:
 * you think you have a clean company and you have last month's leads. Asking
 * the database which tables exist cannot drift.
 *
 * This is destructive and says so. It refuses to run without --yes, because a
 * command that empties a company on a typo is a bad command.
 */

import { unscopedPrisma } from '../platform/db.js';
import { seedBootstrap } from './bootstrap.js';

/**
 * Tables that are not the company's data.
 *
 * `_prisma_migrations` is Prisma's own bookkeeping; dropping it would make the
 * schema look unmigrated. Everything else in the schema is fair game, because
 * the structural rows are recreated by the bootstrap immediately afterwards.
 */
const KEEP = new Set(['_prisma_migrations']);

async function tableNames(): Promise<string[]> {
  const rows = await unscopedPrisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
  `;
  return rows.map((r) => r.tablename).filter((t) => !KEEP.has(t));
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error(
      'This deletes every record in the database — people, organisations, the ledger, everything —\n' +
        'and then recreates an empty tenant with one account.\n\n' +
        'Re-run with --yes if that is what you want:\n' +
        '  pnpm --filter @kaizen/api wipe --yes\n',
    );
    process.exit(1);
  }

  const tables = await tableNames();
  console.log(`Emptying ${tables.length} tables…`);

  // One statement, so it is one transaction: a wipe that half-succeeded would
  // leave a database in a state neither the app nor this script expects.
  // CASCADE handles the foreign keys; RESTART IDENTITY resets the sequences so
  // record codes begin at 00001 again rather than continuing from the deleted
  // company's numbering.
  const quoted = tables.map((t) => `"${t}"`).join(', ');
  await unscopedPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  console.log('Rebuilding the platform…\n');
  const { owner } = await seedBootstrap();

  console.log('\n─────────────────────────────────────────────');
  console.log('Empty. Sign in as:');
  console.log(`  ${owner.email}`);
  if (owner.password) {
    console.log(`  ${owner.password}`);
    console.log('\nThis password was generated because OWNER_PASSWORD was not set.');
    console.log('It is shown here once and is not stored anywhere else — copy it now.');
  } else {
    console.log('  (the password from OWNER_PASSWORD)');
  }
  console.log('─────────────────────────────────────────────\n');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
