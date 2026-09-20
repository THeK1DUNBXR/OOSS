# Kick-off prompts

One phase per session. Paste one, let it finish, review the PR, merge, `/handoff`, `/clear`, next.

Every prompt below already carries the budget block. If you are writing your own prompt for something outside this plan, paste the block from the top of it.

---

## The budget block

This is the reusable part. It goes at the top of any prompt, for any task, in any repo — it is worth more than everything else on this page because it turns off five default behaviours that each cost tokens and none of which you asked for.

```
Work to a token budget. Before you begin:

- Read ONLY the files I name. Do not read siblings, do not "get oriented", do not
  survey the repo. docs/plan/MAP.md has every model, symbol, route and page with
  file:line — look things up there, not by searching.
- Read with offset/limit against MAP's line numbers. Never open a file over 400
  lines whole. Use Edit, not Write, unless the file is new.
- Do not narrate. No "let me...", no "now I'll...", no restating the task back to
  me, no summary of what you just did beyond one or two sentences at the very end.
- Batch independent tool calls into one message. Do not run them one at a time and
  comment between each.
- Any search touching more than three files goes to a subagent, and the subagent
  returns conclusions with file:line — not file contents.
- Pipe noisy commands: `2>&1 | grep -E "error" | head -30`, `| tail -20`. Never let
  a full test or build log into context.
- Do not re-read a file you just edited. Edit would have errored if it failed.
- Do not re-verify facts I have given you. Confirm a single line with grep -n if it
  is load-bearing; do not re-audit.

While you work:

- Stop when the named scope is done. Do not improve adjacent code, do not add tests
  I did not ask for, do not refactor on the way past.
- If you hit something the task did not anticipate, stop and ask in one sentence.
  Do not explore your way to an answer.
- At roughly 70% context, stop, run /handoff, and tell me what is left. Do not push
  on to a half-finished refactor — recovering one costs more than redoing it.
```

---

## Session 0 — orientation

Already run, 12 Sep 2026 against `1656498`. Re-run only if the branch moves substantially before execution starts.

```
[budget block]

Read docs/plan/README.md and CLAUDE.md. Nothing else.

Verify their factual claims about this codebase — paths, line numbers, counts,
absences. Send the checking to subagents, three or four claims each, in parallel, and
have each return only: claim, verdict, actual file:line if wrong.

Report only the claims that are wrong or stale. Do not list what checked out. No code.
```

---

## Session 1 — Phase 0, stabilise

```
[budget block]

Read docs/plan/phase-0-stabilise.md. That file is the whole task — do not read other
phase files, and do not read the source to "understand the codebase" first. Every
defect in it has a file:line; go straight there.

Order: 0.1, then 0.7 and 0.8, then the rest. The schema split and MAP come early
because every later item in this phase otherwise pays to read a 4,031-line schema.

One commit per numbered item, each with a test that fails before and passes after.
Do not touch the ledger, the finance models, or the frontend beyond the dead Tailwind
tokens.

Line numbers were taken at 1656498. app.use(cors()) is now server.ts:18 and
startScheduler() :88 — README has the rest of the drift. If a citation does not match,
grep for the symbol; do not re-read the file.

0.5 and 0.6 are the substance. If you run short, do those and stop.
```

---

## Session 2 — Phase 1, the ledger

Plan mode (`shift+tab` twice). The plan-mode instruction is itself a token saving: code written before the design is settled gets rewritten, and you pay for both.

