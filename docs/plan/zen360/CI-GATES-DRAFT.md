Drafted by Claude; approved by owner 2026-10-10 (see Status). 00-BRIEF.md section 5 is missing from this branch; this is NOT a reconstruction of it.

# CI gates and ledger gate tests: draft

Status: Approved by owner 2026-10-10 with the decisions below; still uses UNVERIFIED markers where flagged. Decisions: DECISIONS.md "Owner answers, round 9 (recorded 2026-10-10)" and "Owner answers, round 10 (recorded 2026-10-10)". Approval covers gates G1 to G12 (G11 and G12 added in round 9). Round 10 approves the ledger gate tests L1 to L3 as the required ledger gate, requires both governed-write checks (G8 checks a and b), and places the CI migration baseline in Wave 0 (G3); see section 5. Adding a gate to `.github/workflows/ci.yml`, `eslint.config.js` or the test suite is still a separate change, made in its own pull request.

Scope: the ten CI gates that DECISIONS.md "Owner answers, round 5" asked Claude to define fresh, plus the three ledger gate tests named in `docs/plan/archive/phase-1-ledger.md` (gate line) and `docs/plan/archive/phase-8-proof.md`. The round 5 answer is: "The ten CI gates and the ledger gate tests are to be defined fresh. Claude will draft them for owner approval."

Sources and how to read them:

- Every claim about the repository is cited `file:line` or to a doc. Line numbers taken from `zen360/FIXES.md` were not re-opened in this drafting pass and are marked "(cited from FIXES.md)".
- Anything not verified in the docs or the code is marked **UNVERIFIED**.
- No statutory rate, limit, slab, due date or form value appears in this draft. Where a gate touches statutory data, it checks structure only.

Waves used in section 3 (the docs give no sequence within a wave; round 9 answer 10 leaves sequencing within a wave to the team):

- **Wave A** = owner's Phase 0 fix items (DECISIONS.md, "Phase 0, fix items (all kept)").
- **Wave B** = owner's Phase 0 new or replace items (DECISIONS.md, "Phase 0, new or replace items chosen").
- **Wave C** = owner's Phase 0 operations wave (DECISIONS.md, round 6, "Operations wave in Phase 0").
- **Phase 1** = owner's Phase 1 scope (DECISIONS.md, "Phase 1 scope chosen"). This is the owner's Phase 1 (developer work-from-home), not the plan's `docs/plan/archive/phase-1-ledger.md`.

---

## 1. The ten CI gates

What exists in the repository today is noted per gate, so the owner can see how much is new. `.github/workflows/ci.yml` already runs jobs `static` (typecheck, lint, `map:check`), `test`, `build` and `e2e`.

### G1. Static checks: typecheck, lint, Tailwind tokens

- **Checks:** `pnpm typecheck`, then `pnpm lint`, which runs `eslint .` and `node scripts/check-tailwind-tokens.mjs --check` (root `package.json:21`).
- **Fails the build:** any non-zero exit. ESLint rules that are `warn` (for example `no-explicit-any`, `no-unused-vars`) do not fail the build; `eslint.config.js` says the `any` rule becomes an error only at Phase 4.1.
- **Protects:** CLAUDE.md "Working" (typecheck, lint, test before commit); docs/plan/archive/phase-0-stabilise.md 0.8 (lint and Tailwind token check).
- **Exists today:** yes, in `ci.yml` job `static`.
- **First mandatory:** Wave A (already in CI).

### G2. Map freshness

- **Checks:** `node scripts/genmap.mjs --check` (root `package.json:25`, run as `map:check` in `ci.yml`). The committed `docs/plan/MAP.md` must match a regenerated map.
- **Fails the build:** a stale map.
- **Protects:** docs/plan/archive/phase-0-stabilise.md 0.7 ("add `node scripts/genmap.mjs --check` to CI"); CLAUDE.md "Working cheaply here" (MAP before any search).
- **Exists today:** yes.
- **First mandatory:** Wave A.

### G3. Schema and migration drift

