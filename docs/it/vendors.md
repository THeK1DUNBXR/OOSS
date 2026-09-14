# Technology — vendors and contracts

Workstream C of `docs/plan/cio.md`. `VendorBill.vendorName` (main.prisma) is
free text; this workstream is the master a bill's vendor name should have
pointed at — who the vendor is, how risky they are, whether their security
assessment and DPA are current — plus the priced, dated, gated contract that
governs each relationship.

## Model

**`ItVendor`** — a supplier. Name, `organizationId` (bare id, set only when
the same counterparty is also a party we sell to or partner with —
`main.prisma` `Organization`), category, tier (1 critical … 4 low, the same
scale `ItApplication.tier` will use), a *dated* risk rating (`riskRating` +
`riskRatedAt`), a security-assessment status (`not_assessed | in_progress |
passed | failed | expired`) with `assessmentDueAt` and
`assessmentNotifiedRungs` (the overdue ladder's own idempotency record), DPA
signed + `dpaSignedAt`, contact name/email, and a status lifecycle
(`active | suspended | offboarded`).

**`ItVendorAssessmentCadenceRule`** — the dated table behind
`assessmentDueAt` (Principle 4: service targets are data, not constants).
One row per `(tenantId, tier)`, seeded from `VENDOR_ASSESSMENT_CADENCE_MONTHS`
(tier 1: 6 months … tier 4: 24 months) and never overwritten once a tenant
has its own row for a tier.

**`ItVendorRiskAssessment`** — append-only: one row per questionnaire round
(`assessedAt`, `assessorPartyId`, `score`, `outcome`, `questionnaire` JSON,
`notes`, `evidenceDocumentId`). A correction is a new assessment, never an
edit to a past one.

**`ItVendorContract`** — the priced, dated instrument. Title, `vendorId`
(relation within this file), `value`/`currency` (`Decimal(18,2)` — money
stays in the books; this is the planning figure, linked, never duplicated),
term, start/end date, `noticeDays`, `autoRenew`, `slaText`, `documentId`,
`ownerPartyId` (the proposer), status
`draft → proposed → approved → active → expiring → expired | terminated`,
`approvedById`/`approvedAt`, `renewedFromId`, `terminatedAt`/
`terminationReason`, `noticeNotifiedRungs` (the notice ladder's idempotency
record).

## Lifecycles

**Vendor** (`packages/shared/src/it/vendors.ts`, `vendorStatusMachine`):
`active ⇄ suspended`, either `-> offboarded` (terminal). Run directly against
the machine in `domains/it/vendors.ts::transitionVendor` — not through
`platform/lifecycle.ts`'s `transition()` helper, which hard-codes the
`kz.hr.*` event namespace and the `hr` domain (wrong for technology). The
generic half, `availableTransitions`, is still reused so a screen can never
render a button the machine would refuse.

**Vendor contract** (`VENDOR_CONTRACT_USER_TRANSITIONS` in the same shared
file): `draft -> proposed -> {approved, terminated}`,
`proposed -> {approved, terminated}`, `approved -> {active, terminated}`,
`active -> terminated`, `expiring -> terminated`. `expiring` and `expired`
are **job-driven only** — the notice-ladder job sets them; a user transition
to either is refused (422). `approved` is the sole privileged transition: it
runs `evaluateApprovalGate('POL-IT-VENDOR-CONTRACT-APPROVAL', { type:
'it_vendor_contract', ownerPartyId: <proposer>, commercialValue: <value>,
... })`, the identical approval-gate shape `domains/agreements.ts` runs for
MoU/Contract/Partner Agreement. When the gate does not permit the transition
outright, `transitionVendorContract` returns `{ applied: false,
approvalStepId, resolvedApproverRole, resolutionTier, selfDealingBarTripped,
reason }` instead of throwing — the same shape `transitionAgreement` returns,
so the web page's gate-result modal (below) reads it identically.

## What is computed vs. typed in

- `assessmentDueAt` is computed at vendor creation and every time
  `recordAssessment` runs, from the tiered cadence table — never typed in
  directly.
- A contract's notice date (`endDate - noticeDays`) and its ladder rung are
  pure arithmetic (`noticeDate`, `noticeRung` in shared) — the job reads them,
  nothing stores a precomputed "days to notice."
- `contractValueUnderManagement` is a pure sum over `approved | active |
  expiring` contracts — a `draft`/`proposed` contract has not committed
  spend yet, and a `terminated`/`expired` one no longer does. Currency is
  **not** normalised across rows (an FX layer this does not attempt); every
  contract in the seed and fixtures is INR.
- The platform does **not** monitor a vendor's actual security posture, does
  not verify a DPA's content, and does not discover a vendor relationship
  from a bill — every field here is typed in by whoever runs the vendor
  relationship, or computed from what was typed in. The Vendors and
  Contracts screens say this in their subtitles.

## Money is withheld server-side, not only hidden in the UI

`it_vendor_contracts:F` (the `financial` verb) is a distinct grant from
`view` — Finance Head and the chairman hold it; Operations Head holds
`VCEX` and does not. Every domain function that returns a contract or a
contract-shaped row (`createVendorContract`, `listVendorContracts`,
`vendorContractDetail`, `transitionVendorContract`, and by extension
`renewVendorContract`/`terminateVendorContract`, which call the first two)
calls `canSeeMoney('it_vendor_contracts')` and runs the row through
`maskContractMoney` before it ever leaves the domain layer: `value` is
withheld the way `platform/permissions.ts`'s `applyFieldVisibility` withholds
any declared `MONEY_FIELDS` entry (present on the shape, set to `null`,
never a silently dropped key), and `currency` — not itself a money figure, so
not in `MONEY_FIELDS` — is nulled alongside it explicitly by the same helper.
`summaryContracts`' `valueUnderManagement` follows the identical rule: `null`
for a caller without `F`, the real sum otherwise. The web page's `can('it_
vendor_contracts:F')` check only decides whether the column renders at all —
removing that check would show `null`s, not leak the figures, because the
withholding happens before the response is built, not in the browser.

## API — mounted at `/api/it`

| Method | Path | What |
|---|---|---|
| GET | `/vendors` | List vendors. Query: `status`, `tier`, `riskRating`. |
| GET | `/vendors/summary` | Vendor summary (shape below). |
| POST | `/vendors` | Create a vendor. `{ name, category, organizationId?, tier?, riskRating?, contactName?, contactEmail?, dpaSigned?, notes? }`. |
| GET | `/vendors/:id` | Detail: vendor + `availableTransitions` + `riskAssessments` + `contracts`. |
| POST | `/vendors/:id/assess` | Record an assessment. `{ assessor, outcome: 'in_progress'\|'passed'\|'failed', assessedAt?, score?, questionnaire?, notes?, evidenceDocumentId?, riskRating? }`. |
| POST | `/vendors/:id/transition` | `{ event: 'SUSPEND'\|'REINSTATE'\|'OFFBOARD', note? }`. |
| GET | `/contracts` | List vendor contracts. Query: `status`, `vendorId`. |
| GET | `/contracts/summary` | Contract summary (shape below). |
| POST | `/contracts` | Create a draft contract. `{ vendorId, title, value, currency?, termMonths?, startDate?, endDate?, noticeDays?, autoRenew?, slaText?, documentId? }`. |
| GET | `/contracts/:id` | Detail: contract + `vendorName` + `daysToNotice` + `availableTransitions` + `requiresApprovalFor`. |
| POST | `/contracts/:id/transition` | `{ toStatus, note? }`. Returns `{ applied, contract, approvalStepId, resolvedApproverRole, resolutionTier, selfDealingBarTripped, reason }`. |
| POST | `/contracts/:id/renew` | `{ endDate, value?, startDate?, noticeDays?, autoRenew?, slaText? }`. Creates a new draft chained by `renewedFromId`; the predecessor is untouched. |
| POST | `/contracts/:id/terminate` | `{ reason }` (required). Equivalent to `transition({ toStatus: 'terminated', note: reason })`. |

Input bounds (zod, `routes/it/vendors.routes.ts`): assessment `score` is
0–100; `termMonths` is a positive integer; `noticeDays` is a non-negative
integer, on both `/contracts` and `/contracts/:id/renew`.

### `GET /it/vendors/summary`

```json
{
  "notYetMeasured": false,
  "byTier": { "1": 2, "2": 5, "3": 3, "4": 1 },
  "byRisk": { "low": 3, "medium": 5, "high": 2, "critical": 1 },
  "assessmentsOverdue": 1,
  "highRiskCount": 3,
  "highRiskWithDpa": 2
}
```
`notYetMeasured: true` (with all counts zero/empty) when the tenant has no
vendors at all.

### `GET /it/contracts/summary`

```json
{
  "notYetMeasured": false,
  "byStatus": { "draft": 1, "proposed": 1, "approved": 2, "active": 3, "expiring": 1, "expired": 0, "terminated": 1 },
  "valueUnderManagement": 1850000,
  "expiringIn90Days": 1,
  "awaitingApproval": 1
}
```
`valueUnderManagement` sums `approved | active | expiring` contracts
(`contractValueUnderManagement` in shared) — `null`, not `0`, for a caller
without `it_vendor_contracts:F` (see "Money is withheld server-side" above).
`awaitingApproval` counts open
`ApprovalStep` rows against `it_vendor_contract`. `notYetMeasured: true` when
the tenant has no vendor contracts at all.

## Jobs (`apps/api/src/jobs/it/vendors.ts`, exported in `JOBS`)

1. **`runVendorContractNoticeLadder`** — daily. For every contract in
   `approved | active | expiring` with an `endDate`: if `endDate` has
   passed, flips the row to `expired` unconditionally (whatever the notice
   ladder had or had not fired). Otherwise computes days to
   `endDate - noticeDays` and applies the 30/7/0 ladder
   (`VENDOR_LADDER_RUNGS`): the first time any rung is crossed the contract
   flips to `expiring`, emitting `EVENTS.IT_VENDOR_CONTRACT_EXPIRING`; each
   newly-crossed rung also raises `IT_VCT_NOTICE`
   (severity climbing S2 → S3 → S4 as the rung tightens), with wording that
   differs for `autoRenew` contracts ("will renew unless notice is given
   by…") versus not ("will lapse … unless renewed"). `noticeNotifiedRungs`
   makes a same-day re-run raise nothing new (IT-VCT-002).
2. **`runVendorAssessmentOverdueJob`** — daily. Same 30/7/0 ladder, this time
   against `assessmentDueAt`. Raises `IT_VEN_ASSESSMENT_OVERDUE` (label and
   severity vary by rung: "due in Nd" pre-due, "overdue" once the date has
   passed); crossing the overdue rung also flips `assessmentStatus` to
   `expired`. `assessmentNotifiedRungs` makes a same-day re-run raise
   nothing new (IT-VEN-001).
3. **`runVendorDpaMissingJob`** — daily. Every `active` vendor rated `high`
   or `critical` risk with `dpaSigned: false` raises `IT_VEN_DPA_MISSING`.
   Not a ladder — `raiseException`'s own "an open exception of this code on
   this subject is not duplicated" rule makes a re-run idempotent.

## No dedicated "vendor transitioned" event

The shared `EVENTS` block (`packages/shared/src/events.ts`) names
`IT_VENDOR_CREATED`, `IT_VENDOR_ASSESSED`, `IT_VENDOR_CONTRACT_CREATED`,
`IT_VENDOR_CONTRACT_TRANSITIONED` and `IT_VENDOR_CONTRACT_EXPIRING` for this
workstream — there is no `IT_VENDOR_TRANSITIONED`. Per the brief
("emit an existing close one and note it"), `transitionVendor` reuses
`EVENTS.IT_VENDOR_CONTRACT_TRANSITIONED` for a vendor's own status change
(suspend/reinstate/offboard); the event envelope's `subject.entityType`
(`it_vendor`, not `it_vendor_contract`) still disambiguates it from a
contract transition for any subscriber. If a future pass adds
`IT_VENDOR_TRANSITIONED` to the shared event block, `transitionVendor` is
the only call site to update.

## Web (`apps/web/src/pages/it/Vendors.tsx`)

- **`ItVendors`** — list, tabs (All / Tier 1 / Tier 2 / Suspended /
  Offboarded), summary metrics (high/critical risk with DPA coverage,
  assessments overdue, tier 1 count), "Add a vendor" modal gated on
  `can('it_vendors:C')`.
- **`ItVendorDetail`** — vendor facts, lifecycle transition buttons (gated on
  `can('it_vendors:E')`, rendered only from `availableTransitions`),
  assessment history, "Record assessment" modal, and this vendor's
  contracts.
- **`ItVendorContracts`** — list, tabs (All / Expiring / Awaiting approval /
  Active), the value-under-management metric shown **only** when
  `can('it_vendor_contracts:F')` (the `financial` verb — Finance Head and
  chairman hold it; Operations Head does not), "New contract" modal gated on
  `can('it_vendor_contracts:C')`. The `can()` check only decides whether the
  column is *rendered* — the figures themselves are withheld server-side (see
  "Money is withheld server-side" below), so hiding the column client-side is
  a presentation choice, not the control.
- **`ItVendorContractDetail`** — transition buttons rendered only from
  `availableTransitions`; a privileged transition (`approved`) renders only
  when `can('it_vendor_contracts:approve')` and is marked with a shield icon.
  A non-applied gate result opens the same "Approval required" modal shape
  `Agreements` (`apps/web/src/pages/Commercial.tsx`) uses, explicitly naming
  the resolved approver, the tier, and — when tripped — the Self-Dealing Bar
  ("the approver may never be the contract's own proposer"). Renew and
  Terminate (reason required) actions.

## Acceptance

| ID | Test | What it proves |
|---|---|---|
| IT-VEN-001 | `IT-VEN-001: a vendor whose security assessment is past its next-due date raises IT_VEN_ASSESSMENT_OVERDUE` | The overdue ladder fires the named exception and is idempotent on a same-day re-run. |
| IT-VCT-001 | `IT-VCT-001: approving a vendor contract the same actor proposed reroutes to the next tier with the Self-Dealing Bar tripped` | The proposer never approves — even the chairman, the only role holding both `create` and `approve` on vendor contracts, is rerouted when approving their own. |
| IT-VCT-002 | `IT-VCT-002: the notice ladder fires once per rung and flips expiring then expired` | The 30/7/0 notice ladder is idempotent per rung and the status flips are exactly `expiring` then `expired`. |
| IT-VCT-003 | `IT-VCT-003: terminating requires a reason and leaves the approval history intact` | Termination without a reason is rejected (400); after termination, `approvedById`/`approvedAt` are unchanged. |
| — | `the Finance Head cannot create a vendor or a vendor contract` | Grant-matrix permission test: Finance Head holds no `create` on either resource. |
| — | `the Operations Head cannot approve a vendor contract — the grant has no approve` | Grant-matrix permission test: Operations Head holds `VCEX`, no `approve`. |
| — | `the Operations Head never receives contract value or currency — withheld server-side, not only hidden in the UI` | `value`/`currency` are `null` on create, list, detail and the summary for a caller without `it_vendor_contracts:F`; Finance Head sees the real figures on the same row. |
| — | `the employee reaches nothing on vendors or vendor contracts` | The employee holds no grant on either resource at all. |
| — | pure arithmetic (`noticeDate`, `noticeRung`, `contractValueUnderManagement`) | Tested without a database. |

Run: `TEST_DATABASE_URL=postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test_vendors?schema=public DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/tests/it/vendors.test.ts` from `apps/api`.
