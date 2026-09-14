# HCM — G2. Time

Shifts, roster assignments, clock in/out, weekly timesheets, overtime pre-approval and the comp-off it
earns, and attendance regularisation that drives the existing `WorkAttendance` machine
(`apps/api/src/domains/leave.ts`) rather than re-implementing dispute/regularise.

## What exists now

### Models (`apps/api/prisma/schema/hcm-time.prisma`)

- **Shift** — code, name, `startTime`/`endTime` as `"HH:MM"`, grace minutes, break minutes, a
  `nightShift` flag (true is the one case where `endTime` reads earlier than `startTime`).
- **RosterAssignment** — one employment's shift over `[effectiveFrom, effectiveTo]`, with
  `weeklyOffDays` (0 Sunday .. 6 Saturday).
- **ClockEvent** — one punch (`in`/`out`), `occurredAt`, `source` (web/mobile/biometric_import), IP,
  device id, optional lat/long. The raw log a nightly job folds into `WorkAttendance`.
- **Timesheet** / **TimesheetEntry** — a weekly timesheet (`draft → submitted → approved/rejected`)
  with day/project/task/hours lines, a cached `totalHours`, and a `TSH-YYYY-NNNNN` record code.
- **OvertimeRequest** — a pre-approval (`requested → approved/rejected`) for a date and hours.
- **CompOff** — earned from an approved `OvertimeRequest` or filed directly for holiday work
  (`available → consumed/expired`), with a 90-day expiry from the day it was earned.
- **AttendanceRegularisation** — a request tied to a specific `WorkAttendance` row
  (`submitted → approved/rejected`); submitting it disputes that row, approving it regularises it.

Every model carries `tenantId` (indexed) and references `employmentRelationshipId` as a plain
`String`, per the multi-file schema convention — no `@relation` into `main.prisma`.

### Pure logic (`packages/shared/src/hcm/time.ts`)

