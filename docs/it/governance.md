# Technology — security and governance

The IT risk register, policy documents staff acknowledge, a control library
mapped to frameworks, access-review campaigns with a self-review bar, and
security findings with severity-driven remediation SLAs
(`docs/plan/cio.md`, workstream F). Before this, the platform had MFA policy,
backups and a privacy access review; nothing scored an IT risk, published a
policy staff sign off on, tracked a control's test history, or gave a
security finding a due date derived from anything but memory.

---

## Model

**`ItRiskScoringBand`** — a dated table: `setId` groups every row of one
version of the band set (all sharing an `effectiveFrom`); each row says the
`band` (`low` | `medium` | `high` | `critical`) a score of at least
`minScore` falls into. `riskScore(likelihood, impact)` and `riskBandFor(score,
bands)` (`packages/shared/src/it/governance.ts`) are pure — no database — and
`bandSetInForce(bands, at)` resolves which set is current as of a date.

**`ItRisk`** — title, category, owner, inherent likelihood/impact (1–5) with
their score and band, optional residual likelihood/impact/score/band once
treatment is in place, `scoredUnderBandSetId` naming which band set produced
the *most recent* score, treatment (`accept` | `mitigate` | `transfer` |
`avoid`) with a plan, a review due date, `controlIds` (bare ids of
`ItControl` rows), and status `open → treating → accepted → closed` (with a
`REOPEN` back to `open`), run through `riskMachine`.

**`ItPolicyDocument`** — `code` + `version` (unique together), `title`,
`body`, status `draft → published → superseded | retired`, `drafterPartyId`,
`appliesToRoleSlugs` (empty means everyone), `reacknowledgeMonths`,
`publishedAt`/`publishedById`, `supersedesId`. A **published row is
immutable** — nothing in this workstream's domain code ever writes `body` or
`title` on a published row; a change is `newVersionOf`, which opens a new
`draft` at `version + 1` under the same code, and publishing it marks the row
named by `supersedesId` `superseded`.

**`ItPolicyAcknowledgement`** — append-only: `policyId`, `version`,
`partyId`, `acknowledgedAt`, unique per `(policyId, partyId, version)`.
`it_policy_acknowledgements:C@own` — `acknowledgePolicy` always writes under
the *caller's own* `partyId`, regardless of how wide a grant's scope is; there
is no argument that lets one party acknowledge on another's behalf.

**`ItControl`** — `code`, `title`, `frameworkRefs` (`Json`, e.g.
`[{"framework":"ISO27001","ref":"A.8.1"}]`), owner, `frequencyDays`,
`lastTestedAt`/`lastResult` (a **projection** of the latest `ItControlTest`
row — never written except by `recordTest`), `evidenceDocumentId`, status
(`active` | `retired`), `testOverdueNotifiedAt` (cleared by every fresh test,
so the overdue detector always re-arms).

**`ItControlTest`** — append-only test log: `controlId`, `testedAt`, `result`
(`pass` | `fail` | `partial`), `testerPartyId`, `notes`, `evidenceDocumentId`.

**`ItAccessReview`** — a campaign: `name`, `scope` (`all` | `role` |
`application`), `scopeRef`, `dueAt`, status `open → in_progress → closed`,
`openedById`, `closedAt`, `overdueNotifiedAt` (set once the overdue detector
has raised for this campaign, so a re-run raises nothing new). Opening
materialises one **`ItAccessReviewItem`**
per active `Affiliation` in scope (narrowed by `roleSlug` for a `role`
campaign; an `application` campaign reviews the same population as `all`,
tagged with the application id under review — there is no per-application
access grant in `main.prisma` to enumerate instead, and the screen and this
document say so rather than pretending otherwise, per Principle 7).

**`ItAccessReviewItem`** — `partyId`, `affiliationId`, a `roleSlug` **snapshot**
at materialisation time, `applicationId`, `reviewerPartyId`, `decision`
(`keep` | `revoke` | `modify`), `decidedAt`, `note`. A reviewer whose
`partyId` equals the item's `partyId` is refused with the self-review bar
named in the error (**IT-ACR-001**). A `revoke` decision raises
`IT_ACR_REVOKE_REQUESTED` for the Operations Head to act on — it never edits
the `Affiliation` itself, which belongs to `main.prisma`, outside this
workstream's files.

**`ItRemediationRule`** — a dated table: `severity` → `days`, `effectiveFrom`.
`remediationDueAt(createdAt, severity, rules)` is pure and picks the rule in
force *at `createdAt`*, never the latest one — a later tightening never
rewrites an already-open finding's due date.

