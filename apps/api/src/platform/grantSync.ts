/**
 * A resource the product has and the tenant has never heard of.
 *
 * Permissions are durable rows, and the seed deliberately never *overwrites*
 * one: re-running a deployment must not silently rewrite somebody's permission
 * state, and changing or revoking a grant stays a governed act done on purpose
 * through `reconcileGrants --apply`. That principle is right and it is not
 * touched here.
 *
 * What it left open is the other half. When a release adds a whole new resource
 * — `students`, the first time the three parties were separated — every tenant
 * that already exists has no row for it at all. Nobody holds `students:create`,
 * so the button to add one is simply absent, the screen looks finished, and the
 * only symptom is a person saying "I can add institutions and organisations but
 * not customers". Nothing on any screen says why. It is the same shape as the
 * sidebar that never mentioned a screen that had shipped.
 *
 * So exactly one narrow thing happens automatically, at boot:
 *
 *   a role that has **no grant row whatsoever** for a resource the matrix
 *   declares gets the row the matrix declares.
 *
 * Nothing else. An existing row is never changed, widened, narrowed or removed
 * — that is still `reconcileGrants --apply`, still deliberate, still reported
 * before it writes. And this is not a new decision about who may do what: it is
 * the same operation `seedGrants` already performs for a tenant, arriving when
 * the release does rather than when somebody remembers to run it.
 *
 * Every addition is logged and emits `kz.gov.grant.changed` carrying its reason,
 * so it leaves the same trail as any other permission change. Set
 * `GRANT_AUTOSYNC=off` to keep the strict manual posture.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from './db.js';
import { config } from './config.js';
import { asSystem } from './context.js';
import { emit } from '../platform/eventBus.js';
import { ROLE_GRANT_MATRIX, parseCell } from '../seed/grants.js';

export interface GrantAddition {
  role: string;
  resource: string;
  verbs: string[];
  scope: string;
}

/**
 * Give a tenant the resources it has never had a row for.
 *
 * Deliberately blind to scope: a role holding `leads: V@all` and missing
 * `leads: CE@own` is *drift on a resource it already has*, which is the
 * reconciler's business and not this function's. Only a resource the role knows
 * nothing about is filled in.
 */
export async function addMissingGrants(tenantId: string): Promise<GrantAddition[]> {
  const added: GrantAddition[] = [];

  await asSystem(tenantId, async () => {
    const policyVersion = await prisma.policyVersion.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
    });

    for (const [slug, specs] of Object.entries(ROLE_GRANT_MATRIX)) {
      const role = await prisma.accessRole.findFirst({ where: { tenantId, slug } });
      if (!role) continue;

      const rows = await prisma.grant.findMany({ where: { tenantId, roleId: role.id } });
      const knownResources = new Set(rows.map((r) => r.resource));

      for (const spec of specs) {
        const parsed = parseCell(spec.cell);
        // An explicit absence in the matrix stays an absence: no row is the
        // representation of "may not", and writing one would invert it.
        if (!parsed) continue;
        if (knownResources.has(spec.resource)) continue;

        const created = await prisma.grant.create({
          data: {
            tenantId,
            principalType: 'role',
            roleId: role.id,
            policyVersionId: policyVersion?.id ?? null,
            resource: spec.resource,
            verbs: parsed.verbs,
            scope: parsed.scope,
            scopeResolver: spec.scopeResolver ?? null,
            conditions: (spec.conditions ?? {}) as never,
          },
        });

        // A permission change leaves the same trail whoever makes it.
        await emit({
          name: EVENTS.GRANT_CHANGED,
          subject: { entityType: 'grant', entityId: created.id },
          previousState: null,
          newState: { role: slug, resource: spec.resource, verbs: parsed.verbs, scope: parsed.scope },
          reason: {
            reasonCode: 'new_resource',
            note: 'The release declares a resource this tenant had no grant row for.',
          },
          impact: { domains: ['gov'], severity: 'S2_WARNING' },
        });

        added.push({ role: slug, resource: spec.resource, verbs: parsed.verbs, scope: parsed.scope });
        // Named individually: a permission appearing is worth a line of its own
        // in the log somebody reads after a deploy.
        console.log(`  grant added: ${slug} → ${spec.resource} ${parsed.verbs.join(',')}@${parsed.scope}`);
      }
    }
  });

  return added;
}

/** Every tenant, at boot, unless the operator has turned it off. */
export async function addMissingGrantsForAllTenants(): Promise<{ tenants: number; added: GrantAddition[] }> {
  if (!config.GRANT_AUTOSYNC) {
    return { tenants: 0, added: [] };
  }
  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
  const added: GrantAddition[] = [];
  for (const t of tenants) added.push(...(await addMissingGrants(t.id)));
  return { tenants: tenants.length, added };
}
