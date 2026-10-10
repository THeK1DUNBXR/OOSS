/**
 * One-off: seals bank advices written before FX-61 was fixed, when the NEFT
 * file and each beneficiary's account number and IFSC were stored in clear.
 *
 *   tsx scripts/encrypt-bank-advices.ts                 # every tenant
 *   tsx scripts/encrypt-bank-advices.ts <tenant-slug>   # one tenant
 *
 * Idempotent: a second run converts nothing, because plaintext is detected by
 * the absence of the `enc:v1:` prefix. Each tenant runs in its own system
 * context, so the pass never reads or writes across tenants.
 */

import { unscopedPrisma } from '../src/platform/db.js';
import { asSystem } from '../src/platform/context.js';
import { encryptBankAdvicesAtRest } from '../src/domains/hcm/payrollops.js';

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
    const result = await asSystem(tenant.id, () => encryptBankAdvicesAtRest(), 'bank_advice_encrypt_at_rest');
    console.log(
      `${tenant.slug}: scanned ${result.advicesScanned}, converted ${result.advicesConverted}, already encrypted ${result.alreadyEncrypted}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => unscopedPrisma.$disconnect());
