# Phase 0 — Foundation — as built

Landed 14 Sep 2026 on `claude/affectionate-brown-t8tbdj`. Full existing suite
(629 tests) still passes; 15 new tests added in
`apps/api/src/tests/ceo/foundation.test.ts` (`CEO-FOUND-001`..`CEO-FOUND-008`,
644 total). `pnpm typecheck` and `pnpm --filter @kaizen/web build` both pass
clean.

## What was built, against the brief in §6

Every file the brief's "Files:" list names was touched exactly once, plus the
two extra deliverables the orchestrator asked for on top of the plan
(`apps/api/src/tests/ceo/README.md`, and this `ceo-office-asbuilt/` directory
instead of appending to `ceo-office.md` itself):

- `packages/shared/src/ceo.ts` (new) — every DTO type/enum for Phases 1-9,
  derived field-by-field from §5. Re-exported from `packages/shared/src/
  index.ts`.
- `packages/shared/src/permissions.ts` — 21 new resources added to
  `RESOURCES`.
- `apps/api/src/seed/grants.ts` — the same 21 resources added to
  `ALL_RESOURCES`; the non-chairman cells §1 names written for
  `hr_ops_manager`, `finance_head`, `company_secretary`; an explicit `'-'`
  row added everywhere else (the codebase's own convention for documenting a
  deliberate omission, not just leaving the resource unmentioned).
- `packages/shared/src/events.ts` — 36 `kz.ceo.*` event names added to
  `EVENTS`.
