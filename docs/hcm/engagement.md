# HCM — WS9 engagement

Announcements, recognition, pulse surveys, the HR helpdesk, policy
acknowledgements and exit interviews. Mounted at `/api/hcm/engagement`;
web at `/people/engagement` and `/me/home`.

## What exists now

### Models (`apps/api/prisma/schema/hcm-engagement.prisma`)

- `Announcement` + `AnnouncementAck` — audience-targeted (all/division/org-unit/location)
  broadcasts, optionally pinned, optionally acknowledgement-required.
- `Recognition` — peer-to-peer kudos with a badge, message and point value.
- `PulseSurvey` + `SurveyResponse` + `SurveyResponseDedupe` — pulse/eNPS
  surveys with `scale`/`text`/`enps` questions; `anonymous` surveys never
  store `employmentRelationshipId`, and `respondentToken` is always a plain
  random id, never derived from who answered. The one-way check that stops a
  second anonymous submission lives entirely in `SurveyResponseDedupe`, a
  table with no other column and no relation to `SurveyResponse` — so even a
  reader who could recompute the dedupe hash for every party id in the tenant
  (the salt is a source constant, not a secret) learns only "this person
  responded", never which row holds their answers.
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

Pulse surveys: `createPulseSurvey` (gated on `surveys:edit`, deliberately not
`create` — see Scope-axis review below), `openPulseSurvey`, `closePulseSurvey`,
`listPulseSurveys`, `submitSurveyResponse` (audience-checked; validates every
question is answered in range; always resolves the responder's own employment
server-side; the anonymous path records a one-way dedupe hash in
`SurveyResponseDedupe`, never on the response row itself), `pulseSurveyResults`
(aggregate only — never a per-respondent breakdown; free-text answers on an
anonymous survey are additionally withheld below `SURVEY_MIN_SAMPLE`
responses), `pendingSurveysForMe`.

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

### Scope-axis review (post-review fixes)

A cross-workstream review flagged a pattern: `assertCan({ resource, verb })`
called with no record (and no `scopeFor` check) on a resource an ordinary
employee holds `create`/`edit` on at some scope lets that employee act on
records that are not theirs, because the WHERE axis only ever runs against a
record that is supplied. Auditing every `assertCan`/`assertScopeAll` call in
this file against the grants matrix (`announcements: V@all`,
`recognitions: VC@own`, `surveys: VC@all`, `hr_cases: VC@own`,
`policy_documents: V@all`, `exit_interviews: -` for an ordinary employee):

- `giveRecognition` and `createHrCase` are both `create@own` self-service
  paths, but the record's owning field (`fromPartyId`, `raisedByPartyId`) is
  always hard-coded to `auth.partyId` — there is no field an employee's input
  can use to act as someone else. Safe as found.
- `createPulseSurvey` was checking `surveys:create` — the same verb the
  grants matrix gives an ordinary employee (at `all` scope, so an
  `assertScopeAll` check would not have caught this either) purely so
  `submitSurveyResponse` lets them answer a survey. Any employee could
  therefore define and open a company-wide survey. **Fixed**: creation now
  checks `surveys:edit`, the verb only a manager holds, matching how
  `openPulseSurvey`/`closePulseSurvey` are already gated. See
  HCM-ENGAGEMENT-014.
- `submitSurveyResponse` took a client-supplied `employmentRelationshipId`
  and wrote it straight onto a non-anonymous response — an employee holding
  `surveys:create@all` (all-scope, precisely because anyone can be asked to
  answer a company survey) could submit a response **as any other employee**,
  since there was no record yet for the WHERE axis to narrow against.
  **Fixed**: the parameter is gone from the function's signature and the
  route; the responder's own active `EmploymentRelationship` is always
  resolved server-side from `auth.partyId`. See HCM-ENGAGEMENT-015.
- Every other `create`/`edit` path in this file (`announcements`, `hr_cases`
  transitions/assignment, `policy_documents`, `exit_interviews`) is either
  restricted to a verb employees do not hold at all, or reaches a record
  through a function (`loadVisibleCase`, `assertScopeAll`) that already
  resolves scope against that record before acting. No further instances
  found.

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
GET  /surveys                             POST /surveys              (edit-gated)
POST /surveys/:id/open                    POST /surveys/:id/close
POST /surveys/:id/responses  { answers }  GET  /surveys/:id/results
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

`computeEnps` (promoters/passives/detractors + -100..100 score, `null` below
`SURVEY_MIN_SAMPLE` responses — the same k-anonymity floor
`commandCenter.ts` uses for unit-level capacity), `isHrCaseSlaBreached`/
`daysToSlaDue`, `validateSurveyAnswers`, `responseRate`, `inAudience`
(all/division/org-unit/location matching).

`inAudience`'s facts are resolved by `audienceFactsFor` in the domain layer —
division from the affiliation's org unit, **location from the affiliation's
`Position.location`** (an org unit carries no location of its own; the first
version of this read it off the org unit and so never matched a
location-targeted audience against anyone — fixed).

### Web

- `/people/engagement` (`apps/web/src/pages/hcm/Engagement.tsx`): tabs for
  Announcements, Recognition (+ leaderboard), Surveys (+ results), Helpdesk
  (general queue + a separately-revealed confidential queue), Policies (+
  acknowledgement status).
- `/me/home` (`apps/web/src/pages/me/Home.tsx`): pending acknowledgements,
  surveys to answer (each with an **Answer** action that renders the
  survey's actual questions and submits `POST /surveys/:id/responses`), my
  open cases, kudos received, announcements.

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
| HCM-ENGAGEMENT-009 | An anonymous survey accepts one response per employee (dedupe hash, never joinable to the response) and reports aggregates only | `Pulse surveys > 009` |
| HCM-ENGAGEMENT-014 | An employee's `surveys:create` (held only so they can answer) is refused when used to define a new survey | `Pulse surveys > 014` |
| HCM-ENGAGEMENT-015 | A named survey response is always recorded against the caller's own employment — there is no field left for a caller to override | `Pulse surveys > 015` |
| HCM-ENGAGEMENT-016 | A grievance is auto-confidential, absent from the general queue, visible only via the confidential listing to an all-scope holder or the raiser | `HR helpdesk > 016` |
| HCM-ENGAGEMENT-017 | A non-grievance case is in the general queue and follows status transitions, rejecting an invalid status | `HR helpdesk > 017` |
| HCM-ENGAGEMENT-018 | An employee cannot reach a colleague's case by id; a cross-tenant id is never found | `HR helpdesk > 018` |
| HCM-ENGAGEMENT-019 | A published policy's acknowledgement count is accurate and is an HR-only read | `Policy acknowledgement > 019` |

`npx vitest run src/tests/hcm/engagement.test.ts` — 15 passed.

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
