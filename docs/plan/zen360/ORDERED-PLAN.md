# Zen 360 ordered plan: owner Phase 0 and Phase 1 (planning only, 2026-10-10)

Status: planning document, with build status on each item. Items marked DONE, BUILT, PARTLY, OPEN or NOT BUILT were checked against the code on 2026-10-12 (DECISIONS.md, round 23, item a). Items not yet checked carry no status. This file is not authority over the decisions in `docs/plan/zen360/DECISIONS.md`; where they differ, DECISIONS.md governs.

Round 18b (DECISIONS.md, 2026-10-11) defers tenancy and all hosting. Items marked DEFERRED or moved below are superseded by round 18b and are kept as history.

Effort: no effort estimate is stated in the docs. Phase 0 is mostly new build, and the owner accepted that. Each phase ends at a stop rule, not at a week count.

Statutory values: none appear in this plan. Statutory values stay unverified and DRAFT until a qualified person signs them off (see DECISIONS.md, round 10, still open).

Markers: `BLOCKED-BY` marks a work item that cannot start until the named condition is met.

---

## Ordering principles

1. Money before ledger: `money.ts` (bigint) lands before the ledger schema.
2. The ledger is serial, done by one person.
3. `entityId` is on the journal before the first post.
4. The audit registry (FX-20) lands before features that register subjects.
5. Every write follows the same sequence: `assertCan`, write, `auditWrite`, `emit`.
6. Every stop-ship fix starts with a failing test on the old code, in a separate first commit.
7. Statutory values are date-effective `StatutoryRule` rows, seeded DRAFT until sign-off. The interim sign-off holder is the internal finance head.
8. Statutory uncertainty means stop and flag it. Do not guess.
9. Open source: copying code from open-source projects is an approved way to build any feature (round 24 item g; the round 22 clarification extended it from mail). Each copied file is logged in `docs/plan/zen360/MAIL-PROVENANCE.md`. Proprietary or paid software is not copied or reverse-engineered; only public docs and feature lists are used. Licences are set aside for now (round 22, second clarification).

---

## Phase 0: streamline and fix

Intent: no new features in principle. The owner accepted that Phase 0 is mostly new build.

Stop rule for each wave: the wave's listed items are merged, and the gates named for that wave pass. Then the next wave starts. Waves run in order unless marked parallel.

### Wave 0: foundations

- **0.7 Schema split and tooling.** Split the schema into `apps/api/prisma/schema/`. Add `genmap.mjs`. Add scoped test scripts, including `test: prisma validate` and a `migrate diff` no-drift check. **Status 2026-10-12: DONE.** `scripts/genmap.mjs`, `docs/plan/MAP.md`, `db:validate` and `db:drift` in `apps/api/package.json`, the schema split under `apps/api/prisma/schema/`.
- **0.1 Config and secrets.** Add `platform/config.ts` with Zod validation at load. Remove the fallback at `auth.ts:31` and `TENANT_ENFORCE_MODE` at `context.ts:94`. Add the FX-60 boot refusal at `privacy.ts:944-954`. **Status 2026-10-12: PARTLY.** Done: Zod load in `platform/config.ts` (`envSchema` at :54); the `auth.ts` fallback is gone (the literal survives only in the refusal list, `lib/auth.ts:74`); `TENANT_ENFORCE_MODE` is absent from source. Open: the FX-60 refusal applies only when `NODE_ENV === 'production'` (`platform/config.ts:150`), see DECISIONS round 23, C-003. The cite `privacy.ts:944-954` is the erasure flow, not a boot check.
  - Test: boot without `JWT_SECRET` exits, naming the variable. Without `FIELD_ENCRYPTION_KEY` the process refuses to boot in every environment (round 24 item b). Dev uses a dummy key from `apps/api/.env.example` (the example has the key commented out today, line 17: OPEN for the Phase 0 session). CI supplies one (OPEN: `ci.yml` does not set it yet).
