/**
 * Technology — vendors and contracts seed (docs/plan/cio.md, workstream C).
 *
 * The assessment-cadence table is the dated default a tenant tunes without a
 * code change (Principle 4) — upserted idempotently by `(tenantId, tier)`, so
 * a tenant that has already edited its own cadence for a tier keeps its
 * edit; only a tier the tenant has never set is created here.
 */
import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';
import { VENDOR_ASSESSMENT_CADENCE_MONTHS } from '@kaizen/shared';

export async function seedVendors(): Promise<void> {
  const tenantId = currentTenantId();

  for (const [tierStr, cadenceMonths] of Object.entries(VENDOR_ASSESSMENT_CADENCE_MONTHS)) {
    const tier = Number(tierStr);
    const existing = await unscopedPrisma.itVendorAssessmentCadenceRule.findFirst({ where: { tenantId, tier } });
    if (existing) continue;
    await unscopedPrisma.itVendorAssessmentCadenceRule.create({
      data: {
        tenantId,
        tier,
        cadenceMonths,
        note: `Tier ${tier} default — re-assessed every ${cadenceMonths} months. Edit this row to change it; the seed never overwrites a rule that already exists.`,
      },
    });
  }
}
