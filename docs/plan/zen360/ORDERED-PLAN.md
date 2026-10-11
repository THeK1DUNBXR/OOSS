# Zen 360 ordered plan: owner Phase 0 and Phase 1 (planning only, 2026-10-10)

Status: planning only. Nothing in this plan is built. This file is not authority over the decisions in `docs/plan/zen360/DECISIONS.md`; where they differ, DECISIONS.md governs.

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
9. Open source is learned from by reading and rewriting, never by copying (owner method).

---

## Phase 0: streamline and fix

Intent: no new features in principle. The owner accepted that Phase 0 is mostly new build.

Stop rule for each wave: the wave's listed items are merged, and the gates named for that wave pass. Then the next wave starts. Waves run in order unless marked parallel.

### Wave 0: foundations

- **0.7 Schema split and tooling.** Split the schema into `apps/api/prisma/schema/`. Add `genmap.mjs`. Add scoped test scripts, including `test: prisma validate` and a `migrate diff` no-drift check.
- **0.1 Config and secrets.** Add `platform/config.ts` with Zod validation at load. Remove the fallback at `auth.ts:31` and `TENANT_ENFORCE_MODE` at `context.ts:94`. Add the FX-60 boot refusal at `privacy.ts:944-954`.
  - Test: boot without `JWT_SECRET` exits, naming the variable. Production without `FIELD_ENCRYPTION_KEY` throws.
- **Time helpers.** Add `packages/shared/src/time.ts`. Use it for FX-40 (`documentNumber.ts:92-94`), FX-41 (`domains/compliance/tax.ts:60-63`) and FX-42 (`invoicing.ts:266-269`).
  - Test: `fyOf(2026-03-31T19:00Z) === '2026-27'`.
- **0.8 CI.** Add ESLint and Prettier. Remove the dead classes at `Start.tsx:100,109` and `People.tsx:56`. Add a build identity. Replace `db push` with a migration baseline. The migration baseline sits in Wave 0 (DECISIONS.md, round 10).
- ~~**Worker removal.** Remove the Cloudflare Worker (`worker/index.ts`).~~ **Done; the removal stands** (round 19b, item 2).
- ~~**Hosting.** Serve everything from the own server behind Caddy.~~ **Replacement hosting DEFERRED until after Phase 1 (superseded by round 18b, item 3).** Server, reverse proxy, caching and routing move to "After Phase 1: hosting and operations (deferred)".

### Wave 1: authority, audit, security, statutory data

- **Task-complete fix.** `POST /tasks/:id/complete` (`crm.routes.ts:1108-1109`) has no `assertCan`, audit or emit. Write the failing test first, in its own commit.
- **FX-20 audit registry.** `registerGovernedEntities` (`audit.ts:37`).
- **FX-21.** Drop `force` (`lifecycle.ts:74-119`).
- **FX-22.** Writes with no audit.
- **FX-01 and FX-04.** `decideApprovalStep` (`approvals.ts:309`) and `decideAgentAction` (`agents/index.ts:251`).
  - Test: an ungranted user gets 403 and the state is unchanged.
