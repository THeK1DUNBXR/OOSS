# HCM — WS12 analytics

HR analytics & reporting. A read-only layer: no new tables, no lifecycle, no
write path. Every function reads existing tables — `EmploymentRelationship`,
`Assignment`, `LeaveBalance`, `WorkAttendance`, `PayrollInstruction`,
`Application`, `Requisition`, `OvertimeAccrual`, `LearningRecord` — plus,
where they exist, a small set of other workstreams' tables (`Grade`,
`GradeAssignment`, `PayGrade`, `PulseSurvey`, `SurveyResponse`, `HrCase`)
read defensively via `readOptionalModel` so a metric this dashboard has no
data source for yet reports **not measured** instead of crashing the page.

## What exists now

### Models (`apps/api/prisma/schema/hcm-analytics.prisma`)

None. The file exists (every workstream owns one) and explains why it is
empty: computing and storing a second copy of any of the above tables' data
here would just be one more place for it to go stale against the tables that
actually own it.

### Shared pure logic (`packages/shared/src/hcm/analytics.ts`)

- The `Measured<T>` / `NotMeasured` / `Metric<T>` envelope and the `measured()` /
  `notMeasured(reason)` constructors every metric returns.
- Arithmetic, unit-tested independent of the database: `annualizedAttritionRate`,
  `isEarlyAttrition`, `absenteeismRate`, `hiringOfferAcceptanceRate`,
  `averageTimeToHireDays`, `dailyRateFromBasic`, `spanOfControlStats`,
  `tenureBucket`/`tenureYears`, `distribution`, `trailingMonths`/`monthKey`
  (`monthKey` itself is `finance.ts`'s export, re-exported here rather than
  redefined).
- `ANALYTICS_REPORTS` — the five CSV report names.

### Domain (`apps/api/src/domains/hcm/analytics.ts`)

Every function asserts `hr_analytics:view@all` (`assertScopeAll('hr_analytics')`)
— an aggregate across every record needs an all-scope grant, the same rule
`payrollCostByDivision`/`headcountByDivision` already follow elsewhere in this
codebase. Reports additionally assert `hr_reports:export`.

| Function | What it computes |
|---|---|
| `headcountTrend(months)` | Month-end headcount + joiners/leavers, trailing N months. Historical headcount is inferred from `hireEffectiveDate`/`separationDate` (no headcount-snapshot table exists), restricted to statuses that mean the person actually started (`Active, OnLeave, Suspended, NoticePeriod, Absconded, Terminated, Alumni` — excludes `PendingHire`, `OfferRescinded`, `NoShow`). |
| `headcountBy('division' \| 'location')` | Current snapshot, from each employment's latest effective `Assignment` → `Position` → `OrgUnit.division` / `Position.location`. |
| `attritionSummary(months)` | Leavers over the window ÷ average headcount, annualised to 365 days (`annualizedAttritionRate`); early-attrition count/rate (separated within 12 months of hire). |
| `tenureDistribution()` | Histogram of currently-employed tenure into `<1y / 1-3y / 3-5y / 5-10y / 10y+`. |
| `absenteeism(months)` | Share of recorded `WorkAttendance` rows with `workedMinutes = 0`, trailing N months. A day never punched at all is not counted — this is absenteeism among *recorded* days, not true unrecorded absence, and the doc/tile says so. |
| `overtimeHours(months)` | Sums `OvertimeAccrual.hours`/`.amount` (compliance-labour workstream) bucketed by `computedAt`'s month; amount withheld (`null`) without `compensation:financial`. |
| `leaveLiability()` | `LeaveBalance.balanceDays × (latest Effective CompensationRecord.basicPay ÷ 26)`, summed and by leave type; amount withheld without `compensation:financial` (days always shown). |
| `hiringSummary(months)` | Offer-acceptance rate (`OfferAccepted/Joined/NoShow` over every application that reached `OfferExtended` or beyond) and average requisition-created → hire-effective-date lead time, matched by candidate person id + requisition's position id. |
| `costPerHire()` | Always **not measured** — no recruiting-cost ledger (agency fees, ad spend) exists anywhere this workstream can read. |
| `spanOfControl()` | Direct-report count per manager position from currently-effective `Assignment.managerPositionId`; not measured if none exist yet. |
| `payrollCostTrend(months)` | Delegates to `domains/payroll.ts`'s own `payrollTrend` — it already asserts `payroll:view@all` and masks money on its own terms, so a caller without that grant gets that denial rather than a second, looser copy of the figure. |
| `trainingSummary(months)` | `completionsPerHead` (measured: `LearningRecord` completions ÷ current headcount); `averageHoursPerHead` (**always not measured** — `LearningActivity` carries no duration field in this schema, only `cost`). |
| `genderRatio()` | **Always not measured** — `Person` carries no gender field anywhere in this schema. |
| `compRatioDistribution()` | Compa-ratio (current CTC ÷ grade midpoint) bucketed into `<80% / 80-95% / 95-110% / 110-120% / >120%`. WS1's `Grade` and WS7's `PayGrade` are deliberately two separate, unlinked tables (per the plan — neither carries a foreign key to the other); the only field they share is `level`, so an employment's current `GradeAssignment` → `Grade.level` is matched to whichever `PayGrade` sits at that same level for the tenant — a level more than one `PayGrade` claims is dropped rather than guessed at. Read via `readOptionalModel` (never throws on an absent table); withheld (`notMeasured`) without `compensation:financial`, since a compa-ratio is a money figure by another name. |
| `engagementEnps()` | Every `enps`-type question answered across every `PulseSurvey`/`SurveyResponse` this tenant has, scored with `@kaizen/shared`'s `computeEnps` (which itself withholds the score below its own k-anonymity floor). Read via `readOptionalModel`. |
| `openCasesBySla()` | Open (non-terminal), non-`confidential` `HrCase` rows bucketed by `daysToSlaDue` into `Breached / Due today / Due this week / On track` — a confidential/grievance case is excluded the same way it is excluded from the general case queue in `domains/hcm/engagement.ts`, so this aggregate never hints at how many grievances are open. Read via `readOptionalModel`. |
| `dashboard(months)` | Runs all of the above in parallel for the one page-load call. |
| `exportHeadcountRegister` / `exportAttritionReport` / `exportLeaveLiabilityReport` / `exportOvertimeRegister` / `exportTrainingRegister` | CSV builders (`toCsv`), each calling `auditExport` so every download lands an `export` audit record with row count. |

