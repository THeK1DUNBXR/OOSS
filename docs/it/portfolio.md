# Technology — portfolio and budget

Workstream G of `docs/plan/cio.md`. What a technology initiative is, how its
funding is approved, what a roadmap milestone is, how a run/grow budget line
is planned and its actual computed, and what a technical-debt item costs to
leave.

## Model

- **`ItInitiative`** — title, theme (`run` | `grow` | `transform`),
  `sponsorPartyId` (the accountable requester — the approval gate's
  Self-Dealing Bar checks this field, never `ownerPartyId`), `ownerPartyId`
  (the delivery owner, who may or may not be the sponsor), business case,
  expected benefit, `budget` (`Decimal(18,2)`), currency, `stage`
  (`idea → assessed → approved → in_flight → delivered → benefits_realised`,
  or `cancelled` from anywhere short of delivery), `rag` (`green` | `amber` |
  `red`) with `ragReason`/`ragSetAt`, `targetQuarter` (e.g. `FY2026-27 Q3`),
  `projectId`, `vendorBillIds`/`licenceIds` (bare ids spend is summed from),
  `staleNotifiedAt`. `assessed → approved` runs
  `evaluateApprovalGate('POL-IT-INITIATIVE-APPROVAL', ...)` exactly the way
  `transitionAgreement` in `domains/agreements.ts` runs it for MoUs and
  contracts — a non-permitted gate opens an approval step and the endpoint
  returns `{ applied: false, reason, approvalStepId, ... }` rather than
  throwing.
- **`ItInitiativeUpdate`** — append-only status report: body, RAG, author,
  timestamp. Posting one also refreshes the initiative's own live
  `rag`/`ragReason`/`ragSetAt` and clears `staleNotifiedAt`, so a quiet
  initiative that speaks up again is eligible for the stale ladder a second
  time.
- **`ItRoadmapItem`** — quarter (`FY2026-27 Q3`), theme, optional
  `initiativeId`, milestone, `dueAt`, `done`.
- **`ItBudgetLine`** — FY (`FY2026-27`), category (`licences` | `hardware` |
  `vendors` | `cloud` | `people` | `other`), division (`software` | `skill`
  | `education` | `shared`), kind (`run` | `grow`), `planned`
  (`Decimal(18,2)`), `bookCategoryIds` (the finance `LedgerCategory` ids
  whose books rows are this line's actuals), status (`draft` | `approved`).
  **Actuals are never stored** — `computeBudgetActual` sums `Transaction`
  (outward, dated inside the FY window) and `VendorBill` (dated inside the
  FY window) rows whose `categoryId` is in `bookCategoryIds`, narrowed to
  the current tenant, the line's division when one is set, and — for
  `VendorBill` — to `status in (open, part_paid, paid)`: a `draft` bill is
  not yet a commitment and a `cancelled` one never was, so neither counts as
  spend (the same live-bill set `domains/books.ts` reads). Approving needs
  `it_budgets:approve` and is refused to the line's own `createdById` by
  hand — the proposer never approves, even when a line has no
  commercial-value gate of its own to run `evaluateApprovalGate` against.
- **`ItTechDebtItem`** — title, `applicationId`, severity (`low` | `medium`
  | `high` | `critical`), `effortDays`, `interest` (what it costs to leave,
  in words), status (`open → planned → in_progress → retired | accepted`,
  `accepted` can be `RETIRE`d or `REOPEN`ed), `initiativeId` (the initiative
  that retires it, once funded).
- **`ItPortfolioSetting`** — the dated-threshold table (Principle 4):
  `stale_initiative_days` (21), `budget_burn_margin_pct` (15), `themes`.
  Upserted by `seedPortfolio`, read by `getSetting(key, fallback)` as the
  row with the latest `effectiveFrom` not in the future.

### Why `platform/lifecycle.ts`'s `transition()` is not used directly

`transition()` now takes an `eventPrefix`/`impactDomain`, so it can carry
`kz.it.*` events too. This workstream still runs its own local
assert/audit/emit rather than calling it, because `APPROVE` (`assessed ->
approved`) needs the gate branch — `evaluateApprovalGate`, returning
`{ applied: false, reason, approvalStepId, ... }` on an unpermitted step
rather than throwing — which `transition()` does not run; every other
transition would still need its own path beside it. The state-machine
mechanics (`can`/`apply`, `availableTransitions`) come from the machines in
`@kaizen/shared`; the five steps `transition()` runs elsewhere run here
under the correct `IT_*` event names.

### Spend to date and licences

An initiative's `spendToDate` sums `VendorBill.total` for the ids in
`vendorBillIds` that exist in `main.prisma`, scoped to the current tenant
and to live, real-spend bills (`status in (open, part_paid, paid)`,
`deletedAt: null`) — the same rule `computeBudgetActual` applies.
`licenceIds` is carried on the model per the plan, but is not read into
spend today: `ItLicence` is another workstream's model and may not exist at
typecheck time, so reading it unsafely would break this workstream's
ability to compile standalone. **Licence spend joins later**, once the
licence workstream's model is stable — the field is already there to join
against.

### Money masking — `it_budgets:F`

The Operations Head holds `it_budgets:VCE` — view, create, edit — but not
`F` (financial); the Finance Head and the chairman hold both. A budget
line's `planned`/`actual`/`variance`, a FY's `plannedTotal`/`actualTotal`,
and an initiative's `spendToDate` are all budget money in this sense, and
are withheld — `null`, present-but-masked, never a silently zeroed figure —
from a caller who does not hold `it_budgets:F`, checked with
`canSeeMoney('it_budgets')` (`platform/permissions.ts`). None of these
field names are in the platform's shared `MONEY_FIELDS` list, so
`applyFieldVisibility` would not mask them on its own; `maskBudgetMoney` in
`domains/it/portfolio.ts` is a small manual masker keyed to this
workstream's own field names, deep-walked (a budget summary nests money
inside `byCategory`/`byDivision`) the same way `maskContractMoney` in
`domains/it/vendors.ts` masks a vendor contract's `value`. `runTotal`,
`growTotal` and a division's `run`/`grow` are not masked — the run/grow
split is a planning shape, not a figure the Finance Head alone signs off.
The web `ItBudget` and `ItInitiativeDetail` pages check
`can('it_budgets:F')` and render `Withheld` in place of a masked value,
collapsing the budget table's Planned/Actual/Variance columns into a single
"Money" column when it is absent.

