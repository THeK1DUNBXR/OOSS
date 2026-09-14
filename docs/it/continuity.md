# Continuity and operations

Which application must be back in how long, whether the last drill actually
proved it, how reliable it has been this month, and when it next goes dark
for maintenance (`docs/plan/cio.md`, workstream H). `BackupRun`
(`main.prisma`) is the platform's own backup log; nothing before this said
which *business* system must be back in how long.

---

## What this module does and does not do

Typed in: RTO, RPO, backup method and frequency, every DR test's outcome and
timing, every month's minutes-down reading, every maintenance window. The
one thing this module computes is uptime % — over the minutes in the
calendar month a reading covers, from the minutes-down figure a person typed
in. It does not discover applications, meter uptime itself, or page anyone.
An application with no reading for a month is *not yet measured*, never
shown as 100%.

## The application catalogue is another workstream's model

`ItApplication` (workstream B, `it-software.prisma`) lives in a different
schema file — the builder brief's rule that cross-workstream references are
bare ids, relations only within a workstream's own file, and this file must
compile whether or not `it-software.prisma` exists yet. A continuity plan
therefore still carries `applicationId` (a bare id) alongside
`applicationName` and `applicationTier` **typed in and snapshotted at plan
creation**, rather than a Prisma relation — so a plan's own tier-1 label and
every screen work standalone, and a tier change on the live application
does not retroactively rewrite an existing plan's `applicationTier` (a new
plan, or an edit through the API, is how that gets corrected).

The catalogue now exists on disk, though, and the `IT_DR_NO_PLAN` detector
reads it directly (a `findMany` against `prisma.itApplication`, resolved at
the service layer — never a cross-file relation): every active, tier-1/2
`ItApplication` with no `ItContinuityPlan` in `active` status against its
`applicationId` is flagged, which is what catches a tier-1/2 application
that has never had a plan written for it at all. The older, plan-sourced
case — a plan that exists but sits in `draft`/`retired` rather than
`active` — is kept alongside it (deduplicated by application id) for a plan
whose application row is not in the catalogue, or the catalogue is not yet
seeded for that tenant. See "Jobs" below.

---

## Model

**`ItContinuityPlan`** — one plan per application: `applicationId` (bare id),
`applicationName`/`applicationTier` (typed-in snapshot, 1 = critical … 4 =
low), `rtoMinutes`, `rpoMinutes`, `backupMethod`, `backupFrequency`,
`restoreProcedureDocumentId`, `ownerPartyId`, `lastTestedAt`,
`testCadenceDays`, `status` (`draft → active → retired`, retired terminal),
`testOverdueNotifiedRungs Int[]` (the DR-test ladder's own idempotency
record, cleared to `[]` on every new test). `recordCode` is unique per
tenant (`@@unique([tenantId, recordCode])`) — codes are per-tenant
sequences, the same as every other record-coded entity, never a
tenant-crossing global unique.

**`ItContinuityTest`** — append-only, immutable after write: `planId`,
`testedAt`, `kind` (`restore` | `failover` | `tabletop`), `outcome` (`pass` |
`fail` | `partial`), `actualRecoveryMinutes`, `actualDataLossMinutes`,
`notes`, `evidenceDocumentId`, `recordedById`. The domain layer exposes no
update path for a test row at all — a correction is a new test, never an
edit to an old one. Recording a test that beat neither promise raises
`IT_DR_RTO_EXCEEDED`. `recordCode` is likewise `@@unique([tenantId, recordCode])`.

**`ItAvailabilityReading`** — one reading per application per calendar month
(`period`, `YYYY-MM`): `minutesDown`, `incidentCount`, `source` (`typed` |
`incidents` — this workstream only ever writes `typed`; `incidents` is
reserved for a future roll-up from the incidents workstream, E). Unique on
`(tenantId, applicationId, period)`. Uptime % is **never stored** — always
computed from `minutesDown` and the period's own length.

