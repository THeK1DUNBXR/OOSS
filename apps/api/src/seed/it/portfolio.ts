/**
 * Technology — portfolio seed (docs/plan/cio.md, workstream G). Idempotent
 * upserts by `key`, so the dated-threshold table (Principle 4) can be
 * re-run against a tenant that already has these settings without
 * duplicating rows.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';
import { IT_THEMES } from '@kaizen/shared';

interface SettingSeed {
  key: string;
  value: unknown;
  note: string;
}

const SETTINGS: SettingSeed[] = [
  {
    key: 'stale_initiative_days',
    value: 21,
    note: 'An in-flight initiative with no status update in this many days raises an exception on its owner.',
  },
  {
    key: 'budget_burn_margin_pct',
    value: 15,
    note: 'How far, in percentage points, actual spend may run ahead of the FY elapsed fraction before it raises IT_BUDGET_BURN.',
  },
  {
    key: 'themes',
    value: [...IT_THEMES],
    note: 'The theme list a new initiative, roadmap item or budget line chooses from.',
  },
];

export async function seedPortfolio(): Promise<void> {
  const tenantId = currentTenantId();
  for (const s of SETTINGS) {
    const existing = await unscopedPrisma.itPortfolioSetting.findFirst({ where: { tenantId, key: s.key } });
    if (existing) {
      await unscopedPrisma.itPortfolioSetting.update({ where: { id: existing.id }, data: { value: s.value as never } });
    } else {
      await unscopedPrisma.itPortfolioSetting.create({
        data: { tenantId, key: s.key, value: s.value as never, effectiveFrom: new Date() },
      });
    }
  }
}
