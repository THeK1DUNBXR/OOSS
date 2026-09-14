# HCM — WS10 separations

Resignations, notice-period policy, exit clearance across five departments,
the no-dues certificate that closes an exit out, and the alumni record that
survives the employment relationship once it reaches `Alumni`. This
workstream does not own the employment or offboarding lifecycle machines —
those are `EmploymentRelationship`/`Offboarding` in `domains/employment.ts`,
against the machines in `packages/shared/src/hr.ts` — it drives them at the
right moments (accepting a resignation calls
`transitionEmployment(..., 'SUBMIT_RESIGNATION')`; clearing the last
department calls `transitionOffboarding(..., 'CLEARANCE_COMPLETE')`) and
owns everything that surrounds those two calls.

## What exists now

### Models (`apps/api/prisma/schema/hcm-separations.prisma`)

- **Resignation** — `recordCode` (`RSG-YYYY-NNNNN`), `employmentRelationshipId`, `submittedOn`, `requestedLastDay`, `noticeDays` (copied from the resolved notice policy at submission time), `reasonCategory`, `reasonNote`, `status` (`submitted | accepted | withdrawn | rejected`), `acceptedById`/`acceptedAt`/`agreedLastDay`, `rejectedReason`, `withdrawnAt`, `offboardingId` (set once accepted).
- **NoticePolicy** — `name`, `grade`, `engagementType` (either nullable — null means "applies regardless"), `noticeDays`, `buyoutAllowed`, `active`.
- **ExitClearance** — one row per `(offboardingId, department)`, `department` ∈ `{it, finance, admin, manager, hr}`, `status` (`pending | cleared | blocked`), `note`, `clearedById`/`clearedAt`.
- **NoDuesCertificate** — `offboardingId` (unique), a `clearanceSnapshot` JSON taken at issue time, `issuedById`/`issuedOn`. Final once written — there is no update path, only the one create.
- **AlumniRecord** — `personId`, `employmentRelationshipId` (unique), `lastDesignation` (read off the latest `Assignment`/`Position`/`Job` at write time), `exitDate`, `separationType`, `rehireEligible`, `rehireNote`, `contactConsent`, `contactEmail`, `contactPhone`.

All five: plain `tenantId String` + `@@index([tenantId])`, no `@relation` into `main.prisma` — an id like `employmentRelationshipId` is a plain column, per the multi-file schema convention `compliance-labour.prisma` sets. `Resignation`/`ExitClearance`/`NoDuesCertificate` therefore never `include` an employment; the domain layer's `employmentBrief()` helper follows the id by hand.

### Shared pure logic (`packages/shared/src/hcm/separations.ts`)

