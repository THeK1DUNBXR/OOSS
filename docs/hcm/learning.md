# HCM — WS6 learning

The training catalogue, the enrollment workflow around it, certifications
with an expiry ladder, mandatory-training tracking, individual development
plans, and a training budget. Built to *feed* the existing capability system
(`apps/api/src/domains/capability.ts`, `Skill`/`CapabilityClaim`/`Evidence`)
rather than duplicate it: completing a skills-linked enrollment calls straight
into `claimFromLearningCompletion`, the same function `performance.ts`'s own
simpler `LearningActivity`/`LearningRecord` pair already uses. This workstream
never writes a `CapabilityClaim` or `Evidence` row directly, and it never
redefines those models.

## What exists now

### Models (`apps/api/prisma/schema/hcm-learning.prisma`)

- `TrainingProgram` — title, kind (`classroom`/`online`/`certification`/
  `mandatory`), provider, cost, `skillIds` (referencing the existing `Skill`
  model by id), `validityMonths` for a certification-kind program.
- `TrainingSession` — a scheduled running of a program (real `@relation` to
  `TrainingProgram`, since both live in this schema file).
- `TrainingEnrollment` — one employee's booking against one session.
  `nominatedById` and `approvedById` are separate columns — that separation
  is what the Self-Dealing Bar checks against. Status:
  `nominated -> approved -> attended -> completed`, with `rejected`/`no_show`
  exits (`packages/shared/src/hcm/learning.ts#ENROLLMENT_TRANSITIONS`).
- `Certification` — held against an employment (plain `employmentRelationshipId`
  string, no cross-schema relation, per the multi-file schema convention).
  `verified`/`verifiedById` record who checked it — never the holder.
  `lastExpiryRungDays` is the expiry-ladder job's idempotency guard.
- `MandatoryTrainingRule` — ties a program to a due window from date of join,
  with an optional recurrence.
- `IndividualDevelopmentPlan` — mentor, JSON goals, a review date.
- `TrainingBudget` — a financial-year (optionally division-scoped) amount.
  `spent` is never a stored column; it is derived at read time from completed
  enrollments so it cannot drift from what actually happened.

### Shared pure logic (`packages/shared/src/hcm/learning.ts`)

- `ENROLLMENT_TRANSITIONS` / `assertEnrollmentTransition` — the enrollment
  lifecycle graph.
- `assertEnrollmentApprovalAllowed` — the Self-Dealing Bar for a nomination:
  the approver may be neither the nominee nor the person who raised the
  nomination.
- `assertCertificationVerificationAllowed` — a certification cannot be
  self-verified.
- `certificationExpiryFrom` — issue date + program validity → expiry date.
- `CERTIFICATION_EXPIRY_LADDER` / `expiryRungReached` / `isCertificationExpired`
  — the 90/30/7-day ladder.
- `mandatoryTrainingDueDate` / `nextRecurrenceDue` / `isMandatoryTrainingOverdue`
  — mandatory-training due-date arithmetic, from join date or from the last
  completion for a recurring rule.
- `budgetUtilisationPercent` — a 0–100 percentage, null when there is no
  budget to divide by (never a fabricated number).

### Domain (`apps/api/src/domains/hcm/learning.ts`)

Every write is grant-checked via `assertCan`, tenant-scoped through `prisma`,
and emits an event on every state change:

- **Catalogue**: `listPrograms`/`createProgram`/`setProgramActive`,
  `listSessions`/`createSession`/`setSessionStatus`.
- **Enrollments**: `nominate` (records `nominatedById`), `approveEnrollment`
  (Self-Dealing Bar — refuses when the approver is the nominee or the
  nominator), `rejectEnrollment`, `markAttendance`, `completeEnrollment`.
  Completion:
  - asserts a capability claim per `skillId` on the program via
    `claimFromLearningCompletion` (capped at the Assessed tier, per
    `tierForLearningCompletion` in `capability.ts` — completing training is
    evidence of being taught, not of being able to do it);
  - if the program is certification-kind, issues a `Certification` row
    (unverified, with a `CERT-YYYY-NNNNN` record code and an expiry from
    `validityMonths`).