- **Checks:** the migrations in `apps/api/prisma/migrations/` replay to the same schema as `apps/api/prisma/schema/`. `prisma migrate diff` shows no drift in either direction. The hand-written migration `20260920173000_ledger_invariants` is included in the replay.
- **Fails the build:** any non-empty diff.
- **Protects:** CLAUDE.md "Working" ("Schema changes: also `pnpm prisma migrate diff`"); docs/plan/archive/phase-0-stabilise.md 0.7 and 0.8 (baseline before `migrate diff` goes into CI).
- **Exists today:** partly. The migrations directory exists with three migrations (`20260920173000_ledger_invariants`, `20260920180000_audit_spine_dpdp`, `20260920220000_session_hardening`). But `ci.yml` still runs `prisma db push --skip-generate` in the `test` and `e2e` jobs, and its header says there is no migration history. That is drift against phase-0 0.8. The gate cannot be enforced until CI stops using `db push`.
- **Not verified:** whether the three migrations form a complete baseline of the current schema. UNVERIFIED.
- **First mandatory:** Wave 0 (owner answer, round 10, item 2): the migration baseline is built and CI moves off `db push`. The drift check applies once that baseline is accepted.

### G4. API tests on real Postgres, no mocks

- **Checks (a):** `pnpm --filter @kaizen/api test` runs against a Postgres 16 service container (`ci.yml` job `test`). Nothing in this gate stubs the database.
- **Checks (b):** a static scan of `apps/api/**/*.test.ts` finds no `vi.mock`, `jest.mock` or `vi.spyOn` on the database, the Prisma client or the request context. Current result: zero matching files (checked in this pass; the scan covers only those three patterns).
- **Fails the build:** a failing test, or any match in the scan. An allowlist is needed only if an owner decides a non-database mock is acceptable (open question 2).
- **Protects:** CLAUDE.md "Never" (add a mock to the API suite) and the reason given there ("its value is the real Postgres, real contexts, real evaluator").
- **Exists today:** the test job exists. The mock scan is new.
- **First mandatory:** Wave A.

### G5. Boot refusal for missing or weak secrets

- **Checks:** a test starts the config loader in a child process once per required variable, with that variable removed, and asserts (i) a non-zero exit and (ii) an error message that names the variable. A second case sets `JWT_SECRET` to 31 characters and expects refusal. Required set: `JWT_SECRET` (minimum 32), `DATABASE_URL`, `NODE_ENV` (phase-0 0.1); and `FIELD_ENCRYPTION_KEY` (FX-60; DECISIONS round 2, D-14: "boot refuses to start without it"). A source scan asserts that no fallback literal such as `dev-secret-change-me` remains (phase-0 0.1 names `apps/api/src/lib/auth.ts:31`).
- **Fails the build:** a process that starts with a missing or weak secret, or an error that does not name the variable, or a fallback literal found in source.
- **Protects:** docs/plan/archive/phase-0-stabilise.md 0.1; FX-60; D-14 (round 2); CLAUDE.md "Never" (no flag removes the boot assertions).
- **Exists today:** `apps/api/src/platform/config.ts` exists (checked). Its contents were not read in this pass; FX-60 cites it at `platform/config.ts:54-93` (cited from FIXES.md). UNVERIFIED that the boot refusal is enforced.
- **Not verified:** whether CI's `test` job sets `FIELD_ENCRYPTION_KEY`. `ci.yml` sets `JWT_SECRET` and `NODE_ENV` only, as far as this pass read. Once the boot refusal lands, the job must supply the key. UNVERIFIED.
- **First mandatory:** Wave A.

### G6. Failing-test-first evidence for FX fixes

- **Checks:** for every pull request that cites one or more FX identifiers (FX-nn in `zen360/FIXES.md`):
  1. a test exists whose name contains the FX identifier;
  2. that test is run against the base commit, where it must fail, and against the head commit, where it must pass.
     Design choice, for the owner: the base-commit run is done by CI, or the pull request records the failing run and CI checks only that the record is present (open question 3).
