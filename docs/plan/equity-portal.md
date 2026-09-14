# Equity, Shareholder & Board portal — plan

Status: **answered 14 Sep 2026; ready for phase 0.** Nothing in this
document is built. It is written so that an implementing model (Sonnet) can
take one phase in §6 at a time as a self-contained brief, and so that the
decisions in §3 can be argued with before any of it exists.

What was asked for: a new domain, reachable only by shareholders and board
members, for equity management; connected to the ERP; one tenant per subsidiary
of Kaizen Infinities; routing by the user's email domain; the chairman signing
in through the group and seeing every subsidiary, consolidated and isolated.

What this plan does with that: keeps the intent, changes three mechanisms
(§3.1–§3.3), because as literally stated they break invariants the platform
is built on or do not survive the first external investor.

| | Section |
|---|---|
| §1 | The answers, and what each one decided |
| §1a | Three consequences to confirm with the company secretary |
| §2 | What the codebase is today, and what this touches |
| §3 | Decisions, and the failures each one prevents |
| §4 | What the market does, and what is deliberately not copied |
| §5 | Data model |
| §6 | Phases, each a brief for Sonnet |
| §7 | Conventions the implementer must hold to |

---

## 1. The answers, and what each one decided

Answered by the chairman on 14 Sep 2026.

1. **The group.** KIPL is the holding. The three divisions — Software, Skill
   Development, Education — become subsidiaries in the near future; the
   platform must be ready for that. Shareholders are entered by the chairman.
   *Decided:* the existing `kaizen` tenant is the holding tenant. Every
   subsidiary tenant records the division it grew out of
   (`Tenant.config.originDivision`), so the group structure chart can show
   the three divisions today as *not yet incorporated* and the same nodes
   become real entities when the tenants exist. A later phase (6b) carries the
   division-tagged rows — transactions, employees, courses — into the new
   tenant; nothing in phases 0–5 assumes it has happened.
2. **Hostname.** One portal host with an entity picker. *Decided:* §3.1 as
   written; one `routes` entry on the Worker.
3. **Emails.** Some corporate, some personal. *Decided:* §3.2 as written;
   email domain is a hint only.
4. **What a shareholder or director sees.** A holder or director *of the
   holding* sees every entity's financial summary; one *of a subsidiary only*
   sees that subsidiary's; the same person can be both, or be on several
   subsidiaries. *Decided:* the rule is exactly the affiliation model. A
   person's reach is the union of the entities they hold an affiliation in,
   and the holding tenant's snapshots carry every subsidiary's summary, so a
   holding-level portal user sees all of them without any cross-tenant read.
   The financial block of a snapshot is therefore published unconditionally
   (the earlier idea of the finance head choosing what goes up is dropped);
   what goes up is the same summary The Business shows: cash, P&L by
   division, headcount.
5. **"Consolidated".** Explained: *aggregated* means adding each company's
   figures together. *Consolidated* (the Companies Act meaning, s.129(3),
   Ind AS 110) means adding them and then removing money that only moved
   between group companies — KIPL invoicing the Education subsidiary for
   software, a subsidiary paying KIPL a dividend, KIPL's own investment in a
   subsidiary sitting as an asset. Without those removals the group looks
   bigger than it is. *Decided:* the group screen shows each entity and a
   **group total before inter-company eliminations**, labelled in those
   words, and every transaction whose counterparty is another group entity
   is flagged `intercompany` so a chartered accountant can do the
   consolidation from a list rather than a hunt. Producing consolidated
   statements themselves is not built.
6. **Instruments.** Everything the Companies Act allows a private limited
   company. *Decided:* equity; preference (compulsorily or optionally
   convertible, redeemable); debentures (compulsorily or optionally
   convertible, non-convertible); convertible notes (DPIIT start-ups only);
   warrants; ESOP options; sweat equity (s.54); bonus (s.63); rights issue
   (s.62(1)(a)); private placement (s.42); preferential allotment (s.62(1)(c));
   buy-back (s.68); reduction of capital (s.66, recorded, not workflowed —
   it needs the tribunal). Phase 1 ships equity and preference classes and
   allotment/transfer; phase 4 the rest.
7. **Register keepers.** Company secretary and finance. *Decided:* §3.4 as
   written; the chairman enters holders and their sign-ins directly (see 10).
8. **Dematerialised.** Explained: shares held as electronic entries with a
   depository (NSDL or CDSL, through a registrar) instead of paper
   certificates, the way a bank account replaces cash. See §1a.1 for why it
   matters to this group specifically.
9. **Board.** Full: meetings with notice, agenda, attendance, minutes and the
   SS-1 timelines, plus circular resolutions. *Decided:* phase 3 as written.
10. **Sign-in for outsiders.** No invite flow, no one-time code. The
    chairman creates the account and sets the password. *Decided:* a
    "Create sign-in" action on a holder or board member (chairman or company
    secretary), which creates the principal and a per-entity user, with the
    password shown once, as the seed does today; the same action resets a
    password. No email is sent by the platform. The risk accepted: a
    certificate-bearing surface protected by a password alone.
11. **Foreign shareholder.** One NRI. *Decided:* residency and investment
    basis are recorded on every holder (§5); FEMA reporting items are
    generated for repatriable holdings (§1a.3); phase 6 includes them.

---

## 1a. Three consequences to confirm with the company secretary

These follow from the answers and change the compliance load of the whole
group, not just the software. They are stated as the platform will state
them; a company secretary should confirm before the subsidiaries are formed.

