# Technology (the CIO office) — plan

What it takes for Kaizen Infinities to run its own technology estate on
KaiERP: every laptop and licence, every vendor and contract, every ticket,
incident and change, every risk, policy, control and access review, the
technology portfolio and its budget, and the continuity plan behind each
system — in the same structural style as the rest of the platform.
Authority separated, documents final once issued, everything audited,
deadlines run as jobs rather than remembered by a person, and a health score
that says *not yet measured* until there is something to measure.

On screen the module is called **Technology**. "CIO" is the audience, not a
label: the sidebar group says Technology, the overview says what the
technology estate is doing, and the person reading it is whoever holds the
CIO's chair — today the chairman, with the Operations Head running the desk
and the Finance Head signing the spend.

This document is the plan the build follows. It says what exists, what
principles the technology work extends from the platform's own rules, what
nine workstreams build, in what order, and what the company alone can
answer.

---

## Where the platform stands

| Area | Exists | Partial | Absent |
|---|---|---|---|
| Asset register | `FixedAsset` (`main.prisma`) — the *books'* capital register: cost, salvage, useful life, SLM/WDV, disposal | — | Serial numbers, assignment to a person, warranty, location, lifecycle (in stock → assigned → repair → retired), hand-over/return acknowledgement |
| Software and licences | — | `VendorBill` carries a vendor name and a bill; nothing says what was bought or for how many seats | Application catalogue, licence seats and renewals, SaaS subscriptions, seat utilisation, shadow-IT |
| Vendors and contracts | `Contract` / `Mou` / `PartnerAgreement` — *customer-side* agreements with the approval gate and expiry ladder | `VendorBill.vendorName` is a string, not a master | A vendor master, vendor risk tier, security assessment, DPA, vendor contract with notice period and renewal, tied to the self-dealing bar |
| Service desk | `ExceptionRecord` (system-raised problems), `Notification`, `Task` | — | A ticket a person raises, priority and SLA clocks from a dated table, assignment, comments, knowledge base, satisfaction |
| Incidents, problems, changes | `DataBreach` (privacy register) | — | Major-incident timeline (detected → acknowledged → mitigated → resolved), MTTR, post-incident review, problem/known-error, change request with CAB approval, freeze windows |
| Security and governance | `SecurityPolicy` (MFA/session/password), `BackupRun`, privacy `AccessReview` (stale affiliations), sensitivity registry, hash-chained audit | `H_RSK` rolls up exceptions | An IT risk register with inherent/residual scoring, IT policy documents staff acknowledge, a control library mapped to frameworks, an access-review campaign with a self-review bar, security findings with severity-driven remediation SLAs |
| Portfolio and budget | `BudgetLine` (finance, by category/period/division), `Project` (delivery) | — | A technology initiative with a business case and stage gates, a roadmap, run-vs-grow technology budget, technical debt |
| Continuity | `BackupRun` (the platform's own backup) | — | RTO/RPO per application, DR plan and test log, availability readings, maintenance windows |
| Command Center | Ten domain health scores, attention queue, decision queue | — | An eleventh domain for technology |

The gap has the shape the compliance plan found: the platform has the
structural primitives — governed writes, the record-code generator, the
approval gate, idempotent ladder jobs, the exception queue, health scoring
with an honest empty state — and has not pointed any of them at the
technology estate. What follows is nine domain modules wired onto existing
plumbing, not new plumbing.

---

## Principles for technology work

These extend rules the platform already enforces elsewhere.

1. **A record that names a thing is a register row, never a spreadsheet
   column.** An asset, a licence, a vendor, a ticket and a risk each get a
   record code from the unified generator (`ITA-2026-00001`), assigned at
   creation and never edited — the same discipline every other entity keeps
   (CRM-FOUND-007).
2. **The proposer never approves.** A vendor contract, a normal or emergency
   change, a policy publication and an initiative's funding each run
   through `evaluateApprovalGate` on the Self-Dealing Bar the platform
   already runs for MoUs and contracts. Nobody signs off their own change.
   An access review adds a second bar of the same kind: nobody reviews
   their own access.
3. **Deadlines are jobs, not memory.** Warranty end, licence renewal,
   contract notice period, SLA clocks, risk review dates, finding
   remediation dates, policy re-acknowledgement, DR test cadence — each is
   an idempotent ladder job keyed the way the expiry ladders already are,
   firing once at the tightest crossed rung, with the rung recorded on the
   row.
4. **Service targets are data, not constants.** SLA minutes by priority,
   remediation days by finding severity, RTO/RPO per application, risk
   scoring bands — each lives in a dated table with an effective-from date,
   the way statutory rates already do (compliance Principle 1).
5. **A timeline is append-only.** An incident's detected/acknowledged/
   mitigated/resolved timestamps are set once each; a ticket's comments,
   an asset's hand-overs, a DR test's result and a change's implementation
   note are new rows, never edits. A post-incident review is a document
   that is final once published.
6. **"Not yet measured" is distinct from "healthy."** A tenant with no
   tickets has no SLA attainment, not 100%. The Technology health domain
   reports each factor only when its inputs exist, and the summary
   endpoints every screen reads carry a `notYetMeasured` flag the way the
   compliance summaries do.
7. **What the platform does not do is stated on screen.** It does not
   discover devices on the network, does not meter SaaS logins, does not
   page anyone, and does not scan for vulnerabilities. Each screen says
   what is typed in and what is computed from it.
8. **Money stays in the books.** A licence's cost or a vendor contract's
   value is a figure on the technology record for planning; the movement
   of money is a `VendorBill` and a ledger transaction, linked by id, never
   duplicated. The technology budget reads actuals from the books through
   those links rather than storing its own.
9. **Plain words lead.** Sidebar and screen say Technology, Assets,
   Applications, Service Desk, Incidents, Changes, Risks, Policies, Access
   Reviews, Portfolio, Budget, Continuity. Codes (`H_TEC`, `S3_HIGH_RISK`,
   `P1`) sit in a tooltip or a chip, never as the primary label.

---

## Structure

Every workstream is built side by side, each in its own files, exactly the
way the compliance workstreams were:

| Layer | Path |
|---|---|
| Schema | `apps/api/prisma/schema/it-<ws>.prisma` |
| Shared types and pure arithmetic | `packages/shared/src/it/<ws>.ts` |
| Domain | `apps/api/src/domains/it/<ws>.ts` |
| Routes | `apps/api/src/routes/it/<ws>.routes.ts`, mounted at `/api/it/<segment>` |
| Seed | `apps/api/src/seed/it/<ws>.ts` (dated tables, defaults; idempotent by code) |
| Jobs | `apps/api/src/jobs/it/<ws>.ts` exporting `JOBS` |
| Tests | `apps/api/src/tests/it/<ws>.test.ts` |
| Web | `apps/web/src/pages/it/<Screen>.tsx`, routed under `/it/...` |
| Docs | `docs/it/<ws>.md` |

Cross-workstream references are bare string ids (an asset names its
`fixedAssetId`; a DR plan names its `applicationId`), resolved at the
service layer — the convention `main.prisma` already keeps. Relations are
declared only within a workstream's own file.

Resources, record codes, events, nav entries, grant cells and the health
domain are declared up front in the shared files so that no workstream
edits another's, and so that the chairman's row — generated from
`ALL_RESOURCES` — is complete from the first commit.

---

## Grant matrix

| Resource | Employee | Operations Head | Finance Head | Chairman |
|---|---|---|---|---|
| `it_assets` | `V@own` (what is assigned to me) | `VCEDAX` | `VF` | all |
| `it_applications` | `V@all` (the catalogue) | `VCEDX` | `V` | all |
| `it_licences` | – | `VCEX` | `VF,approve` | all |
| `it_vendors` | – | `VCEX` | `V` | all |
| `it_vendor_contracts` | – | `VCEX` | `VF,approve` | all |
| `it_tickets` | `VC@own` | `VCEDAX` | `V` | all |
| `it_sla_policies` | – | `VCE` | `V` | all |
| `it_knowledge` | `V@all` | `VCEDX` | `V` | all |
| `it_incidents` | – | `VCEDAX` | `V` | all |
| `it_problems` | – | `VCEDAX` | `V` | all |
| `it_changes` | `VC@own` (an engineer proposes) | `VCEX,approve` | `V` | all |
| `it_risks` | – | `VCEX` | `V` | all |
| `it_policies` | `V@all` (published policies) | `VCEX` | `V` | all (`approve` publishes) |
| `it_policy_acknowledgements` | `VC@own` | `V` | `V` | all |
| `it_controls` | – | `VCEX` | `V` | all |
| `it_access_reviews` | – | `VCEA` | `V` | all |
| `it_findings` | – | `VCEDX` | `V` | all |
| `it_initiatives` | – | `VCEX` | `V,approve` | all |
| `it_budgets` | – | `VCE` | `VCEDXF,approve` | all |
| `it_tech_debt` | – | `VCEDX` | `V` | all |
| `it_continuity` | – | `VCEDX` | `V` | all |

The shape is the compensation split, applied to technology: the Operations
Head runs the desk and proposes spend; the Finance Head approves licences,
vendor contracts, budgets and initiative funding and sees the cost; the
chairman publishes policy and approves a change the Operations Head raised.
`approve` is never held beside `create` on the same resource by the same
role except where the self-dealing bar makes it safe (`it_changes` for the
Operations Head: an engineer's change is theirs to approve, their own goes
to the chairman).

---

## Workstreams

### A. Assets and devices

**Today.** `FixedAsset` is the books' register (cost, depreciation,
disposal) and nothing else: no serial, no assignee, no warranty, no
location, no hand-over.