- **FX-02, FX-03, FX-05.** `hr.routes.ts:844-856`, `crm.routes.ts:243-257`, `agents/index.ts:95-98`.
- **FX-50.** Webhook dedupe, and HMAC with a single webhook secret. Per-tenant HMAC is **DEFERRED (superseded by round 18b, item 1)**; FX-50 is now a single secret.
- **FX-61, FX-80.**
- **FX-24.** Postgres outbox (D-16).
- ~~**FX-51.** RLS on every table: ENABLE and FORCE, default deny, a non-owner app role, and a boot check that the role has neither `rolsuper` nor `rolbypassrls`.~~ **MERGED (#33; round 19b, item 1); extra proof deferred.** Existing ledger-table RLS and tenant scoping stay (round 18b, implications (a) and (g)).
- **FX-06, FX-07, FX-62 to FX-65.** Exceptions, merge, privacy.
- **0.4 Logging.** pino with allowlist redaction (G11).
- **0.3 HTTP hardening.** helmet. CORS allowlist (FX-52, `server.ts:19`). express-rate-limit with a Postgres store. Error leak fix at `http.ts:116-118`.
- **0.2 Sessions.** `jti`. A Session model and logout. A 15-minute access token. A rotating, hashed refresh token. Login throttle.
- **3.1 Statutory master pack.** The owner overrides the "do not reorder" rule for this item.
  - Contents: an EXCLUDE constraint on the date range via `btree_gist`, written as hand-written SQL. Status values DRAFT, APPROVED and HOLD. A citation on every row. Good and bad fixtures.
  - Figures are NOT reproduced in the repository.
  - BLOCKED-BY statutory sign-off.

### Wave 2: scheduler and audit correctness

- **0.5 Scheduler.** Verify the croner licence first. Atomic claim with a unique key on `(tenantId, jobKey, scheduledFor)`. Lease with heartbeat. Backoff. Dead-letter queue.
  - Test: `'0 6 * * *'` fires once per simulated day.
- **0.6 Hash chain.** Unique `(tenantId, prevHash)`. SERIALIZABLE retry (`eventBus.ts:104-105, 158`). FX-81 `verifyChain` (`eventBus.ts:422`).
- Audit gaps in `books.ts`.
- `assertPeriodOpen` on the remaining write paths.

### Wave 3: money and ledger (serial, one person)

- **1.6 Money.** `money.ts` with bigint. Allocate leftover paise to the first line, so 100 split three ways gives 33.34 / 33.33 / 33.33. Delete `round2` (`finance.ts:132`) and the epsilon comparisons.
- **Payment allocation.** `FOR UPDATE` with a DB CHECK. Invoice numbering inside the same transaction (`invoicing.ts:584`).
- **1.1 Ledger models.** `LedgerEntity`, `AccountingPeriod`, `JournalEntry` (with `entityId`), `JournalLine` (bigint), `LedgerAccount`.
- **1.2 Ledger migration.** Hand-written migration with: a deferred balance trigger, immutability, a period trigger, a two-line minimum, RLS with both USING and WITH CHECK, and `SET LOCAL` via `set_config(..., true)`.
  - ~~BLOCKED-BY PgBouncer in transaction mode.~~ **Superseded by round 18b, item 2:** PgBouncer is not a blocker. Revisit only if connections run short.
  - ~~BLOCKED-BY the non-owner role set up on the own server.~~ **Superseded by round 18b, item 5:** the non-owner role is a dev and CI database setting, needed for the immutability test. It is not a hosting item.
- **1.3 Posting.** `post()` is the sole writer (enforced by a lint rule). Idempotency key. A reversal refuses to reverse a reversal (`books.ts:264`).
- **1.4 Balances.** Derived balances and a nightly drift check. Ledger gate tests L1 to L3. FX-30 to FX-35.
- **1.5 Cashbook migration, then delete `model Transaction`.**
  - BLOCKED-BY internal finance head review of the mapping.
  - BLOCKED-BY confirmation of the Kaizen figures: 1,123 vouchers, 66 accounts, a gap of about 40,500. UNVERIFIED.
  - Cutover at a financial year start (1 April), after the trial balance ties to the paisa.

### Wave 4: operations (own server) — moved after Phase 1 (superseded by round 18b)

Moved to "After Phase 1: hosting and operations (deferred)" below. The non-owner DB role is not moved: it stays in item 1.2 as a dev and CI setting (round 18b, item 5).

### Wave 5: ledger consumers and interface (parallel within the wave)

- **FX-70.** Post from domain events.
- **FX-71.** Reversal, not hard delete (`commit.ts:714-746`).
- **FX-72.** Imports via `recordTransaction` in chunks of 500 rows.
- **FX-73.** Payroll posts liabilities (`payrollops.ts:414-455`).
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

- Commitment record.
- Case record.
- One document store.
- Typed task source.
- Decision foreign keys.
- Founder exception view.
- Z3 continuity and handover gate.
- **P7 onboarding state machine** and per-state packs.
  - BLOCKED-BY 3.1 sign-off.
- Level-based access system, assigned at onboarding.
- Thresholds, reserved matters and alternates are entered as data during onboarding ("tbd during onboard").
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
- Delegation with an expiry and a named alternate. Escalate after 24 hours of absence.
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
- COM-02: internal-only shared inbox.
- COM-11: meetings and minutes, typed by people. No recordings.
- Standups are dropped.

### 1F. Staff expense claims

- Claim, approve, and post to the ledger via `post()` on approval.
- Desktop capture only.
- BLOCKED-BY the receipt storage location.

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

- Read and learn only. No third-party code is copied, whatever its licence (owner method).
- Dependencies allowed: pino, express-rate-limit, fast-check (test-only), the LiveKit SDK and server as a service, React Aria, TanStack Table, hey-api, Playwright, schemathesis (dev).
- Licences to verify before use: helmet, croner.
- Ideas studied: pg_ledger, pgledger, Formance, pg-boss, xstate, OpenFGA, Zulip, Taiga, Vikunja, Plane, Kimai, frappe hrms, ERPNext, OpenProject, OpenFisca, Catala.
- The licence check in CI is report-only.

## Access model

Levels are split by stakeholder type:

- Employees: Head, Manager, Staff.
- Founders and owners.
- Contractors and freelancers.
- External auditors and accountants.
- Board and investors.

The level template ships with the app. ~~Editable per tenant at onboarding.~~ **Per-tenant editing is DEFERRED (round 18b, item 1).** Each person holds one level, plus named extra duties. Exact duties per level and read scope are not yet defined (DECISIONS.md, round 10).

---

## Risks and open items

- Still open after round 10, from `docs/plan/zen360/DECISIONS.md`:
  - Statutory sign-off by a qualified person. Values stay DRAFT.
  - Duties per level, and read scope of the non-employee levels.
  - IT owner, as a level assignment at onboarding.
  - Expense receipt storage location.
  - D-11 numbers after the one-month measurement.
  - Legal checks before the first outside user: Resend data hosting, and chat retention (D-14).
- Still open after round 18b (DECISIONS.md, 2026-10-11): hosting, caching and routing (after Phase 1); whether onboarding and level mapping stay in Phase 0; questionnaire approval; statutory sign-off holder and IT owner (tbd during onboard); D-11 numbers; Resend data-hosting and chat-retention legal checks.
- Phase 0 is mostly new build, with no effort estimates.
- Item 3.1 (statutory master pack, Wave 1) is pulled early by the owner, overriding the "do not reorder" rule.
- The founder's exemption from maker-checker is a segregation-of-duties risk for founder-only classes (payroll run, large payments, statutory filings).
- ~~On-premises, single-site risk: everything runs on one own server.~~ Superseded by round 18b: hosting is deferred until after Phase 1, so the hosting shape and its single-site risk are open.
- Test counts differ across documents: `ci.yml` says 382, `docs/plan/archive/phase-8-proof.md` says 370, `docs/plan/archive/phase-0-stabilise.md` says 372. There is no single source of truth yet.
