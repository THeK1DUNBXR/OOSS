# Zen 360 proposal — verified gap analysis and plan additions

The source is _Zen 360 – Unified Group Operating Platform Proposal_, shareable edition, 10 October 2026 (75 pages). It was checked against the repo at `claude/wonderful-gauss-0d3bu5`, 10 October 2026. **No code was changed.** This folder says what the proposal asks for, what the code already does, what is broken underneath it, and where the work sits in the existing phase plan.

**Read this file. Open the registers only for the module you are working on.** Like `MAP.md`, they are lookups, not reading.

| File                  | What it is                                                                                                                                                         | Size                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `FIXES.md`            | 57 deduplicated defects (FX-nn), severity P0–P3, each with file:line, the rule it breaks, whether the plan already has it, and the test that must fail on old code | 32 KB                        |
| `CAPABILITIES.md`     | 379 proposal capabilities (CAP-<module>-nn) across 22 modules: EXISTS / PARTIAL / MISSING, evidence, what to add, controls, dependency, size                       | 146 KB, **never read whole** |
| `INTERCONNECTS.md`    | 45 missing links (IC-nn) between modules that each exist alone, plus the 8 "spine" records                                                                         | 14 KB                        |
| `DECISIONS.md`        | 20 leadership decisions (D-nn). Merges the proposal's p67 register with plan decisions A/B/C (A = D-01, B = D-06, C = D-05)                                        | 19 KB                        |
| `GAPS-IN-PROPOSAL.md` | What the proposal omits, gets wrong, or conflicts with this plan and CLAUDE.md                                                                                     | 14 KB                        |
| `evidence/01–12-*.md` | Raw per-section analyses the registers were built from                                                                                                             | 580 KB, **never read whole** |

### How this was produced, and how far to trust it

Twelve Haiku agents each took a slice of the PDF and checked it against `MAP.md`, the code and `docs/plan/`. Two Sonnet agents merged and deduplicated their output, and **re-opened every P0/P1 citation** before marking it `V`. Seven agent claims failed that check; they are listed under "Rejected claims" in `FIXES.md`. The orchestrator then read the code behind every P0 directly; those rows are marked `V-O`.

Rows marked `U`, and anything in `CAPABILITIES.md` or `evidence/`, are agent work. Per CLAUDE.md, cite the line yourself before acting on one.

---

## 1. Verdict

**The proposal describes the right target, but the codebase is not where the proposal assumes.**

- **Breadth is already there.** There are 377 Prisma models across CRM, HCM, compliance, IT, marketing, equity, board and education. Of the 379 capabilities the proposal implies, **26 exist, 184 are partial and 169 are missing.** Few modules are absent outright. The proposal's 2–4-week "Phase 0 Discovery" is largely what this analysis did.
- **The foundations under that breadth are not safe to expose.** Eight P0 defects let ordinary users approve things they hold no authority over, send unreadable bank files, or forge consent changes. The proposal's success criteria assume approvals, independent review, reconciled finance and evidence integrity. Today the code has the vocabulary for these but does not enforce them.
- **The proposal is shallow where the money is.** It never states the money type, which ledger is the system of record, or the IST period rule. Its "accurate finance" acceptance gate (p4) **cannot be met until Phase 1.5**, because the journal has no writers (FX-70).

My recommendation as advisor: **approve the operating model as the target. Do not approve the proposal's rollout as written.** Run the P0 fixes first, then the plan's ledger phase, then the proposal's operating-control pilot on top of a sound ledger. Section 4 gives the merged sequence.

## 2. Stop-ship: P0 defects (all `V-O`, read in code)

None of these are in the existing plan except FX-40, and that one is cited at a stale line. All must close before any external user, second tenant or pilot. Details and the failing test for each are in `FIXES.md`.

