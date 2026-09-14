/**
 * `Tenant.kind` is never trusted as written — it is recomputed from the
 * parent/child rows that actually exist, every time this runs (end of every
 * bootstrap, and at API boot beside nav and grant sync). A hand-set flag
 * drifts the moment a subsidiary is added or removed; a computed one cannot.
 *
 * The rule (equity-portal plan §6, phase 0 item 2): a tenant with a
 * `parentTenantId` is a `subsidiary`; a tenant any other tenant names as
 * parent is a `holding`; anything else is `standalone`.
 *
 * The moment a tenant is first found to be a holding or a subsidiary, s.2(85)
 * ends its "small company" status regardless of size (§1a.1) — four board
 * meetings a year with a ≤120-day gap instead of two, MGT-7 instead of
 * MGT-7A, and Rule 9B dematerialisation becomes mandatory. That is raised
 * once, as a compliance exception, and recorded on the tenant so it is never
 * raised twice.
 */

import { EVENTS, type TenantKind } from '@kaizen/shared';
import { unscopedPrisma } from './db.js';
import { asSystem } from './context.js';
import { emit } from './eventBus.js';
import { raiseException } from './exceptions.js';

export interface TenantKindChange {
  tenantId: string;
  slug: string;
  from: string;
  to: TenantKind;
}

function kindFor(tenantId: string, parentTenantId: string | null, isNamedAsParent: boolean): TenantKind {
  if (parentTenantId) return 'subsidiary';
  if (isNamedAsParent) return 'holding';
  return 'standalone';
}

/** Recomputes `kind` for every tenant, raising the §1a.1 notice on a first flip to holding/subsidiary. Safe to run repeatedly. */
export async function reconcileTenantKinds(): Promise<TenantKindChange[]> {
  const tenants = await unscopedPrisma.tenant.findMany({
    select: { id: true, slug: true, kind: true, parentTenantId: true, config: true },
  });
  const parentIds = new Set(tenants.map((t) => t.parentTenantId).filter((id): id is string => Boolean(id)));

  const changes: TenantKindChange[] = [];

  for (const tenant of tenants) {
    const nextKind = kindFor(tenant.id, tenant.parentTenantId, parentIds.has(tenant.id));
    if (nextKind === tenant.kind) continue;

    await unscopedPrisma.tenant.update({ where: { id: tenant.id }, data: { kind: nextKind } });
    changes.push({ tenantId: tenant.id, slug: tenant.slug, from: tenant.kind, to: nextKind });

    await asSystem(tenant.id, async () => {
      await emit({
        name: EVENTS.TENANT_KIND_CHANGED,
        subject: { entityType: 'tenant', entityId: tenant.id },
        previousState: { kind: tenant.kind },
        newState: { kind: nextKind },
        impact: { domains: ['sys'], severity: 'S2_WARNING' },
      });

      if (nextKind === 'standalone') return;

      const config = (tenant.config as { smallCompanyNoticeRaisedAt?: string } | null) ?? {};
      if (config.smallCompanyNoticeRaisedAt) return;

      const chairman = await unscopedPrisma.affiliation.findFirst({
        where: { tenantId: tenant.id, roleSlug: 'chairman', status: 'active' },
        orderBy: { primaryFlag: 'desc' },
      });

      await raiseException({
        code: 'EX-EQT-001',
        label: 'Small company status ended by group structure',
        severity: 'S2_WARNING',
        subjectType: 'tenant',
        subjectId: tenant.id,
        subjectLabel: tenant.slug,
        domain: 'eqt',
        detail:
          `This entity is now a ${nextKind}. Section 2(85) excludes a holding and a subsidiary company from ` +
          '"small company" status regardless of size: four board meetings a year with no more than a ' +
          '120-day gap (instead of two), MGT-7 instead of MGT-7A for the annual return, and Rule 9B ' +
          'dematerialisation becomes mandatory. A company secretary should confirm before this changes ' +
          'anything filed.',
        reasonCode: 'small_company_status_ended',
        ownerPartyId: chairman?.partyId ?? null,
      });

      await unscopedPrisma.tenant.update({
        where: { id: tenant.id },
        data: { config: { ...((tenant.config as object) ?? {}), smallCompanyNoticeRaisedAt: new Date().toISOString() } as never },
      });
    });
  }

  return changes;
}