1. **Forming subsidiaries ends "small company" status — for KIPL and for
   each subsidiary.** Section 2(85) excludes a holding company and a
   subsidiary company from the definition regardless of size. On the day the
   first subsidiary is incorporated: four board meetings a year with a
   120-day gap instead of two; MGT-7 instead of MGT-7A; and **Rule 9B
   dematerialisation becomes mandatory** for KIPL (and for the subsidiaries
   unless the wholly-owned-subsidiary exemption, which the research could
   not verify, applies). Until then KIPL is almost certainly a small company
   and paper certificates are fine. The platform models demat status per
   entity and raises a compliance item the moment a tenant becomes a holding
   or a subsidiary.
2. **Group total is not a consolidated statement.** A holding company must
   prepare consolidated financial statements (s.129(3)) and file AOC-1 for
   each subsidiary. The platform gives the per-entity figures, the
   inter-company flag and the AOC-1 data; the consolidation is an accountant's
   act.
3. **The NRI's holding decides the FEMA work.** An NRI investing on a
   *non-repatriation* basis (Schedule IV of the NDI Rules) is treated as a
   resident investment: no FC-GPR, no FC-TRS. On a *repatriation* basis every
   allotment needs FC-GPR within 30 days, every transfer with a resident
   needs FC-TRS within 60 days, pricing must meet the FEMA fair-value floor,
   and the FLA return is due 15 July each year. The holder record carries
   the basis; the calendar follows from it.

---

## 2. What the codebase is today, and what this touches

The full briefings are long; this is what matters for the design.

**Tenancy.** `apps/api/src/platform/db.ts` — a Prisma extension injects
`tenantId` into every query and throws if none is in scope. Tenant comes from
the `User` row re-read on every request (`apps/api/src/lib/http.ts:29-71`),
never from a header or hostname. There is no parent tenant, no group, no
cross-tenant read path of any kind. The header comment in `db.ts` says no role
bypasses the gate, including the chairman. The README says the same. **This
plan keeps that true.**

**Identity.** `User` is `@@unique([tenantId, email])` — one user per tenant,
no cross-tenant identity. Roles live on `Affiliation.roleSlug`, several per
person, switched inside one tenant by `POST /auth/switch-context`. A person
with no active affiliation cannot sign in. Four roles exist:
`chairman`, `finance_head`, `hr_ops_manager`, `employee`.

**Surfaces.** `AccessRole.archetype` accepts `command | workspace | portal |
console`. `portal` is declared in `packages/shared/src/api.ts:99`, filtered by
`navigationFor()` in `apps/api/src/domains/surfaces.ts`, and used by nothing.
The client has no hostname awareness anywhere; the Worker strips `Host`.

**Company.** `CompanyProfile` (one per tenant) already carries `cin`, `pan`,
`gstin`, `legalName`, `documentPrefix` (`KIPL`). Document numbering
(`apps/api/src/platform/documentNumber.ts`) has three series letters
(`I`, `R`, `F`); a certificate series fits there. `EmploymentRelationship.
legalEntity` is a free string defaulting to "Kaizen Infinities Pvt Ltd" —
the only other place a legal entity is named.

**Money.** A capital injection is already modelled: a `Transaction` on a
`LedgerCategory` of `kind: 'equity'`, excluded from P&L by `isTrading()` and
counted in cash (`packages/shared/src/finance.ts:38-56`, `books.ts:1037`). The
register must point at those rows, not post beside them.

**Governance.** `emit()` with hash-chained events named
`kz.<ctx>.<entity>.<verb>`; `assertCan()` at the top of every domain function;
`approvals.ts` with the self-dealing bar; `AuditRecord` for regulated reads.
Nav is `NAV_REGISTRY` in `apps/api/src/seed/bootstrap.ts`, reconciled at boot.
New resources go in `packages/shared/src/permissions.ts` **and**
`apps/api/src/seed/grants.ts` (a test asserts parity), and boot grants them.

**Web.** One `<Routes>` block in `apps/web/src/main.tsx`, no lazy loading, no
data grid, no forms library, recharts used in one file, a print-sheet chassis
in `apps/web/src/pages/documentSheet.tsx` that a share certificate can reuse.

---

## 3. Decisions, and the failures each one prevents

### 3.1 The hostname selects a surface, never a tenant or a permission

`worker/index.ts`, `apps/web/src/main.tsx`

The portal host (`equity.<domain>`) serves the same bundle and talks to the
same API. At boot the client reads `window.location.hostname` and, if it is a
portal host, renders the **portal shell**: no ERP sidebar, an entity picker,
the shareholder/director surfaces only. Roles with `archetype: 'portal'`
(§3.4) get the portal shell on either host; ERP roles opening the portal host
are offered the portal view of the entities they are affiliated to, which for
the chairman is every one of them.

Why not route the tenant by host: the API already refuses to trust anything
but the token for tenancy, and the Worker strips `Host` before forwarding.
Making the host authoritative would add a second tenancy mechanism that the
gate cannot see. "Exclusive for shareholders and board members" is a property
of grants — a person without a `shareholder`/`director`/`company_secretary`
affiliation has no navigation on that host and no route resolves — not of DNS.

The Worker gets a `PORTAL_HOSTS` var so the client can be told which hosts are
portals without a second build (`/api/meta/version` already carries build
facts; a `surfaceHosts` field is added there).

### 3.2 A person is one identity across entities; routing is by relationship, not by email domain