| ID       | Defect                                                                                                                           | Where                                                                                                                      | Consequence                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| FX-01    | `decideApprovalStep` has no `assertCan`, no check that the approver holds authority, and no `auditWrite`. The route is bare too. | `platform/approvals.ts:309-345`, `routes/commercial.routes.ts:497-502`                                                     | Any user except the requester can approve any gated step. The whole DoA model is advisory.                         |
| FX-02    | Capability verify takes the two-person-rule flags from the request body, defaulting to false                                     | `routes/hr.routes.ts:844-856`                                                                                              | One verifier can certify a pay- or promotion-affecting skill alone.                                                |
| FX-03    | Affiliation create accepts a free-string `roleSlug` that becomes the access role                                                 | `routes/crm.routes.ts:243-257`, `domains/identity.ts:456-465`                                                              | A `people.edit` holder can grant any role, including their own escalation.                                         |
| FX-04    | `decideAgentAction` and exception acknowledge/resolve have no `assertCan` and no audit                                           | `agents/index.ts:251`, `platform/exceptions.ts:149,163`, `routes/admin.routes.ts:426`, `routes/command.routes.ts:265-276`  | Any user accepts an AI proposal. This breaks the CLAUDE.md "human approval" prohibition in substance.              |
| FX-40/41 | FY derived with `getUTCMonth()`                                                                                                  | `platform/documentNumber.ts:92-94` (plan cites :67), `domains/compliance/tax.ts:60-63` (**not in plan**) plus 6 more sites | Invoices raised 00:00–05:30 IST on 1 April take the previous FY series. TDS and payroll also land in the wrong FY. |
| FX-50    | Public marketing webhook takes its tenant from `X-Kai-Tenant` or `?tenant=` and checks no signature, with no dedupe              | `domains/marketing/capture.ts:~705-745`                                                                                    | Anyone who knows a tenant's slug can withdraw consent, mark sends delivered, or replay events.                     |
| FX-60    | `FIELD_ENCRYPTION_KEY` silently falls back to a well-known dev key                                                               | `domains/compliance/privacy.ts:944-954`                                                                                    | "Encrypted" PAN, Aadhaar and bank data is readable by anyone with the repo if the env var is missed.               |
| FX-61    | NEFT advice writes `bankIfsc` without decrypting it                                                                              | `domains/hcm/payrollops.ts:~585` vs `compliance/payroll.ts:855`                                                            | The salary bank file carries ciphertext, so the payroll run cannot be paid.                                        |
| FX-80    | `verifyCertificate` always returns `valid:true`; there is no revocation and it needs a tenant login                              | `compliance/corporate/certificates.ts:67-79`                                                                               | The proposal's "competency evidence" claim is unprovable to an employer.                                           |

The P1s that go with these: FX-05 (the agent tier ceiling is not enforced, `agents/index.ts:95-98`), FX-81 (`verifyChain` never recomputes hashes and stops at 5,000 rows while still returning valid, `platform/eventBus.ts:422-450`), FX-20/21/22 (audit registry gaps and `force:true` bypasses), FX-62/63 (DPDP erasure and correction), FX-70–73 (ledger, imports, payroll posting).

## 3. Six structural findings the proposal does not see

1. **The books are not books yet.** `post()` (`platform/ledger.ts:61`) has no non-test caller. Trial balance, P&L, cash, period close and the Tally export all read legacy `Transaction`, and money is `num()` floats in 54 files. Everything the proposal promises for finance, consolidation, collections and close sits downstream of plan Phase 1/1.5. → FX-70, FX-31, D-03.
2. **The controls exist as vocabulary, not enforcement.** Approvals (FX-01), agent decisions (FX-04), verification (FX-02), the audit registry (FX-20–22) and the integrity chain (FX-81) are all named and modelled but bypassable. The proposal's "independent review" (§33) needs these closed, not new features.
3. **The spine records are missing** (see `INTERCONNECTS.md` § Spine). The proposal's core promise is that every commitment has an owner, a backup, a next action and evidence. Today:
   - there is no `Commitment`/obligation model with owner or backup;
   - there is no customer `Case`; complaints exist only as learner exceptions;
   - there are three unlinked document stores (`Document`, `EntityDocument`, `Evidence`) and no upload path;
   - `Decision` has no FK to what it decided;
   - `Task` is untyped (`relatedType`/`relatedId` strings).
     These are **new**, not in any plan file, and they are what the proposal's first pilot actually needs.
4. **Multi-entity is half-built.** `CompanyProfile.tenantId @unique` (`main.prisma:97`) means one tenant is one company. Groups exist as a tenant tree with `EntitySnapshot`. `LedgerEntity` and `JournalEntry.entityId` are in the schema, but nothing writes them. Intercompany is one-sided (`Transaction.intercompanyTenantId`) with no pairing or eliminations, and group totals are floats (`group.ts:132-141`). Decision A must be taken before Phase 1 posts anything (D-01).
5. **Communication capture is absent.** There are no mailbox, telephony, recording or transcript models or adapters. The only senders are marketing-only, env-gated (generic HTTP email, MSG91, WhatsApp Cloud templates), and those map _sent_ to _delivered_ (`whatsappCloud.ts:51`, `msg91.ts:44`). "All communication through the app" is the proposal's most expensive and most legally exposed line (recording consent, DPDP, provider cost). Treat it as an integration programme with its own decision (D-13). Do not build it in-house. Exception: employee company mailboxes are planned in Phase 1E (round 21, OPEN; round 22 clarification on copying open-source mail code, DECISIONS.md).
6. **The AI is a shell.** `platform/llm.ts` is a gateway with no provider call, and its PII list misses fields (FX-65). The README's "AI-native" line (`README.md:3`) is still unsupported. The proposal names runtimes without evaluation gates. Keep all AI behind plan Phases 5–6 and decide the claim now (D-15).

## 4. Sequencing: proposal phases mapped onto the plan

The proposal's Phases 0–4 collide by name with plan Phases 0–8 (its "Phase 1" is an operations pilot; the plan's Phase 1 is the journal). **The proposal's phases are renamed R0–R4 here.** Plan phases keep their numbers, and the plan's dependency rule still holds (1 before 3; 1, 2 and 5 before 6).

