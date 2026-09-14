/**
 * Technology — continuity and operations seed (docs/plan/cio.md, workstream H).
 *
 * This workstream's only dated defaults are the DR-test cadence (180 days
 * for a tier-1 application, 365 for everything else) and the overdue ladder
 * rungs (-7 / 0 / +30 days). Both live as plain exported constants in
 * `packages/shared/src/it/continuity.ts` (`DEFAULT_TEST_CADENCE_DAYS`,
 * `TEST_OVERDUE_LADDER_RUNGS`) rather than a database table: unlike the
 * compliance calendar's due-date rules or the service desk's SLA policy,
 * there is no natural "as of" date these have ever changed on, and no
 * per-tenant variant the domain layer is asked to read as of a point in
 * time — they are read straight out of shared at plan-creation and job-run
 * time. If the company ever wants to vary them by tenant or effective date,
 * that is a small follow-up (a dated `ItContinuityCadence` table), not a
 * gap in this seed.
 *
 * There is nothing else to seed: this workstream cannot see the application
 * catalogue (workstream B, a different schema file — see it-continuity.prisma's
 * header), so it has no rows of its own to create ahead of time. A demo
 * tenant is expected to create its first continuity plans through the API,
 * naming the application by hand until the catalogue join lands.
 */

export async function seedContinuity(): Promise<void> {
  // Intentionally a no-op beyond existing — see the header. Kept as an
  // async function (rather than removed) so `seed/it/index.ts` can import
  // and call it uniformly with every other workstream's seed, and so a
  // future dated table has a natural home to be upserted from.
}