**Build.** `ItAsset` — tag, kind (laptop | desktop | phone | monitor |
peripheral | network | server | other), make/model, serial, purchase date
and cost, warranty end, supplier (vendor name or `vendorId`), location,
division, `fixedAssetId` when capitalised, status lifecycle `in_stock →
assigned → in_repair → retired → disposed` run through `platform/lifecycle`,
condition, notes. `ItAssetAssignment` — append-only hand-over/return log:
who, from when, to when, condition out and in, acknowledged at.
`ItAssetEvent` — append-only history (repair, audit sighting, note).
Warranty ladder job at 90/30/7 days and expired; an asset in repair longer
than a dated threshold raises an exception; an assigned asset whose holder's
affiliation has ended raises `IT_AST_ORPHANED` (the exit checklist's
technology half). Summary: counts by kind and status, warranty expiring,
assets per person, unassigned stock, book value from the linked
`FixedAsset`. Screens: Assets list (tabs by status, filters by kind and
holder), Asset detail (timeline, assign / return / repair / retire
controls that appear only when the lifecycle says they exist), employee's
own assets on My IT.

**Acceptance.**
- IT-AST-001: PASS when an asset's transitions are exactly those its state
  machine declares, FAIL if `disposed` is reachable from `assigned`.
- IT-AST-002: PASS when assigning writes an assignment row and returning
  closes it without editing the earlier row; the history is append-only.
