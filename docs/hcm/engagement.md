# HCM — WS9 engagement

Announcements, recognition, pulse surveys, the HR helpdesk, policy
acknowledgements and exit interviews. Mounted at `/api/hcm/engagement`;
web at `/people/engagement` and `/me/home`.

## What exists now

### Models (`apps/api/prisma/schema/hcm-engagement.prisma`)

- `Announcement` + `AnnouncementAck` — audience-targeted (all/division/org-unit/location)
  broadcasts, optionally pinned, optionally acknowledgement-required.
- `Recognition` — peer-to-peer kudos with a badge, message and point value.
- `PulseSurvey` + `SurveyResponse` — pulse/eNPS surveys with `scale`/`text`/`enps`
  questions; `anonymous` surveys never store `employmentRelationshipId`, only a
  salted, non-reversible `respondentToken` that stops a second submission.
- `HrCase` + `HrCaseMessage` — the HR helpdesk ticket and its conversation.
  `confidential` is forced `true` for every `grievance` case (and settable on
  any other category) — see Concealment below.
- `PolicyDocument` + `PolicyAcknowledgement` — versioned company policies;
  publishing a new version under the same title supersedes the prior one.
- `ExitInterview` — questionnaire + themes against an offboarding, referenced
  by id only (WS10 owns `Offboarding`).

### Domain (`apps/api/src/domains/hcm/engagement.ts`)

Announcements: `createAnnouncement`, `publishAnnouncement`,
`withdrawAnnouncement`, `listAnnouncements`, `acknowledgeAnnouncement`,
`announcementAcks`.

Recognition: `giveRecognition` (refuses self-recognition), `listRecognitions`,
`recognitionLeaderboard` (all-scope aggregate).

Pulse surveys: `createPulseSurvey`, `openPulseSurvey`, `closePulseSurvey`,
`listPulseSurveys`, `submitSurveyResponse` (validates every question is
answered in range; anonymous path hashes identity into a token), `pulseSurveyResults`
(aggregate only — never a per-respondent breakdown, anonymous or not),
`pendingSurveysForMe`.

HR helpdesk: `createHrCase`, `listHrCases`, `listConfidentialHrCases`,
`getHrCase`, `addHrCaseMessage`, `assignHrCase`, `transitionHrCase`,
`runHrCaseSlaCheck` (job).

Policies: `createPolicyDocument`, `publishPolicyDocument`,
`listPolicyDocuments`, `acknowledgePolicyDocument`, `policyAckStatus`,
`pendingPolicyAcksForMe`.

Exit interviews: `createExitInterview`, `listExitInterviews`,
`exitInterviewThemeSummary`.

Home: `myEngagementHome` — announcements, kudos received, my open cases,
pending acknowledgements (announcements + policies), surveys to answer.

### Concealment — the confidential-grievance rule

`HrCase.confidential` follows the exact pattern `PoshComplaint.concealed`
uses in `domains/compliance/labour.ts`: the field is checked explicitly by
the domain layer, never inferred.

- `createHrCase` forces `confidential = true` whenever `category === 'grievance'`.
- `listHrCases` (the general queue) **excludes every confidential case**, for
  every viewer, including the HR ops manager — `WHERE confidential = false`,
  unconditionally, for an all-scope viewer. An own-scope viewer (an ordinary
  employee) sees only cases they raised, confidential or not.
- `listConfidentialHrCases` is a **separate function**, gated by
  `assertScopeAll('hr_cases', 'view')`, and is the only path to a confidential
  case for anyone but its raiser or assignee. There is no code path from the
  general queue or its counts into this list — reaching it takes the explicit
  call and the grant, never a wider aggregate that happens to include it.
- `getHrCase`/`addHrCaseMessage`/`transitionHrCase` return **404, not 403**,
  to a caller who is neither the case's raiser/assignee nor an all-scope
  holder — whether the case exists is itself part of what a concealed case
  withholds.
