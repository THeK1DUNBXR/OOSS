# Chairman's Office — test files

Phase 0 owns `foundation.test.ts` (`CEO-FOUND-*`). Each implementation phase
(1-9) owns exactly one file of its own here, named after its area, and no
other phase's file:

- `cockpit.test.ts` — Phase 1, `CEO-COC-*`
- `strategy.test.ts` — Phase 2, `CEO-STR-*`
- `initiatives.test.ts` — Phase 3, `CEO-INI-*`
- `rhythm.test.ts` — Phase 4, `CEO-RHY-*`
- `doa.test.ts` — Phase 5, `CEO-DOA-*`
- `board.test.ts` — Phase 6, `CEO-BRD-*`
- `risk.test.ts` — Phase 7, `CEO-RSK-*`
- `finance.test.ts` — Phase 8, `CEO-FIN-*`
- `people.test.ts` — Phase 9, `CEO-PPL-*`

Every test runs inside a real request context against a real database,
through `asUser`/`withFixtureRole` in `apps/api/src/tests/helpers.ts` — see
`docs/plan/ceo-office.md` §7 for the full set of conventions each phase holds
to, including the rule that a phase's own test file must set up whatever
tenant/fixture data it needs itself, since phases build in separate
worktrees and only meet at merge time.