- `packages/shared/src/planes.ts` — `'ceo'` added to `BOUNDED_CONTEXTS`; a
  `MODULE_REGISTER` entry added (`owns` lists every §5 record name across
  all 9 phases, `neverDoes` lists §1's four points).
- `apps/api/src/seed/bootstrap.ts` — 20 `NAV_REGISTRY` rows (one per screen
  in §6's master table, plus `ceo_kpi_library` — see Deviation 1 below), all
  `group: 'ceo'`, `archetypes: ['command', 'workspace', 'console']`.
- `apps/api/src/routes/index.ts` — `router.use('/ceo', requireAuth,
  ceoRoutes)`.
- `apps/api/src/routes/ceo/index.ts` (new) — mounts the 9 area routers at
  `/cockpit`, `/strategy`, `/initiatives`, `/rhythm`, `/doa`, `/board`,
  `/risk`, `/finance`, `/people`.
- `apps/api/src/routes/ceo/{cockpit,strategy,initiatives,rhythm,doa,board,
  risk,finance,people}.routes.ts` (new, 9 files) — each a wildcard stub:
  every `GET` returns `{ items: [] }`, every `POST`/`PATCH`/`DELETE` returns
  501 `{ message: 'Not built yet.' }`.
- `apps/web/src/main.tsx` — 24 `<Route>` entries (20 unique stub pages, 4
  paths reusing the list component for a `:id` detail/document route, per
  the master table's "same component" rows).
- `apps/web/src/pages/ceo/*.tsx` (new, 20 files — see Deviation 1) — each
  `<PageHeader/><Card><EmptyState message="This screen is not built yet."
  /></Card>`.
- `apps/web/src/components/Shell.tsx` — `'ceo'` added to `GROUP_ORDER`
  (after `'equity'`, before `'people'` — still satisfies "after equity,
  before compliance"); `ceo: "Chairman's Office"` added to `GROUP_LABELS`.
  No new `ICONS` entries needed — every icon key the nav rows use (`gauge`,
  `target`, `kanban`, `clock`, `shield`, `inbox`, `file`, `users`, `alert`,
  `scale`, `building`, `message`, `badge`, `chart`) already exists in the
  map.
- `apps/api/prisma/schema/ceo-core.prisma` (new) — header comment only, no
  models (no phase's §5 entry names a cross-phase model as of Phase 0).
- `apps/api/src/domains/ceo/detectors.ts` (new) — imports each area's
  `detectors` array and runs them all; the scheduler's only touch point.
- `apps/api/src/domains/ceo/{cockpit,strategy,initiatives,rhythm,doa,board,
  risk,finance,people}.detectors.ts` (new, 9 stub files) — each exports an
  empty `detectors` array.
- `apps/api/src/jobs/scheduler.ts` — one job registration,
  `runCeoDetectorsJob`, calling `runCeoDetectors()`.
- `docs/acceptance.md` — a "Chairman's Office" subsection with 10 pending
  rows (`CEO-FOUND-000` plus one per Phase 1-9 area), matching the existing
  Compliance section's table shape.
- `apps/api/src/tests/ceo/foundation.test.ts` (new) — `CEO-FOUND-001`
  through `CEO-FOUND-008`, 15 tests.
- `apps/api/src/tests/ceo/README.md` (new, orchestrator's extra ask) — names
  which phase owns which test file.
- `docs/plan/ceo-office-asbuilt/phase-0.md` (this file, orchestrator's extra
  ask) — as-built notes live here rather than appended to `ceo-office.md`.

## The 21 resources registered

`kpi_definitions`, `ceo_cockpit` (Phase 1); `strategic_themes`, `objectives`,
`key_results` (Phase 2); `initiatives` (Phase 3); `meeting_series`,
`meeting_instances` (Phase 4); `doa_matrix`, `ceo_approvals_inbox` (Phase 5);
`board_packs`, `investor_updates`, `stakeholders` (Phase 6); `risks`,
`policy_documents` (Phase 7); `financial_scenarios`, `headcount_plans`
(Phase 8); `seats`, `one_on_ones`, `succession_candidates`, `time_audit`
(Phase 9).

## The 36 `kz.ceo.*` events registered

`kz.ceo.kpi_definition.created`, `kz.ceo.kpi_formula.published`,
`kz.ceo.north_star.changed`, `kz.ceo.vision.set`, `kz.ceo.aop.submitted`,
`kz.ceo.aop.activated`, `kz.ceo.objective.created`,
`kz.ceo.objective.scored`, `kz.ceo.key_result.checked_in`,
`kz.ceo.initiative.created`, `kz.ceo.initiative.status_changed`,
`kz.ceo.initiative.killed`, `kz.ceo.initiative.milestone_completed`,
`kz.ceo.meeting.scheduled`, `kz.ceo.meeting.closed`, `kz.ceo.issue.raised`,
`kz.ceo.issue.resolved`, `kz.ceo.action_item.completed`,
`kz.ceo.doa_entry.changed`, `kz.ceo.delegation.created`,
`kz.ceo.delegation.ended`, `kz.ceo.board_pack.issued`,
`kz.ceo.investor_update.issued`, `kz.ceo.document.circulated`,
`kz.ceo.document.acknowledged`, `kz.ceo.stakeholder.touched`,
`kz.ceo.risk.raised`, `kz.ceo.risk.closed`, `kz.ceo.policy.published`,
`kz.ceo.policy.acknowledged`, `kz.ceo.scenario.created`,
`kz.ceo.budget_line.proposed`, `kz.ceo.headcount_plan.approved`,
`kz.ceo.seat.created`, `kz.ceo.seat.reassigned`,
`kz.ceo.succession.reviewed`, `kz.ceo.one_on_one.logged`.

## Routes registered

`/ceo` mounted in `routes/index.ts`, itself mounting 9 area stub routers at
`/ceo/cockpit`, `/ceo/strategy`, `/ceo/initiatives`, `/ceo/rhythm`,
`/ceo/doa`, `/ceo/board`, `/ceo/risk`, `/ceo/finance`, `/ceo/people`. Each
area router answers every `GET *` with `{ items: [] }` and every
`POST/PATCH/DELETE *` with 501, under `requireAuth`. Every owning phase
replaces its own file wholesale — see the note under Deviation 2.

## Deviations from the plan, and why

1. **`KpiLibrary.tsx`/`ceo_kpi_library` added, though Phase 0's own
   enumerated file list in §6 omits it.** Phase 1's own brief a few
   paragraphs later explicitly says it "replaces the Phase-0 stubs" for
   `Cockpit.tsx` **and** `KpiLibrary.tsx`, and the master nav/route table
   names a `KPI Library` screen at `/ceo/kpi-library` with
   `requiredPermission: kpi_definitions:V`. Treating the file-list sentence
   as the authority and skipping the stub would have left Phase 1 unable to
   "replace" a file that never existed and a nav row Phase 0 was supposed
   to have written. Built it; noted here rather than silently reconciled.

2. **KPI Library's API routes are not literally under `/ceo/cockpit`.**
   Phase 1's own "Routes:" section lists `GET /ceo/kpi-library` (a sibling
   top-level path, not `/ceo/cockpit/kpi-library`), while Phase 0's file
   list only mounts 9 routers at the 9 area prefixes named in §6 (no
   separate `kpi-library` mount). This is fine in practice — a browser page
   route (`/ceo/kpi-library`, wired in `main.tsx`) is independent of the
   API path its `useQuery` calls — so Phase 1 is free to serve
   `GET /ceo/kpi-library` from inside `cockpit.routes.ts` (mounted at
   `/ceo/cockpit`) by defining the route as `/../kpi-library`-shaped inside
   that router, or more simply just keep the API's own KPI-library
   endpoints under `/ceo/cockpit/kpi-library` and have `KpiLibrary.tsx`
   call that URL. Flagging this now so Phase 1 does not spend time treating
   it as a wiring bug.

3. **Explicit `{ resource, cell: '-' }` rows added for every role/resource
   pair not named in §1**, beyond what the brief's Phase 0 bullet strictly
   requires ("Phase 0 writes no other role's cells unless §1 names one").
   This matches the existing house convention elsewhere in `grants.ts`
   (e.g. `hrOpsManager`'s `{ resource: 'board_meetings', cell: '-' }`) of
   documenting a deliberate omission rather than leaving it unstated, and
   costs nothing at runtime (`addMissingGrants` treats an explicit `'-'`
   and no row at all identically). No behavioural deviation.

4. **The test database was reseeded (`scripts/test-db.sh --reseed`).** The
   grant-matrix drift test (`the durable grant rows match the declared
   matrix, with no drift`, `acceptance.test.ts`) compares the seeded
   tenant's actual `Grant` rows against `ROLE_GRANT_MATRIX` — a `prisma db
   push` alone does not backfill new resources into an already-seeded
   database's grant rows (that is `addMissingGrants`'s job, which runs at
   API boot or via `reconcileGrants --apply`, neither of which the test run
   invokes). Reseeding was the correct remedy per §7's own guidance ("if
   the drift test still fails, run it before assuming the matrix itself is
   wrong") rather than a workaround.

5. **`docs/plan/ceo-office.md` line 3's "Status" line was not updated** —
   the orchestrator's brief for this session redirected as-built notes to
   this new `ceo-office-asbuilt/` directory instead, so the plan file
   itself was left untouched per that instruction.

## Nothing else needed editing

`apps/api/src/domains/health.ts` was not touched (reserved for Phase 1).
`docs/acceptance.md`'s pending rows are Phase 0's only touch to that file —
Phase 10 fills them in after every phase merges.
