# Current work

**Active phase:** owner Phase 0, **Wave 0: foundations** (not yet closed; see Status). The Phase 0 session continues in the order below (DECISIONS round 23, item a).
**Source:** [`zen360/ORDERED-PLAN.md`](zen360/ORDERED-PLAN.md), Wave 0. Stop rule: [`zen360/ROADMAP.md`](zen360/ROADMAP.md) section 1a.

## Wave 0 items

Work in this order.

1. **0.7 Schema split and tooling.** Split the schema into `apps/api/prisma/schema/`. Keep `scripts/genmap.mjs` and `docs/plan/MAP.md` in step: regenerate after the split, and the CI check fails on a stale map. Add scoped test scripts, including `prisma validate` and a `migrate diff` no-drift check.
2. **0.1 Config and secrets.** `platform/config.ts` with Zod validation at load. Remove the fallback at `auth.ts:31` and `TENANT_ENFORCE_MODE` at `context.ts:94`. Add the FX-60 boot refusal at `privacy.ts:944-954`.
3. **Time helpers.** `packages/shared/src/time.ts`. Used for FX-40, FX-41 and FX-42 (see ORDERED-PLAN for the file lines).
4. **0.8 CI.** ESLint and Prettier. Remove the dead classes at `Start.tsx:100,109` and `People.tsx:56`. Build identity. Replace `db push` with a migration baseline.
   Not active: the Cloudflare Worker removal is done and stands (DECISIONS.md, round 19b, item 2). **Hosting** (server, reverse proxy, caching, routing) is undecided until after Phase 1 (round 18b, item 3). Until hosting is decided the app runs local only: no non-local deployment and no outside user (round 24 item h). See [`zen360/ORDERED-PLAN.md`](zen360/ORDERED-PLAN.md), "After Phase 1: hosting and operations (deferred)".

## Status (2026-10-12, round 23)

Checked against the code on 2026-10-12. The plan follows the code (DECISIONS.md, round 23, item a). Item-level status is in [`zen360/ORDERED-PLAN.md`](zen360/ORDERED-PLAN.md), with a status tag on each checked item.

Built and checked:

- 0.7: schema split, `scripts/genmap.mjs`, `docs/plan/MAP.md`, `db:validate` and `db:drift` (CI runs both: `.github/workflows/ci.yml:42` and `:91`).
- 0.1: `platform/config.ts` loads through a Zod schema. The `lib/auth.ts` fallback is gone and `TENANT_ENFORCE_MODE` is absent from source. Open: the FX-60 refusal applies only in production today (`platform/config.ts:150`). Ruled in round 24 item b: it applies in every environment. The code change belongs to the Phase 0 session.
- Time helpers: `packages/shared/src/time.ts`, used for FX-40, FX-41 and FX-42.
- 0.8 (part): ESLint; Prettier (CI runs `pnpm format:check`, `ci.yml:47`); build identity; migration baseline.
- 0.2: sessions with `jti`, 15-minute access token, hashed refresh token.
- 0.3 and 0.4: helmet, CORS allowlist, express-rate-limit with a Postgres store, pino.

Open in Wave 0:

- 0.8: dead classes at `Start.tsx:100,109` and `People.tsx:56` are not confirmed. `db push` still runs in `apps/api/docker-entrypoint.sh:30`.
- 0.1: FX-60 refusal in every environment (round 24 item b). The code still checks production only (`config.ts:150`). The dev key is commented out in `apps/api/.env.example:17`.
- 0.3 and 0.4: error-leak fix and G11 redaction test not located.
- 0.5 scheduler is built; the croner licence check is still open.
- CI does not set `FIELD_ENCRYPTION_KEY` (`.github/workflows/ci.yml`), so G5's "CI must supply" requirement is not met (round 24 item b: CI must supply one).
- G6 and G10 are not built.

Retired: the "pending CI on the PR" line (the branch is an ancestor of `origin/main`), and the "Prettier reformat deferred" line (`format:check` runs in CI).

## Remaining Phase 0 money work (round 24 item e)

- Migrate the roughly 250 `Decimal(18,2)` money columns outside the ledger to bigint paise before Phase 0 closes: items 1.5 (cashbook, `model Transaction`) and 1.6 (`round2`, `finance.ts:150`), with trial-balance assertions. Owner wording: "ledger first". RULED 2026-10-12: money comes first; ORDERED principle 1 (money before ledger) stands (see DECISIONS.md, round 24 follow-up).

## Exit criteria (Wave 0)

- Boot without `JWT_SECRET` exits, naming the variable. Without `FIELD_ENCRYPTION_KEY` the process refuses to boot, in every environment (round 24 item b).
- `fyOf(2026-03-31T19:00Z) === '2026-27'` passes.
- `prisma validate` and the migration no-drift check pass.
- Gates G1, G2 and G3 run in CI.
- Wave is closed when the items above are merged and these gates pass. Then Wave 1 starts.

## Rules for this work

- **Failing test first, in its own commit.** Every stop-ship fix starts with a test that fails on the old code (ORDERED-PLAN principle 6).
- Follow the rules in `CLAUDE.md`. In particular: IST for dates (rule 3, time helpers), no hardcoded statutory values (rule 4), and no writes outside `assertCan`, write, `auditWrite`, `emit` (rule 5).
- Statutory uncertainty means stop and flag it, not guess (ORDERED-PLAN principle 8).
- `zen360/DECISIONS.md` governs where it differs from ORDERED-PLAN.

## Not in scope

Wave 0 does not include Wave 1 onwards (authority, audit, sessions, statutory master pack, scheduler, money, ledger, interface, onboarding, proof). It also excludes everything in the deferred table in [`zen360/ROADMAP.md`](zen360/ROADMAP.md) section 2, and the items in the "Tbd during onboard" section 3. Tenancy and hosting items (round 18b) are not in scope, even where the status note above mentions them.

## Updating this file

Update this file when a wave closes. Move the "Active phase" line to the next wave, replace the item list and exit criteria from ORDERED-PLAN, and record the closing date in DECISIONS.md if the owner answered anything during the wave.