- **Fails the build:** no FX-named test; the test passes on base; the test fails on head.
- **Protects:** CLAUDE.md "Working" ("Before claiming a defect is fixed, write the test that fails on the old code"); docs/plan/archive/phase-0-stabilise.md, gate line ("every item below has a test that fails on the old code and passes on the new"); the "Test that must fail on old code" column in `zen360/FIXES.md`.
- **Exists today:** no.
- **First mandatory:** Wave A.

### G7. Tenant isolation and row-level security negative tests

- **Checks (a), RLS negative tests run as the non-owner application role:**
  - a query under tenant B's context returns zero rows owned by tenant A, for every tenant-scoped table;
  - an insert or update with `tenantId = A` under tenant B's context is refused (`WITH CHECK`);
  - a request that puts another tenant's id in the body, query string or JWT claim is ignored, because tenant scope is resolved from the session (CLAUDE.md rule 6).
  - a catalogue check: every table with a `tenantId` column has `ENABLE` and `FORCE ROW LEVEL SECURITY` and a policy covering both `USING` and `WITH CHECK`.
- **Checks (b), tenant-leakage fuzzer (Wave B):** walk every route, background job, cache key and export path with tenant A's token and tenant B's identifiers; assert no tenant A data in tenant B's response, and no 2xx for a foreign identifier. This is the fuzzer named in the owner's Phase 0 new items.
- **Fails the build:** any leaked row; any tenant-scoped table without forced RLS; any route that accepts a tenant id from the body, query or claim.
- **Protects:** CLAUDE.md rule 6 and "Never"; docs/plan/archive/phase-1-ledger.md 1.2 item 5 (a migration test that runs each invariant as the application role and asserts failure); FX-51 (round 4 Phase 0 item; FX-51 says RLS exists only on ledger tables, cited from FIXES.md); D-07 (round 3).
- **Exists today:** the ledger migration sets `FORCE ROW LEVEL SECURITY` on `ledger_entities`, `cmp_accounting_periods`, `journal_entries` and `journal_lines`, and creates policies from a loop (`20260920173000_ledger_invariants/migration.sql`, lines 165 and 173). The loop's table list was not read in full, so the catalogue coverage is UNVERIFIED. Expected to fail on today's main for tables other than the four above, until FX-51 lands. That failure is the point of the gate.
- **Dependency:** the runtime RLS checks need the non-owner application role, which is in the Wave C operations list.
- **First mandatory:** Wave A for the RLS checks (FX-51). Wave B for the fuzzer.

### G8. Governed writes: assertCan, auditWrite, emit, through the registry

- **Checks (a), static scan of route and domain code:** every Prisma `create`, `update`, `upsert`, `delete` and `deleteMany` on a governed model must sit in a function where, in this order, `assertCan`, then `auditWrite`, then `emit` appear (CLAUDE.md rule 5). Every `subjectType` passed to `auditWrite` must appear in a `registerGovernedEntities(domain, [...])` list (`platform/audit.ts:37`). Any literal `force: true` fails.
- **Checks (b), runtime test:** for each governed entity, one write through its route produces an audit row. A silent no-op (FX-20) fails this test.
- **Fails the build:** a write with no `assertCan`; an unregistered `subjectType`; `force: true` anywhere; a write with no `auditWrite`; a runtime write that produces no audit row.
- **Protects:** CLAUDE.md rule 5 and its note that `force` must not be used to bypass registration; docs/plan/archive/phase-0-stabilise.md 0.6 "Audit gaps" and "Add `assertCan` + `auditWrite` + `emit` to `reversePayment`"; stop-ship FX-01, FX-02, FX-03, FX-04, FX-05, FX-20, FX-21, FX-22 (DECISIONS round 4 and Phase 0 fix items).
- **Exists today:** no. The static scan is heuristic and can miss writes made through helper functions. The runtime test is the authoritative check. Both checks are required (owner answer, round 10, item 3).
- **First mandatory:** Wave A.

### G9. Money, period and ledger-write lint rules

