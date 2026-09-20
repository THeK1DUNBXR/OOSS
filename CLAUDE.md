# CLAUDE.md

KaiERP — Kaizen Infinities' operating platform. CRM, HRM, Finance, Education, Command Centre. Multi-tenant, Indian statutory, intended for commercialisation.

TypeScript pnpm monorepo: `apps/api` (Express + Prisma + Postgres), `apps/web` (React + Vite + Tailwind + TanStack Query), `packages/shared` (vocabulary both tiers import), `worker/` (Cloudflare Worker: serves the built client, proxies `/api`).

Plan: `docs/plan/README.md` — index, audit point, known drift. **Read only the one phase file you are working on.**

## Rules

**1. Money is signed `bigint` minor units (paise).** Never `number`, `float`, or `Decimal` in application code. Use `packages/shared/src/money.ts`; splits go through `allocate()`. No `Math.round`, no epsilon comparisons — `>= x - 0.001` means you used the wrong type. Root cause of the existing float bug: `num()` at `apps/api/src/platform/db.ts:150`.

**2. Only `platform/ledger.ts` writes to the journal.** No domain, route, job, script, seed or migration inserts into `journal_entries` / `journal_lines` except via `post()`. There is a lint rule; do not disable it. Posted entries are immutable — the app DB role has no `UPDATE`/`DELETE`. A correction is a reversal. Wanting to edit a posted entry means you found a modelling error.

**3. Dates are IST.** Use `packages/shared/src/time.ts`. Never `getUTCMonth()`/`getUTCFullYear()` for a tax period, financial year or document series — IST is UTC+5:30, so 00:00–05:30 on the 1st lands in the previous month, and on 1 April the previous FY and the wrong invoice series. FY is 1 April–31 March. Store instants UTC; derive periods IST.

**4. Every statutory parameter is a date-effective `StatutoryRule` row** — `effectiveFrom`, `effectiveTo`, `jurisdiction`, notification reference in `source`. Never a constant: not the PF ceiling, a PT slab, a GST rate, a TDS section, an ESI percentage or a form number. All of these changed in the last 18 months and several are contested. About to hardcode a number a government can change? Stop.

**5. Every write is permitted, audited, emitted** — `assertCan` → write → `auditWrite` → `emit`, in that order.
Register new entities via `registerGovernedEntities(domain, [...])` (`platform/audit.ts:37`). `auditWrite` silently no-ops on an unregistered `subjectType` (`isGoverned`, `:134`) — that is how the cashbook ended up outside the audit log. **Not `AUDIT_ACTIONS` (`:17`)**, which is the verb list. Do not use `auditWrite`'s `force` flag to bypass registration.
Events are past tense and validated against the `kz.<domain>.<object>.<verb>` grammar at both ends.

**6. Tenant scope is never optional.** Resolved server-side from the session — never from a body, query param or JWT claim. The Prisma extension injects it, RLS enforces underneath; neither gets an off switch. Jobs, cache keys, object paths, exports, logs and analytics all carry it — most real multi-tenant breaches are a background job that forgot the tenant. Nested Prisma writes bypass the extension: write parent then children explicitly.

**7. A number on screen carries `drillTo` or `noActionReason`.** `Metric` (`apps/web/src/components/ui.tsx:136`) documents this at `:132-135` and **does not enforce it** — both props are optional and 52 of 90 call sites pass neither. Phase 4.2a makes it a discriminated union. Until then it binds anything you write, and a `noActionReason` must say something true, not "no drill available".
Keep the triad: **not measured ≠ zero ≠ withheld.**

**8. Comments say why, not what.** This codebase's comments explain reasoning and admit past mistakes (`domains/invoicing.ts:505`). Match the register. When you fix a bug that had a consequence, name the consequence.

## Never

- Rewrite `platform/db.ts`, `platform/permissions.ts`, `platform/recordScope.ts`, `platform/lifecycle.ts` or `packages/shared/src/hr.ts` without instruction. Extend them.
- Add a mock to the API test suite. Its value is the real Postgres, real contexts, real evaluator.
- Text-to-SQL. Ever — not behind a flag, not for an internal tool. Best models score 10–17% on schemas this size, and this one has the `invoice → lines → tax_lines` fan-out that yields plausible wrong revenue. Use `packages/semantic`.
- Let an agent post a journal entry, generate an IRN, file a return, run payroll or email a customer without human approval. Hard prohibitions in `packages/shared/src/ai.ts`, not config defaults.
- Send personal data to an inference API without `applyFieldVisibility`, or to a non-India region for a tenant requiring India inference. It is a cross-border transfer under DPDP.
- Hard-delete in the accounting or audit path. `imports/commit.ts:721` does; that is the defect, not the precedent.
- Add a flag disabling the audit trail, the tenant gate or period close. "Cannot be disabled" is statutory.
- Claim a capability that does not exist. The README's "AI-native" line, with zero model calls in the repo, is why this plan exists.

## Working

Cite `file:line` for any claim about existing code — one time in ten the plausible-sounding description is of code that isn't there. Before claiming a defect is fixed, write the test that fails on the old code.

Every PR: what changed and why, which phase item, tests added, migration plan if the schema moved, and — anything in the finance path — the trial-balance assertion.

Before commit: `pnpm typecheck && pnpm lint && pnpm test`. Schema changes: also `pnpm prisma migrate diff`.
⚠️ Neither `lint` nor a migrations directory exists yet — Phase 0.8 creates both. Until it merges, run `pnpm typecheck && pnpm test`.

Statutory uncertainty: stop and flag it. A wrong constant in payroll is a wrong payslip for every employee of every tenant, discovered via a notice.

Disagree with the plan? Say so in the PR with reasoning. It was written without the code open in front of it.

## Working cheaply here

`docs/plan/EFFICIENCY.md` has the reasoning. The rules:

- **`docs/plan/MAP.md` before any search.** Every model, exported symbol, route and page with `file:line`, plus each file's length. `/where <thing>` looks it up. Only search the source if MAP misses, and say that you had to. Regenerate with `node scripts/genmap.mjs` whenever exports or the schema change — CI fails on a stale map.
- **`Read` with `offset`/`limit`.** MAP gives the line. `invoicing.ts` is 1,540 lines, `createForms.tsx` 1,898, `acceptance.test.ts` 2,461 — opening one whole to change thirty lines costs ~20k tokens for ~300 of signal. `Edit`, not `Write`, unless the file is new.
- **Scoped tests while iterating** — `pnpm --filter @kaizen/api test:books`, etc. Full suite once, before the PR. `/check` runs typecheck and tests with the output already truncated. Pipe every noisy command: `pnpm typecheck 2>&1 | grep -E "error TS" | head -30`.
- **Subagent for fan-out search.** More than three or four files means delegate, and ask for conclusions with `file:line` — not file contents. The excerpts die with the subagent.
- **Do not re-derive what the plan states.** Confirm one line with `grep -n`; do not re-survey. If it does not match, `README.md` has the drift table.
- **`/handoff` then `/clear` between phases.** Carrying a finished phase forward pays for it on every subsequent turn.
- **Stop and report rather than half-finish.** A half-converted refactor costs more to recover than to redo.
- **Do not narrate.** Say what changed, at the end. Output tokens cost more than input, and the tool calls are already visible.
