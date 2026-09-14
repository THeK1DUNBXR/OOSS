# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Four internal roles at Kaizen Infinities, each seeing a genuinely different
product on the same screens, via a five-axis permission model (WHO/WHERE/
WHAT/HOW MUCH/WHY) rather than a role check in code:

- **Employee** — own leave, attendance, goals, skills and payslip; the staff
  and skills directories; raises invoices for what they sell and sees only
  the ones they raised.
- **Operations Head** — the employment lifecycle end to end, payroll
  *preparation*, disciplinary records, projects, education and the course
  catalogue. Proposes pay, cannot approve it.
- **Finance Head** — the books, GST returns, and approves compensation and
  payroll, without running HR.
- **Chairman** — superadmin: every resource, every verb, every scope.

The load-bearing fact: the person who proposes a number is never the person
who approves it, and nobody — including the Chairman — can approve their
own. Design for privileged actions (pay change, approval, payroll) should
make that separation visible, not just rely on the server to enforce it.

## Product Purpose

KaiERP is the ERP platform Kaizen Infinities runs its own company on. CRM,
HRM and Finance are the three domains the company runs on; Education,
Projects, Commercial, Governance and a Command Center ship alongside them
because the product's premise is that all of it is one system that shares
identity, permissions and an event history — not nine tools that happen to
integrate. Success means the company's own day-to-day work (sales pipeline,
staff lifecycle, invoicing, GST filing, course delivery, partnership
management) runs on this platform with figures that tie back to the books
to the paisa.

## Positioning

Built from a named source document (*Kaizen Infinities Unified Operating
Platform — Master Architecture*) with numbered, testable requirements: 39
CRM requirements with PASS/FAIL acceptance criteria, an eleven-state HRM
lifecycle machine, and a defined finance model. What a neighboring product
could not truthfully copy without the same discipline:

- **One identity, one event history, one permission evaluator across every
  domain.** A lead, an employee and a ledger entry can all trace back to
  the same person and the same grant matrix; nothing is bolted on via
  integration.
- **Authority is structurally divided, not policy-divided.** Self-dealing
  (approving your own pay, your own payroll) is blocked for every role,
  including the superadmin, by a rule in the approval gate itself — not by
  a norm someone could override.
- **Every access decision is re-evaluated at query time**, never cached at
  login, so a revoked grant takes effect on the very next request.
- **The platform ships empty on purpose.** No demonstration data — a
  company installing it does not have to identify and delete somebody
  else's fake data before their own figures mean anything.

## Operating Context

- Deployed as: a Cloudflare Worker serving the built SPA (`apps/web`) and
  proxying `/api` to an Express/Prisma API running on a separate Node host
  with PostgreSQL (Prisma-over-TCP and a durable job scheduler don't run on
  Workers as written).
- Day-to-day workflows: sales/admissions pipeline management (five
  commercial motions, each with its own stage vocabulary); the HR
  lifecycle end to end (hire through exit, leave, payroll prep/approval,
  disciplinary records); invoicing and receipting for course sales and
  services; GST return preparation and filing (GSTR-1/3B); course catalogue
  and delivery tracking; partnership management for institutions and
  organisations; a Command Center reviewed for cross-domain health.
- Data enters through **Import Data**: a Tally export (Excel + XML), a bank
  statement (CSV, any dialect), a general spreadsheet, a student/enrolment
  register, or the platform's own templates — never through hand-typed
  demonstration rows in normal operation.
- Every screen carries a build/data footnote (`web 148 · api 148 · data
  #12`) so a viewer can tell whether the UI, the API and the seeded rows
  are in sync — this is an existing, load-bearing piece of chrome, not
  decoration to remove.

## Capabilities and Constraints

- Multi-tenant: tenant isolation is enforced at the database-client level,
  not by convention, and a cross-tenant reach returns 404 (never 403, which
  would confirm existence).
- The permission model (grants × scope × classification ceiling × authority
  ceiling × purpose) is enforced server-side and tested; the UI must not
  render an action that role/scope would deny (avoid disabled-button dead
  ends — omit the control rather than show it disabled with no path).
- Money bookkeeping treats Obligation (Invoice), Movement (Payment,
  append-only), Allocation (Receipt) and Statement (Final Invoice) as four
  distinct, non-interchangeable facts. An issued tax invoice is final —
  its printed figures never change after issue; running balance, receipts
  and restatements live in surrounding (non-printing) chrome.
