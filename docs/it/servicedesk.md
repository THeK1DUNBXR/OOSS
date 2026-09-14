# Service desk

Workstream D of the Technology module (`docs/plan/cio.md`). `ExceptionRecord`
is what the platform raises against itself; this is what a person raises —
a ticket, worked through a small state machine, held to an SLA clock stamped
from a dated policy table, with a knowledge base the desk can point a
requester to instead.

---

## Model

**`ItSlaPolicy`** — the dated target table: priority `P1`..`P4` maps to a
response and resolution budget in minutes, and whether that budget counts
only business hours (Mon–Fri 09:00–18:00 IST). Effective-dated like a
statutory rate (Principle 4) — a new row supersedes the old one from its
`effectiveFrom` date forward, and a ticket already triaged under an earlier
row keeps the due times it was stamped with. **The seeded table (P1 30m
response / 4h resolution … P4 1d / 10d) is a starting point Kaizen
Infinities has not committed to as a target** — every screen that shows an
SLA figure repeats that.

**`ItTicket`** — `requesterPartyId` (who raised it), `assigneePartyId` (who
is working it), `category` (incident | request | access | question),
`priority` (`P1`..`P4`, set at triage), `status` (`new` → `triaged` →
`in_progress` → `waiting` → `resolved` → `closed`, with a `REOPEN` event
taking a resolved ticket back to `in_progress` — a "reopened" ticket is
simply back in progress, not a seventh state), `subject`/`description`,
bare `assetId`/`applicationId` (resolved by another workstream, never a
Prisma relation here), `respondDueAt`/`resolveDueAt` (stamped once at
triage — see IT-SLA-001 below), `firstRespondedAt` (stamped on `START`),
`resolvedAt`/`closedAt`, `satisfaction` (1–5, set once by the requester),
`slaBreachNotified` (`["response"]`/`["resolution"]`, so the breach job
fires each clock at most once), `waitingSince`.

**`ItTicketComment`** — append-only; `internal` comments are desk
conversation, hidden from the requester.

**`ItKnowledgeArticle`** — `draft` → `published` → `retired`, `helpfulCount`
a plain counter (not one vote per person — the screen says so).

## Pure arithmetic (`packages/shared/src/it/servicedesk.ts`)

- **`dueFrom(createdAt, minutes, businessHoursOnly)`** — the SLA due time.
  With `businessHoursOnly` false it is plain calendar arithmetic; true, it
  counts only Mon–Fri 09:00–18:00 IST, skipping weekends and after-hours
  entirely (a ticket raised at 17:30 with a 4-hour budget is due mid-morning
  the next business day, not 21:30 the same evening).
