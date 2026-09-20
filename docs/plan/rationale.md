# Why this plan is shaped this way

Read once. Not needed during execution — `docs/plan/README.md` and the phase files carry everything operative.

Audit point `origin/main` @ `1656498`, 12 September 2026.

---

## 0. Read this before you read anything else

You are not being asked to rewrite this codebase. You are being asked to finish it.

The audit that produced this brief read all 4,031 lines of the Prisma schema, all fourteen `platform/*` files, the domain layer, the route layer, the 370-test suite, every one of the 38 frontend files, and the deployment configuration. The finding is not what the commissioner expected when he called the build "shit."

**The finding is that this repository contains two things of real, uncommon value and one thing that is genuinely unfinished.**

The two valuable things:

1. **A structurally-enforced multi-tenant data gate.** `apps/api/src/platform/db.ts` injects `tenantId` into every top-level `where` and `data` through a Prisma `$extends`, and *throws* `TenantScopeError` when no tenant is in scope rather than degrading to an unscoped query. `contextMiddleware` (`apps/api/src/lib/http.ts:26`) resolves the tenant from the database user record on every request (`:35`, substituted at `:53`), never from the JWT claim. Cross-tenant reach returns 404, not 403, so the existence of a foreign record does not leak. This is better than most shipped commercial SaaS.

2. **A five-axis authorisation engine that is data, not code.** `apps/api/src/platform/permissions.ts` (518 lines) evaluates WHO / WHERE / WHAT / HOW_MUCH / WHY per request against `AuthorityGrant` rows. It handles the two cases nearly everybody gets wrong: `assertScopeAll` refuses to hand a company-wide aggregate to an `own`-scoped principal, and `visibilityWhere` returns an *unsatisfiable* filter when no grant resolves, so a forgotten assertion degrades to an empty list rather than the whole table. Denials carry per-axis reasons, and `ErrorBox` (`apps/web/src/components/ui.tsx:212-224`) maps the `axes[]` array and colours each one passed or failed, so a user is told *which* axis refused them.

Alongside those: 115 Prisma models with tenant-leading composite indexes throughout, a hash-chained event fabric, twelve HR lifecycle state machines shared between API and UI from `packages/shared/src/hr.ts:755` so the interface cannot offer an action the server will refuse, per-line GST arithmetic that gives the odd paisa to CGST and carries `roundOff` explicitly, a financial-year-aware document numbering series capped at 16 characters because the GST portal rejects longer, and 370 integration tests that run against a real Postgres inside real request contexts with no mocks.

That is not the work of someone who does not know what they are doing.

**The thing that is genuinely unfinished — and it is the load-bearing thing:**

The accounting is not accounting. `model Transaction` (`apps/api/prisma/schema.prisma:3731`) is a single row with one `accountId`, a `direction` of `in|out`, and one positive `amount`. There is no `Journal`, no `JournalLine`, no pair of entries that must sum to zero, no invariant that can ever fail and therefore no invariant that ever catches anything. It is a categorised cashbook with a P&L view on top. Every downstream claim — the balance sheet, the trial balance, the GST return, the audit trail, the eight-year statutory retention — rests on a structure that cannot support them.

And the frontend is a hand-written CRUD admin panel: 69 duplicated `<table>` blocks across 18 files, zero code splitting, zero error boundaries, eleven `aria-*` attributes in 19,000 lines (seven of them `aria-hidden`), 98 responsive utilities in the entire application with none at all in the shell, and no tests of any kind.

And there is no AI in it. Not one model call. `grep -rn "openai\|anthropic\|@ai-sdk" --include=package.json .` returns nothing. Seven agents are seeded as database rows in `apps/api/src/seed/bootstrap.ts:472-477`, a careful 373-line policy engine at `apps/api/src/agents/index.ts` governs what they may propose, and **nothing ever calls it except four tests and one admin endpoint.** The fence is excellent. There is nothing inside it.

**So the honest verdict is: this is roughly 70% of a very good ERP, where the missing 30% is the 30% that makes the other 70% trustworthy.** Your job is the 30%, plus the work of turning a competent admin panel into something a Chairman opens on a phone at 9pm and understands in four seconds.

Do not start over. Starting over would destroy `platform/db.ts`, `platform/permissions.ts`, the shared state machines, the GST arithmetic and the test suite, and you would spend six months rebuilding them worse.

---

---

## 1. What "best in the world" has to mean here, concretely

"Revolutionary" is not a feature list. For this company, in this market, it resolves to five claims that must be *demonstrably true* when the work is done. Every phase in this plan exists to make one of them true.