```
[budget block]

Read docs/plan/phase-1-ledger.md and CLAUDE.md rules 1-3. Nothing else yet.

Stay in plan mode until I approve. Write no code, create no files. Four things to
settle, and for each, tell me what you need to read before you read it:

1. Chart-of-accounts mapping — the accountType for each existing LedgerAccount, as a
   CSV. Flag every one you are unsure of instead of guessing.
2. Contra-account derivation per Transaction.source (manual, bank_import, payroll,
   invoice, vendor_bill, recurring, asset, loan): which two accounts, where the tax
   lines come from. This is the part that will be wrong if anything is.
3. Posted-directly-as-posted with a separate draft table, or a narrow status UPDATE
   via SECURITY DEFINER. The file prefers the first — disagree if you do.
4. Confirm entityId goes on JournalEntry now, with one entity.

After approval, build in this order and commit at each arrow: models + migrations →
invariant triggers with the test proving each refuses the app role → platform/ledger.ts
→ migration script → equivalence assertion → balance projections → delete Transaction.

Do not delete model Transaction until equivalence passes against the real books
(1 Feb–27 Aug 2026, 1,123 vouchers, 66 accounts). The ~₹40,500 inherited gap becomes a
visible suspense account, not a forced zero. Those figures are unverified — if they do
not reconcile, say so and stop. Do not adjust anything to make them fit.
```

---

## Session 3 — Phase 2, the audit spine

```
[budget block]

Read docs/plan/phase-2-audit.md and execute it.

2.1 is Rule 3(1): audit trail of every transaction, edit log with date, cannot be
disabled. "Cannot be disabled" means a database trigger, not an application call a
future developer forgets — which is exactly what happened in books.ts.

Build the trigger first, then prove it with one test: bypass the domain layer, write
raw SQL to a books-of-account table as the app role, assert the audit row appeared.
That single test is the deliverable for 2.1; do not write a suite around it.

For 2.2 build ConsentLedger and the three rights endpoints only. Breach workflow and
purpose tagging are later — do not start them.

In the PR, state how erasure interacts with the 8-year s.128(5) retention. Two
sentences. Do not research it further than the file goes.
```

---

## Session 4 — Phase 3.1, statutory pack

Plan mode. **3.1 only** — the scope fence is the saving here; this phase file covers four sessions' work.

```
[budget block]

Read docs/plan/phase-3-statutory.md, section 3.1 ONLY. Stop reading at 3.2. E-invoicing,
returns and payroll are separate sessions — do not read them, do not start them, do not
mention them.

Plan mode first: propose the StatutoryRule key namespace — exact keys and jurisdiction
strings for GST rates, PF, ESI, TN professional tax by local body, gratuity, bonus and
the Income-tax Act 2025 TDS sections. One table. No code until I approve it.

Then seed from the values in the file, writing the notification reference into `source`
for each. Do not search the web to confirm them — the file states what is verified and
what is not, and that distinction is the point.

Three flagged values:
- PF ceiling ₹15,000, not ₹25,000. The file says why. Do not re-litigate it.
- Income-tax form renumbering: do NOT seed. Sections 392/393/394 only, form numbers as
  TODO, and one line in the PR saying someone must read Notification 22/2026 Appendix
  III before any certificate is generated.
- TN labour rules are draft: seed central, mark TN pending, and make the lookup behave
  correctly when a jurisdiction has no rule.

Finish with the statutory-pack diff CLI.
```

---

## Session 5 — Phase 3.2, e-invoicing

```
[budget block]

Read docs/plan/phase-3-statutory.md section 3.2 only.

One web fetch before you start, not a research session: get the live INV-01 schema
version and API version from einv-apisandbox.nic.in and tell me how they differ from
the file's assumption (v1.1 / API 1.03). One paragraph. Do not read the surrounding
documentation.

Build against a GSP adapter interface with a NIC-direct implementation behind it. The
GSP is not chosen; it must not reach the call sites.

Three things matter, in order:
1. The 30-day rule as a hard business rule — back-dating refused for liable tenants,
   escalation at T+25, dead-letter and alert on IRP failure.
2. Dual-instance failover across e-invoice-1/2. Same credentials, nearly free.
3. Idempotency. The IRP will time out; the IRN is a deterministic hash, so check
   before resubmitting. Token cache per tenant, never per request.

Nothing else in 3.2 this session.
```

---

## Session 6 — Phase 3.4, payroll

