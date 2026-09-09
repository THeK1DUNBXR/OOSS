/**
 * Reconciles the durable GRANT rows against the declared matrix.
 *
 * The seed deliberately never overwrites an existing GRANT: re-running a
 * deployment must not silently rewrite a tenant's permission state. That leaves
 * a real question — how a *deliberate* matrix change reaches a tenant that has
 * already been seeded — and this is the answer to it.
 *
 * It is a separate, explicit step, it prints the diff before it touches
 * anything, it requires `--apply` to write, and every write emits
 * `kz.gov.grant.changed` carrying the before and after. A permission change is
 * a governed act, so it leaves the same trail as any other.
 *
 *   tsx src/seed/reconcileGrants.ts            # report only
 *   tsx src/seed/reconcileGrants.ts --apply    # report, then apply
 */

import { EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { registerSubscribers } from '../events/handlers.js';
import { ROLE_GRANT_MATRIX, parseCell } from './grants.js';

type Change =
  | { kind: 'add'; role: string; resource: string; verbs: string[]; scope: string; scopeResolver: string | null }
  | { kind: 'update'; role: string; resource: string; from: Record<string, unknown>; to: Record<string, unknown>; id: string }
  | { kind: 'revoke'; role: string; resource: string; id: string };

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export async function planFor(tenantId: string): Promise<Change[]> {
  const changes: Change[] = [];

  for (const [slug, specs] of Object.entries(ROLE_GRANT_MATRIX)) {
    const role = await prisma.accessRole.findFirst({ where: { tenantId, slug } });
    if (!role) continue;

    const rows = await prisma.grant.findMany({ where: { tenantId, roleId: role.id } });
    // Keyed on resource AND scope: a resource may hold two cells, a wide read
    // beside a narrow write. Keyed on resource alone, the reconciler compared
    // the first row against the second cell and reported drift on a freshly
    // seeded database.
    const key = (resource: string, scope: string) => `${resource}@${scope}`;
    const byCell = new Map(rows.map((r) => [key(r.resource, r.scope), r]));
    const declared = new Set<string>();

    for (const spec of specs) {
      const parsed = parseCell(spec.cell);
      // An explicit absence stays an absence: no row is the representation.
      if (!parsed) continue;
      declared.add(key(spec.resource, parsed.scope));

      const existing = byCell.get(key(spec.resource, parsed.scope));
      const resolver = spec.scopeResolver ?? null;

      if (!existing) {
        changes.push({ kind: 'add', role: slug, resource: spec.resource, verbs: parsed.verbs, scope: parsed.scope, scopeResolver: resolver });
        continue;
      }

      const drifted =
        !same(existing.verbs, parsed.verbs) ||
        existing.scope !== parsed.scope ||
        (existing.scopeResolver ?? null) !== resolver;

      if (drifted) {
        changes.push({
          kind: 'update',
          role: slug,
          resource: spec.resource,
          id: existing.id,
          from: { verbs: existing.verbs, scope: existing.scope, scopeResolver: existing.scopeResolver },
          to: { verbs: parsed.verbs, scope: parsed.scope, scopeResolver: resolver },
        });
      }
    }

    // A row the matrix no longer declares is a revocation, and is reported as
    // one rather than quietly left in place.
    for (const row of rows) {
      if (!declared.has(key(row.resource, row.scope))) {
        changes.push({ kind: 'revoke', role: slug, resource: row.resource, id: row.id });
      }
    }
  }

  return changes;
}

async function apply(changes: Change[], tenantId: string, policyVersionId: string | null) {
  for (const c of changes) {
    if (c.kind === 'add') {
      const created = await prisma.grant.create({
        data: {
          tenantId,
          principalType: 'role',
          roleId: (await prisma.accessRole.findFirstOrThrow({ where: { tenantId, slug: c.role } })).id,
          resource: c.resource,
          verbs: c.verbs,
          scope: c.scope,
          scopeResolver: c.scopeResolver,
          policyVersionId,
        },
      });
      await emit({
        name: EVENTS.GRANT_CHANGED,
        subject: { entityType: 'grant', entityId: created.id },
        previousState: null,
        newState: { role: c.role, resource: c.resource, verbs: c.verbs, scope: c.scope, scopeResolver: c.scopeResolver },
        reason: { reasonCode: 'matrix_reconcile', note: 'Declared matrix added this grant.' },
        impact: { domains: ['gov'], severity: 'S2_WARNING' },
      });
    } else if (c.kind === 'update') {
      await prisma.grant.update({
        where: { id: c.id },
        data: { verbs: c.to.verbs as string[], scope: c.to.scope as string, scopeResolver: (c.to.scopeResolver ?? null) as string | null },
      });
      await emit({
        name: EVENTS.GRANT_CHANGED,
        subject: { entityType: 'grant', entityId: c.id },
        previousState: c.from,
        newState: { role: c.role, resource: c.resource, ...c.to },
        reason: { reasonCode: 'matrix_reconcile', note: 'Declared matrix changed this grant.' },
        impact: { domains: ['gov'], severity: 'S2_WARNING' },
      });
    } else {
      await prisma.grant.delete({ where: { id: c.id } });
      await emit({
        name: EVENTS.GRANT_CHANGED,
        subject: { entityType: 'grant', entityId: c.id },
        previousState: { role: c.role, resource: c.resource },
        newState: null,
        reason: { reasonCode: 'matrix_reconcile', note: 'Declared matrix no longer grants this resource.' },
        impact: { domains: ['gov'], severity: 'S2_WARNING' },
      });
    }
  }
}

async function main() {
  const applying = process.argv.includes('--apply');
  registerSubscribers();

  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true, slug: true } });

  for (const tenant of tenants) {
    await asSystem(tenant.id, async () => {
      const changes = await planFor(tenant.id);

      if (!changes.length) {
        console.log(`${tenant.slug}: grants match the declared matrix.`);
        return;
      }

      console.log(`\n${tenant.slug}: ${changes.length} difference(s) from the declared matrix`);
      for (const c of changes) {
        if (c.kind === 'add') console.log(`  + ${c.role.padEnd(22)} ${c.resource}  ${c.verbs.join(',')}@${c.scope}${c.scopeResolver ? ` [${c.scopeResolver}]` : ''}`);
        else if (c.kind === 'update') console.log(`  ~ ${c.role.padEnd(22)} ${c.resource}  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
        else console.log(`  - ${c.role.padEnd(22)} ${c.resource}`);
      }

      if (!applying) {
        console.log('\n  Report only. Re-run with --apply to write these changes.');
        return;
      }

      const pv = await prisma.policyVersion.findFirst({ where: { tenantId: tenant.id }, orderBy: { version: 'desc' } });
      await apply(changes, tenant.id, pv?.id ?? null);
      console.log(`\n  Applied ${changes.length} change(s); each emitted ${EVENTS.GRANT_CHANGED}.`);
    });
  }
}

// Importable as a drift detector; only runs when invoked as a script.
if (process.argv[1]?.endsWith('reconcileGrants.ts') || process.argv[1]?.endsWith('reconcileGrants.js')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
