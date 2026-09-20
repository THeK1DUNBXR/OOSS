# HCM — recruiting (WS4)

A full applicant-tracking system built on top of the existing
Requisition/Application lifecycle machines in `packages/shared/src/hr.ts`
and `apps/api/src/domains/hiring.ts`. Nothing here re-derives a requisition
or an application — every model hangs off a `requisitionId` or
`applicationId`, and the candidate is a `Person` resolved through
`findOrCreatePerson` (`apps/api/src/domains/identity.ts`), the same identity
plane every other intake surface uses.

## What exists now

### Models (`apps/api/prisma/schema/hcm-recruiting.prisma`)

- `JobPosting` — `Draft → Published → Closed`, reopenable, against a
  `requisitionId`. Its own `slug` for an eventual public listing page.
- `CandidateProfile` — one row per `Person`, carrying `source`, `resumeText`,
  `currentCtc`/`expectedCtc` (Decimal, withheld — see Money below),
  `noticeDays`, `tags`.
- `InterviewRound` — `roundNo`, `kind` (phone/technical/hr/panel),
  `interviewerPartyIds` (JSON array of Person ids — the round's roster),
  `status` (Scheduled/Completed/Cancelled/NoShow), `outcome`
  (advance/reject/hold) set on completion.
- `InterviewScorecard` — one row per interviewer per round; a panel round
  never averages its panellists into one number.
- `OfferLetter` — `Draft → ApprovalPending → Approved → Sent → Accepted |
  Declined`, or `Rescinded` from any pre-terminal state. `ctc` withheld
  without the distinct `offers:financial` grant. Re-issuable: a rescinded
  offer's application can carry a second `OfferLetter` rather than
  resurrecting the first.
- `Referral` — `Submitted → Shortlisted → Hired → BonusPaid`, or `Rejected`
  from `Submitted`/`Shortlisted`.
- `BackgroundVerification` — against an `applicationId` and/or an
  `employmentId`; `Pending → InProgress → Completed` with a clear/adverse/
  pending outcome.
- `OnboardingTaskTemplate` / `OnboardingTask` — a reusable checklist
  (title, assignee role, due-offset-in-days) instantiated once per
  employment at joining time.

Only `JobPosting` (`JPST-`) and `OfferLetter` (`OFR-`) were given a
record-code series by the scaffold — see "Wanted from the scaffold" below
for why `CandidateProfile`, `Referral` and `BackgroundVerification` have no
`recordCode` column.

### Shared pure logic (`packages/shared/src/hcm/recruiting.ts`)

- `jobPostingMachine`, `offerMachine` — the two lifecycle diagrams this
  workstream owns, in the same `createMachine` shape as `hr.ts`'s eleven.
- `timeToHireDays` / `meanTimeToHireDays`, `offerAcceptanceRate`,
  `sourceEffectiveness` — pure funnel arithmetic, each returning `null`
  (never `0`) when there is nothing to compute from.
- `taskDueDate` — resolves a template's `dueOffsetDays` against a joining
  date.

### Endpoints (`/api/hcm/recruiting`)

- `GET/POST /job-postings`, `POST /job-postings/:id/transition`
- `GET/POST /candidates` (`?source=&q=`)
- `GET /applications/:applicationId/interviews`, `POST /interviews`,
  `POST /interviews/:id/complete`
- `GET/POST /interviews/:id/scorecards`
- `GET/POST /offers` (`?applicationId=&status=`),
  `POST /offers/:id/transition`
- `POST /applications/:id/join-and-onboard` — calls `hiring.ts`'s
  `joinFromApplication` unchanged, then instantiates the onboarding
  checklist for the new employment (idempotent per employment).
- `GET/POST /referrals`, `POST /referrals/:id/status`
- `GET/POST /background-verifications`, `PATCH /background-verifications/:id`
- `GET/POST /onboarding-templates`
- `GET /onboarding-tasks?employmentId=`, `POST /onboarding-tasks/instantiate`,
  `POST /onboarding-tasks/:id/complete`
- `GET /funnel` — mean time-to-hire, offer acceptance rate, source
  effectiveness; all-scope only (`assertScopeAll('applications')`).

### Web (`apps/web/src/pages/hcm/Recruiting.tsx`, `/people/recruiting`)

Eight tabs: **Pipeline** (a read-only kanban of `/hr/applications` by funnel
bucket, plus the funnel metrics and source-effectiveness table),
**Postings**, **Candidates** (search, create, CTC withheld inline),
**Interviews** (pick a schedulable application, round list, complete, and a
per-round scorecard panel), **Offers** (create, transition buttons driven by
`availableTransitions`, a "Join & onboard" action once Accepted),
**Referrals**, **BGV**, **Onboarding** (template management plus a
per-employment checklist lookup).

The page never re-implements a requisition or application transition —
those stay in People → Hiring; this page reads `/hr/requisitions` and
`/hr/applications` only for pickers and the pipeline board.

## Enforcement

- **Tenant scoping**: every read/write goes through the request-scoped
  `prisma` from `platform/context.ts`; a wrong-tenant id is a 404
  (`ApiError.notFound`), never a 403.
- **Grants**: every domain function opens with `assertCan({ resource, verb
  })` against the exact resources the scaffold registered
  (`job_postings`, `candidates`, `interviews`, `scorecards`, `offers`,
  `referrals`, `background_verifications`, `onboarding_tasks`); the funnel
  uses `assertScopeAll('applications')`.
- **Self-Dealing Bar**: `transitionOffer`'s `APPROVE` branch refuses when
  `offer.proposedByPartyId === auth.partyId`, unconditionally, the same
  shape as `approveSalaryStructure` in `compliance/payroll.ts` — checked
  *before* the state machine even runs, so a proposer who also holds
  `offers:approve` still cannot approve their own draft.
- **Events**: `kz.hr.job_posting.*`, `kz.hr.offer.*`,
  `kz.hr.candidate.created`, `kz.hr.interview.*`,
  `kz.hr.scorecard.submitted`, `kz.hr.referral.submitted`,
  `kz.hr.background_verification.completed`,
  `kz.hr.onboarding_task.completed` on every state change, via
  `platform/lifecycle.ts`'s `transition()` for the two machines and `emit()`
  directly elsewhere.
- **Record codes**: `nextRecordCode('JPST' | 'OFR')`, generator-assigned,
  never caller-supplied.
- **Money withheld**: `CandidateProfile.currentCtc/expectedCtc`,
  `OfferLetter.ctc` and `Referral.bonusAmount` come back `null` (never a
  masked non-null figure) for a viewer who holds the base resource grant but
  not the distinct `financial` verb — checked with `canSeeMoney()`, exactly
  the axis the platform names for this.
- **Built on Requisition/Application, not duplicated**: `createOffer`
  requires the application to be `Selected`; sending an offer drives the
  application's own `EXTEND_OFFER` event, and accepting/declining/rescinding
  drive `ACCEPT_OFFER`/`DECLINE_OFFER`/`RESCIND_OFFER` — the offer and the
  application move together as one fact, checked *before* the offer's own
  machine runs: if the application machine would refuse the paired event, the
  offer transition refuses with it rather than leaving an offer marked
  Sent/Accepted/Declined against an application that never followed. (RESCIND
  is the one exception — an offer rescinded before it was ever sent has no
  matching Application transition to take, so it is a no-op there rather than
  a refusal.) `joinAndOnboard` calls `hiring.ts`'s `joinFromApplication`
  verbatim rather than re-implementing the hire.
- **Offer expiry**: `ACCEPT` is refused once `validUntil` has passed — an
  expired offer cannot be turned into an acceptance by calling the endpoint
  late.
- **Referral integrity**: the referrer and the candidate can never resolve to
  the same `Person`. In practice identity resolution is the first line of
  defence — an existing employee's own affiliation carries a
  statutory-retention floor, so a referral naming them as "the candidate"
  raises `MERGE_CANDIDATE` (409) before a `Person` is ever handed back;
  `createReferral`'s own same-person check is the second line, for a match
  identity resolution would otherwise let through silently.
- **Background verification finality**: once `status` reaches `Completed`,
  `updateBackgroundVerification` refuses any further edit — a correction is a
  new check, not a rewrite of a closed one.
- **Own-scope narrowing** (the scope-axis pattern flagged across the HCM
  workstreams): `assertCan({ resource, verb })` with no `record` passes the
  WHERE axis unconditionally, so every own-scope self-service grant this
  workstream's `employee` role holds (`interviews:V@own`,
  `scorecards:VC@own`, `referrals:VC@own`, `onboarding_tasks:VE@own`) is
  narrowed by hand in the domain function itself, not left to `assertCan`
  alone: `listInterviewRounds` filters to rounds where the caller is the
  candidate or on the roster; `listScorecards` filters to the caller's own
  scorecard; `createReferral` refuses a `referrerEmploymentId` that is not
  the caller's own employment and `listReferrals` filters to the caller's own
  employments; `listOnboardingTasks`/`completeOnboardingTask` refuse (404) an
  employment that is not the caller's own, and `completeOnboardingTask`
  additionally requires the task's `assignee` to be `employee`.