`apps/api/prisma/schema.prisma` (`Principal`), `apps/api/src/lib/auth.ts`

New model `Principal { id, email @unique, passwordHash, secondFactor,
status }`. `User.principalId` links every per-tenant `User` to it; the
per-tenant `passwordHash` is migrated into the principal (same email ⇒ same
principal) and dropped. Sign-in verifies the principal, then lists the
tenants in which it holds an active affiliation. One ⇒ silent. Several ⇒ the
entity picker (portal) or the existing context switcher extended with an
entity level (ERP). `POST /auth/switch-entity` issues a token for the chosen
tenant's `User`. The token shape does not change; the gate does not change.

Email domain is kept as what it can honestly be: a **hint**.
`Tenant.config.emailDomains` maps `sub-a.com` ⇒ that tenant so the picker
pre-selects it. It is never the reason a person can see an entity.

Why: the chairman at `chairman@kaizen.co.in` holds a director affiliation in
each subsidiary — that is a fact about relationships, and it is what should
open the subsidiary, so that removing them from a board removes the access on
the next request (the platform's existing revocation guarantee). An investor
at a Gmail address holding shares in two subsidiaries has no domain to route
by at all, and would otherwise need two passwords.

### 3.3 The tenant gate stays absolute; the group view is built from upward publication

`apps/api/src/domains/group.ts`, `apps/api/src/jobs/scheduler.ts`

`Tenant.parentTenantId` (nullable) and `Tenant.kind: 'holding' | 'subsidiary'
| 'standalone'`. A subsidiary **publishes** an `EntitySnapshot` into its
parent tenant — cap table summary, holder list with percentages, share
classes, board calendar, open resolutions, the financial summary (the same
cash, P&L-by-division and headcount figures The Business shows), valuation,
compliance flags — written
under `asSystem(parentTenantId)` on the relevant events and by a nightly job.
The chairman's group dashboard reads **only rows in the holding tenant**.
Look-through ownership (founder 60% of KIPL × KIPL 70% of Sub A + founder 5%
direct = 47%) is computed over snapshots in the holding tenant.

Isolated view = switch entity (§3.2) into the subsidiary and use its own
screens. No consolidated screen ever queries a subsidiary's tables directly.

Why not a cross-tenant read grant for the chairman: it would be the first code
path where a request in tenant A reads tenant B's rows, and every later
feature would be tempted to use it. Publication keeps every read inside one
tenant and leaves an event on both sides. The cost is staleness measured in seconds,
which the dashboard states ("as published 14 Sep 09:41").

Each snapshot carries the `hash` of the last subsidiary event it reflects, so
the group view can say which entity is behind and by how much rather than
silently mixing ages.

### 3.4 Three new roles, one archetype, and the self-dealing bar reaches the register

`packages/shared/src/permissions.ts`, `apps/api/src/seed/grants.ts`

| Role | Archetype | Holds |
|---|---|---|
| `shareholder` | portal | `holdings:V@own`, `certificates:V@own`, `entity_documents:V@all` (portal class), `valuations:V@all`, `resolutions:V@own` (where they are a voter, e.g. shareholder resolutions) |
| `director` | portal | everything a shareholder holds, plus `board_meetings:V@all`, `resolutions:V,approve@all` (votes), `board_documents:V@all`, `cap_table:V@all` |
| `company_secretary` | workspace | `cap_table:VCEX`, `share_ledger:VC` (no edit — the ledger is append-only), `certificates:VC`, `board_meetings:VCE`, `resolutions:VCE`, `compliance:VCE`; **no `approve`** |
| `finance_head` (existing) | | `+ share_ledger:approve`, `cap_table:V`, `valuations:VCE` |
| `chairman` (existing) | | everything, as now; the bar still blocks approving an allotment or transfer they are a party to |

An allotment or transfer is proposed by the secretary and **approved** through
`approvals.ts`, whose self-dealing bar already reroutes an approver who is the
subject. A transfer where the chairman is transferee goes to the finance head.

### 3.5 The register is a ledger; the cap table is its sum

`apps/api/src/domains/equity.ts`

`ShareTransaction` rows are append-only (allotment, transfer, conversion,
buy-back, split, bonus, forfeiture, cancellation), each with a `reversalOfId`
like `Transaction`. Holdings and the cap table are computed from them, as
leave balances are from the leave ledger. A `ShareCertificate` is issued
against a range of distinctive numbers and is a document: numbered from a
new `C` series (`KIPL/C/26-27/001`), fixed at issue, printed from the same
sheet chassis as an invoice, superseded (never edited) on transfer or split.

### 3.6 The register references the books; it never posts to them

An allotment for cash carries `considerationTransactionId` pointing at the
`Transaction` of `kind: 'equity'` that already lifts cash and stays out of
P&L. If the money has not arrived, the allotment is `pending_consideration`
and says so. Dividends, when they come, are `Transaction`s the finance head
posts and the register references. Module boundary written down:
**EQT never holds money movement; FIN never holds share ownership.**

### 3.7 Say what is known

The cap table shows *issued* and *fully diluted* as two columns, because the
Companies Act uses "total share capital" for subsidiary status and FEMA uses
fully diluted, and one number would be wrong for one of them. Valuation shows
the date, the valuer and the basis, or "No valuation on record". Compliance
counters (days since last board meeting against 120) count from recorded
meetings only and say "No meeting recorded" rather than "overdue" when the
register is empty. The group figure is headed *Group total before
inter-company eliminations*, never *Consolidated*.

---

## 4. What the market does, and what is deliberately not copied

Researched: Vestd (UK + India), Carta, Ledgy, Qapita, Hissa, Eqvista, Pulley,
Capdesk, Diligent Boards/Entities, BoardEffect, OnBoard, Equidam.

**Copied.** Portal role tiers (Vestd: investors see ownership summary,
employees see grants, finance sees all). Entity-as-stakeholder (Pulley: a
subsidiary's cap table lists the holding as an institutional holder linked to
its own account — this is §3.3 with a link instead of a grant). Rights matrix
per class (Hissa: liquidation preference, anti-dilution, pro-rata, board
seat, information rights). Board consents drafted from cap-table data (Carta).
Structure chart from ownership edges (Diligent Entities). India instruments as
legal objects — equity, CCPS, CCD, convertible note, warrant, option, phantom
— with conversion events that spawn allotments (Qapita; iSAFE modelled as
CCPS because a SAFE does not exist in Indian law).

**Not copied.** Marketplace/liquidity desks (Hissa), 409A (no Indian
standing; India needs a merchant-banker FMV for ESOP perquisite), token cap
tables, investor MOIC/IRR portfolios, HRIS integrations (the HRM is in the
same system). No vendor combines a statutory register, India filings, a
shareholder portal and a real meetings module; that combination is what an
in-house build is for.

**Regulatory anchors the model carries** (details with sources in the
research report; the model stores the data these forms need, exports come in
phase 6): MGT-1 register of members per class; SH-1 certificates within two
months of allotment; SH-4 transfers, 60/30-day windows; PAS-3 within 15/30
days of allotment; SH-7 for capital changes; MGT-14 for special resolutions;
MGT-7/7A annual return; Rule 12 ESOP (one-year minimum vesting, SH-6
register, promoter exclusion with DPIIT relief); Rule 9B demat + PAS-6;
s.173 / SS-1 board meetings (four a year, ≤120-day gap, 7-day notice, minutes
within 30 days, s.179(3) matters at a meeting not by circulation); s.175
circular resolutions; MBP-1 director interests; s.2(87) subsidiary test,
s.19 no subsidiary may hold its holding's shares (the graph refuses that
edge), two-layer limit; s.90 SBO (≥10% direct or indirect — computed from the
look-through graph); AOC-1 statement of subsidiaries. Angel tax (s.56(2)(viib))
is abolished from AY 2025-26 and is not modelled.

