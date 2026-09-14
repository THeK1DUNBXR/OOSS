# Acceptance

The Handoff states its requirements as PASS/FAIL criteria. Each is verified by a
test that names it. Where a criterion reads "PASS if X; FAIL if Y", the test
asserts X and, where the failure mode is the interesting half, asserts that Y is
impossible.

```bash
./scripts/test-db.sh          # provision kaizen_test
cd apps/api && pnpm test      # 372 tests
```

## How the suite is built

It runs against a real PostgreSQL database, inside real request contexts,
through the same `evaluate()` and the same tenant gate that serve production
traffic. Nothing is mocked. A mocked permission check proves nothing about the
one that actually runs, and every requirement here is a claim about the real
one.

It runs serially by construction. Several requirements — gapless record codes,
hash-chain continuity, the expiry ladder's per-rung idempotence — are claims
about *ordering*, and a parallel runner would be asserting something else.

It has its own database because it creates and mutates records. The development
dataset is a demonstration, not a scratchpad.

## Coverage

| Requirement | Tests | What is pinned |
|---|---|---|
| **CRM-FOUND-001** Tenant isolation | 4 | An unscoped query throws before reaching the database; a cross-tenant fetch by direct id returns `null` (not 403); two tenants register the same email without collision; a write cannot move a row between tenants |
| **CRM-FOUND-002** Event fabric | 5 | All 23 legacy names map to the canonical grammar; the chain verifies under an independent walk; tampering changes the hash; a read emits zero events; every event resolves to a real tenant |
| **CRM-FOUND-003** Five axes | 9 | The letter-matrix vocabulary parses unchanged; `view`/`export` resolve to `all` while narrowing applies to mutation; `own_or_unowned` applies the branch check only in the unowned case; an explicit absence denies on WHO; WHAT stops an insufficient ceiling; HOW MUCH fails closed; WHY requires a purpose binding; the durable rows match the declared matrix with no drift |
| **CRM-FOUND-004** No role checks in code | 3 | A source grep for a role-slug comparison against a literal returns empty; need-to-know is conferred by `restricted_interactions:view`; the supervisory list is a `management_chain` scope resolver |
| **CRM-FOUND-006** Audit and field visibility | 2 | Money fields are masked with a named reason; regulated fields are structurally excluded from the response shape |
| **CRM-FOUND-007** Record codes | 5 | Correct format at creation; gapless and strictly increasing under 100-way concurrency; batch allocation contiguous; per-tenant counters with no sharing; `record_code` rejected as an edit target |
| **CRM-IDN-001** Identity resolution | 7 | Neither phone nor email is refused; an exact in-scope match resolves silently; a statutory-retention-floor match never auto-merges; a raised candidate is queued; a merged row never matches and is never deleted; `people:merge` is held independently of `people:edit`; phone normalisation |
| **CRM-IDN-002** The three parties | 15 | A body is an institution or an organisation and never both; a college we also invoice stays a college; school details are refused on an organisation at creation and at attach; neither list contains the other; reclassifying needs a reason and is refused once learners point at the college; a student is a third thing, in neither list; a student's origin must be an institution; a registration number belongs to one learner and the clash names whose; somebody already on file becomes a student rather than a second person; an employee can take one on at the counter and cannot rewrite one after; attaching requires `institutions:create`; detaching that would orphan an open opportunity is blocked with a count; a sponsored learner names who is paying or is refused, and a college cannot be one; a scheme names its framework; a funded learner is not billable and the invoice says who to bill instead; a body holds several roles at once and a college is described by engagements instead |
| **CRM-IDN-004** Relationship graph | 3 | A nature change supersedes rather than mutates; status and strength update in place — the deliberate exception; current-view and full-history traversals differ correctly |
| **CRM-LEAD-001/002** Pipeline as data | 9 | The canonical ordinal is a closed eight-value set; an off-set stage is a 422; all five pipelines seed with entry and both terminals; every graph reaches a terminal; a transition-less stage write is rejected by name; one ordinal spans differing labels; SLA budgets differ per motion; post-award stages are unreachable; retiring a live stage is blocked with a count |
| **CRM-LEAD-003/005** Routing | 5 | One unrouted predicate; no eligible candidate lands unrouted rather than defaulting to the creator; every candidate considered is recorded; a hard-filter failure is never soft-scored; the two unrouted causes carry different reason codes |
| **CRM-LEAD-004 / COML-006** Won gate | 2 | `won` is unreachable with both `contract_id` and `mou_id` null; a renewal opens a new opportunity |
| **CRM-LEAD-006** Forecast state machine | 7 | Position 10 cannot reach `best_case`; `commit` is blocked on a past close date and re-validates on re-promotion; a closed category cannot be set independently of stage; a demotion requires a reason; `manual_commit` ignores stage weighting; roll-up is per pipeline unless blending is asked for; a coverage query spans every pipeline in one pass |
| **CRM-COML-002/005** Pricing and discount authority | 5 | Repricing supersedes rather than mutates; publishing requires a deliberately set ceiling; an over-ceiling quote blocks wholly and opens an approval step; lines resolve against the exact version; currencies cannot mix |
| **CRM-MOU-002** Approval gate | 8 | A non-positive value is refused; `edit` never confers approval; the Self-Dealing Bar reroutes to the next tier; over-ceiling opens an approval step; `system_admin` is structurally excluded; job-driven statuses are not user transitions; the ladder fires at the tightest crossed rung, once, and is idempotent per rung |
| **CRM-ACT-002** Computed sensitivity | 7 | The maximum across references wins outright; an unregistered type fails closed at `confidential`; a CRM-only interaction computes `internal`; an HR reference lifts the whole record; at least one reference is required; a cross-tenant reference is rejected at write; a confidential record is *absent*, not masked, from a low-ceiling timeline |
| **AI governance** | 6 | An undeclared tool is blocked; a categorical prohibition holds at any authority size; RECOMMEND waits for a human; AUTONOMOUS_WITHIN_POLICY executes without per-instance approval; an agent never approves an agreement or confirms a merge |
| **Exceptions and jobs** | 4 | Every exception carries a resolved owner or is measured as a routing defect; escalation is bounded to four named triggers; a re-run does not re-fire a notified rung; severity and notification priority are independent |
| **CRM-RPT-001/002** Health scores | 4 | Insufficient inputs report not-yet-measured, never zero; every factor carries a drill path; the retired `pipeline_value`/`pipeline_count` metrics are no longer written; a band never itself reaches S4 — only a named exception does |
| **Decisions** | 3 | An incomplete evidence pack is not decidable; deferring past the point of no return is refused outright; a decision arms a review date rather than closing at disposition |
| **Finance** | 5 | A payment is idempotent on its gateway reference; a correction is a new row; over-allocation is refused; only allocated receipts determine what is paid; the revenue method derives from the offering |
| **Invoicing** | 26 | Tax is priced per line at creation and quantity is multiplied by; the split halves within a state and does not across one; an invoice bills a person without an organisation being invented; a draft is editable and an issued invoice is not; a draft carries no invoice number and gets one at issue, in the company's own series; an issued invoice is never restated by a later payment; over-collection and a repeated payment reference are refused; the document prints both totals and keeps today's balance off the sheet; it names which of the three it is addressed to and carries the learner's own registration number; a student's state comes from their record rather than being asked for again |
| **Receipts and the final invoice** | 9 | Every instalment issues a numbered receipt carrying its own time, the invoice it is against, the amount, the mode and the balance it left; those figures are snapshotted, so a reprint says what it said; a final invoice names every receipt it consolidates, prints the balance rather than refusing to exist while one remains, and supersedes an earlier statement rather than replacing it |
| **GST returns** | 12 | A GSTIN is validated on shape, state code and check digit; credit is set off head by head in the statutory order rather than netted; a registered customer is reported invoice by invoice and an unregistered one rate-wise; a draft is not a supply and a void invoice is reported as cancelled; the 3B agrees with the GSTR-1 by construction; a return the portal would reject cannot be recorded as filed; filing closes the month and a preparation supersedes an earlier one |
| **The catalogue and the student record** | 15 | A course is edited and retired, never deleted, and a retired one cannot be billed; a fee, rate and SAC flow from the course onto an invoice line; a course assigned with no batch named uses its rolling intake; a query and an issue open and stay open while feedback and a note close as written; attendance, progress and the log merge into one timeline on the server; a trainer reaches the batches they teach and no others |
| **The student register import** | 8 | The register is recognised before the bank sniffer; instalments, their dates and their receipt numbers are read; dates are inferred month-first or day-first from the file; a row that does not add up is reported and still imports; the commit writes the enrolment and leaves course prices exactly as they were |
| **EQT-IDN** Equity portal — Phase 0 identity, entities, portal surface | 10 | One principal signs into two tenants under one password; the entity list and the token-issuing selection token both resolve correctly; a tenant the principal holds no active affiliation in is a 404, never a 403; ending a director affiliation refuses the next `switch-entity` with no deprovisioning step in between; the `shareholder` role (archetype `portal`) sees only `portal_*` navigation and the chairman sees none of it; the tenant-scope gate still throws with no context in scope even when a subsidiary's `tenantId` is named in the query; `POST /auth/sign-ins` returns a password once and only rotates it on `reset:true`; every seeded role holds exactly the grant matrix's declared cells for the thirteen new equity resources, and no others; `reconcileTenantKinds` flips a tenant to `holding`/`subsidiary` correctly and raises `EX-EQT-001` exactly once per tenant |
| **EQT-BRD** Equity portal — Phase 3 board and compliance | 9 | Short notice (fewer than the SS-1 clear days) is refused unless director consent with a reason is recorded, and the same call succeeds once it is; s.174 quorum (`max(2, ceil(directors/3))`) blocks `markHeld` until enough directors are recorded present; a s.179(3)/Rule 8 subject (allotment, borrowing, investment and the rest of the closed list) refuses `passedBy: 'circulation'` outright and only accepts a meeting resolution; an interested director's vote is forced to `abstain` with `abstainedAsInterested` set and is excluded from the entitled count that decides the outcome; two of six members (a third, s.175) demanding a meeting closes the circulation as `meeting_demanded` rather than tallying votes; minutes entered more than 30 days after `heldOn` are refused without `late: true` and a reason, and recorded as late — never silently — once given; the daily `board_compliance` job raises nothing from a wholly empty register (no fabricated due date), raises exactly one `board_first_meeting` item once incorporation is on record, and running it again the same day does not duplicate that item; a shareholder is denied (403) on `board_meetings:view` while a director in the same tenant reads the list, and a meeting id from another tenant 404s even for a director there; a passed special resolution raises the `mgt14_30d` compliance item and recording the SRN closes it |

