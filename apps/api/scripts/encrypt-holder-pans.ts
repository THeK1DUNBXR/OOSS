/**
 * One-off: seals holder PANs written before the equity writers sealed them.
 * Until then the holder form, the holder update and the opening-register
 * import all wrote Holder.panNumber in clear, so those rows still hold plaintext.
 *
 *   tsx scripts/encrypt-holder-pans.ts                 # every tenant
 *   tsx scripts/encrypt-holder-pans.ts <tenant-slug>   # one tenant
 *
 * Idempotent: a second run converts nothing, because plaintext is detected by
 * the absence of the `enc:v1:` prefix. Each tenant runs in its own system
 * context, so the pass never reads or writes across tenants.
 */

import { unscopedPrisma } from '../src/platform/db.js';
import { asSystem } from '../src/platform/context.js';
import { encryptHolderPansAtRest } from '../src/domains/equity.js';

async function main() {
  const slug = process.argv[2];
  const tenants = await unscopedPrisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
  });
  if (!tenants.length) {
    console.log(slug ? `No tenant with slug "${slug}".` : 'No tenants.');
    return;
  }

  for (const tenant of tenants) {
    const result = await asSystem(tenant.id, () => encryptHolderPansAtRest(), 'holder_pan_encrypt_at_rest');
    console.log(
      `${tenant.slug}: scanned ${result.holdersScanned}, converted ${result.valuesEncrypted}, already encrypted ${result.alreadyEncrypted}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => unscopedPrisma.$disconnect());