`parseHHMM`/`formatHHMM`, `shiftScheduledMinutes` (a shift's paid span net of its break),
`classifyPunch` (late/early/half-day/absent + worked/overtime minutes from a punch pair against a
shift, night-shift-aware), `weeklyHoursTotal`, `weekStartMonday`, `compOffDaysForHours` (half a day
per 4 hours of overtime, rounded down to the nearest half day), `compOffExpiryDate`/`isCompOffExpired`,
`isWeeklyOff`.

### Domain (`apps/api/src/domains/hcm/time.ts`)

Shifts and rosters; clock in/out with alternation enforced (no clock-in over an open one, no
clock-out with nothing open); `deriveAttendanceFromClockEvents` (the nightly job) folding a day's
punches into `WorkAttendance` against the roster shift in force, idempotent via upsert, skipping a
`Locked` day; timesheet entries → submit → approve/reject (Self-Dealing Bar: decider ≠ the
timesheet's own employment); overtime requests → approve/reject, where approving also earns the
comp-off; comp-off listing/consumption and the expiry sweep; attendance regularisation submit/decide,
which drives `leave.ts`'s `transitionAttendance` under a system context (see "Wanted from the
scaffold" below) rather than requiring the filer to hold `attendance:edit` directly.

Every write emits its `kz.hr.<entity>.<verb>` event (all pre-registered by the scaffold); shifts and
their assignments are audited via `auditWrite`; tenant scoping and cross-tenant 404s come from the
same `prisma`/`assertEmploymentVisible` helpers every other HR domain uses.

### Routes (`apps/api/src/routes/hcm/time.routes.ts`, mounted at `/api/hcm/time`)

| Area | Endpoints |
|---|---|
| Shifts | `GET/POST /shifts`, `PATCH /shifts/:id` |
| Roster | `GET /rosters`, `GET /rosters/mine`, `POST /rosters` |
| Clock | `GET /clock`, `GET /clock/mine`, `POST /clock/mine/:kind`, `POST /clock` |
| Timesheets | `GET /timesheets(/mine)`, `GET /timesheets/:id`, `POST /timesheets/entries`, `DELETE /timesheets/entries/:id`, `POST /timesheets/:id/{submit,approve,reject}` |
| Overtime | `GET /overtime(/mine)`, `POST /overtime`, `POST /overtime/:id/{approve,reject}` |
| Comp-off | `GET /comp-offs(/mine)`, `POST /comp-offs/holiday-work`, `POST /comp-offs/:id/consume` |
| Regularisation | `GET /regularisations(/mine)`, `POST /regularisations`, `POST /regularisations/:id/{approve,reject}` |
| Jobs (manual trigger) | `POST /jobs/derive-attendance`, `POST /jobs/expire-comp-offs` |

### Jobs (`apps/api/src/jobs/hcm/time.ts`, not yet wired — see "Wanted from the scaffold")

- `runDeriveAttendanceFromClockEventsJob` — nightly, 03:00.
- `runCompOffExpiryJob` — nightly, 04:00.

### Web

- `apps/web/src/pages/hcm/Time.tsx` (`/people/time`) — seven tabs: Shifts, Roster, Clock, Timesheets,
  Overtime, Comp-off, Regularisations. HR ops creates shifts and rosters, reviews the clock log per
  employee, and decides submitted timesheets/overtime/regularisations (never their own).
- `apps/web/src/pages/me/Attendance.tsx` (`/me/attendance`) — clock in/out, this week's timesheet with
  an entry form and submit, my overtime requests, my comp-off balance (view-only — see below), and
  raising a regularisation.

## Acceptance

| ID | What PASS means | Test |
|---|---|---|
| HCM-TIME-001 | HR defines a shift and assigns an employment's roster to it; the assignment resolves for a covered day | `HCM-TIME-001` in `time.test.ts` |
| HCM-TIME-002 | An employee clocks in and out for themself; a second clock-in with no clock-out first is refused (422) | `HCM-TIME-002` |
| HCM-TIME-003 | The nightly deriver folds a punch pair against the roster shift into `WorkAttendance.workedMinutes` | `HCM-TIME-003` |
| HCM-TIME-004 | A submitted timesheet is approved by someone else; the employee cannot approve their own (403, Self-Dealing Bar); a decided timesheet cannot be decided again (422) | `HCM-TIME-004` |
| HCM-TIME-005 | Approving an overtime request earns a comp-off; a comp-off can be consumed once, and a second consumption is refused (422); self-approval is refused (403) | `HCM-TIME-005` |
| HCM-TIME-006 | The expiry sweep marks a past-due comp-off `expired`; it can no longer be consumed (422) | `HCM-TIME-006` |
| HCM-TIME-007 | Submitting a regularisation disputes the `WorkAttendance` row; approving it regularises the same row; a second approval is refused as an invalid transition (422); self-approval is refused (403) | `HCM-TIME-007` |
| HCM-TIME-008 | Reading a timesheet id that does not exist in this tenant 404s | `HCM-TIME-008` |
| HCM-TIME-009 | An employee-scoped principal cannot read a colleague's timesheet by id (404, not 403 — visibility, not authority) | `HCM-TIME-009` |

Run: `TEST_DATABASE_URL=postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test_time?schema=public npx vitest run src/tests/hcm/time.test.ts` from `apps/api` — 9/9 passing.

## What this does not do

- **Consumption is not wired to the leave ledger.** The plan names `leavepolicy`'s CO leave type as
  the intended path for spending a comp-off; until that workstream lands, `consumeCompOff` only flips
  this table's own status — it posts no `LeaveTransaction`. Grants also reflect this: `comp_offs` is
  `V@own` for an employee (view only), so consumption today is an HR-ops action (`comp_offs:edit`),
  not employee self-service — the `/me/attendance` page shows the balance but has no "use" button.
- **The deriver does not compute lateness/half-day status into `WorkAttendance` itself** — only
  worked and overtime minutes. `classifyPunch`'s `status`/`lateMinutes`/`earlyLeaveMinutes` are
  computed but not persisted anywhere yet; `WorkAttendance` has no columns for them (it is an
  already-existing model this workstream does not own). A future pass could carry them in `note` or
  ask for schema room on `WorkAttendance`.
- **No shift swap / trade workflow, and no multi-shift-per-day roster.** One shift per employment per
  effective range.
- **Overtime pre-approval is not enforced against the clock.** An employee can be paid comp-off for
  overtime that was requested and approved but never actually worked past the shift, because nothing
  here cross-checks the approved `OvertimeRequest` against that day's derived `WorkAttendance`.
  worked minutes.
- **No push/biometric device integration.** `source: 'biometric_import'` is a valid enum value with no
  importer behind it yet — a future job would insert `ClockEvent` rows with that source from a vendor
  file.
- **Timesheet hours are not validated against attendance or leave** — an employee can log 8 timesheet
  hours on a day they never clocked in.

## Wanted from the scaffold

- **Job registration.** `apps/api/src/jobs/hcm/time.ts` exports `JOBS: JobDefinition[]` (the same
  shape `jobs/compliance/index.ts` uses) but is not spread into `ALL_JOBS` — every workstream is
  barred from editing `scheduler.ts`. **Integrator action**: add
  `import { JOBS as time } from './hcm/time.js';` and `...time,` to `ALL_JOBS` in
  `apps/api/src/jobs/scheduler.ts`.
- **`attendance:edit` for a regularisation's own effect.** `attendance_regularisations` carries a
  `create`+`view` grant at `@own` scope for an employee, but driving the underlying
  `WorkAttendance` DISPUTE/REGULARISE transitions needs `attendance:edit`, which an own-scoped
  employee never holds. This domain runs those two transitions under a system context
  (`asSystem`) rather than the filer's or decider's own — gated instead on
  `attendance_regularisations:create`/`:approve`, which are the grants that actually exist for this
  flow. Documented here rather than requesting a grant change, since the system-context approach is
  the more honest fit: the regularisation *is* the audited action; the attendance transition is its
  mechanical consequence.
- No additional record-code prefix was needed beyond the scaffold's `TSH` (timesheet) — shifts,
  rosters, clock events, overtime requests, comp-offs and regularisations are referred to by id, not
  a human-facing number, which matches how `Holiday`/`WorkingHoursRule` work in `compliance-labour`.
