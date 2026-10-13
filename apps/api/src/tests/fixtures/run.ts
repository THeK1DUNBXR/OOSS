/**
 * Loads the demonstration dataset into the suite's database.
 *
 * Invoked by `scripts/test-db.sh`, never by the application. The dataset is a
 * set of test subjects; if it ever runs against a company's database, that is
 * the bug.
 */

import { seedDemoDataset } from './demoDataset.js';
import { readyInvoicePosting } from './invoicePostingReady.js';
import { unscopedPrisma } from '../../platform/db.js';
import { TENANT_SLUG } from '../../seed/bootstrap.js';

async function main(): Promise<string> {
  // Before the dataset: its invoices are issued into the journal, and an issue in a
  // tenant without the posting setup is refused (invoicePosting.ts). The tenant is the
  // one `pnpm seed` made.
  const tenant = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: TENANT_SLUG } });
  await readyInvoicePosting(tenant.id);
  return seedDemoDataset();
}

main()
  .then((tenantId) => {
    console.log(`demo dataset loaded into tenant ${tenantId}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
