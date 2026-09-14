# HCM — WS13 workflow

Generic HR request & approval engine, used by other workstreams via ids only:
they submit a request against a request type they (or HR ops) define, this
engine walks the approval chain, and they read back status/decisions. WS13
never interprets a request's `payload` — it is opaque JSON the caller defines.

## What exists now

### Models (`apps/api/prisma/schema/hcm-workflow.prisma`)

- **HrRequestType** — `code`, `name`, `approvalChain` (JSON `[{ level, resolver, partyId? }]`, `resolver` one of `manager | hr_grant | finance_grant | specific`), `slaHours`, `active`.
- **HrRequest** — `recordCode` (`HRQ-YYYY-NNNNN`), `typeId`, `subjectEmploymentId`, `payload` (JSON), `status` (`submitted | approved(transient, see below) | rejected | withdrawn | closed`), `currentLevel`, `requestedById`.
  - In practice a request only ever sits in `submitted`, then moves straight to a terminal state — `closed` on the final level's approval, `rejected` on any level's rejection, `withdrawn` by the requester. There is no separate database row ever left at status `approved`; the `HR_REQUEST_APPROVED` event fires per-level (including the final one) and `HR_REQUEST_CLOSED` fires once, on top of it, when the chain completes.
- **HrRequestApproval** — one row per chain level reached: `level`, `approverPartyId` (resolved when the level opened; null if resolution found nobody, which raises an exception rather than silently blocking), `decision` (`pending | approved | rejected`), `note`, `decidedAt`.
- **DelegationOfAuthority** — `fromPartyId → toPartyId`, `fromDate`/`toDate`, `scope` (`all | manager | hr_grant | finance_grant`). Consulted at resolution time: a resolved approver who has an active, in-scope delegation is rerouted to the delegate (following the chain up to 5 hops, to guard against a cycle).

### Domain (`apps/api/src/domains/hcm/workflow.ts`)

- `submitRequest({ typeId, subjectEmploymentId, payload })` — validates the type's chain, opens level 1, emits `kz.hr.hr_request.submitted`.
- `decide(requestId, approve, note?)` — decides the current level. Approve on a non-final level advances and opens the next level (emits `kz.hr.hr_request.approved`); approve on the final level closes the request (`kz.hr.hr_request.approved` + `kz.hr.hr_request.closed`); reject ends it (`kz.hr.hr_request.rejected`) without opening further levels.
- `withdrawRequest(requestId)` — the requester only, while still `submitted`.
- `listInbox(forParty?)` — every `pending` approval resolved to a party, across every request type; requires `hr_requests:approve`.
- `listMyRequests()` — the caller's own submitted requests.
- `getRequest(id)` — tenant- and scope-checked read (own-scope callers see only requests they raised or that are about them).
- `createRequestType` / `listRequestTypes` — request-type CRUD (create/edit), gated on `hr_request_types`.
- `createDelegation` / `listDelegations` / `revokeDelegation` — gated on `authority_delegations`; only the delegator may revoke their own.

**Approval-chain resolution** (`resolveStepApprover` in the domain file):

| resolver | resolves to |
|---|---|
| `manager` | the subject employment's active primary `ReportingLine` manager if WS1's table is present and has an open line for it; otherwise the `hr_ops_manager` role holder |
| `hr_grant` | the active `hr_ops_manager` role holder |
| `finance_grant` | the active `finance_head` role holder |
| `specific` | the chain step's fixed `partyId` |

Every resolution excludes a candidate equal to the requester or the request's
subject (the Self-Dealing Bar, applied at resolution time so a request never
even opens against an approver it would refuse), then applies any active
delegation on top. If exclusion or an empty role leaves no candidate, the
level opens with `approverPartyId: null` and an `EX-HCM-WF-001` exception is
raised so it does not sit silently unapproveable.

**The Self-Dealing Bar is also enforced again inside `decide()`** — an
approver may never decide a request they raised or that is about them, even
if the resolved `approverPartyId` on the row has drifted since the level
opened (a chain edit, a manual reassignment). This is defense in depth on top
of the resolution-time exclusion; `HCM-WORKFLOW-005`/`006` test it directly by
forcing that drift.

