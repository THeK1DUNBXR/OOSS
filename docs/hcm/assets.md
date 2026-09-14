# HCM — WS11 assets

Physical inventory, travel requests and letter requests — the ordinary
paperwork of employment that is not payroll, leave or performance. Fulfilling
a letter request routes through `compliance/labour.ts`'s exported
`issueLetter` for the one kind it also models (`experience`); every other
kind (address proof, salary certificate, NOC, visa) writes this workstream's
own snapshot, since `HrLetterKind` does not carry them.

## What exists now

### Models (`apps/api/prisma/schema/hcm-assets.prisma`)

- **Asset** — `recordCode` (`AST-YYYY-NNNNN`), `tag` (unique per tenant), `category` (`laptop | phone | access_card | other`), `serial`, `purchaseDate`, `cost` (masked — see below), `status` (`in_stock | assigned | repair | retired`).
- **AssetAssignment** — one row per spell of an asset being held: `assetId`, `employmentRelationshipId`, `issuedOn`, `returnedOn` (null while out), `condition` (`good | fair | poor`, recorded at issue and again at return).
- **TravelRequest** — `recordCode` (`TRV-YYYY-NNNNN`), `employmentRelationshipId`, `purpose`, `fromLocation`/`toLocation`, `startDate`/`endDate`, `mode` (`flight | train | road | other`), `estimatedCost`, `advanceRequested`, `status` (`submitted | approved | rejected | settled`), `approverPartyId`, `expenseClaimId` (a bare id into WS7's ExpenseClaim — never a relation, since this workstream does not own that model).
- **LetterRequest** — `employmentRelationshipId`, `kind` (`address_proof | salary_certificate | noc | visa | experience`), `status` (`requested | fulfilled | rejected`), `hrLetterId` (set only when fulfilment went through `issueLetter`), `snapshot` (`{ body, issuedOn }`, set only when it did not), `number`.
- **IdCard** — `employmentRelationshipId`, `cardNumber` (unique per tenant), `status` (`issued | lost | reissued | returned`), `issuedOn`, `returnedOn`.

### Shared pure logic (`packages/shared/src/hcm/assets.ts`)

Closed vocabularies (`ASSET_CATEGORIES`, `ASSET_STATUSES`, `TRAVEL_MODES`, `LETTER_REQUEST_KINDS`, …), the small asset/travel/letter-request status machines (`canTransitionAsset`, `canTransitionTravelRequest`, `canTransitionLetterRequest`), the Self-Dealing Bar predicate `isSelfDealingApproval`, and `fulfilsViaHrLetter`/`buildOwnLetterBody` — the split between the one letter kind `compliance/labour.ts` knows and the four this workstream writes itself.

### Domain (`apps/api/src/domains/hcm/assets.ts`)

- `listAssets` / `createAsset` / `transitionAsset` — inventory CRUD and the non-assignment status moves (`in_stock → retired`, `repair → in_stock | retired`). `assigned` only ever changes via assign/return.
- `listAssetAssignments` / `assignAsset` / `returnAsset` — `assignAsset` refuses an asset that is not `in_stock`; `returnAsset` sends a `poor`-condition return to `repair`, everything else back to `in_stock`, both inside one transaction with the asset's own status.
- `listTravelRequests` / `createTravelRequest` / `decideTravelRequest` / `settleTravelRequest` — `decideTravelRequest` enforces the Self-Dealing Bar (the approver may never be the traveller); `settleTravelRequest` only accepts an `approved` request and records the WS7 `expenseClaimId` by id.
- `listLetterRequests` / `createLetterRequest` / `fulfilLetterRequest` / `rejectLetterRequest` — `fulfilLetterRequest` calls `issueLetter` (compliance labour) for `experience`, and writes its own `{ body, issuedOn }` snapshot (numbered `LREQ-YYYY-NNNN`, its own sequence, not `nextRecordCode`) for the other four kinds.
- `listIssuedHrLetters` — a thin re-export of `compliance/labour.ts`'s `listLetters`, so a surface can show real `HrLetter`s issued off an employment without owning that file.
- `listIdCards` / `issueIdCard` / `reportIdCardLost` / `returnIdCard` — `reportIdCardLost` marks the old card `lost` and issues a `reissued` card with a fresh number in one transaction, so the row for the lost card is never overwritten.
- `myEmployment()` — resolves the caller's own employment relationship by `personId`, for `/me/requests` to work with no id the person has to know or paste.
- `assetsPendingCount()` — submitted travel requests + requested letter requests, for a command-center number.
- `assetsPendingForEmployment(employmentRelationshipId)` — open (unreturned) asset assignments for one employment. This is the query WS10's separations screen reads for its `assetsPending` count; WS11 does not call into WS10.

Money masking: `cost` (Asset) and `estimatedCost`/`advanceRequested` (TravelRequest) are nulled in place for a caller without the `financial` verb on `hcm_assets`/`travel_requests` respectively — done by hand in this file's `maskCost`, not through the shared `MONEY_FIELDS`/`applyFieldVisibility` path, because `cost` is not one of the field names that list carries and `packages/shared/src/permissions.ts` is out of this workstream's files to edit. Only the chairman's superadmin grant currently holds `financial` on either resource; `hr_ops_manager` and `finance_head` both see the record with the money withheld.

### Routes (`apps/api/src/routes/hcm/assets.routes.ts`), mounted at `/api/hcm/assets`

| Method & path | Calls |
|---|---|
| `GET /_status` | — |
| `GET /me/employment` | `myEmployment` |
| `GET/POST /inventory`, `POST /inventory/:id/transition` | `listAssets`, `createAsset`, `transitionAsset` |
| `GET /pending`, `GET /pending/:employmentId` | `assetsPendingCount`, `assetsPendingForEmployment` |
| `GET/POST /assignments`, `POST /assignments/:id/return` | `listAssetAssignments`, `assignAsset`, `returnAsset` |
| `GET/POST /travel`, `POST /travel/:id/decide`, `POST /travel/:id/settle` | `listTravelRequests`, `createTravelRequest`, `decideTravelRequest`, `settleTravelRequest` |
| `GET/POST /letters`, `GET /letters/issued/:employmentId`, `POST /letters/:id/fulfil`, `POST /letters/:id/reject` | `listLetterRequests`, `createLetterRequest`, `listIssuedHrLetters`, `fulfilLetterRequest`, `rejectLetterRequest` |
| `GET/POST /idcards`, `POST /idcards/:id/lost`, `POST /idcards/:id/return` | `listIdCards`, `issueIdCard`, `reportIdCardLost`, `returnIdCard` |

### Screens

- **`/people/assets`** (`apps/web/src/pages/hcm/Assets.tsx`) — five tabs: Inventory, Assignments, Travel, Letter requests, ID cards. Approve/reject/fulfil/edit controls are shown only when `useSession().can(...)` says the signed-in role holds the verb, so nobody sees a button the server would refuse outright; a self-dealing refusal (an ops manager deciding their own travel request) still surfaces through the request's own error message rather than being pre-empted client-side.
- **`/me/requests`** (`apps/web/src/pages/me/Requests.tsx`) — resolves the caller's own employment via `GET /hcm/assets/me/employment` first (an `EmptyState` with a true statement if none is on file), then three tabs: assets currently held (plus history), travel requests (submit + track), letter requests (submit + track, with the fulfilled letter's text viewable in place).

