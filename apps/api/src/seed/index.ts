/**
 * `pnpm seed` — prepare a tenant to be used.
 *
 * Structure only: the permission matrix, the pipeline definitions, the
 * navigation registry, statutory leave types, and the four accounts the company
 * runs on — one per role. No leads, no ledger, no invented staff. The company's
 * data arrives through the product — by import from Tally, a bank statement or a
 * spreadsheet, or by being typed in — and the first-run checklist walks the owner
 * through it.
 *
 * Four accounts rather than one because the matrix's point is that authority is
 * divided: a pay rise takes two parties and the books are not the people
 * function. A tenant with a single superadmin cannot demonstrate any of that, and
 * whoever signed in first had to create three colleagues before the product
 * behaved the way it is designed to.
 *
 * Safe to re-run: every block checks before it writes, re-running never alters a
 * GRANT, and an account that already exists keeps its password.
 */

import { seedBootstrap } from './bootstrap.js';

async function main() {
  console.log('Preparing the tenant…\n');
  const { accounts } = await seedBootstrap();

  // The seed does not know where the client is being served from — 5173 under
  // `dev.sh`, 8080 under Docker, a domain in a real install — so it does not
  // guess. Naming the wrong port sends somebody to a page that does not exist
  // and makes them doubt the credentials underneath it.
  console.log('\n─────────────────────────────────────────────');
  console.log('Ready. Four accounts, one per role:\n');

  let anyGenerated = false;
  for (const account of accounts) {
    console.log(`  ${account.name} — ${account.roleSlug}`);
    console.log(`    ${account.email}`);
    if (account.password) {
      console.log(`    ${account.password}`);
      anyGenerated = true;
    } else if (account.created) {
      console.log('    (the password from the environment)');
    } else {
      console.log('    (existing account — password left untouched)');
    }
    console.log(`    ${account.holds}`);
    console.log('');
  }

  if (anyGenerated) {
    console.log('The passwords above were generated because none was set in the environment.');
    console.log('They are shown here once and are not stored anywhere else — copy them now.');
    console.log('');
  }
  console.log('─────────────────────────────────────────────\n');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