- IT-AST-003: PASS when the warranty ladder fires once per rung and a
  second run on the same day raises nothing new.
- IT-AST-004: PASS when an employee lists assets and sees only those
  assigned to them; FAIL if another person's laptop appears.
- IT-AST-005: PASS when an asset held by a person whose affiliation has
  ended surfaces as an exception with the asset as subject.

### B. Applications, licences and subscriptions

**Today.** Nothing names the software the company runs on.

**Build.** `ItApplication` — the catalogue: name, vendor, category, tier
(1 critical … 4 low), hosting (saas | on_prem | cloud), owner party, data
classification handled, SSO (yes/no), status (evaluating | active |
sunsetting | retired), URL, notes, `vendorId`. `ItLicence` — per
application: kind (per_seat | site | perpetual | usage), seats purchased,
seats in use (typed in — the platform does not meter logins), cost per
period, billing cycle, term start/end, renewal date, notice days, auto-
renew, `vendorContractId`, `vendorBillId` of the last bill, status
(active | expiring | expired | cancelled). `ItLicenceEvent` — append-only
seat and renewal history. Renewal ladder at 90/60/30/7 and expired; seat
over-allocation (in use > purchased) and under-use (< 60 % over a dated
threshold) raise exceptions; a renewal above the Finance Head's ceiling
opens an approval step through the gate. Summary: applications by tier,
annualised licence spend, renewals in 90 days, seats purchased vs used,
applications with no owner (a routing defect, like an unowned obligation).
Screens: Applications list and detail (licences, incidents, DR plan
links), Licences list (tabs: renewing, over-allocated, all) and detail.

