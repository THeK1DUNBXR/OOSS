# Incidents, problems and changes

Workstream E of the Technology module (`docs/plan/cio.md`). `DataBreach`
already covers a personal-data breach; nothing before this covered an
outage, a root cause, or a change to production. This gives the desk a live
incident timeline, a place root cause lives once someone bothers to find it,
and a change process that runs the platform's own approval-gate shape
instead of a spreadsheet and a Slack thread.

---

## Model

**`ItIncident`** — a live outage. `title`, `severity` (`sev1` business-
stopping … `sev4` cosmetic), `affectedApplicationIds` (bare ids — resolved
against workstream B's `ItApplication` at the service layer, never a Prisma
relation), `commanderPartyId`, `impact`, `customerFacing`, `breachId` when
it is also a personal-data breach, `problemId` once linked. The timeline —
`detectedAt` / `acknowledgedAt` / `mitigatedAt` / `resolvedAt` / `closedAt`
— is five stamps, each **set once**: a second `acknowledge` is a 409, not a
silent overwrite (IT-INC-001). `reviewRequired` is computed at declare time
from the dated `ItItsmPolicy` row (`sev1`/`sev2` by default); when true, the
incident cannot reach `closed` without a published `reviewBody` — a
published review (`reviewPublishedAt` set) is final, and a further edit is
refused with a 409 (IT-INC-002).

**`ItIncidentUpdate`** — append-only: `body`, `authorPartyId`, `at`. Posting
one resets the incident's `staleNotifiedAt` marker.