### Routes (`apps/api/src/routes/hcm/analytics.routes.ts`, mounted at `/api/hcm/analytics`)

- `GET /_status` → `{ module: 'analytics', ready: true }`
- `GET /dashboard?months=`
- `GET /headcount/trend?months=`, `GET /headcount/by-division`, `GET /headcount/by-location`, `GET /tenure`
- `GET /attrition?months=`
- `GET /absenteeism?months=`, `GET /overtime?months=`
- `GET /leave-liability`
- `GET /hiring?months=`, `GET /hiring/cost-per-hire`
- `GET /span-of-control`
- `GET /payroll-trend?months=`
- `GET /training?months=`
- `GET /gender-ratio`, `GET /comp-ratio`, `GET /engagement/enps`, `GET /cases/by-sla`
- `GET /reports/headcount-register.csv`, `/reports/attrition.csv?months=`, `/reports/leave-liability.csv`, `/reports/overtime.csv?months=`, `/reports/training.csv?months=`

Every route is a plain read (or a CSV download of one) — there is no
`/:id/transition` pattern here the way there is in `hr.routes.ts`, because
there is no lifecycle.

### Web (`apps/web/src/pages/hcm/Analytics.tsx`, `/people/analytics`)

Two tabs:

- **Dashboard** — a KPI tile grid (`Metric`, each with a `noActionReason`
  since there is no per-metric drill target on this page) where every
  not-measured metric renders the words "Nothing to measure yet" plus its
  reason, never a bare `0` or `—` standing in for one; then inline-SVG charts
  with no charting library — a single accent-coloured line/bar for a
  one-series figure (headcount trend, tenure distribution, overtime hours,
  payroll cost trend, comp-ratio distribution, open cases by SLA) and the
  platform's fixed categorical `div-*` palette (with a legend) for the
  headcount-by-division breakdown only, since division is the only cut here
  that is actually a division — comp-ratio buckets and SLA buckets are not,
  so they stay on the single accent hue.
- **Reports** — one button per CSV export, using `api.download`.

## Acceptance

| ID | What PASS means | Test |
|---|---|---|
| HCM-ANALYTICS-001 | Headcount trend counts every real head and excludes anyone who hasn't actually started | `headcount trend > the latest month includes an employee hired this week...` |
| HCM-ANALYTICS-002 | Early-attrition flag and the annualised-rate formula match the shared pure functions exactly; zero leavers is a `0` rate, zero headcount is `null` | `attrition summary` (2 cases) |
| HCM-ANALYTICS-003 | Tenure buckets a 2-year hire into `1-3y` | `tenure distribution` |
| HCM-ANALYTICS-004 | Leave liability sums days correctly and withholds the amount (never the days) from a viewer without `compensation:financial` | `leave liability` |
| HCM-ANALYTICS-005 | Overtime hours sum correctly inside the trailing window | `overtime hours` |
| HCM-ANALYTICS-006 | A full requisition → application → offer → join flow produces a non-null offer-acceptance rate and time-to-hire | `hiring summary` |
| HCM-ANALYTICS-007 | Cost-per-hire and gender ratio always resolve to `measured: false` with a reason (no schema field, ever); comp-ratio/eNPS/open-cases-by-SLA never throw whatever state their tables are in; span of control resolves either way without throwing | `not-measured metrics degrade gracefully` (3 cases) |
| HCM-ANALYTICS-008 | An `employee` principal (no `hr_analytics` grant) is refused (403) on both a single metric and the whole dashboard; holding `hr_analytics:view` at `own` scope (not `all`) is refused the same way — an aggregate has no meaningful "own" | `permission refusal` (3 cases) |
| HCM-ANALYTICS-009 | A CSV export lands exactly one new `export` audit record and is itself refused without `hr_reports:export`; holding `hr_reports:export` at `own` scope is refused the same way | `report export is audited` (3 cases) |
| HCM-ANALYTICS-010 | Headcount is scoped to the caller's own tenant (cross-checked against a direct count) | `tenant scoping` |
| HCM-ANALYTICS-011 | Compa-ratio buckets an employee whose CTC equals their pay grade's midpoint into `95-110%`, bridged through `Grade.level`/`PayGrade.level`; withheld without `compensation:financial` | `compa-ratio distribution` (2 cases) |
| HCM-ANALYTICS-012 | eNPS scores a seeded 4-promoter/1-detractor mix via the shared formula (`computeEnps([9,10,9,10,3]).score === 60`), and adding it to the tenant-wide pool never lowers the aggregate score | `engagement eNPS` |
| HCM-ANALYTICS-013 | An overdue open case buckets as `Breached`; a confidential grievance case never moves the SLA breakdown | `open cases by SLA` (2 cases) |