**Acceptance.**
- IT-APP-001: PASS when an application with no owner raises an exception
  rather than sitting silently unowned.
- IT-LIC-001: PASS when the renewal ladder fires once per rung; a second
  run is idempotent.
- IT-LIC-002: PASS when seats in use above seats purchased raises an
  over-allocation exception naming the licence.
- IT-LIC-003: PASS when a renewal proposal by the Operations Head opens an
  approval step and the Operations Head cannot decide it; FAIL if the
  proposer's own decision is accepted.
- IT-LIC-004: PASS when annualised spend normalises monthly, quarterly and
  annual billing to one figure (pure arithmetic, no DB).

### C. Vendors and contracts

**Today.** `VendorBill.vendorName` is free text. Customer-side contracts have
a gate and a ladder; supplier-side ones have nothing.

**Build.** `ItVendor` — name, `organizationId` when they are also a party
we deal with, category, tier, risk rating (dated), security assessment
(status, date, score, next due), DPA signed, contact, status. `ItVendorRisk
Assessment` — append-only questionnaire results. `ItVendorContract` —
title, vendor, value, currency, term, start/end, notice days, auto-renew,
SLA text, `documentId`, status `draft → proposed → approved → active →
expiring → expired | terminated`, approval through
`POL-IT-VENDOR-CONTRACT-APPROVAL` on the Self-Dealing Bar, renewal chains
via `renewedFromId`. Notice-period ladder (notice date − 30/7 days, and
passed) so a contract that will auto-renew is noticed before it does.
Summary: vendors by tier, contract value under management, expiring in 90
days, assessments overdue. Screens: Vendors list and detail (contracts,
licences, assessment history), Contracts list and detail (approve /
terminate / renew).

**Acceptance.**
- IT-VEN-001: PASS when a vendor whose security assessment is past its
  next-due date raises an exception.
- IT-VCT-001: PASS when approving a contract one proposed reroutes to the
  next tier with `selfDealingBarTripped`.
- IT-VCT-002: PASS when the notice ladder fires once per rung and marks
  `expiring` then `expired`.
- IT-VCT-003: PASS when terminating requires a reason and leaves the
  contract's approval history intact.

### D. Service desk

**Today.** `ExceptionRecord` is what the *system* raises. Nothing a person
raises exists.