---

## 5. Data model

All rows carry `tenantId`, tenant-leading indexes, `recordCode`, `deletedAt`
where soft delete applies, `Decimal(18,2)` for money, `Decimal(24,6)` for
share counts and prices (fractional shares do not occur, but conversion
ratios do).

**Identity and group**
- `Principal` — `email @unique`, `passwordHash`, `otpSecret?`, `status`,
  `lastLoginAt`. `User.principalId`.
- `Tenant` + `parentTenantId?`, `kind`, `config.emailDomains: string[]`,
  `config.originDivision?` (the division a subsidiary grew out of).
- `EntityProfile` — extends `CompanyProfile` 1:1 (or new columns on it):
  `incorporatedOn`, `financialYearEnd`, `authorisedCapital` per class,
  `isSmallCompany`, `dematStatus (physical | demat | mixed)`, `isin?`, `rta?`,
  `dpiitNumber?`, `dpiitRecognisedOn?`, `registeredOfficeAddress`.

**Register**
- `ShareClass` — `name`, `kind (equity | preference | debenture)`, `instrument
  (equity | sweat_equity | ccps | ocps | rps | ccd | ocd | ncd |
  convertible_note | warrant | option | phantom)`,
  `faceValue`, `votingRightsPerShare`, `rights Json` (liquidation preference
  multiple and participation, anti-dilution, pro-rata, board seat, information
  rights, dividend rate), `conversionTerms Json?`, `authorisedCount`.
- `Holder` — the party that holds: `kind (person | organization | entity)`,
  `personId? | organizationId? | heldByTenantId?` (the last is the
  entity-as-stakeholder link), `folioNumber`, `residency (resident |
  non_resident)`, `investmentBasis (repatriable | non_repatriable)?` (required
  when non-resident; decides whether FEMA items are generated), `pan?`,
  `nomineeJson?`, `jointHolders Json?`.
- `ShareTransaction` — append-only; `type (allotment | transfer | conversion |
  buyback | split | bonus | forfeiture | cancellation | redemption |
  reduction)`, `shareClassId`,
  `fromHolderId?`, `toHolderId?`, `count`, `pricePerShare?`, `distinctiveFrom /
  distinctiveTo`, `effectiveOn`, `roundId?`, `considerationTransactionId?`
  (→ `Transaction`), `approvalDecisionId?`, `status (proposed | approved |
  effective | reversed)`, `reversalOfId?`, `boardResolutionId?`, `documents`.
- `ShareCertificate` — `certificateNumber` (document series `C`),
  `holderId`, `shareClassId`, `distinctiveFrom/To`, `count`, `issuedOn`,
  `status (issued | surrendered | cancelled)`, `supersededById?`, `signatories
  Json` (snapshotted names), `stampDutyPaid?`.
- `FundingRound` — `name`, `kind (seed | series | rights_issue | bonus |
  preferential | private_placement | sweat_equity | esop_top_up |
  capital_reduction)`, `preMoneyValuation?`,
  `closedOn?`, `valuationReportId?`, `offerLetterRef?` (PAS-4 serial),
  `status`.
