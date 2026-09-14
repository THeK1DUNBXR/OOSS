# Assets and devices

The IT half of a device (`docs/plan/cio.md`, workstream A). `FixedAsset`
(main.prisma) stays the books' capital register — cost, salvage, useful
life, depreciation, disposal. `ItAsset` is everything the books never
tracked: a serial number, a warranty, who is holding it, where it sits, and
what state it is in. The two are linked by a bare `fixedAssetId` when the
item was capitalised; book value is read from `ItAsset.purchaseCost` for the
IT-side summary and from `FixedAsset` for the books' own figure — neither
duplicates the other (Principle 8).

---

## Model

**`ItAsset`** — tag, kind (`laptop` | `desktop` | `phone` | `monitor` |
`peripheral` | `network` | `server` | `other`), make/model/serial, purchase
date and cost, warranty end, supplier name and a bare `vendorId`, location,
division, `fixedAssetId`, status, condition, notes, the current
`holderPartyId`, and `warrantyNotifiedRungs` (the ladder's idempotency
record, mirroring `ComplianceObligation.notifiedRungs`).

Status runs `in_stock → assigned → in_repair → retired → disposed` through
`itAssetMachine` (`packages/shared/src/it/assets.ts`), enforced by
`apps/api/src/domains/it/assets.ts` the same way every other lifecycle
machine on the platform is: a read carries `availableTransitions`, computed
by the machine, so a screen can never offer a move that will be refused.
`disposed` is reachable only through `retired` — never directly from
`assigned` or `in_stock` (IT-AST-001).

```
in_stock --ASSIGN--> assigned --RETURN--> in_stock
in_stock --SEND_TO_REPAIR--> in_repair --BACK_FROM_REPAIR--> in_stock
assigned --SEND_TO_REPAIR--> in_repair
in_stock / assigned / in_repair --RETIRE--> retired --DISPOSE--> disposed
```

**`ItAssetAssignment`** — append-only hand-over/return log (Principle 5):
`partyId`, `assignedAt`, `assignedById`, `conditionOut`, and — once
returned, on the SAME row — `returnedAt`, `conditionIn`, `acknowledgedAt`.
Assigning always writes a new row; returning closes the currently open one
and never touches an earlier, already-closed row (IT-AST-002). An asset with
an open assignment cannot be reassigned without a `RETURN` first — the
machine only allows `ASSIGN` from `in_stock`, so the invariant is structural.
`conditionOut`/`conditionIn` are validated against `IT_ASSET_CONDITIONS`, the
same as the asset's own `condition` field.

Assigning and returning are gated on `it_assets:assign` (the matrix's `A`
letter), a distinct grant from `edit` — the Operations Head cell is
`VCEDAX`, so holding `edit` alone does not confer the authority to hand an
asset to a person or take it back; that is its own letter on the matrix.

**`ItAssetEvent`** — append-only history: a repair note, an audit sighting,
a free-text note, or the record of a lifecycle transition. Never edited or
deleted.