## Acceptance table

| ID | PASS means | Test |
|---|---|---|
| HCM-ASSETS-001 | An asset's `cost` is null for a viewer without `hcm_assets:financial` and the real figure for the chairman | `Asset inventory (HCM-ASSETS-001, 002)` › `HCM-ASSETS-001` |
| HCM-ASSETS-002 | An asset that is not `in_stock` cannot be assigned again | same describe › `HCM-ASSETS-002` |
| HCM-ASSETS-003 | Returning `poor` sends the asset to `repair`; `good` returns it to `in_stock` | `Asset assignment and return` › `HCM-ASSETS-003` |
| HCM-ASSETS-004 | A `retired` asset cannot move back to `in_stock` | same describe › `HCM-ASSETS-004` |
| HCM-ASSETS-005 | An employee's assignment list is scoped to their own employment | same describe › `HCM-ASSETS-005` |
| HCM-ASSETS-006 | An employee may submit their own travel request | `Travel requests` › `HCM-ASSETS-006` |
| HCM-ASSETS-007 | The Self-Dealing Bar refuses a traveller deciding their own request (403) | same describe › `HCM-ASSETS-007` |
| HCM-ASSETS-008 | A different approver may approve; settlement records the WS7 `expenseClaimId` and cannot repeat | same describe › `HCM-ASSETS-008` |
| HCM-ASSETS-009 | Fulfilling `experience` issues a real `HrLetter` via `compliance/labour.ts` | `Letter requests` › `HCM-ASSETS-009` |
| HCM-ASSETS-010 | Fulfilling `noc` writes this workstream's own snapshot, no `HrLetter` | same describe › `HCM-ASSETS-010` |
| HCM-ASSETS-011 | A fulfilled or rejected letter request cannot be fulfilled again (422) | same describe › `HCM-ASSETS-011` |
| HCM-ASSETS-012 | Reporting a card lost marks it `lost` and issues a distinct `reissued` card | `ID cards` › `HCM-ASSETS-012` |
| HCM-ASSETS-013 | An asset is invisible from another tenant (404, not a leak) | `Cross-tenant isolation` › `HCM-ASSETS-013` |

Run: `npx vitest run src/tests/hcm/assets.test.ts` from `apps/api`, against `kaizen_test_assets`.

## WS5 scope-axis review