22 `it` blocks total, run against `kaizen_test_analytics`.

## What this does not do

- No cost-per-hire (no recruiting-cost ledger anywhere in this schema).
- No gender ratio (`Person` has no gender field in this schema — a schema
  gap, not a permission gap).
- No hours-per-head for training (`LearningActivity` has no duration field —
  only completions-per-head is measured).
- Comp-ratio distribution can only place an employee whose current grade
  level resolves to *exactly one* `PayGrade` at that level — there is no
  `payGradeId` anywhere in the schema linking an employment (or WS1's
  `Grade`) to WS7's `PayGrade` directly, `level` is the only field the two
  tables share, and a level two or more `PayGrade` rows claim is dropped
  rather than guessed at. An employee with no current `GradeAssignment`, or
  no `Effective` `CompensationRecord`, is likewise excluded rather than
  counted at a wrong ratio.
- eNPS is withheld (not measured) below `computeEnps`'s own k-anonymity floor
  (`SURVEY_MIN_SAMPLE` responses), even once a survey exists — this workstream
  defers entirely to that floor rather than adding a second one.
- `readOptionalModel` still guards all three of comp-ratio, eNPS and
  open-cases-by-SLA against their tables being absent (a `not measured`
  degrade, never a throw) — relevant if this file is ever run against a
  schema snapshot from before WS7/WS1/WS9 landed their models.
- No historical division/location breakdown — only a current snapshot. A true
  historical cut would need either a headcount-snapshot table or walking
  every `Assignment`'s `effectiveFrom`/`effectiveTo` per month, which was cut
  for scope; the trend line itself (a simple month-end count) does not need
  that and is exact.
- Absenteeism is "share of recorded attendance rows with zero worked
  minutes" — a day nobody ever punched at all is invisible to it, since there
  is no separate absence record distinct from an attendance row.

## Wanted from the scaffold

- A real `payGradeId` column somewhere on the employment/assignment spine
  (or on WS1's `GradeAssignment`) would remove the `level`-number bridge
  compa-ratio currently leans on to reach WS7's `PayGrade` — today two
  tenant grade tables happening to share a level number is the only
  connection between "what rung this person sits on" and "what that rung
  is meant to pay".
- No new grant/event/nav was needed beyond what the scaffold already
  registered (`hr_analytics`, `hr_reports`, the `/people/analytics` nav node).

## Security review (scope-axis audit)

Following the WS5 review finding that `assertCan({ resource, verb })` without
a scope check lets an `own`-scope holder of a create/edit verb act on records
that are not their own: every entry point in this file was re-checked.

- `hr_analytics` and `hr_reports` are never granted at `own` scope to any
  role in `apps/api/src/seed/grants.ts` (`hr_ops_manager`/`finance_head` hold
  `@all`; `employee` holds neither) — so this specific bug was not live here.
  `dashboard()` was nonetheless tightened from a bare `assertCan({ resource:
  'hr_analytics', verb: 'view' })` to `assertAnalyticsView()`
  (`assertScopeAll`), and `assertReportExport()` from a bare `assertCan` to
  `assertScopeAll('hr_reports', 'export')`, so a future grants-matrix change
  that ever added an `own`-scope row for either resource could not use this
  reporting layer as a way to pull every other employee's data through it.
  Every other function in this file already called `assertScopeAll` via
  `assertAnalyticsView()`. HCM-ANALYTICS-008/009 each gained a case proving
  an `own`-scope grant on the resource is refused exactly like no grant at
  all.
- Nothing in this file creates, edits, or approves a record — it is
  read-only aggregation — so the "own-scope create/edit about someone else"
  half of the pattern does not apply to any function here.