**`ItSecurityFinding`** — `title`, `source` (`pentest` | `scan` | `audit` |
`internal`), `severity` (`critical` | `high` | `medium` | `low`), optional
`cvss`, `applicationId`/`assetId` (bare ids), `dueAt` (computed once at
creation), status `open → in_progress → fixed → verified` or
`→ risk_accepted` (with a `REOPEN` back to `in_progress` from `fixed` or
`risk_accepted`), `changeId`, `overdueNotifiedRungs`.

### Lifecycle machines

Four machines live in `packages/shared/src/it/governance.ts` (`riskMachine`,
`policyMachine`, `findingMachine`, `accessReviewMachine`), each a pure
`Transitions` table the same shape as `packages/shared/src/hr.ts`'s eleven.
The domain layer applies them **inline** (`machine.can`/`machine.apply`,
mirroring `domains/it/assets.ts`'s `transitionAsset`) rather than through
`platform/lifecycle.ts`'s generic `transition()` helper, the pattern
established before `packages/shared/src/permissions.ts`'s `RESOURCES` tuple
listed this workstream's resources. Every detail endpoint still returns
`availableTransitions` from
`platform/lifecycle.ts`'s `availableTransitions(machine, state)` (which is
not resource-typed), so a screen can never render a dead button.

---

## Domain (`apps/api/src/domains/it/governance/{risks,policies,controls,accessReviews,findings}.ts`)

Re-exported from `apps/api/src/domains/it/governance.ts`.

**Risks** — `createRisk`, `updateRisk` (edits descriptive fields; passing
`likelihoodResidual`/`impactResidual` rescores the residual band against the
band set in force *now*), `listRisks`/`riskDetail`, `transitionRisk`,
`scoreAgainstBands` (throws if no band set has ever taken effect — a risk
with no band is a seed defect, never a silent constant), `risksSummary`.