## What the platform does and does not do

- It computes a budget line's actual and an initiative's spend to date from
  linked books rows every time anyone asks. It never stores either — a late
  bill moves the variance the next time the screen is opened, with nothing
  to reconcile.
- It does not allocate money, pay a vendor, or reconcile a bank statement —
  that is the books' job, linked to by id.
- It does not forecast a budget past the FY it is planned for, and it does
  not roll a line forward automatically — a new FY is a new line.
- "Not yet measured" is reported, not a zero, when a tenant has no
  initiatives, no budget lines for a FY, or no technical-debt items.

## API — mounted at `/api/it`

| Method | Path | |
|---|---|---|
| `GET` | `/initiatives?stage=&theme=&rag=` | list |
| `GET` | `/initiatives/summary` | `ItPortfolioSummary` (below) |
| `POST` | `/initiatives` | create (`it_initiatives:create`) |
| `GET` | `/initiatives/:id` | detail, with `spendToDate` (`number \| null`, masked without `it_budgets:F`) and `availableTransitions` |
| `POST` | `/initiatives/:id/transition` | `{ event, note? }` → `{ applied, initiative, approvalStepId, reason }` |
| `GET` | `/initiatives/:id/updates` | list |
| `POST` | `/initiatives/:id/updates` | `{ body, rag }`, append-only |
| `GET` | `/roadmap`, `/roadmap/items` | list (`?quarter=&theme=`) |
| `POST` | `/roadmap/items` | create |
| `POST` | `/roadmap/items/:id/done` | `{ done? }` (extra, not in the plan's endpoint list, mirrors the model's `done` field) |
| `GET` | `/budget?fy=FY2026-27` | `BudgetForFy` — every line for the FY with `actual`/`variance` computed, money masked without `it_budgets:F` |
| `GET` | `/budget/summary?fy=` | `ItBudgetSummary` (below); `fy` defaults to the FY containing today; money masked without `it_budgets:F` |
| `POST` | `/budget/lines` | create (`it_budgets:create`) |
| `GET` | `/budget/lines/:id` | detail, with `actual`/`variance`, money masked without `it_budgets:F` |
| `PATCH` | `/budget/lines/:id` | edit `planned`/`division`/`bookCategoryIds` (extra, matches the `E` verb every role with `it_budgets` holds) |
| `POST` | `/budget/lines/:id/approve` | `it_budgets:approve`, refused to the line's own creator |
| `GET` | `/tech-debt?status=&severity=&applicationId=` | list |
| `GET` | `/tech-debt/summary` | `ItTechDebtSummary` (below) |
| `POST` | `/tech-debt` | create |
| `GET` | `/tech-debt/:id` | detail, with `availableTransitions` |
| `POST` | `/tech-debt/:id/transition` | `{ event, note? }` |

### Summary shapes