- **Time helpers.** Add `packages/shared/src/time.ts`. Use it for FX-40 (`documentNumber.ts:92-94`), FX-41 (`domains/compliance/tax.ts:60-63`) and FX-42 (`invoicing.ts:266-269`). **Status 2026-10-12: DONE.** `packages/shared/src/time.ts`. FX-40 at `apps/api/src/platform/documentNumber.ts:99`, FX-41 at `apps/api/src/domains/compliance/tax.ts:74`. FX-42's cite is now `totalsMinorOf`, a paise helper, not a date; the period check is `assertPeriodOpen` (`apps/api/src/domains/invoicing.ts:368`, `filingPeriodOf` at :342). The cites in this item are stale.
  - Test: `fyOf(2026-03-31T19:00Z) === '2026-27'`.
- **0.8 CI.** Add ESLint and Prettier. Remove the dead classes at `Start.tsx:100,109` and `People.tsx:56`. Add a build identity. Replace `db push` with a migration baseline. The migration baseline sits in Wave 0 (DECISIONS.md, round 10). **Status 2026-10-12: PARTLY.** Done: ESLint, Prettier (`.github/workflows/ci.yml:47` runs `pnpm format:check`), build identity (`platform/build.ts`), migration baseline (CI runs `db:validate` and `db:drift`). Open: the dead classes at `Start.tsx:100,109` and `People.tsx:56` are not confirmed (the cited lines are live code; re-derive the list); `db push` still runs in `apps/api/docker-entrypoint.sh:30`.
- ~~**Worker removal.** Remove the Cloudflare Worker (`worker/index.ts`).~~ **Done; the removal stands** (round 19b, item 2).
- ~~**Hosting.** Serve everything from the own server behind Caddy.~~ **Replacement hosting DEFERRED until after Phase 1 (superseded by round 18b, item 3).** Server, reverse proxy, caching and routing move to "After Phase 1: hosting and operations (deferred)".

### Wave 1: authority, audit, security, statutory data

- **Task-complete fix.** `POST /tasks/:id/complete` (`crm.routes.ts:1108-1109`) has no `assertCan`, audit or emit. Write the failing test first, in its own commit. **Status 2026-10-12: DONE.** `apps/api/src/domains/tasks.ts:114` `completeTask`: `assertCan` at :115, `auditWrite` at :149, `emit` at :158. Route `crm.routes.ts:1175`.
- **FX-20 audit registry.** `registerGovernedEntities` (`audit.ts:37`).
- **FX-21.** Drop `force` (`lifecycle.ts:74-119`). **Status 2026-10-12: DONE.** No `force` option in `apps/api/src/platform/lifecycle.ts`; `transition` is at :76.
- **FX-22.** Writes with no audit. **Status 2026-10-12: OPEN.** No coverage scan of routes against `auditWrite` has been run.
- **FX-01 and FX-04.** `decideApprovalStep` (`approvals.ts:309`) and `decideAgentAction` (`agents/index.ts:251`). **Status 2026-10-12: DONE.** `apps/api/src/platform/approvals.ts:330` (`assertCan` at :349, before the state check); `apps/api/src/agents/index.ts:328` (`assertCan` at :341). Cites were `:309` and `:251`.
  - Test: an ungranted user gets 403 and the state is unchanged.
