# HCM — WS5 performance

Review cycles and talent management, built alongside — never replacing —
the existing `Goal`/`PerformanceEvidence` pair in `apps/api/src/domains/performance.ts`.
That file remains the continuous, append-only record of what a person did;
this workstream is the periodic reading of it (review cycles, calibration,
final ratings) plus the ongoing talent processes around it (feedback, 1:1s,
PIPs, succession).

## What exists now

### Models (`apps/api/prisma/schema/hcm-performance.prisma`)

- `ReviewCycle` — annual/half/quarter/probation, moving through a fixed phase
  order `self -> manager -> calibration -> closed`. `closed` is terminal.
- `ReviewTemplate` — weighted competency sections + a rating scale, reusable
  across cycles.
- `ReviewAssignment` — one reviewer against one subject for one cycle
  (`self`/`manager`/`peer`/`upward`/`skip`). A `self` assignment requires the
  reviewer and subject to be the same person; every other kind requires them
  to differ — a reviewer never reviews themselves outside the self form.
- `ReviewResponse` — the reviewer's filed answer. One per assignment,
  append-only: a submitted response cannot be resubmitted (409), a correction
  is a new assignment.
- `CalibrationSession` — a calibration meeting for a cycle; `decisions` is the
  working set while `open`, snapshotted into `FinalRating` rows and locked on
  close.
- `FinalRating` — one row per (cycle, employment). Carries `rating`,
  `potential` (the second 9-box axis), `band`, `promotionRecommended`, and
  `incrementRecommendedPct` — a calibration *recommendation* for WS7
  compensation to act on, never a disbursement, so it is not withheld-as-null
  the way an actual pay figure would be. `released` gates visibility to the
  subject.
- `Feedback` — continuous, outside any cycle. `praise`/`constructive`,
  `private`/`manager`/`public` visibility.
- `OneOnOne` — manager/report check-ins with agenda/notes/actions as JSON.
- `Pip` — a Performance Improvement Plan with objectives and checkpoints.
  Closing it (`outcome` away from `open`) needs a decider who is not the
  subject.
- `SuccessionPlan` — a position's ranked bench of successors and their
  readiness (`now`/`1yr`/`2yr`).

### Shared pure logic (`packages/shared/src/hcm/performance.ts`)

Enumerations for every kind/phase/outcome above, plus:

- `nextPhase` / `canAdvancePhase` — the fixed phase order, one step at a time.
- `isValidReviewerAssignment` — the reviewer-never-reviews-themselves rule
  (except the self form).
- `ratingTier` / `nineBoxCell` — a 1-5 rating and a potential level collapse to
  a 9-box cell and label (Star, Core player, Risk, …).
- `isRatingVisibleToSubject` — the plan's stated rule, made checkable: visible
  once the cycle is closed **and** the row released.
- `canReleaseRating` / `canClosePip` — the Self-Dealing Bar in its
  non-financial form: a rating may not be released by, and a PIP may not be
  closed by, the person it is about.

### Domain (`apps/api/src/domains/hcm/performance.ts`)

Every write is grant-checked via `assertCan`/`scopeFor`, tenant-scoped through
`currentAuth().tenantId`, and emits its `kz.hr.*` event. Notably:

- `createReviewCycle` allocates an `RVW-YYYY-NNNNN` record code and opens in
  phase `self`.
- `advanceReviewCyclePhase` refuses any jump that isn't the next phase in
  order (422), and refuses entering `calibration` while assignments are still
  `pending`.
- `createReviewAssignment` refuses a non-self kind where reviewer == subject,
  and a self kind where they differ (422).
- `submitReviewResponse` refuses a second submission (409) and refuses
  filing against a closed cycle (422).
- `closeCalibrationSession` snapshots every decision into a `FinalRating` row
  (upserted on the `(tenant, cycle, employment)` key) and locks the session;
  refuses closing twice (409).
- `releaseFinalRating` requires the cycle to be `closed`, refuses releasing
  twice, and enforces the Self-Dealing Bar: the releaser may never be the
  rating's subject (403, "Self-Dealing Bar").
- `listFinalRatings` narrows to the caller's own rows when the grant scope
  isn't `all`, and further hides any row that isn't yet `released` — an
  employee sees nothing about their own rating until both conditions hold.
- `nineBoxForCycle` requires an all-scope grant on `reviews` — an aggregate
  over everybody, refused to an own-scoped caller (403), per the platform's
  `assertScopeAll` rule.
- `giveFeedback` requires the "from" employment to be the caller's own unless
  they hold an all-scope grant (403 otherwise).
- `closePip` enforces the Self-Dealing Bar the same way `releaseFinalRating`
  does, for a corrective rather than financial approval.
- `myEmploymentContext` resolves the caller's own employment relationship for
  the `/me` surfaces.

### Routes (`apps/api/src/routes/hcm/performance.routes.ts`, mounted at `/api/hcm/performance`)