```
[budget block]

Read docs/plan/phase-3-statutory.md section 3.4 only. Rebuild payroll on the statutory
pack from Session 4 — read the StatutoryRule model and the pack seed, not the whole
statutory phase again.

Build in this order, and do not start the next until the previous has a passing test:
1. Per-component "included in wages" flag and the Labour Code 50% deeming computation.
   Four separate wage bases come out of this — PF, ESI, gratuity, bonus. Everything
   else sits on top of it, so it is wrong first or it is wrong everywhere.
2. Each statutory calculation against its wage base.
3. The payroll run posting exactly one balanced journal entry through
   platform/ledger.ts. Not transactions directly.

ESI is modelled on the contribution period (Apr-Sep, Oct-Mar), not the month.
PT is per local body — Madurai Corporation. Never "Tamil Nadu" as one rate.

Write the payslip test first, with one worked example I can check by hand. Seed from
the 12-person roster; do not invent test employees.
```

---

## Session 7 — Phase 4, the interface

Five PRs, and **five separate sessions**. Pasting this once and letting it run all five is how a session runs out of context at 60% of the work.

```
[budget block]

Read docs/plan/phase-4-interface.md. Execute PR <N> ONLY — stop and hand off when it
is done. Do not begin the next.

PR 1 — 4.1 foundations. Code splitting, error boundary, 401 interceptor, generated
typed client. Make `any` a lint error in apps/web and clear it. There are 97 real
annotations; a grep says 114 because it counts the English word. Do not count them
again.

PR 2 — DataTable in packages/ui, then convert all 69 tables. Get the list of the 69
from a subagent in one call — file:line only, no excerpts — then convert mechanically.
Do not read each page to understand it first; the conversion is structural.

PR 3 — remaining primitives, then 4.2a. For 4.2a change the props to a discriminated
union FIRST and let the compiler produce the worklist. Do not grep for Metric call
sites; tsc will list all 52. A noActionReason must say something true — document
headers legitimately have nothing beneath them, GST return figures do not and should
drill.

PR 4 — accessibility. Wire axe-core into CI first so there is a number to move, then
work the list it produces. Do not audit by reading components.

PR 5 — mobile, field surfaces only: enrolment, receipts, attendance, expenses,
approvals, the Briefing. Nothing else gets a breakpoint this pass.

Preserve and extend, never replace: the tailwind token file including the protanopia
note, the not-measured/zero/withheld triad, ErrorBox's five-axis trace, and the UI
copy. The copy is better than any ERP I have seen — do not "improve" it.
```

---

## Session 8 — Phase 5, the semantic layer

Plan mode.

```
[budget block]

Read docs/plan/phase-5-semantic.md. Build packages/semantic.

Plan mode until I approve. The definitions are the product, so we agree them before
any code exists. Finance first — revenue, collections, receivables, runway, gross
margin by division. For each: the one-sentence definition a human would defend in a
board meeting, and the grain it computes at. Revenue comes off journal lines filtered
to income accounts, not off invoices. If two people here would mean different things
by a word, it gets two names.

Propose those in one table. Do not read the domain layer to derive them — ask me.
I know what we mean by revenue; the code does not.

Then build the compiler. The property that matters: it knows every entity's grain and
REFUSES a combination that would fan out, rather than silently multiplying revenue by
the line count. This schema has exactly that shape.

Permissions fold in at compile time via visibilityWhere. A metric without a grant is
not compilable, and the refusal carries the same five-axis reason as everything else.

Eval harness last: 200+ verified numeric answers per module, exact match, plus the
adversarial set — fan-out, NULLs, 31 Mar / 1 Apr, 00:00-05:30 IST on the 1st,
cross-tenant probes, injection payloads in note fields. Generate these from the data,
not by hand.
```

---

## Session 9 — Phase 6.3, the Briefing

Do this before the rest of Phase 6.