- **FX-02, FX-03, FX-05.** `hr.routes.ts:844-856`, `crm.routes.ts:243-257`, `agents/index.ts:95-98`. **Status 2026-10-12: PARTLY.** FX-03 DONE (`apps/api/src/domains/identity.ts:354` `assertCan` for merge). FX-05 DONE (`apps/api/src/agents/index.ts:93-99` blocks an undeclared tool). FX-02 OPEN: `transitionPayrollRun` (`apps/api/src/domains/payroll.ts:207`) has no `assertCan` in its body; whether `transition()` reaches the guard is not verified.
- **FX-50.** Webhook dedupe, and HMAC with a single webhook secret. Per-tenant HMAC is **DEFERRED (superseded by round 18b, item 1)**; FX-50 is now a single secret.
- **FX-61, FX-80.**
- **FX-24.** Postgres outbox (D-16). **Status 2026-10-12: OPEN, no verdict.** `apps/api/src/platform/outbox.ts` exists; not verified against D-16.
- ~~**FX-51.** RLS on every table: ENABLE and FORCE, default deny, a non-owner app role, and a boot check that the role has neither `rolsuper` nor `rolbypassrls`.~~ **MERGED (#33; round 19b, item 1); extra proof deferred.** Existing ledger-table RLS and tenant scoping stay (round 18b, implications (a) and (g)). **Status 2026-10-12: DONE.** Migration `20261010235900_tenant_rls`; boot guard `apps/api/src/platform/rlsGuard.ts:14-19`. The extra proof stays deferred (round 18b).
- **FX-06, FX-07, FX-62 to FX-65.** Exceptions, merge, privacy. **Status 2026-10-12: PARTLY.** `apps/api/src/platform/exceptions.ts` and `mergePersons` (`apps/api/src/domains/identity.ts`) are present. FX-62 to FX-65 not verified.
- **0.4 Logging.** pino with allowlist redaction (G11). **Status 2026-10-12: BUILT, open.** pino is present (`apps/api/src/platform/logger.ts`). Open: the G11 redaction test was not located.
- **0.3 HTTP hardening.** helmet. CORS allowlist (FX-52, `server.ts:19`). express-rate-limit with a Postgres store. Error leak fix at `http.ts:116-118`. **Status 2026-10-12: BUILT, open.** helmet (`apps/api/src/server.ts:77`); CORS allowlist (`server.ts:27-33`); express-rate-limit with a Postgres store (`apps/api/src/platform/rateLimitStore.ts`). Open: the error-leak fix at the cited `http.ts:116-118` was not located (that range is now `requireAuth`).
- **0.2 Sessions.** `jti`. A Session model and logout. A 15-minute access token. A rotating, hashed refresh token. Login throttle. **Status 2026-10-12: DONE.** `jti` at `apps/api/prisma/schema/main.prisma:1315`; 15-minute access token at `apps/api/src/lib/auth.ts:45`; hashed refresh token at `main.prisma:1317-1321`.
- **3.1 Statutory master pack.** The owner overrides the "do not reorder" rule for this item.
  - Contents: an EXCLUDE constraint on the date range via `btree_gist`, written as hand-written SQL. Status values DRAFT, APPROVED and HOLD. A citation on every row. Good and bad fixtures.
  - Figures are NOT reproduced in the repository.
  - Not BLOCKED-BY statutory sign-off (round 22, item d; round 19a(c)). Rows stay DRAFT until the accountant approves them in the guided setup.

### Wave 2: scheduler and audit correctness

- **0.5 Scheduler.** Verify the croner licence first. Atomic claim with a unique key on `(tenantId, jobKey, scheduledFor)`. Lease with heartbeat. Backoff. Dead-letter queue. **Status 2026-10-12: DONE (build).** `apps/api/src/jobs/schedule.ts` (croner, lease, backoff, dead-letter); `JobClaim` at `apps/api/prisma/schema/main.prisma:1127`. The unique key is on `jobName`, not `jobKey`. OPEN: the croner licence check.
  - Test: `'0 6 * * *'` fires once per simulated day.
- **0.6 Hash chain.** Unique `(tenantId, prevHash)`. SERIALIZABLE retry (`eventBus.ts:104-105, 158`). FX-81 `verifyChain` (`eventBus.ts:422`). **Status 2026-10-12: PARTLY.** Done: unique `(tenantId, prevHash)` at `main.prisma:1071`. The SERIALIZABLE retry is not in code, by choice: `apps/api/src/platform/eventBus.ts:319-328` uses ReadCommitted with the lock, and says the plan's SERIALIZABLE choice is rejected there. This item's text is not yet rewritten. `verifyChain` is at `eventBus.ts:593`, not :422.
- Audit gaps in `books.ts`.
- `assertPeriodOpen` on the remaining write paths.

### Wave 3: money and ledger (serial, one person)

- **1.6 Money.** `money.ts` with bigint. Allocate leftover paise to the first line, so 100 split three ways gives 33.34 / 33.33 / 33.33. Delete `round2` (`finance.ts:150`; earlier cited as :132) and the epsilon comparisons.
  - Remaining Phase 0 money work (round 24 item e): the roughly 250 `Decimal(18,2)` money columns outside the ledger move to bigint paise before Phase 0 closes, with trial-balance assertions. Items 1.5 and 1.6 stay in Phase 0. Owner wording: "ledger first". OPEN: principle 1 says money before ledger; the owner states which order applies. **Status 2026-10-12: PARTLY.** Done: `packages/shared/src/money.ts` (`allocate` at :97, `parseMinor`, `formatMinor`, `applyBps`). Open: `round2` is still at `packages/shared/src/finance.ts:150` with its call sites; the epsilon removal is open. The cite `finance.ts:132` is stale.
- **Payment allocation.** `FOR UPDATE` with a DB CHECK. Invoice numbering inside the same transaction (`invoicing.ts:584`). **Status 2026-10-12: PARTLY.** `apps/api/src/domains/finance.ts:275` `allocatePayment` (one lock, commit `1ca0a2c`); invoice numbering is taken at `apps/api/src/domains/invoicing.ts`, not :584. The DB CHECK is not verified.
- **1.1 Ledger models.** `LedgerEntity`, `AccountingPeriod`, `JournalEntry` (with `entityId`), `JournalLine` (bigint), `LedgerAccount`.
  - **Done (round 24 item d):** `BusinessLine` registry (`apps/api/prisma/schema/business-lines.prisma:11`) and `lineId` / `costCentreId` composite foreign keys on `JournalLine` (`compliance-books.prisma:152-161`; migrations `20261010235800_business_lines`, `20261013110000_business_line_units`, `20261013205000_journal_line_cost_centre_fk`). **Status 2026-10-12: DONE for models.** `apps/api/prisma/schema/compliance-books.prisma` (`AccountingPeriod` :12, `LedgerEntity` :86, `JournalEntry` :103, `JournalLine` :134, `JournalReversal` :174); `LedgerAccount` at `main.prisma:5106`. OPEN: the bigint type, the two-line minimum and the `set_config` form are not yet checked.
- **1.2 Ledger migration.** Hand-written migration with: a deferred balance trigger, immutability, a period trigger, a two-line minimum, RLS with both USING and WITH CHECK, and `SET LOCAL` via `set_config(..., true)`. **Status 2026-10-12: PARTLY.** Triggers and the REVOKEs are present (`20260920173000_ledger_invariants`, `20261012100000_ledger_gates`, `20261010235900_tenant_rls/migration.sql:51-52`). OPEN: the two-line minimum and the `set_config` form.
  - ~~BLOCKED-BY PgBouncer in transaction mode.~~ **Superseded by round 18b, item 2:** PgBouncer is not a blocker. Revisit only if connections run short.
  - ~~BLOCKED-BY the non-owner role set up on the own server.~~ **Superseded by round 18b, item 5:** the non-owner role is a dev and CI database setting, needed for the immutability test. It is not a hosting item.
- **1.3 Posting.** `post()` is the sole writer (enforced by a lint rule). Idempotency key. A reversal refuses to reverse a reversal (`books.ts:264`). **Status 2026-10-12: DONE.** `post` at `apps/api/src/platform/ledger.ts:351`, `postInTx` at :394; the reversal refusal is at `ledger.ts:253` (the cite `books.ts:264` is stale); the lint rule is at `eslint.config.js:97-119`.
- **1.4 Balances.** Derived balances and a nightly drift check. Ledger gate tests L1 to L3. FX-30 to FX-35. **Status 2026-10-12: BUILT, open.** `apps/api/src/platform/balances.ts`; ledger gates in `apps/api/src/tests/ledger/ledgerGates.test.ts` (L1 :139, L2 :164, L3 :244). OPEN: the file's L1 is an unbalanced-entry refusal, while CI-GATES L1 is the ten-thousand-operation property test. The scopes differ.
- **1.5 Cashbook migration, then delete `model Transaction`.** **Status 2026-10-12: NOT DONE.** `model Transaction` is still at `apps/api/prisma/schema/main.prisma:5205`; used in 10 non-test files.
  - BLOCKED-BY internal finance head review of the mapping.
  - BLOCKED-BY confirmation of the Kaizen figures: 1,123 vouchers, 66 accounts, a gap of about 40,500. UNVERIFIED.
  - Cutover at a financial year start (1 April), after the trial balance ties to the paisa.

### Wave 4: operations (own server) — moved after Phase 1 (superseded by round 18b)

Moved to "After Phase 1: hosting and operations (deferred)" below. The non-owner DB role is not moved: it stays in item 1.2 as a dev and CI setting (round 18b, item 5).

### Wave 5: ledger consumers and interface (parallel within the wave)

- **FX-70.** Post from domain events. **Status 2026-10-12: DONE.** `apps/api/src/platform/ledger.ts:394` `postInTx`; `apps/api/src/platform/postingRoles.ts`; migration `20261013201000_ledger_posting_roles`.
- **FX-71.** Reversal, not hard delete (`commit.ts:714-746`). **Status 2026-10-12: DONE.** Commit `2b30fbf`; revert by reversal at `apps/api/src/imports/commit.ts:1181-1190`. The cite `commit.ts:714-746` is stale; the file has no hard delete.
- **FX-72.** Imports via `recordTransaction` in chunks of 500 rows. **Status 2026-10-12: DONE.** Commit `54295b9`, 500-row transactions.
- **FX-73.** Payroll posts liabilities (`payrollops.ts:414-455`). **Status 2026-10-12: OPEN.** Payroll does not post liabilities. `apps/api/src/domains/hcm/payrollops.ts:13-16` says so; `:414-455` is a read path. FX-73a (commit `2d68f74`) posts net pay in paise.
  - BLOCKED-BY statutory sign-off for PF, ESI, PT and TDS.
- **P4 interface, in this order:**
  1. `MetricProps` discriminated union.
  2. Code splitting.
  3. Error boundaries.
  4. 401 handling and an httpOnly cookie.
  5. Typed client.
  6. Component library and DataTable.
  7. Forms: pick react-hook-form or conform before the wave starts.
  8. Accessibility, with the axe gate G12.
  9. Frontend tests.

### Wave 6: spine and onboarding

- BusinessLine registry and `lineId` / `costCentreId` on `JournalLine`: **done**, see 1.1 (round 24 item d).
- Commitment record. **Status 2026-10-12: DONE.** `apps/api/prisma/schema/commitments.prisma`, `apps/api/src/domains/commitments.ts`, migration `20261013100000_commitment_record`.
- Case record (stays in Phase 0 Wave 6, round 22 item a). **Status 2026-10-12: DONE.** `apps/api/prisma/schema/cases.prisma`, `apps/api/src/domains/cases.ts`, migration `20261013120000_case_record`.
- Case record. **Clarified by round 21b, item 1 (round 22 item a repeats it):** the customer Case record stays in this wave. The ROADMAP row that put it out of Phase 0 is superseded.
- One document store. **Status 2026-10-12: DONE.** Migration `20261013090000_document_store`.
- Typed task source. **Status 2026-10-12: DONE.** Migration `20261013130000_task_source_kind`.
- Decision foreign keys. **Status 2026-10-12: DONE.** Migration `20261013150000_decision_links_money`; `apps/api/src/domains/decisions.ts`.
- Founder exception view. **Status 2026-10-12: DONE.** `apps/api/src/domains/founderView.ts`.
- Z3 continuity and handover gate. **Status 2026-10-12: DONE.** `apps/api/src/domains/handover.ts`; `apps/api/src/tests/handoverGate.test.ts`.
- **P7 onboarding state machine** and per-state packs. Stays in Phase 0 Wave 6 (round 22 item c). Not BLOCKED-BY 3.1 sign-off (round 22 item d). **Status 2026-10-12: BUILT, open.** `apps/api/prisma/schema/onboarding.prisma`, `apps/api/src/domains/onboarding.ts`, migration `20261013140000_onboarding_run`. The per-state packs are not verified.
  - ~~BLOCKED-BY 3.1 sign-off.~~ **Superseded by round 21b, item 4 (round 22 item d repeats it):** 3.1 sign-off is not a blocker for the onboarding state machine, matching round 19a (c). Statutory rules stay gated until the accountant approves them.
- Level-based access system, assigned at onboarding. Stays in Phase 0 Wave 6 (round 22 item c). **Status 2026-10-12: DONE for the tables and assignments.** `apps/api/prisma/schema/access.prisma`, `apps/api/src/domains/access/assignments.ts`, migrations `20261013180000_access_model` and `20261013191000_access_sod`. The level model itself is open (DECISIONS round 23, C-008 and C-009).
- Level mapping (questionnaire, suggestion until confirmed) stays in Phase 0 Wave 6 (round 22 item c).
- **Payment approval step.** Adds a `payments:approve` gate to the payment flow, so a payment needs a second person's approval before it counts. It goes after Wave 6 PR12, in the finance path, with its own ledger tests including the trial-balance assertion. Owner-approved, 2026-10-12. **Status 2026-10-12: NOT BUILT.** `payments:approve` appears only in `apps/api/src/tests/accessSod.test.ts`. The owner's decision, dated 2026-10-12, is recorded in DECISIONS.md round 23, item b, with an open question about founder-created payments.
- Thresholds, reserved matters and alternates are entered as data during onboarding ("tbd during onboard").
- Account recovery goes through the founder or the IT admin. SMS to employees' phones is NOT a recovery method (round 22 item e: owner chose this over SMS; reason noted: SIM-swap risk on a finance system). **Status 2026-10-12: BUILT, open.** `apps/api/src/domains/accountRecovery.ts`. The recovery holder is open (DECISIONS round 23, C-015).
- Delegation and the 24-hour absence test are owned by Phase 1A, not this wave (round 22 item b).
- ~~A static public IP exists.~~ **DEFERRED (superseded by round 18b, item 3):** hosting.

### Wave 7: proof

- Concurrency suite.
- ~~Tenant-leakage fuzzer. Needs second-tenant test data.~~ **DEFERRED (round 18b, item 1).**
- All CI gates in `docs/plan/zen360/CI-GATES-DRAFT.md` except G7, which is **DEFERRED (round 18b, item 1)**. Mandatory: G1 to G6, G8 to G12 and ledger tests L1 to L3.

---

## Phase 1: software developers can work from home

Stop rule for each sub-phase: its items are merged and its listed tests pass. Tests are written first.

### 1A. Approvals (DEC-05, DEC-06, DEC-07, CAP-DEC-08)

- Definition rows.
- A pure transition function, persisted with the decision row and an audit row.
- Requester exclusion. The founder is exempt (DECISIONS.md, round 10). The draft test "maker equals checker is refused" must exempt the founder level.
- Delegation with an expiry and a named alternate. Escalate after 24 hours of absence. **Owned here (round 21b, item 2):** delegation and the 24-hour absence test are Phase 1A items. The 24-hour founder-absence scenario is no longer a Phase 0 Wave 6 exit criterion.
- The 24-hour absence test is an exit test for this sub-phase (round 22 item b). It moved here from Phase 0 Wave 6. Owner-confirmed as 1A scope; ROADMAP follows.
- Typed thresholds, stored as data.
- Prerequisites: FX-01, FX-32.

### 1B. Attendance and remote (HRM-06, HRM-28, HRM-19, HRM-15)

- Self-declared work-from-home and on-duty requests, with manager approval.
- No location, device ID or IP is stored.
- Overlap check.
- Self-approval refused.
- Backup approver.
- BLOCKED-BY the CAP-HRM-32 legal check.

### 1C. Time and projects (CON-09, DEL-07, DEL-01, DEL-02)

- Timesheets per person, with project aggregates for insights.
- Project and activity foreign keys.
- Billable flag.
- Rate snapshot.
- Approved-period lock, with a permission-gated reopen.

### 1D. Delivery (HRM-18 first, DEL-03 to DEL-06, CRM-13, CON-05)

- Allocation calendar with a Postgres exclusion constraint.
- DEL-04: change request baseline plus delta.
- Billable amounts are derived.
- Customer acceptance is the only billing trigger. A signed contract means won.

### 1E. Communication

- COM-13: response SLA mechanism only. The numbers come after one month of measurement.
- COM-15: notifications in-app and by email via Resend.
  - BLOCKED-BY the Resend data-hosting check, before the first outside user.
- COM-02: shared inbox. One mailbox that several employees open (for example support@), with assignment and internal notes. It may receive and send to external addresses (round 24 item g). Customer-facing sends keep human approval. Supersedes the round 4 COM-02 rule "internal-only, no external provider".
- Employee company mailboxes and in-app inbox (round 21, OPEN, new large scope, not estimated). Owner answers: the app creates and hosts each employee's mailbox; the inbox sends and reads mail and links it to customers (Z3 capture pulled in for employee mail only). Round 22 owner decision, clarified 2026-10-12: copy code from open-source mail projects where relevant (Stalwart and others) into our own mail component, and log provenance in `docs/plan/zen360/MAIL-PROVENANCE.md`. This is not a literal fork. Unresearched caveats (Enterprise features, JMAP, release cadence, hosting conflict) are listed in DECISIONS.md round 22. Still OPEN and not estimated. No CAP row or spec yet. MVP, v2 and later feature phasing is in DECISIONS.md round 22. See DECISIONS.md round 21 and round 22.
- COM-11: meetings and minutes, typed by people. No recordings.
- Standups are dropped.

### 1F. Staff expense claims

- Claim, approve, and post to the ledger via `post()` on approval.
- Desktop capture only.
- Not BLOCKED-BY the receipt storage location. Storage and backups are decided with hosting after Phase 1 (round 24 item i).

### Feature 1 work items, in waves

- **Wave 2 (projects):** projects, epics, stories, tasks, subtasks. Per-project status rows via `lifecycle.ts:74`. WIP limits. Midpoint fractional rank, with rebalance. A `version` column for optimistic concurrency. RLS.
- **Wave 3 (discussion):** channels, DMs, mentions, reactions. Per-channel sequence numbers. Edits kept as revisions. Deletes kept as tombstones.
  - BLOCKED-BY the chat-retention legal check (D-14).
- **Wave 4 (realtime):** SSE served directly by the Express API. The Worker spike is dropped. A notification worker with do-not-disturb.
- **Wave 5 (automation):** rules cannot post journals, generate IRNs, file returns, run payroll, or email customers without approval.
- **Wave 6 (voice and video):** LiveKit. ~~Self-hosted on the own server in India.~~ **Superseded by round 18b, item 4:** the code needs only a configurable server address; hosting deferred. Development and tests use a local setup. Where the server runs is a hosting decision after Phase 1.
  - Ports: TCP 7880 and 7881, UDP 50000 to 60000, TURN/TLS on 443, public IP. **Hosting detail, DEFERRED (round 18b, item 4).** Kept as history.
  - 5-minute join tokens. Opaque room names. Webhook verification with event-id idempotency.
  - No recording, egress or transcripts.
  - Per-tenant LiveKit isolation is **DEFERRED (round 18b, item 1)**. E2EE is still UNVERIFIED.

---

## After Phase 1: hosting and operations (deferred)

Moved out of Phase 0 by round 18b (DECISIONS.md, 2026-10-11, items 3 and 4). The owner will consider hosting separately after Phase 1: how to host efficiently, and which caching and routing to use. The round 6 and round 7 own-server answers are provisional history until then. Nothing in this section is scheduled.

Items moved here from Phase 0 Wave 4 and Wave 0 (round 18b):

- Postgres operations. PgBouncer is not a blocker (round 18b, item 2). Revisit only if connections run short.
- Backups with tested restores and an off-site copy. The owner named Databasus as the backup setup. It is a PostgreSQL backup tool, not a connection pooler, and it does not make the app faster. Its documentation has not been read, and nothing here evaluates it.
- Monitoring and alerts.
- Caddy as the reverse proxy, and Caddy TLS renewal (round 7).
- Static public IP, a second line and backup power (round 7). Redundancy notes are provisional.
- Serving everything from one origin, the replacement for the Phase 0 Wave 0 "Hosting" item. Undecided until after Phase 1. The Worker removal itself is done. Confirmed by owner (round 19b, item 2): removal stands.
- Server hosting for LiveKit (Phase 1 Wave 6). The code needs only a configurable server address.
- Caching and routing. Not yet decided.
- Internal IT owner, as a level assignment at onboarding (round 10). Still tbd during onboard (round 18b, open list).

Not moved: the non-owner database role stays in item 1.2 as a dev and CI setting (round 18b, item 5).

---

## Open-source use

- Copying code from open-source projects is an approved way to build any feature (round 24 item g). Licences are set aside for now (round 22, second clarification). Proprietary or paid software is not copied or reverse-engineered; only public docs and feature lists are used.
  - Each copied file goes in MAIL-PROVENANCE.md, for any feature and not only mail (round 24 item g). Copied code follows CLAUDE.md (round 22 item vi).
- Dependencies allowed: pino, express-rate-limit, fast-check (test-only), the LiveKit SDK and server as a service, React Aria, TanStack Table, hey-api, Playwright, schemathesis (dev).
- Licences to verify before use: helmet, croner.
- Ideas studied: pg_ledger, pgledger, Formance, pg-boss, xstate, OpenFGA, Zulip, Taiga, Vikunja, Plane, Kimai, frappe hrms, ERPNext, OpenProject, OpenFisca, Catala.
- The licence check in CI is report-only.

## Access model

Identity types are decided first (round 14, round 24 item a). Level and function are attributes, and each placement carries one level (round 19a(f)). Round 10's "one level per person" and "levels by stakeholder type" are retired.

Identity types:

- Employees: Head, Manager, Staff.
- Founders and owners.
- Contractors and freelancers. Timesheets and tasks are employee-only until guest accounts are designed (round 24 item f; a default, not an owner decision).
- External auditors and accountants.
- Board and investors.

The level template ships with the app. ~~Editable per tenant at onboarding.~~ **Per-tenant editing is DEFERRED (round 18b, item 1).** Each placement holds one level, plus named extra duties. Exact duties per level and read scope are not yet defined (DECISIONS.md, round 10).

- `payment_create_approve` blocks only granting both permissions; no code gates `payments:approve`, so the pair does not stop any payment until the approval step lands (owner, 2026-10-12).

---

## Risks and open items

- Still open after round 10, from `docs/plan/zen360/DECISIONS.md`:
  - Statutory sign-off by a qualified person. Values stay DRAFT.
  - Duties per level, and read scope of the non-employee levels.
  - IT owner, as a level assignment at onboarding.
  - Expense receipt storage location.
  - D-11 numbers after the one-month measurement.
  - Legal checks before the first outside user: Resend data hosting, and chat retention (D-14).
- Still open after round 22 (DECISIONS.md, 2026-10-11): hosting, caching and routing (after Phase 1); mail hosting exception and domain/DNS owner (round 22); questionnaire approval; statutory sign-off holder and IT owner (tbd during onboard); D-11 numbers; Resend data-hosting and chat-retention legal checks.
- Earlier list, as on origin/main, kept for history: Still open after round 18b (DECISIONS.md, 2026-10-11): hosting, caching and routing (after Phase 1); ~~whether onboarding and level mapping stay in Phase 0~~ **closed by round 21b, item 3:** they stay in Phase 0; questionnaire approval; statutory sign-off holder and IT owner (tbd during onboard); D-11 numbers; Resend data-hosting and chat-retention legal checks.
- Phase 0 is mostly new build, with no effort estimates.
- Item 3.1 (statutory master pack, Wave 1) is pulled early by the owner, overriding the "do not reorder" rule.
- The founder's exemption from maker-checker is a segregation-of-duties risk for founder-only classes (payroll run, large payments, statutory filings).
- ~~On-premises, single-site risk: everything runs on one own server.~~ Superseded by round 18b: hosting is deferred until after Phase 1, so the hosting shape and its single-site risk are open.
- Test counts differ across documents: `ci.yml` says 382, `docs/plan/archive/phase-8-proof.md` says 370, `docs/plan/archive/phase-0-stabilise.md` says 372. There is no single source of truth yet.