- The SLA-breach job (`runHrCaseSlaCheck`) still runs over confidential cases
  (an unresolved grievance's SLA still matters), but the exception and event
  it raises carry only the record code, never the category or subject — and
  the event's `confidentiality` is set to `restricted`.

### Routes (`apps/api/src/routes/hcm/engagement.routes.ts`)

```
GET  /_status
GET  /announcements                       POST /announcements
POST /announcements/:id/publish           POST /announcements/:id/withdraw
POST /announcements/:id/ack               GET  /announcements/:id/acks
GET  /recognitions                        POST /recognitions
GET  /recognitions/leaderboard
GET  /surveys                             POST /surveys
POST /surveys/:id/open                    POST /surveys/:id/close
POST /surveys/:id/responses               GET  /surveys/:id/results
GET  /hr-cases                            GET  /hr-cases/confidential
POST /hr-cases                            GET  /hr-cases/:id
POST /hr-cases/:id/messages               POST /hr-cases/:id/assign
POST /hr-cases/:id/transition
GET  /policies                            POST /policies
POST /policies/:id/publish                POST /policies/:id/ack
GET  /policies/:id/status
GET  /exit-interviews                     GET  /exit-interviews/themes
POST /exit-interviews
GET  /me/home
```

### Jobs (`apps/api/src/jobs/hcm/engagement.ts`)

`hcm_engagement_hr_case_sla_check` (hourly) — `runHrCaseSlaCheck`: any case
still open past `slaDueAt` raises `HCM_HR_CASE_SLA_BREACHED` on its assignee
(or the resolved HR ops owner) and emits `kz.hr.hr_case.sla_breached_detected`.
**Not wired into `jobs/scheduler.ts`** — see "Wanted from the scaffold" below.

### Pure logic (`packages/shared/src/hcm/engagement.ts`)

`computeEnps` (promoters/passives/detractors + -100..100 score),
`isHrCaseSlaBreached`/`daysToSlaDue`, `validateSurveyAnswers`, `responseRate`,
`inAudience` (all/division/org-unit/location matching).

### Web

- `/people/engagement` (`apps/web/src/pages/hcm/Engagement.tsx`): tabs for
  Announcements, Recognition (+ leaderboard), Surveys (+ results), Helpdesk
  (general queue + a separately-revealed confidential queue), Policies (+
  acknowledgement status).
- `/me/home` (`apps/web/src/pages/me/Home.tsx`): pending acknowledgements,
  surveys to answer, my open cases, kudos received, announcements.

## Acceptance

| ID | What PASS means | Test |
| --- | --- | --- |
| HCM-ENGAGEMENT-001 | eNPS classifies 9-10 as promoters, 0-6 as detractors, and scores `(%promoters - %detractors)` | `Pure logic > 001` |
| HCM-ENGAGEMENT-002 | An HR case is SLA-breached only while still open past its due date; resolved/closed never counts | `Pure logic > 002` |
| HCM-ENGAGEMENT-003 | HR publishes an announcement; it reaches an employee's feed and pending-ack list, and disappears from pending once acked | `Announcements > 003` |
| HCM-ENGAGEMENT-004 | An employee cannot create an announcement (no `create` grant) | `Announcements > 004` |
| HCM-ENGAGEMENT-005 | A draft, future-dated announcement never appears in an employee's feed | `Announcements > 005` |
| HCM-ENGAGEMENT-006 | An employee can give/receive recognition; giving it to oneself is refused | `Recognition > 006` |
| HCM-ENGAGEMENT-007 | The recognition leaderboard is an all-scope aggregate; an employee cannot pull it | `Recognition > 007` |
| HCM-ENGAGEMENT-008 | An employee's recognition list never includes a colleague-to-colleague entry | `Recognition > 008` |
| HCM-ENGAGEMENT-009 | An anonymous survey accepts one response per employee (hashed token) and reports aggregates only | `Pulse surveys > 009` |
| HCM-ENGAGEMENT-010 | A grievance is auto-confidential, absent from the general queue, visible only via the confidential listing to an all-scope holder or the raiser | `HR helpdesk > 010` |
| HCM-ENGAGEMENT-011 | A non-grievance case is in the general queue and follows status transitions, rejecting an invalid status | `HR helpdesk > 011` |
| HCM-ENGAGEMENT-012 | An employee cannot reach a colleague's case by id; a cross-tenant id is never found | `HR helpdesk > 012` |
| HCM-ENGAGEMENT-013 | A published policy's acknowledgement count is accurate and is an HR-only read | `Policy acknowledgement > 013` |

`npx vitest run src/tests/hcm/engagement.test.ts` — 13 passed.

## What this does not do

- No directory/person picker in the web recognition form yet — the recipient
  is entered as a raw party id until WS1's directory ships.
- No org-unit/division/location picker for audience targeting — the API
  accepts the ids/codes; a picker UI is left for integration once WS1's
  org-design surfaces exist.
- `ExitInterview` is created directly by HR; there is no trigger wired from
  WS10's offboarding lifecycle (WS10 owns that machine) — the endpoint exists
  and is ready to be called from there.
- eNPS/survey results are aggregate-only by design — no per-respondent
  export, even to HR, on a non-anonymous survey.
- No email/push delivery for announcements or SLA notifications — everything
  rides the existing in-app `notify`/exception path.

## Wanted from the scaffold

- **Job registration**: `apps/api/src/jobs/hcm/engagement.ts` exports `JOBS:
  JobDefinition[]`, following the exact shape `jobs/compliance/index.ts` uses
  for `COMPLIANCE_JOBS`. `jobs/scheduler.ts` is off-limits to this
  workstream; the integrator should add `import { JOBS as engagement } from
  './hcm/engagement.js';` and splice `...engagement` into `ALL_JOBS` the same
  way `...COMPLIANCE_JOBS` is spliced in today.
- **Record-code prefixes**: `Announcement`, `Recognition`, `PulseSurvey`,
  `PolicyDocument` and `ExitInterview` have no reserved entry in
  `packages/shared/src/domain.ts`'s `RECORD_TYPE_CODES` (only `CASE` for
  `HrCase` was reserved for this workstream). Rather than edit a shared,
  cross-workstream file, they use their own `ENG:<code>` sequence via
  `recordSequence` (mirroring `nextLabourNumber` in
  `compliance/labour.ts`), producing `ANN-YYYY-NNNNN`,
  `REC-YYYY-NNNNN`, `SUR-YYYY-NNNNN`, `POL-YYYY-NNNNN`, `EXI-YYYY-NNNNN`. If
  the platform later wants these in the closed `RECORD_TYPE_CODES` union, a
  one-line addition there plus a switch to `nextRecordCode` would tighten the
  type (currently they are validated only by the format, not the closed enum).