- **Checks, as lint rules added to `eslint.config.js`:**
  1. (money) no `round2`, no `Number(...)` and no `num(...)` on money-typed values in the finance, invoicing, payroll, books and fee paths; no `Math.round` in those paths; no `Number.EPSILON`. Money is `bigint` minor units (CLAUDE.md rule 1).
  2. (period) no `getUTCMonth`, `getUTCFullYear` or `getUTCDate` used to derive a tax period, financial year or document series. The IST helpers in `packages/shared/src/time.ts` are the only source (CLAUDE.md rule 3).
  3. (ledger write) only `apps/api/src/platform/ledger.ts` may write `journal_entries` or `journal_lines`, through Prisma or raw SQL. Migrations are excluded because they are reviewed as schema.
- **Fails the build:** a lint error. The rule must not be disabled per file (CLAUDE.md rule 2: "when added, do not disable it").
- **Protects:** CLAUDE.md rules 1, 2 and 3; docs/plan/archive/phase-1-ledger.md 1.3 ("Enforce that with a lint rule") and 1.6; FX-31 (float money, cited from FIXES.md); FX-40 and FX-41 (UTC financial-year defects, cited from FIXES.md); FX-42 (cited from FIXES.md).
- **Exists today:** no. Checked: `eslint.config.js` has no rule that restricts journal writes, `round2` or UTC getters. `packages/shared/src/time.ts` exists. `packages/shared/src/money.ts` does not exist (checked). The rule for `num()` and `Number()` will flag many existing sites (FIXES.md FX-31 cites `num()` in 54 files, cited from FIXES.md). The rule should be introduced with an allowlist that shrinks each phase, not with a list that is empty on day one.
- **First mandatory:** the IST rule (part 2) in Wave A, since FX-40 and FX-41 are Phase 0 fix items. The money rule (part 1) and ledger-write rule (part 3) in Wave B, when 1.3 and 1.6 land.

### G10. Statutory values only as StatutoryRule rows

- **Checks (a), static scan:** no literal for a statutory parameter (rates, thresholds, ceilings, slabs, section numbers, form numbers, due-day offsets, notification strings) in finance, HCM or compliance code paths. The denylist is maintained from the findings in FX-36 and FX-76 (cited from FIXES.md). Seed data lives in one dedicated folder, which is the only allowlist.
- **Checks (b), resolver test:** every computation resolves its parameter by effective date from a `StatutoryRule` row. A date with no covering row throws. Every row has non-null `effectiveFrom`, `jurisdiction` and `source`.
- **Fails the build:** a scan hit outside the seed folder, or a resolver that returns a value for an uncovered date, or a row missing a field.
- **Protects:** CLAUDE.md rule 4 and its instruction "About to hardcode a number a government can change? Stop."; DECISIONS round 2 (D-05: "seed Tamil Nadu as data, no hardcoding"); DECISIONS round 3 (D-02: every statutory item "remains awaiting professional sign-off"); phase-0 owner Wave B item 3.1 (statutory master pack, placed early in Phase 0 by round 4).
- **Exists today:** no. FX-36 and FX-76 cite statutory constants in code (for example `packages/shared/src/compliance/tax.ts:251-255`, cited from FIXES.md; not re-opened in this pass). UNVERIFIED as of today.
- **Statutory values are not stated in this draft and must not be added to it.**
- **First mandatory:** Wave B, with 3.1.

### G11. Log redaction

- **Checks:** fields listed in `REGULATED_EXCLUDED_FIELDS` never appear in serialised logs, error output or responses. A test writes a value into each excluded field and asserts that the value does not appear in captured output.
- **Fails the build:** any captured output that contains a redacted field's value.
- **Protects:** phase-0 0.4 (`REGULATED_EXCLUDED_FIELDS` redacted at the serialiser). Required by owner answer, round 9, item 1.
- **Exists today:** no. `REGULATED_EXCLUDED_FIELDS` is cited from the phase-0 file and was not re-opened in this pass. UNVERIFIED as to where it is defined and what it covers.
- **First mandatory:** Wave A (phase-0 0.4). Wave membership is taken from the phase-0 item and not re-checked.

### G12. Accessibility (axe)

