# Equity, Shareholder & Board portal — plan

Status: **proposal, awaiting answers to the questions in §1.** Nothing in this
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
| §1 | Questions that change the build — please answer before phase 0 |
| §2 | What the codebase is today, and what this touches |
| §3 | Decisions, and the failures each one prevents |
| §4 | What the market does, and what is deliberately not copied |
| §5 | Data model |
| §6 | Phases, each a brief for Sonnet |
| §7 | Conventions the implementer must hold to |

---

## 1. Questions that change the build

Answers to these decide real code. Where a default is stated it is what the
plan assumes if no answer comes.

1. **What is the group, legally?** Is Kaizen Infinities Pvt Ltd (KIPL, the
   entity the ERP runs today) itself the holding company, or is there a
   separate "Kaizen Group" entity above it? List the subsidiaries with KIPL's
   percentage in each, and say whether any has outside shareholders today.
   *Default assumed: KIPL is the holding; the existing `kaizen` tenant becomes
   the holding tenant; each subsidiary is a new tenant.*
2. **Which hostname(s)?** One portal host for the whole group (e.g.
   `equity.kaizeninfinities.com`) with an entity picker, or one per subsidiary?
   Is DNS on Cloudflare, where the Worker already is? *Default: one host, an
   entity picker after sign-in.*
3. **Do shareholders and directors have corporate emails?** Routing by email
   domain works for staff. An outside investor signs in with a Gmail address
   and may hold shares in two subsidiaries. *Default: email domain is a sign-in
   hint that pre-selects an entity; the actual routing is by which entities
   the person holds a shareholder or director relationship in (§3.2).*
4. **How much of the ERP does a shareholder see?** Holdings and documents
   only, or also the entity's financial position (cash, P&L by division,
   the same figures as The Business)? And does a director see more than a
   shareholder? *Default: shareholders see holdings, certificates, valuations,
   round history, documents; directors additionally see the board pack, which
   can embed the financial summary the finance head chooses to publish.*
5. **"Consolidated" — aggregated or eliminated?** Adding subsidiary P&Ls
   together is not consolidation under Ind AS 110 / AS 21 (inter-company
   sales, dividends and the holding's investment must be eliminated).
   *Default: the group view says "Aggregated" and shows each entity's figure
   beside the sum; true consolidated statements are out of scope until a
   company secretary or auditor asks for them.*
6. **Which instruments, in the first release?** Plain equity only, or CCPS /
   CCD / convertible notes now? Is there an ESOP pool or plan today? *Default:
   phase 1 is equity and preference shares as classes; conversions, notes and
   ESOP follow in later phases (§6).*
7. **Who keeps the register?** The finance head, a new company-secretary role,
   or an outside CS firm that needs its own sign-in? *Default: a
   `company_secretary` role that maintains the register and cannot approve
   its own entries; the finance head and chairman approve.*
8. **Are KIPL's shares dematerialised?** Rule 9B (mandatory demat for private
   companies that are not "small") had a 30 June 2025 deadline. If the shares
   are in demat, the depository is the register of record and this system
   mirrors it (ISIN, PAS-6 half-yearly reconciliation). If KIPL and every
   subsidiary are small companies, physical certificates (SH-1) remain valid.
   *Default: physical register with a demat flag per entity, unfilled.*
9. **Board module scope?** Circular resolutions with e-sign, or full meetings
   with notice, agenda, attendance, minutes and SS-1 timelines? *Default:
   both, meetings in phase 3; e-sign is "upload the signed copy" until a
   provider (Leegality / DocuSign / Aadhaar eSign) is chosen.*
10. **Sign-in for outsiders.** Today: email + password, no reset, no invite,
    no second factor. External shareholders need an invitation flow and, for
    a surface showing share certificates, an email one-time code at sign-in.
    *Default: build invite + email OTP for portal roles in phase 0.*
11. **Any foreign shareholder, now or planned?** It adds residency to every
    holder and FC-GPR / FC-TRS / FLA to the compliance calendar. *Default:
    residency field present, FEMA reporting not built.*

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
classes, board calendar, open resolutions, the financial summary the entity's
finance head has marked publishable, valuation, compliance flags — written
under `asSystem(parentTenantId)` on the relevant events and by a nightly job.
The chairman's group dashboard reads **only rows in the holding tenant**.
Look-through ownership (founder 60% of KIPL × KIPL 70% of Sub A + founder 5%
direct = 47%) is computed over snapshots in the holding tenant.

Isolated view = switch entity (§3.2) into the subsidiary and use its own
screens. No consolidated screen ever queries a subsidiary's tables directly.

