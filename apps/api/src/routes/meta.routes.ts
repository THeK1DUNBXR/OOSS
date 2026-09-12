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
import { BUILD, STARTED_AT, buildLabel } from '../platform/build.js';
import { NAV_REGISTRY } from '../seed/bootstrap.js';

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
    const behind = BUILD.sequence > 0 && seedBuild > 0 ? BUILD.sequence - seedBuild : 0;

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
      seedBehindBy: behind > 0 ? behind : 0,
      /** What a current seed would write, so a mismatch in the count shows. */
      expected: { navNodes: NAV_REGISTRY.length },
    };
  }),
);

export default router;