- `RESIGNATION_REASON_CATEGORIES`, `RESIGNATION_STATES`, `RESIGNATION_TRANSITIONS`/`canTransitionResignation` — the small machine a resignation itself moves through (`submitted` is the only state with outbound arrows).
- `resolveNoticePolicy(policies, grade, engagementType)` — most-specific-match resolution (a row naming both grade and engagement type beats one naming only one beats the flat fallback).
- `noticeShortfallDays(noticeDays, submittedOn, lastDay)` — days short of full notice, floored at zero, for a buyout line downstream (payroll's own concern; not computed here).
- `CLEARANCE_DEPARTMENTS`, `CLEARANCE_STATUSES`, `allClearancesComplete(rows)`, `blockedClearanceCount(rows)` — the clearance vocabulary and its two derived facts.

### Domain (`apps/api/src/domains/hcm/separations.ts`)

- **Notice policy** — `listNoticePolicies` / `createNoticePolicy` / `setNoticePolicyActive`; `noticeDaysFor(employmentId)` resolves the applicable policy (matched on `engagementType`; `grade` is not yet on `EmploymentRelationship` so it is always matched as `null` — see Wanted below) or falls back to the employment's own flat `noticePeriodDays`.
- **Resignation** — `submitResignation` (own-scope for the employee, all-scope for HR filing on somebody's behalf; refuses a second `submitted` row, refuses when employment is not `Active`/`OnLeave`); `acceptResignation` (`resignations:approve`, Self-Dealing Bar — the resigning employee can never accept their own — calls `transitionEmployment(..., 'SUBMIT_RESIGNATION')` and links the `Offboarding` row that creates); `rejectResignation` (same grant and bar); `withdrawResignation` (the employee's own act on their own still-`submitted` row, carried by `resignations:create @own` since a withdrawal is not an edit of a decided record).
- **Exit clearance** — `initiateClearance` (drives the offboarding from `NoticePeriodActive`→`LastWorkingDayReached`→`ClearancePending` as needed, then opens the five department rows, idempotently); `clearDepartment`/`blockDepartment` (Self-Dealing Bar — the departing employee never clears or is asked to clear their own exit); `afterClearanceChange` auto-advances the offboarding (`CLEARANCE_COMPLETE` once all five are `cleared`, `DISPUTE` when any is `blocked`, `RESOLVE` once no block remains).
- **No-dues** — `issueNoDues` refuses outright (409, naming the outstanding departments) unless `allClearancesComplete` is true; `getNoDues` for reading it back.
- **Alumni** — `recordAlumni` transitions `Terminated`→`Alumni` via `transitionEmployment(..., 'RETENTION_TRANSITION')` (or accepts an already-`Alumni` employment) and writes the record; refuses a second write for the same employment.
- **`assetsPendingCount(employmentId)`** — calls WS11's `assetsPendingForEmployment` (`domains/hcm/assets.ts`, written for this workstream to call), wrapped in try/catch so a checkout without WS11 degrades to `null` ("not measured") instead of a 500.
- **`myEmploymentId()` / `myResignations()` / `mySubmitResignation()` / `myOffboarding()` / `myNoticeDays()`** — the `/me/exit` shape, resolving the caller's own employment from `currentAuth().partyId` (mirrors `time.ts`'s `myEmploymentId`) so the client never has to know or paste an id.
- **`getOffboardingForEmployment`** — a read this workstream's screens need (clearances + `allCleared` + no-dues, joined onto the `Offboarding` row), gated by `assertEmploymentVisible('employees', ...)` — the same guard `employment.ts` puts in front of `leaveBalances`.

No role slug is ever compared. Scope narrowing goes through `assertCan`'s `record.ownerPartyId`, `scopeFor(resource, verb)`, or `assertEmploymentVisible` — the same three mechanisms `employment.ts`/`compliance/labour.ts` use.

### Routes (`apps/api/src/routes/hcm/separations.routes.ts`), mounted at `/api/hcm/separations`

| Method & path | Calls |
|---|---|
| `GET /_status` | — |
| `GET/POST /notice-policies`, `PATCH /notice-policies/:id/active`, `GET /notice-policies/for/:employmentId` | notice policy CRUD + resolution |
| `GET /resignations`, `GET /resignations/:id`, `POST /resignations`, `POST /resignations/:id/{accept,reject,withdraw}` | resignation lifecycle |
| `GET /my/resignations`, `POST /my/resignations`, `GET /my/offboarding`, `GET /my/notice-days` | the `/me/exit` shape |
| `GET /offboarding/by-employment/:employmentId` | `getOffboardingForEmployment` |
| `GET /offboarding/:offboardingId/clearances`, `POST /offboarding/:offboardingId/clearances/initiate` | exit clearance |
| `POST /clearances/:id/{clear,block}` | per-department decisions |
| `GET/POST /offboarding/:offboardingId/no-dues` | no-dues certificate |
| `GET /assets-pending/:employmentId` | `assetsPendingCount` |
| `GET/POST /alumni` | alumni record |

### Screens

- **`/people/separations`** (`apps/web/src/pages/hcm/Separations.tsx`) — five tabs: Resignations (accept/reject, status filter), Exit clearance (open/refresh, per-department clear/block), No-dues (issue once complete), Alumni (list + record), Notice policies (list/create/toggle). Actions that the server would refuse are omitted rather than shown disabled: a resignation not in `submitted` shows no accept/reject row, a cleared department shows no clear/block buttons.
- **`/me/exit`** (`apps/web/src/pages/me/Exit.tsx`) — submit a resignation (with the applicable notice period shown as a hint before submitting), see its status, withdraw it while still pending, and once accepted, watch the exit clearance table and the no-dues certificate appear.

## Acceptance table