Why not a cross-tenant read grant for the chairman: it would be the first code
path where a request in tenant A reads tenant B's rows, and every later
feature would be tempted to use it. Publication keeps every read inside one
tenant, leaves an event on both sides, and lets a subsidiary decide what it
publishes upward (the finance head marks a period's summary publishable —
authority stays with the entity). The cost is staleness measured in seconds,
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
register is empty.

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
- `Tenant` + `parentTenantId?`, `kind`, `config.emailDomains: string[]`.
- `EntityProfile` — extends `CompanyProfile` 1:1 (or new columns on it):
  `incorporatedOn`, `financialYearEnd`, `authorisedCapital` per class,
  `isSmallCompany`, `dematStatus (physical | demat | mixed)`, `isin?`, `rta?`,
  `dpiitNumber?`, `dpiitRecognisedOn?`, `registeredOfficeAddress`.

**Register**
- `ShareClass` — `name`, `kind (equity | preference)`, `instrument (equity |
  ccps | ocps | ccd | ocd | convertible_note | warrant | option | phantom)`,
  `faceValue`, `votingRightsPerShare`, `rights Json` (liquidation preference
  multiple and participation, anti-dilution, pro-rata, board seat, information
  rights, dividend rate), `conversionTerms Json?`, `authorisedCount`.
- `Holder` — the party that holds: `kind (person | organization | entity)`,
  `personId? | organizationId? | heldByTenantId?` (the last is the
  entity-as-stakeholder link), `folioNumber`, `residency (resident |
  non_resident)`, `pan?`, `nomineeJson?`, `jointHolders Json?`.
- `ShareTransaction` — append-only; `type (allotment | transfer | conversion |
  buyback | split | bonus | forfeiture | cancellation)`, `shareClassId`,
  `fromHolderId?`, `toHolderId?`, `count`, `pricePerShare?`, `distinctiveFrom /
  distinctiveTo`, `effectiveOn`, `roundId?`, `considerationTransactionId?`
  (→ `Transaction`), `approvalDecisionId?`, `status (proposed | approved |
  effective | reversed)`, `reversalOfId?`, `boardResolutionId?`, `documents`.
- `ShareCertificate` — `certificateNumber` (document series `C`),
  `holderId`, `shareClassId`, `distinctiveFrom/To`, `count`, `issuedOn`,
  `status (issued | surrendered | cancelled)`, `supersededById?`, `signatories
  Json` (snapshotted names), `stampDutyPaid?`.
- `FundingRound` — `name`, `kind (seed | series | rights_issue | bonus |
  preferential | private_placement | esop_top_up)`, `preMoneyValuation?`,
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
   `PARENT_TENANT_SLUG` is unset and any tenant names it as parent.
3. Roles `shareholder`, `director`, `company_secretary` in `ROLE_SLUGS`,
   `ROLE_DEFINITIONS`, `ROLE_CLASSIFICATION_CEILING` (`confidential` for the
   two portal roles — they never see regulated HR data), `ROLE_GRANT_MATRIX`
   with the cells in §3.4 against the phase-1 resources (empty until phase 1
   lands; declare the resources now so boot autosync grants them once).
   New affiliation types `shareholder`, `director`, `company_secretary`.
   `chairman` gets a `director` affiliation in every subsidiary by the
   create-tenant script only when `--chairman-email` is given; nothing is
   implied.
4. Invitations and second factor for portal roles: `POST /auth/invite`
   (secretary or chairman; creates `Principal` with `status: invited`, emails
   a one-time link — email transport is whatever `platform/exceptions.ts`'s
   `notify` uses today; if it is log-only, the link is printed to the log and
   the plan says so), `POST /auth/accept-invite`, and an email OTP step on
   sign-in when the chosen affiliation's role archetype is `portal`. A
   password-reset route lands here too, because a portal user cannot walk
   over to the person who seeded them.
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
   `kz.eqt.*` effective events and nightly; carries `sourceEventHash`.
   The publishing side decides content: the financial block is only included
   for periods the finance head has marked `publishToGroup` (a new flag on
   the period close, or on a `books` report snapshot — whichever the books
   module already persists; if nothing is persisted, add a
   `PublishedFinancialSummary` row rather than recomputing on the parent).
2. Group dashboard (holding tenant, `chairman` and `director` there):
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

`FundingRound`, preference classes with rights, CCPS/CCD conversion events
that spawn allotments, convertible notes, warrants; valuation records with
basis; scenario modelling in `packages/shared/src/equity.ts` (pure: a
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
item; FEMA (FC-GPR/FC-TRS/FLA) items only when a non-resident holder exists.

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
