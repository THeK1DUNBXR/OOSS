# Architecture

The platform is organised as ten planes. A plane is not a layer in a stack —
several of them are active in the same request. A plane is a question the
system answers exactly once, in exactly one place.

| | Plane | The question it answers once |
|---|---|---|
| P0 | Tenancy | Whose data is this? |
| P1 | Party / Identity | Who is this, and are they one person or two? |
| P2 | World Model | What kinds of things exist, and what may they become? |
| P3 | Relationship Graph | How is anything connected to anything else? |
| P4 | Event Fabric | What happened, in what order, and can we prove it? |
| P5 | Automation | What should follow from that, without a human? |
| P6 | Intelligence | What does it mean, and what would we do about it? |
| P7 | Governance | Who may do this, and under what authority? |
| P8 | Memory | What did we decide, and why? |
| P9 | Experience | How does a person see and act on all of it? |

Each module declares not only what it does but what it **never** does
(`packages/shared/src/planes.ts`). CRM never holds money movement. Finance
never holds a pipeline stage. The prohibitions are the load-bearing half.

---

## P0 — Tenancy is a gate, not a filter

`apps/api/src/platform/db.ts`

Tenant isolation is enforced as a Prisma client extension that intercepts every
operation on every model. It is a **pre-axis gate**: it runs before the five
permission axes are consulted, and it cannot be bypassed by a service forgetting
a `where` clause, because a query that reaches the database with no tenant in
scope throws rather than returning rows.

Three properties are deliberate:

- **A cross-tenant reach returns 404, never 403.** A 403 confirms the record
  exists. From another tenant's vantage point it does not exist, and the
  response says so.
- **`findUnique` degrades safely.** A lookup by primary key cannot carry a
  tenant predicate, so the extension fetches and then verifies tenancy,
  returning `null` on a mismatch.
- **A write cannot move a row between tenants.** `update` and `updateMany`
  strip `tenantId` from the payload before it reaches the database.

There is a warn mode (`TENANT_ENFORCE_MODE=warn`) that logs rather than throws,
for migrating an existing codebase. Production runs in `enforce`.

---

## P1 — Identity resolves once, or refuses

`apps/api/src/domains/identity.ts`

`findOrCreatePerson()` is the only sanctioned way any flow obtains "a person
with these details" — lead capture, admissions enquiry, contact dialog, bulk
import, webhook. Identity forking can only be prevented at creation time, so
that is where it is prevented.

The resolver is biased hard toward false negatives:

- An **exact match** — every primary identifier the caller supplied matching
  the same primary field on exactly one candidate — resolves silently to that
  person and creates no row.
- A **partial match** — two identifiers supplied, one matching and one not —
  raises `MERGE_CANDIDATE` as a 409 with ranked, masked candidates.
- A match against a person holding a **statutory-retention-floor affiliation**
  (`employee`, `student`) never auto-merges, however exact. The floor outranks
  the confidence.

Merging is a separate `people:merge` grant, barred for agents entirely. A
merged row is never deleted; it is marked and excluded from future matching, so
the audit trail survives the merge.

---

## P2 — Pipeline as data

`apps/api/src/domains/pipelines.ts`, `apps/api/src/seed/pipelines.ts`

Stages are rows (`PIPELINE_DEFINITION` / `PIPELINE_STAGE` /
`PIPELINE_TRANSITION`), not an enum. Five commercial motions ship seeded, each
with its own vocabulary and its own SLA budgets — `counselled` is a 3-day stage
in learner admission and `engaged` is a 30-day stage in institutional
partnership, because they are different kinds of waiting.

Cross-motion reporting keys on a **closed eight-value canonical ordinal**
`{0, 10, 20, 30, 40, 50, 60, 90}`, never on stage names. A stage write with no
corresponding transition row is rejected and names the invalid transition.

Post-award stages (`delivering`, `outcome`, `renew_expand_refer`) are retained
so historical rows still render a label, marked `postAward` with no inbound
transitions. Graph reachability validation skips them: requiring a path out of a
stage nothing enters would reject a graph that is in fact sound.

---

## P4 — The event fabric proves its own order

`apps/api/src/platform/eventBus.ts`

Events follow `kz.<domain>.<entity>.<verb>`. All 23 legacy PascalCase names have
canonical counterparts in a crosswalk, and subscribing to a legacy name throws
at registration.

Each event carries a full envelope — actor, subject, related references,
previous and new state, reason, correlation and causation ids, impact, owner,
confidentiality, retention class — and an integrity block:

```
integrity.hash = sha256(prevHash | canonical-json(body))
```

The durable write happens *before* subscriber dispatch, so a handler crash
cannot lose the fact. `verifyChain()` walks the chain independently of the
request context that wrote it, which is what makes it an audit rather than a
self-report. Tampering with any event breaks every subsequent link.

