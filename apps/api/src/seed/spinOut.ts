/**
 * `pnpm division:spin-out` — carry a division across into the subsidiary
 * tenant incorporated for it (equity-portal plan §3.3, §6b).
 *
 * This script is the one sanctioned cross-tenant writer besides the
 * snapshot publisher: it reads the holding tenant and writes the subsidiary
 * tenant in the same run. Every individual query still goes through the
 * ordinary tenant-scoped `prisma` client, under its own `asSystem(<that
 * tenant>)` context (`seed/spinOutEngine.ts`) — no query ever runs unscoped
 * and no query ever spans two tenants at once. Nothing here is reachable
 * from the API: a request that tried this would fail at the tenant-scope
 * gate before it got anywhere.
 *
 * Preconditions (refused by name, not silently worked around):
 *   - the target tenant exists, was created with `--origin-division`
 *     matching, and names the holding as its `parentTenantId` — run
 *     `pnpm tenant:create` first if not;
 *   - its equity register is empty — a spin-out is the first thing that
 *     happens to a subsidiary;
 *   - its company profile carries at least two certificate signatories —
 *     the opening allotment issues certificates like any other.
 *
 * Usage:
 *   tsx src/seed/spinOut.ts --from kaizen --division education --to kz-edu
 *     [--yes] [--kipl-stake 7000 --face-value 10 --class "Equity"]
 *     [--other-holder "Jane Founder|jane@example.com=3000"]
 *   tsx src/seed/spinOut.ts --revert <batchId> --from kaizen --to kz-edu --yes
 *
 * Without `--yes` this only previews — nothing is written, and every row it
 * would carry and every row it would refuse is printed, the same shape as
 * `pnpm wipe` refusing without `--yes` and `imports/service.ts` staging
 * before commit.
 */

import { unscopedPrisma } from '../platform/db.js';
import {
  previewSpinOut, commitSpinOut, revertSpinOut, MODEL_LABEL, type SpinOutModel,
} from './spinOutEngine.js';

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const DIVISIONS = ['software', 'skill', 'education'] as const;
type DivisionArg = (typeof DIVISIONS)[number];