| Track                                | Contents                                                                                                                                                                                                                         | Plan phase                                            | Proposal                                     | Gate                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Z0 Stop-ship** (1–2 wks)           | All P0 in §2, plus FX-05, FX-81, FX-20–22                                                                                                                                                                                        | extends Phase 0                                       | R0 "resolve access before exposure"          | each FX's failing test passes; negative access tests for approve, verify, affiliation, agent decide, webhook |
| **Z1 Ledger**                        | Phase 1 + 1.5 cutover; entity on the journal (D-01); FX-30–35, FX-70–73                                                                                                                                                          | Phase 1                                               | prerequisite of R1 "reconcile pilot finance" | README "Done means" 1–3, 6                                                                                   |
| **Z2 Operating-control spine** (new) | `Commitment` (owner, backup, next action, due, evidence); `Case` (customer, learner, complaint; owner, clock, multi-rung escalation); one document store; typed `Task` source; `Decision` FKs; founder exception view over these | **new, runs parallel to Phase 1 for non-money parts** | R1                                           | proposal p4 criteria 1, 2, 4; 24-hour founder-absence scenario                                               |
| **Z3 Connected delivery**            | Lead→contract→project/cohort→invoice→support lifecycles (IC-12–IC-19); continuity and handover gate (IC-19–21); comms capture _integration_ after D-13                                                                           | Phases 2–3                                            | R2, R3                                       | the three lifecycle scenarios (p49–51) pass end to end                                                       |
| **Z4 Group, portals, intelligence**  | Consolidation and intercompany pairing; portals after D-08; semantic layer and AI                                                                                                                                                | Phases 3, 4–8                                         | R3, R4                                       | plan Done 5, 7–11; proposal p64 scenarios                                                                    |
| **Deferred**                         | CCTV, pantry, hybrid desks, MSP catalogue, logistics/procurement, ventures platform, foundation restricted funds (until D-17), recordings and transcripts (until D-13)                                                           | —                                                     | R4 "per readiness"                           | separate business case per pack                                                                              |

**Where I disagree with the proposal:**

- **Discovery.** Its Phase 0 (2–4 weeks) should shrink to a decision sprint. The verification is done, so what remains is decisions D-01 to D-20.
- **Breadth.** It approves the full target, with 11 practice packs, "as a coherent product". With 169 missing capabilities and the staffing on p62 (4–6 FTE, not dedicated), the packs should be **separately funded, not pre-approved**.
- **Gates.** Its pilot gate "reconcile pilot finance" is impossible before Z1. Either Z1 lands first or the pilot gate is reworded to "reconcile to bank statements, outside the books".
- **Testing.** Its acceptance scenarios assume provider doubles (outages, 429s, bank timeouts). CLAUDE.md forbids mocks in the API suite, so provider adapters need their own contract and sandbox suite outside `apps/api` tests.

**Where the proposal should change the plan:**

- The plan has no operating-control spine (Z2), no customer case, no continuity/backup-owner concept, no intercompany or consolidation work, no comms capture beyond employee mailboxes (planned in Phase 1E, OPEN) and no portals. These are real gaps, now captured as Z2–Z4.
- Plan gates are engineering-only. Adopt the proposal's operating gate (p61): named owner, end-to-end scenario, negative access test, support plan, training, export and rollback. Apply it on top of "Done means".

## 5. Decisions needed (full register in `DECISIONS.md`)

These block work. **D-01** (multi-entity), **D-03** (ledger cutover and money type) and **D-09** (authority matrix) block Z1/Z2 and must be taken first. **D-13** (communications and recording) and **D-14** (privacy, retention and erasure vs 8-year retention) need legal owners before any capture work. **D-15** (AI claim and autonomy) should be taken now, because the README makes a claim the code does not support.

## 6. Plan drift found during the review

| Where                                              | Says                                                                    | Actual                                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plan/archive/README-old-index.md` decision A | `schema.prisma:81`                                                      | `apps/api/prisma/schema/main.prisma:97`                                                                                                                                                                                    |
| `docs/plan/archive/phase-0-stabilise.md:51`        | `financialYearStart` at `documentNumber.ts:67`                          | `:92-94`; also `compliance/tax.ts:60` `fyOf`, missing from the list                                                                                                                                                        |
| `CLAUDE.md`                                        | `num()` at `platform/db.ts:150`; hard delete at `imports/commit.ts:721` | `:166`; `:733`                                                                                                                                                                                                             |
| `CLAUDE.md` rule 5                                 | unregistered `subjectType` silently no-ops                              | true. Separately, `force:true` is used at 10+ sites, e.g. `platform/lifecycle.ts:113` (requisition, application, position) and `compliance/payroll.ts:87-320` (every statutory rate table) (FX-21), which the rule forbids |

More drift is in the "Stale-line corrections" section of `FIXES.md`.