**`ItAssetThreshold`** — the dated table behind the warranty ladder and the
in-repair detector (Principle 4: service targets are data, not constants).
One row per `(tenantId, code, effectiveFrom)`; the row with the latest
`effectiveFrom` at or before now is in force. Seeded with `warrantyRungs =
[90, 30, 7, 0]` and `repairDaysThreshold = 14` — a starting point, not a
decision (`docs/plan/cio.md`'s open questions).

## Pure arithmetic

`packages/shared/src/it/assets.ts`, exercised without a database:

- `warrantyRung(daysLeft, rungs)` — the tightest ladder rung `daysLeft` has
  crossed, or `null` when the warranty is outside every rung. `rungs` is
  passed in, never hard-coded, so a tenant's own `ItAssetThreshold` row
  governs the ladder actually run.
- `assetBookValue(costs)` — sums a list of purchase costs, treating
  null/undefined as zero. The caller excludes `disposed` rows first.
- `daysUntil(date, now)` / `daysInRepair(since, now)` — whole-day arithmetic
  the ladder and the in-repair detector both read.
- `itAssetMachine` — the lifecycle machine itself (`createMachine` from
  `packages/shared/src/hr.ts`), so the transition diagram is one object the
  domain, the API and the tests all read the same way.

## API — mounted at `/api/it/assets`

| Method | Path | What |
|---|---|---|
| GET | `/` | List, scoped. Query: `status`, `kind`, `search` (matches tag, serial, make, model, or a holder's name). |
| GET | `/summary` | The summary tile shape (below). |
| GET | `/mine` | Exactly the caller's own assets — what the My IT page (another workstream) reads, regardless of the caller's own `it_assets` scope. |
| POST | `/` | Create. `it_assets:create`. |
| GET | `/:id` | Detail: the asset, `availableTransitions`, `assignments`, `events`, and — when `fixedAssetId` is set — the linked `FixedAsset` resolved server-side (`recordCode`, `name`, `cost`, `disposedAt`) plus a `bookValue` (the books' cost when capitalised, else the typed-in `purchaseCost`). Never both added together (Principle 8). Scoped to the caller's own asset unless their grant is `@all`. |
| PATCH | `/:id` | Edit descriptive fields (make/model/serial/cost/warranty/supplier/location/division/fixedAssetId/condition/notes) — never status or holder. `kind` (create only) and `condition` are validated against `IT_ASSET_KINDS`/`IT_ASSET_CONDITIONS` in the zod schema and again in the domain. |
| POST | `/:id/assign` | `{ partyId, conditionOut?, note? }` — writes a new `ItAssetAssignment` row, moves to `assigned`. `it_assets:assign`. |
| POST | `/:id/return` | `{ conditionIn?, note?, acknowledged? }` — closes the open assignment row, moves to `in_stock`, clears the holder. `it_assets:assign`. |
| POST | `/:id/transition` | `{ event, note? }` — `SEND_TO_REPAIR` \| `BACK_FROM_REPAIR` \| `RETIRE` \| `DISPOSE` only; `ASSIGN`/`RETURN` are refused here (400) since they need the dedicated endpoints. |
| GET | `/:id/events` | The append-only event log. |
| POST | `/:id/events` | `{ kind, detail }` — a repair note, an audit sighting, or a free-text note. |

All writes are `assertCan`-gated on `it_assets`, audited via `auditWrite`,
and emit `IT_ASSET_CREATED` / `IT_ASSET_ASSIGNED` / `IT_ASSET_RETURNED` /
`IT_ASSET_TRANSITIONED` / `IT_ASSET_WARRANTY_APPROACHING`. Every list and
detail read is scoped: an employee's `it_assets:V@own` grant narrows both
against `holderPartyId`, mapped as the owning field the WHERE axis expects.

### Summary shape

The summary is an aggregate over the whole fleet — exactly the case
`assertScopeAll` exists for: an `it_assets:V@own` grant answers "may I view
an asset", not "may I know the fleet's book value and who holds the most
kit". A caller who does not hold an `@all` view grant (an employee, on the
matrix) gets the same shape computed only over their own assets instead of
being flatly refused — `topHolders` then contains at most themselves and
`bookValue` is their own assets' cost, never the fleet's.

```jsonc
GET /api/it/assets/summary
{
  "notYetMeasured": false,          // true only when the tenant (or the caller's own slice) has zero assets
  "total": 42,
  "byKind": { "laptop": 30, "monitor": 8, "phone": 4 },
  "byStatus": { "in_stock": 6, "assigned": 30, "in_repair": 2, "retired": 3, "disposed": 1 },
  "warrantyExpiringIn90Days": 5,     // non-retired/disposed, 0 <= daysLeft <= 90
  "unassignedStock": 6,              // status === in_stock
  "topHolders": [
    { "partyId": "…", "fullName": "…", "count": 3 }
  ],                                  // top 10, by asset count — narrowed to the caller's own scope when not @all
  "bookValue": 1250000,               // sum of purchaseCost over non-disposed assets in scope
  "fixedAssetLinkedCount": 12         // assets with a fixedAssetId set, in scope
}
```

## Seed

`apps/api/src/seed/it/assets.ts` upserts the single `ItAssetThreshold` row
(`code: "DEFAULT"`) idempotently — a second run updates the same row rather
than creating another.

## Jobs (`apps/api/src/jobs/it/assets.ts`, exported as `JOBS`)

- **`runAssetWarrantyLadderJob`** (06:00 daily) — every non-retired,
  non-disposed asset with a warranty end date; fires `IT_AST_WARRANTY_
  APPROACHING` (or `_EXPIRED` once past the last rung) once per rung,
  recorded on `warrantyNotifiedRungs`. Owner is the current holder, or the
  Operations Head when unheld.
- **`runAssetInRepairTooLongJob`** (06:15 daily) — an asset in `in_repair`
  longer than the seeded threshold raises `IT_AST_REPAIR_OVERDUE`.
  Idempotent via `raiseException`'s own open-exception check (the same code
  on the same subject never duplicates while it stays open).
- **`runAssetOrphanedDetectorJob`** (06:30 daily) — an asset whose holder has
  no active `Affiliation` raises `IT_AST_ORPHANED` (IT-AST-005), the exit
  checklist's technology half. Owner resolution never branches on a role
  slug: it looks up an active `hr_ops_manager` affiliation the same way
  `domains/compliance/calendar.ts` resolves an obligation's owner.

## What this does and does not do

Typed in: serial, warranty, cost, condition, location. Computed: the
warranty rung, book value, who holds what. **Not** done here: no device
discovery, no MDM/asset-agent polling, no automatic serial capture — every
field above is typed in by a person, and the summary tile says so
(`notYetMeasured` on an empty fleet).

## Acceptance

| ID | Test |
|---|---|
| IT-AST-001 | `IT-AST-001: the asset lifecycle machine (pure, no DB)` — three `it`s in `src/tests/it/assets.test.ts` asserting `allowedEvents` per state and that `DISPOSE` is refused from `assigned`. |
| IT-AST-002 | `IT-AST-002: assigning writes an assignment row and returning closes it without editing the earlier row` |
| IT-AST-003 | `IT-AST-003: the warranty ladder fires once per rung and a second run on the same day raises nothing new` |
| IT-AST-004 | `IT-AST-004: an employee lists assets and sees only those assigned to them` |
| IT-AST-005 | `IT-AST-005: an asset held by a person whose affiliation has ended surfaces as an exception with the asset as subject` |

Plus: the in-repair-too-long detector (idempotent), append-only events, the
summary's `notYetMeasured`/count invariants, and permission tests — an
employee cannot create an asset (`V@own`, view only), the Finance Head
(`VF` — view and financial, no edit) cannot transition one, the chairman
holds every verb at every scope, `/transition` refuses `ASSIGN`/`RETURN`
(400) since those need the dedicated endpoints, a fixture role holding `VCE`
(view/create/edit but no `A`) cannot assign, and an employee's summary
excludes fleet-wide `topHolders`/`bookValue` — narrowed to their own assets
instead.

## Web

`apps/web/src/pages/it/Assets.tsx` — `ItAssets` (list: tabs by status,
filters by kind, search by tag/serial/holder, a New asset modal) and
`ItAssetDetail` (fields including the resolved linked `FixedAsset` and its
book value, holder, a merged timeline of assignments and events, and
controls rendered only from `availableTransitions` — assign [a small
inline person-search against `/crm/people`, the same pattern
`components/createForms.tsx` uses], return, send to repair, back from
repair, retire, dispose, and add an event/note).

Action buttons are computed, not disabled: `ItAssetDetail` filters
`availableTransitions` down to what the caller's own grants actually permit
(`it_assets:assign` for assign/return, `it_assets:edit` for the rest) and
renders only that subset — never a greyed-out button for a move the caller
cannot make, matching the platform's "omit, never disable" rule for gated
controls.
