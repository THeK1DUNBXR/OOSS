/**
 * The sidebar is code, not somebody's data.
 *
 * Navigation is stored per tenant — a row per entry, so a person's menu can be
 * filtered by what they are allowed to reach — but *what the entries are* is
 * part of the product. Nobody edits them. They are declared once in
 * `NAV_REGISTRY` and written out.
 *
 * For a while the only thing that wrote them was the seed, and that cost two
 * bugs in a row. A release that adds a screen adds a row nobody's tenant has,
 * so the screen exists, the route works, and the sidebar never mentions it:
 * Customers and Institutions shipped and could not be reached. A release that
 * changes a word updates a row nobody's tenant re-reads, so the command palette
 * goes on answering with the old vocabulary. Both look exactly like the change
 * not working, and neither is visible from any screen.
 *
 * So the API reconciles the navigation against the registry at boot, for every
 * tenant. A deploy restarts the API; the menu is then what the code says it is,
 * without anybody remembering to run anything. The seed calls the same function,
 * so there is one implementation and not two that drift.
 */

import { unscopedPrisma } from './db.js';
import { NAV_REGISTRY } from '../seed/bootstrap.js';

export interface NavSyncResult {
  written: number;
  retired: number;
}

/** Bring one tenant's navigation up to what the code declares. */
export async function reconcileNav(tenantId: string): Promise<NavSyncResult> {
  for (const n of NAV_REGISTRY) {
    await unscopedPrisma.navNode.upsert({
      where: { tenantId_nodeKey: { tenantId, nodeKey: n.nodeKey } },
      create: {
        tenantId,
        nodeKey: n.nodeKey,
        label: n.label,
        icon: n.icon,
        path: n.path,
        group: n.group,
        position: n.position,
        requiredPermission: n.requiredPermission ?? null,
        eligibleArchetypes: n.archetypes ?? [],
        searchSynonyms: n.synonyms ?? [],
      },
      // Every field, not only the label and the path. The synonyms were left
      // out of this once, and the palette went on routing a word that had moved
      // to another screen.
      update: {
        label: n.label,
        icon: n.icon,
        path: n.path,
        group: n.group,
        position: n.position,
        requiredPermission: n.requiredPermission ?? null,
        eligibleArchetypes: n.archetypes ?? [],
        searchSynonyms: n.synonyms ?? [],
      },
    });
  }

  // An entry the product no longer has is removed rather than left in the
  // sidebar pointing at a route that has gone. The registry is the whole truth
  // about what the menu contains.
  const { count: retired } = await unscopedPrisma.navNode.deleteMany({
    where: { tenantId, nodeKey: { notIn: NAV_REGISTRY.map((n) => n.nodeKey) } },
  });

  return { written: NAV_REGISTRY.length, retired };
}

/**
 * Every tenant, at boot.
 *
 * Failure here is logged and swallowed: a menu that is one deploy stale is bad,
 * and an API that will not start is worse.
 */
export async function reconcileNavForAllTenants(): Promise<NavSyncResult & { tenants: number }> {
  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
  let retired = 0;
  for (const t of tenants) {
    const result = await reconcileNav(t.id);
    retired += result.retired;
  }
  return { tenants: tenants.length, written: NAV_REGISTRY.length, retired };
}