**A read is never an event.** A read of confidential or regulated data produces
an `AUDIT_RECORD`. A future change emitting an event for a read is a
review-blocking violation.

A handler's third failure writes to a durable dead-letter queue rather than only
logging, so a process restart does not lose an in-flight retry.

---

## P7 — Five axes, evaluated at query time

`apps/api/src/platform/permissions.ts`

Every access decision passes through one `evaluate()`, which returns a per-axis
outcome rather than a boolean, so a denial can say which axis denied it.

| Axis | Question | Source |
|---|---|---|
| WHO | Does this principal hold a grant on this resource and verb? | GRANT rows |
| WHERE | Is this record in scope — `own`, `own_or_unowned`, `all`? | scope + resolver |
| WHAT | Does their classification ceiling clear this record's class? | role ceiling |
| HOW MUCH | Is the magnitude within their authority ceiling? | AUTHORITY_GRANT |
| WHY | Is a purpose declared, and does it permit this? | request purpose |

Nothing is cached at login. A grant revoked mid-session takes effect on the next
query, because the next query re-evaluates.

**No service code compares a role slug.** This is enforced by a test that greps
the source. Where a narrowing looks like a role list, it is expressed as data:

- `trainer` scoped to their own batches → a grant `scopeResolver: 'batch_member'`
- supervisory visibility of an org unit's interactions → a grant
  `scopeResolver: 'management_chain'`
- need-to-know on a concealed interaction → a `restricted_interactions:view`
  grant

Holding the grant *is* the condition. Re-pointing any of them is a matrix edit,
not a code change.

An empty cell in the legacy matrix translates to an **explicit grant absence** —
no row — rather than a placeholder with no verbs. The ambiguity is resolved at
translation time rather than left for a permission check to interpret.

### Field visibility has two distinct mechanisms

- **Masking** — the field is present with a `null` value and a named reason.
  Used for money fields the viewer may not see. The viewer knows something is
  withheld.
- **Structural exclusion** — the field is absent from the response shape
  entirely. Used for regulated fields. The stronger guarantee, because a masked
  field's presence is itself information.
- **Concealing** — the record is absent from the payload, the schema *and any
  count*. Used where the existence of the record is the sensitive fact.

---

## Approval gates

`apps/api/src/platform/approvals.ts`

A privileged transition requires all of:

```
holds resource:approve
AND (AUTHORITY_GRANT ceiling >= value  OR  actor is a resolved-tier approver)
AND actor is not the owner            ← the Self-Dealing Bar
AND actor is not an agent             ← categorical AI exclusion
AND actor's role is not system_admin  ← structural exclusion
```

The **Self-Dealing Bar** is unconditional and reroutes rather than blocks: an
approver who owns the record is passed over and the request goes to the next
tier. It never resolves to "approve it yourself, but we logged it".

`system_admin` is excluded structurally, not by ceiling. Platform administration
confers no domain content authority, so there is no value of any variable that
would let it approve a commercial decision.

---

## Health scores

`apps/api/src/domains/health.ts`

One pipeline, instantiated ten times. Every domain score is a weighted set of
factors, each carrying its own value, target, narrative and drill path — a score
is never a number without a route to its evidence, at most three hops away.

Two rules matter more than the arithmetic:

- **"Not yet measured" is never zero.** A domain with insufficient inputs
  renders as unmeasured. Rendering it as 0.0 would state a fact — *this is
  going badly* — that the system does not know.
- **The falsifiability check.** A factor that cannot move in both directions is
  not a measurement. `H_RSK` is a rollup of whether risk is being *managed*
  (unacknowledged severe exceptions, SLA breaches, ownership completeness), not
  a count of how much risk exists — otherwise a working detector suite would
  bottom out the domain it is protecting, and the better the instrumentation the
  worse the score.

`H_RSK` is also excluded from raising factor exceptions about itself, which
would otherwise feed its own inputs.

---

## Exceptions, jobs and ownership

`apps/api/src/platform/exceptions.ts`, `apps/api/src/jobs/`

Severity (S0–S4) and notification priority (N0–N4) are **separate scales**. A
critical fact discovered at 3am is S4 and may still be N1: how bad it is and how
loudly to say so are different questions.

An owner is resolved **before** any notification is sent. An exception nobody
owns is itself a routing defect, counted as one, and surfaced in `H_OPS` —
rather than broadcast to everyone in the hope that someone picks it up.

Escalation is bounded to four named triggers. There is no open-ended "escalate
if still open" rule, because that produces noise that trains people to ignore
the channel.

