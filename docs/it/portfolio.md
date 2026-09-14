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
  the line's division when one is set. Approving needs `it_budgets:approve`
  and is refused to the line's own `createdById` by hand — the proposer
  never approves, even when a line has no commercial-value gate of its own
  to run `evaluateApprovalGate` against.
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

`transition()` composes its event name as `` `kz.hr.${object}.${verb}` ``
unconditionally — every call site today is an HR domain, and the function
has no namespace parameter. Technology's canonical events are `kz.it.*`
(`IT_INITIATIVE_TRANSITIONED`, `IT_TECH_DEBT_TRANSITIONED`, …), so this
workstream uses the state machines (`itInitiativeMachine`,
`itTechDebtMachine`) and `availableTransitions()` directly from
`@kaizen/shared`/`platform/lifecycle.ts`, and does its own
assert/audit/emit under the correct event name — the same five steps
`transition()` runs, in the right namespace. **Proposed fix, not applied**
(outside this workstream's owned files): parameterise `transition()` with
an `eventPrefix` (default `'kz.hr'`), e.g.

```diff
- eventObject: string;
+ eventObject: string;
+ eventPrefix?: string; // default 'kz.hr', so existing HR call sites are unaffected
...
- const eventName = hrTransitionEvent(input.eventObject, input.verbs[input.event]);
+ const eventName = `${input.eventPrefix ?? 'kz.hr'}.${input.eventObject}.${input.verbs[input.event]}`;
```

### Spend to date and licences

An initiative's `spendToDate` sums `VendorBill.total` for the ids in
`vendorBillIds` that exist in `main.prisma`. `licenceIds` is carried on the
model per the plan, but is not read into spend today: `ItLicence` is
another workstream's model and may not exist at typecheck time, so reading
it unsafely would break this workstream's ability to compile standalone.
**Licence spend joins later**, once the licence workstream's model is
stable — the field is already there to join against.

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
| `GET` | `/initiatives/:id` | detail, with `spendToDate` and `availableTransitions` |
| `POST` | `/initiatives/:id/transition` | `{ event, note? }` → `{ applied, initiative, approvalStepId, reason }` |
| `GET` | `/initiatives/:id/updates` | list |
| `POST` | `/initiatives/:id/updates` | `{ body, rag }`, append-only |
| `GET` | `/roadmap`, `/roadmap/items` | list (`?quarter=&theme=`) |
| `POST` | `/roadmap/items` | create |
| `POST` | `/roadmap/items/:id/done` | `{ done? }` (extra, not in the plan's endpoint list, mirrors the model's `done` field) |
| `GET` | `/budget?fy=FY2026-27` | `BudgetForFy` — every line for the FY with `actual`/`variance` computed |
| `GET` | `/budget/summary?fy=` | `ItBudgetSummary` (below); `fy` defaults to the FY containing today |
| `POST` | `/budget/lines` | create (`it_budgets:create`) |
| `GET` | `/budget/lines/:id` | detail, with `actual`/`variance` |
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
interface ItBudgetSummary {
  notYetMeasured: boolean;
  fy: string | null;
  plannedTotal: number;
  actualTotal: number;
  byCategory: Array<{ category: string; planned: number; actual: number; variance: number }>;
  byDivision: Array<{ division: string; planned: number; actual: number; variance: number; run: number; grow: number }>;
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
`it_tech_debt` — no grant at all.

## Web

- **Portfolio** (`/it/portfolio`) — kanban columns by stage with a RAG chip
  on each card, tabs by theme, a New initiative modal with an inline
  sponsor/owner search (built the same way `NewEnrollment`'s contact search
  is in `createForms.tsx`, against `GET /hr/employees`).
- **Initiative detail** (`/it/portfolio/:id`) — business case, budget vs
  spend to date, the updates feed with a post-update form (body + RAG),
  transition buttons from `availableTransitions`, and the same gate-result
  modal `Agreements` renders in `Commercial.tsx` when a transition opens an
  approval step instead of applying.
- **Roadmap** (`/it/roadmap`) — a quarters × themes grid, add-item modal.
- **Budget** (`/it/budget`) — FY picker, a planned/actual/variance table by
  category and division, divisions in their fixed colours via
  `DIVISION_LABELS`, a run-vs-grow `ContributionBar` per division, New line
  modal, an Approve button gated by `can('it_budgets:approve')`.
- **Technical debt** (`/it/tech-debt`) — list with severity/status tabs,
  New item modal, transition buttons.
