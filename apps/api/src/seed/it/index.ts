/** Technology seed: dated tables and defaults. Runs inside the tenant's system context. */
import { seedAssets } from './assets.js';
import { seedSoftware } from './software.js';
import { seedVendors } from './vendors.js';
import { seedServicedesk } from './servicedesk.js';
import { seedItsm } from './itsm.js';
import { seedGovernance } from './governance.js';
import { seedPortfolio } from './portfolio.js';
import { seedContinuity } from './continuity.js';

export async function seedIt(): Promise<void> {
  await seedAssets();
  await seedSoftware();
  await seedVendors();
  await seedServicedesk();
  await seedItsm();
  await seedGovernance();
  await seedPortfolio();
  await seedContinuity();
}
