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

  console.log('\n─────────────────────────────────────────────');
  console.log('Ready. Sign in at http://localhost:5173');
  console.log(`  ${owner.email}`);
  if (owner.password) {
    console.log(`  ${owner.password}`);
    console.log('\nThis password is shown once and is not stored anywhere else.');
    console.log('Change it after signing in.');
  } else {
    console.log('  (password unchanged — set OWNER_PASSWORD to choose one)');
  }
  console.log('─────────────────────────────────────────────\n');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