### Routes (`apps/api/src/routes/hcm/workflow.routes.ts`, mounted at `/api/hcm/workflow`)

- `GET /request-types`, `POST /request-types`
- `GET /requests/mine`, `GET /requests/:id`, `POST /requests`, `POST /requests/:id/withdraw`, `POST /requests/:id/decide`
- `GET /inbox`
- `GET /delegations`, `POST /delegations`, `POST /delegations/:id/revoke`
- `GET /_status` → `{ module: 'workflow', ready: true }`

### Web

- `apps/web/src/pages/hcm/Approvals.tsx` (`/people/approvals`) — the signed-in party's inbox (via `RequestInbox`) plus a self-service Delegation of Authority card (create/revoke, own delegations only).
- `apps/web/src/components/hcm/RequestInbox.tsx` — the reusable inbox: fetches `/hcm/workflow/inbox`, renders each pending item with an SLA-aware chip and an inline approve/reject-with-note form, invalidates on decide. Takes no dependency on the Approvals page — any screen can embed it.

### Shared (`packages/shared/src/hcm/workflow.ts`)

Pure logic used by both the domain layer and the tests: `ApprovalChain`/`ApprovalChainStep` types, `validateApprovalChain`/`isValidApprovalChain`, `stepForLevel`, `resolveDelegate` (the delegation-chain walk), `tripsSelfDealingBar`, `isTerminalStatus`.

## Acceptance

| ID | What PASS means | Test |
|---|---|---|
| HCM-WORKFLOW-001 | Submitting opens level 1, resolved via `hr_grant` to the `hr_ops_manager` holder, with a generated `HRQ-YYYY-NNNNN` code | `HCM-WORKFLOW-001: submitting opens level 1...` |
| HCM-WORKFLOW-002 | Approving a single-level chain's only level closes the request | `HCM-WORKFLOW-002: approving the only level closes the request` |
| HCM-WORKFLOW-003 | A two-level chain advances to a different resolver (finance_grant) on level-1 approval, then closes on level-2 approval | `HCM-WORKFLOW-003: a two-level chain advances...` |
| HCM-WORKFLOW-004 | Rejecting at level 1 of a two-level chain ends the request `rejected` without ever opening level 2 | `HCM-WORKFLOW-004: rejecting at level 1 ends...` |
| HCM-WORKFLOW-005 | The Self-Dealing Bar refuses `decide()` when the (possibly drifted) approver is the request's subject | `HCM-WORKFLOW-005: an approver may never decide a request that is about them...` |
| HCM-WORKFLOW-006 | The Self-Dealing Bar refuses `decide()` when the (possibly drifted) approver is the requester | `HCM-WORKFLOW-006: an approver may never decide a request they themselves raised` |
| HCM-WORKFLOW-007 | Deciding an already-closed request is refused as a 409 conflict, not a silent no-op | `HCM-WORKFLOW-007: deciding an already-closed request is refused as a conflict` |
| HCM-WORKFLOW-008 | A request is a 404 from another tenant's vantage point — never a leak | `HCM-WORKFLOW-008: a request is invisible from another tenant` |
| HCM-WORKFLOW-009 | Only the requester may withdraw their own still-`submitted` request | `HCM-WORKFLOW-009: only the requester may withdraw...` |
| HCM-WORKFLOW-010 | `listInbox` returns only pending approvals resolved to the caller, and drops a request once decided | `HCM-WORKFLOW-010: listInbox surfaces only pending approvals...` |
| HCM-WORKFLOW-011 | A `manager` step falls back to the `hr_ops_manager` holder when no `ReportingLine` is open for the subject | `HCM-WORKFLOW-011: a manager step falls back...` |
| HCM-WORKFLOW-012 | An active delegation reroutes a resolved level to the delegate, who can then decide it | `HCM-WORKFLOW-012: an active delegation reroutes...` |
| HCM-WORKFLOW-013 | A malformed approval chain (non-contiguous levels) is refused at request-type creation, not discovered at submit time | `HCM-WORKFLOW-013: a malformed approval chain is refused at creation...` |

