/**
 * `pnpm tenant:create` — bootstrap a subsidiary (or any additional standalone
 * tenant) the same way `pnpm seed` bootstraps the first one.
 *
 * Runs the identical `seedBootstrap` — thresholds, sensitivity registrations,
 * governance, the grant matrix, pipelines, navigation, agents, statutory
 * leave types, and the founding accounts — against a new tenant slug/name
 * instead of the module defaults. `Tenant.kind` is never set directly: it is
 * recomputed by `reconcileTenantKinds` at the end of the run, from whether
 * `--parent` was given and from every other tenant's own `parentTenantId`.
 *
 * Founding accounts for the new tenant come from the same `OWNER_*` /
 * `OPERATIONS_*` / `FINANCE_*` / `EMPLOYEE_*` environment variables
 * `seedAccount` already reads (`apps/api/src/seed/bootstrap.ts`) — set them
 * per invocation, the same way a Docker Compose override sets them for the
 * first tenant, or the subsidiary's founding accounts land on
 * `chairman@<SEED_EMAIL_DOMAIN>` etc. and collide with the holding's.
 *
 * Usage:
 *   tsx src/seed/createTenant.ts --slug sub-a --name "Kaizen Education Pvt Ltd" \
 *     --parent kaizen --origin-division education \
 *     [--chairman-email chairman@kaizen.co.in]
 *
 * `--chairman-email` creates a `director` affiliation for that principal's
 * sign-in in the new tenant, and nothing else is implied — the plan is
 * explicit that nothing about being chairman elsewhere carries a role into a
 * subsidiary on its own (§6, phase 0 item 3).
 */

import { seedBootstrap } from './bootstrap.js';
import { unscopedPrisma, prisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { nextRecordCode } from '../platform/recordCode.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    out[key] = value;
    if (value !== 'true') i += 1;
  }
  return out;
}

const ORIGIN_DIVISIONS = ['software', 'skill', 'education'] as const;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug || !args.name) {
    console.error('Usage: tsx src/seed/createTenant.ts --slug <slug> --name <name> [--parent <slug>] [--origin-division software|skill|education] [--chairman-email <email>]');
    process.exit(1);
  }
  if (args['origin-division'] && !ORIGIN_DIVISIONS.includes(args['origin-division'] as never)) {
    console.error(`--origin-division must be one of: ${ORIGIN_DIVISIONS.join(', ')}`);
    process.exit(1);
  }

  console.log(`Preparing tenant "${args.slug}"…\n`);

  const { tenantId, accounts } = await seedBootstrap({
    tenantSlug: args.slug,
    tenantName: args.name,
    parentTenantSlug: args.parent,
    originDivision: args['origin-division'] as (typeof ORIGIN_DIVISIONS)[number] | undefined,
  });

  if (args['chairman-email']) {
    const email = args['chairman-email'].toLowerCase();
    const principal = await unscopedPrisma.principal.findFirst({ where: { email } });
    if (!principal) {
      console.error(`No principal exists yet for ${email} — create their sign-in first (they must already be able to log in somewhere).`);
    } else {
      const existingUser = await unscopedPrisma.user.findFirst({ where: { tenantId, principalId: principal.id } });
      await asSystem(tenantId, async () => {
        let user = existingUser;
        if (!user) {
          const source = await unscopedPrisma.user.findFirst({ where: { principalId: principal.id }, include: { person: true } });
          const person = source
            ? await prisma.person.create({
                data: {
                  tenantId,
                  recordCode: await nextRecordCode('PER'),
                  fullName: source.person.fullName,
                  primaryEmail: email,
                  primaryEmailNormalised: email,
                  source: 'tenant_create',
                },
              })
            : null;
          if (!person) {
            console.error(`Could not resolve a name for ${email} — skipping the director affiliation.`);
            return;
          }
          user = await prisma.user.create({ data: { tenantId, personId: person.id, email, principalId: principal.id } });
        }

        const affiliation = await prisma.affiliation.findFirst({ where: { partyId: user.personId, roleSlug: 'director' } });
        if (!affiliation) {
          await prisma.affiliation.create({
            data: { tenantId, partyId: user.personId, affiliationType: 'director', roleSlug: 'director', status: 'active', primaryFlag: false },
          });
          console.log(`  director affiliation created for ${email} in ${args.slug}`);
        } else {
          console.log(`  ${email} already holds a director affiliation in ${args.slug}`);
        }
      });
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Ready. Founding accounts for "${args.slug}":\n`);
  for (const account of accounts) {
    console.log(`  ${account.name} — ${account.roleSlug}`);
    console.log(`    ${account.email}`);
    if (account.password) console.log(`    ${account.password}`);
    else if (account.created) console.log('    (the password from the environment, or an existing principal)');
    else console.log('    (existing account — password left untouched)');
  }
  console.log('─────────────────────────────────────────────\n');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
