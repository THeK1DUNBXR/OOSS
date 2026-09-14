/**
 * Technology — assets seed (docs/plan/cio.md, workstream A).
 *
 * The single dated threshold row the warranty ladder and the in-repair-too-
 * long detector read (Principle 4: service targets are data, not constants).
 * Idempotent: upserted by `(tenantId, code, effectiveFrom)`, so re-running
 * the seed against a tenant that already has today's row only updates it.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';

const DEFAULT_WARRANTY_RUNGS = [90, 30, 7, 0];
const DEFAULT_REPAIR_DAYS_THRESHOLD = 14;

export async function seedAssets(): Promise<void> {
  const tenantId = currentTenantId();

  const existing = await unscopedPrisma.itAssetThreshold.findFirst({
    where: { tenantId, code: 'DEFAULT' },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (existing) {
    await unscopedPrisma.itAssetThreshold.update({
      where: { id: existing.id },
      data: {
        warrantyRungs: DEFAULT_WARRANTY_RUNGS,
        repairDaysThreshold: DEFAULT_REPAIR_DAYS_THRESHOLD,
      },
    });
    return;
  }

  await unscopedPrisma.itAssetThreshold.create({
    data: {
      tenantId,
      code: 'DEFAULT',
      effectiveFrom: new Date(0),
      warrantyRungs: DEFAULT_WARRANTY_RUNGS,
      repairDaysThreshold: DEFAULT_REPAIR_DAYS_THRESHOLD,
      note: 'Warranty ladder at 90/30/7/0 days; an asset in repair 14 days or more is flagged. Starting point, not a decision (docs/plan/cio.md open questions).',
    },
  });
}