**`ItMaintenanceWindow`** — `applicationId`/`applicationName`, `startsAt`,
`endsAt`, `reason`, `changeId` (bare id into workstream E's `ItChange`),
`notifiedAt`, `status` (`planned → in_progress → done` | `cancelled`),
`cancelReason`. `recordCode` is `@@unique([tenantId, recordCode])`.

## Dated defaults

Unlike the compliance calendar's due-date rules or the service desk's SLA
table, this workstream's two dated values — the default DR-test cadence
(180 days for tier 1, 365 otherwise) and the overdue-ladder rungs (`-7`,
`0`, `+30` days) — have no natural "as of" date they have ever changed on
and no per-tenant variant asked for. They live as plain exported constants
in `packages/shared/src/it/continuity.ts`
(`DEFAULT_TEST_CADENCE_DAYS`/`defaultTestCadenceDays`,
`TEST_OVERDUE_LADDER_RUNGS`), read directly by the domain and the job. If
the company ever wants these to vary by tenant or by effective date, that is
a small follow-up (a dated table), not a gap in this seed —
`apps/api/src/seed/it/continuity.ts` documents the same reasoning and is
otherwise a deliberate no-op: this workstream has no rows of its own to
create ahead of time (it cannot see the catalogue to seed plans against).

## Pure arithmetic (`packages/shared/src/it/continuity.ts`)

- **`uptimePercent(minutesDown, period)`** — `period` is `YYYY-MM`; the
  denominator is that month's own minute count (28/29/30/31 days × 1440),
  never a fixed 30-day assumption. Clamped to `[0, 100]`.
- **`testOverdueRung(lastTestedAt, cadenceDays, now)`** — which rung of
  `[-7, 0, 30]` `now` has crossed, measured from
  `lastTestedAt + cadenceDays`. `undefined` before the earliest rung. A plan
  never tested is treated as due today (rung `0`), not indefinitely safe.
- **`rtoBreached(test, plan)`** — true when the recorded recovery time
  exceeds the plan's `rtoMinutes`, or the recorded data loss exceeds its
  `rpoMinutes` (either is enough; `IT_DR_RTO_EXCEEDED` covers both, per the
  workstream's single named exception code).

All three are exercised directly by tests, no database involved.

## Domain (`apps/api/src/domains/it/continuity.ts`)

Plans: `createPlan`, `updatePlan`, `transitionPlan(id, 'active' | 'retired')`
— runs through `platform/lifecycle.ts`'s generic `transition`, against
`itContinuityPlanMachine` (`packages/shared/src/it/continuity.ts`, events
`ACTIVATE`/`RETIRE`, `draft → active → retired`, retired terminal), so the
domain layer never hand-rolls a transition table; events are emitted under
`kz.it.continuity_plan.<verb>` (`transition`'s `eventPrefix: 'kz.it'`,
`impactDomain: IT_DOMAIN`) rather than the helper's `kz.hr` default.
`availablePlanTransitions(status)` wraps `platform/lifecycle.ts`'s
`availableTransitions` and is exposed on `planDetail` so a screen only ever
renders legal buttons. `listPlans(filter)`, `planDetail(id)` (includes
tests, newest first).

Tests: `recordTest(planId, input)` — refuses on a retired plan, stamps the
plan's `lastTestedAt` and clears its overdue-ladder memory, and raises
`IT_DR_RTO_EXCEEDED` when `rtoBreached` says so. `listTests(planId)`.

Availability: `recordAvailabilityReading(input)` — upserts by
`(applicationId, period)`, so re-recording the same month corrects it rather
than duplicating. `listAvailabilityReadings(filter)` — every row carries its
computed `uptimePercent`.

Maintenance: `createMaintenanceWindow(input)`, `listMaintenanceWindows(filter)`
(`when: 'upcoming' | 'past' | 'all'`), `maintenanceWindowDetail(id)`,
`cancelMaintenanceWindow(id, reason)` — a reason is required, the same
"deliberate decision, not a status flip" discipline the compliance
calendar's `waive` keeps.

Owner resolution: `resolveOperationsHeadPartyId()` looks up the active
`Affiliation` carrying `roleSlug: 'hr_ops_manager'` (the Operations Head) —
data, never a role-slug branch in a conditional — the same shape
`resolveOwnerPartyId` uses in `domains/compliance/calendar.ts`.

Summaries: `continuitySummary()`, `availabilitySummary()` (shapes below).

## Routes (mounted at `/api/it/`)

| Method | Path | |
|---|---|---|
| GET | `/continuity/summary` | `continuitySummary()` |
| GET | `/continuity/plans` | `?tier=`, `?status=` |
| POST | `/continuity/plans` | create |
| GET | `/continuity/plans/:id` | detail, with tests and `availableTransitions` |
| PATCH | `/continuity/plans/:id` | field edits, or `{status}` to transition |
| GET | `/continuity/plans/:id/tests` | test history |
| POST | `/continuity/plans/:id/tests` | record a test |
| GET | `/availability/summary` | `availabilitySummary()` |
| GET | `/availability/readings` | `?period=`, `?applicationId=` |
| POST | `/availability/readings` | record (upserts by app + period) |
| GET | `/maintenance` | `?when=upcoming\|past\|all`, `?status=` |
| POST | `/maintenance` | create |
| GET | `/maintenance/:id` | detail |
| POST | `/maintenance/:id/cancel` | `{reason}` |

(There is no bare `/continuity` or `/availability` list alias — `/continuity/plans`
and `/availability/readings` are the one way to list each, alongside their
own `/summary`.)

### `GET /api/it/continuity/summary`

```json
{
  "notYetMeasured": false,
  "plansByTier": { "1": 2, "2": 1, "3": 0, "4": 0 },
  "plansByStatus": { "draft": 1, "active": 2, "retired": 0 },
  "tier1Tested": { "count": 1, "total": 2, "fraction": 0.5 },
  "testsOverdue": 1,
  "availabilityLastMonth": {
    "notYetMeasured": false,
    "period": "2026-08",
    "meanUptimePercent": 99.82,
    "worstApplication": { "applicationId": "app-1", "applicationName": "Order Service", "uptimePercent": 98.7 }
  },
  "nextMaintenanceWindows": 3
}
```

`ContinuitySummary` extends the shared `ItSummaryBase` (`{ notYetMeasured }`)
rather than repeating the field. `notYetMeasured` is true only when the
tenant has zero continuity plans.
`tier1Tested.fraction` counts only **active** tier-1 plans currently within
their own cadence (`testOverdueRung` returns `undefined`); it is `null` when
there are no active tier-1 plans to measure. `availabilityLastMonth` is its
own nested honest-empty-state (see below), computed for the calendar month
immediately before the current one.

### `GET /api/it/availability/summary`

```json
{
  "notYetMeasured": false,
  "period": "2026-08",
  "meanUptimePercent": 99.82,
  "worstApplication": { "applicationId": "app-1", "applicationName": "Order Service", "uptimePercent": 98.7 }
}
```

`notYetMeasured` is true when no application has a reading for last month —
never reported as 100%.

## Jobs (`apps/api/src/jobs/it/continuity.ts`, exported as `JOBS`)

1. **`runContinuityTestOverdueJob`** — daily. For every `active` plan,
   `testOverdueRung` against `now`; a newly-crossed rung raises
   `IT_DR_TEST_OVERDUE` (severity climbs `S2_WARNING` → `S3_HIGH_RISK` →
   `S4_CRITICAL` as the rung widens) and is recorded on
   `testOverdueNotifiedRungs`, so a rung already fired never re-fires
   (IT-DR-003).
2. **`runContinuityNoPlanJob`** — daily. Two sources, deduplicated by
   `applicationId` so an application caught by both raises one exception,
   not two: (a) every active, tier-1/2 `ItApplication` (workstream B's
   catalogue) with no `ItContinuityPlan` in `active` status by
   `applicationId`; and (b) — kept for an application whose catalogue row
   does not exist, or the catalogue is not yet seeded for the tenant — a
   continuity plan for a tier-1/2 application sitting in `draft` or
   `retired` rather than `active`. Either way, `IT_DR_NO_PLAN` is raised
   with the **application** — `subjectType: 'it_application'`, `subjectId:
   applicationId` — as the exception's subject, never the plan (IT-DR-001).
   See "The application catalogue is another workstream's model" above.
3. **`runMaintenanceWindowNoticeJob`** — every 30 minutes. A `planned`
   window starting within 24 hours with `notifiedAt` still null raises
   `IT_MAINTENANCE_WINDOW_SOON` on the Operations Head and stamps
   `notifiedAt`, so it fires once per window.

`IT_DR_RTO_EXCEEDED` is raised synchronously by `recordTest`, not by a job —
a breach is known the moment the test is recorded, not discovered later.

## Events

`IT_CONTINUITY_PLAN_SET` (create, field edits, and every status
transition), `IT_CONTINUITY_TESTED`, `IT_AVAILABILITY_RECORDED`,
`IT_MAINTENANCE_SCHEDULED` (create, and reused — noted at the call site — for
the 24-hour notice stamp and for cancellation, since no separate
`IT_MAINTENANCE_CANCELLED` event is declared for this workstream).

## Grants (`it_continuity`)

| Role | Cell |
|---|---|
| Employee | *(nothing — not in the employee grant table at all)* |
| Operations Head | `VCEDX` |
| Finance Head | `V` |
| Chairman | all |

No `approve` verb on this resource — plan and window lifecycle moves on
`create`/`edit` alone, no approval gate policy is declared for continuity in
`docs/plan/cio.md`.

## Acceptance

| ID | Test |
|---|---|
| IT-DR-001 | `IT-DR-001: a tier-1 catalogue application with no active continuity plan raises IT_DR_NO_PLAN naming the application` |
| IT-DR-002 | `IT-DR-002: a test whose recovery time exceeds RTO raises IT_DR_RTO_EXCEEDED, and the test row is immutable afterwards` |
| IT-DR-003 | `IT-DR-003: the DR-test-overdue ladder is idempotent per rung` |
| IT-AVL-001 | `IT-AVL-001: uptime % is pure arithmetic over minutes, and a month with no reading reports not yet measured` |

Plus, in `apps/api/src/tests/it/continuity.test.ts`: the pure-arithmetic
suite for `uptimePercent`/`testOverdueRung`/`rtoBreached` (no DB); the
plan-sourced fallback case for `IT_DR_NO_PLAN` (a tier-1 plan in `draft`
with no catalogue row at all); plan lifecycle (`draft → active → retired`,
retired terminal, retired refuses a new test); maintenance window creation,
the 24-hour notice job, and cancellation requiring a reason; both
summaries' `notYetMeasured` shape; and permission tests — an employee is
refused on every read and write to `it_continuity` (403), the Finance Head
can view but cannot create a plan (view-only), and the chairman can act on a
plan the Operations Head created.

## Web (`apps/web/src/pages/it/Continuity.tsx`)

- **`ItContinuity`** — plans grouped by tier, with a summary strip
  (tier-1-tested fraction, tests overdue, last month's availability, windows
  ahead). New plan modal. Clicking a row opens a detail modal: RTO/RPO,
  backup method/frequency, cadence, status, the activate/retire buttons
  `availableTransitions` allows, a Record test modal, and the full test
  history (an RTO-exceeded test is flagged inline).
- **`ItAvailability`** — a month picker, a table per application sorted
  worst uptime first, a Record reading modal. An empty month reads "Not yet
  measured", never a blank 100%.
- **`ItMaintenance`** — tabs for upcoming/past/all, a New window modal, and
  a Cancel action (with a required reason) on any window still planned or
  in progress.

Every write control is **omitted**, never disabled, for a viewer without the
grant (`useSession().can('it_continuity:C' | 'it_continuity:E')`) — so an
employee (who holds no `it_continuity` grant at all) and the Finance Head
(view-only) see a read-only screen with no dead buttons.