**Build.** `ItSlaPolicy` — dated table: priority (P1 … P4) → response and
resolution minutes, business hours flag. `ItTicket` — requester party,
category (incident | request | access | question), priority, status
`new → triaged → in_progress → waiting → resolved → closed` (and
`reopened` from resolved), assignee, `assetId`, `applicationId`,
response-due and resolve-due computed at triage from the policy in force,
first-responded-at, resolved-at, satisfaction (1–5, set by the requester
on close). `ItTicketComment` — append-only, public or internal.
`ItKnowledgeArticle` — title, body, application, published/retired,
helpful count. SLA job: response and resolution breaches raise exceptions
on the assignee (or the desk owner when unassigned) once per clock; a
ticket waiting more than a dated threshold raises a nudge. Summary: open by
priority, SLA attainment this month (response and resolution, or
*not yet measured*), median time to resolve, backlog age, satisfaction.
Screens: Service Desk (tabs: mine, unassigned, open, breached, all),
Ticket detail (timeline, comments, assign / triage / resolve / close,
satisfaction), Knowledge base, and **My IT** — an employee's own tickets,
own assets, policies awaiting their acknowledgement, and a raise-a-ticket
form.

**Acceptance.**
- IT-SLA-001: PASS when triage stamps due times from the policy dated as
  in force on the ticket's creation date, not today's.
- IT-TKT-001: PASS when an employee sees only tickets they raised and can
  raise one; FAIL if they can assign or see another's.
- IT-TKT-002: PASS when the SLA job raises one breach exception per clock
  and a re-run raises none.
- IT-TKT-003: PASS when only the requester can rate a resolved ticket and
  the rating is set once.
- IT-TKT-004: PASS when SLA attainment reports *not yet measured* with no
  closed tickets in the period, never 100 %.

### E. Incidents, problems and changes

**Today.** `DataBreach` covers personal-data breaches; nothing covers an
outage, a root cause or a change.

**Build.** `ItIncident` — title, severity (sev1 … sev4), affected
applications (ids), detected / acknowledged / mitigated / resolved
timestamps each set once, commander party, impact statement, customer-
facing flag, `breachId` when it is also a personal-data breach, `problemId`,
post-incident review (required for sev1/sev2: document, published at,
final once published). `ItIncidentUpdate` — append-only status updates.
`ItProblem` — root cause, known error, workaround, status, linked incidents.
`ItChange` — title, kind (standard | normal | emergency), risk (low |
medium | high), affected applications, plan, rollback plan, window
start/end, requester, status `draft → submitted → approved → scheduled →
implemented → reviewed | failed | rolled_back | rejected`, approval through
`POL-IT-CHANGE-APPROVAL` (standard changes are pre-approved by kind;
normal and emergency go to the gate), implementation and review notes set
once. `ItChangeFreeze` — dated windows in which a normal change cannot be
scheduled. Jobs: an open sev1/sev2 with no update in a dated interval
raises an exception; a sev1/sev2 resolved without a review after N days
raises one; a change scheduled inside a freeze is refused at the API.
Summary: open incidents by severity, MTTR (30 days, or not yet measured),
change success rate, changes awaiting approval, freeze in force.
Screens: Incidents list and detail (timeline, updates, declare / acknowledge
/ mitigate / resolve, review), Problems, Changes list and detail
(submit / approve / schedule / implement / review).

**Acceptance.**
- IT-INC-001: PASS when timeline stamps are set once and a second
  `acknowledge` is refused.
- IT-INC-002: PASS when a sev1 cannot close without a published review and
  a published review cannot be edited.
- IT-CHG-001: PASS when a normal change one raised cannot be approved by
  its raiser (self-dealing bar) while a standard change needs no step.
- IT-CHG-002: PASS when scheduling inside a freeze window is refused with
  the window named.
- IT-CHG-003: PASS when change success rate counts only reviewed changes
  and reports not yet measured with none.

### F. Security and governance

**Today.** MFA policy, backups and a privacy access review exist. No risk
register, no policy documents staff acknowledge, no control library, no
findings.