## The browser suite

The unit suite runs the server. It cannot see a button whose label promises one
thing and whose link does another — nothing throws, nothing logs, and every
assertion about the data underneath still passes. So there is a second, small
suite that drives a real browser against a running stack:

```bash
pnpm --filter @kaizen/api dev            # :4000
pnpm --filter @kaizen/web dev            # :5173
E2E_EMAIL=… E2E_PASSWORD=… pnpm test:e2e
```

It signs in as a real account through the form, reads the getting-started
checklist from the API, and holds the screen to it: every step's button says
either its own action or "Open", and points where that word promises — an undone
step at the place the job is done, a done step at the screen. Then it presses
each one and checks where it lands, because an unrouted path does not fail
loudly here; the client's catch-all returns it quietly to the landing screen.
The setup banner gets the same treatment, in the state a company is actually in
on its first day.

It is deliberately four tests. A browser suite that tries to cover the product
becomes the slowest and least trusted thing in the repository; this one covers
the class of defect the unit suite structurally cannot see.

| **Navigation, permissions and the build footnote** | 9 | Every seeded nav row matches the registry, synonyms included; no word reaches two of the party screens; the three parties are three entries, each to its own screen; a deleted entry comes back and a stale one is corrected on reconcile, without the seed; a retired entry is removed; the build reports a sequence and a commit; the seed stamps the tenant and the stamp moves every run; a resource the tenant never had a row for is granted at boot with the matrix's own cell, and an existing grant is never touched however far it has drifted — that is left for the reconciler and reported |

