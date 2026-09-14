# Technology — applications, licences and subscriptions

Workstream B of `docs/plan/cio.md`. The catalogue of every application the
company runs on, and the commercial agreements — licences and subscriptions —
that sit against each one.

## What the platform does and does not do

- It does not discover applications on the network, and does not meter SaaS
  logins. Every application in the catalogue, and every seat count on a
  licence, was typed in by a person. The screens say so.
- It does not pay a vendor. A licence's `costPerPeriod` is a figure for
  planning; the bill and the payment stay the books' (`VendorBill`,
  `lastVendorBillId` is a pointer to the most recent one, never a duplicated
  figure).
- It computes annualised cost, seat utilisation and the renewal-ladder rung —
  all pure arithmetic over what was typed in, never a guess.

## Model

- **`ItApplication`** — the catalogue row. `name`, `vendorName`/`vendorId`
  (bare id into a future `ItVendor`), `category`, `tier` (1 business-stopping
  … 4 low), `hosting` (`saas`/`on_prem`/`cloud`), `ownerPartyId`,
  `dataClassificationHandled`, `sso`, `status`
  (`evaluating → active → sunsetting → retired`, plus a direct `REJECT` from
  `evaluating` or a direct `RETIRE` from `active` — see
  `itApplicationMachine` in `packages/shared/src/it/software.ts`), `url`,
  `notes`, `unownedNotifiedAt`.
