# Technology

The CIO's office, built onto the platform's own plumbing (`docs/plan/cio.md`).
Every laptop and licence, every vendor and contract, every ticket, incident
and change, every risk, policy, control and access review, the technology
portfolio and its budget, and the continuity plan behind each system — each
a register row with a record code, an audited write and a state machine of
its own, the same discipline the rest of KaiERP already keeps.

On screen the module is called **Technology**. "CIO" is the audience, not a
label: the sidebar group says Technology, the overview says what the
technology estate is doing, and the person reading it is whoever holds the
CIO's chair — today the chairman, with the Operations Head running the desk
and the Finance Head signing the spend.

---

## The nine workstreams

**A. Assets and devices** — the laptop, phone or server a person actually
holds: tag, serial, warranty, location, and a lifecycle (`in_stock →
assigned → in_repair → retired → disposed`) that runs through the platform's
own state-machine engine, so the buttons on a row can never drift from the
diagram. An asset still held by someone whose affiliation has ended surfaces
as an exception rather than staying quietly assigned. See
[docs/it/assets.md](assets.md).

**B. Applications, licences and subscriptions** — the catalogue of what the
company runs on, and the seats it pays for underneath each entry: kind,
billing cycle, renewal date, seats purchased against seats in use (typed in
— the platform does not meter logins). Renewals are chased by a ladder job;
seat over-allocation and an application with no owner both raise an
exception. See [docs/it/software.md](software.md).

**C. Vendors and contracts** — the supplier side `VendorBill.vendorName`
never had: a vendor master with a risk tier and a security-assessment
cadence, and a vendor contract that runs through the same approval gate and
notice-period ladder the platform's customer-side contracts already use. See
[docs/it/vendors.md](vendors.md).

**D. Service desk** — a ticket a person raises, distinct from
`ExceptionRecord` (what the system raises): priority and SLA clocks stamped
from a dated table at the moment of triage, assignment, comments, a
knowledge base, and **My IT** — an employee's own tickets, own assets, and
the policies waiting on their acknowledgement. See
[docs/it/servicedesk.md](servicedesk.md).

**E. Incidents, problems and changes** — a major-incident timeline
(detected → acknowledged → mitigated → resolved, each stamp set once), a
post-incident review that is final once published, a problem/known-error
register, and a change request that a normal or emergency change routes
through the self-dealing bar — an engineer's own change goes to someone
else, a standard change needs no step at all. A change cannot be scheduled
inside a declared freeze window. See [docs/it/itsm.md](itsm.md).

**F. Security and governance** — an IT risk register scored from a dated
table rather than a constant, IT policy documents staff acknowledge (a
published version is immutable), a control library mapped to the frameworks
that matter, an access-review campaign where nobody may decide their own
row, and security findings with severity-driven remediation deadlines. See
[docs/it/governance.md](governance.md).

**G. Portfolio and budget** — a technology initiative with a business case
and stage gates, funded through the approval gate above a value ceiling, a
roadmap by quarter and theme, a run-vs-grow technology budget that reads its
actuals from the books rather than storing its own, and a technical-debt
register. See [docs/it/portfolio.md](portfolio.md).

**H. Continuity and operations** — an RTO/RPO per application, a DR plan and
its append-only test log (a test whose actual recovery time exceeds the RTO
raises an exception), availability readings and uptime computed purely from
minutes down, and maintenance windows. See
[docs/it/continuity.md](continuity.md).

**I. The overview, the health domain and these documents** — built last,
against the summaries A–H expose: `apps/web/src/pages/it/Overview.tsx`
composes every workstream's `GET /it/<segment>/summary` into one KPI wall,
each tile carrying a drill path and reading "Nothing to measure yet" rather
than a zero when its workstream has nothing behind it yet; `H_TEC` is the
eleventh Command Center health domain, computed in `health.ts` from six
factors — SLA attainment, incident recovery, change success, risk exposure,
finding remediation, continuity coverage — each omitted while unmeasured.

---

## Grant matrix

The shape is the compensation split, applied to technology: the Operations
Head runs the desk and proposes spend; the Finance Head approves licences,
vendor contracts, budgets and initiative funding and sees the cost; the
chairman publishes policy and approves a change the Operations Head raised.
`approve` is never held beside `create` on the same resource by the same
role except where the self-dealing bar makes it safe (`it_changes` for the
Operations Head: an engineer's change is theirs to approve, their own goes
to the chairman).

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

## The API

Mounted at `/api/it`. Every workstream owns a segment of it: `/assets`,
`/applications` and `/licences`, `/vendors` and `/contracts`, `/tickets`,
`/sla-policies`, `/knowledge` and `/my`, `/incidents`, `/problems` and
`/changes`, `/risks`, `/policies`, `/controls`, `/access-reviews` and
`/findings`, `/initiatives`, `/roadmap`, `/budget` and `/tech-debt`,
`/continuity`, `/availability` and `/maintenance`, and `/overview`. Every
list endpoint returns an array or `{ items, total }`; every `GET
/<segment>/summary` returns `{ notYetMeasured, ... }` — the field a screen
checks before it trusts a figure, because a tenant with nothing recorded yet
has nothing to report, not a zero.

## The health domain

`H_TEC` — "Technology" on screen, "are the systems we run on being looked
after?" — is the Command Center's eleventh domain, computed from six
factors: SLA attainment, incident recovery, change success, risk exposure,
finding remediation, and continuity coverage. Each factor is omitted from
the score while its inputs do not exist, so a brand-new tenant reports
`not_yet_measured` rather than a flattering 100 or a frightening 0. Owner
resolution prefers the Operations Head, then the chairman.

## What the platform does not do

Stated on every Technology screen, per Principle 7 of the plan: it does not
discover devices on the network, does not meter SaaS logins, does not page
anyone, and does not scan for vulnerabilities. Every figure here is typed in
or computed from what was typed in, and each screen says which. It does not
pay a vendor either — a contract and a licence carry a value, the bill and
the payment are the books' — and it does not replace the privacy access
review or the personal-data breach register; an IT incident that is also a
breach links to the breach, and an access-review campaign reads the same
affiliations the privacy review does.