- **Certifications**: `listCertifications`, `addCertification` (a credential
  entered directly — the employee already held it, or it came from outside
  this platform's catalogue), `verifyCertification` (barred from the holder),
  `runCertificationExpiryLadder` (the 90/30/7 job, idempotent per rung via
  `lastExpiryRungDays`; raises `CERTIFICATION_EXPIRING`/`CERTIFICATION_EXPIRED`
  exceptions and events).
- **Mandatory training**: `listMandatoryRules`, `createMandatoryRule`,
  `mandatoryComplianceStatus` (every active employee × every active rule,
  with a due date and whether it is overdue), `runMandatoryTrainingOverdueCheck`
  (raises one exception per overdue pair).
- **IDPs**: `listIdps`, `createIdp`, `updateIdp`.

**Scope-axis audit** (see `alert-scope.md`): `assertCan({resource, verb})`
with no `record` skips the WHERE axis, so an own-scope grant (an `employee`
role, or any fixture role scoped `@own`) would otherwise pass straight
through to an operation on somebody else's row. Fixed:
`nominate` (an own-scope caller may only nominate themselves — 403
otherwise), `approveEnrollment`/`rejectEnrollment`/`markAttendance`/
`completeEnrollment`/`verifyCertification` (each now requires
`scopeFor(...) === 'all'` — these are not self-service actions, whatever verb
a caller happens to hold), `updateIdp` (an own-scope caller may only edit
their own plan — 404 on a colleague's, matching `assertEmploymentVisible`'s
not-found-not-forbidden convention), a bare `listEnrollments`/
`listCertifications`/`listIdps` with no id filter (now narrowed to the
caller's own employment(s) when scope is not `all`, instead of returning
every colleague's row), `mandatoryComplianceStatus` (was gated on
`training_programs`, whose view is company-wide by design — switched to
`training_enrollments`, the resource whose sensitivity actually matches what
this reads), and `runCertificationExpiryLadder` (had no permission check at
all on its route — any authenticated user could trigger it and see every
certification's expiry state through the exceptions it raises; now requires
all-scope `certifications:view`). `HCM-LEARNING-013` in the test file proves
each fix with an own-scope actor refused, or narrowed, on a colleague's
record.
- **Budgets**: `listBudgets` (with derived `spent`/`utilisationPercent`),
  `createBudget`.

### Routes (`/api/hcm/learning`, `apps/api/src/routes/hcm/learning.routes.ts`)

`GET/POST /programs`, `PATCH /programs/:id`, `GET/POST /sessions`,
`POST /sessions/:id/status`, `GET/POST /enrollments`,
`POST /enrollments/:id/{approve,reject,attendance,complete}`,
`GET/POST /certifications`, `POST /certifications/:id/verify`,
`POST /certifications/expiry-check`, `GET/POST /mandatory-rules`,
`GET /mandatory-status`, `POST /mandatory-rules/overdue-check`,
`GET/POST /idps`, `PATCH /idps/:id`, `GET/POST /budgets`, `GET /_status`.

### Jobs (`apps/api/src/jobs/hcm/learning.ts`)

`LEARNING_JOBS: JobDefinition[]` — the certification expiry ladder (daily,
03:00) and the mandatory-training overdue check (daily, 03:30) — in the exact
shape `jobs/compliance/index.ts` uses for `COMPLIANCE_JOBS`. **Not** wired
into `jobs/scheduler.ts`'s `ALL_JOBS` array, since that file is common
infrastructure this workstream does not edit. **Integrator action**: spread
`...LEARNING_JOBS` into `ALL_JOBS` (or call the exported
`registerLearningJobs(register)` helper), the same way `...COMPLIANCE_JOBS`
is spread in today.

### Web

- `/people/learning` (`apps/web/src/pages/hcm/Learning.tsx`) — tabs: Programs,
  Sessions, Enrollments (approve/reject/attendance/complete, with the
  self-dealing refusal surfaced as an inline error rather than a disabled
  button — nothing here can tell in advance who nominated a given row),
  Certifications (verify, run the expiry check), Mandatory (rules + live
  compliance status with an overdue count), IDPs, Budget.
- `/me/learning` (`apps/web/src/pages/me/Learning.tsx`) — my enrollments
  (with a self-nominate action, offered only while an open session exists —
  no dead-end button when there is nothing to nominate into), my
  certifications, my development plan.

## Acceptance table

| ID | What PASS means | Test |
| --- | --- | --- |
| HCM-LEARNING-001 | Creating a program and scheduling a session against it succeeds and the session lists under the program | `HCM-LEARNING-001 — training programs and sessions` |
| HCM-LEARNING-002 | Nominating an employee to a session creates an enrollment at `nominated` | `HCM-LEARNING-002 — nomination enrolls an employee at status "nominated"` |
| HCM-LEARNING-003 | Approving your own nomination is refused (422) even holding the approve grant, self-nominator or self-nominee | `HCM-LEARNING-003 — a nomination cannot be approved by the person nominated` |
| HCM-LEARNING-004 | A different approver can approve, then attendance and completion proceed in order | `HCM-LEARNING-004 — approval by someone else, then attendance and completion` |
| HCM-LEARNING-005 | Skipping straight to completion, or approving an already-rejected nomination, is refused (422) | `HCM-LEARNING-005 — completing a nomination that has not been approved or attended is refused` |
| HCM-LEARNING-006 | Completing a skills-linked program writes a real `CapabilityClaim` at the Assessed tier via the existing capability domain, not a shadow copy | `HCM-LEARNING-006 — completing a skills-linked program asserts a capability claim` |
| HCM-LEARNING-007 | Completing a certification-kind program auto-issues an unverified `Certification` with the right expiry and a `CERT-YYYY-NNNNN` code | `HCM-LEARNING-007 — completing a certification-kind program issues a Certification` |
| HCM-LEARNING-008 | A certification cannot be self-verified (422), even holding the approve grant; HR can verify it | `HCM-LEARNING-008 — a certification cannot be self-verified` |
| HCM-LEARNING-009 | The expiry ladder raises an exception at the correct rung and a same-day re-run is idempotent | `HCM-LEARNING-009 — the certification expiry ladder is idempotent per rung` |
| HCM-LEARNING-010 | An employee past their mandatory-training due window with no completion is flagged overdue, and the job raises an exception for it | `HCM-LEARNING-010 — mandatory training overdue detection` |
| HCM-LEARNING-011 | An IDP can be created with goals/mentor/review date and closed | `HCM-LEARNING-011 — individual development plans` |
| HCM-LEARNING-012 | Budget utilisation derives from completed-enrollment spend; a program id from another tenant (or a non-existent one) is 404, not 403 | `HCM-LEARNING-012 — training budgets and cross-tenant isolation` |
| HCM-LEARNING-013 | An own-scope grant (an `employee`-shaped role, or any fixture role scoped `@own`) never reaches another employee's record: nominating a colleague, approving/rejecting/attendance/completion, verifying a colleague's certification, reading or closing a colleague's IDP are all refused, and a bare list (no id filter) on enrollments/certifications/IDPs returns only the caller's own rows, never a colleague's | `HCM-LEARNING-013 — own-scope callers cannot act on a colleague's record` |

## What this does not do

- No skill-gap analysis or a recommendation engine — the catalogue and the
  enrollment workflow only.
- No LMS content hosting — `link`/`location` are references, not a player.
- Mandatory-rule `applicability` is a single keyword (`all`); it cannot yet
  target a grade or org unit — see "Wanted from the scaffold" below.
- Training-budget `spent` is not split by division even when a budget row
  names one — see below.
- No integration with payroll for training reimbursement or stipend; that is
  WS8 payrollops' ad-hoc pay line, referenced by id only if ever wired up.

## Wanted from the scaffold

- The `certifications` grant cell for `hr_ops_manager` is `VCEDA` with no
  explicit `approve` token (`apps/api/src/seed/grants.ts`), so only the
  chairman (superadmin) can currently verify a certification. Verification
  is gated on `certifications:approve` deliberately — a routine edit and a
  decision that turns a claim into a fact should not share a grant — but
  that means HR ops cannot verify certifications today. The fix is a matrix
  edit: `{ resource: 'certifications', cell: 'VCEDA,approve' }` for
  `hr_ops_manager`.
- No `RecordTypeCode` prefix exists for a training program, session or
  enrollment (`CERT` covers certifications only). None of those need one
  for this release — no screen refers to one by a printed code — but a
  future letter or report referring to "session TRN-2026-00042" would need
  one added to `packages/shared/src/domain.ts#RECORD_TYPE_CODES`.
- There is no reliable employee→division join available to this workstream's
  own tables (division lives on `OrgUnit`, reached only through
  `Position -> Assignment`, which this workstream does not query). A
  division-scoped `TrainingBudget`'s `spent` is therefore the whole
  financial year's spend, not that division's — recorded plainly in the web
  page's subtitle rather than silently wrong.