**Claim 1 — It cannot lie about money.**
Every rupee is a balanced journal entry stored in integer paise. `SUM(debit) = SUM(credit)` is a database constraint, not a code path. Posted entries have no `UPDATE` and no `DELETE` — the grant is revoked at the role level, so it is not policy, it is physics. Balances are derived from entries and a nightly job re-derives them and screams if the cached snapshot drifts by one paisa. A correction is a reversal. This is simultaneously the correct engineering answer, the cheapest route to Companies (Accounts) Rules Rule 3(1) compliance, and a 1:1 map onto how GST credit notes and TDS corrections already work.

**Claim 2 — It is statutorily correct for India, and stays correct when the law changes.**
Not "GST-ready." Specifically: IRN generation through a GSP with the 30-day hard rejection modelled as a business rule and not a reminder; GSTR-1 Table 12/13 with validated HSN/SAC masters; GSTR-1A as a first-class amendment workflow because Tables 3.1/3.2 of GSTR-3B have been non-editable since July 2025 and Table 4A since July 2026; IMS accept/reject/pending; payroll that computes PF, ESI, Tamil Nadu professional tax *by local body*, gratuity under the Social Security Code, and the Labour Codes' 50% wage-deeming rule that means PF wage, ESI wage, gratuity wage and bonus wage are no longer the same number. And every one of those parameters — the ₹15,000 PF ceiling, the PT slabs, the GST rate per HSN, the TDS section numbering that changed wholesale when the Income-tax Act 2025 took effect on 1 April 2026 — is a **date-effective row in a versioned statutory master pack**, never a constant in a TypeScript file. Every single one of those changed in the last eighteen months.

**Claim 3 — It answers questions instead of displaying tables.**
The Chairman's stated requirement, from the original commission, is to "understand the state of Kaizen from anywhere — what changed, what needs attention, what needs a decision, who is responsible, what the system already handled, what is likely next." That is not a dashboard. It is a briefing, and it is the thing this product can be best in the world at, because it is the thing SAP and Oracle are structurally worst at.

**Claim 4 — The AI is real, and it is fenced.**
The industry-wide honest position in 2026 is that shipped ERP agents still require human confirmation before consequential actions, and that the differentiator is not the model but the clean data model and the explicit named actions the agent is written against. You are in an unusually good position: you own the data model, you have twelve explicit state machines, you have a five-axis permission evaluator, and you already have an agent-proposal policy engine with monetary ceilings and a self-approval bar. Wire a model into the fence you already built. Do **not** do text-to-SQL — on enterprise-scale schemas the best models score around 10–17% and the failures are plausible wrong numbers, not errors. Build a typed semantic layer and let the model pick from a constrained vocabulary.

**Claim 5 — It is a product, not an installation.**
Tenant onboarding as a resumable state machine. Per-tenant statutory configuration. A dedicated-database tier for enterprise tenants. Data residency in India, because Rule 3(5) requires books of account in electronic mode to be backed up daily on servers physically located in India and Rule 3(6) requires the company to disclose the provider and location to the Registrar. SOC 2 Type II on the roadmap, because your customers' auditors must report under Rule 11(g) whether the audit trail operated all year and was not tampered with, and they will ask you for evidence.

---

---

## One thing the audit got wrong, and the lesson in it

**One claim was wrong, and it is load-bearing.** The first audit stated that the `Metric` component "structurally requires `drillTo` or `noActionReason`, so a dead number is a compile error." It does not. Both are plain optionals (`apps/web/src/components/ui.tsx:147-148`), there is no discriminated union and no runtime check, and the component renders unwrapped when `drillTo` is absent (`:167-173`). `<Metric label="x" value={1} />` typechecks and ships.

What actually exists is an *aspiration in a doc comment* at `ui.tsx:132-135`. The audit read the comment and reported it as the implementation — exactly the failure mode `CLAUDE.md` warns about, committed by the document that warns about it.

And it is not a near miss in practice: **52 of 90 `<Metric>` call sites — 57% — pass neither prop**, including every figure on the GST return screens (`pages/GstReturns.tsx:350-353,569-571`), the receipt and final-invoice document headers (`ReceiptDocument.tsx:206,207`, `FinalInvoiceDocument.tsx:273,274`) and `Courses.tsx:82,83`.

This matters because §6.3 builds the Briefing on top of the property and `CLAUDE.md` rule 7 extends it to every AI-produced claim. **You are not preserving it. You are building it for the first time, across 52 existing violations.** That work is now Phase 4.2a.

The two sibling claims in the same sentence *are* true and worth keeping: the `not-measured ≠ zero ≠ withheld` triad (`ui.tsx:189-200`) and `ErrorBox` rendering the five-axis denial trace (`ui.tsx:212-224`).

The lesson generalises, and it is why `CLAUDE.md` demands `file:line` for any claim about existing code: **a doc comment describing intent reads exactly like a description of behaviour.** This codebase's comments are unusually good, which makes the trap unusually easy to fall into. Confirm the line, not the paragraph.
