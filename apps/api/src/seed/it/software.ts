/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B). Idempotent upsert by `code`, so re-running the seed against
 * a tenant that already has this row only ever updates it in place.
 *
 * The under-use percentage, the minimum seat count it applies to, and the
 * renewal ladder rungs are data here, never a constant in job code
 * (Principle 4) — see `renewalRung`/`isUnderUsed` in
 * `packages/shared/src/it/software.ts` for how they are read.
 */

import { DEFAULT_IT_LICENCE_RENEWAL_RUNGS } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';

const THRESHOLD_CODE = 'IT_SOFTWARE_DEFAULT';

export async function seedSoftware(): Promise<void> {
  const tenantId = currentTenantId();

  await unscopedPrisma.itSoftwareThreshold.upsert({
    where: { tenantId_code: { tenantId, code: THRESHOLD_CODE } },
    create: {
      tenantId,
      code: THRESHOLD_CODE,
      effectiveFrom: new Date(Date.UTC(2026, 3, 1)), // FY2026-27 start
      underUsePercent: 30,
      underUseMinSeats: 5,
      renewalLadderRungs: [...DEFAULT_IT_LICENCE_RENEWAL_RUNGS],
      note:
        'A licence with at least 5 seats purchased is flagged under-used below 30% utilisation. ' +
        'The renewal ladder fires at 90/60/30/7 days out and once the renewal date has passed. ' +
        'A starting point, not a decision — the company has not set its own thresholds yet.',
    },
    update: {
      underUsePercent: 30,
      underUseMinSeats: 5,
      renewalLadderRungs: [...DEFAULT_IT_LICENCE_RENEWAL_RUNGS],
    },
  });
}
