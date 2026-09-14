# HCM — WS12 analytics

HR analytics & reporting. A read-only layer: no new tables, no lifecycle, no
write path. Every function reads existing tables — `EmploymentRelationship`,
`Assignment`, `LeaveBalance`, `WorkAttendance`, `PayrollInstruction`,
`Application`, `Requisition`, `OvertimeAccrual`, `LearningRecord` — plus,
where they exist, a small set of other workstreams' tables read defensively
so a metric this dashboard has no data source for yet reports **not
measured** instead of crashing the page.

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
| `compRatioDistribution()` / `engagementEnps()` / `openCasesBySla()` | Probe for a `payGrade` / `surveyResponse` / `hrCase` Prisma model by name (`readOptionalModel`, which returns `null` on an absent model, an absent table, or any other failure — never throws) and report **not measured**, with a reason that distinguishes "the table hasn't landed yet" from "it has landed but this workstream doesn't read its shape yet" (compensation/engagement/cases workstreams were not guessed at beyond that — see "Wanted from the scaffold"). |
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
  payroll cost trend) and the platform's fixed categorical `div-*` palette
  (with a legend) for the headcount-by-division breakdown, since division is
  the same cut Finance and the Command Center already use it for.
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
| HCM-ANALYTICS-007 | Cost-per-hire, gender ratio, comp-ratio, eNPS and open-cases-by-SLA all resolve to `measured: false` with a reason — never throw; span of control resolves either way without throwing | `not-measured metrics degrade gracefully` (2 cases) |
| HCM-ANALYTICS-008 | An `employee` principal (no `hr_analytics` grant) is refused (403) on both a single metric and the whole dashboard | `permission refusal` (2 cases) |
| HCM-ANALYTICS-009 | A CSV export lands exactly one new `export` audit record and is itself refused without `hr_reports:export` | `report export is audited` (2 cases) |
| HCM-ANALYTICS-010 | Headcount is scoped to the caller's own tenant (cross-checked against a direct count) | `tenant scoping` |

14 `it` blocks total, run against `kaizen_test_analytics`.

## What this does not do

- No cost-per-hire (no recruiting-cost ledger anywhere in this schema).
- No gender ratio (`Person` has no gender field in this schema — a schema
  gap, not a permission gap).
- No hours-per-head for training (`LearningActivity` has no duration field —
  only completions-per-head is measured).
- No compa-ratio, eNPS, or open-cases-by-SLA yet — each needs a table
  (pay grades/bands, survey responses, HR cases) that belongs to a workstream
  that had not landed a stable, known shape at the time this one was built.
  `readOptionalModel` probes for a plausible model name so these degrade
  gracefully instead of crashing, and will report "not measured (shape not
  read yet)" rather than a wrong number even once the table exists, until
  this file is updated to read it deliberately.
- No historical division/location breakdown — only a current snapshot. A true
  historical cut would need either a headcount-snapshot table or walking
  every `Assignment`'s `effectiveFrom`/`effectiveTo` per month, which was cut
  for scope; the trend line itself (a simple month-end count) does not need
  that and is exact.
- Absenteeism is "share of recorded attendance rows with zero worked
  minutes" — a day nobody ever punched at all is invisible to it, since there
  is no separate absence record distinct from an attendance row.

## Wanted from the scaffold

- A stable name/shape for whatever the compensation workstream calls its
  pay-grade/band table (for compa-ratio), the engagement workstream calls its
  survey-response table (for eNPS), and the separations/cases workstream
  calls its HR-case table (for open-cases-by-SLA) would let this file read
  them properly instead of only probing for a model name and reporting "not
  measured" either way.
- No new grant/event/nav was needed beyond what the scaffold already
  registered (`hr_analytics`, `hr_reports`, the `/people/analytics` nav node).
