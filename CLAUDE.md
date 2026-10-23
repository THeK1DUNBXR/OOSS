# CLAUDE.md

Zen 360 (formerly KaiERP) — Kaizen Infinities' operating platform. CRM, HRM, Finance, Education, Command Centre. Multi-tenant, Indian statutory, internal first; commercialisation is a later product phase, not the current aim.

TypeScript pnpm monorepo: `apps/api` (Express + Prisma + Postgres), `apps/web` (React + Vite + Tailwind + TanStack Query), `packages/shared` (vocabulary both tiers import), hosting (server, reverse proxy, caching, routing) is undecided until after Phase 1; the Cloudflare Worker that served the built client has been removed. Schema changes go through `apps/api/prisma/migrations` (never `db push`); `db:drift` gates them in CI.

Plan: Phase 1 is in `docs/plan/zen360/PHASE-1-MASTER-PLAN.md` (23 Oct 2026; the source of truth for Phase 1). Phase 0 is still in `docs/plan/CURRENT.md` and `docs/plan/zen360/ORDERED-PLAN.md`, which stay live for Phase 0 and carry Phase 1 banners. Superseded plan files with no live content move to `docs/plan/archive/` (the old zen360 Phase 1 sections moved there on 23 Oct 2026: `zen360-ordered-plan-phase-1-old.md` and `zen360-roadmap-phase-1-old.md`), where item numbers such as `1.6` remain valid references and old `P0`–`P8` labels are retired. **Read only the one item spec you need.**

## Rules

**1. Money is signed `bigint` minor units (paise).** Never `number`, `float`, or `Decimal` in application code. The money helper exists: `packages/shared/src/money.ts`, with `allocate()` at `:97` (item 1.6, archived spec `docs/plan/archive/phase-1-ledger.md`; owner Phase 0 Wave 3). `packages/shared/src/finance.ts` still uses `number` and `round2` (`:150`) until items 1.5 and 1.6 are done. No `Math.round`, no epsilon comparisons — `>= x - 0.001` means you used the wrong type. Root cause of the existing float bug: `num()` at `apps/api/src/platform/db.ts:302`.

**2. Only `platform/ledger.ts` writes to the journal.** No domain, route, job, script, seed or migration inserts into `journal_entries` / `journal_lines` except via `post()`. The lint rule is in `eslint.config.js` (`:105-123`, with the test-side Prisma rule at `:124-136`); do not disable it. Posted entries are immutable — the app DB role has no `UPDATE`/`DELETE`. A correction is a reversal. Wanting to edit a posted entry means you found a modelling error.

**3. Dates are IST.** Use `packages/shared/src/time.ts`. Never `getUTCMonth()`/`getUTCFullYear()` for a tax period, financial year or document series — IST is UTC+5:30, so 00:00–05:30 on the 1st lands in the previous month, and on 1 April the previous FY and the wrong invoice series. FY is 1 April–31 March. Store instants UTC; derive periods IST.

**4. Every statutory parameter is a date-effective `StatutoryRule` row** — `effectiveFrom`, `effectiveTo`, `jurisdiction`, notification reference in `source`. Never a constant: not the PF ceiling, a PT slab, a GST rate, a TDS section, an ESI percentage or a form number. All of these changed in the last 18 months and several are contested. About to hardcode a number a government can change? Stop.

**5. Every write is permitted, audited, emitted** — `assertCan` → write → `auditWrite` → `emit`, in that order.
Register new entities via `registerGovernedEntities(domain, [...])` (`platform/audit.ts:43`). `auditWrite` throws on an unregistered `subjectType` (`isGoverned`, `audit.ts:55`; the check is at `:420`). It used to return silently, which is how the cashbook ended up outside the audit log. **Not `AUDIT_ACTIONS` (`:20`)**, which is the verb list. Do not use `auditWrite`'s `force` flag to bypass registration.
Events are past tense and validated against the `kz.<domain>.<object>.<verb>` grammar at both ends.

**6. Tenant scope is never optional.** Resolved server-side from the session — never from a body, query param or JWT claim. The Prisma extension injects it, RLS enforces underneath; neither gets an off switch. Jobs, cache keys, object paths, exports, logs and analytics all carry it — most real multi-tenant breaches are a background job that forgot the tenant. Nested Prisma writes bypass the extension: write parent then children explicitly.

**7. A number on screen carries `drillTo` or `noActionReason`.** `Metric` (`apps/web/src/components/ui.tsx:153`) takes `MetricProps` (`:145-146`), a discriminated union (phase-4 audit 4.2a, archived spec `docs/plan/archive/phase-4-interface.md`): exactly one of `drillTo` or `noActionReason` must be passed, and passing both is a type error. The union does not separate withheld from zero, because `value` is a `ReactNode` (`:134`). Keep the triad: **not measured ≠ zero ≠ withheld.** A `noActionReason` must say something true, not "no drill available".

**8. Comments say why, not what.** This codebase's comments explain reasoning and admit past mistakes (`domains/invoicing.ts:244`). Match the register. When you fix a bug that had a consequence, name the consequence.

## Never

