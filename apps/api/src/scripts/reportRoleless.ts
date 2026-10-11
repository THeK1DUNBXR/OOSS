/**
 * Read-only report of active affiliations with no role, per tenant.
 *
 * A null roleSlug gives its holder no access (lib/http.ts). That is correct,
 * and it is also a person who cannot do their job until someone names a role.
 * Run this before a deploy to see who that is. It prints counts and person
 * record codes only, never names, emails or anything else personal.
 *
 *   tsx src/scripts/reportRoleless.ts
 */

import { unscopedPrisma } from '../platform/db.js';

async function main(): Promise<void> {
  const tenants = await unscopedPrisma.tenant.findMany({
    where: { status: 'active' },
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true },
  });

  let total = 0;
  for (const tenant of tenants) {
    const rows = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: tenant.id, status: 'active', roleSlug: null },
      select: { affiliationType: true, party: { select: { recordCode: true } } },
      orderBy: { createdAt: 'asc' },
    });
    total += rows.length;
    const codes = [...new Set(rows.map((r) => r.party.recordCode))];
    console.log(`${tenant.slug}: ${rows.length} active affiliation(s) with no role, ${codes.length} person(s)`);
    for (const code of codes) console.log(`  ${code}`);
  }

  console.log(`total: ${total} active affiliation(s) with no role across ${tenants.length} active tenant(s)`);
}

main()
  .catch((err) => {
    console.error('reportRoleless failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => unscopedPrisma.$disconnect());
