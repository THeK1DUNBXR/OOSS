# Current work

**Active phase:** owner Phase 0, **Wave 0: foundations.**
**Source:** [`zen360/ORDERED-PLAN.md`](zen360/ORDERED-PLAN.md), Wave 0. Stop rule: [`zen360/ROADMAP.md`](zen360/ROADMAP.md) section 1a.

## Wave 0 items

Work in this order.

1. **0.7 Schema split and tooling.** Split the schema into `apps/api/prisma/schema/`. Keep `scripts/genmap.mjs` and `docs/plan/MAP.md` in step: regenerate after the split, and the CI check fails on a stale map. Add scoped test scripts, including `prisma validate` and a `migrate diff` no-drift check.
2. **0.1 Config and secrets.** `platform/config.ts` with Zod validation at load. Remove the fallback at `auth.ts:31` and `TENANT_ENFORCE_MODE` at `context.ts:94`. Add the FX-60 boot refusal at `privacy.ts:944-954`.
3. **Time helpers.** `packages/shared/src/time.ts`. Used for FX-40, FX-41 and FX-42 (see ORDERED-PLAN for the file lines).
4. **0.8 CI.** ESLint and Prettier. Remove the dead classes at `Start.tsx:100,109` and `People.tsx:56`. Build identity. Replace `db push` with a migration baseline.
5. **Hosting.** Remove the Cloudflare Worker (`worker/index.ts`). Serve everything from the own server behind Caddy.

## Exit criteria (Wave 0)

- Boot without `JWT_SECRET` exits, naming the variable. Production without `FIELD_ENCRYPTION_KEY` throws.
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

Wave 0 does not include Wave 1 onwards (authority, audit, sessions, statutory master pack, scheduler, money, ledger, interface, onboarding, proof). It also excludes everything in the deferred table in [`zen360/ROADMAP.md`](zen360/ROADMAP.md) section 2, and the items in the "Tbd during onboard" section 3.

## Updating this file

Update this file when a wave closes. Move the "Active phase" line to the next wave, replace the item list and exit criteria from ORDERED-PLAN, and record the closing date in DECISIONS.md if the owner answered anything during the wave.
