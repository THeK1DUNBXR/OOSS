# HCM — WS3. Leave policy

The leave policy engine sitting over the leave request/balance/ledger machinery
`apps/api/src/domains/leave.ts` already owns: who a policy applies to, how each leave type it
governs accrues, the guard rails a request against it is checked against, multi-level approval
chains, restricted-holiday elections, and a derived team calendar. It never re-implements the
request state machine, the ledger or `accrueEntitlement` — it calls into `leave.ts`'s exported
helpers.

## What exists now

### Models (`apps/api/prisma/schema/hcm-leavepolicy.prisma`)

- **LeavePolicy** — name, applicability as inclusion lists (`engagementTypes`, `orgUnitIds`,
  `gradeCodes`; empty means everybody), `effectiveFrom`/`effectiveTo`, `status` (active/retired).
- **LeavePolicyRule** — one leave type's rule under one policy: `accrualFrequency`
  (monthly/quarterly/yearly/none), `accrualDays` (days credited per accrual event, not an annual
  figure), `prorateOnJoin`, `maxBalanceDays`, `carryForwardCapDays`, `negativeAllowed`,
  `minNoticeDays`, `maxConsecutiveDays`, `sandwichRule`, `requiresDocumentAfterDays`,
  `applicableGender`.
- **AccrualRun** — one firing of one rule for one period, unique on `(leavePolicyRuleId, period)` —
  the idempotency guard the monthly job and the manual "Run accrual" button share.
- **LeaveApprovalChain** — a named, ordered list of levels (`manager` | `hr` | `custom_grant`),
  optionally scoped to one policy, or the tenant's default.
- **LeaveRequestApproval** — one level row per leave request's chain, with its approver resolved at
  chain-initiation time and a `pending/approved/rejected/skipped` decision.
- **RestrictedHolidayElection** — one employee's election of one restricted holiday for one FY,
  capped by `RESTRICTED_HOLIDAY_ANNUAL_LIMIT` (2).

None of these carry a `recordCode` — like `Holiday`/`WorkingHoursRule`/`LeaveYearClose` in
compliance-labour.prisma, they are configuration and job-log rows nobody refers to by number out
loud, and no `LVP`-style prefix exists in `RECORD_TYPE_CODES` for one to be added without editing
`packages/shared/src/domain.ts` (out of scope — see "Wanted from the scaffold").

Team calendar is derived, not a model: `teamCalendar(month, orgUnitId?)` composes `LeaveRequest` and
compliance-labour's `Holiday`.

### Pure logic (`packages/shared/src/hcm/leavepolicy.ts`)

`suggestedAccrualDays`, `proratedAccrual` (mid-period join/exit pro-ration), `creditableWithinCap`
(what a credit may add without breaching `maxBalanceDays`), `parseAccrualPeriod` (monthly/quarterly/
yearly period-key parsing), `calendarSpanDays` and `effectiveLeaveDays` (the sandwich rule — extends
`workingDayCount` from compliance/labour.ts: a bracketed weekend/holiday is charged as leave instead
of skipped), and `validateLeaveRequestAgainstPolicy`, which returns one true, specific statement per
violation (`min_notice`, `max_consecutive`, `insufficient_balance`, `gender_not_applicable`,
`document_required`) rather than a blanket refusal.

### Domain (`apps/api/src/domains/hcm/leavepolicy.ts`)