- **Checks:** axe-core run on the rendered pages in scope, with zero violations, and a Lighthouse accessibility score at or above 95 (figures from `docs/plan/archive/README-old-index.md:59` and `docs/plan/archive/phase-4-interface.md:5`).
- **Fails the build:** any axe violation, or a Lighthouse accessibility score below 95.
- **Protects:** the Phase 4 interface requirements. Required by owner answer, round 9, item 1.
- **Exists today:** no. No axe job exists in `ci.yml` (checked).
- **First mandatory:** not in the wave table in section 3 for Waves A to C or Phase 1; it applies from Phase 4.

### Considered and not in the ten

- **Log redaction test:** moved to G11 by owner answer, round 9, item 1.
- **Accessibility gate (axe-core):** moved to G12 by owner answer, round 9, item 1.
- **Dependency licence check:** REPORT ONLY, by owner answer, round 9, item 5. The request that asked for this draft named GPL, AGPL, LGPL, MPL and BUSL. No licence policy exists in the repository docs or in `ci.yml` or `scripts/` (checked). The owner's build-versus-integrate answer (DECISIONS round 5) says LiveKit is Apache-2.0 and that third-party code is read, not copied. The check lists licences found and never fails the build. The clean-room rule is enforced by review, not by CI (implication, labelled in DECISIONS round 9). UNVERIFIED as a policy. Open question 7.
- **Monthly restore drill with bit-identical trial balance:** `docs/plan/archive/phase-8-proof.md`. Out of the owner's Phase 0 list (DECISIONS, "P8: load tests, monthly restore drill ... out"). The Wave C item "database backups with tested restores" is the nearest operations item.
- **Concurrency suite:** `docs/plan/archive/phase-8-proof.md`, and the owner's Phase 0 new items. Covered for the ledger by L3 below.

---

## 2. Ledger gate tests

Each test runs against a real Postgres as the non-owner application role, not as the table owner (docs/plan/archive/phase-1-ledger.md 1.2 item 5; CLAUDE.md rule 6).

Each test is a separate suite, for example `test:ledger-property`, `test:ledger-migration` and `test:concurrency`. The main suite is serial by construction and stays that way (`docs/plan/archive/phase-8-proof.md`).

Dependency note: the property test uses `fast-check`. It is not a dependency today (checked: neither root `package.json` nor `apps/api/package.json` lists it). Adding it is a new dependency that needs owner approval.

### L1. Ten-thousand-operation property test

Named in `docs/plan/archive/phase-1-ledger.md` (gate line) and `docs/plan/archive/phase-8-proof.md`.

**Inputs**

- A fixed seed, printed in the test output so that any failure can be replayed exactly.
- Two `LedgerEntity` rows in one tenant, because Phase 1 is "built for many companies" (DECISIONS round 2).
- A generated chart of accounts: postable accounts across all five account types, one non-postable control account, and one account that requires a party.
- Entry dates drawn across two financial years, including instants between 00:00 and 05:30 IST on the first day of a month and on 1 April.
- A sequence of 10,000 operations, weighted by the generator, drawn from:
  1. balanced post of 2 to 6 lines, amounts random `bigint` in paise;
  2. unbalanced post (expected refusal);
  3. post to a non-postable account (expected refusal);
  4. post missing a required party (expected refusal);
  5. repeat post with an existing idempotency key;
  6. reversal of a posted entry;
  7. reversal of a reversal (expected refusal);
  8. direct `UPDATE` and `DELETE` of a posted entry as the application role (expected refusal);
  9. period close, then post into the closed period (expected refusal);
  10. balance read and snapshot rebuild.

**Invariants, checked after every operation for I1 to I6, and after every 100 operations for I7 to I9**