## Defects this suite found

Writing the tests against the Handoff's own criteria surfaced six real bugs in
the implementation, all fixed:

1. **Dedup confidence.** An exact match required *both* phone and email to have
   been supplied and matched, so a caller supplying only a phone and hitting it
   exactly was scored 0.7 and raised a spurious merge candidate. The absence of
   a second identifier is not evidence against a match.
2. **Graph reachability.** Retired post-award stages were required to reach a
   terminal, rejecting a graph that was in fact sound.
3. **Expiry ladder rung selection.** `find` on `[90, 60, 30, 7]` returns the
   *widest* crossed rung, not the tightest — so an agreement first seen 25 days
   out fired at 90, then 60, then 30 across three successive runs, three
   notifications for two rungs already in the past.
4. **Need-to-know as a role list.** `isNeedToKnow` compared the role slug
   against three literals, in violation of CRM-FOUND-004. Now a
   `restricted_interactions:view` grant.
5. **The supervisory role list.** Same violation in `inManagementChain`. Now a
   `management_chain` scope resolver on the interactions grant.
6. **The admin classification bypass.** An `ADMIN_ROLES` set let three roles
   read above their ceiling regardless of what their ceiling said — so lowering
   an admin's ceiling would not have lowered what they could read. Removed; the
   ceiling is the whole of the rule, and those roles already carry `regulated`.