- `Valuation` — `asOf`, `basis (registered_valuer | merchant_banker | ca_cert
  | internal | round_price)`, `valuerName`, `perShareByClass Json`,
  `equityValue`, `reportDocumentId`, `validUntil?`.

**Board and compliance** (phase 3)
- `BoardMember` — `personId`, `role (director | independent | nominee |
  observer | company_secretary)`, `din?`, `appointedOn`, `ceasedOn?`,
  `interestsDeclaredOn?` (MBP-1), `nominatedByHolderId?`.
- `BoardMeeting` — `kind (board | agm | egm | committee)`, `noticeSentOn`,
  `heldOn`, `mode (physical | vc | hybrid)`, `quorumMet`, `attendees Json`,
  `agendaItems[]`, `minutesStatus (draft | circulated | entered | signed)`,
  `minutesEnteredOn?`, `minutesDocumentId?`.
- `Resolution` — `kind (board | shareholder_ordinary | shareholder_special)`,
  `passedBy (meeting | circulation)`, `meetingId?`, `text`, `subject
  (allotment | transfer | esop_scheme | borrowing | ... )`, `requiresMeeting`
  (true for s.179(3) subjects — validated), `votes[]`, `dispatchProof?`,
  `outcome`, `mgt14Srn?`, `signedDocumentId?`.
- `Vote` — `resolutionId`, `boardMemberId | holderId`, `choice`, `castAt`,
  `abstainedAsInterested`.
- `ComplianceItem` — generated, not typed: `kind`, `dueOn`, `basis` (which
  rule and which event it counts from), `status`, `filedRef?`; produced by a
  job from the register and meeting history.

**ESOP** (phase 5) — `EsopPlan`, `OptionPool` (a `ShareClass` of instrument
`option`), `OptionGrant` (`employeeAffiliationId`, `granted`, `exercisePrice`,
`vestingSchedule Json` with cliff and tranches, `status`), `VestingEvent`,
`Exercise` (spawns a `ShareTransaction` allotment), `Lapse`.

**Books** (phase 2) — `Transaction.intercompanyTenantId?` set when the
counterparty is another group entity; listed on the group screen for the
accountant doing the consolidation.

**Group** (phase 2) — `EntitySnapshot` in the holding tenant: `sourceTenantId`,
`asOf`, `sourceEventHash`, `capTable Json`, `holders Json`, `board Json`,
`financial Json?`, `compliance Json`, `valuation Json?`. Plus `GroupEdge`
computed from snapshots for the structure chart, and `LookThrough` rows for
each principal ⇒ entity effective percentage.

Record type codes to add in `packages/shared/src/domain.ts`: `SHC` (class),
`HLD` (holder), `SHT` (share transaction), `CRT` (certificate), `RND`, `VAL`,
`BDM` (meeting), `RES`, `OPG` (option grant).

Events, bounded context `eqt` added to `BOUNDED_CONTEXTS` and a module
register entry `EQT` with its never-does: `kz.eqt.share_class.created`,
`kz.eqt.allotment.proposed | .approved | .effective`, `kz.eqt.transfer.*`,
`kz.eqt.certificate.issued | .cancelled`, `kz.eqt.round.opened | .closed`,
`kz.eqt.valuation.recorded`, `kz.eqt.snapshot.published`,
`kz.eqt.meeting.called | .held | .minuted`, `kz.eqt.resolution.proposed |
.passed | .failed`, `kz.eqt.option.granted | .vested | .exercised | .lapsed`.

---

## 6. Phases, each a brief for Sonnet

Each phase is one branch and one PR, lands with tests named by requirement
(`EQT-<AREA>-<NNN>`), a row in `docs/acceptance.md`, and a section appended
to this file recording what was decided differently and why. Phases 0–2 are
the answer to the request; 3–6 are the product.

### Phase 0 — Foundations: identity, entities, portal surface

Files: `schema.prisma`, `apps/api/src/lib/auth.ts`, `lib/http.ts`,
`routes/auth.routes.ts`, `seed/bootstrap.ts` (tenant + roles), `seed/grants.ts`,
`packages/shared/src/permissions.ts`, `api.ts`, `planes.ts`, `domain.ts`,
`worker/index.ts`, `wrangler.jsonc`, `apps/web/src/main.tsx`,
`lib/session.tsx`, `lib/api.ts`, new `apps/web/src/portal/`.

1. `Principal` model; migration moves `User.passwordHash` into it keyed by
   lowercase email; `User.principalId` required; `User.passwordHash` dropped.
   `login()` verifies against the principal, returns `{ entities: [{tenantId,
   slug, name, kind, affiliations}] }` when more than one, else a token as now.
   `POST /auth/switch-entity { tenantId }` — allowed only if the principal has
   a `User` with an active affiliation there; issues a token for that user;
   audit-logged in both tenants. Token shape unchanged.
2. `Tenant.parentTenantId`, `Tenant.kind`, `config.emailDomains`. Seed:
   `TENANT_KIND`, `PARENT_TENANT_SLUG` env; a `pnpm tenant:create --slug
   --name --parent` script that runs the same bootstrap for a subsidiary
   (grants, nav, pipelines, leave types, founding accounts with their own
   `*_EMAIL` env). The existing tenant becomes `kind: holding` when
   `PARENT_TENANT_SLUG` is unset and any tenant names it as parent. The
   moment a tenant becomes a holding or a subsidiary, a compliance item is
   raised in it saying small-company status has ended and naming what
   changes (§1a.1); nothing is computed from size, because s.2(85) does not
   look at size for these two kinds.