- **I1, balance.** For every entry, the sum of `amountMinor` over its lines is zero.
- **I2, trial balance.** For each entity and for the group, the trial balance sums to zero.
- **I3, immutability.** A hash of every posted entry's header and lines is identical before and after every later operation. Any `UPDATE` or `DELETE` attempt is refused by the database.
- **I4, reversals only.** No posted entry is removed or edited. Each reversed entry has exactly one `reversedById`. No reversal of a reversal exists.
- **I5, idempotency.** Each idempotency key maps to exactly one entry. A replay returns the original entry id and leaves row counts unchanged.
- **I6, period lock.** No entry dated in a closed period was posted after that period's close timestamp.
- **I7, gapless numbering.** Posted entry numbers are gapless per entity per financial year. A refused operation does not consume a number (phase-0 0.6, invoice numbering, applies here too).
- **I8, derived equals snapshot.** After each rebuild, every `AccountBalanceSnapshot` equals the balance derived from `journal_lines` for that account and period end (docs/plan/archive/phase-1-ledger.md 1.4).
- **I9, types.** Every amount read back is a `bigint`. No float, `Decimal` or `number` appears in the returned values.

**Pass criteria**

- All 10,000 operations run to completion.
- Zero invariant violations.
- Every refused operation returns its expected error code, and no refused operation is recorded as success.
- Replaying the same seed gives the same final trial-balance hash.

Cadence and runtime budget are owner decisions (open question 8).

### L2. Migration-equivalence test

Named in `docs/plan/archive/phase-1-ledger.md` 1.5 (gate line), and the cutover rule in DECISIONS round 7 ("only after the trial balance ties to the paisa").

**Inputs**

- A frozen fixture of the Kaizen cashbook for 1 February 2026 to 27 August 2026: 1,123 vouchers and 66 ledger accounts (docs/plan/archive/phase-1-ledger.md 1.5). These figures are cited from the phase doc. `docs/plan/archive/README-old-index.md:68` says they must be confirmed with a human before relying on them. UNVERIFIED until confirmed.
- The reviewed mapping table from `ledgerGroup` to `accountType`, committed as a CSV fixture after sign-off (docs/plan/archive/phase-1-ledger.md 1.5 step 1). The reviewer is the internal finance head (DECISIONS round 5).
- The inherited reconciliation gap recorded in the source financial model. The test reads that gap from the recorded source. It does not hard-code a number.

**Procedure**

- Run `cashbookToJournal` into an empty tenant.
- Compare the journal-derived balance with the legacy cashbook balance for every account and every month-end in the window.

**Invariants and pass criteria**

- Every account and every month-end ties to the paisa.
- Each of the 1,123 vouchers maps to at least one posted entry.
- The only difference between the two sides is the explicit `Opening Balance Difference` suspense account, whose balance equals the recorded inherited gap. No other difference exists.
- Trial balance sums to zero.
- Re-running the migration posts nothing new (each idempotency key is `legacy:<transaction.id>`).
- On any mismatch the test prints the account and month, and fails. No forcing to zero (docs/plan/archive/phase-1-ledger.md 1.5 step 4).

**Gate status:** blocked until the mapping fixture is signed. `model Transaction` is deleted only after this test passes (docs/plan/archive/phase-1-ledger.md 1.5).

### L3. Two-hundred concurrent allocations

Not named in the docs. The docs ask for concurrency tests (`docs/plan/archive/phase-8-proof.md`) and for the payment-allocation race fix (docs/plan/archive/phase-0-stabilise.md 0.6: `domains/finance.ts:201` reads `available`, `:235` creates the receipt; `collectInvoicePayment` at `invoicing.ts:946`). The count of 200 comes from the request. UNVERIFIED as a documented requirement.

**Inputs**

- One tenant, one entity, one payment of `P` paise. `P` is generated so that the requests together exceed it, for example by setting `P` to a generated fraction of the requests' total.
- 200 allocation requests against that one payment, each for a random positive amount, released together behind a barrier. Each request uses its own connection or its own HTTP request.
- Repeated 20 times with different seeds.

**Invariants and pass criteria**

- In every run, the sum of accepted allocations is at most `P`. The database check (phase-0 0.6) holds. Final unallocated equals `P` minus the accepted sum, exactly.
- Accepted plus rejected equals 200. Every rejection uses the insufficient-available error. No request returns a server error.
- Accepted receipt numbers are unique and gapless within their series. Rolled-back attempts consume no number.
- Each accepted allocation posts exactly one journal entry, and the trial balance still sums to zero.
- Paise remainders go to the first allocation line, so the allocations on each invoice sum exactly to the allocated total (DECISIONS round 2, FX-31).
- No deadlock timeout.
- The test must first fail on the current code, with over-allocation, before the 0.6 fix is merged (G6).