## What this does not do

- No SLA escalation job. `slaHours` is carried on the type and surfaced to the
  inbox as an SLA-due chip, but nothing currently auto-escalates an overdue
  level to the next tier or notifies anyone — there is no scheduled job in
  this workstream (`apps/api/src/jobs/hcm/workflow.ts` does not exist). A
  follow-up job would read `HrRequestApproval` rows past
  `createdAt + type.slaHours` and raise an exception per row, the same shape
  `EX-HCM-WF-001` already uses for an unresolved approver.
- No email/push notification on a new inbox item or a decision — `notify()`
  (the in-app notification helper other domains use) is not called here; the
  inbox is pull-only (poll/visit `/people/approvals`).
- No chain editing UI. `HrRequestType.approvalChain` is created once via
  `POST /request-types`; there is no `PATCH` and no web form for it in this
  workstream (request types are meant to be defined by whichever workstream
  needs a request kind, via the API, not hand-authored by an HR user through
  this page).
- `finance_grant` and `hr_grant` resolve to *the* `finance_head`/`hr_ops_manager`
  role holder — there is no notion of "whichever hr_ops_manager owns this
  employment's org unit" or similar narrowing; the product only has one of
  each role today, so this is deliberately the simplest correct
  implementation rather than a speculative multi-holder resolver.
- Delegation `scope` narrows which *resolver kind* reroutes (`manager`,
  `hr_grant`, `finance_grant`, or `all`); it does not narrow by request type
  or subject. A delegate covering `hr_grant` receives every `hr_grant`-routed
  request for the delegation period, not a filtered subset.

## Wanted from the scaffold

- **`ReportingLine` (WS1, `hcm-workforce.prisma`)** exists in the checked-out
  schema at the time this workstream was built, so it participates in this
  workstream's own `prisma db push` and is queryable. Per the brief, this
  workstream still reaches it defensively — by raw SQL against
  `hcm_workforce_reporting_lines` (`to_regclass` existence check, then a
  plain `SELECT`), never through a generated `prisma.reportingLine` model
  delegate — so a `manager` step degrades to the `hr_ops_manager` fallback
  rather than failing to typecheck or to run if that table's shape changes,
  is renamed, or has not migrated in some other environment. This is a
  one-time table-existence check cached for the process lifetime
  (`_resetReportingLineTableCache()` is exported for tests that need to force
  a re-check).
- Every resource (`hr_requests`, `hr_request_types`, `authority_delegations`),
  event name (`kz.hr.hr_request.submitted/approved/rejected/closed`,
  `kz.hr.authority_delegation.created/ended`), and record-code prefix (`HRQ`)
  this workstream needed was already registered by the scaffold. Two of the
  seeded *grants* on those resources are narrower than this engine actually
  needs, though, and this workstream cannot edit `grants.ts` to widen them:
  - **`finance_head` holds only `view` on `hr_requests`, not `approve`** — so
    a `finance_grant`-resolved level opens correctly, but the real seeded
    `finance_head` account cannot call `decide()` on it as shipped.
    `src/tests/hcm/workflow.test.ts` patches the `Grant` row directly in
    `beforeAll` (the same mechanism `withFixtureRole` uses) so the
    `finance_grant` resolver and `decide()` path are still exercised
    end to end; the fix that belongs in the scaffold is adding `approve` to
    `finance_head`'s `hr_requests` cell.
  - **The `employee` role's own-scope grant on `hr_requests` is `VC@own`
    (view + create), with no `edit`/`delete`** — there is no verb that
    actually names "withdraw your own request". `withdrawRequest()` asserts
    the closest held verb (`create`) and does the real authorization itself
    (the row's `requestedById` must equal the caller), documented inline
    where it does so; the fix that belongs in the scaffold is adding `edit`
    to `employee`'s `hr_requests` cell so that assertion can name the verb it
    actually means.
