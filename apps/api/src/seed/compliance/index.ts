/** Compliance seed: rate tables, obligations, notices. Runs inside the tenant's system context. */
import { seedCalendar } from './calendar.js';
import { seedGst } from './gst.js';
import { seedTax } from './tax.js';
import { seedBooks } from './books.js';
import { seedPayroll } from './payroll.js';
import { seedLabour } from './labour.js';
import { seedPrivacy } from './privacy.js';
import { seedCorporate } from './corporate.js';
import { seedStatutory } from './statutory.js';

export async function seedCompliance(): Promise<void> {
  await seedCalendar();
  await seedGst();
  await seedTax();
  await seedBooks();
  await seedPayroll();
  await seedLabour();
  await seedPrivacy();
  await seedCorporate();
  await seedStatutory();
}