Policy/rule CRUD; `resolveApplicablePolicy` (most-specific-wins applicability resolution, using the
employment's `engagementType` and current org unit via its latest effective `Assignment`);
`validateLeaveRequest` (the pre-flight check, see below); the accrual job
(`runAccrualForRule`/`runMonthlyAccrual`), idempotent per `(rule, period)`, pro-rating a mid-period
join and capping at `maxBalanceDays`, crediting through `leave.ts`'s `accrueEntitlement`; approval
chains (`createApprovalChain`, `initiateApprovalChain`, `decideApprovalLevel`); restricted-holiday
elections; and `teamCalendar`.

**Wiring a leave request without editing `leave.ts` or `hooks.ts`.** There is no
`leave_request.before_create` hook point registered in `platform/hooks.ts`, so this module cannot
veto a leave request at the moment it is written — the honest limit this brings, recorded rather
than worked around. Two real mechanisms exist instead:

1. `POST /validate` exposes `validateLeaveRequest` for a form to check before `POST
   /hr/leave-requests` — this is what `/me/leave`'s "Check against policy" button calls, and it is a
   real, specific, pre-submission gate even though it cannot be a server-side hard block on the write
   itself.
2. This module subscribes to `EVENTS.LEAVE_REQUEST_CREATED` (via `platform/eventBus.ts`'s
   `subscribe`, not by editing `events/handlers.ts`) to, after the fact: open the request's approval
   chain (idempotent), and raise `EX-HCM-LVP-001` when the request as filed already breaks its
   policy — the same "allowed, but never silent" pattern `leave.ts` itself uses for a negative
   balance (`EX-HR-004`).

**The Self-Dealing Bar on `decideApprovalLevel`.** The platform's grant matrix has four roles, not
one per rank, so an ordinary manager holds no blanket `leave:approve`. `decideApprovalLevel`
authorises on identity instead: the level's own resolved approver may decide it (a delegated,
per-record authority the coarse grant matrix does not otherwise express), and anybody else needs the
broad `leave:approve` grant as an override. The bar itself is unconditional either way: nobody may
ever decide a level on their own leave request, checked before the identity branch.

### Routes (`apps/api/src/routes/hcm/leavepolicy.routes.ts`, mounted at `/api/hcm/leavepolicy`)

| Area | Endpoints |
|---|---|
| Policies | `GET/POST /policies`, `GET/PATCH /policies/:id`, `GET /policies/applicable?employmentRelationshipId=&leaveTypeId=` |
| Rules | `GET /policies/:id/rules`, `POST /policies/:id/rules`, `PATCH/DELETE /rules/:id` |
| Validation | `POST /validate` |
| Accrual | `POST /accrual-runs`, `GET /accrual-runs` |
| Approval chains | `GET/POST /approval-chains`, `PATCH/DELETE /approval-chains/:id` |
| Approvals | `POST /leave-requests/:id/initiate-chain`, `GET /leave-requests/:id/approvals`, `GET /approvals/inbox`, `POST /approvals/:id/decide` |
| Restricted holidays | `GET/POST /restricted-holiday-elections`, `DELETE /restricted-holiday-elections/:id` |
| Team calendar | `GET /team-calendar?month=YYYY-MM&orgUnitId=` |

### Jobs (`apps/api/src/jobs/hcm/leavepolicy.ts`, not yet wired — see "Wanted from the scaffold")

- `runLeaveAccrualJob` — monthly, 1st at 02:00 — `runMonthlyAccrual()`, which runs every
  `monthly`-frequency rule of every active policy for the current month, each firing idempotent.

### Web

- `apps/web/src/pages/hcm/LeavePolicies.tsx` (`/people/leave-policies`) — three tabs: **Policies**
  (applicability, add a leave-type rule, run its accrual on demand), **Accrual runs** (history), and
  **Approval chains** (build an ordered manager/hr/specific-person chain).
- `apps/web/src/pages/hcm/LeaveCalendar.tsx` (`/people/leave-calendar`) — a month grid of who is away
  and the holidays alongside it, filterable by org unit.
- `apps/web/src/pages/me/Leave.tsx` (`/me/leave`) — balances, history, "Apply for leave" with a
  live policy check before submitting (via `POST /validate`), restricted-holiday elections, and an
  inbox of anything resolved to the viewer to decide in somebody else's chain.

## Acceptance