3. Roles `shareholder`, `director`, `company_secretary` in `ROLE_SLUGS`,
   `ROLE_DEFINITIONS`, `ROLE_CLASSIFICATION_CEILING` (`confidential` for the
   two portal roles — they never see regulated HR data), `ROLE_GRANT_MATRIX`
   with the cells in §3.4 against the phase-1 resources (empty until phase 1
   lands; declare the resources now so boot autosync grants them once).
   New affiliation types `shareholder`, `director`, `company_secretary`.
   `chairman` gets a `director` affiliation in every subsidiary by the
   create-tenant script only when `--chairman-email` is given; nothing is
   implied.
4. Sign-ins for outsiders, without email. `POST /equity/holders/:id/sign-in`
   and the same for board members (chairman or company secretary): creates
   the `Principal` if the email has none, creates this tenant's `User` and a
   `shareholder`/`director` affiliation, and returns a generated password
   **once**, as the seed does. Calling it again resets the password. No
   invite, no one-time code, no reset link — decided by the chairman
   (§1.10); the platform sends no email. The audit record names who created
   or reset the sign-in.
5. Portal surface. Worker var `PORTAL_HOSTS` (comma-separated) surfaced through
   `/api/meta/version` as `surfaceHosts.portal`; client sets `surface =
   'portal'` when `location.hostname` matches, or when the active role's
   archetype is `portal`. `apps/web/src/portal/PortalShell.tsx`: masthead with
   the entity name and picker, three sections (Holdings, Board, Documents),
   footnote kept. `navigationFor()` already filters by archetype; add the
   portal nodes to `NAV_REGISTRY` with `archetypes: ['portal']`. The ERP host
   with a portal-only principal renders the portal shell, never the sidebar.
   Add a `routes` entry to `wrangler.jsonc` for the portal host once question
   2 is answered; until then the dev proxy serves both on `localhost`
   with `?surface=portal` honoured in development only.
6. Global 401 handling in `lib/api.ts` (clear token, return to sign-in) — a
   portal user's session expiring into a page of error boxes is not
   acceptable on a screen that shows share certificates.

Tests: `EQT-IDN-001` one principal, two tenants, two users, one password;
`EQT-IDN-002` switch-entity refused without an active affiliation there and
returns 404 not 403; `EQT-IDN-003` revoking the director affiliation makes
the next request fail; `EQT-IDN-004` portal archetype sees only portal nav on
either host; `EQT-IDN-005` the tenant gate still throws inside the group
tenant when reading a subsidiary model with no scope (the existing
`CRM-FOUND-001` suite re-run against a parent/child pair).

### Phase 1 — The register

Files: `schema.prisma`, new `apps/api/src/domains/equity.ts`,
`routes/equity.routes.ts`, `platform/documentNumber.ts` (series `C`),
`seed/bootstrap.ts` nav (`group: 'equity'` ⇒ add to `GROUP_ORDER` /
`GROUP_LABELS` in `Shell.tsx`), `packages/shared/src/equity.ts` (cap-table
arithmetic, pure, tested), web pages `CapTable.tsx`, `ShareClasses.tsx`,
`Holders.tsx`, `ShareLedger.tsx`, `CertificateDocument.tsx`, portal pages
`Holdings.tsx`, `Certificates.tsx`, `Documents.tsx`.

1. Models `ShareClass`, `Holder`, `ShareTransaction`, `ShareCertificate`,
   `Valuation`, `EntityProfile` fields. `Holder` for a person goes through
   `findOrCreatePerson` (an investor who is also a contact is one row).
2. `equity.ts`: `createShareClass`, `proposeAllotment`, `proposeTransfer`,
   `approveShareTransaction` (through `approvals.ts`; the secretary cannot
   approve; the bar reroutes an interested approver), `makeEffective` (assigns
   distinctive numbers gaplessly per class, issues or supersedes
   certificates), `reverseShareTransaction`, `capTable(asOf?)` returning
   issued and fully-diluted columns and per-holder percentages,
   `holdingsFor(holderId)`, `recordValuation`.
3. `considerationTransactionId` must reference a `Transaction` on a category
   of `kind: 'equity'` in the same tenant or the allotment stays
   `pending_consideration`; the cap table shows the flag.
4. Certificate document view + printable sheet from `documentSheet.tsx`;
   figures and names snapshotted at issue.
5. Cap table page: table first (holder, class, count, issued %, fully-diluted
   %, certificates, since), one donut second, with a **new** categorical
   palette validated per `apps/web/DESIGN.md` — the division hues are
   reserved. Money withheld renders `Withheld`, as elsewhere.
6. Portal: Holdings (own rows only, `@own` resolved through `Holder.personId`
   ⇒ the session's `partyId`; an organisation holder is visible to the persons
   affiliated as its contacts), Certificates (print), Documents (entity
   documents marked `audience: shareholders`).
7. Import: a template (`Data` + `How to fill this in` sheets, numbered after
   the existing ones) for the opening register — holders, classes, opening
   allotments with distinctive ranges — through the existing preview/commit
   import path, so the first cap table is not typed in.