- Rewrite `platform/db.ts`, `platform/permissions.ts`, `platform/recordScope.ts`, `platform/lifecycle.ts` or `packages/shared/src/hr.ts` without instruction. Extend them.
- Add a mock to the API test suite. Its value is the real Postgres, real contexts, real evaluator.
- Text-to-SQL. Ever — not behind a flag, not for an internal tool. Best models score 10–17% on schemas this size, and this one has the `invoice → lines → tax_lines` fan-out that yields plausible wrong revenue. Use `packages/semantic`.
- Let an agent post a journal entry, generate an IRN, file a return, run payroll or email a customer without human approval. Hard prohibitions in `packages/shared/src/ai.ts`, not config defaults.
- Send personal data to an inference API without `applyFieldVisibility`, or to a non-India region for a tenant requiring India inference. It is a cross-border transfer under DPDP.
- Hard-delete in the accounting or audit path. Import undo goes by reversal or tombstone, as `revertImport` does (`imports/commit.ts:1190`); keep it that way.
- Add a flag disabling the audit trail, the tenant gate or period close. "Cannot be disabled" is statutory.
- Claim a capability that does not exist. The README's "AI-native" line, with zero model calls in the repo, is why this plan exists.

## Working

Cite `file:line` for any claim about existing code — one time in ten the plausible-sounding description is of code that isn't there. Before claiming a defect is fixed, write the test that fails on the old code.

Every PR: what changed and why, which ORDERED-PLAN item, tests added, migration plan if the schema moved, and — anything in the finance path — the trial-balance assertion.

Before commit: `pnpm typecheck && pnpm lint && pnpm test`. Schema changes: also `pnpm prisma migrate diff`.

Statutory uncertainty: stop and flag it. A wrong constant in payroll is a wrong payslip for every employee of every tenant, discovered via a notice.

Disagree with the plan? Say so in the PR with reasoning. It was written without the code open in front of it.

## Working cheaply here

`docs/plan/EFFICIENCY.md` has the reasoning. The rules:

- **`docs/plan/MAP.md` before any search.** Every model, exported symbol, route and page with `file:line`, plus each file's length. `/where <thing>` looks it up. Only search the source if MAP misses, and say that you had to. Regenerate with `node scripts/genmap.mjs` whenever exports or the schema change — CI fails on a stale map.
- **`Read` with `offset`/`limit`.** MAP gives the line. `invoicing.ts` is 2,030 lines, `createForms.tsx` 2,764, `acceptance.test.ts` 2,855 — opening one whole to change thirty lines costs ~20k tokens for ~300 of signal. `Edit`, not `Write`, unless the file is new.
- **Scoped tests while iterating** — `pnpm --filter @kaizen/api test:books`, etc. Full suite once, before the PR. `/check` runs typecheck and tests with the output already truncated. Pipe every noisy command: `pnpm typecheck 2>&1 | grep -E "error TS" | head -30`.
- **Subagent for fan-out search.** More than three or four files means delegate, and ask for conclusions with `file:line` — not file contents. The excerpts die with the subagent.
- **Do not re-derive what the plan states.** Confirm one line with `grep -n`; do not re-survey. If it does not match, the drift table is in `docs/plan/archive/README-old-index.md`.
- **`/handoff` then `/clear` between phases.** Carrying a finished phase forward pays for it on every subsequent turn.
- **Stop and report rather than half-finish.** A half-converted refactor costs more to recover than to redo.
- **Do not narrate.** Say what changed, at the end. Output tokens cost more than input, and the tool calls are already visible.

## Frontend design system

Kaizen Glass (root `DESIGN.md`, `design/tokens.css`) is the target design system, migrated in stages under proposed sub-phase 1Q (`PHASE-1-MASTER-PLAN.md` section 7). Until 1Q Stage 1 ships, existing `apps/web` screens follow `apps/web/DESIGN.md` and the Tailwind tokens enforced by `scripts/check-tailwind-tokens.mjs` (run by `pnpm lint`). Do not mix the two systems in one screen.
For Kaizen Glass work: use only `design/tokens.css` tokens, applied as `var(--name)`; follow the Do and Don't lists in `DESIGN.md`; keep the "Example data" label (section 5.24) on any screen showing sample figures.
Fonts and brand marks are in `design/fonts/` and `design/brand/`. Do not load fonts from a CDN.
Open questions and known conflicts are in `DESIGN.md` section 10. Do not resolve them silently.

## Build and review policy (D-48)

Source: `PHASE-1-MASTER-PLAN.md` section 4.

- Haiku builds: code, docs, extraction and research. Opus advises and orchestrates only; it does not write the change.
- Sonnet, in a fresh context, reviews every change in a high-stakes area before merge. It never reviews its own work.
- High-stakes areas:
  1. Money and the ledger: `ledger.ts`, `money.ts`, invoicing, payments, refunds.
  2. Payroll and statutory rules: PF, ESI, PT, TDS, GST, `StatutoryRule` rows.
  3. Login, permissions and approvals: `permissions.ts`, 2FA, sessions, approvals, maker-checker.
  4. Data access and the audit trail: tenant scoping, `audit.ts`, RLS.
  5. Personal data: DPDP consent, field visibility, anything sent to an AI model.
  6. Schema migrations.
- The reviewer gets the diff and these rules, not the builder's reasoning. Findings cite `file:line`, or say "no findings".
- Two unresolved disagreements go to Opus, then to the owner.
- Everything else: CI only.
