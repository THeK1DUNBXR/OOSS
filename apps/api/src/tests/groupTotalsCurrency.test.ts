/**
 * FX-30: a group total is the paise sum of entities in one currency, and is
 * withheld, not added, when they are not (archive/FIXES.md row FX-30;
 * domains/group.ts groupFinancials and sumPnl).
 *
 * The totals were float sums of entity figures with no currency check. A
 * subsidiary reporting in another currency was added into the group's rupee
 * total as if it were rupees.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMinor, parseMinor } from '@kaizen/shared';
import { seedBootstrap } from '../seed/bootstrap.js';
import { groupFinancials, publishEntitySnapshot } from '../domains/group.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const cleanupTenantSlugs: string[] = [];
let HOLDING: string;
let subId: string;

beforeAll(async () => {
  HOLDING = await tenantId();
  const slug = `fx30-sub-${Date.now()}`;
  cleanupTenantSlugs.push(slug);
  ({ tenantId: subId } = await seedBootstrap({
    tenantSlug: slug,
    tenantName: 'FX-30 Sub',
    parentTenantSlug: 'kaizen',
  }));
  expect((await publishEntitySnapshot(subId)).published).toBe(true);
});

afterAll(async () => {
  // Snapshots live under the holding's tenantId; the source tenant is left, as in equityGroup.test.ts.
  await unscopedPrisma.entitySnapshot.deleteMany({ where: { sourceTenantId: subId } });
  await unscopedPrisma.entitySnapshotHistory.deleteMany({ where: { sourceTenantId: subId } });
});

/** Rupee figures summed as paise: the only sum that is exact to the paisa. */
function paiseOf(values: Array<number | null | undefined>): bigint {
  return values.reduce<bigint>((s, v) => (v == null ? s : s + parseMinor(v.toFixed(2))), 0n);
}

describe('FX-30: the group cash total is the exact paise sum of the entities', () => {
  it('equals the sum of every entity row, to the paisa', async () => {
    const financials = await asUser(CHAIRMAN, () => groupFinancials());
    expect(financials.totalCash).not.toBeNull();
    const expected = paiseOf(financials.entities.map((e) => e.cash));
    expect(financials.totalCash).toBe(Number(formatMinor(expected)));
  });
});

describe('FX-30: an entity in another currency withholds the group totals', () => {
  it('does not add a foreign-currency entity into the rupee totals; the reason is stated', async () => {
    const snapshot = await unscopedPrisma.entitySnapshot.findFirstOrThrow({ where: { sourceTenantId: subId } });
    const financial = snapshot.financial as Record<string, unknown>;
    await unscopedPrisma.entitySnapshot.updateMany({
      where: { sourceTenantId: subId },
      data: { financial: { ...financial, currency: 'USD' } as never },
    });

    const financials = await asUser(CHAIRMAN, () => groupFinancials());
    expect(financials.totalCash).toBeNull();
    expect(financials.totalPnlMonth).toBeNull();
    expect(financials.totalsWithheldReason).toMatch(/currenc/i);

    // The entity's own row is still listed: only the totals are withheld.
    const subRow = financials.entities.find((e) => e.tenantId === subId);
    expect(subRow).toBeTruthy();
  });
});