**Build.** `ItRisk` — title, category, owner, likelihood and impact (1–5,
inherent and residual), score and band computed from a dated scoring
table, treatment (accept | mitigate | transfer | avoid), treatment plan,
review date, status (open | treating | accepted | closed), linked controls.
`ItPolicyDocument` — code, title, body, version, status `draft →
published → superseded | retired`, publication through
`POL-IT-POLICY-PUBLISH` (the chairman publishes what the Operations Head
drafts), applies-to roles, re-acknowledgement months. `ItPolicyAcknowledge
ment` — party, policy version, acknowledged at; append-only. `ItControl` —
code, title, framework references (ISO 27001 Annex A, SOC 2, DPDP), owner,
frequency, last tested, result, evidence `documentId`, status. `ItAccess
Review` — a campaign: scope (all users, a role, an application), due date,
status; `ItAccessReviewItem` — one per user/affiliation/application access
in scope, reviewer, decision (keep | revoke | modify), decided at; a
reviewer may not decide their own row. `ItSecurityFinding` — source
(pentest | scan | audit | internal), severity, CVSS optional, affected
application/asset, due date from a dated remediation table, status,
`changeId` of the fix. Jobs: risk review overdue, finding overdue by
severity, control test overdue, policy re-acknowledgement due, access-
review campaign overdue — each a ladder with the rung on the row. Summary:
open risks by band, findings overdue, control test coverage, policy
acknowledgement rate (or not yet measured), access reviews in progress.
Screens: Risks, Policies (list, detail, acknowledge), Controls, Access
Reviews (campaign, item decisions), Findings.

**Acceptance.**
- IT-RSK-001: PASS when residual score and band come from the dated table
  (pure arithmetic tested without DB) and never from a constant.
- IT-POL-001: PASS when publishing needs `approve`, the drafter cannot
  publish their own draft, and a published version is immutable — a change
  is a new version.
- IT-POL-002: PASS when an employee can acknowledge a published policy
  once per version and the rate counts only current versions.
- IT-ACR-001: PASS when a reviewer's decision on their own access is
  refused with the self-review bar named.
- IT-FND-001: PASS when a finding's due date follows the remediation table
  in force at creation, and the overdue ladder is idempotent.

### G. Portfolio and budget

**Today.** `Project` is delivery, `BudgetLine` is finance. Neither knows
what a technology initiative is.

**Build.** `ItInitiative` — title, theme (run | grow | transform), sponsor,
owner, business case, expected benefit, budget, spend to date (computed
from linked vendor bills and licences, never typed), stage `idea →
assessed → approved → in_flight → delivered → benefits_realised |
cancelled`, RAG status with a dated reason, target quarter, `projectId`
when delivery runs it, approval through `POL-IT-INITIATIVE-APPROVAL` on
budget value. `ItInitiativeUpdate` — append-only status reports.
`ItRoadmapItem` — quarter, theme, initiative, milestone. `ItBudgetLine` —
FY, category (licences | hardware | vendors | cloud | people | other),
division, run/grow, planned; actuals computed from the books' `VendorBill`
and `Transaction` categories tagged to technology, and from licences'
annualised cost. `ItTechDebtItem` — title, application, severity, effort,
interest (what it costs to leave), status, `initiativeId` that retires it.
Jobs: an in-flight initiative with no update in a dated interval raises an
exception; budget burn ahead of the FY elapsed by more than a dated margin
raises one. Summary: portfolio by stage and RAG, budget planned vs actual
by category, run/grow split, tech-debt by severity. Screens: Portfolio
(kanban by stage, detail with updates and gate transitions), Roadmap
(quarters × themes), Budget (planned vs actual, divisions in their fixed
colours), Technical debt.

**Acceptance.**
- IT-INI-001: PASS when approving an initiative one sponsors reroutes on
  the self-dealing bar; below the ceiling the Finance Head approves
  directly.
- IT-INI-002: PASS when stage transitions are exactly those declared and
  `benefits_realised` is unreachable from `in_flight`.
- IT-BUD-001: PASS when actuals are a sum over linked books rows and a
  late bill moves the variance (nothing is stored).
- IT-BUD-002: PASS when the burn detector fires once per FY margin
  crossing.

### H. Continuity and operations

**Today.** `BackupRun` records the platform's own backup. Nothing says which
system must be back in how long.