Runs in the concurrency suite, not the serial suite. Latency budget is an owner decision (open question 8).

---

## 3. Mandatory gates by wave

"from A" means mandatory for pull requests merged in that wave. "carried" means it still applies. "n/a" means it does not apply in that wave. "exists" means already in `ci.yml` or the repository today.

| Gate                                     | Wave A (Phase 0 fix items)                     | Wave B (Phase 0 new or replace items)                                      | Wave C (Phase 0 operations)                    | Phase 1 (owner's, developer work-from-home)       |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| G1 Static checks                         | from A (exists)                                | carried                                                                    | carried                                        | carried                                           |
| G2 Map freshness                         | from A (exists)                                | carried                                                                    | carried                                        | carried                                           |
| G3 Schema and migration drift            | from Wave 0 (baseline built; CI off `db push`) | carried                                                                    | carried                                        | carried                                           |
| G4 Real Postgres, no mocks               | from A (test job exists; mock scan new)        | carried                                                                    | carried                                        | carried                                           |
| G5 Boot refusal for secrets              | from A (0.1, FX-60)                            | carried                                                                    | carried; CI must supply `FIELD_ENCRYPTION_KEY` | carried                                           |
| G6 Failing-test-first for FX fixes       | from A                                         | carried                                                                    | carried                                        | carried                                           |
| G7 Tenant isolation and RLS              | from A (RLS checks, FX-51)                     | from B (fuzzer)                                                            | needs non-owner app role for runtime checks    | carried                                           |
| G8 Governed writes                       | from A (FX-01 to FX-05, FX-20 to FX-22)        | carried                                                                    | carried                                        | carried; applies to approvals and expense posting |
| G9 Money, period, ledger-write lint      | from A (IST rule part 2)                       | from B (money part 1, ledger-write part 3, with 1.3 and 1.6)               | carried                                        | carried; expense claims post only via `post()`    |
| G10 Statutory rows only (structure only) | n/a                                            | from B (with 3.1)                                                          | carried                                        | carried                                           |
| G11 Log redaction                        | from A (phase-0 0.4)                           | carried                                                                    | carried                                        | carried                                           |
| G12 Accessibility (axe)                  | n/a                                            | n/a                                                                        | n/a                                            | n/a until Phase 4                                 |
| L1 Ten-thousand-operation property test  | n/a                                            | from B (with 1.1 to 1.4)                                                   | carried; needs app role for immutability cases | carried                                           |
| L2 Migration equivalence                 | n/a                                            | from B, blocked until mapping is signed and Kaizen figures confirmed (1.5) | carried                                        | required at the 1 April cutover (round 7)         |
| L3 200 concurrent allocations            | from A (0.6 payment allocation fix)            | carried                                                                    | carried                                        | carried                                           |

Drift to note: `ci.yml` header says the suite is "382-test"; `docs/plan/archive/phase-8-proof.md` says "370"; `docs/plan/archive/phase-0-stabilise.md` says "372". The count needs one source of truth before any "all tests pass" gate can state a number.

---

## 4. Drift found while drafting (for the record)

- `ci.yml` runs `prisma db push` in the `test` and `e2e` jobs, and its header says there is no migration history. `apps/api/prisma/migrations/` holds three migrations. This conflicts with phase-0 0.8, which says the migration baseline must exist before `migrate diff` is in CI.
- `docs/plan/archive/phase-1-ledger.md` 1.1 still describes `model Transaction` as present and the migration as future work. The ledger invariants migration exists already (`20260920173000_ledger_invariants`). Which parts are done is not verified in this pass. UNVERIFIED.
- The test counts differ across three documents (see section 3).
- `docs/plan/archive/phase-8-proof.md` says the ten gates are in `00-BRIEF.md` section 5. That file is not in the repository, and no commit in any branch has ever contained it (`git log --all -- '*00-BRIEF*'` returned nothing). This draft therefore does not reconstruct it.

---

## 5. Open questions for owner approval

Status after round 10 (owner answers recorded in DECISIONS.md, "Owner answers, round 9" and "Owner answers, round 10"). Each question keeps its answer. Questions with no answer stay open.

1. **Gates G1 to G10 and ledger tests L1 to L3.** RESOLVED for G1 to G10: approved as the required set. G11 (log redaction) and G12 (axe) added as required gates, so twelve checks in total. RESOLVED in round 10 (item 1) for L1 to L3: approved as the required ledger gate, with the short-run and phase-end budget in question 8.
2. **Mock policy (G4).** RESOLVED in part: the mock scan fails the build. No allowlist was recorded, so no non-database stub is allowed until the owner names one.
3. **Failing-test-first (G6).** RESOLVED: the failing test is in a separate first commit that fails on the old code. CI checks that this commit exists and that it fails on the old code.
4. **Governed-write check (G8).** RESOLVED (round 10, item 3): both checks are required. The registry-driven scan blocks the build (unregistered writes and `force: true` fail). The runtime audit-row test (check b) is also required: one write per governed entity must produce an audit row.
5. **Order within each wave.** RESOLVED: gates are listed per wave only. The team sequences work within a wave.
6. **Log redaction and axe.** RESOLVED: both are required gates (G11, G12). Neither replaces a gate above.
7. **Dependency licence check.** RESOLVED: report only. The check lists licences and never fails the build. Enforcement of the clean-room rule moves to review. The GPL, AGPL, LGPL, MPL and BUSL list and the exception owner are not recorded and remain open.
8. **Ledger test budgets.** PARTLY RESOLVED: short runs of L1 on every pull request; the full ten-thousand-operation test and full concurrency runs at phase end. Still open: the runtime ceiling for L1, the latency ceiling for L3, and whether 200 is the right concurrency for L3.
9. **Fixture sign-off (L2).** OPEN in part. Under round 9 item 11, sign-off duties (including the 1.5 account-mapping review) attach to access levels, not named people. The interim holder is the internal finance head. Still open: whether the Kaizen book figures (1,123 vouchers, 66 accounts, the window) are checked by a human before the fixture is committed (`docs/plan/archive/README-old-index.md:68`), and the level model (open after round 9).
10. **Statutory gate (G10).** RESOLVED: G10 checks structure only and fails on hard-coded rates. It never checks values. Values, sign-off and ownership stay with the internal finance head (DECISIONS round 3, D-02). Statutory sign-off still needs a real qualified person, even when the duty is held by a level.
11. **CI database approach (G3).** RESOLVED (round 10, item 2): the CI migration baseline sits in Wave 0, and the G3 row in section 3 and the G3 section now say Wave 0 (previously "from B"). Still open: who owns the baseline; the owner did not name an owner in round 10.
12. **Fast-check.** RESOLVED: fast-check (MIT) approved as a test-only dependency.

---

## 6. Items marked UNVERIFIED

- Whether the three existing migrations form a complete baseline of the current schema (G3).
- Whether CI's `test` job sets `FIELD_ENCRYPTION_KEY` (G5).
- Whether the boot refusal in `apps/api/src/platform/config.ts` is enforced; contents not read in this pass (G5).
- The RLS loop's table list and the full catalogue coverage (G7).
- Line numbers cited from `zen360/FIXES.md` and not re-opened: FX-31, FX-36, FX-40, FX-41, FX-42, FX-51, FX-76, `packages/shared/src/compliance/tax.ts:251-255`, `domains/finance.ts:201,235`, `invoicing.ts:946` (G9, G10, L3).
- The Kaizen book figures and their window (L2), until a human confirms them (`docs/plan/archive/README-old-index.md:68`).
- The licence blocklist as a repository policy (considered list; open question 7).
- The 200-concurrency figure as a documented requirement (L3).
- The current state of the ledger migration's status against docs/plan/archive/phase-1-ledger.md 1.1 to 1.2 (section 4).
- The mock scan covers only `vi.mock`, `jest.mock` and `vi.spyOn`. Other forms of hand-written stub were not searched for (G4).