**`ItProblem`** — the root cause an incident (or several) points back to.
`status` (`open → analysing → known_error|resolved → closed`, with
`REOPEN` from `resolved` back to `analysing`), `rootCause`, `knownError`,
`workaround`, `incidentIds` (bare ids — creating or updating a problem with
`incidentIds` also stamps each of those incidents' `problemId`).

**`ItChange`** — `title`, `kind` (`standard | normal | emergency`), `risk`
(`low | medium | high`), `affectedApplicationIds`, `plan`, `rollbackPlan`,
`windowStart`/`windowEnd`, `requesterPartyId` (also the approval gate's
`ownerPartyId` — the Self-Dealing Bar). `status`: `draft → submitted →
approved → scheduled → implemented → reviewed | failed | rolled_back`, plus
`rejected` from `submitted`. `implementationNote` and `reviewNote` are each
set once, required on the `IMPLEMENT`/`REVIEW` transition that sets them.

**`ItChangeFreeze`** — `name`, `startsAt`/`endsAt`, `reason`,
`allowEmergency`. Scheduling a change inside a freeze's window is refused,
naming the freeze, unless the change is `emergency` **and** the freeze says
`allowEmergency: true`.

**`ItItsmPolicy`** — one dated row per tenant (Principle 4): `staleMinutes`
(default 60), `reviewOverdueDays` (default 5), `reviewRequiredSeverities`
(default `['sev1','sev2']`). Never a constant in job or domain code.

---

## The approval gate

`submitted → approved` on a `normal` or `emergency` change runs
`evaluateApprovalGate('POL-IT-CHANGE-APPROVAL', { type: 'it_change',
ownerPartyId: requesterPartyId, commercialValue: null, ... }, 'it_change.approve')`
— the identical shape `domains/agreements.ts` runs for a contract. A
`standard` change skips the gate entirely: `SUBMIT` auto-applies `APPROVE`
(policy applying itself, not a person deciding), so it is never asked to
hold an `approve` grant it does not have.

Bootstrap seeds every approval-gate policy, including
`POL-IT-CHANGE-APPROVAL`, with one generic version-1 content shared across
all eight gates (legacy `business_head`/`director`/`chairman` placeholder
roles). This workstream's seed adds a **version 2** naming the real chain —
`['hr_ops_manager', 'chairman']` — which `evaluateApprovalGate`'s
`loadPolicy` picks up automatically (it always reads the highest version
number). No `AuthorityGrant` ceiling is seeded: the gate's "actor is the
resolved-tier approver" rule already permits a non-self-dealing
`hr_ops_manager` (Operations Head) directly, since tier 0 of the chain names
that role, and seeding a ceiling here would race `seedFoundingAccounts`
(bootstrap calls it immediately after `seedIt`, before any `hr_ops_manager`
affiliation exists to grant it to).

`platform/lifecycle.transition` composes its event name as
`kz.hr.<object>.<verb>` unconditionally — an HR-domain helper despite the
generic module name. A `kz.hr.it.*` name fails the canonical
`kz.<domain>.<entity>.<verb>` grammar, so this workstream's transitions use
a local `checkedTransition` helper in `domains/it/itsm.ts` doing the same
five things (grant check, ask the machine, audit) and emits its own
correctly-named `kz.it.*` event.

---

## Lifecycle machines (`packages/shared/src/it/itsm.ts`, pure)

- `itIncidentMachine`: `declared → acknowledged → mitigated → resolved →
  closed`.
- `itProblemMachine`: `open → analysing → known_error|resolved → closed`,
  with `REOPEN` from `resolved`.
- `itChangeMachine`: `draft → submitted → approved → scheduled →
  implemented → reviewed | failed | rolled_back`, plus `rejected` from
  `submitted`.

Each detail endpoint exposes `availableTransitions` (filtered further for
incidents: `CLOSE` is withheld from the list while a required review is
unpublished, even though the machine itself would allow it) so a screen can
never render a button the API would refuse.

## Pure arithmetic

- `mttrMinutes(rows)` — mean minutes from `detectedAt` to `resolvedAt`,
  over resolved incidents only; `null` with none.
- `changeSuccessRate(rows)` — the fraction of changes counted among
  `reviewed | failed | rolled_back` that are `reviewed`; `null` with no
  counted rows (a change still `draft`/`scheduled` says nothing about
  success yet).
- `isInFreeze(freezes, at, kind)` — the freeze covering `at`, or `null`; an
  `emergency` change passes through a freeze that declares
  `allowEmergency`, every other kind is blocked by any freeze covering the
  moment.

---

## Domain (`apps/api/src/domains/it/itsm.ts`)

Incidents: `declareIncident`, `listIncidents(filter)`, `incidentDetail(id)`,
`transitionIncident(id, event, note?)`, `postIncidentUpdate(id, body)`,
`submitIncidentReview(id, { reviewBody, publish? })`, `incidentSummary()`.

Problems: `createProblem`, `listProblems(status?)`, `problemDetail(id)`,
`updateProblem(id, patch)`, `transitionProblem(id, event, note?)`.

Changes: `createChange`, `listChanges(filter)` (scoped for `it_changes:
VC@own` — an employee's own changes only, `requesterPartyId` mapped as the
owning field), `changeDetail(id)`, `transitionChange(id, { event, note? })`
(returns `{ applied, change, approvalStepId, resolvedApproverRole,
resolutionTier, selfDealingBarTripped, reason }` — `applied: false` when a
privileged `APPROVE` opened a step instead of landing, the same shape
`transitionAgreement` returns), `declareFreeze`, `listFreezes`,
`changeSummary()`.

Every write: `assertCan` on entry, a record code from `nextRecordCode`
(`INC` / `PRB` / `CHG`), `auditWrite`, and a `kz.it.*` event on every state
change (`IT_INCIDENT_DECLARED/_TRANSITIONED/_REVIEW_PUBLISHED`,
`IT_PROBLEM_CREATED/_TRANSITIONED`, `IT_CHANGE_CREATED/_TRANSITIONED`,
`IT_CHANGE_FREEZE_DECLARED`).

## Routes (mounted at `/api/it/`)

`GET|POST /incidents`, `GET /incidents/summary`, `GET /incidents/:id`,
`POST /incidents/:id/transition`, `POST /incidents/:id/updates`, `POST
/incidents/:id/review`.

`GET|POST /problems`, `GET|PATCH /problems/:id`, `POST
/problems/:id/transition`.

`GET|POST /changes` (`?status=`, `?mine=true`), `GET /changes/summary`,
`GET|POST /changes/freezes`, `GET /changes/:id`, `POST
/changes/:id/transition`.

### Summary shapes

`GET /it/incidents/summary`:
```json
{
  "notYetMeasured": false,
  "openBySeverity": { "sev1": 0, "sev2": 1, "sev3": 2, "sev4": 0 },
  "mttrMinutes30d": 42.5,
  "customerFacingOpen": 1,
  "reviewsOutstanding": 0
}
```
`mttrMinutes30d` is `null`, not `0`, when no incident resolved in the last
30 days. `notYetMeasured: true` (with every other field zeroed) only when
the tenant has no incidents at all.

`GET /it/changes/summary`:
```json
{
  "notYetMeasured": false,
  "awaitingApproval": 2,
  "scheduledThisWeek": 1,
  "successRate90d": 0.75,
  "freezeInForce": { "name": "Quarter close freeze", "until": "2026-10-05T00:00:00.000Z" }
}
```
`successRate90d` is `null` with no change reaching `reviewed | failed |
rolled_back` in 90 days. `freezeInForce` is `null` when no freeze covers
the current moment (computed against `kind: 'normal'`, so it reports the
freeze a normal change would hit right now).

## Jobs (`apps/api/src/jobs/it/itsm.ts`, exported in `JOBS`)

Three one-shot detectors — each condition is binary, so idempotence is a
single marker column rather than a ladder of rungs:

- `runItsmStaleIncidentJob` (every 15 min) — an open `sev1`/`sev2` with no
  `ItIncidentUpdate` and no transition in `staleMinutes` raises
  `IT_INCIDENT_STALE` on the commander. `staleNotifiedAt` is cleared by the
  next update or transition, so a fresh sign of life re-arms the detector.
- `runItsmReviewOverdueJob` (daily, 07:00) — a `sev1`/`sev2` resolved
  without a published review after `reviewOverdueDays` raises
  `IT_INCIDENT_REVIEW_OVERDUE` on the commander; cleared by publishing.
- `runItsmChangeWindowMissedJob` (hourly) — an `approved`/`scheduled`
  change whose `windowEnd` has passed without reaching `implemented` raises
  `IT_CHANGE_WINDOW_MISSED` on the requester.

## Seed (`apps/api/src/seed/it/itsm.ts`, `seedItsm`)

Idempotent: the `ItItsmPolicy` row (upserted by `tenantId`), and version 2
of `POL-IT-CHANGE-APPROVAL` (created once, skipped on a re-run since
`loadPolicy` already reads the newest version).

## What this does not do

It does not page anyone, does not detect an outage on its own (declaring is
typed in), and does not run the change itself — `implementationNote` is
what a person reports happened, not a deployment log the platform captured.

---

## Acceptance

| ID | Test |
|---|---|
| IT-INC-001 | `IT-INC-001: timeline stamps are set once; a second acknowledge is a 409` |
| IT-INC-002 | `IT-INC-002: a sev1 cannot close without a published review, and a published review is final` |
| IT-CHG-001 | `IT-CHG-001: a normal change one raised cannot be approved by its raiser, while a standard change needs no step` |
| IT-CHG-002 | `IT-CHG-002: scheduling inside a freeze window is refused with the window named; emergency passes when the freeze allows it` |
| IT-CHG-003 | `IT-CHG-003: changeSuccessRate counts only reviewed/failed/rolled_back and is null with none` |

Plus: `mttrMinutes` and `isInFreeze` pure-arithmetic tests; a problem
opened from an incident, carried through its lifecycle, and linked back;
`listIncidents` filtering; the Finance Head denied on `it_incidents:create`
and `it_changes:create` (view-only); an employee seeing only their own
changes while the Operations Head sees all; implementation/review notes
set once each; and the three jobs' idempotence across two runs.

```
Test Files  1 passed (1)
     Tests  19 passed (19)
```
