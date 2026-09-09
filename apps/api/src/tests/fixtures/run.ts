/**
 * Loads the demonstration dataset into the suite's database.
 *
 * Invoked by `scripts/test-db.sh`, never by the application. The dataset is a
 * set of test subjects; if it ever runs against a company's database, that is
 * the bug.
 */

import { seedDemoDataset } from './demoDataset.js';

seedDemoDataset()
  .then((tenantId) => {
    console.log(`demo dataset loaded into tenant ${tenantId}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