The first three would have shipped as wrong behaviour. The last three would
have shipped as a permission model that quietly did not mean what it said.

## Defects the invoicing work found

Building the invoicing, the returns and the register importer over the top
surfaced seven more, all fixed:

1. **Quantity was stored and never multiplied by.** `InvoiceLine` carried a
   quantity and an amount, and every total summed the amounts. Three seats at
   ₹20,000 invoiced as ₹20,000, on screen and in the ledger.
2. **The GST fields were unreachable.** `Invoice` carried the whole split and
   the only function that could fill it refused to run on anything but a draft
   — and nothing created a draft. Every invoice the platform had ever raised
   carried zero tax.
3. **There was no supplier registration anywhere in the model.** An invoice
   without the supplier's legal name, address and GSTIN is not a tax invoice,
   and a return is filed *under* a GSTIN. The old summary produced six totals
   with no registration attached to them.
4. **Settlement was decided on the pre-tax value.** `settleIfFullyPaid` summed
   the lines, so a ₹1,18,000 invoice read as settled when ₹1,00,000 had been
   paid.
5. **Two handlers were registered on `GET /education/courses`**, with different
   filters and different response shapes. The second was unreachable.
6. **`DAILY_PROGRESS` had no endpoint.** It had been in the schema since the
   beginning with nothing reading or writing it, which is the same as not
   existing.
7. **Netting the GST totals understated the cash due.** Output minus input is
   the wrong arithmetic: credit is set off head by head in a statutory order,
   and the shortfall from netting arrives as interest.

12. **A new resource could not be used at all.** Permissions are durable rows
   and the seed deliberately never rewrites one, which is right — but it left a
   release that adds a whole new resource giving every existing tenant no row
   for it, so nobody could press the button on the screen that shipped with it.
   The symptom is a missing button, which is the least diagnosable thing in the
   product. Boot now fills in a resource a role has never had a row for, and
   only that; changing or revoking an existing grant stays governed, and what is
   waiting is counted in the footnote.

11. **A new screen could not be reached at all.** Navigation rows are written
   per tenant and only the seed wrote them, so a release that added a screen
   added a row nobody's tenant had: Customers and Institutions shipped, their
   routes worked, and the sidebar never mentioned them. The API now reconciles
   the menu against its registry at boot — the sidebar is code, not somebody's
   data — and the footnote on every screen says which build is running against
   which seeded data, because neither staleness is visible from any screen.

10. **A vocabulary change never reached the tenant.** The nav upsert refreshed
   a row's label and path and left its search synonyms as they were — so after
   the three parties were separated, "customers" went on opening Organisations,
   and so did "colleges" and "institutions". Typing the word for a thing and
   arriving at a different thing is the whole of what navigation is for. The
   upsert now writes every field, the registry is exported so the suite can hold
   the rows to it, and no word reaches two party screens.

9. **Everything was a customer.** A learner, a polytechnic and a manufacturer
   were one list, one word and one screen — "Companies & Colleges" — so neither
   "how many students do we have" nor "which colleges do we work with" had a
   screen that answered it, and billing a walk-in meant inventing a company for
   them. Three party types now, separated in the model, the API, the permission
   families and the navigation.

8. **The setup banner's button went to the setup banner's checklist.** The
   whole strip was one link to Getting Started, so the button inside it —
   labelled with the step's own action, "Add a customer" — led back to the list
   of things to do rather than doing one. It is the first button a new company
   presses. Nothing failed; it simply did not work, which is why the browser
   suite above now exists.

And one the spreadsheet found rather than the code: the invoice number the
company asked for, `KIPL/I/2026-27/001`, is eighteen characters. The portal
accepts sixteen. `KIPL/I/26-27/001` is exactly sixteen, which is why the short
year is the default — and the Company details screen prints the length beside
the next number so this is seen before the first invoice rather than at the
filing deadline.