The job substrate is durable and keyed on
`(automationVersionId, subjectRef, triggerFingerprint, ladderRung)`, so a job
that runs twice does not act twice. The expiry ladders (MoU 90/60/30/7,
contract 120/90/60/30) fire at the **tightest crossed rung** and mark every
wider crossed rung spent in the same write — an agreement first seen 25 days
from expiry notifies once at the 30-day rung, not three times over three runs
for rungs that are already history.

---

## AI

`packages/shared/src/ai.ts`, `apps/api/src/agents/`

Every AI touchpoint is classified into one of six tiers — READ, RECOMMEND,
DRAFT, EXECUTE_WITH_APPROVAL, AUTONOMOUS_WITHIN_POLICY, PROHIBITED — and the
tier is declared per touchpoint, not per model. Twenty touchpoints are
catalogued with their tier, tool surface and boundary.

Four prohibitions hold platform-wide and are not configurable: an agent never
approves, never merges identities, never sends external communication
unreviewed, and never alters a governance record.

An agent principal holds grants bound to its own identity and is never assigned
a role, so its authority is always enumerable rather than inherited.

---

## Money

Three facts, kept distinct, because conflating them is how reconciliation
becomes impossible:

- **Obligation** — Invoice, FeeInstalment. What is owed.
- **Movement** — Payment. What moved. Append-only: a correction is a new row
  with a negative amount pointing at the original, never an update in place.
- **Allocation** — Receipt. An N:N join saying which movement settled which
  obligation. Only the sum of allocated receipts determines what has been paid.

A fourth fact was added with the documents: **statement** — FinalInvoice, the
consolidation raised when the instalments against an invoice are done. It is not
an obligation (nothing new is owed), not a movement and not an allocation; it is
a summary somebody hands over, with its own number and date, and its figures are
snapshotted because a statement that restates itself is not a statement.

### A tax invoice is final

The rule that decides most of the invoicing design. An issued invoice states the
whole obligation and what was handed over on the day, and then never changes: the
copy in the customer's file has to still read the same in three years. A payment
arriving next week is a new fact with its own document, not an amendment to an
old one.

So the surfaces split what the invoice *says* from where the account *stands*.
The printed sheet carries only the figures fixed at issue; the live position, the
receipts and the statements sit in the application chrome, which does not print.

### Two kinds of number

Record codes identify a row to the platform. **Document numbers** are what a
customer quotes back, and they are the company's own:
`KIPL/I/26-27/001` — short code, series letter, financial year, sequence.

The difference matters in one place and matters a lot. A document number is
allocated when the document exists, not when the row is created: a draft carries
a record code and no invoice number, because the tax series has to be consecutive
and a number on a draft nobody issued is a gap the return cannot explain. See
[invoicing.md](invoicing.md).

---

## Record codes

`<TYPE>-<YYYY>-<NNNNN>`, allocated per tenant, per type, per year, gapless
within the year, generator-assigned, never caller-supplied, and rejected as an
edit target for every role. Two tenants each start from `00001` for the same
type and year; there is no shared counter. Sequence exhaustion raises an
operational alert rather than rolling over silently.

The one exception is the tax invoice, and it is a deliberate one: its code is
allocated at issue rather than at creation, and it is a document number rather
than a record code. Everything else about the scheme holds — generator-assigned,
never caller-supplied, immutable once set.

---

## Language

The platform's internal vocabulary is precise and worth keeping. `H_FIN`,
`S3_HIGH_RISK`, `own_or_unowned` and `EX-CRM-014` each mean something exact,
the audit trail is keyed on them, and the governance surfaces need that
precision.

None of it belongs on a screen a counsellor opens on a Tuesday. So one rule
holds across the product:

> **Plain words lead. The code stays available.**

A tile is headed *Money*, not `H_FIN`. A chip reads *High risk*, not
`S3_HIGH_RISK` — and its tooltip carries the code, for the person whose job
needs it. A grant cell still shows `VCEA@own`, because that audience reads it
fluently, and hovering spells it out as a sentence so nobody has to decode it
to check it is right.

Two things this rule is not:

- **It is not "avoid business terms."** A salesperson knows what a lead, a
  pipeline, a quote and a forecast are. Renaming those would make the product
  worse for the people who use it. What gets translated is the *engineering*
  vocabulary underneath.
- **It is not renaming anything in the database.** `packages/shared` and the
  schema are unchanged. The translation lives in one module,
  `apps/web/src/lib/words.ts`, plus the labels the API attaches to what it
  emits.

Empty states say what is true rather than which threshold was not crossed:
*"Nothing significant has changed since you last looked"*, not *"Nothing
crossed the materiality floor in this window."* And where a score has too
little evidence, the screen says **Nothing to measure yet** — never a zero,
because a zero asserts that things are going badly, which is a different claim
from not knowing.