**Build.** `ItContinuityPlan` — per application: RTO and RPO (minutes),
backup method and frequency, restore procedure `documentId`, owner, last
tested, test cadence days, status. `ItContinuityTest` — append-only:
tested at, kind (restore | failover | tabletop), outcome, actual recovery
minutes, notes, evidence `documentId`. `ItAvailabilityReading` — per
application per month: minutes down, incidents, uptime % computed, source
(typed in or from incidents). `ItMaintenanceWindow` — application, start,
end, reason, `changeId`, notified at. Jobs: DR test overdue by cadence;
plan missing for a tier-1/2 application; a test whose actual recovery
exceeded RTO raises an exception. Summary: tier-1 applications with a
tested plan, tests overdue, availability last month (or not yet measured),
next maintenance. Screens: Continuity (plans by application with test
history, record a test), Availability, Maintenance windows.

**Acceptance.**
- IT-DR-001: PASS when a tier-1 application without a continuity plan
  raises an exception with the application as subject.
- IT-DR-002: PASS when a test whose recovery time exceeds RTO raises an
  exception and the test row is immutable afterwards.
- IT-DR-003: PASS when the overdue-test ladder is idempotent per rung.
- IT-AVL-001: PASS when uptime % is pure arithmetic over minutes and a
  month with no reading reports not yet measured.

### I. The Technology overview, the health domain and the documents

Built last, against the summaries A–H expose.

**Build.** `GET /api/it/overview` — one call that composes every
workstream's summary into a KPI wall: assets and warranty runway, licence
spend and renewals, vendor contracts expiring, open tickets and SLA
attainment, incidents and MTTR, change success, risks by band, findings
overdue, policy acknowledgement, portfolio RAG, budget burn, continuity
coverage — each tile with a drill path, and each *not yet measured* when
its workstream says so. `H_TEC` — the eleventh Command Center domain,
computed in `health.ts` from six factors (SLA attainment, incident
recovery, change success, risk exposure, finding remediation, continuity
coverage), each omitted while unmeasured; owner resolution prefers the
Operations Head then the chairman. Nav, `DOMAIN_WORDS`, the acceptance
crosswalk (`docs/acceptance.md`), `docs/it/README.md`, the README's module
list and *What to look at*, and one Playwright smoke test that walks the
Technology group.

**Acceptance.**
- IT-OVR-001: PASS when the overview renders every tile as not yet
  measured on an empty tenant and no tile reads zero.
- IT-HLT-001: PASS when `H_TEC` reports `not_yet_measured` with no inputs
  and a measured score once tickets and incidents exist.

---

## Sequencing

1. Shared declarations (resources, cells, codes, events, nav, health
   domain, gate subject types, index files, page stubs) — one commit, so
   the build is green before any workstream starts.
2. A–H in parallel, each in its own files against its own test database.
3. I, once A–H have landed: overview, health, docs, acceptance, README,
   smoke test.
4. Full suite, typecheck, web build, grant reconciliation plan empty.

---

## What the platform will still not do

- Discover devices, meter logins, page an on-call engineer, or scan for
  vulnerabilities. Every figure here is typed in or computed from what was
  typed in, and each screen says which.
- Pay a vendor. A contract and a licence carry a value; the bill and the
  payment are the books'.
- Replace the privacy access review or the personal-data breach register.
  An IT incident that is also a breach links to the breach; an access
  review campaign reads the same affiliations the privacy review does.

---

## Open questions for Kaizen Infinities

- Which applications are tier 1 today, and who owns each?
- What are the SLA targets the desk should be held to — the seeded P1 30 min
  / 4 h … P4 2 d / 10 d table is a starting point, not a decision.
- Which frameworks matter for the control library — ISO 27001 only, or SOC 2
  and DPDP alongside?
- Does the Finance Head's authority ceiling for licence and contract
  approval match the one already set for customer contracts?
