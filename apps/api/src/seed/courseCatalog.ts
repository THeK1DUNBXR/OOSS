/**
 * `pnpm --filter @kaizen/api run seed:course-catalog` — load Kaizen
 * Infinities' real course price list, its add-ons, and the company's own
 * registration details onto a tenant.
 *
 * Deliberately not part of `pnpm seed`. That script's whole point is that a
 * fresh tenant starts empty — no leads, no ledger, no invented data — and a
 * price list of ~110 real courses is exactly the kind of company-specific
 * content that principle is protecting against, even though every figure
 * here is real rather than fabricated. So this is its own step, run once
 * against a tenant that already exists, for the one company this catalogue
 * actually belongs to.
 *
 * Safe to re-run: every course is matched by name and updated in place
 * rather than duplicated, and the company profile write is the same
 * `updateCompanyProfile` a human uses from Settings.
 */

import { prisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { createCourse, updateCourse, type CourseFeePlanInput, type CourseAddonInput } from '../domains/courses.js';
import { updateCompanyProfile } from '../domains/companyProfile.js';
import { TENANT_SLUG } from './bootstrap.js';
import { COURSE_CATALOG, COURSE_ADDONS, type CourseCatalogEntry } from './courseCatalogData.js';

function feePlansFor(entry: CourseCatalogEntry): CourseFeePlanInput[] {
  const plans: CourseFeePlanInput[] = [];
  if (entry.m1 !== null) plans.push({ tenureMonths: 1, monthlyFee: entry.m1 });
  if (entry.m3 !== null) plans.push({ tenureMonths: 3, monthlyFee: entry.m3 });
  if (entry.m6 !== null) plans.push({ tenureMonths: 6, monthlyFee: entry.m6 });
  if (entry.m8 !== null) plans.push({ tenureMonths: 8, monthlyFee: entry.m8 });
  return plans;
}

function addonsFor(courseName: string): CourseAddonInput[] {
  return COURSE_ADDONS.filter((a) => a.course === courseName).map((a) => ({
    name: a.name,
    price: a.price,
    gstRate: a.gstRate,
    hsnSac: a.sac,
    notes: a.notes || null,
  }));
}

/** `KC-001`, `KC-002`, … — stable, collision-free, and never shown to a customer. */
function codeFor(index: number): string {
  return `KC-${String(index + 1).padStart(3, '0')}`;
}

export async function seedCourseCatalog() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG } });
  if (!tenant) {
    throw new Error(`No tenant "${TENANT_SLUG}" yet. Run "pnpm seed" first.`);
  }

  await asSystem(tenant.id, async () => {
    await updateCompanyProfile({
      legalName: 'Kaizen Infinities Private Limited',
      tradeName: 'Kaizen Infinities',
      gstin: '33AAMCK6781B1ZH',
      addressLine1: '4/99-A, 2nd Floor, EB Colony Main Road',
      addressLine2: 'Srinagar, Iyer Bungalow',
      city: 'Madurai',
      pincode: '625014',
      phone: '+91 73051 33996',
      documentPrefix: 'KIPL',
    });

    let created = 0;
    let updated = 0;
    for (const [index, entry] of COURSE_CATALOG.entries()) {
      const feePlans = feePlansFor(entry);
      const addons = addonsFor(entry.name);
      const existing = await prisma.course.findFirst({ where: { tenantId: tenant.id, name: entry.name } });

      const shared = {
        name: entry.name,
        description: entry.notes || null,
        feeAmount: entry.m1,
        gstRate: entry.gstRate,
        hsnSac: entry.sac,
        hours: entry.hours,
        division: 'education' as const,
        feePlans,
        addons,
      };

      if (existing) {
        await updateCourse(existing.id, shared);
        updated += 1;
      } else {
        await createCourse({ ...shared, code: codeFor(index) });
        created += 1;
      }
    }
    console.log(`Course catalogue: ${created} created, ${updated} updated, ${COURSE_ADDONS.length} add-on rows across them.`);
  });
}

async function main() {
  await seedCourseCatalog();
  process.exit(0);
}

// Only run as a script — `import`ed by nothing else, but guarded the same
// way `seed/index.ts` is in case that ever changes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