- **`ItLicence`** — one commercial agreement against an application. `kind`
  (`per_seat`/`site`/`perpetual`/`usage`), `seatsPurchased`, `seatsInUse`
  (typed in), `costPerPeriod`/`currency`/`billingCycle`, `termStart`/
  `termEnd`/`renewalDate`/`noticeDays`/`autoRenew`, `vendorContractId` and
  `lastVendorBillId` (bare ids), `status`
  (`active`/`expiring`/`expired`/`cancelled`), `renewalNotifiedRungs`
  (the ladder's own idempotency record), and the `pendingRenewal*` fields
  that carry an open renewal proposal until it is decided.
- **`ItLicenceEvent`** — append-only: `seats_changed`, `renewal_proposed`,
  `renewal_approved`, `renewal_declined`, `cancelled`.
- **`ItSoftwareThreshold`** — dated table: the under-use percentage, the
  minimum seat count it judges licences by, and the renewal-ladder rungs.
  Seeded at `90/60/30/7/0` days and 30%-of-at-least-5-seats — a starting
  point, not a decision (`docs/plan/cio.md` Open questions).

## Renewal is a two-party act by construction

The grant matrix gives Operations Head `it_licences:edit` with no
`approve`, and gives Finance Head `it_licences:approve` with no `edit` —
so a renewal can never be proposed and decided by the same person, and there
is no authority ceiling under which a proposer applies it directly (the
matrix gives nobody both verbs on this resource at once). That is different
from the MoU/contract gate, where one role often holds both verbs and the
Self-Dealing Bar is what stands between a proposer and their own approval.

`evaluateApprovalGate`'s own required-permission check reflects that
asymmetry literally ("holding edit alone never confers approval authority"),
so it cannot be the function a proposer without `approve` calls. Instead:

- **`proposeRenewal`** (held by an edit-only proposer) opens an
  `ApprovalStep` itself, against the `POL-IT-LICENCE-APPROVAL` policy
  version, resolving the standing decider (Finance Head, then the chairman)
  the same way `resolveApprover` in `platform/approvals.ts` resolves one —
  by role slug as data, never a comparison in this file's logic.
- **`approveRenewal`** (held by an approve-only decider) hands the decision
  to `decideApprovalStep` in `platform/approvals.ts`, which is where the
  Self-Dealing Bar actually lives: a requester may never decide their own
  step, checked there regardless of who happens to hold `approve`.

The return shape at both ends is `transitionAgreement`'s in
`domains/agreements.ts`: `{ applied: false, approvalStepId, ... }` while a
step is open, `{ applied: true, licence, ... }` once decided.

## API — mounted at `/api/it`

| Method & path | Verb needed | Notes |
|---|---|---|
| `GET /applications` | `it_applications:view` | `?status=&tier=&hosting=` |
| `GET /applications/summary` | `it_applications:view` | see below |
| `POST /applications` | `it_applications:create` | |
| `GET /applications/:id` | `it_applications:view` | includes `licences[]` and `availableTransitions` |
| `PATCH /applications/:id` | `it_applications:edit` | assigning an owner clears `unownedNotifiedAt` |
| `POST /applications/:id/transition` | `it_applications:edit` | `{ event: 'ACTIVATE'\|'SUNSET'\|'RETIRE'\|'REJECT', note? }` |
| `GET /licences` | `it_licences:view` | `?status=&applicationId=&view=renewing\|over_allocated\|all` |
| `GET /licences/summary` | `it_licences:view` | see below |
| `POST /licences` | `it_licences:create` | |
| `GET /licences/:id` | `it_licences:view` | includes computed `annualisedCost`, `seatUtilisation`, `events[]` |
| `POST /licences/:id/seats` | `it_licences:edit` | `{ seatsInUse, note? }` — append-only event |
| `POST /licences/:id/renew` | `it_licences:edit` | propose — `{ newTermEnd, newCostPerPeriod?, newBillingCycle?, note? }` |
| `POST /licences/:id/approve-renewal` | `it_licences:approve` | `{ approve, note? }` — refuses the proposer |
| `POST /licences/:id/cancel` | `it_licences:edit` | `{ reason }` |

### `GET /applications/summary`

```jsonc
{
  "notYetMeasured": false,
  "byTier": { "1": 2, "2": 5, "3": 9, "4": 3 },
  "byHosting": { "saas": 14, "on_prem": 3, "cloud": 2 },
  "byStatus": { "evaluating": 2, "active": 15, "sunsetting": 1, "retired": 1 },
  "unowned": 1
}
```

### `GET /licences/summary`

`annualisedSpend` and every `annualisedSpendByApplication[].annualisedCost`
are `null` — present, withheld — for a caller without
`it_licences:financial` (Operations Head's `VCEX` carries no `F`). Shown here
as seen by Finance Head, who holds it:

```jsonc
{
  "notYetMeasured": false,
  "annualisedSpend": 842000,
  "annualisedSpendByApplication": [
    { "applicationId": "…", "applicationName": "Google Workspace", "annualisedCost": 240000 }
  ],
  "renewingIn90Days": 3,
  "overAllocated": 1,
  "underUsed": 2,
  "seatsPurchased": 180,
  "seatsInUse": 142
}
```

## Jobs (`runItSoftwareJob`, daily, `automationClass: threshold_response`)

1. **Renewal ladder** — 90/60/30/7 days out and `0` (expired), from
   `ItSoftwareThreshold.renewalLadderRungs`. Fires `IT_LIC_RENEWAL_DUE` (or
   `IT_LIC_EXPIRED` past the renewal date) once per rung, recorded on
   `renewalNotifiedRungs`; a second run the same day raises nothing new
   (`raiseException`'s own `triggerFingerprint`+`ladderRung` dedupe, plus the
   row's own record). Flips `status` to `expiring` within 90 days and
   `expired` once the date has passed.
2. **Seat over-allocation** — `seatsInUse > seatsPurchased` raises
   `IT_LIC_SEAT_OVERALLOCATED` naming the licence. Idempotent via
   `raiseException`'s open-exception dedupe: the condition is a standing
   fact, not a discrete rung, so it stays open rather than duplicating.
3. **Seat under-use** — utilisation below `underUsePercent`, judged only for
   licences with at least `underUseMinSeats` purchased, raises
   `IT_LIC_SEAT_UNDERUSED`.
4. **Unowned application** — an `evaluating`/`active` application with no
   `ownerPartyId` raises `IT_APP_UNOWNED` with the application as subject,
   no fallback owner (IT-APP-001).

## Pure arithmetic (`packages/shared/src/it/software.ts`, no DB)

- `annualisedCost(costPerPeriod, billingCycle)` — monthly ×12, quarterly ×4,
  annual ×1, one_off as itself.
- `seatUtilisation(purchased, inUse)` — `{ percent, overAllocated }`;
  `percent` is `null` (not 0%) with nothing purchased.
- `isUnderUsed(purchased, inUse, underUsePercent, underUseMinSeats)`.
- `renewalRung(daysLeft, rungs)` — the tightest rung crossed, or `null`.
- `itApplicationMachine` — the application lifecycle, exposed to the API via
  `availableTransitions` so a button the UI renders can never drift from the
  diagram.

## Acceptance IDs → tests (`apps/api/src/tests/it/software.test.ts`)

| ID | Test |
|---|---|
| IT-APP-001 | `IT-APP-001: an application with no owner raises IT_APP_UNOWNED rather than sitting silently unowned` |
| IT-LIC-001 | `IT-LIC-001: the renewal ladder fires once per rung, and a second run the same day is idempotent` |
| IT-LIC-002 | `IT-LIC-002: seats in use above seats purchased raises an over-allocation exception naming the licence` |
| IT-LIC-003 | `IT-LIC-003: a renewal proposal by the Operations Head opens an approval step it cannot decide itself` |
| IT-LIC-004 | `IT-LIC-004: annualisedCost normalises monthly, quarterly and annual billing to one figure` |
| Permission | `the Operations Head cannot approve their own renewal (permission test)` |
| Permission | `the Finance Head cannot create a licence — VF,approve carries no create verb (permission test)` |
| Permission | `an employee sees the application catalogue but holds no grant on licences at all (permission test)` |

Run against this workstream's own database:

```
export TEST_DATABASE_URL="postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test_software?schema=public"
export DATABASE_URL="$TEST_DATABASE_URL"
cd apps/api
npx prisma db push --skip-generate --accept-data-loss
pnpm generate
npx tsx src/tests/fixtures/run.ts
npx vitest run src/tests/it/software.test.ts
```

## Screens

- **Applications** (`/it/applications`) — tabs by status, tiles for total,
  tier 1, unowned and retired counts, a New application modal with an owner
  picker copied inline from the person-search pattern in
  `apps/web/src/components/createForms.tsx`.
- **Application detail** (`/it/applications/:id`) — fields, owner
  assignment, lifecycle buttons rendered only from `availableTransitions`,
  its licences, and links (by path only, no duplication) to Continuity,
  Incidents and Changes. The `licences[]` array itself is server-shaped: it
  is populated only when the caller separately holds `it_licences:view` (an
  employee holds `it_applications:view` but no grant on `it_licences` at
  all, so they see none), and within it `costPerPeriod` is withheld —
  present but `null` — for a caller without `it_licences:financial`
  (`GET /applications/:id`, `applicationDetail` in
  `domains/it/software.ts`).
- **Licences** (`/it/licences`) — tabs (renewing soon, over-allocated, all),
  an annualised spend metric, a New licence modal. Money is withheld
  server-side, not merely hidden by the screen: `listLicences`,
  `licenceDetail` and `licencesSummary` each call `canSeeMoney('it_licences')`
  and null `costPerPeriod`/`annualisedCost`/`annualisedSpend`
  (present-but-`null`, the same shape `maskContractMoney` in
  `domains/it/vendors.ts` uses) for a caller without `it_licences:financial`
  — Operations Head holds `VCEX` on this resource, no `F`. The `can('it_licences:F')`
  check on screen renders `Withheld` in place of the figure; it is a display
  choice layered on top of a response that already carries no real number to
  leak.
- **Licence detail** (`/it/licences/:id`) — seat update, propose renewal,
  the Approve/Decline controls shown only to a viewer holding
  `it_licences:approve` (never rendered disabled for anyone else), cancel
  with a required reason, and the append-only event history.