| Method | Path | Notes |
|---|---|---|
| GET | `/_status` | `{ module: 'performance', ready: true }` |
| GET | `/my/context` | The caller's own employment relationship id |
| GET/POST | `/review-cycles` | List / open a cycle |
| GET | `/review-cycles/:id` | One cycle (404 cross-tenant) |
| POST | `/review-cycles/:id/phase` | Advance one phase |
| GET/POST | `/review-templates` | |
| GET/POST | `/review-assignments` | `?cycleId=&employmentRelationshipId=&mine=true` |
| GET | `/review-assignments/:id` | With its response, if any |
| POST | `/review-assignments/:id/submit` | Files the `ReviewResponse` |
| GET/POST | `/calibrations` | `?cycleId=` |
| PATCH | `/calibrations/:id` | Record/update decisions while open |
| POST | `/calibrations/:id/close` | Snapshots decisions to `FinalRating` |
| GET | `/final-ratings` | `?cycleId=&employmentRelationshipId=` |
| POST | `/final-ratings/:id/release` | Self-Dealing Bar enforced |
| GET | `/nine-box?cycleId=` | All-scope only |
| GET/POST | `/feedback` | `?employmentRelationshipId=&direction=given\|received` |
| GET/POST | `/one-on-ones` | |
| PATCH | `/one-on-ones/:id` | Notes/actions/status |
| GET/POST | `/pips` | |
| POST | `/pips/:id/checkpoints` | |
| POST | `/pips/:id/close` | Self-Dealing Bar enforced |
| GET/POST | `/succession-plans` | |
| PATCH | `/succession-plans/:id` | Replace the successor list |

### Web

- `apps/web/src/pages/hcm/Performance.tsx` (`/people/performance`) — tabs:
  Cycles, Assignments, Calibration, 9-box, Feedback, 1:1s, PIPs, Succession.
- `apps/web/src/pages/me/Performance.tsx` (`/me/performance`) — tabs: My
  reviews (fill in what's assigned to me), My ratings (only what has been
  released), Feedback (give/received), My 1:1s, My PIP.

No jobs. Grants (`review_cycles`, `reviews`, `calibrations`, `feedback`,
`one_on_ones`, `pips`, `succession_plans`) and the events used
(`REVIEW_CYCLE_OPENED/CLOSED`, `REVIEW_SUBMITTED`, `CALIBRATION_CLOSED`,
`FINAL_RATING_RELEASED`, `FEEDBACK_GIVEN`, `ONE_ON_ONE_SCHEDULED`,
`PIP_OPENED/CLOSED`, `SUCCESSION_PLAN_UPDATED`) were already registered by the
scaffold (WS0), as was the `RVW` record-code prefix.

## Acceptance

| ID | PASS means | Test |
|---|---|---|
| HCM-PERFORMANCE-001 | A new cycle gets an `RVW-YYYY-NNNNN` code and opens in phase `self` | `allocates a RVW-prefixed record code and opens in phase self` |
| HCM-PERFORMANCE-002 | A cycle only ever advances exactly one phase; skipping ahead is refused (422) | `refuses jumping from self straight to closed` / `accepts self -> manager in order` |
| HCM-PERFORMANCE-003 | A reviewer never reviews themselves outside the self form | `refuses a manager-kind assignment where the reviewer is the subject` / `accepts a self-kind assignment...` |
| HCM-PERFORMANCE-004 | A submitted review is final; resubmitting is refused (409) | `moves the assignment to submitted and refuses a second submission` |
| HCM-PERFORMANCE-005 | Closing calibration snapshots each decision into a `FinalRating`; closing twice is refused (409) | `creates a FinalRating row per decision` / `refuses closing an already-closed session` |
| HCM-PERFORMANCE-006 | The Self-Dealing Bar: nobody releases their own rating (403) | `refuses when the releaser is the rating's subject` |
| HCM-PERFORMANCE-007 | A rating is invisible to its subject until the cycle is closed **and** released | `is invisible before release, visible to the subject after` |
| HCM-PERFORMANCE-008 | The 9-box needs an all-scope grant; an own-scoped caller is refused (403) | `refuses an own-scoped employee` / `lets hr_ops_manager compute the cell...` |
| HCM-PERFORMANCE-009 | Feedback reaches its giver/recipient/HR; giving "from" someone else is refused | `an unrelated employee cannot list feedback...` / `refuses giving feedback "from" someone other than yourself` |
| HCM-PERFORMANCE-010 | The Self-Dealing Bar: nobody closes their own PIP (403); a different manager can | `refuses when the closer is the PIP subject, accepts a different manager` |
| HCM-PERFORMANCE-011 | A review cycle from another tenant is a 404, not a leak | `returns 404 rather than the record` |

## What this does not do

- No compensation math. `incrementRecommendedPct` is a recommendation for WS7
  to read and act on; this workstream never touches payroll or the ledger.
- No org chart / reporting-line resolution of "who is my manager" — every
  manager/reviewer relationship here is named explicitly by whoever creates
  the assignment, 1:1, or PIP (WS1 workforce owns `ReportingLine`).
- No notification/reminder emails for pending reviews or overdue calibration
  — the `/me/performance` "reviews to complete" list is the only surface.
- No review template enforcement against submitted ratings (a `ReviewTemplate`
  is descriptive metadata; `ReviewResponse.ratings` is a free-form JSON array
  the caller shapes, not validated section-by-section against the template).
- `SuccessionPlan.positionId` is a plain string reference; there is no
  `Position` join because WS5 does not own that model.

## Wanted from the scaffold

- No dedicated event exists for a `ReviewAssignment` being created (only for
  its submission, `REVIEW_SUBMITTED`) or for a `ReviewCycle` phase advance
  short of `closed`. Both are recorded via `auditWrite` instead; a future
  `kz.hr.review_assignment.created` / `kz.hr.review_cycle.phase_advanced`
  event would let a subscriber react to assignment creation and mid-cycle
  phase changes the way it can already react to a close.
- No `final_ratings` grant resource exists distinct from `reviews`; this
  workstream gates final-rating reads/writes on `reviews` (`view`/`approve`),
  which is the closest existing fit and matches the matrix's intent (HR ops
  holds `reviews:...,approve`; the employee row is `VCE@own` with no
  `approve`).