- Health/status metrics must be able to render "not yet measured" as a
  distinct state from zero — a zero asserts "going badly," which is a
  different, sometimes false, claim from "not yet known."
- Internal engineering vocabulary (`H_FIN`, `S3_HIGH_RISK`, `own_or_unowned`)
  must never appear as the primary label on a screen; plain words lead, and
  the code is available on hover/tooltip for the audience that needs it
  (e.g. an admin reading a grant cell). This does not apply to established
  business vocabulary (lead, pipeline, quote, forecast), which stays as is.
- Audience is internal-only: Kaizen Infinities' own staff, across the four
  roles above. KaiERP is not currently sold or licensed to other companies
  — multi-tenancy is an architectural property (and used for the test
  database and any future internal separation), not a go-to-market plan.
  Design should not assume an external-customer onboarding flow, pricing
  surface, or multi-company marketing story.

## Brand Commitments

- **Visual direction (standing preference, confirmed 2026-09-13):** the
  flat, border-only-hierarchy system is being replaced with a fluent,
  Apple-esque, minimalist depth language — real soft shadows and
  translucent/glass chrome carry hierarchy instead of border weight. Craft
  bar: **Apple's own system apps / macOS** (Settings, Mail, Notes,
  Big Sur/Sonoma-era vibrancy) and **Notion / Craft** (soft cards, warm
  neutral ground, calm content-first minimalism) — played straight, at
  their fidelity, not as a mood reference. This is the canon/standing-exit
  path (a named, well-known design language), not an invented world.
  Applies uniformly, including the densest screens (KPI walls, ledger and
  invoice tables) — depth is not chrome-only; tabular numbers stay crisp
  within it. Division and status categorical colors (§ Capabilities and
  Constraints) are unaffected — they encode data, not aesthetics.
- Product name: **KaiERP**. Company: **Kaizen Infinities** (legal entity
  KIPL, seen in document numbering: `KIPL/I/26-27/001`).
- Three internal divisions are a fixed, named part of the brand and are
  never relabeled or reordered in any figure: **Software**, **Skill**
  (Skill Development), **Education**, plus **Shared** for costs that don't
  belong to one division.
- Voice, established in the README and in-product copy: precise, plain,
  writes empty/zero states as true statements rather than threshold
  language (e.g. "Nothing significant has changed since you last looked,"
  "Nothing to measure yet"). New UI copy should match this register.
- An existing visual identity is already implemented (see the design
  system this file's sibling `DESIGN.md`, once written, will document) —
  init does not restate or alter it.

## Evidence on Hand

- A reference dataset exists whose imported figures tie back to Tally to
  the paisa (bank ₹12,965.36, cash ₹56,730, income ₹427,930.00, expenses
  ₹1,002,060.07) — real, not fabricated, financial figures used for
  verification.
- 372 backend tests, each naming the requirement it verifies
  (`docs/acceptance.md` maps requirement → test), plus 4 browser
  (Playwright-style) end-to-end tests, deliberately not a full UI-coverage
  suite.
- No customer testimonials, case studies, press, or external marketing
  material exist for this product — it is not currently marketed
  externally. Do not fabricate any of this for design work.
- No demo/seed business data exists by design; every list starts genuinely
  empty in a fresh install.

## Product Principles

1. **One system, not nine integrations.** A domain boundary is a rule about
   what a module never does (CRM never holds money movement; Finance never
   holds a pipeline stage), not a wall between products — identity, events
   and permissions are shared everywhere.
2. **Authority is separated structurally, and the UI must show the
   separation.** No design should let a proposer also be the approver, or
   let any role appear to approve its own record, even when a shortcut
   would be more convenient.
3. **State what is true; never round toward alarm or reassurance.**
   Whether it's a health score, an empty state, or a reconciliation
   mismatch, the system says exactly what it knows and no more — "not yet
   measured" and "nothing crossed" are different from "zero" and "fine."
4. **A document, once issued, is history — not a draft with a later
   opinion.** Anything that behaves like an official document (tax
   invoice, receipt, filed return) is presented as fixed at the moment of
   issue; changes are new, dated facts, never edits to the old one.
5. **Plain words for the audience in front of the screen; precise words for
   the audience that needs them.** Business language stays; internal
   engineering codes move to a tooltip.
