# Chairman's Office — plan

Status: planned 14 Sep 2026; built by parallel Sonnet agents on branch
`claude/affectionate-brown-t8tbdj` (the orchestrator updates this line when
phases land).

## What was asked for, and what this plan does with that

The chairman asked for "a complete, thorough, world-class, end-to-end
CEO/Founder/Chairman management module for KaiERP... look through the
existing modules and features and plan with tonnes of features." Two research
passes over the codebase (§2) found real machinery this module must sit on
top of — decisions, exceptions, health scores, approvals, the board register,
the group snapshot pattern, and half a dozen finance/HR rollup functions
already shaped like cockpit tiles — and real gaps: no OKR/goal entity, four
of the ten health domains permanently "Not yet measured," no risk register,
no investor-update artifact, no meeting-cadence entity, no headcount plan, no
DoA policy surface, no succession tracking (§2, §3). This plan builds the
gaps and wires the cockpit to the machinery that already exists, rather than
re-deriving anything the platform already computes correctly. It does not
invent a second decision model, a second approval flow, or a second
cross-tenant read path — every new screen that needs one of those reuses the
existing mechanism (§2's reuse table, §3.1–3.6).

Because this ships as many Sonnet agents working in parallel worktrees, the
whole shape of this plan — resource names, event names, DTOs, nav rows, stub
routers and stub pages — is decided once, up front, in a single Foundation
phase (§6, Phase 0), so that nine implementation phases can run at the same
time and never write to the same file. §6 is the part every implementing
agent should read as a standalone brief; §7 is the checklist every phase must
hold to; §1–§5 are the reasoning a later reader needs to understand why the
phases are shaped the way they are.

Table of contents: §1 Naming and scope, §2 What the codebase is today, §3
Decisions and the failures each prevents, §4 Feature catalogue, §5 Data
model, §6 Phases, §7 Conventions.

---

## §1 Naming and scope decisions

- **On-screen module name:** "Chairman's Office." The engineering name stays
  `ceo` everywhere in code — nav group key, route prefix, table prefix — the
  same split the codebase already keeps elsewhere (`eqt`/"Equity, Shareholder
  & Board," `xdm`/"Command Center") between the bounded-context code and the
  plain-language label a person reads.
- **Code prefix:** `ceo` (directories `domains/ceo/`, `routes/ceo/`,
  `pages/ceo/`, `components/ceo/`, schema files `ceo-<area>.prisma`).
- **Requirement prefix:** `CEO-<AREA>-NNN`. Area codes, one per phase:
  `COC` (Cockpit/Scorecard/KPI Library, Phase 1), `STR` (Strategy & OKRs,
  Phase 2), `INI` (Initiatives, Phase 3), `RHY` (Operating Rhythm, Phase 4),
  `DOA` (Delegation of Authority & Approvals Inbox, Phase 5), `BRD` (Board
  Pack, Investor Updates & Stakeholders, Phase 6), `RSK` (Risk Register,
  Policy Register & Governance Overview, Phase 7), `FIN` (Financial Planning
  & Headcount, Phase 8), `PPL` (Leadership, Org, 1:1s & Succession, Phase 9).
- **Event grammar:** `kz.ceo.<entity>.<verb>`, e.g. `kz.ceo.objective.created`,
  `kz.ceo.initiative.status_changed`, `kz.ceo.board_pack.issued`. Bounded
  context `ceo` is added to `BOUNDED_CONTEXTS` (`packages/shared/src/
  planes.ts`) with a `MODULE_REGISTER` entry (plane `P2` for the record-owning
  half, `P9`/Experience covers the cockpit read layer — the entry lists both
  in `owns`), and an explicit `neverDoes` list: never holds money movement
  (FIN owns that; this module references `Transaction`/`BudgetLine` rows, it
  never posts one), never holds statutory board records (`BoardMeeting`,
  `Resolution` stay `eqt`-owned; the new Board Pack is a narrative document
  that *cites* an `eqt` meeting, it does not replace one), never writes a
  second Decision-like record (reuses `Decision`), never reads another
  tenant's tables directly (extends `group.ts`'s snapshot pattern for any
  group-wide chairman view).
- **Nav group:** `ceo`, sidebar label `"Chairman's Office"`, inserted into
  `GROUP_ORDER` in `Shell.tsx` after `equity` and before `compliance`. Every
  `NAV_REGISTRY` row for this module sets `archetypes: ['command',
  'workspace', 'console']` explicitly — omitting it leaks the node into the
  shareholder/director portal shell (`research-web.md` gotcha 3; this module
  is ERP-only, chairman and the leadership team who work inside the ERP, not
  the equity portal).
- **Who besides the chairman sees what.** The chairman is superadmin by data,
  not by code (`ALL_RESOURCES.map(...)` in `grants.ts:144-147` — every new
  `ceo`-module resource this plan adds automatically grants the chairman full
  access the moment it lands in `ALL_RESOURCES`; no chairman-specific grant
  rows are ever written by any phase). Below the chairman:
  - `finance_head` and `hr_ops_manager` ("Operations Head") hold `V,C,E@own`
    on OKRs, Initiatives, and Meeting instances **they own or sponsor** — an
    Operations Head who sponsors an initiative can update its RAG and
    milestones; they cannot see or edit another leader's owned records
    through this module (they may already see company-wide numbers through
    their existing Finance/HR grants — this module's `@own` scoping is about
    the *module's own records*, not about re-hiding numbers already visible
    elsewhere).
  - `finance_head` holds `V@all` on the Financial Planning area (Phase 8) —
    the annual budget, scenarios and headcount plan are Finance's own domain
    even though the Chairman's Office screen is where the chairman reviews
    them — and `C,E@own` where a budget owner is proposing their division's
    number.
  - `company_secretary` holds `V@all` on Board Pack and Investor Updates
    (Phase 6) — they compile them — but never `approve`; issuing a pack still
    requires the chairman (or whoever the DoA matrix names) to approve,
    matching the existing `equity.ts` pattern where the secretary proposes
    and the approval gate decides.
  - Every other resource in this module defaults to `chairman`-only view
    (nobody else holds a grant row) unless a phase brief in §6 says
    otherwise — a module built "with tonnes of features" for one person does
    not need every feature visible to everyone; the exceptions above are the
    ones the business genuinely needs (an Operations Head running their own
    initiative, Finance running the annual plan, the Secretary compiling the
    pack).
  - **Proposer-never-approves, applied here:** a DoA matrix change (Phase 5),
    a budget line above a division's authority ceiling (Phase 8), and an
    initiative's kill/pause decision (Phase 3) all route through
    `raiseDecision`/the approval gate rather than a direct write, exactly as
    an MoU or a share transfer does today — the person proposing the change
    is never the same person whose approval makes it effective, checked by
    the self-dealing bar in `approvals.ts`, not by convention.

---

## §2 What the codebase is today, and what this reuses

**Tenancy, permissions, events — unchanged, extended, never re-derived.**
`assertCan`/`assertScopeAll` (`apps/api/src/platform/permissions.ts:317,396`)
gate every domain function; the tenant gate in `platform/db.ts` throws before
any unscoped query reaches the database, and this module adds no exception to
that — a chairman's group-wide roll-up (if any Phase needs one) is built on
`group.ts`'s snapshot-publish pattern (`apps/api/src/domains/group.ts:203-
371`, and the `EQT-GRP-001` source-grep test asserting `unscopedPrisma` never
appears outside the marked publisher section), never a new cross-tenant read.
`emit()` (`platform/eventBus.ts`) writes the hash-chained event log; this
module's events use the `kz.ceo.*` grammar (§1) and are added to `EVENTS` in
`packages/shared/src/events.ts`. New resources go in **both**
`packages/shared/src/permissions.ts`'s `RESOURCES` array and
`apps/api/src/seed/grants.ts`'s `ALL_RESOURCES` — a parity test asserts they
agree, so a resource declared in one and not the other fails CI, not review.

**Decisions — reused, never forked.** `apps/api/src/domains/decisions.ts`:
`raiseDecision()` (:42), `decisionQueue()` (:163-207, already surfaced at
`GET /command/decisions` and rendered by `CommandCenter.tsx`'s "Waiting on
your decision" strip and by `Decisions.tsx` at `/command/decisions`),
`disposeDecision()` (:221-360, the four dispositions decide/delegate/defer/
request_evidence), `reviewDecision()` (:366-396, requires a `Lesson` **and** a
`changeCommitment` to close the loop), `decisionCalibration()` (:402-424).
**This module never writes a second "what did we decide" table.** A meeting
minute that records a real decision (Phase 4), a kill/pause on an initiative
(Phase 3), a DoA matrix change (Phase 5), or a material KPI-definition change
(Phase 1) all call `raiseDecision`/`disposeDecision` with `subjectType`
pointing at the CEO-module record; the module's own screens then show that
`Decision`'s state and link back to `/command/decisions/:id` for the full
evidence pack rather than re-rendering it. **`/command/decisions` stays
exactly where it is** — the new "Decision Log" screen this module could show
(if any phase wants one) is a filtered *view* over the same `Decision`
records (e.g. `subjectType` in a CEO-module set), never a parallel list.

**Exceptions — reused as the only attention mechanism.**
`apps/api/src/platform/exceptions.ts`: `raiseException(input)` (:57-147, the
four-property test at :51-55: abnormal, actionable, owned, consequential),
`acknowledgeException`/`resolveException`/`escalateException` (:149/163/178).
Every new detector this module adds (an overdue check-in, a stalled
initiative, an unreviewed risk, a compliance deadline the chairman owns) is a
plain function that queries for the bad condition and calls `raiseException`
with a unique `triggerFingerprint` — the pattern named in
`research-executive.md` §4's closing note, copied from `detectOverdue
Payments()` (`finance.ts:397-443`). No phase edits `exceptions.ts` itself;
each phase's detectors live in its own file (§6, Phase 0's stub-registration
mechanism) and are called through it.

**Health scores — four domains are stubbed and waiting.**
`apps/api/src/domains/health.ts`: `computeDomainHealth()` (:217-371) has real
implementations for `H_COM`, `H_FIN`, `H_EDU`, `H_DLV`, `H_OPS`, `H_RSK`, but
**no branch at all** for `H_STR` (Strategy), `H_PPL`, `H_MKT`, `H_CUS` — these
four permanently render `notYetMeasured()` (`{score:null, band:null,
state:'not_yet_measured'}`, never a bare zero). Phase 1 is the only phase
that may edit `health.ts`, and wires the `H_STR` case (§6, Phase 1) — the
cockpit's own north-star/KPI data is enough to compute a first cut of
"are the long bets moving" without depending on OKRs/Initiatives, which land
in parallel in Phases 2–3. `H_PPL`/`H_MKT`/`H_CUS` stay stubbed; this plan
does not attempt them (out of scope — People/Marketing/Customer health needs
work outside this module's remit and should not block it).

**Finance rollups — import, never re-derive.** All in
`apps/api/src/domains/books.ts`: `profitAndLoss(period)` (:1168),
`monthlyTrend(months)` (:1231), `cashPosition(months)` (:1264, `runwayMonths`
is `null` when not burning, never `Infinity`), `cashForecast(months)`
(:1295), `budgetVariance(period)` (:816, actual re-summed from `Transaction`s
on every read), `setBudgetLine(input)` (:764). `employment.ts:
headcountByDivision()` (:1001). `payroll.ts: payrollCostByDivision()` (:270),
`payrollTrend()` (:291). `opportunities.ts: forecastRollup({blended})`
(:418). `equity.ts: capTable(asOf?)` (:1302). Phase 1's cockpit and Phase 8's
financial planning both **import these functions directly** — the existing
reuse pattern (`group.ts:60,217-225,568-569`; `compliance/tax.ts:761-768`) —
and never re-sum a `Transaction` table themselves.

**Approvals — reused for the approvals inbox and everywhere a "who signs
off" question comes up.** `apps/api/src/platform/approvals.ts`:
`DEFAULT_APPROVAL_POLICY`, the self-dealing bar (`actor.principal_id !=
subject.owner_id`), the tiered `approverResolution` ladder, and the rule that
`edit` never confers `approve`. Phase 5's "Chairman's approvals inbox" is a
**read-model** that queries every domain's own pending-approval rows
(pending vendor bills, pending share transactions, pending MoUs, any
CEO-module item awaiting a decision) and renders them in one place; every
*action* taken from that inbox calls the *owning* domain's own approve
function (`equity.approveShareTransaction`, `finance.payVendorBill`, etc.) —
the inbox never grows its own parallel approve code path.

**Board — the statutory layer stays statutory.** `apps/api/src/domains/
board.ts` already owns `BoardMeeting`, `Resolution`, `BoardPackItem` (a
per-meeting *file attachment* list, not an authored deck — confirmed absent
as a synthesized document, `research-executive.md` §2 row "board pack").
Phase 6's Board Pack is a new, generated/authored document (auto-filled
sections from ERP figures + narrative blocks) that **cites** a `BoardMeeting`
by id and can itself become one of that meeting's `BoardPackItem` attachments
once issued — it does not touch `board.ts`'s tables, and `/equity/board`
stays the place statutory meeting/resolution records live.

**Group — the only cross-tenant read pattern in the codebase.**
`group.ts`'s snapshot publish/read split (§2 above) is the pattern to extend,
never re-invent, for anything in this module that would otherwise want a
holding-company-wide view (e.g. a consolidated cockpit across subsidiaries).
No phase in §6 currently needs this — flagged here so a later phase does not
reach for `unscopedPrisma`.

**Prisma schema — confirmed multi-file pickup.** `apps/api/package.json`
carries `"prisma": {"schema": "prisma/schema"}` — any `.prisma` file dropped
into `apps/api/prisma/schema/` is picked up automatically by `prisma
generate`/`prisma db push`, the same way the eight `compliance-*.prisma`
files already are. Each phase's `ceo-<area>.prisma` file needs no wiring
beyond existing.

---

## §3 Decisions, and the failures each one prevents

**3.1 Issued board packs and investor updates are immutable documents; a
correction is a new version.** `Phase 6 files.` A `BoardPackVersion`/
`InvestorUpdateVersion` moves `draft → issued`; once issued its content is
frozen (matching `documents once issued are history`, the house rule already
applied to invoices and share certificates). *Why:* a board member or
investor who quotes a number from a pack that was quietly edited after
circulation is the exact failure this house convention exists to prevent
elsewhere; a "corrected" pack is a new numbered version that supersedes, not
replaces.

**3.2 KPI values are computed from ERP figures with visible lineage; manual
KPIs are allowed but permanently labelled as manual, never rendered
identically to a computed one.** `Phase 1.` Every `KpiValue` row carries
either a `formulaVersionId` + `sourceLineage` (computed) or `enteredById` +
`manualNote` (manual) — the screen shows a small "manual entry" tag on the
latter forever, it is never promoted to look computed just because it has
been entered a few times. *Why:* the failure this prevents is a dashboard
number that looks authoritative because it sits next to real computed ones,
when it is actually one person's typed estimate nobody can audit.

**3.3 "Not yet measured" is distinct from zero and distinct from withheld,
on every tile this module renders — reusing the exact three-state convention
`research-web.md` §5 documents.** `All phases, especially 1.` *Why:* a KPI
with no data source wired and a KPI genuinely reading zero are opposite
facts (the first means "we don't know," the second might mean "revenue is
actually zero this month" or "good, zero open risks") — collapsing them to
the same rendering is how a founder stops trusting the dashboard, or worse,
reads silence as good news.

**3.4 The DoA matrix is *data* linked to `AuthorityGrant`, never a second
threshold hardcoded in route code.** `Phase 5.` A `DoaMatrixEntry` row names
a decision class and an authority ceiling, and **displays** the ceiling that
`AuthorityGrant`/`resolveAuthorityCeiling` (the mechanism `decisions.ts`'s
`AwaitingAuthority` state and `approvals.ts` already use) actually enforces —
the DoA screen is a legible *view* of grants that already exist, with an edit
path that writes a new `AuthorityGrant`, not a separate ceiling field
somewhere else that could silently diverge from the one actually checked.
*Why:* two copies of "who can approve up to what" — one enforced, one merely
displayed — inevitably drift, and the displayed one becomes the one people
trust while the enforced one is the one that actually decides.

**3.5 No CEO-module domain function compares a role slug.** `All phases.`
Narrowing is grants and scope resolvers only, matching the platform-wide
source-grep test (`CRM-FOUND-004`) that already fails a PR containing a
literal role-slug comparison. *Why:* the whole grant model exists so "what
can the Operations Head see" is answered by reading one matrix, not by
grepping every domain file for `if (role === 'hr_ops_manager')`.

**3.6 No cross-tenant reads.** `All phases.` Every phase's queries stay
inside the scoped `prisma` for the acting tenant; nothing in this module
calls `unscopedPrisma`. *Why:* §2's closing note — it would be the first new
code path (outside `group.ts`'s marked publisher section) where a request in
one tenant reads another's rows, and the next feature after this one would
be tempted to reuse it.

**3.7 Scenario planning stores assumptions, not a copy of the ledger.**
`Phase 8.` A `FinancialScenario` row holds parameters (growth rate, hiring
pace, pricing change, funding timing) and a **pure projection function**
computes the resulting P&L/cash/runway from those parameters plus the live
`cashPosition()`/`budgetVariance()` figures — it never forks or duplicates
`Transaction` rows. *Why:* two versions of "the books" that can drift and
both be quoted in a board meeting is worse than no scenario tool at all;
a scenario must always be reproducible from (assumptions + today's real
figures), never a frozen copy that silently goes stale.

**3.8 Meeting decisions flow into the existing `Decision` record, never a
second decision-like model.** `Phase 4.` Restated concretely: the "Decisions
captured in-meeting" feature (area 6, feature 7) calls `raiseDecision` with
`subjectType: 'meeting_decision'`, `subjectId` pointing at the
`MeetingInstance`, and stores the returned `Decision.id` on a
`MeetingDecisionLink` row — the meeting screen shows the decision's live
state by reading `Decision`, not by storing its own copy of "what we
decided." *Why:* §2's reuse rule, made concrete for the one place a new
"decision-shaped" record would be most tempting to invent from scratch.

**3.9 The approvals inbox is a read-model; actions call the owning domain.**
`Phase 5.` Restated concretely from §2: the inbox's `GET` handler unions
pending rows from several domains' own tables (it does not own a table of
its own beyond a thin index for sort/filter performance if needed); its
`POST` action handlers are thin wrappers that call
`equity.approveShareTransaction`/`finance.payVendorBill`/`decisions.
disposeDecision`/etc. directly. *Why:* a second approve/reject code path
duplicates every permission check, audit write, and self-dealing bar the
owning domain already has — and the two paths will diverge the first time
one of them is patched and the other is not.

**3.10 Proposer never approves, applied structurally, not by convention.**
`Phases 3, 5, 8.` A DoA matrix change, a budget line above a division's
authority ceiling, and an initiative kill/pause all route through
`raiseDecision`/the approval gate with the proposer's own approval refused by
the self-dealing bar — the same mechanism §1's "who sees what" section
names. *Why:* this is the platform's own stated design rule (area-A feature
catalogue's closing "Design Rules for a Founder Dashboard," rule 5) made
enforceable rather than aspirational: self-approval must be structurally
disallowed, not merely discouraged by a UI hint.

---

## §4 Feature catalogue

Tags: **[M]**ust (must ship, and must be buildable within the phase brief in
§6), **[S]**hould, **[C]**ould (a phase may cut a Could if time runs short;
Musts may not be cut). Phase number in brackets after the area heading.

### 4.1 Cockpit, Company Scorecard, KPI Library, "Since you last looked" [Phase 1]

- [M] North-star metric tile(s) — 1–3 metrics, current value, trend, target.
- [M] "Since you last looked" digest — diffs every cockpit number against
  the chairman's last-session snapshot, grouped by domain.
- [M] 10-domain health strip reusing `latestPulse()`; click-through to
  `/command/health/:domainCode` (unchanged).
- [M] Attention feed embedded (top-N from the existing attention queue).
- [M] Open Decisions strip (top-N from `decisionQueue()`, links to
  `/command/decisions`).
- [M] KPI Library: definition, plain-English text, formula, unit, owner,
  mandatory data-lineage before a KPI can show a live number.
- [M] "Not yet measured" state on every KPI/tile with no wired source (§3.3).
- [M] Company scorecard grid — KPIs with actual vs target vs last period,
  RAG, owner.
- [S] Historical KPI value series, immutable once its period closes.
- [S] Runway & cash tile (reads `cashPosition`/`cashForecast`).
- [S] Cap table snapshot tile (reads `equity.capTable`).
- [S] Compliance calendar tile (next 3 due dates, reads compliance calendar).
- [S] Drill-to-evidence on every number (one or two clicks to source rows).
- [S] Division/consolidated toggle (Software/Skill/Education/consolidated).
- [S] Versioned KPI formula changes — old values keep the formula that
  produced them.
- [S] Vanity-metric flag — a KPI with no consumer (no OKR/initiative/decision
  referencing it) is flagged for review, not hidden.
- [S] Cross-domain composite KPI formulas with multi-source lineage.
- [S] KPI-to-consumer map (which OKRs/dashboards/meetings reference it).
- [C] Custom pinboard — chairman pins any metric onto a personal layout.
- [C] Board-ready export of the cockpit (PDF snapshot).
- [C] Formula sandbox — preview a formula against history before publishing.
- [C] Anomaly-flag note (human review only, never auto-corrects).

### 4.2 Strategy & OKRs [Phase 2]

- [M] Vision statement — current text, effective-from, full version history.
- [M] 3-Year Picture — target-state record for a future FY, one active
  version.
- [M] Annual Operating Plan (AOP) per FY, per division, linked to `budget`
  data (reads `BudgetLine`/`budgetVariance`, never forks it).
- [M] Strategic Themes list, each with a rationale and an owner.
- [M] Objective record — title, owner, level (company/division/team/
  individual), parent link, theme link, cycle.
- [M] Key Result record — metric or milestone type, weight, optional binding
  to a KPI Library entry (auto-updating current value).
- [M] Alignment tree — company objectives fanning to division/team/
  individual; unaligned OKRs flagged.
- [M] Check-in cadence — weekly/bi-weekly KR updates with confidence.
- [M] Cycle lifecycle: draft → committed → active → scoring → closed.
- [M] End-of-cycle scoring with required self-assessment note.
- [S] Theme → Initiative → OKR linkage; unlinked items flagged.
- [S] Plan approval via `raiseDecision` (§3.10).
- [S] Version comparison (this year's AOP vs last year's).
- [S] Plan-to-actual variance, refreshed monthly, RAG per line.
- [S] Stretch vs committed flag; at-risk digest (no check-in in N days).
- [S] Draft/propose-approve on team OKRs (proposer ≠ approving senior owner).
- [S] Company OKR heat-map (objectives × quarters, coloured by score).
- [S] `H_STR` health-domain wiring (§2, §6 Phase 1 item — cross-referenced
  here since Strategy is the natural long-term owner of the factor once
  OKR/Initiative data exists; Phase 1 ships the first cut from cockpit-owned
  data alone, per §2).
- [C] Strategic narrative memo attached to each AOP version.
- [C] Scenario draft AOPs (base/upside/downside) before one is approved.
- [C] OKR templates library by function.
- [C] Retro note per closed cycle.

### 4.3 Strategic Initiatives / Rocks Portfolio [Phase 3]

- [M] Initiative record — title, sponsor, owner, theme/objective link,
  dates, status (Not Started/On Track/At Risk/Off Track/Done/Killed).
- [M] RAG status, self-reported, required comment on Amber/Red.
- [M] Milestone list rolling to % complete.
- [M] Portfolio board view, grouped by status/theme/division.
- [M] Capital/budget allocation per initiative — linked `BudgetLine`, ₹
  allocated vs spent, variance.
- [M] Exactly one accountable owner per initiative (never a group).
- [S] Dependency links (blocks/blocked-by), surfaced as a table.
- [S] Risk notes per initiative (inline field — the company-wide, named Risk
  Register is Phase 7; this is a lightweight per-initiative list, not a
  second register).
- [S] Kill/pause requires a linked `Decision` record (§3.10).
- [S] Weekly delta digest feeding the cockpit's "since you last looked."
- [S] Portfolio capital summary vs AOP capex/opex.
- [S] Initiative → KPI impact tag, checked post-completion.
- [C] EOS-style quarterly "Rocks" mode per leadership member.
- [C] Stage-gate model (Discovery → Build → Launch → Scale).
- [C] Post-initiative retrospective, archived read-only.
- [C] Resource-contention alert across Red initiatives.

### 4.4 Operating Rhythm — L10 / MBR / QBR / Annual Planning [Phase 4]

- [M] Meeting type templates (Weekly Leadership, MBR, QBR, Annual Planning).
- [M] Issues List — persistent, cross-meeting, carried automatically if
  unresolved.
- [M] To-Do tracker — owner, due date, status, linked to source meeting.
- [M] Attendance record per instance.
- [M] Minutes capture per agenda item, editable until closed, then read-only.
- [M] Decisions captured in-meeting via `raiseDecision` (§3.8).
- [S] Scorecard auto-pull from KPI Library.
- [S] Rock/initiative review section, auto-listing attendees' owned items.
- [S] Meeting rating (1–10), trended.
- [S] Recurring series with generated instances, independently editable.
- [S] Pre-read/evidence attachment, visible to invitees before start.
- [S] Cross-meeting to-do rollup for one owner.
- [S] Meeting-to-OKR linkage — a live check-in updates the OKR module.
- [C] Meeting history full-text search.
- [C] External guest/observer attendee type, restricted visibility.
- [C] Issue-aging alert into the attention queue.

### 4.5 Delegation of Authority & Approvals Inbox [Phase 5]

- [M] DoA matrix — decision class, role, authority ceiling as a legible view
  over real `AuthorityGrant` rows (§3.4), never a second threshold.
- [M] DoA change requires `raiseDecision`, proposer ≠ approver (§3.10).
- [M] Approvals inbox — cross-domain read-model over every pending-approval
  row the chairman (or a delegate) can act on.
- [M] Inbox actions call the owning domain's function, never a parallel path
  (§3.9).
- [M] "Why this is here" line per inbox row — which policy/ceiling routed it.
- [S] Delegation log — a general "delegate this responsibility to X until Y"
  record, independent of a raised Decision (closing the gap
  `research-executive.md` §6 item 7 names: today `Delegation` only exists via
  the `delegate` disposition on a Decision).
- [S] Filter/sort the inbox by domain, age, value, SLA.
- [S] Bulk view of "Authority in force" (links to the existing
  `/admin/agents` list already on Command Center, not re-derived).
- [C] Inbox digest (count + oldest) surfaced on the cockpit.
- [C] Historical "who approved what, when" export.

### 4.6 Board Pack, Investor Updates & Stakeholders [Phase 6]

- [M] Board Pack document — auto-filled sections from ERP figures (P&L,
  cash, headcount, KPI highlights) plus narrative blocks the secretary/
  chairman writes; draft → issued, immutable once issued (§3.1); printable
  via `documentSheet.tsx`.
- [M] Board Pack cites a `BoardMeeting` by id and, once issued, can be
  attached as that meeting's `BoardPackItem` (reuses `board.ts`, never
  forks it — §2).
- [M] Investor Update document — same draft/issue/immutable shape, its own
  template (headline metrics, narrative, asks), versioned.
- [M] Circulation & acknowledgement — who it was sent to, who has opened/
  acknowledged it.
- [M] Stakeholder Map — external stakeholders (investors, key customers,
  regulators, key partners), contact, relationship owner, last-touch date,
  next planned touch.
- [S] Section library — reusable narrative-block templates across packs.
- [S] Version comparison between two issued packs/updates.
- [S] Stakeholder engagement history (log of touches, linked documents sent).
- [S] Auto-suggested KPI highlights pulled from the KPI Library's flagged
  "external/statutory" tag.
- [C] One-click PDF bundle of the last N packs for due diligence.
- [C] Investor-specific update variant (redacted sections per recipient).

### 4.7 Risk Register, Policy Register & Governance Overview [Phase 7]

- [M] Risk Register — named risk, category, likelihood, impact, mitigation,
  owner, review date, status (open/mitigating/closed) — distinct from
  `H_RSK`, which measures whether *exceptions* are handled, not a catalogue
  of named risks (`research-executive.md` §6 item 3's confirmed gap).
- [M] Risk linked optionally to an Initiative (Phase 3) without duplicating
  the initiative's own lightweight risk notes — the register is the single
  place a *named, tracked* risk lives; an initiative's inline note may
  promote to a full register entry, never the reverse duplication.
- [M] Policy Register — business/operating policies (expense policy, WFH
  policy, data-retention policy, etc.) as versioned documents with an owner
  and a review-due date, distinct from the platform's own permission
  `Policy`/`PolicyVersion` model (which governs grants, not business
  conduct) — named `PolicyDocument` to avoid any collision.
- [M] Governance Overview screen — one page rolling up: open risks by
  severity, policies overdue for review, DoA matrix summary, board
  compliance counters (reads `board.complianceCalendar()`, never forks it).
- [S] Risk trend (opened vs closed over time).
- [S] Policy acknowledgement tracking (who has read the current version).
- [S] Risk review reminders feeding the attention queue.
- [C] Risk heat-map (likelihood × impact grid).
- [C] Policy change history diff view.

### 4.8 Financial Planning & Headcount [Phase 8]

- [M] Annual budget by division, building on existing `BudgetLine`/
  `budgetVariance` (§2) rather than a parallel budget table — this phase
  adds the *planning* layer (multi-line, multi-division authoring UI,
  approval routing) the existing single-line `setBudgetLine` lacks.
- [M] Driver-based scenarios (base/upside/downside) — assumptions only,
  never a ledger copy (§3.7); projects P&L/cash/runway from `cashPosition`/
  `profitAndLoss` plus the scenario's parameters.
- [M] Runway per scenario, and 13-week cash flow, extending `cashForecast`'s
  approach rather than re-deriving cash logic.
- [M] Headcount plan — planned headcount and compensation envelope by
  division/role, actual vs plan (reads `headcountByDivision`/
  `payrollCostByDivision`, never forks them) — closing the confirmed gap
  that headcount today is reported, never planned forward
  (`research-executive.md` §6 item 9).
- [M] Actual vs plan variance for both budget and headcount, refreshed on
  read (matching `budgetVariance`'s own "never stale" convention).
- [S] Budget line proposal → approval routing above a division's authority
  ceiling (§3.10).
- [S] Compensation envelope alert if planned hires would breach it.
- [S] Multi-year budget trend (3–5 FY).
- [C] What-if headcount-to-cash-runway interaction (adding N hires shows
  runway impact under the active scenario).

### 4.9 Leadership, Org, 1:1s & Succession [Phase 9]

- [M] Accountability Chart — org by seat/function, named owner, 3–5 key
  responsibilities, reads/writes HRM org data (`OrgUnit`/`Position`) without
  duplicating those tables — a `Seat` references a `Position`, it is not a
  second org model.
- [M] Vacant-seat flag.
- [M] 1:1 record — recurring series, structured notes, private by default.
- [M] Skip-level record — same shape, tagged, Chairman/senior-leader cadence.
- [M] Succession plan per key seat — ready-now/1yr/2yr or "none identified,"
  risk rating, review date — respects the platform's explicit prohibition on
  individual flight-risk scoring and the k≥5 anonymity floor already
  enforced in `commandCenter.ts`'s People & Capability panel (§2's People &
  Capability note): succession data is scoped `chairman`-only, never rolled
  into any unit-level aggregate a wider audience can see.
- [M] Founder/Chairman time audit — manually-logged calendar-category
  entries (strategic/1:1/operational/external/admin), weekly/monthly
  rollup — manual entry is explicit; this module has no calendar
  integration, so every entry is visibly self-reported, never inferred.
- [S] 1:1 action-item tracker, visible to both parties.
- [S] Org chart version history (seat added/removed/reassigned, diffable).
- [S] Leadership roster view — one page: seat, current rocks/OKRs, last 1:1.
- [S] Time-audit-vs-stated-priorities gap report.
- [S] Delegation log cross-check against the accountability chart (Phase 5's
  Delegation log, viewed here against seat ownership).
- [C] Seat scorecard (1–3 KPIs a seat is accountable for).
- [C] 9-box talent grid.
- [C] Engagement/pulse self-rating, trended.

---

## §5 Data model

All new models carry `tenantId`, tenant-leading indexes, a `recordCode`
where the codes below name one, `deletedAt` for soft delete, `Decimal(18,2)`
for money. Prose, not Prisma syntax — each phase writes its own
`ceo-<area>.prisma`.

**Phase 0 (shared types only — no new Prisma models; types and enums for
every area below live in `packages/shared/src/ceo.ts`).**

**Phase 1 — Cockpit & KPI Library.** `KpiDefinition` (name, definitionText,
unit, ownerId, domain, division?, status: draft/active/deprecated).
`KpiFormulaVersion` (kpiId, expression, sourceLineage: string[],
effectiveFrom, effectiveTo?). `KpiTargetBand` (kpiId, period, target,
greenMin, amberMin). `KpiValue` (kpiId, period, value, computedAt,
formulaVersionId?, state: computed/manual/not_yet_measured — immutable once
its period closes). `KpiReference` (kpiId, consumerType: okr/initiative/
meeting/cockpit, consumerId). `NorthStarMetric` (name, kpiRef, target,
cadence). `CockpitView` (ownerId, layoutConfig Json, pinnedKpiIds[],
divisionFilter?). `CockpitSnapshot` (ownerId, takenAt, tileValues Json,
state: captured/superseded) — the "since you last looked" diff base. Record
codes: `KPD` (KPI definition), `NSM` (north-star metric).

**Phase 2 — Strategy & OKRs.** `VisionStatement` (text, effectiveFrom,
version, status: draft/active/superseded). `ThreeYearPicture` (targetFy,
headlineMetrics Json, narrative, version, status). `AnnualOperatingPlan`
(fy, division, targetRevenue, targetMargin, targetHeadcount, targetCash,
status: draft/pending_decision/active/closed, decisionId?). `StrategicTheme`
(name, rationale, ownerId, status: active/retired). `PlanAssumption`
(planId, text, ownerId, reviewDate, status: holding/broken). `Objective`
(title, ownerId, level: company/division/team/individual, parentId?,
themeId?, cycleId, status: draft/committed/active/scoring/closed,
isStretch). `KeyResult` (objectiveId, type: metric/milestone, startValue,
targetValue, currentValue, unit, weight, kpiRef?, status). `CheckIn`
(keyResultId, date, value, confidence, comment, authorId — append-only).
`OkrCycle` (fy, period, status: draft/open/grading/closed, lockDate). Record
codes: `AOP`, `OBJ`, `KRS`.

**Phase 3 — Initiatives.** `Initiative` (title, sponsorId, ownerId,
themeId?, objectiveIds: string[], status, rag, startDate, targetEnd,
actualEnd?, budgetLineRef?). `InitiativeMilestone` (initiativeId, name,
dueDate, status, ownerId). `InitiativeDependency` (fromId, toId, type:
blocks/blocked_by). Record code: `INI`.

**Phase 4 — Operating Rhythm.** `MeetingSeries` (type: l10/mbr/qbr/annual,
cadence, templateId, participantGroup). `MeetingInstance` (seriesId, date,
status: scheduled/in_progress/closed, attendees Json, ratingAvg?).
`AgendaItem` (instanceId, section, notes, order). `IssueItem` (title,
raisedById, raisedDate, status: open/solving/solved, carriedFromInstanceId?,
resolvedInInstanceId?). `ActionItem` (title, ownerId, dueDate, status,
sourceInstanceId). `MeetingDecisionLink` (instanceId, decisionId — §3.8).
Record code: `MTG`.

**Phase 5 — DoA & Approvals.** `DoaMatrixEntry` (decisionClass, roleSlug,
authorityGrantRef — points at the real `AuthorityGrant` it displays, never a
second ceiling field, §3.4). `DelegationLog` (fromPartyId, toPartyId,
responsibility, until, status: active/ended, sourceDecisionId?). The
approvals inbox itself has no table of its own beyond an optional thin index
for sort/filter (§3.9) — it reads existing tables. Record code: `DOA`.

**Phase 6 — Board Pack, Investor Updates & Stakeholders.** `BoardPack`
(meetingId — references `eqt.BoardMeeting`, title). `BoardPackVersion`
(packId, version, sections Json, status: draft/issued, issuedAt?,
issuedById?). `InvestorUpdate` (title, periodLabel). `InvestorUpdateVersion`
(updateId, version, sections Json, status: draft/issued, issuedAt?).
`DocumentCirculation` (versionId (either kind), recipientPartyId, sentAt,
openedAt?, acknowledgedAt?). `Stakeholder` (name, kind: investor/customer/
regulator/partner, contactPersonId?, relationshipOwnerId, lastTouchAt?,
nextPlannedTouchAt?). `StakeholderTouch` (stakeholderId, date, note,
documentRef?). Record codes: `BPK`, `IVU`.

**Phase 7 — Risk, Policy & Governance.** `RiskItem` (title, category,
likelihood, impact, mitigation, ownerId, reviewDate, status: open/
mitigating/closed, initiativeRef?). `PolicyDocument` (title, body,
ownerId, version, reviewDueDate, status: draft/active/superseded) — named to
avoid collision with the platform's existing `Policy`/`PolicyVersion`
(permission policies, unrelated). `PolicyAcknowledgement` (policyDocumentId,
partyId, acknowledgedAt). Record codes: `RSK`, `PLY`.

**Phase 8 — Financial Planning & Headcount.** `FinancialScenario` (name,
kind: base/upside/downside, assumptions Json — growth rate, hiring pace,
pricing change, funding timing; never a ledger copy, §3.7). `HeadcountPlan`
(fy, division, plannedHeadcount, plannedCompCost, status: draft/active).
`HeadcountPlanLine` (planId, role, plannedCount, plannedCompCost,
startMonth). Budget authoring itself extends `BudgetLine` (existing model)
rather than adding a new one — this phase adds a multi-line authoring +
approval-routing layer over it, not a new storage model. Record code: `SCN`,
`HCP`.

**Phase 9 — Leadership & Org.** `Seat` (title, function, ownerId
(Affiliation/Person ref), responsibilities: string[], status: filled/
vacant, parentSeatId?) — versioned on change (append-only history row per
change). `SuccessionCandidate` (seatId, candidateId, readiness: now/1yr/2yr,
notes, reviewedAt) — `chairman`-only view (§4.9). `OneOnOneSeries`
(managerId, reportId, cadence, isSkipLevel). `OneOnOneInstance` (seriesId,
date, notes Json, actionItems: Json[], privateFlag). `TimeAuditEntry`
(personId, category, durationMinutes, date, note?) aggregated into a
computed `TimeAuditRollup` (not stored — derived on read, like
`budgetVariance`). Record code: `SEA`.

**Events** (`kz.ceo.*`, added to `EVENTS`): one `created`/`status_changed`
(or lifecycle-appropriate verb) pair per top-level record above, e.g.
`kz.ceo.objective.created`, `kz.ceo.objective.scored`,
`kz.ceo.initiative.status_changed`, `kz.ceo.initiative.killed`,
`kz.ceo.meeting.closed`, `kz.ceo.board_pack.issued`,
`kz.ceo.investor_update.issued`, `kz.ceo.risk.raised`,
`kz.ceo.risk.closed`, `kz.ceo.policy.published`,
`kz.ceo.doa_entry.changed`, `kz.ceo.headcount_plan.approved`,
`kz.ceo.seat.reassigned`, `kz.ceo.succession.reviewed`. Phase 0 owns the
full list in `packages/shared/src/events.ts`; each owning phase emits only
its own names.

---

## §6 Phases, each a standalone brief for one Sonnet agent

Each phase is one branch, one PR, lands with tests named
`CEO-<AREA>-NNN`. **Phase 0 lands first, alone.** Phases 1–9 then run **in
parallel**, each in its own worktree, each touching only the files listed
under its own "Files:" line — never a file another phase owns. Phase 10 runs
last, after every phase 1–9 PR has merged, and is run by the orchestrator,
not by a Sonnet agent working blind.

### Phase 0 — Foundation

**Files (touches every shared file exactly once; no later phase edits any
of these again):**
- `packages/shared/src/ceo.ts` — every DTO type and enum for every phase
  below (Phase 1 through 9's records from §5, as TypeScript interfaces/enums,
  not Prisma), re-exported from `packages/shared/src/index.ts`.
- `packages/shared/src/permissions.ts` — add every new resource name from
  §6's phase lists below to `RESOURCES`.
- `apps/api/src/seed/grants.ts` — add every new resource to `ALL_RESOURCES`;
  add the non-chairman grant cells named in §1 ("who besides the chairman
  sees what") for `finance_head`, `hr_ops_manager`, `company_secretary` —
  everything else defaults to chairman-only via the existing superadmin map,
  so Phase 0 writes no other role's cells unless §1 names one.
- `packages/shared/src/events.ts` — add every `kz.ceo.*` event name from §5's
  closing list to `EVENTS`.
- `packages/shared/src/planes.ts` — add `'ceo'` to `BOUNDED_CONTEXTS`; add a
  `MODULE_REGISTER` entry per §1 (`owns` lists every §5 record name,
  `neverDoes` lists the four points in §1).
- `apps/api/src/seed/bootstrap.ts` — add one `NAV_REGISTRY` row per screen
  named in §6 phases 1–9 below (nodeKey, label, icon, path, `group: 'ceo'`,
  position 100+N, `requiredPermission`, `archetypes: ['command', 'workspace',
  'console']`, synonyms) — every path here must match the stub route added to
  `main.tsx` in the same commit (below).
- `apps/api/src/routes/index.ts` — add `router.use('/ceo', requireAuth,
  ceoRoutes)` mounting `apps/api/src/routes/ceo/index.ts`.
- `apps/api/src/routes/ceo/index.ts` (new) — imports and mounts one router
  per area: `router.use('/cockpit', cockpitRoutes)`,
  `/strategy`, `/initiatives`, `/rhythm`, `/doa`, `/board`, `/risk`,
  `/finance`, `/people` (paths chosen to match §6's per-phase route prefixes
  below). **This file is never edited again after Phase 0** — each phase
  replaces only the stub router file it owns, not this index.
- `apps/api/src/routes/ceo/{cockpit,strategy,initiatives,rhythm,doa,board,
  risk,finance,people}.routes.ts` (new, 9 files) — each a stub router: every
  route the owning phase will build returns `501 { message: 'Not built yet.'
  }` for POST/PATCH and `{ items: [] }` for GET list endpoints, so Phase 0's
  own typecheck/tests pass and the nav/route wiring is provably correct
  before any area is built. Each phase **replaces** its stub file wholesale.
- `apps/web/src/main.tsx` — import and add a `<Route>` for every screen path
  in §6 phases 1–9, pointing at a stub page component.
- `apps/web/src/pages/ceo/{Cockpit,Strategy,Okrs,Initiatives,Rhythm,Doa,
  Approvals,BoardPack,InvestorUpdates,Stakeholders,Risk,Policies,Governance,
  FinancialPlan,Headcount,Leadership,OneOnOnes,Succession,TimeAudit}.tsx`
  (new stub files, one per screen listed in §6 below) — each renders
  `<PageHeader title="..."/><Card><EmptyState message="This screen is not
  built yet."/></Card>`. Each owning phase **replaces** its own stub files;
  it may also add further files under `pages/ceo/<area>/` for sub-screens.
- `apps/web/src/components/Shell.tsx` — add `'ceo'` to `GROUP_ORDER` (after
  `'equity'`), add `ceo: "Chairman's Office"` to `GROUP_LABELS`; add any new
  `ICONS` keys the nav rows above use (check against the existing map first;
  reuse `gauge`, `target`, `kanban`, `scale`, `clock`, `file`, `shield`,
  `chart`, `alert`, `inbox` where they fit before importing a new
  `lucide-react` icon).
- `apps/api/prisma/schema/ceo-core.prisma` (new) — **only** if a later phase
  brief below explicitly says a model is shared across phases (check each
  phase's §5 entry — the plan currently keeps every model inside its owning
  phase's own `ceo-<area>.prisma` file; leave `ceo-core.prisma` empty with
  just a header comment noting that, so the filename exists for any future
  cross-phase model without requiring a schema-ownership renegotiation).
- `apps/api/src/domains/ceo/detectors.ts` (new) — imports and calls one
  detector-list export from each of nine stub files below; wires into
  `apps/api/src/jobs/scheduler.ts` (Phase 0's one edit to this file: a
  `runCeoDetectors()` job registration) so every phase's detectors run
  without any phase touching the scheduler itself.
- `apps/api/src/domains/ceo/{cockpit,strategy,initiatives,rhythm,doa,board,
  risk,finance,people}.detectors.ts` (new, 9 stub files) — each exports
  `export const detectors: Array<() => Promise<void>> = [];`. Each owning
  phase **replaces** its own file with real detector functions (§2's
  `raiseException` pattern) and adds them to the exported array; it never
  edits `detectors.ts` itself.
- `apps/api/src/domains/health.ts` — **Phase 0 does not edit this file.**
  It is reserved for Phase 1 only (§2) — noted here so no other phase reaches
  for it by habit.
- `docs/acceptance.md` — add one **"Chairman's Office"** subsection with nine
  rows, one per `CEO-<AREA>` prefix, `Tests` column `pending`, `What is
  pinned` column `pending` — **no other phase may edit this file**; the
  orchestrator fills every row in Phase 10.

**Nav rows and route paths Phase 0 must create (one row/route per screen
below; each phase's brief repeats its own subset for convenience, this is
the master list Phase 0 works from):**

| Screen | Path | nodeKey | requiredPermission | Phase |
|---|---|---|---|---|
| Cockpit | `/ceo/cockpit` | `ceo_cockpit` | `ceo_cockpit:V` | 1 |
| KPI Library | `/ceo/kpi-library` | `ceo_kpi_library` | `kpi_definitions:V` | 1 |
| Strategy | `/ceo/strategy` | `ceo_strategy` | `strategic_themes:V` | 2 |
| OKRs | `/ceo/okrs` | `ceo_okrs` | `objectives:V` | 2 |
| Initiatives | `/ceo/initiatives` | `ceo_initiatives` | `initiatives:V` | 3 |
| Initiatives detail | `/ceo/initiatives/:id` | — (same component) | — | 3 |
| Meeting Rhythm | `/ceo/meetings` | `ceo_meetings` | `meeting_series:V` | 4 |
| Meeting detail | `/ceo/meetings/:id` | — | — | 4 |
| Delegation of Authority | `/ceo/delegation` | `ceo_delegation` | `doa_matrix:V` | 5 |
| Approvals Inbox | `/ceo/approvals` | `ceo_approvals` | `ceo_approvals_inbox:V` | 5 |
| Board Pack | `/ceo/board-pack` | `ceo_board_pack` | `board_packs:V` | 6 |
| Board Pack document | `/ceo/board-pack/:id/document` | — | — | 6 |
| Investor Updates | `/ceo/investor-updates` | `ceo_investor_updates` | `investor_updates:V` | 6 |
| Investor Update document | `/ceo/investor-updates/:id/document` | — | — | 6 |
| Stakeholders | `/ceo/stakeholders` | `ceo_stakeholders` | `stakeholders:V` | 6 |
| Risk Register | `/ceo/risks` | `ceo_risks` | `risks:V` | 7 |
| Policy Register | `/ceo/policies` | `ceo_policies` | `policy_documents:V` | 7 |
| Governance Overview | `/ceo/governance` | `ceo_governance` | `risks:V` | 7 |
| Financial Plan | `/ceo/financial-plan` | `ceo_financial_plan` | `financial_scenarios:V` | 8 |
| Headcount Plan | `/ceo/headcount-plan` | `ceo_headcount_plan` | `headcount_plans:V` | 8 |
| Leadership | `/ceo/leadership` | `ceo_leadership` | `seats:V` | 9 |
| 1:1s | `/ceo/one-on-ones` | `ceo_one_on_ones` | `one_on_ones:V` | 9 |
| Succession | `/ceo/succession` | `ceo_succession` | `succession_candidates:V` | 9 |
| Time Audit | `/ceo/time-audit` | `ceo_time_audit` | `time_audit:V` | 9 |

**Tests:** Phase 0 must pass `pnpm typecheck` and the full existing suite
(629 tests) unmodified — it adds stub behaviour only, changing no existing
test's outcome. Add one smoke test per stub route confirming it returns
`501`/`{items:[]}` under a chairman principal, and one confirming every new
`NAV_REGISTRY` row's `path` matches a real route in `main.tsx` (extend the
existing nav/route consistency check if one exists, or add
`CEO-FOUND-001`..`CEO-FOUND-003` covering: every new resource appears in
both `RESOURCES` and `ALL_RESOURCES`; every new nav path resolves; the
chairman role automatically holds every new resource via the existing
superadmin map (no new chairman-specific grant rows were written by Phase
0). Aim 5–8 tests.

---

### Phase 1 — Cockpit, Company Scorecard, KPI Library

**Files:** `apps/api/prisma/schema/ceo-cockpit.prisma`,
`apps/api/src/domains/ceo/cockpit.ts`,
`apps/api/src/routes/ceo/cockpit.routes.ts` (replaces the Phase-0 stub),
`apps/api/src/tests/ceo/cockpit.test.ts`,
`apps/api/src/domains/ceo/cockpit.detectors.ts` (replaces the Phase-0 stub),
`apps/web/src/pages/ceo/Cockpit.tsx`, `apps/web/src/pages/ceo/KpiLibrary.tsx`
(replace the Phase-0 stubs), `apps/web/src/components/ceo/cockpit/*` as
needed. **Exception, granted by §2:** this is the one phase allowed to edit
`apps/api/src/domains/health.ts` — add an `H_STR` case to
`computeDomainHealth()`'s switch.

**Reads from (existing functions, by name and file — call these, never
re-derive):** `books.ts: profitAndLoss`, `monthlyTrend`, `cashPosition`,
`cashForecast`, `budgetVariance`. `employment.ts: headcountByDivision`.
`equity.ts: capTable`. `health.ts: latestPulse`, `computeDomainHealth`.
`decisions.ts: decisionQueue`. `exceptions.ts` attention rows via the same
query shape `commandCenter.ts: attentionQueue` uses (do not import
`commandCenter.ts` internals directly — call the platform layer the same
way it does, or expose a thin re-export if genuinely identical, but do not
duplicate the ranking logic).

**Build:**
1. `KpiDefinition`/`KpiFormulaVersion`/`KpiTargetBand`/`KpiValue`/
   `KpiReference` models (§5). `cockpit.ts`: `createKpiDefinition(input)`,
   `publishKpiFormula(kpiId, input)` (versions, never overwrites),
   `recordKpiValue(kpiId, period, value, {manual?})`,
   `kpiCatalog(filters)`, `kpiDetail(kpiId)` (with lineage + value history +
   consumer map), `vanityKpiReport()` (KPIs with zero `KpiReference` rows).
2. `NorthStarMetric` model + `setNorthStarMetrics(kpiRefs[])`,
   `northStarTiles()`.
3. `CockpitView`/`CockpitSnapshot` models. `cockpitSnapshot()` — takes a
   snapshot of every tile value at call time; `sinceYouLastLooked(ownerId)`
   — diffs the current tiles against the owner's most recent prior
   snapshot, grouped by domain; called once per session by the Cockpit page
   on mount, writing a fresh snapshot after computing the diff (so the next
   visit diffs against *this* visit, not itself).
4. `cockpit()` — one aggregate function (mirrors `commandCenter()`'s shape)
   returning: north-star tiles, since-you-last-looked digest, 10-domain
   health strip (from `latestPulse`), attention feed top-N, decisions strip
   top-N, scorecard grid (KPI catalog filtered to `pinnedKpiIds` or top-N by
   default), runway/cash tile, cap-table tile, compliance-calendar tile.
   Each sub-fetch independently try/caught so one failed panel does not
   blank the page (`Executive.tsx`'s `allFailed` pattern, §"Data fetching").
5. `H_STR` factor(s) in `health.ts`: at minimum
   `north_star_on_target` (north-star metrics within target band) and
   `kpi_library_coverage` (share of active KPIs with a wired data source vs
   manual/undefined) — both computable from Phase-1-owned data alone, no
   dependency on Phases 2–3's OKR/Initiative tables. `notYetMeasured()` when
   no north-star metric is set yet.
6. Detector: `KPI-STALE` — a KPI with a `refreshCadence` past due and no new
   `KpiValue` in that window raises an exception via `raiseException`
   (`cockpit.detectors.ts`).
7. Web: `Cockpit.tsx` — tile grid using `Metric`/`KpiStatus` patterns from
   `Executive.tsx`/`ui.tsx` (§"Component vocabulary"); every tile has a
   `drillTo` or `noActionReason` (`ui.tsx`'s hard rule). `KpiLibrary.tsx` —
   catalog list + create/edit dialog (its own dialog in the page file, not
   `createForms.tsx`) + detail view showing lineage/value history/consumer
   map. Empty states: `"No KPI has been defined yet."`,
   `"Nothing to compare against yet — this is your first visit."` (cockpit
   digest on a first-ever snapshot).

**Routes:** `GET /ceo/cockpit` (the aggregate), `GET /ceo/kpi-library`
(catalog), `POST /ceo/kpi-library` (create definition), `GET
/ceo/kpi-library/:id`, `POST /ceo/kpi-library/:id/formula`, `POST
/ceo/kpi-library/:id/values`, `POST /ceo/cockpit/north-star`, `POST
/ceo/cockpit/views` (save a pinboard layout).

**Grants:** `kpi_definitions: VCED` chairman-only by default (superadmin);
add `V@all` for `finance_head`/`hr_ops_manager` (they need to see the
library to bind their own OKRs to it in Phase 2) — write this cell in
Phase 0's grants.ts edit, not here. `ceo_cockpit: V` — chairman only.

**Events:** `kz.ceo.kpi_definition.created`, `kz.ceo.kpi_formula.published`,
`kz.ceo.north_star.changed`.

**Tests (aim 10–14):** `CEO-COC-001` a KPI with no formula version shows
`not_yet_measured`, never 0. `CEO-COC-002` a manual `KpiValue` is visibly
tagged and never indistinguishable from a computed one on the API response
shape. `CEO-COC-003` a `KpiValue` for a closed period is immutable (no
update route reaches it). `CEO-COC-004` `sinceYouLastLooked` diffs against
the caller's own prior snapshot, not another user's. `CEO-COC-005` a KPI
with zero `KpiReference` rows appears in `vanityKpiReport`. `CEO-COC-006`
`cockpit()` returns partial data with one panel withheld when one underlying
grant is refused, not a blanket 403. `CEO-COC-007` `H_STR` reads
`not_yet_measured` with zero north-star metrics set and a real score once
one is set. `CEO-COC-008` a non-chairman, non-finance/ops role cannot read
`kpi_definitions`. `CEO-COC-009` published formula versions are never
retroactively applied to historical `KpiValue` rows. `CEO-COC-010` tenant
isolation — a KPI in tenant A is a 404 read from tenant B.

---

### Phase 2 — Strategy & OKRs

**Files:** `apps/api/prisma/schema/ceo-strategy.prisma`,
`apps/api/src/domains/ceo/strategy.ts`,
`apps/api/src/routes/ceo/strategy.routes.ts`,
`apps/api/src/tests/ceo/strategy.test.ts`,
`apps/api/src/domains/ceo/strategy.detectors.ts`,
`apps/web/src/pages/ceo/Strategy.tsx`, `apps/web/src/pages/ceo/Okrs.tsx`,
`apps/web/src/components/ceo/strategy/*`.

**Reads from:** `books.ts: profitAndLoss`, `budgetVariance` (AOP
plan-to-actual). `decisions.ts: raiseDecision` (plan approval, §3.10).
Phase 1's `cockpit.ts: kpiCatalog`/`kpiDetail` (KR-to-KPI binding — import
the function, do not requery `KpiDefinition` directly with a second query
shape).

**Build:**
1. `VisionStatement`, `ThreeYearPicture`, `AnnualOperatingPlan`,
   `StrategicTheme`, `PlanAssumption` models (§5).
   `strategy.ts`: `setVisionStatement(text, effectiveFrom)` (versions, never
   overwrites), `setThreeYearPicture(input)`, `createAop(fy, division,
   input)`, `submitAopForApproval(aopId)` (calls `raiseDecision`),
   `activateAop(aopId)` (only after the linked `Decision` is `Implemented`),
   `createTheme(input)`, `aopVariance(fy, division)` (imports
   `budgetVariance`, never re-sums).
2. `Objective`, `KeyResult`, `CheckIn`, `OkrCycle` models. `createObjective
   (input)`, `createKeyResult(objectiveId, input)`, `checkIn(keyResultId,
   input)`, `lockCycle(cycleId)`, `scoreObjective(objectiveId, {score,
   selfAssessment})`, `alignmentTree(cycleId)` (recursive, flags orphans),
   `atRiskDigest()` (no check-in in N days or 2+ declining confidence
   readings).
3. Web: `Strategy.tsx` — vision/3-year/AOP/themes in tabs
   (`Tabs` component); AOP shows plan-to-actual RAG per line.
   `Okrs.tsx` — alignment tree view, cycle picker, check-in inline form
   (pattern: inline `<form>` per §"Forms," not a modal, matching
   `Agenda`/`VoteForm` precedent). Empty states: `"No vision statement has
   been recorded yet."`, `"This cycle has no company-level objectives yet."`

**Routes:** `GET/POST /ceo/strategy/vision`, `GET/POST
/ceo/strategy/three-year-picture`, `GET/POST /ceo/strategy/aop`, `POST
/ceo/strategy/aop/:id/submit`, `GET/POST /ceo/strategy/themes`, `GET
/ceo/strategy/aop/:id/variance`, `GET/POST /ceo/okrs/objectives`, `GET
/ceo/okrs/objectives/:id`, `POST /ceo/okrs/objectives/:id/key-results`,
`POST /ceo/okrs/key-results/:id/check-in`, `POST
/ceo/okrs/objectives/:id/score`, `GET /ceo/okrs/alignment`, `GET
/ceo/okrs/at-risk`.

**Grants:** `strategic_themes`, `objectives`, `key_results`: chairman
default; `V,C,E@own` for `finance_head`/`hr_ops_manager` on objectives/KRs
they own (§1) — written in Phase 0.

**Events:** `kz.ceo.vision.set`, `kz.ceo.aop.submitted`,
`kz.ceo.aop.activated`, `kz.ceo.objective.created`,
`kz.ceo.objective.scored`, `kz.ceo.key_result.checked_in`.

**Tests (aim 10–14):** `CEO-STR-001` an AOP cannot move to `active` while
its linked `Decision` is not `Implemented`. `CEO-STR-002` submitting an AOP
for approval and approving it as the same person is refused (self-dealing
bar via the Decision flow). `CEO-STR-003` an objective's `parent_id` cycle
(A→B→A) is refused. `CEO-STR-004` an orphaned (no theme, no parent)
objective is flagged in `alignmentTree`. `CEO-STR-005` a locked cycle
refuses new check-ins after the grading window. `CEO-STR-006` scoring an
objective without a `selfAssessment` note is refused. `CEO-STR-007` a KR
bound to a KPI auto-updates `currentValue` from the KPI's latest value, a
manual KR does not. `CEO-STR-008` `aopVariance` matches `budgetVariance`'s
own number exactly (imported, not re-derived — assert equality against a
direct call). `CEO-STR-009` a vision statement's prior version stays
readable and unedited after a new one is set. `CEO-STR-010` tenant
isolation on objectives/AOPs.

---

### Phase 3 — Strategic Initiatives Portfolio

**Files:** `apps/api/prisma/schema/ceo-initiatives.prisma`,
`apps/api/src/domains/ceo/initiatives.ts`,
`apps/api/src/routes/ceo/initiatives.routes.ts`,
`apps/api/src/tests/ceo/initiatives.test.ts`,
`apps/api/src/domains/ceo/initiatives.detectors.ts`,
`apps/web/src/pages/ceo/Initiatives.tsx`,
`apps/web/src/pages/ceo/initiatives/InitiativeDetail.tsx`,
`apps/web/src/components/ceo/initiatives/*`.

**Reads from:** `books.ts: budgetVariance` (capital allocation vs spend).
`decisions.ts: raiseDecision` (kill/pause, §3.10).

**Build:**
1. `Initiative`, `InitiativeMilestone`, `InitiativeDependency` models (§5).
   `initiatives.ts`: `createInitiative(input)`, `updateStatus(id, {status,
   rag, comment})` (comment required on Amber/Red), `addMilestone(id,
   input)`, `completeMilestone(milestoneId)` (rolls up % complete),
   `addDependency(fromId, toId, type)`, `killOrPause(id, reason)` (calls
   `raiseDecision`, blocks the direct status write until the decision is
   disposed), `portfolioBoard(filters)` (grouped by status/theme/division),
   `capitalSummary(fy)` (imports `budgetVariance` per linked
   `budgetLineRef`, sums allocated vs spent).
2. Detector: `INI-STALLED` — an initiative with no status update in N days
   raises an exception.
3. Web: `Initiatives.tsx` — board/kanban view (`Tabs` for
   status/theme/division grouping, no drag-and-drop library needed — click
   to open detail, change status there). `InitiativeDetail.tsx` — milestone
   list, dependency table, capital allocation panel, RAG history. Empty
   state: `"Nothing is being tracked as an initiative yet."`

**Routes:** `GET/POST /ceo/initiatives`, `GET /ceo/initiatives/:id`, `POST
/ceo/initiatives/:id/status`, `POST /ceo/initiatives/:id/milestones`, `POST
/ceo/initiatives/milestones/:id/complete`, `POST
/ceo/initiatives/:id/dependencies`, `POST /ceo/initiatives/:id/kill`, `GET
/ceo/initiatives/capital-summary`.

**Grants:** `initiatives`: chairman default; `V,C,E@own` for
`finance_head`/`hr_ops_manager` where they are `sponsorId`/`ownerId` (§1) —
written in Phase 0.

**Events:** `kz.ceo.initiative.created`, `kz.ceo.initiative.status_changed`,
`kz.ceo.initiative.killed`, `kz.ceo.initiative.milestone_completed`.

**Tests (aim 8–12):** `CEO-INI-001` an Amber/Red status change without a
comment is refused. `CEO-INI-002` exactly one owner is stored, never a list
(schema-level, plus a service-level assertion). `CEO-INI-003` `killOrPause`
does not change `status` until the linked `Decision` is `Implemented`.
`CEO-INI-004` a dependency cycle (A blocks B blocks A) is refused.
`CEO-INI-005` `capitalSummary` matches a direct `budgetVariance` call for
the same period (imported, not re-derived). `CEO-INI-006` a non-owner,
non-sponsor `hr_ops_manager` cannot edit another leader's initiative.
`CEO-INI-007` completing a milestone recomputes the initiative's % complete
correctly at boundary values (0/1 of N, N/N). `CEO-INI-008` tenant
isolation.

---

### Phase 4 — Operating Rhythm

**Files:** `apps/api/prisma/schema/ceo-rhythm.prisma`,
`apps/api/src/domains/ceo/rhythm.ts`,
`apps/api/src/routes/ceo/rhythm.routes.ts`,
`apps/api/src/tests/ceo/rhythm.test.ts`,
`apps/api/src/domains/ceo/rhythm.detectors.ts`,
`apps/web/src/pages/ceo/Rhythm.tsx`,
`apps/web/src/pages/ceo/rhythm/MeetingDetail.tsx`,
`apps/web/src/components/ceo/rhythm/*`.

**Reads from:** `decisions.ts: raiseDecision` (§3.8, in-meeting decisions).
Phase 1's `cockpit.ts: kpiDetail` (scorecard auto-pull, optional — build the
manual-entry path first, wire the auto-pull as the KPI Library import once
Phase 1 has landed and merged; if Phase 1 has not yet merged when this phase
is implemented, ship the manual-entry version and leave a `// TODO: bind to
KPI Library once available` comment rather than blocking on it).

**Build:**
1. `MeetingSeries`, `MeetingInstance`, `AgendaItem`, `IssueItem`,
   `ActionItem`, `MeetingDecisionLink` models (§5). `rhythm.ts`:
   `createSeries(input)`, `scheduleInstance(seriesId, date)`,
   `recordAttendance(instanceId, attendees)`, `addAgendaNote(instanceId,
   section, notes)`, `raiseIssue(input)`, `carryIssueForward(issueId,
   toInstanceId)` (automatic at instance-close time for any open issue),
   `resolveIssue(issueId, instanceId)`, `createActionItem(input)`,
   `completeActionItem(id)`, `recordMeetingDecision(instanceId, decisionId)`
   (§3.8 — links, does not create a second decision record), `closeInstance
   (instanceId)` (minutes become read-only; refuses if any agenda note is
   still being edited concurrently — last-write-wins is acceptable, no
   locking needed), `crossMeetingTodos(ownerId)`.
2. Web: `Rhythm.tsx` — series list + upcoming/past instances.
   `MeetingDetail.tsx` — agenda, issues list (carried-forward items visibly
   marked "carried from <date>"), to-dos, attendance, minutes (editable
   pre-close, read-only after), "Record a decision" inline form calling
   `raiseDecision` then `recordMeetingDecision`. Empty state: `"No meeting
   has been recorded in this series yet."`

**Routes:** `GET/POST /ceo/rhythm/series`, `GET/POST
/ceo/rhythm/instances`, `GET /ceo/rhythm/instances/:id`, `POST
/ceo/rhythm/instances/:id/attendance`, `POST
/ceo/rhythm/instances/:id/agenda`, `GET/POST /ceo/rhythm/issues`, `POST
/ceo/rhythm/issues/:id/resolve`, `GET/POST /ceo/rhythm/todos`, `POST
/ceo/rhythm/todos/:id/complete`, `POST
/ceo/rhythm/instances/:id/decisions`, `POST
/ceo/rhythm/instances/:id/close`.

**Grants:** `meeting_series`, `meeting_instances`: chairman default;
`V,C,E@own` for `finance_head`/`hr_ops_manager` on series they participate
in (§1) — written in Phase 0.

**Events:** `kz.ceo.meeting.scheduled`, `kz.ceo.meeting.closed`,
`kz.ceo.issue.raised`, `kz.ceo.issue.resolved`, `kz.ceo.action_item.
completed`.

**Tests (aim 10–13):** `CEO-RHY-001` an unresolved issue is carried to the
next instance automatically on close. `CEO-RHY-002` a closed instance's
minutes reject a further edit. `CEO-RHY-003` a meeting decision calls
`raiseDecision` and stores a `MeetingDecisionLink`, never a second decision
table. `CEO-RHY-004` `crossMeetingTodos` returns a single owner's open items
across every series they belong to. `CEO-RHY-005` an action item with no
owner is refused at creation. `CEO-RHY-006` attendance quorum flag computes
correctly for a statutory-adjacent series type if one is modelled (else
this test is dropped — note it explicitly if so, per §6's "as built"
convention Phase 10 will fold in). `CEO-RHY-007` a resolved issue does not
re-appear as carried on the next instance. `CEO-RHY-008` tenant isolation.

---

### Phase 5 — Delegation of Authority & Approvals Inbox

**Files:** `apps/api/prisma/schema/ceo-doa.prisma`,
`apps/api/src/domains/ceo/doa.ts`,
`apps/api/src/routes/ceo/doa.routes.ts`,
`apps/api/src/tests/ceo/doa.test.ts`,
`apps/api/src/domains/ceo/doa.detectors.ts`,
`apps/web/src/pages/ceo/Doa.tsx`, `apps/web/src/pages/ceo/Approvals.tsx`,
`apps/web/src/components/ceo/doa/*`.

**Reads from:** `platform/permissions.ts: resolveAuthorityCeiling` (§3.4 —
the DoA matrix *displays* this, never a second ceiling). `platform/
approvals.ts` (self-dealing bar, approver resolution ladder — the DoA
matrix's own change-approval flow reuses this shape). `decisions.ts:
raiseDecision`/`disposeDecision`. Every domain with a pending-approval
concept, read-only, for the inbox: at minimum `finance.ts`/`books.ts`
(pending vendor bills), `equity.ts` (pending share transactions),
`agreements.ts` (pending MoU/Contract/Partner Agreement approvals),
`decisions.ts` (`decisionQueue`, already pending-shaped).

**Build:**
1. `DoaMatrixEntry`, `DelegationLog` models (§5). `doa.ts`:
   `doaMatrix()` (reads every `AuthorityGrant` row grouped by decision
   class/role, joined with any `DoaMatrixEntry` narrative row), `proposeDoa
   Change(input)` (calls `raiseDecision`, never writes the
   `AuthorityGrant` directly), `applyDoaChange(decisionId)` (only after
   `Implemented`, then writes the new `AuthorityGrant`), `createDelegation
   (fromPartyId, toPartyId, responsibility, until)`, `endDelegation(id)`.
2. `approvalsInbox(filters)` — unions: pending vendor bills (import from
   `finance.ts`/`books.ts`), pending share transactions (`equity.ts`),
   pending agreement approvals (`agreements.ts`), open items in
   `decisionQueue()`. Each row carries `{domain, subjectType, subjectId,
   summary, value?, slaDueAt?, actionEndpoint}` — `actionEndpoint` names the
   *owning* domain's real route, the inbox UI POSTs there directly, not to a
   `doa.routes.ts` action handler that re-implements approval (§3.9).
3. Detector: `DOA-STALE-ENTRY` — a matrix entry pointing at a since-revoked
   `AuthorityGrant` raises an exception.
4. Web: `Doa.tsx` — matrix table (role × decision class × ceiling, using
   `words.ts`'s `grantSentence()` helper per §"Copy voice" to render each
   cell as a sentence), "Propose a change" form. `Approvals.tsx` — grouped
   inbox list, each row's action button calls the row's own
   `actionEndpoint` via a generic POST helper (not a hardcoded per-domain
   switch in the frontend — read `actionEndpoint` from the API response).
   Empty states: `"Nothing is waiting on your approval."`

**Routes:** `GET /ceo/doa/matrix`, `POST /ceo/doa/matrix/propose`, `POST
/ceo/doa/matrix/:decisionId/apply`, `GET/POST /ceo/doa/delegations`, `POST
/ceo/doa/delegations/:id/end`, `GET /ceo/approvals/inbox`.

**Grants:** `doa_matrix`, `ceo_approvals_inbox`: chairman-only default
(written in Phase 0) — this is deliberately narrow; a delegate who should
also see the inbox gets there via their own domain's existing approval
grants (e.g. `finance_head` already sees pending vendor bills through
`vendor_bills:V,approve` — the CEO inbox is a convenience aggregation for
the chairman, not a new grant of access nobody had).

**Events:** `kz.ceo.doa_entry.changed`, `kz.ceo.delegation.created`,
`kz.ceo.delegation.ended`.

**Tests (aim 8–12):** `CEO-DOA-001` `doaMatrix()`'s displayed ceiling
matches `resolveAuthorityCeiling`'s real value exactly for every role/class
pair (no drift, §3.4). `CEO-DOA-002` `applyDoaChange` refuses before the
linked `Decision` is `Implemented`. `CEO-DOA-003` the proposer of a DoA
change cannot also dispose the linked decision as `decide` (self-dealing
bar via the Decision flow). `CEO-DOA-004` `approvalsInbox` rows' actions
resolve to real, callable owning-domain routes (a live integration check,
not a hardcoded string match). `CEO-DOA-005` an inbox row for a domain the
chairman happens to hold no grant on (should not occur for chairman, but
verify for a hypothetical delegate view if one exists) never appears.
`CEO-DOA-006` a delegation past its `until` date is `ended`, not silently
still active. `CEO-DOA-007` tenant isolation.

---

### Phase 6 — Board Pack, Investor Updates & Stakeholders

**Files:** `apps/api/prisma/schema/ceo-board.prisma`,
`apps/api/src/domains/ceo/board.ts` (note: distinct from the existing
`apps/api/src/domains/board.ts` — this phase's file lives under `domains/
ceo/`, never edits the statutory `board.ts`), `apps/api/src/routes/ceo/
board.routes.ts`, `apps/api/src/tests/ceo/board.test.ts`,
`apps/api/src/domains/ceo/board.detectors.ts`,
`apps/web/src/pages/ceo/BoardPack.tsx`,
`apps/web/src/pages/ceo/board/BoardPackDocument.tsx`,
`apps/web/src/pages/ceo/InvestorUpdates.tsx`,
`apps/web/src/pages/ceo/investor/InvestorUpdateDocument.tsx`,
`apps/web/src/pages/ceo/Stakeholders.tsx`,
`apps/web/src/components/ceo/board/*`.

**Reads from:** `board.ts: listMeetings`, `meeting` (cites a `BoardMeeting`
by id, read-only). `books.ts: profitAndLoss`, `cashPosition`. `employment.ts:
headcountByDivision`. Phase 1's `cockpit.ts: kpiCatalog` (KPI highlights,
optional — same "ship without it, TODO-comment the binding" rule as Phase
4 if Phase 1 has not landed yet). `pages/documentSheet.tsx` (`Sheet`,
`SupplierBlock`, `Signature`, `rupees`) for the printable views.

**Build:**
1. `BoardPack`, `BoardPackVersion`, `InvestorUpdate`,
   `InvestorUpdateVersion`, `DocumentCirculation`, `Stakeholder`,
   `StakeholderTouch` models (§5). `board.ts` (ceo): `createBoardPack
   (meetingId, title)`, `draftBoardPackVersion(packId, sections)`,
   `autoFillSections(packId)` (pulls P&L/cash/headcount/KPI highlights into
   named sections the author then edits narrative around — this writes into
   the draft, it never runs again once issued), `issueBoardPackVersion
   (versionId)` (draft → issued, immutable, §3.1), `attachToBoardMeeting
   (versionId)` (writes a `BoardPackItem` on the cited `eqt.BoardMeeting` —
   the one place this phase touches an `eqt` table, through `board.ts`'s own
   `addBoardPackItem` function, never a raw write to its table). Same shape
   for `InvestorUpdate`/`InvestorUpdateVersion`. `recordCirculation
   (versionId, recipientIds)`, `acknowledgeReceipt(circulationId)`.
   `createStakeholder(input)`, `logTouch(stakeholderId, input)`.
2. Web: `BoardPack.tsx`/`InvestorUpdates.tsx` — version list, draft editor
   (section-by-section, auto-filled figures shown read-only with a
   "refresh figures" action only while still draft), issue button (confirms
   irreversibility in the UI copy). `BoardPackDocument.tsx`/
   `InvestorUpdateDocument.tsx` — printable, following the
   `documentSheet.tsx` pattern exactly as §"Printable documents" specifies
   (route sits above the list/detail route, per `research-web.md` §1).
   `Stakeholders.tsx` — list + touch log. Empty states: `"No board pack has
   been drafted yet."`, `"Nothing is logged as a touch with this
   stakeholder yet."`

**Routes:** `GET/POST /ceo/board/packs`, `GET /ceo/board/packs/:id`, `POST
/ceo/board/packs/:id/versions`, `POST /ceo/board/packs/versions/:id/issue`,
`POST /ceo/board/packs/versions/:id/attach`, `GET
/ceo/board/packs/versions/:id/document`, `GET/POST
/ceo/board/investor-updates`, `POST
/ceo/board/investor-updates/versions/:id/issue`, `GET
/ceo/board/investor-updates/versions/:id/document`, `POST
/ceo/board/circulation`, `POST /ceo/board/circulation/:id/acknowledge`,
`GET/POST /ceo/board/stakeholders`, `POST
/ceo/board/stakeholders/:id/touch`.

**Grants:** `board_packs`, `investor_updates`, `stakeholders`: chairman
default; `V,C@all` for `company_secretary` on `board_packs`/
`investor_updates` (they compile, never issue — §1); written in Phase 0.

**Events:** `kz.ceo.board_pack.issued`, `kz.ceo.investor_update.issued`,
`kz.ceo.document.circulated`, `kz.ceo.document.acknowledged`,
`kz.ceo.stakeholder.touched`.

**Tests (aim 10–14):** `CEO-BRD-001` an issued version's content is
byte-identical (deep-equal) after a later edit attempt is refused.
`CEO-BRD-002` `company_secretary` can draft and cannot call `issue`.
`CEO-BRD-003` `autoFillSections` never runs against an already-issued
version. `CEO-BRD-004` attaching an issued pack writes a real
`BoardPackItem` on the cited `eqt.BoardMeeting`, verified by reading it back
through `board.ts`'s own `boardPack()` function. `CEO-BRD-005` a
`BoardPack` citing a nonexistent `BoardMeeting` id is refused at creation.
`CEO-BRD-006` circulation acknowledgement is per-recipient and does not
leak to other recipients. `CEO-BRD-007` the printed document view matches
`documentSheet.tsx`'s white/black print convention (a presence check on
`DOCUMENT_CSS` usage, not a screenshot test). `CEO-BRD-008` tenant
isolation.

---

### Phase 7 — Risk Register, Policy Register & Governance Overview

**Files:** `apps/api/prisma/schema/ceo-risk.prisma`,
`apps/api/src/domains/ceo/risk.ts`,
`apps/api/src/routes/ceo/risk.routes.ts`,
`apps/api/src/tests/ceo/risk.test.ts`,
`apps/api/src/domains/ceo/risk.detectors.ts`,
`apps/web/src/pages/ceo/Risk.tsx`, `apps/web/src/pages/ceo/Policies.tsx`,
`apps/web/src/pages/ceo/Governance.tsx`,
`apps/web/src/components/ceo/risk/*`.

**Reads from:** `board.ts: complianceCalendar()` (Governance Overview's
compliance counters — imports, never re-derives). `exceptions.ts:
raiseException`.

**Build:**
1. `RiskItem`, `PolicyDocument`, `PolicyAcknowledgement` models (§5).
   `risk.ts`: `createRisk(input)`, `updateRiskStatus(id, {status,
   mitigation})`, `reviewRisk(id)` (stamps `reviewDate` forward), `risk
   Register(filters)`. `createPolicyDocument(input)`, `publishPolicyVersion
   (id, body)` (versions, never overwrites), `acknowledgePolicy(id)`,
   `policiesOverdueForReview()`.
2. `governanceOverview()` — one aggregate: open risks by severity, policies
   overdue for review, DoA matrix summary (imports Phase 5's `doaMatrix()`
   if it has landed; if not yet merged when this phase is implemented,
   this panel is a `noActionReason`-carrying `Metric` stub with a comment
   noting the dependency — this phase must not block on Phase 5 landing
   first, per the parallel-build contract), board compliance counters
   (imports `board.complianceCalendar()`).
3. Detector: `RISK-REVIEW-OVERDUE`, `POLICY-REVIEW-OVERDUE` — raise
   exceptions via `raiseException`.
4. Web: `Risk.tsx` — register list, severity chips (`SeverityChip`,
   reusing the existing S0–S4 vocabulary rather than inventing a new one —
   a business risk's likelihood×impact maps onto the same severity words).
   `Policies.tsx` — document list, version history, acknowledgement tracker.
   `Governance.tsx` — the rollup dashboard. Empty states: `"Nothing is on
   the risk register yet."`, `"No policy has been published yet."`

**Routes:** `GET/POST /ceo/risk/risks`, `POST /ceo/risk/risks/:id/status`,
`POST /ceo/risk/risks/:id/review`, `GET/POST /ceo/risk/policies`, `POST
/ceo/risk/policies/:id/publish`, `POST
/ceo/risk/policies/:id/acknowledge`, `GET /ceo/risk/governance`.

**Grants:** `risks`, `policy_documents`: chairman default; written in
Phase 0 (no other role named in §1 for this area — keep chairman-only
unless a later review adds one).

**Events:** `kz.ceo.risk.raised`, `kz.ceo.risk.closed`,
`kz.ceo.policy.published`, `kz.ceo.policy.acknowledged`.

**Tests (aim 8–12):** `CEO-RSK-001` a risk with no mitigation text cannot
move to `mitigating`. `CEO-RSK-002` `policiesOverdueForReview` correctly
excludes a policy reviewed within its window. `CEO-RSK-003` a
`PolicyDocument` version publish never overwrites the prior version's
stored body (history readable). `CEO-RSK-004` `governanceOverview`'s
compliance counters match a direct `board.complianceCalendar()` call
exactly. `CEO-RSK-005` an acknowledgement is per-party and per-version (a
new policy version resets acknowledgement state). `CEO-RSK-006` tenant
isolation. `CEO-RSK-007` `PolicyDocument` and the platform's own `Policy`
model never collide on resource name or table name (a compile-time/schema
check).

---

### Phase 8 — Financial Planning & Headcount

**Files:** `apps/api/prisma/schema/ceo-finance.prisma`,
`apps/api/src/domains/ceo/finance.ts`,
`apps/api/src/routes/ceo/finance.routes.ts`,
`apps/api/src/tests/ceo/finance.test.ts`,
`apps/api/src/domains/ceo/finance.detectors.ts`,
`apps/web/src/pages/ceo/FinancialPlan.tsx`,
`apps/web/src/pages/ceo/Headcount.tsx`,
`apps/web/src/components/ceo/finance/*`.

**Reads from:** `books.ts: profitAndLoss`, `cashPosition`, `cashForecast`,
`budgetVariance`, `setBudgetLine` (this phase's budget-authoring layer
calls `setBudgetLine` per line rather than writing `BudgetLine` rows
directly, so it stays the single write path). `employment.ts:
headcountByDivision`. `payroll.ts: payrollCostByDivision`, `payrollTrend`.
`decisions.ts: raiseDecision` (§3.10, over-ceiling budget lines).

**Build:**
1. `FinancialScenario`, `HeadcountPlan`, `HeadcountPlanLine` models (§5).
   `finance.ts` (ceo): `createScenario(input)` (assumptions only, §3.7),
   `projectScenario(scenarioId)` — **pure function**: reads live
   `cashPosition()`/`profitAndLoss()` figures, applies the scenario's
   assumption parameters, returns a projected series; writes nothing back
   to `Transaction`/`BudgetLine`. `runwayUnderScenario(scenarioId)`.
   `thirteenWeekCashFlow(scenarioId?)` (extends `cashForecast`'s approach
   to weekly granularity — reuses its `RecurringRule`/`VendorBill` inputs,
   does not reinvent them).
2. `authorBudgetLine(period, categoryId, division, amount)` — wraps
   `setBudgetLine`; if `amount` exceeds the division's `AuthorityGrant`
   ceiling (via `resolveAuthorityCeiling`, same function Phase 5's matrix
   displays), routes through `raiseDecision` instead of writing directly
   (§3.10) — this phase does not depend on Phase 5 having merged; it calls
   the platform function directly, same as Phase 5 does, rather than
   importing anything from Phase 5's files.
3. `createHeadcountPlan(fy, division, input)`, `addPlanLine(planId,
   input)`, `headcountVariance(fy, division)` (imports
   `headcountByDivision`/`payrollCostByDivision`, compares to plan).
4. Web: `FinancialPlan.tsx` — scenario picker (base/upside/downside tabs),
   projected P&L/cash/runway charts (`recharts`, following
   `Executive.tsx`'s chart conventions exactly — division colours, polarity
   colours, the mandatory `<details><summary>Show the figures</summary>`
   table under every chart, §"Component vocabulary"), budget authoring
   grid. `Headcount.tsx` — plan vs actual by division/role. Empty states:
   `"No scenario has been modelled yet."`, `"No headcount plan exists for
   this year yet."`

**Routes:** `GET/POST /ceo/finance/scenarios`, `GET
/ceo/finance/scenarios/:id/projection`, `GET
/ceo/finance/scenarios/:id/runway`, `GET /ceo/finance/thirteen-week-cash`,
`GET/POST /ceo/finance/budget-lines`, `GET/POST
/ceo/finance/headcount-plans`, `POST
/ceo/finance/headcount-plans/:id/lines`, `GET
/ceo/finance/headcount-plans/:id/variance`.

**Grants:** `financial_scenarios`, `headcount_plans`: `V@all` for
`finance_head` (§1), chairman default; written in Phase 0.

**Events:** `kz.ceo.scenario.created`, `kz.ceo.budget_line.proposed`,
`kz.ceo.headcount_plan.approved`.

**Tests (aim 10–14):** `CEO-FIN-001` a scenario never writes to
`Transaction`/`BudgetLine` — `projectScenario` is read-only (assert no
write query is issued). `CEO-FIN-002` two scenarios computed at different
times from the same assumptions reproduce identically given the same live
figures (determinism, modulo the live figures themselves — test with a
frozen fixture). `CEO-FIN-003` `authorBudgetLine` above ceiling routes
through `raiseDecision` and does not write the `BudgetLine` until
`Implemented`. `CEO-FIN-004` `authorBudgetLine` below ceiling writes
directly via `setBudgetLine`, verified equal to a direct call.
`CEO-FIN-005` `headcountVariance` matches direct `headcountByDivision`/
`payrollCostByDivision` calls exactly. `CEO-FIN-006` `runwayMonths` is
`null`, never `Infinity`, under a non-burning scenario (matches
`cashPosition`'s own convention). `CEO-FIN-007` `finance_head` sees all
scenarios; a non-finance, non-chairman role is refused. `CEO-FIN-008`
tenant isolation.

---

### Phase 9 — Leadership, Org, 1:1s & Succession

**Files:** `apps/api/prisma/schema/ceo-people.prisma`,
`apps/api/src/domains/ceo/people.ts`,
`apps/api/src/routes/ceo/people.routes.ts`,
`apps/api/src/tests/ceo/people.test.ts`,
`apps/api/src/domains/ceo/people.detectors.ts`,
`apps/web/src/pages/ceo/Leadership.tsx`,
`apps/web/src/pages/ceo/OneOnOnes.tsx`,
`apps/web/src/pages/ceo/Succession.tsx`,
`apps/web/src/pages/ceo/TimeAudit.tsx`,
`apps/web/src/components/ceo/people/*`.

**Reads from:** `employment.ts` (`OrgUnit`/`Position` — a `Seat` references
a `Position` id, never duplicates its fields). `commandCenter.ts`'s
`peopleAndCapability` k≥5 anonymity convention (§4.9 — do not import the
function itself since it is command-center-scoped, but replicate its
anonymity floor: any aggregate view in this phase covering fewer than 5
people withholds, same as that panel does).

**Build:**
1. `Seat`, `SuccessionCandidate`, `OneOnOneSeries`, `OneOnOneInstance`,
   `TimeAuditEntry` models (§5). `people.ts`: `createSeat(input)`,
   `reassignSeat(seatId, newOwnerId)` (versions — old row kept, new row
   created, both readable), `vacantSeats()`. `createSuccessionPlan(seatId,
   input)`, `updateSuccessionCandidate(id, input)` (chairman-only grant,
   §4.9 — no aggregate rollup of this data is ever exposed to a wider
   audience; there is no "team succession health" tile anywhere in this
   module). `createOneOnOneSeries(input)`, `logOneOnOne(seriesId, input)`
   (`privateFlag` respected: visible only to the two parties + chairman).
   `logTimeAuditEntry(personId, category, minutes, date)`,
   `timeAuditRollup(personId, period)` (derived on read, not stored).
2. Web: `Leadership.tsx` — accountability chart (org tree with seat
   ownership) + roster view (seat, current rocks/OKRs if Phases 2–3 have
   landed — else a `noActionReason`-carrying placeholder, same
   dependency-tolerant pattern as Phases 4/6/7 above — last 1:1 date).
   `OneOnOnes.tsx` — series list, instance log (private notes gated by
   `privateFlag` + party identity, checked server-side, not just hidden in
   the UI). `Succession.tsx` — per-seat candidates, explicitly
   chairman-visible only (no grant for any other role, §1). `TimeAudit.tsx`
   — self-logged entries + rollup chart. Empty states: `"No seat has been
   defined yet."`, `"This 1:1 series has no logged instances yet."`,
   `"No successor has been identified for this seat."` (a true, neutral
   fact, never rendered as an alarm).

**Routes:** `GET/POST /ceo/people/seats`, `POST
/ceo/people/seats/:id/reassign`, `GET /ceo/people/seats/vacant`, `GET/POST
/ceo/people/succession`, `GET/POST /ceo/people/one-on-ones/series`, `POST
/ceo/people/one-on-ones/series/:id/instances`, `GET/POST
/ceo/people/time-audit`, `GET /ceo/people/time-audit/rollup`.

**Grants:** `seats`: chairman default, `V@all` for `hr_ops_manager` (org
data is theirs to maintain, §1). `succession_candidates`,
`one_on_ones` (beyond the two parties' own `@own`), `time_audit`:
chairman-only default; written in Phase 0.

**Events:** `kz.ceo.seat.created`, `kz.ceo.seat.reassigned`,
`kz.ceo.succession.reviewed`, `kz.ceo.one_on_one.logged`.

**Tests (aim 10–14):** `CEO-PPL-001` reassigning a seat keeps the prior
owner's row readable (history, never overwritten). `CEO-PPL-002` a
`privateFlag` 1:1 instance is invisible to a third party who is neither
manager nor report nor chairman. `CEO-PPL-003` `SuccessionCandidate` reads
are refused for every role except chairman. `CEO-PPL-004` no aggregate
view in this phase exposes a count under 5 people without withholding
(k≥5 floor, §4.9). `CEO-PPL-005` `timeAuditRollup` is computed on read, not
stored (no write path other than `logTimeAuditEntry`). `CEO-PPL-006` a
vacant seat is correctly flagged and a filled one is not. `CEO-PPL-007` a
`Seat` references a real `Position`; creating one against a nonexistent
position id is refused. `CEO-PPL-008` tenant isolation.

---

### Phase 10 — Integration & docs (orchestrator, after every phase 1–9 PR merges)

Not a Sonnet-agent brief — run by whoever merges the phases. Work:
1. `README.md` "What to look at" — add bullets for the Chairman's Office
   surfaces actually shipped (the equity portal shipped without this step;
   §2 of the research flags it as a real gap — this module closes it rather
   than repeating the omission).
2. `PRODUCT.md` "Users" section — confirmed stale even for the equity
   portal's three roles; update it now to list every role this module
   changes the story for (it should already list `chairman`; confirm the
   description still matches what the chairman can now do).
3. `docs/acceptance.md` — replace every `pending` row Phase 0 wrote with
   the real test count and "What is pinned" prose, one row per
   `CEO-<AREA>` prefix, matching the existing table's voice (a plain-English
   claim about behaviour, semicolon-separated clauses).
4. Append a `## Phase N — as built` section to this file for every phase 1–9,
   following the convention in `docs/plan/equity-portal.md`'s existing "as
   built" sections (§`research-plan-domains.md`'s Goal A write-up) — each
   phase's own agent should have appended its own section on landing per
   §7's rule below; if any phase's agent did not, the orchestrator
   reconstructs it from the PR diff before closing this out.
5. Confirm every dependency-tolerant `noActionReason` placeholder left by a
   phase that shipped ahead of one of its optional dependencies (Phases 4,
   6, 7, 9 each name one) has been re-wired now that all phases are merged;
   file a follow-up task for any that still needs a real implementation
   rather than leaving the placeholder silently in production.
6. Run `pnpm typecheck` and the full test suite once on the fully merged
   tree; record the before/after test count on this file's Status line, per
   the equity-portal.md convention (§`research-plan-domains.md` Goal A,
   point 1).

---

## §7 Conventions the implementer must hold to

- Every domain function opens with `assertCan`/`assertScopeAll`; scoped
  `prisma` only; no phase in this module calls `unscopedPrisma` anywhere.
- No service code compares a role slug (the existing grep test fails the PR
  otherwise). Narrowings are grants and scope resolvers, written in Phase 0.
- New resources in both `RESOURCES` (`packages/shared/src/permissions.ts`)
  and `ALL_RESOURCES` (`apps/api/src/seed/grants.ts`) — both edited only by
  Phase 0; new events in `EVENTS` with the `kz.ceo.*` grammar, also Phase
  0-only; `emit()` after every state change in the owning phase's own domain
  file; a regulated read writes an `AuditRecord`, never an event.
- Money is `Decimal`; the client does no arithmetic on document views.
- Plain words on screen (`Cockpit`, `Board pack`, `Risk register`), codes in
  tooltips. Empty states are true sentences, per §4–§6's examples above —
  never a bare "No data."
- Nav rows via `NAV_REGISTRY`, written once by Phase 0 for every screen;
  `GROUP_ORDER`/`GROUP_LABELS` in `Shell.tsx`, also Phase-0-only.
- Tests through `asUser`/the fixture-role helpers in `apps/api/src/tests/
  helpers.ts` (`principalFor`, `authFor`), named by requirement; one row in
  `docs/acceptance.md` per phase — written by Phase 0 as `pending`, filled
  by Phase 10, **never edited by phases 1–9**.
- Exact commands (from `env-ready.md`): `cd /home/user/OOSS && pnpm
  typecheck` (~27s, must pass clean after every phase); `cd apps/api &&
  npx prisma generate` after adding/editing a schema file, then `DATABASE_URL=
  "postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public"
  npx prisma db push --skip-generate` against the test DB before running
  that phase's tests; `cd apps/api && npx vitest run src/tests/ceo/
  <area>.test.ts` for one phase's file, `npx vitest run` for the full suite
  (baseline 629 tests passing before this module; each phase's PR should
  report its own new count).
- After Phase 0 edits `apps/api/src/seed/grants.ts`, a test asserts the
  durable `Grant` rows match the declared matrix with no drift
  (`planFor(tenantId)` from `seed/reconcileGrants.js` must return `[]`); the
  boot-time `addMissingGrants` autosync covers every resource that has no
  existing grant row at all, which is true for every resource this module
  adds, so no manual `reconcileGrants --apply` should be needed — if the
  drift test still fails, run it before assuming the matrix itself is wrong.
- `vitest.config.ts` runs every test file **serially against one shared
  database** — several existing requirements (gapless record codes, hash-
  chain continuity) depend on that ordering. Because phases 1–9 build in
  separate worktrees against separate local databases and only meet at
  merge time, each phase's own test file must set up any tenant/fixture
  data it needs itself (follow `board.test.ts`'s or the equity-portal test
  files' pattern of creating what they need rather than assuming another
  phase's fixture rows exist) — a phase's tests must pass standing alone,
  because that is how they run until the final merged-tree run in Phase 10.
- Every domain function that writes a record most people would recognise as
  "the plan," "the risk," "the decision we made in the meeting," etc. opens
  by calling `assertCan`, and every state transition that the feature
  catalogue (§4) marked as needing proposer≠approver calls `raiseDecision`/
  goes through `approvals.ts` rather than a direct write — check §3's
  decisions list before writing any transition function that changes money,
  authority, or an issued document's state.
- Each phase commits on its own branch with a descriptive message and does
  not touch a file outside its "Files:" list in §6 — if a phase brief turns
  out to need a file another phase owns, that is a signal the brief was
  wrong, not a reason to edit it; flag it in that phase's own "as built"
  section instead (append one to this file on landing, following
  `docs/plan/equity-portal.md`'s "as built" convention) and let Phase 10
  reconcile it.
- Do not edit `docs/acceptance.md`, `README.md`, or `PRODUCT.md` from any
  phase 1–9 — the orchestrator (Phase 10) does all three.
- Ask before: adding a cross-tenant read, storing a full bank account or PAN
  in plain text where the platform elsewhere masks it, any e-sign or email
  provider dependency, or exposing succession/time-audit/1:1 data beyond the
  chairman-only default §1 and §4.9 set.