```ts
// GET /it/initiatives/summary
interface ItPortfolioSummary {
  notYetMeasured: boolean;
  byStage: Record<'idea'|'assessed'|'approved'|'in_flight'|'delivered'|'benefits_realised'|'cancelled', number>;
  byRag: { green: number; amber: number; red: number; total: number; worst: 'green'|'amber'|'red'|null };
}

// GET /it/budget/summary
// planned/actual/variance/plannedTotal/actualTotal are `null` — present but
// withheld — for a caller without `it_budgets:F`. runTotal/growTotal/run/grow
// are never masked.
interface ItBudgetSummary {
  notYetMeasured: boolean;
  fy: string | null;
  plannedTotal: number | null;
  actualTotal: number | null;
  byCategory: Array<{ category: string; planned: number | null; actual: number | null; variance: number | null }>;
  byDivision: Array<{ division: string; planned: number | null; actual: number | null; variance: number | null; run: number; grow: number }>;
  runTotal: number;
  growTotal: number;
}

// GET /it/tech-debt/summary
interface ItTechDebtSummary {
  notYetMeasured: boolean;
  bySeverity: Record<'low'|'medium'|'high'|'critical', number>;
  openCount: number;
}
```

## Jobs (`apps/api/src/jobs/it/portfolio.ts`, exported in `JOBS`)

- **`runStaleInitiativeJob`** (daily, 07:00) — an `in_flight` initiative
  with no `ItInitiativeUpdate` in `stale_initiative_days` (21, seeded)
  raises `IT_INITIATIVE_STALE` on the initiative's `ownerPartyId`, once
  (`staleNotifiedAt`), cleared the moment a fresh update lands.
- **`runBudgetBurnJob`** (daily, 07:30) — an `approved` budget line whose
  spend is running ahead of the FY's own elapsed fraction by more than
  `budget_burn_margin_pct` (15%, seeded) raises `IT_BUDGET_BURN` on the
  line's `createdById` (falling back to the active Operations Head
  affiliation), once per FY per line — a line covers exactly one FY, so
  `burnNotifiedAt` alone is the idempotency marker.

## Acceptance

| ID | Test |
|---|---|
| IT-INI-001 | `IT-INI-001: approving an initiative one sponsors reroutes on the Self-Dealing Bar` and `IT-INI-001: a Finance Head approving an initiative they did not sponsor is never flagged self-dealing` |
| IT-INI-002 | `IT-INI-002 (arithmetic): benefits_realised is reachable only through delivered, never directly from in_flight` and `IT-INI-002: a stage transition the machine has no arrow for is refused by the API, not silently accepted` |
| IT-BUD-001 | `IT-BUD-001: a budget line's actual is a live sum over the books, and a late bill moves the variance without editing the line` |
| IT-BUD-002 | `IT-BUD-002 (arithmetic): burnAhead exceeds only once spend outruns the elapsed clock by more than the margin` and `IT-BUD-002: the burn detector fires once per FY margin crossing, and a second run raises nothing new` |

Plus permission tests: the Finance Head cannot create an initiative (holds
`V,approve` only); the Operations Head proposes a budget line and cannot
approve it (holds `VCE`, no `approve`); a budget line's own creator can
never approve it even holding the grant (self-dealing bar applied by hand);
the employee reaches nothing on `it_initiatives`, `it_budgets` or
`it_tech_debt` — no grant at all; the Operations Head gets every budget
money field masked (`null`) on `budgetForFy`, `budgetSummary` and
`budgetLineDetail` (holds `it_budgets:VCE`, not `F`), and a bill in
`draft`/`cancelled` status never counts toward a budget line's actual
(IT-BUD-001).

Routes validate `category`, `kind` and `severity` with `z.enum` against the
shared `IT_BUDGET_CATEGORIES`/`IT_BUDGET_KINDS`/`IT_TECH_DEBT_SEVERITIES`
constants (and `theme` against `IT_THEMES`), so an unrecognised value is a
400 at the edge, not a row the domain layer has to reject later.

## Web

- **Portfolio** (`/it/portfolio`) — kanban columns by stage with a RAG chip
  on each card, tabs by theme, a New initiative modal with an inline
  sponsor/owner search (built the same way `NewEnrollment`'s contact search
  is in `createForms.tsx`, against `GET /hr/employees`).
- **Initiative detail** (`/it/portfolio/:id`) — business case, budget vs
  spend to date (`Withheld` in place of the figure when `spendToDate` comes
  back `null`), the updates feed with a post-update form (body + RAG),
  transition buttons from `availableTransitions`, and the same gate-result
  modal `Agreements` renders in `Commercial.tsx` when a transition opens an
  approval step instead of applying.
- **Roadmap** (`/it/roadmap`) — a quarters × themes grid, add-item modal.
- **Budget** (`/it/budget`) — FY picker, a planned/actual/variance table by
  category and division, divisions in their fixed colours via
  `DIVISION_LABELS`, a run-vs-grow `ContributionBar` per division, New line
  modal, an Approve button gated by `can('it_budgets:approve')`. Planned,
  actual and variance render as `Withheld` (the table collapses those three
  columns into one "Money" column) whenever `can('it_budgets:F')` is false —
  the Operations Head sees the run/grow split and can still propose and edit
  lines, just not the figures on them.
- **Technical debt** (`/it/tech-debt`) — list with severity/status tabs,
  New item modal, transition buttons.
