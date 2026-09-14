/**
 * The group surface (equity-portal plan §3.3). Phase 2's consolidated
 * dashboard is not built in this worktree; the one thing here is the
 * read-only spin-out preview (§6b) — the same preview `pnpm division:spin-out`
 * prints, scoped to the caller's own tenant.
 *
 * `previewSpinOut` is called with `deep: false`: a request never reads past
 * the `Tenant` row of a tenant that is not its own (see `spinOutEngine.ts`).
 * The commit itself is never reachable from here — it is a deliberate script,
 * not a button.
 */

import { DIVISIONS, type Division } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { previewSpinOut, type SpinOutPreview } from '../seed/spinOutEngine.js';

const SPINOUT_DIVISIONS = DIVISIONS.filter((d) => d !== 'shared') as Division[];

export async function spinOutPreview(divisionInput: string | undefined): Promise<SpinOutPreview> {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'create' });

  if (!divisionInput || !SPINOUT_DIVISIONS.includes(divisionInput as Division)) {
    throw ApiError.badRequest(`division must be one of: ${SPINOUT_DIVISIONS.join(', ')}.`);
  }

  return previewSpinOut(auth.tenantId, divisionInput as Division, false);
}

export interface SpinOutDivisionSummary {
  division: Division;
  carriedTotal: number;
  refusedTotal: number;
  command: string;
}

export interface SpinOutDivisionsView {
  tenantKind: string;
  divisions: SpinOutDivisionSummary[];
}

/** The "Divisions" card on the cap table: one row per division not yet its own subsidiary. */
export async function spinOutDivisionsSummary(): Promise<SpinOutDivisionsView> {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'create' });

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  if (tenant.kind !== 'holding' && tenant.kind !== 'standalone') {
    return { tenantKind: tenant.kind, divisions: [] };
  }

  const divisions: SpinOutDivisionSummary[] = [];
  for (const division of SPINOUT_DIVISIONS) {
    const preview = await previewSpinOut(auth.tenantId, division, false);
    if (preview.subsidiary) continue; // already incorporated — nothing to preview
    const carriedTotal = Object.values(preview.carried).reduce((sum, b) => sum + (b?.count ?? 0), 0);
    const refusedTotal = Object.values(preview.refused).reduce((sum, b) => sum + (b?.count ?? 0), 0);
    divisions.push({
      division,
      carriedTotal,
      refusedTotal,
      command: `pnpm --filter @kaizen/api division:spin-out --from ${tenant.slug} --division ${division} --to <subsidiary-slug>`,
    });
  }

  return { tenantKind: tenant.kind, divisions };
}
