# Acceptance

The Handoff states its requirements as PASS/FAIL criteria. Each is verified by a
test that names it. Where a criterion reads "PASS if X; FAIL if Y", the test
asserts X and, where the failure mode is the interesting half, asserts that Y is
impossible.

```bash
./scripts/test-db.sh          # provision kaizen_test
cd apps/api && pnpm test      # 110 tests
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
| **CRM-IDN-002** Specialisations | 7 | Account and institution profile coexist; no validation rejects the second; attaching requires `institutions:create`; detaching that would orphan an open opportunity is blocked with a count; detaching what nothing references succeeds; a viewer without the grant sees the badge and not the contents; relationship status is never stored |
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
