/**
 * What is actually running, and against what data.
 *
 * One endpoint, read by the footnote on every screen. It answers the question
 * that costs an hour when nothing answers it: is the thing in front of me the
 * thing I just changed?
 *
 * Three sequences, because three things go stale independently — the API, the
 * web bundle (which reports its own, built into it) and the tenant's seeded
 * data. Any two of them disagreeing is worth seeing before anybody starts
 * debugging the code.
 */

import { Router } from 'express';
import { handler } from '../lib/http.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { BUILD, STARTED_AT, buildLabel, buildsBehind } from '../platform/build.js';
import { NAV_REGISTRY } from '../seed/bootstrap.js';
import { planFor } from '../seed/reconcileGrants.js';

const router = Router();

export interface SeedStamp {
  sequence: number;
  at: string | null;
  build: number | null;
  commit: string | null;
  navNodes: number | null;
}

router.get(
  '/version',
  handler(async () => {
    const auth = currentAuth();
    const tenant = await prisma.tenant.findFirst({
      where: { id: auth.tenantId },
      select: { config: true },
    });
    const seed = ((tenant?.config as { seed?: Partial<SeedStamp> } | null)?.seed ?? null) as
      | Partial<SeedStamp>
      | null;

    // Has the seed run since this build was deployed? The one that catches a
    // vocabulary change that never reached the tenant.
    const seedBuild = Number(seed?.build ?? 0);
    const behind = buildsBehind(BUILD.sequence, seedBuild);

    return {
      api: { ...BUILD, label: buildLabel(), startedAt: STARTED_AT },
      seed: seed
        ? {
            sequence: Number(seed.sequence ?? 0),
            at: seed.at ?? null,
            build: seedBuild || null,
            commit: seed.commit ?? null,
            navNodes: Number(seed.navNodes ?? 0) || null,
          }
        : null,
      /**
       * How many builds have gone out since this tenant was last seeded. Zero
       * is current; anything else means the seeded rows — grants, navigation,
       * vocabulary — may be from an older shape than the code reading them.
       */
      seedBehindBy: behind,
      /** What a current seed would write, so a mismatch in the count shows. */
      expected: { navNodes: NAV_REGISTRY.length },

      /**
       * Permission changes the declared matrix wants and this tenant has not
       * had applied.
       *
       * Boot fills in resources a role has never had a row for, which is what
       * makes a newly shipped screen usable. It deliberately does not change or
       * revoke an existing grant — that stays a governed act — so anything left
       * here is waiting for somebody to run the reconciler on purpose. Reported
       * rather than silent: a permission that is not what the matrix says is
       * invisible until the day it matters.
       */
      grants: await pendingGrantChanges(auth.tenantId),
    };
  }),
);

async function pendingGrantChanges(tenantId: string): Promise<{
  pending: number;
  changed: number;
  revoked: number;
}> {
  try {
    const plan = await planFor(tenantId);
    return {
      pending: plan.length,
      changed: plan.filter((c) => c.kind === 'update').length,
      revoked: plan.filter((c) => c.kind === 'revoke').length,
    };
  } catch {
    // A diagnostic that cannot be computed must not take the screen down with
    // it: the footnote simply has nothing to say about grants.
    return { pending: 0, changed: 0, revoked: 0 };
  }
}

export default router;