## Acceptance

| ID | What PASS means | Test |
| --- | --- | --- |
| HCM-RECR-001 | A job posting follows Draft → Published → Closed and refuses to skip a state | `HCM-RECR-001` |
| HCM-RECR-002 | A candidate resolves through `findOrCreatePerson` (no duplicate Person/CandidateProfile), and CTC is withheld without the financial grant | `HCM-RECR-002` |
| HCM-RECR-003 | An interview round can only be scheduled while the application is Screening/Interviewing | `HCM-RECR-003` |
| HCM-RECR-004 | Only a roster interviewer may score a round, and only once | `HCM-RECR-004` |
| HCM-RECR-005 | An offer is approved by someone other than its proposer (finance_head) | `HCM-RECR-005` |
| HCM-RECR-006 | The Self-Dealing Bar refuses a proposer approving their own offer, even a chairman | `HCM-RECR-006` |
| HCM-RECR-007 | The offer machine refuses an out-of-order transition (Draft → Sent) | `HCM-RECR-007` |
| HCM-RECR-008 | Accepting an offer advances the Application to OfferAccepted; joining instantiates onboarding tasks exactly once | `HCM-RECR-008` |
| HCM-RECR-009 | A record id from another tenant is a 404 | `HCM-RECR-009` |
| HCM-RECR-010 | A referral follows Submitted → Shortlisted → Hired → BonusPaid and refuses to skip | `HCM-RECR-010` |
| HCM-RECR-011 | A background verification needs an application or employment, and records a Completed outcome | `HCM-RECR-011` |
| HCM-RECR-012 | The recruiting funnel is an all-scope aggregate, refused at narrower scope | `HCM-RECR-012` |
| HCM-RECR-013 | An own-scope grant (interviews/scorecards/referrals/onboarding_tasks) narrows to the caller's own record, never a colleague's | `HCM-RECR-013` |