**Policies** — `createPolicyDraft`, `updatePolicyDraft` (refuses once
published), `listPolicies`/`policyDetail` (carries `acknowledgedByMe` for the
caller; a caller who lacks `it_policies:edit` — checked with a non-throwing
`evaluate`, not `assertCan`, so the base `view` grant is untouched — never
sees a `draft` row: `listPolicies` drops drafts from the result and from any
`status: 'draft'` filter rather than erroring, and `policyDetail` answers
`404` for one, the same as a record outside scope), `publishPolicy` (runs
`evaluateApprovalGate('POL-IT-POLICY-PUBLISH', { type: 'it_policy', resource:
'it_policies', ownerPartyId: drafterPartyId, ... })` — the drafter never
publishes their own draft; see *Publication and the approval gate*, below,
for how a later call finishes the write once the gate's step is approved),
`newVersionOf`, `retirePolicy`, `acknowledgePolicy`, `policiesAwaitingCaller`
(published policies the caller has not yet acknowledged at the current
version, filtered by `appliesToRoleSlugs` — the My IT page in another
workstream calls this), `acknowledgementsFor` (gated on `it_policies:E`),
`publishedPolicyAudiences` (the target-audience computation shared by the
summary and the re-acknowledgement job, so the two never disagree),
`policiesSummary`.

**Controls** — `createControl`, `updateControl`, `listControls`/
`controlDetail`, `recordTest` (writes the append-only test row and projects
`lastTestedAt`/`lastResult`/clears `testOverdueNotifiedAt` onto the control),
`controlsSummary`.

**Access reviews** — `openCampaign` (materialises items), `listCampaigns`
(with `itemCount`/`decidedCount`), `campaignDetail`, `decideItem` (the
self-review bar; a `revoke` decision raises an exception; the campaign
auto-advances `open → in_progress` on its first decision), `closeCampaign`
(refuses while any item is undecided), `runCampaignOverdueDetector`,
`accessReviewsSummary`.

**Findings** — `createFinding` (computes `dueAt` from the remediation rules
in force today), `updateFinding`, `listFindings`/`findingDetail`,
`transitionFinding`, `runFindingOverdueLadder`, `findingsSummary`.

`resolveOpsHeadPartyId` (in `risks.ts`, imported by the other four files) —
the same data-driven owner resolution `domains/compliance/calendar.ts` and
`domains/it/assets.ts` use: the active `Affiliation` carrying
`hr_ops_manager`, never a role-slug branch in a conditional.

Every entry point calls `assertCan`; every write calls `auditWrite`; every
create and every state change emits the matching `IT_RISK_*`/`IT_POLICY_*`/
`IT_CONTROL_*`/`IT_ACCESS_REVIEW_*`/`IT_FINDING_*` event from
`packages/shared/src/events.ts`; every register row (risk, policy, control,
campaign, finding) gets a record code (`ITR`, `ITP`, `CTL`, `ACR`, `FND`).

---

## Seed (`apps/api/src/seed/it/governance.ts`, `seedGovernance`)

Idempotent, run from `seed/it/index.ts` → `seedBootstrap`:

- **Risk scoring bands** — one set (`setId: 'v1'`), `effectiveFrom` 2020-01-01:
  `low` ≥ 1, `medium` ≥ 6, `high` ≥ 12, `critical` ≥ 20 (scores range 1–25).
- **Remediation SLA** — `critical` 7 days, `high` 30, `medium` 90, `low` 180,
  effective 2020-01-01.
- **Control library** — 13 ISO 27001 Annex A (2022) controls: access control
  policy, cloud services security, ICT continuity readiness, endpoint
  devices, privileged access, malware protection, backup, logging,
  monitoring, vulnerability management, supplier relationships, incident
  management planning, and secure development life cycle — upserted by
  `code`, owned by the Operations Head.
- **Three policy drafts** — Acceptable use, Password & MFA, and BYOD &
  remote work, each with a real one-paragraph body in the house voice.
  Created once (by `code`) and never overwritten — a real edit to a seeded
  draft is not silently reverted by re-running the seed.

---

## Jobs (`apps/api/src/jobs/it/governance.ts`)

All daily, staggered five minutes apart so they never race the same tenant:

| Job | What |
|---|---|
| `runRiskReviewJob` | Risk review overdue ladder (`GOVERNANCE_LADDER_RUNGS`: 30/7/1/0/-1/-7 days), rung recorded on `reviewNotifiedRungs`. |
| `runFindingOverdueJob` | Finding remediation overdue, severity-scaled rungs (`FINDING_LADDER_RUNGS`), rung recorded on `overdueNotifiedRungs`. |
| `runControlTestOverdueJob` | A control past `frequencyDays` since its last test (or since creation, if never tested) raises once per overdue window — `testOverdueNotifiedAt` gates re-firing, and `recordTest` clears it. |
| `runPolicyReacknowledgementJob` | Per published policy whose `reacknowledgeMonths` window has elapsed since `publishedAt`, **one** exception naming how many of the target audience still owe a re-acknowledgement — never one per person. |
| `runAccessReviewOverdueJob` | A campaign still `open`/`in_progress` past its `dueAt` raises `IT_ACR_CAMPAIGN_OVERDUE` once, gated on `overdueNotifiedAt` (a plain flag, not a ladder — this detector has one crossing to notice, not several rungs). |

Every ladder is idempotent per rung/window, the same shape the compliance
calendar's daily job uses.

---

## Routes (mounted at `/api/it/`)

`GET/POST /risks`, `GET /risks/summary`, `GET/PATCH /risks/:id`, `POST
/risks/:id/transition`.

`GET/POST /policies`, `GET /policies/summary`, `GET /policies/awaiting`,
`GET/PATCH /policies/:id`, `POST /policies/:id/publish`, `POST
/policies/:id/new-version`, `POST /policies/:id/retire`, `POST
/policies/:id/acknowledge`, `GET /policies/:id/acknowledgements`.

`GET/POST /controls`, `GET /controls/summary`, `GET/PATCH /controls/:id`,
`POST /controls/:id/test`.

`GET/POST /access-reviews`, `GET /access-reviews/summary`, `GET
/access-reviews/:id`, `POST /access-reviews/:id/items/:itemId/decide`, `POST
/access-reviews/:id/close`.

`GET/POST /findings`, `GET /findings/summary`, `GET/PATCH /findings/:id`,
`POST /findings/:id/transition`.

### Summary shapes

```
GET /it/risks/summary
{ notYetMeasured, total, byBand: { low, medium, high, critical }, open, reviewsOverdue }

GET /it/policies/summary
{ notYetMeasured, published, drafts, acknowledgementRate: number | null }

GET /it/controls/summary
{ notYetMeasured, active, testedInPeriod, failing, overdue }

GET /it/access-reviews/summary
{ notYetMeasured, open, inProgress, closed, overdue }

GET /it/findings/summary
{ notYetMeasured, openBySeverity: { critical, high, medium, low }, overdue }
```

`acknowledgementRate` is `null` — not `0` — when nothing is published, per
`acknowledgementRate(acknowledged, target)` in the shared arithmetic.

---

## Web (`apps/web/src/pages/it/Governance.tsx`)

- **`ItRisks`** — a 5×5 likelihood×impact heatmap coloured via band chips, a
  filterable list, a New risk modal, summary tiles.
- **`ItRiskDetail`** — inherent/residual scoring, treatment plan, a "record
  residual score" action, and only the transitions the machine allows.
- **`ItPolicies`** — an "awaiting your acknowledgement" panel, tabs by
  status, a New policy draft modal.
- **`ItPolicyDetail`** — the full body, Publish (gated on
  `can('it_policies:approve')`, with a gate modal in the same shape
  `Agreements` in `Commercial.tsx` uses when the Self-Dealing Bar reroutes an
  approval), Open new version, Retire, an Acknowledge button that appears
  only when the caller has not yet acknowledged the current version, and an
  acknowledgement list gated on `can('it_policies:E')`.
- **`ItControls`** — the library with framework references, a Record a test
  modal.
- **`ItAccessReviews`** — campaigns list with progress (`decided / total`),
  an Open campaign modal.
- **`ItAccessReviewDetail`** — item-by-item decisions, a Decide modal (with a
  note on what `revoke` actually does), Close disabled while any item is
  undecided.
- **`ItFindings`** — list by severity/status with inline transition buttons,
  a New finding modal.

Every screen states plainly what the platform does not do: it does not scan
for vulnerabilities, does not discover what applications exist to review
access against, and does not decide a risk's treatment — every figure is
typed in or computed from what was typed in.

---

## Tests (`apps/api/src/tests/it/governance.test.ts`)

Pure arithmetic first (`riskScore`, `riskBandFor`, `remediationDueAt`,
`acknowledgementRate`) — no database. Then the wiring:

- **IT-RSK-001** — a risk's inherent score/band come from the seeded dated
  scoring table and `scoredUnderBandSetId` is recorded; a residual score is
  computed the same way.
- **IT-POL-001** — publishing needs `approve`; the drafter (chairman, the
  only role holding both `create` and `approve` on `it_policies`) cannot
  publish their own draft (the gate reroutes rather than applying); a
  published body is immutable (`updatePolicyDraft` on a published row is
  refused with 422); a change is `newVersionOf` at `version + 1`, and
  publishing it marks the row it supersedes `superseded`. A separate
  "gate chain" test drives the reroute to completion: chairman drafts and
  self-publishes → a step opens to the Finance Head with
  `selfDealingBarTripped: true` → the Finance Head decides it via
  `decideApprovalStep` → chairman calls `publishPolicy` again and it applies,
  without the gate being re-evaluated (see *Publication and the approval
  gate*, below).
- **IT-POL-002** — an employee acknowledges a published policy once per
  version (a second call is a no-op, not a second row), cannot acknowledge a
  draft, and the summary's `acknowledgementRate` reads `null`/a number
  correctly.
- **IT-ACR-001** — a reviewer deciding their own access item is refused with
  "self-review" named in the message; someone else can decide it.
- **IT-FND-001** — a finding's `dueAt` matches `createdAt + rule.days` for
  the rule in force; the overdue ladder fires once and a second run adds
  nothing.

Plus: risk/finding lifecycle transitions and their dead-transition refusal,
control test recording and the overdue detector's idempotence and re-arming,
an access-review campaign refusing to close with undecided items, the
campaign-overdue detector firing once and staying quiet on a second run
(`overdueNotifiedAt`), and the grant matrix — an employee can acknowledge a
published policy but reaches nothing else in this workstream and never sees
a draft (`listPolicies`/`policyDetail`, filtered or requested directly);
the Operations Head cannot publish any policy (no `approve` at all,
self-dealing or not); the Finance Head reads everything here but creates
nothing, and — holding only `V` on `it_policies`, same as an employee —
sees no draft either; a fixture role holding a wide
`it_policy_acknowledgements:create` grant still only ever acknowledges under
its own `partyId`.

---

## Publication and the approval gate

`POL-IT-POLICY-PUBLISH` is seeded (`apps/api/src/seed/bootstrap.ts`) with
`approverResolution: ['chairman', 'finance_head']`. For an ordinary
(non-self-dealing) publish at no declared authority ceiling, tier resolves
to 0 — `chairman` — and the chairman *is* that tier's approver, so it applies
directly. The Self-Dealing Bar still applies when the drafter and the
publisher are the same principal: `evaluateApprovalGate` bumps the tier to 1
(`finance_head`) and, since the chairman is never `finance_head`, opens an
`ApprovalStep` there instead of applying — a chairman publishing their own
draft is routed to the Finance Head, exactly as it should be.

Deciding that step (`decideApprovalStep`, `platform/approvals.ts`) does not
itself publish anything — it only records the decision on the step. A later
call to `publishPolicy` for the same draft looks for an `ApprovalStep` with
`subjectType: 'it_policy'`, `subjectId: <the draft's id>` and `state:
'approved'` *before* re-running the gate; when one exists it finalises the
write directly (still checking the caller holds ordinary `it_policies:edit`
standing) rather than re-evaluating `evaluateApprovalGate`, which would only
ever reproduce the same self-dealing reroute for the same drafter. This
mirrors the shape `domains/agreements.ts`'s `transitionAgreement` gives a
privileged agreement transition backed by an approval step.

## Open questions (from the plan)

Which frameworks matter for the control library beyond ISO 27001 — SOC 2 and
DPDP alongside, as `frameworkRefs` already supports more than one entry per
control if the company names them.