| ID | What PASS means | Test |
|---|---|---|
| HCM-LVP-001 | Pure accrual/pro-rata/sandwich/period-parsing/validation arithmetic is correct in isolation | `HCM-LVP-001a`–`f` |
| HCM-LVP-002 | A duplicate rule for the same leave type on a policy is refused (409); an employee holds no `leave_policies:create` (403) | `HCM-LVP-002` (×2) |
| HCM-LVP-003 | Applicability resolution picks the more specific (engagement-type-scoped) policy over the wider default | `HCM-LVP-003` |
| HCM-LVP-004 | `validateLeaveRequest` flags a real notice-period breach and clears once satisfied; with no rule configured it is permissive and says so | `HCM-LVP-004` (×2) |
| HCM-LVP-005 | The accrual run is idempotent per `(rule, period)`; a `none`-frequency rule refuses to run | `HCM-LVP-005` (×2) |
| HCM-LVP-006 | An approval chain resolves the requester's actual manager and lets them decide their level; the Self-Dealing Bar refuses the leave-taker deciding their own | `HCM-LVP-006` (×2) |
| HCM-LVP-007 | A third restricted-holiday election in one FY is refused once the two-per-year limit is reached; withdrawing frees a slot | `HCM-LVP-007` |
| HCM-LVP-008 | The team calendar returns an empty list rather than erroring for a quiet month; cross-tenant isolation holds | `HCM-LVP-008` (×2) |

All 18 `it` blocks pass against `kaizen_test_leavepolicy`
(`npx vitest run src/tests/hcm/leavepolicy.test.ts`).

## What this does not do

- **Does not block a policy-violating leave request at creation.** See "Wiring a leave request"
  above — it validates pre-submission and flags post-creation, but cannot veto the write inside
  `leave.ts` itself without a hook point that does not exist yet.
- **`gradeCodes` on `LeavePolicy` is accepted and stored but never matched against** — there is no
  Grade model yet to resolve an employment's grade from (workstream A/WS1 territory). Applicability
  today is `engagementTypes` and `orgUnitIds` only.
- **`applicableGender` is checked only when the caller supplies a `gender` fact explicitly** — `Person`
  carries no gender field in `main.prisma`, so this cannot be resolved server-side from the
  employment record itself. The rule and its check exist and are tested; the fact has nowhere to come
  from automatically today.
- **The monthly accrual job is not wired into `ALL_JOBS`** — see below.
- **Carry-forward/lapse at FY close is not implemented here** — `LeavePolicyRule.carryForwardCapDays`
  is stored and surfaced on the policy screen, but the actual FY-close sweep lives in
  compliance-labour.ts's `runLeaveYearClose` against `LeaveType.carryForwardCapDays` (a different,
  pre-existing field on a different model). Reconciling the two caps is a follow-up, not attempted
  here to avoid touching a file this workstream does not own.
- **Org-unit applicability degrades to "does not match"** when an employment has no current
  assignment to resolve an org unit from, rather than guessing — a policy scoped by org unit simply
  will not apply to an employment with no assignment on record.

## Wanted from the scaffold

- **A `leave_request.before_create` hook point in `platform/hooks.ts`** (payload `{ input }`, vetoable)
  would let this module enforce policy at the point of creation instead of only before (via `POST
  /validate`) and after (via the `LEAVE_REQUEST_CREATED` subscription raising an exception).
- **`apps/api/src/jobs/hcm/index.ts`**, mirroring `jobs/compliance/index.ts`'s `COMPLIANCE_JOBS`
  pattern: `export const HCM_JOBS = [...leavepolicyJobs, ...]`, spread into `ALL_JOBS` in
  `scheduler.ts`. Until it exists, `runLeaveAccrualJob` in `apps/api/src/jobs/hcm/leavepolicy.ts` is
  defined and tested (`runMonthlyAccrual` is exercised directly by HCM-LVP-005) but not reachable from
  the scheduled tick — the integrator wires it in without editing `scheduler.ts` beyond that one
  spread.
- **A `LVP`-style record-code prefix** was not pre-registered in `RECORD_TYPE_CODES`
  (`packages/shared/src/domain.ts`) the way `TSH`/`OFR`/`RVW`/etc. were for other workstreams — not
  needed today since none of this workstream's models are the kind a human refers to by number, but
  worth knowing if a future policy-approval or accrual-run reference needs one.