Also covered without a dedicated ID (folded into the describe blocks above):
an offer past `validUntil` cannot be accepted (HCM-RECR-007's suite), a
referral cannot name the referrer as their own candidate and its bonus is
withheld without `referrals:financial` (HCM-RECR-010's suite), and a
`Completed` background verification outcome is final (HCM-RECR-011's suite).

Tests: `apps/api/src/tests/hcm/recruiting.test.ts` — 22 `it` blocks, all
passing against `kaizen_test_recruiting`.

## What this does not do

- Does not post a job to any external job board — `JobPosting.channel =
  'external'` is a label recorded here, not an integration.
- Does not compute or pay a referral bonus itself — `Referral.bonusAmount`
  is tracked to `BonusPaid`; the actual payout is payroll's ad-hoc line
  (WS7/WS8), referenced by this workstream's id only.
- Does not call out to a real background-check vendor — `vendor`/`checks`/
  `outcome` are recorded as reported, not verified against an API.
- Does not send an email or generate a PDF offer letter — `OfferLetter` is
  the system-of-record row; a document artefact is compliance/labour's
  `issueLetter` (already wired for the `appointment` letter on
  `OfferAccepted` in `hiring.ts`), not duplicated here.
- Does not gate `candidates:financial` or `offers:financial` to a specific
  role beyond what the scaffold's grant matrix already assigns
  (`finance_head` holds `offers:VXF,approve`; nobody currently holds
  `candidates:financial`, so `currentCtc`/`expectedCtc` come back withheld
  for every role including HR — see "Wanted from the scaffold").

## Wanted from the scaffold

- The record-code registry (`packages/shared/src/domain.ts`) allocated only
  `JPST` and `OFR` to this workstream (`CERT` went to WS6 learning's
  certifications). `CandidateProfile`, `Referral` and
  `BackgroundVerification` therefore have no `recordCode` column — a
  candidate is referred to by their `Person`'s own `PER-` code, and a
  referral/BGV row by its plain id. If a human-facing code is wanted for
  these later, the closest free letters would be `CAND`/`REF`/`BGV`.
- No role in `apps/api/src/seed/grants.ts` was given the distinct
  `candidates:financial` verb, so candidate CTC is withheld for every
  principal, `chairman` excepted. If HR is meant to see it while proposing
  an offer, `candidates` needs an `F` added to `hr_ops_manager`'s cell.
- No hook point exists for "an employment was created from an application"
  (`hooks.ts`'s registry stops at `offboarding.completed`), so onboarding
  tasks are instantiated by this workstream's own
  `POST /applications/:id/join-and-onboard` endpoint rather than firing
  automatically off `hiring.ts`'s `joinFromApplication`. A future
  `application.joined` hook point would let this run without a bespoke
  endpoint.