```
[budget block]

Read docs/plan/phase-6-intelligence.md section 6.3 only.

Two strictly separated halves, and the separation is the whole design:

1. A deterministic job assembling a structured change set since this reader last
   looked — material events scored by the S0-S4 ladder, open exceptions, approvals
   waiting on this person, metrics crossing thresholds, statutory deadlines in window.
   Every item carries the record it came from.
2. A narration call that only turns that structure into six sentences. No database
   access, no tools, no numbers it was not handed. It cannot invent a figure because
   it cannot look one up.

Build half 1 completely, with tests, before writing half 2. If half 2 needs anything
half 1 does not provide, that is a bug in half 1.

Also build platform/llm.ts here as the single model gateway — token budgets, spend
caps, timeouts, logging keyed to correlationId, field redaction through
applyFieldVisibility before anything leaves the process. Nothing else in this codebase
ever calls a model.

Every claim links to its record. Lead with the verdict, executive tone.
```

---

## Session 10 — Phase 6.1/6.2, agents

```
[budget block]

Read docs/plan/phase-6-intelligence.md sections 6.1, 6.2 and 6.4.

agents/index.ts is already correct and has no callers. Wire callers into it — do not
modify it without telling me why first.

Start with the non-conversational tier, one at a time, each shipping before the next
starts: bank-statement to ledger matching, invoice-to-payment reconciliation,
duplicate detection, OCR bill digitisation, IMS reconciliation. Every one proposes; a
human confirms.

Classify tools by reversibility × blast radius per the file. Encode as hard
prohibitions in packages/shared/src/ai.ts, not config defaults: posting a journal
entry, generating an IRN, filing a return, running payroll, emailing a customer —
never auto-approvable, at any ceiling, for any agent.

Every action verifies against source-of-truth data before executing. A fabricated
transaction match that looks right is the documented failure mode and the expensive one.

Then 6.4, over the Phase 5 semantic layer only. Outside the vocabulary: "I can't
answer that yet, here is what I can." Never a guess. Show the compiled query.
```

---

## Why each line of the budget block is there

Worth understanding, because you will want to write your own prompts.

**"Read ONLY the files I name."** The default opening move is to look around. On this repo that is a few greps and a whole-file read or two before any work starts — 10–20k tokens, every session, for context that MAP already holds.

**"Never open a file over 400 lines whole."** `invoicing.ts` is 1,540 lines, `acceptance.test.ts` 2,461. Opening one to change thirty lines costs ~20k tokens for ~300 of signal.

**"Do not narrate."** Output tokens cost several times input. "Let me look at X" → look → "I found Y, now I'll do Z" → do → "I've done Z" triples the output on every step, and the tool calls are already visible to you.

**"Batch independent tool calls."** Four reads in one message cost one round trip. Four messages cost four, each re-sending the accumulated context.

**"Subagent for anything over three files."** A fan-out search dumps excerpts into the window and they stay there for the rest of the session, even though only the conclusion mattered. In a subagent the excerpts die and a paragraph comes back.

**"Pipe noisy commands."** A passing run of 372 tests prints 372 lines. `--reporter=dot` makes it one. A failing `tsc` prints the whole program; `grep -E "error TS" | head -30` makes it thirty.

**"Do not re-read a file you just edited."** Edit errors if it fails to apply. Re-reading to confirm is paying twice for the same bytes, and it is a very common default.

**"Do not re-verify facts I have given you."** The phase files carry exact line numbers. Re-auditing to confirm them pays twice for one fact.

**"Stop when the named scope is done."** Gold-plating — the extra tests, the adjacent refactor, the improvement on the way past — is the largest single source of unasked-for tokens, and it also makes PRs harder to review.

**"Stop and ask rather than explore."** An agent that explores its way to an answer can spend 30k tokens on what one sentence from you would have settled.

**"At 70% context, hand off."** A refactor abandoned at 90% costs more to diagnose and recover than to redo from a clean session.

## The two things the prompt cannot do

**`/clear` between phases.** Nothing in a prompt prevents you from continuing in a window that already holds a finished phase. Carrying Phase 1 through Phase 3 pays for the ledger conversation on every subsequent turn.

**Holding it to `file:line`.** When it says "the current implementation does X", ask which line. Roughly one description in ten is of code that would be reasonable rather than code that exists — that is exactly how the `Metric` error got into this plan, and building on a wrong claim costs far more than checking one line.