Tests: `EQT-REG-001` the ledger is append-only (no update route; reversal
posts the opposite); `EQT-REG-002` distinctive numbers are gapless and never
overlap within a class; `EQT-REG-003` the secretary cannot approve their own
proposal and the chairman cannot approve a transfer they receive;
`EQT-REG-004` cap table sums to 100.00% on both bases and a pending
consideration is visible; `EQT-REG-005` a shareholder reads only their own
holdings and a cross-holder read is 404; `EQT-REG-006` an issued certificate's
view is byte-identical after a later transfer of other shares;
`EQT-REG-007` the two-month certificate window raises a compliance item.

### Phase 2 — The group

Files: `apps/api/src/domains/group.ts`, `jobs/scheduler.ts` (a
`publish_entity_snapshot` job), event subscribers in `events/handlers.ts`,
`packages/shared/src/equity.ts` (look-through), web `Group.tsx`,
`GroupEntity.tsx`, portal `Entities.tsx`.

1. `EntitySnapshot` written to the parent under `asSystem(parent)` on
   `kz.eqt.*` effective events and nightly; carries `sourceEventHash`. The
   financial block is the same summary The Business renders (cash position,
   P&L by division for the last complete month and the year to date,
   headcount), computed by the existing `books.ts` report functions inside
   the subsidiary's own context; published unconditionally (§1.4).
   `Transaction.intercompanyTenantId` is set by the finance head on entry
   (a counterparty picker offers group entities) and the snapshot carries
   the inter-company totals.
2. Group dashboard (holding tenant; `chairman`, `director` and `shareholder`
   affiliated there — a holding-level shareholder sees every entity's
   summary, per §1.4, through the portal's Entities page which is the same
   data with the ERP chrome removed):
   structure chart (entities as nodes, edge % from the subsidiary's own cap
   table, subsidiary/associate/WOS badge by the s.2(87) test, layer count
   against two), per-entity tiles (paid-up by class, fully-diluted, pool
   granted/available, demat status, last valuation, next compliance due,
   snapshot age), consolidated holders table (direct and look-through per
   principal, SBO flag at ≥10%), aggregated financial block labelled
   *Aggregated, not consolidated* with each entity's figure beside the sum.
3. Isolated view: an entity tile opens `switch-entity` and lands on that
   tenant's own cap table. The group screen never reads a subsidiary table.
4. The graph refuses an edge from a subsidiary into its holding (s.19) at
   `Holder` creation when `heldByTenantId` is the parent's parent chain.

Tests: `EQT-GRP-001` a snapshot is the only row the group screen reads
(grep-style test on `group.ts` for `unscopedPrisma`/`asSystem` outside the
publisher, mirroring the existing role-slug grep test); `EQT-GRP-002`
look-through arithmetic on the worked example; `EQT-GRP-003` a stale
snapshot is labelled with its age and never blended; `EQT-GRP-004` a
subsidiary cannot hold its holding's shares; `EQT-GRP-005` a chairman with
no affiliation in a subsidiary sees its snapshot on the group screen and
cannot switch into it.

### Phase 3 — Board

Meetings, agenda, attendance, minutes lifecycle with SS-1 dates
(notice ≥7 days; draft minutes within 15 days; entered within 30; four a
year with ≤120-day gap — half-yearly for small companies), circular
resolutions with dispatch proof and a "1/3 may demand a meeting" path,
votes with the interested-director abstention, s.179(3) subjects refused by
circulation, MBP-1 annual declaration prompt, board pack assembly (documents +
the published financial summary), signed-copy upload as the e-sign stand-in
with a provider adapter interface. Portal: Meetings, Resolutions (vote),
Board pack. Compliance items generated by a job. Tests `EQT-BRD-*`.

### Phase 4 — Rounds, instruments, valuations, scenarios

`FundingRound`, preference and debenture classes with rights, conversion and
redemption events that spawn or retire holdings, convertible notes, warrants,
rights issues (s.62(1)(a), with the offer-and-renunciation record), bonus
(s.63, from free reserves only — the books say whether they exist), sweat
equity (s.54, with the valuation report), private placement (s.42: offer
letter serial, separate bank account reference, the 200-person count),
buy-back (s.68: the 10%/25% and debt-equity tests computed from the books),
capital reduction (s.66, recorded against the tribunal order); valuation
records with basis; scenario modelling in `packages/shared/src/equity.ts` (pure: a
proposed round ⇒ post-money table, dilution per holder, waterfall by
preference stack) rendered client-side and never persisted as fact.
Tests `EQT-RND-*`.

### Phase 5 — ESOP

Plan, pool as a `ShareClass` of instrument `option`, grants to
`EmploymentRelationship`s (the HRM already has the employee), vesting with
cliff and tranches (Rule 12: ≥1 year between grant and first vesting,
validated), exercise ⇒ allotment, lapse on exit (subscribes to the HRM exit
event), perquisite computation needing a merchant-banker FMV on record,
SH-6 register export. Employee portal view under the existing `employee`
role. Tests `EQT-ESP-*`.

### Phase 6 — Filings and demat

Exports in the layouts the forms want: MGT-1 register, PAS-3 allottee list,
SH-4 pre-filled, SH-6, AOC-1 (from group snapshots), BEN-1/2 candidates from
look-through; demat mirror fields, ISIN, PAS-6 half-yearly reconciliation
item; FEMA items — FC-GPR within 30 days of an allotment to a repatriable
non-resident holder, FC-TRS within 60 days of a transfer between such a holder
and a resident, FLA by 15 July when any such holding exists, and the
fair-value floor check on the allotment price — generated from
`Holder.residency` and `investmentBasis`. The group has one NRI holder (§1.11),
so this is built, not optional.

