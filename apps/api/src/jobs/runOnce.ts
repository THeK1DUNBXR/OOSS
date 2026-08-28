/**
 * The manual / CI entry point, pointed at the same durable substrate as
 * scheduled execution so the two can never diverge.
 *
 *   pnpm jobs:run                    # every job, every active tenant
 *   pnpm jobs:run -- --dry-run       # shadow mode: compute, do not execute
 *   pnpm jobs:run -- runMouExpiryJob # a named subset
 */

import { runAllTenants, ALL_JOBS } from './scheduler.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jobNames = args.filter((a) => !a.startsWith('--'));

  if (jobNames.some((n) => !ALL_JOBS.find((j) => j.name === n))) {
    console.error('Unknown job. Registered jobs:');
    for (const j of ALL_JOBS) console.error(`  ${j.name}  —  ${j.label}`);
    process.exit(1);
  }

  const results = await runAllTenants({ dryRun, jobNames: jobNames.length ? jobNames : undefined });

  for (const [tenantId, jobs] of Object.entries(results)) {
    console.log(`\ntenant ${tenantId}${dryRun ? '  (dry run)' : ''}`);
    for (const [name, r] of Object.entries(jobs)) {
      const status = r.errors.length ? `FAILED: ${r.errors[0]}` : `processed ${r.processed}, notified ${r.notified}`;
      console.log(`  ${name.padEnd(34)} ${status}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
