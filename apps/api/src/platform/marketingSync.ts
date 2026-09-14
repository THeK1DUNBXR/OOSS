/**
 * Marketing's own per-tenant reconcile step, run the same way nav and grants
 * are: once per tenant, on every boot, idempotently.
 *
 * Two things a brand-new tenant (and every tenant that existed before this
 * module shipped) needs before the Marketing screens are useful:
 *
 *   - the 15 channel keys registered (`ensureDefaultChannels`), so Settings >
 *     Channels is never empty and a send has something to be honest about
 *     not having an adapter for;
 *   - the five starter lead-score rules (`seedDefaultScoreRules`), so scoring
 *     has a transparent, reversible starting point rather than nothing.
 *
 * `seedDefaultScoreRules` actually lives in `domains/marketing/attribution.ts`
 * (score rules are attribution's concern, not capture's, despite living next
 * to forms in the skeleton doc) — called from here under that name.
 */

import { unscopedPrisma } from './db.js';
import { asSystem } from './context.js';
import { ensureDefaultChannels } from '../domains/marketing/settings.js';
import { seedDefaultScoreRules } from '../domains/marketing/attribution.js';

export interface MarketingSyncResult {
  channelsCreated: number;
  scoreRulesCreated: number;
}

/** Bring one tenant's marketing defaults up to date. Safe to run repeatedly. */
export async function reconcileMarketingDefaults(tenantId: string): Promise<MarketingSyncResult> {
  return asSystem(tenantId, async () => {
    const channelsCreated = await ensureDefaultChannels(tenantId);
    const scoreRulesCreated = await seedDefaultScoreRules(tenantId);
    return { channelsCreated, scoreRulesCreated };
  });
}

/** Every tenant, at boot. Failure is logged and swallowed by the caller, same posture as nav/grant sync. */
export async function reconcileMarketingDefaultsForAllTenants(): Promise<{ tenants: number } & MarketingSyncResult> {
  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
  let channelsCreated = 0;
  let scoreRulesCreated = 0;
  for (const t of tenants) {
    const result = await reconcileMarketingDefaults(t.id);
    channelsCreated += result.channelsCreated;
    scoreRulesCreated += result.scoreRulesCreated;
  }
  return { tenants: tenants.length, channelsCreated, scoreRulesCreated };
}