function printPreview(preview: Awaited<ReturnType<typeof previewSpinOut>>) {
  console.log(`\nSpin-out preview — ${preview.division} division, from "${preview.holding.slug}"`);
  console.log('─────────────────────────────────────────────');
  if (preview.subsidiary) {
    console.log(`Target subsidiary: ${preview.subsidiary.slug} (${preview.subsidiary.name})`);
  } else {
    console.log('Target subsidiary: none on file yet.');
  }

  console.log('\nWould carry:');
  const models = Object.keys(MODEL_LABEL) as SpinOutModel[];
  let anyCarried = false;
  for (const model of models) {
    const bucket = preview.carried[model];
    if (!bucket) continue;
    anyCarried = true;
    console.log(`  ${MODEL_LABEL[model]}: ${bucket.count}`);
    for (const code of bucket.sample) console.log(`    - ${code}`);
    if (bucket.count > bucket.sample.length) console.log(`    … and ${bucket.count - bucket.sample.length} more`);
  }
  if (!anyCarried) console.log('  (nothing)');

  console.log('\nWould refuse:');
  let anyRefused = false;
  for (const model of models) {
    const bucket = preview.refused[model];
    if (!bucket) continue;
    anyRefused = true;
    console.log(`  ${MODEL_LABEL[model]}: ${bucket.count}`);
    for (const row of bucket.sample) console.log(`    - ${row.code}: ${row.reason}`);
    if (bucket.count > bucket.sample.length) console.log(`    … and ${bucket.count - bucket.sample.length} more`);
  }
  if (!anyRefused) console.log('  (nothing)');

  console.log(`\n${preview.openingAllotment.note}`);

  if (preview.blockers.length) {
    console.log('\nCannot commit yet:');
    for (const b of preview.blockers) console.log(`  - ${b}`);
  } else {
    console.log('\nReady to commit — re-run with --yes.');
  }
  console.log('─────────────────────────────────────────────\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.revert) {
    const batchId = String(args.revert);
    const fromSlug = args.from ? String(args.from) : undefined;
    const toSlug = args.to ? String(args.to) : undefined;
    if (!fromSlug || !toSlug) {
      console.error('Usage: tsx src/seed/spinOut.ts --revert <batchId> --from <holding-slug> --to <subsidiary-slug> --yes');
      process.exit(1);
    }
    if (!args.yes) {
      console.error('This removes what this spin-out batch created in the subsidiary. Re-run with --yes if that is what you want.');
      process.exit(1);
    }
    const holding = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: fromSlug } });
    const subsidiary = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: toSlug } });
    const result = await revertSpinOut({ holdingTenantId: holding.id, subsidiaryTenantId: subsidiary.id, batchId });
    console.log('\nReverted. Removed:');
    for (const [k, v] of Object.entries(result.removed)) console.log(`  ${k}: ${v}`);
    console.log('');
    process.exit(0);
  }

  const fromSlug = args.from ? String(args.from) : undefined;
  const division = args.division ? String(args.division) : undefined;
  const toSlug = args.to ? String(args.to) : undefined;

  if (!fromSlug || !division || !toSlug || !DIVISIONS.includes(division as DivisionArg)) {
    console.error(
      'Usage: tsx src/seed/spinOut.ts --from <holding-slug> --division <software|skill|education> --to <subsidiary-slug> ' +
        '[--yes] [--kipl-stake <count> --face-value <n> --class "Equity"] [--other-holder "<name>|<email>=<count>" ...]',
    );
    process.exit(1);
  }

  const holding = await unscopedPrisma.tenant.findFirst({ where: { slug: fromSlug } });
  if (!holding) {
    console.error(`No tenant "${fromSlug}" on file.`);
    process.exit(1);
    return;
  }
  const subsidiary = await unscopedPrisma.tenant.findFirst({ where: { slug: toSlug } });
  if (!subsidiary) {
    console.error(
      `No tenant "${toSlug}" on file. Create it first:\n` +
        `  pnpm --filter @kaizen/api tenant:create --slug ${toSlug} --name "<Legal Name> Pvt Ltd" --parent ${fromSlug} --origin-division ${division}`,
    );
    process.exit(1);
    return;
  }

  // `previewSpinOut` takes the tenant explicitly and manages its own
  // `asSystem` scoping internally — no ambient context needed here.
  const preview = await previewSpinOut(holding.id, division as DivisionArg);
  printPreview(preview);

  if (!args.yes) process.exit(0);

  if (!preview.ready) {
    console.error('Refusing to commit — see the blockers above.');
    process.exit(1);
  }

  // `parseArgs` keeps only the last occurrence of a repeatable flag, so
  // `--other-holder` is read straight off `process.argv` here instead.
  const otherHolders = process.argv
    .map((v, i) => (process.argv[i - 1] === '--other-holder' ? v : null))
    .filter((v): v is string => v !== null);
  // "<name>|<email>=<count>" — the email is required, because the holder is
  // resolved as a Person in the subsidiary tenant the same way any other
  // holder is (`findOrCreatePerson`), and a person needs an email or a phone.
  const parsedOtherHolders = otherHolders.map((entry) => {
    const [namePart, countRaw] = entry.split('=');
    const [name, email] = namePart.split('|');
    return { name: name.trim(), email: email?.trim(), count: Number(countRaw) };
  });

  const result = await commitSpinOut({
    holdingTenantId: holding.id,
    division: division as DivisionArg,
    kiplStake: args['kipl-stake'] ? Number(args['kipl-stake']) : undefined,
    faceValue: args['face-value'] ? Number(args['face-value']) : undefined,
    className: args.class ? String(args.class) : undefined,
    otherHolders: parsedOtherHolders,
  });

  console.log('\nCommitted. Carried:');
  for (const [k, v] of Object.entries(result.carried)) console.log(`  ${k}: ${v}`);
  if (result.accountsOpened.length) console.log(`Accounts opened at zero: ${result.accountsOpened.join(', ')}`);
  if (result.categoriesCopied.length) console.log(`Categories copied: ${result.categoriesCopied.join(', ')}`);
  console.log(`Batch: ${result.batchId}`);
  console.log(
    '\nNot done by this script, and needing a deliberate human act: ending the migrated employment relationships in ' +
      `"${fromSlug}", moving the actual cash into the subsidiary's bank accounts, and registering the subsidiary for its ` +
      'own GSTIN before it can invoice. See docs/operations.md.\n',
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