| ID | PASS means | Test |
|---|---|---|
| HCM-SEP-001 | An accepted resignation moves the employment relationship to `NoticePeriod` and opens an `Offboarding` at `NoticePeriodActive` | `HCM-SEP-001` |
| HCM-SEP-002 | A resignation cannot be accepted by the person who filed it | `HCM-SEP-002` |
| HCM-SEP-003 | A second resignation is refused (409) while one is `submitted`; a fresh one is accepted after the first is withdrawn | `HCM-SEP-003` |
| HCM-SEP-004 | A withdrawn resignation cannot then be accepted (409) | `HCM-SEP-004` |
| HCM-SEP-005 | `noticeDaysFor` resolves an engagement-type-specific active policy over the employment's flat default, and `submitResignation` copies that value onto the row | `HCM-SEP-005` |
| HCM-SEP-006 | Clearing all five departments completes the exit clearance and the offboarding reaches `FFSettlementPending` | `HCM-SEP-006` |
| HCM-SEP-007 | A department cannot be cleared by the departing employee themselves | `HCM-SEP-007` |
| HCM-SEP-008 | Blocking a department disputes the offboarding (`BlockedDisputed`); clearing the block resolves it back to `ClearancePending`/onward | `HCM-SEP-008` |
| HCM-SEP-009 | No-dues is refused (409, naming the outstanding departments) until all five clear, then succeeds | `HCM-SEP-009` |
| HCM-SEP-010 | A resignation from another tenant 404s rather than leaking a 403 | `HCM-SEP-010` |
| HCM-SEP-011 | `recordAlumni` moves `Terminated` into `Alumni` and writes rehire/consent fields | `HCM-SEP-011` |
| HCM-SEP-012 | An employee's resignation list is narrowed to their own; a colleague's resignation 404s by id | `HCM-SEP-012` |

All 12 pass against `kaizen_test_separations` (`npx vitest run src/tests/hcm/separations.test.ts`).

## What this does not do

- No approval-chain UI for accepting a resignation beyond the single `resignations:approve` grant — there is no multi-level sign-off, matching the plan (this is HR ops accepting, finance only ever views).
- `NoticePolicy.grade` is declared but never matched against, because `EmploymentRelationship` carries no grade field this workstream can read (WS1 owns `Grade`/`ReportingLine`). `noticeDaysFor` only ever resolves on `engagementType`.
- No buyout amount is computed or posted — `resignationNoticeShortfall()` (pure, exported) gives the days short of full notice; turning that into money and posting it to payroll is payroll's own concern, not modelled here.
- F&F settlement (`settleOffboarding` in `domains/compliance/payroll.ts`) does not itself check `allClearancesComplete` before running — see Wanted below.
- No exit interview — that model (`ExitInterview`) belongs to WS9 engagement per the plan, not this workstream.
- `AssetReturn` is read-only from here (`assetsPendingCount`, backed by WS11's own `assetsPendingForEmployment`); this workstream neither creates nor closes an asset assignment.
- The clearance screen's department detail is loaded by pasting an offboarding id (or via "view clearance" from the accepted-resignations list) rather than a cross-linked employee 360 — WS1's directory/360 view is a separate workstream and this screen does not assume it exists yet.

## Wanted from the scaffold

- **A hook point for "no F&F before clearance is complete."** `hooks.ts` declares `offboarding.completed` (fired at `ClosedArchived`/`FFSettlementCompleted`) but nothing fires *before* `settleOffboarding` runs in `domains/compliance/payroll.ts`, and that file is out of this workstream's ownership to add one to. `settleOffboarding` currently computes and writes a settlement amount regardless of `ExitClearance` state. The clean fix is an `offboarding.before_settle` hook point declared in `hooks.ts` (scaffold or platform, not this workstream) that `settleOffboarding` calls and this workstream registers against, asserting `allClearancesComplete`.
- **A `grade` field on `EmploymentRelationship` (or a WS1 cross-read)** so `NoticePolicy.grade` can actually be matched — right now it is declared but always resolves as "any grade," which is honest but incomplete once WS1's `Grade`/`ReportingLine` model exists.
- The scaffold's resource list already includes `resignations`, `exit_clearances`, `no_dues`, `alumni`, `notice_policies` with sensible verb/scope cells (employee `V@own`/`VC@own`, hr_ops_manager `VCEDA(,approve)`, finance_head `V`, alumni HR-only) — no gap there. Record code `RSG` and events `kz.hr.resignation.{submitted,accepted,withdrawn,rejected}`, `kz.hr.exit_clearance.completed`, `kz.hr.no_dues.issued` were likewise already present and used as-is; no per-department clearance event was scaffolded, so a single department clearing or blocking is `auditWrite`d but does not emit its own `kz.hr.*` event — only the all-departments-complete case does (`EXIT_CLEARANCE_COMPLETED`).