- **`slaAttainment(rows)`** — the percentage of `{met: boolean}` rows that
  met their clock; `null` for an empty set (Principle 6 — "not yet
  measured" is never a false 100%).
- **`medianMinutes(values)`** — the median of a set of minute values, `null`
  when empty.
- **`backlogAgeBuckets(createdAts, now)`** — open-ticket ages bucketed into
  0–1 / 2–7 / 8–30 / 30+ days.
- **`ticketMachine`** — the lifecycle machine (`createMachine` from
  `packages/shared/src/hr.ts`), so the API and the detail screen's buttons
  can never drift from each other.

All four are tested without a database (`IT-SLA-ARITH-00x` in the test
file).

## Seed (`apps/api/src/seed/it/servicedesk.ts`)

Upserts the four `ItSlaPolicy` rows above, effective from 2024-01-01,
idempotently by `(priority, effectiveFrom)`.

## Domain (`apps/api/src/domains/it/servicedesk.ts`)

- **`createTicket({category, subject, description, assetId?,
  applicationId?, requesterPartyId?})`** — `requesterPartyId` defaults to
  the caller; only a caller holding `all` scope on `it_tickets` may raise a
  ticket in someone else's name.
- **`listTickets({tab, status, priority})`** — `tab` is `mine` | `unassigned`
  | `open` | `breached` | `all`. Visibility: an `all`-scope grant sees
  everything; an `own`-scope grant (the employee row) sees only tickets
  where `requesterPartyId` **or** `assigneePartyId` is theirs — the generic
  WHERE axis only narrows on one field, so this file builds the OR itself
  rather than pretending a single scope field covers it, per the plan's own
  instruction to map `requesterPartyId` → the owner field for evaluation
  and separately allow the assignee through.
- **`getTicket(id)`** — the same visibility rule, plus `availableTransitions`
  (from `ticketMachine`), `canRate` (true only for the requester on a
  resolved/closed, unrated ticket), and comments filtered to hide internal
  notes from anyone who is not desk staff.
- **`triageTicket(id, {priority, category?})`** — only legal from `new`
  (the `TRIAGE` event). Resolves the `ItSlaPolicy` row **in force on the
  ticket's own `createdAt`**, not today's table, and stamps
  `respondDueAt`/`resolveDueAt` from it once (**IT-SLA-001**).
- **`assignTicket(id, assigneePartyId)`** — sets the assignee; no status
  change.
- **`transitionTicket(id, event, note?)`** — `START` | `WAIT` | `RESUME` |
  `RESOLVE` | `CLOSE` | `REOPEN`, run through `platform/lifecycle.ts`'s
  `transition()`. Stamps `firstRespondedAt` on the first `START`,
  `waitingSince` on `WAIT` (cleared on `RESUME`), `resolvedAt`/`closedAt`
  once each.
- **`addComment(ticketId, {body, internal?})`** — the requester or assignee
  (or an `all`-scope desk role) may post; only a caller holding `edit` may
  mark a comment `internal`.
- **`rateTicket(id, satisfaction)`** — only the requester, only on a
  resolved/closed ticket, only once (**IT-TKT-003**).
- **`listKnowledge`/`getKnowledgeArticle`** — a caller without `edit` on
  `it_knowledge` sees only `published` articles; desk staff see everything.
- **`createKnowledgeArticle`/`publishKnowledgeArticle`/
  `markKnowledgeHelpful`** — publish is a plain `edit`-gated action (the
  service desk's knowledge base has no approval gate, unlike the governance
  workstream's policy documents); helpful is a lightweight counter, gated
  only on `view`.
- **`myIt()`** — the My IT composite: the caller's own tickets (raised or
  assigned), plus `policiesAwaiting: []` and `assets: []` with a `note`
  explaining that those two sections are read directly from the governance
  and assets workstreams' own endpoints once they exist — this endpoint
  does not reach into files it does not own.
- **`summary()`** — see below.

An unresolved desk owner (`resolveDeskOwnerPartyId`) is the `partyId` of the
active `Affiliation` carrying the `hr_ops_manager` role slug — data, looked
up, never a role-slug branch in the logic that consumes it.

## Routes (`apps/api/src/routes/it/servicedesk.routes.ts`, mounted at `/api/it`)

| Method | Path | |
|---|---|---|
| GET | `/sla-policies` | list |
| POST | `/sla-policies` | new dated row |
| GET | `/tickets` | `?tab=&status=&priority=` |
| GET | `/tickets/summary` | see below |
| GET | `/tickets/:id` | detail |
| POST | `/tickets` | raise |
| POST | `/tickets/:id/triage` | `{priority, category?}` |
| POST | `/tickets/:id/assign` | `{assigneePartyId}` |
| POST | `/tickets/:id/transition` | `{event, note?}` |
| POST | `/tickets/:id/comments` | `{body, internal?}` |
| POST | `/tickets/:id/rate` | `{satisfaction}` |
| GET | `/knowledge` | `?status=&applicationId=` |
| GET | `/knowledge/:id` | detail |
| POST | `/knowledge` | `{title, body, applicationId?}` |
| POST | `/knowledge/:id/publish` | |
| POST | `/knowledge/:id/helpful` | |
| GET | `/my` | the My IT composite |

### `GET /tickets/summary`

```jsonc
{
  "notYetMeasured": false,          // true only with zero tickets ever raised
  "openByPriority": { "P1": 0, "P2": 1, "P3": 3, "P4": 2, "none": 0 },
  "unassigned": 2,
  "breached": 1,                    // open tickets with a breached clock
  "slaAttainment": { "response": 87.5, "resolution": null },  // this month's closed tickets; null = not yet measured
  "medianResolveMinutes": 245,      // last 30 days; null = not yet measured
  "backlogAge": { "d0_1": 2, "d2_7": 1, "d8_30": 0, "d30plus": 0 },
  "satisfactionAverage": 4.2,       // null with no ratings
  "knowledgePublished": 6
}
```

## Job (`apps/api/src/jobs/it/servicedesk.ts`)

`runServicedeskJob`, every 15 minutes:

- **SLA breach detector** — for every open ticket, checks the response
  clock (`respondDueAt` passed with no `firstRespondedAt`) and the
  resolution clock (`resolveDueAt` passed with no `resolvedAt`)
  independently, raising `IT_TICKET_RESPONSE_BREACHED` /
  `IT_TICKET_RESOLUTION_BREACHED` at most once per clock per ticket — the
  clock already fired is recorded in `slaBreachNotified`, so a re-run adds
  nothing (**IT-TKT-002**). The owner is the assignee, else the desk owner.
- **Waiting-too-long nudge** — a ticket sitting in `waiting` past 48 hours
  raises `IT_TICKET_WAITING_TOO_LONG`, idempotent per multiple of the
  threshold crossed (a housekeeping heuristic, not a dated target like the
  SLA table — the company has not been asked to commit to a number here).

## Web (`apps/web/src/pages/it/ServiceDesk.tsx`)

- **`ItTickets`** — tabs (mine, unassigned, open, breached, all), summary
  metrics (open, unassigned, breached, SLA attainment, median resolve — each
  "not yet measured" until there is something to measure), a table, and a
  raise-a-ticket modal.
- **`ItTicketDetail`** — description, an append-only timeline of comments
  (internal notes visibly marked and hidden from the requester), triage and
  assign modals (assign reuses the person-search pattern from
  `createForms.tsx`'s `NewEnrollment`, inlined here rather than editing that
  file), transition buttons driven by `availableTransitions`, and a rating
  widget shown only when the API says `canRate`.
- **`ItKnowledge`** / **`ItKnowledgeDetail`** — list, detail, new/publish,
  and a helpful counter.
- **`MyIt`** — the caller's own tickets, a raise-a-ticket action, and two
  sections (assets, policies awaiting acknowledgement) that read
  `/it/assets/mine` and `/it/policies/awaiting` directly — rendered as
  "Nothing here yet" on a 404 (those workstreams not yet landed) exactly as
  on an empty list, so the page degrades gracefully either way.

Every control that needs `edit`/`create`/`approve` is **omitted**, never
disabled, for a viewer without the grant (`useSession().can(...)`).

## Grants

| Resource | Employee | Operations Head | Finance Head | Chairman |
|---|---|---|---|---|
| `it_tickets` | `VC@own` | `VCEDAX` | `V` | all |
| `it_sla_policies` | – | `VCE` | `V` | all |
| `it_knowledge` | `V@all` | `VCEDX` | `V` | all |

An employee can raise and view their own tickets (and any assigned to them)
but cannot triage, assign, transition, or leave an internal comment — those
all require `edit`, which the employee grant does not carry. Only the
requester can rate their own resolved ticket.

## Acceptance

| ID | Test |
|---|---|
| IT-SLA-001 | `service desk — domain and wiring > IT-SLA-001: triage stamps due times from the policy in force on the ticket's creation date, not today's` |
| IT-TKT-001 | `> IT-TKT-001: an employee sees only tickets they raised (or are assigned), can raise one, and cannot assign or triage` |
| IT-TKT-002 | `> IT-TKT-002: the SLA breach job raises one exception per clock, and a re-run raises none new` |
| IT-TKT-003 | `> IT-TKT-003: only the requester can rate a resolved ticket, and only once` |
| IT-TKT-004 | `> IT-TKT-004: SLA attainment reports not yet measured with no closed tickets this month, never 100%` |
| — (permission) | `> permission: an employee cannot see or act on another employee's ticket via comments` |
| — (permission) | `> permission: the requester cannot leave an internal comment, but an assigned desk role can` |
| — (permission) | `> permission: the Finance Head holds only view on tickets and cannot raise one` |
| — (pure arithmetic) | `dueFrom / slaAttainment / medianMinutes (pure arithmetic, no DB) > IT-SLA-ARITH-001..008` |

Plus wiring coverage for the full lifecycle machine (`new` → … → `closed`,
`REOPEN` from `resolved`, illegal jumps refused) and the knowledge base
(draft invisible to an employee, publish makes it visible, helpful
increments).

## What this does not do

No SLA target here is a decision the company has made — the seeded table is
explicitly a starting point (`docs/plan/cio.md`'s own open question). The
desk does not page anyone, does not discover devices, and does not meter
anything: every figure is typed in or computed from what was typed in.

## Proposed edit outside this workstream's ownership (not applied)

`packages/shared/src/permissions.ts`'s `RESOURCES` array (the `Resource`
literal union) does not yet include any `it_*` resource, so a strict
`resource: Resource` parameter — used by `platform/lifecycle.ts`'s
`transition()` — cannot accept `'it_tickets'` without a local cast. This
file worked around it locally (`const TICKETS_RESOURCE = 'it_tickets' as
unknown as Resource` in `domains/it/servicedesk.ts`) rather than editing a
file this workstream does not own; the same gap affects every other
workstream that drives a lifecycle machine through `transition()` (at
least `itsm.ts`, `governance/accessReviews.ts`, `governance/findings.ts`,
`governance/risks.ts` show the identical error). The real fix, for whoever
owns `packages/shared/src/permissions.ts`, is to append the technology
resources to `RESOURCES`:

```diff
   'esop_plans',
   'option_grants',
+  // Technology (docs/plan/cio.md).
+  'it_assets', 'it_applications', 'it_licences', 'it_vendors', 'it_vendor_contracts',
+  'it_tickets', 'it_sla_policies', 'it_knowledge',
+  'it_incidents', 'it_problems', 'it_changes',
+  'it_risks', 'it_policies', 'it_policy_acknowledgements', 'it_controls',
+  'it_access_reviews', 'it_findings',
+  'it_initiatives', 'it_budgets', 'it_tech_debt',
+  'it_continuity',
 ] as const;
```