Audited every `assertCan` call in `apps/api/src/domains/hcm/assets.ts` against the bug the WS5 review flagged: `assertCan({ resource, verb })` called with no record (or no `scopeFor` check) on a resource an `own`-scope role holds, letting that role act on or read a record about someone else. Findings:

- **Fixed — `listIssuedHrLetters`**: delegated straight to `compliance/labour.ts`'s `listLetters`, which does exactly the flagged thing (`assertCan('hr_letters', 'view')` with no record, then trusts whatever `employmentRelationshipId` filter it is given). An employee holds `hr_letters:V@own`; passing a colleague's employment id would have returned that colleague's real `HrLetter`s. `labour.ts` is not this workstream's file to edit, so the check now happens in `listIssuedHrLetters` itself, via `assertEmploymentVisible('hr_letters', employmentRelationshipId, 'view')`, before it ever calls into `listLetters`. Test: `Letter requests` › `WS5 scope-axis review: an employee cannot read a colleague's issued HrLetters by passing their employment id`.
- **Fixed — `assetsPendingForEmployment`**: had no permission check of any kind — any authenticated caller could pass any employment id. Now gated with `assertEmploymentVisible('asset_assignments', employmentRelationshipId, 'view')`, so an `own`-scope caller (an employee holds `asset_assignments:V@own`) gets a 404 on a colleague's id. Test: `WS5 scope-axis review: assetsPendingForEmployment` › `an employee may ask about their own pending returns, but not a colleague's`.
- **Already correct — `createTravelRequest`, `createLetterRequest`**: both route through `assertEmploymentVisible(resource, employmentRelationshipId, 'create')`, which checks `scopeFor` and compares the target employment's `personId` to the caller's `partyId` when the grant is not `all`-scoped — the self-service half of the fix pattern, already in place before this review.
- **Already correct — `listAssetAssignments`, `listTravelRequests`, `listLetterRequests`**: each narrows its `where` clause through `ownEmploymentWhere`, which resolves the caller's own employment id(s) first and filters on `employmentRelationshipId` — not a coarse `assertCan` alone.
- **No live exploit, hardened anyway** — `createAsset`, `transitionAsset`, `assignAsset`, `returnAsset`, `decideTravelRequest`, `settleTravelRequest`, `fulfilLetterRequest`, `rejectLetterRequest`, `issueIdCard`, `reportIdCardLost`, `returnIdCard`: every one of these is an admin-only verb (`create`/`edit`/`approve`) that, per `apps/api/src/seed/grants.ts`, no seeded role currently holds at `own` scope — `employee` either lacks the verb entirely (`hcm_assets: '-'`) or holds only `view`/`create` at `own` (`asset_assignments: V@own`, `travel_requests`/`letter_requests: VC@own`, neither of which includes `edit`/`approve`). There is no grant row today that reaches these functions with anything but `all` scope, so no refusal test was added for them (there is no currently-reachable path to refuse). Each now also calls a new `assertAllScope(resource, verb)` guard requiring `scopeFor(resource, verb) === 'all'`, as defence in depth against a future grant change quietly adding an `own`-scope `create`/`edit`/`approve` here.

## What this does not do

- Does not implement generic HR approval routing (`HrRequestType`/`HrRequest`) — travel decisions and letter fulfilment are this workstream's own two-state approve/fulfil, not WS13's chain.
- Does not read or write WS7's `ExpenseClaim` beyond storing its id on `TravelRequest.expenseClaimId` once settled — no relation, no validation that the id refers to a real claim in the right amount.
- Does not compute an actual accounting depreciation schedule for `Asset.cost` — it is the purchase figure, held and masked, nothing more.
- Does not generate a printable ID card or a PDF letter — a letter's `snapshot.body` (or the `HrLetter`'s own snapshot) is plain text, the same discipline `compliance/labour.ts`'s own letters follow.
- Does not notify anyone on assignment, letter fulfilment or travel decision — nothing here calls `notify()`; a viewer finds out by opening their own `/me/requests` or `/people/assets`.

## Wanted from the scaffold

- No `RecordTypeCode` was reserved for a letter request or an ID card (only `AST` and `TRV` were). Both use their own year-scoped sequence via `RecordSequence` with a custom `entityType` string (`HCM:LREQ`, `HCM:IDC`) — the same pattern `compliance/labour.ts`'s `nextLabourNumber` already uses for its own letter and POSH numbering — rather than touching `RECORD_TYPE_CODES` in `packages/shared/src/domain.ts`.
- No `kz.hr.*` event names were registered for an asset's own status change (`repair`/`retired`, outside assign/return), a letter request's rejection, or ID card issuance/loss. Those state changes are covered by `auditWrite` alone; only `asset.assigned`, `asset.returned`, `travel_request.submitted`, `travel_request.approved`, `letter_request.submitted` and `letter_request.issued` — the six names the scaffold did register — are emitted as events.