### Phase 6b — Spinning a division out into a subsidiary

When a division is incorporated: `pnpm tenant:create --slug --name --parent
kaizen --origin-division education`, then a guarded `pnpm division:spin-out`
that previews, like an import, every division-tagged row it would carry
across — transactions, employment relationships, courses and enrolments,
organisations owned by that division — and the opening allotment of the
subsidiary's shares to KIPL (and to anyone else the chairman names) as the
first `ShareTransaction` in the new tenant. Rows are copied and marked
`migratedToTenantId`, never moved, so the holding's history still reads.
This phase is specified here so nothing earlier forecloses it; it is built
when the first subsidiary is formed.

---

## 7. Conventions the implementer must hold to

- Every domain function opens with `assertCan`/`assertScopeAll`; scoped
  `prisma` only; `unscopedPrisma` appears in `lib/auth.ts` and the snapshot
  publisher and nowhere else in this domain.
- No service code compares a role slug (the existing grep test will fail the
  PR). Narrowings are grants and scope resolvers.
- New resources in both `RESOURCES` and `ALL_RESOURCES`; new events in
  `EVENTS` with the `kz.eqt.*` grammar; `emit()` after every state change;
  a regulated read writes an `AuditRecord`, never an event.
- Money is `Decimal`; the client does no arithmetic on document views.
- Plain words on screen (`Cap table`, `Register`, `Board`), codes in tooltips.
  Empty states are true sentences: "No shares have been allotted yet."
- Nav rows via `NAV_REGISTRY`; a new nav `group` needs `GROUP_ORDER` and
  `GROUP_LABELS` in `Shell.tsx`.
- Tests through `asUser` / `withFixtureRole`, named by requirement; one row
  in `docs/acceptance.md` per phase.
- Ask before: adding a cross-tenant read, storing a full bank account or PAN
  in plain text where the platform elsewhere masks it, or any e-sign or
  email provider dependency.

---

## Phase 3 — as built

Board members, meetings and their minutes lifecycle, circular and
meeting resolutions, and the daily compliance calendar landed as designed in
§5/§6, with a few notes for whoever builds on this next.

- `BoardMember.role` distinguishes a voting seat (`director`,
  `independent_director`, `nominee_director`) from `observer` and
  `company_secretary`; only the voting family counts toward quorum
  (`quorumFor`) and the s.175 demand threshold (`meetingDemandThreshold`),
  both mirrored in `@kaizen/shared` as pure functions so a screen can show
  "Quorum: 2 of 5 present" without waiting on a round trip, while the API
  computes the same numbers as the source of truth on every write.
- `Resolution.requiresMeeting` is derived once, at `proposeResolution`, from
  the closed `RESOLUTION_SUBJECTS_REQUIRING_MEETING` list (s.179(3) + Rule 8)
  and is never accepted as caller input; `passedBy: 'circulation'` on one of
  those subjects is refused outright, not silently upgraded to a meeting.
- An interested vote (`interested: true`, or the voter's declared interests
  naming the resolution's free-text `subjectRef`) is stored as `abstain` with
  `abstainedAsInterested` set, and is excluded from both the circulation
  majority's denominator and the meeting count under s.184 — the same
  exclusion, expressed once and read by `closeCirculation` and
  `passAtMeeting` alike.
- The compliance calendar is written by `runBoardComplianceJob`
  (`board_compliance`, daily) and is strictly a function of recorded facts:
  no board meeting and no `incorporatedOn` on file raises nothing at all —
  never a fabricated "overdue" — and the unique `(tenantId, kind,
  relatedType, relatedId, dueOn)` key is what actually keeps a re-run from
  duplicating a row; the job's own `raised` count is how many candidates it
  swept, not how many rows it wrote, so idempotence is proven against the
  table, not the return value (see `EQT-BRD-007`).
- `listBoardMembers` and the meeting reads (`listMeetings`, `meeting`,
  `boardPack`) now compute `interestsDeclaredThisYear` and `presentCount` on
  the way out, closing a gap between what `@kaizen/shared`'s view types
  already declared and what the domain functions returned — both are
  read-only projections of stored facts, never separately persisted.
- `Resolution.subjectRef` and `Vote.holderRef` stay the free-text/nullable
  placeholders §5 called for: nothing here depends on the phase-1 register,
  and a shareholder's vote (as opposed to a director's) is not yet wired to
  anything, since `holders`/`ShareTransaction` do not exist in this branch.
- ERP nav: `eq_board`/`eq_resolutions`/`eq_compliance` under a new `equity`
  group (after `money`), each with explicit `archetypes: ['command',
  'workspace', 'console']` — a node with no `archetypes` reaches the portal
  shell too, which these three must not. The portal's `portal_board` node
  (phase 0) is unchanged; it is the same data, filtered by the viewer's own
  grants (`shareholder` sees resolutions only, `director` sees the board
  calendar too).
- Screens: `pages/board/{Board,MeetingDetail,Resolutions,Compliance}.tsx` on
  the ERP side, `portal/pages/Board.tsx` rewritten from its phase-0
  placeholder. Every write control is gated by `can()` on the same grant
  the route asserts (`board_meetings:E`/`resolutions:E`/`resolutions:approve`/
  `compliance:E`/`board_documents:C`) — an omitted control, not a disabled
  one, where the grant is absent.
