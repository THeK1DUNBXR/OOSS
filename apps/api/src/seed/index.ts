/**
 * `pnpm seed` — prepare a tenant to be used.
 *
 * Structure only: the permission matrix, the pipeline definitions, the
 * navigation registry, statutory leave types, and one account to sign in with.
 * No leads, no ledger, no invented staff. The company's data arrives through
 * the product — by import from Tally, a bank statement or a spreadsheet, or by
 * being typed in — and the first-run checklist walks the owner through it.
 *
 * Safe to re-run: every block checks before it writes, and re-running never
 * alters a GRANT.
 */

import { seedBootstrap } from './bootstrap.js';

async function main() {
  console.log('Preparing the tenant…\n');
  const { owner } = await seedBootstrap();

  // The seed does not know where the client is being served from — 5173 under
  // `dev.sh`, 8080 under Docker, a domain in a real install — so it does not
  // guess. Naming the wrong port sends somebody to a page that does not exist
  // and makes them doubt the credentials underneath it.
  console.log('\n─────────────────────────────────────────────');
  console.log('Ready. Sign in as:');
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
