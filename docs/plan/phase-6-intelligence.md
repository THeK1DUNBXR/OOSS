> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 6 — The intelligence

**Duration:** four to six weeks. **Prerequisite: Phases 1, 2 and 5 complete.** An AI layer over an unreliable ledger and an ungoverned query path is a liability, not a feature.

## 6.1 Wire the model into the fence you already built

`apps/api/src/agents/index.ts` is a correct 373-line policy engine: it checks the agent exists and is active, that the tool is declared, that the action is not categorically prohibited, that a value magnitude is within the agent's `AuthorityGrant` ceiling, and that a count ceiling per window is not exceeded; it writes an `agentAction` row, emits an event, notifies a human, and refuses to let an agent approve its own proposal (`:253`). `packages/shared/src/ai.ts` defines six action tiers, four hard prohibitions and eleven prohibited actions.

**It has no callers outside four tests and one admin endpoint.** Seven agents sit in the database from `seed/bootstrap.ts:472-477` with names and ceilings and no implementations.

So: build `apps/api/src/platform/llm.ts` as the single model gateway, and route every agent through `propose()`. Nothing calls a model except this module.

The gateway owns: provider abstraction, per-tenant and per-task token budgets and hard spend caps, step limits and circuit breakers, timeouts, retries, full request/response logging keyed to the `correlationId`, **field-level redaction before the call** (reuse `applyFieldVisibility`, `platform/permissions.ts:463`), and a per-tenant model-region setting so a tenant can require India-region inference — because an inference API in a US region receiving employee data is a cross-border transfer under DPDP.

## 6.2 Approval gates

Classify every tool by **reversibility × blast radius**:

| Class | Examples | Gate |
|---|---|---|
| Read-only | query the semantic layer, summarise a record | Auto |
| Reversible single-record write | draft a quote, tag a lead, suggest an owner | Auto + audit |
| **Irreversible or externally visible** | post a journal entry, generate an IRN, file a return, run payroll, email a customer, transition an employee's state | **Human approval, always** |

IRN generation is irreversible after 24 hours and GST filing is irreversible outright. Those two are **structurally never auto-approvable**, at any authority ceiling, for any agent. Encode that as a hard prohibition in `packages/shared/src/ai.ts`, not as a configuration default.

The four documented agent failure modes and their fixes, all of which belong in the gateway: runaway loops → step limits and token budgets and circuit breakers; **hallucinated actions** (fabricated transaction matches, a welcome email sent prematurely) → **verify the action against source-of-truth data before executing**; context exhaustion → externalise state rather than accumulating the transcript; cost explosion → per-task and hourly spend caps.

## 6.3 The Briefing — the product's centre of gravity

This is the original commission, restated: the Chairman can understand the state of Kaizen from anywhere — what changed, what needs attention, what needs a decision, who is responsible, what the system already handled, and what is likely next.

Build it as a scheduled composition, not a chat response:

1. A deterministic job assembles a **structured change set** since the reader last looked — every material event from the event fabric, scored by the existing S0–S4 severity ladder, every exception, every approval waiting on this specific person, every metric that crossed a threshold, every statutory deadline inside its window.
2. The model's only job is **narration**: turn that structured set into six sentences in the company's own vocabulary. It receives no database access and no tools. It cannot invent a number because every number it is given is already computed and carries a drill-through link.
3. Every claim in the briefing links to the record that produced it. The rule built in Phase 4.2a — a number must carry a drill path or an explicit reason it has none — extends to the briefing.
4. Delivered in-app, by email, and as a WhatsApp or push message. Chairman-first, and — per the standing audience note — lead with the verdict, keep spreadsheet mechanics off the summary, executive tone throughout.

**If only one thing from Phase 6 ships, ship this.** It is the thing the commission actually asked for, it is the thing a large ERP vendor is structurally worst at, and it is achievable with a narration-only model call over deterministic data.

## 6.4 Ask Kaizen

Natural language over the Phase 5 semantic layer. The model picks metrics, dimensions and filters from the constrained vocabulary; the compiler emits the SQL; the answer renders as a chart plus the exact query, so a user can see what was asked on their behalf. A question outside the covered vocabulary gets "I can't answer that yet, here is what I can answer" — **never a guess**.

Stack RAG *alongside* the semantic layer, never in place of it: RAG for unstructured text (policy documents, GST circulars, contracts, the HR handbook, course syllabi); semantic layer for numbers. RAG over business records fails because relevance ranking is not correctness ranking — a vector search will happily return the 2021 refund policy because it is textually similar.

Note for the team: **temperature 0 does not give reproducibility** (GPU batch variance). Anything that must be reproducible is deterministic code, not a model call.

## 6.5 The rest, in order of value

- **Narrow ML, which is mature and is not agentic** — this is the tier that has worked in production for years and it is where the immediate money is: bank-statement to ledger matching, invoice-to-payment reconciliation, duplicate detection, OCR bill digitisation, IMS auto-reconciliation, cash application. Build these before anything conversational.
- **Drafting** — proposals, follow-up emails, job descriptions, course outlines, collection letters. Always drafts, always human-sent.
- **Extraction** — vendor bills, bank statements, resumes, student documents. Always into a review queue, never straight to post.
- **Forecasting** — collections, cash runway, enrolment. Statistical first, model-narrated second.
