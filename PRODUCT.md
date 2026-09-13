# PRODUCT.md — KaiERP

Durable context for design work on this repository. Written by reading the
codebase directly (README.md, docs/architecture.md, the Tailwind config and
global CSS) — no `impeccable` reference docs or launcher script were present
in this environment, so this file captures what a designer needs to know
before touching any surface, rather than following a fixed template.

## What this is

KaiERP is the ERP platform Kaizen Infinities runs its own company on:
CRM, HRM and Finance as one system, plus Education, Projects, Commercial,
Governance and a Command Center. It is multi-tenant and AI-native — AI
touchpoints are a first-class, governed part of the product, not a bolt-on
chat feature.

It is built from a named source document (*Kaizen Infinities Unified
Operating Platform — Master Architecture*) with numbered, testable
requirements. Design and engineering both answer to that document; a UI
change that contradicts a numbered requirement or an acceptance test is
wrong, not a style choice.

## Who uses it — four roles, deliberately unequal

The permission model is the product's core idea, not an implementation
detail, and it should read on screen:

| Role | Signs in as | Holds |
|---|---|---|
| **Employee** | `employee@` | Own leave/attendance/goals/skills/payslip, staff & skills directories, invoices they raised (`own` scope only) |
| **Operations Head** | `operations@` | Employment lifecycle, payroll *preparation*, disciplinary records, projects, education, course catalogue — proposes pay, cannot approve it |
| **Finance Head** | `finance@` | The books, GST returns, approves compensation/payroll — without running HR |
| **Chairman** | `chairman@` | Superadmin — everything |

The load-bearing detail: **the person who proposes a number is never the
person who approves it**, and nobody — including the Chairman — can approve
their own. Any UI for a privileged action (pay change, approval, payroll)
should make the separation of authorship and sign-off visible, not just
enforce it server-side. Scope (`own` vs `all`) governs reads as much as
writes — an employee's "Leave" screen is *their* ledger, not the company's.

## The three parties (do not blur these)

CRM/People surfaces distinguish three kinds of counterparty, on purpose,
after a past design ("Companies & Colleges") collapsed them and broke
reporting:

- **Customers** — individual learners who take a course (a `Person`).
- **Institutions** — schools/colleges/polytechnics (partnership depth: six
  named engagement types, from academic alignment to a built admissions
  portal).
- **Organisations** — businesses/trusts/foundations, which can simultaneously
  be a client, a sponsor, an employer and a government appointer — `roles`
  is a set, not a single tag.

Billing detail (GSTIN, payment terms) is not identity — any of the three can
carry it and stay what it is. A student's `funding` (`self` / `sponsor` /
`scheme` / `institution`) decides who an invoice is actually addressed to;
never assume the learner is the payer.

## Language: plain words lead, the code stays available

This is a standing design rule, not a suggestion:

- Screens use plain language (`Money`, `High risk`) never internal codes
  (`H_FIN`, `S3_HIGH_RISK`) — the code goes in a tooltip for the audience
  that needs it (e.g. a grant cell `VCEA@own` still shown to admins, spelled
  out as a sentence on hover).
- Empty/zero states say what is actually true — *"Nothing significant has
  changed since you last looked"*, not a threshold description. A metric
  with insufficient data reads **"Nothing to measure yet"**, never `0.0` —
  asserting "going badly" is a different, false claim from "not yet known."
  This applies to the ten Command Center domain health scores specifically.
- This is about *engineering* vocabulary, not business vocabulary — CRM
  terms (lead, pipeline, quote, forecast) are the users' own words and stay.

## Money and documents — invariants that shape any invoice/receipt UI

- **Obligation** (Invoice), **Movement** (Payment, append-only, corrections
  are new negative rows, never edits), and **Allocation** (Receipt, N:N)
  are three separate facts. Don't design a screen that conflates them.
- **A tax invoice is final once issued.** The printed document only ever
  shows figures fixed at issue time; running balance, receipts and
  statements belong in the surrounding chrome (which never prints).
- Draft documents carry no invoice number — numbers allocate at issue,
  because the tax series must stay gapless.
- A **Final Invoice** (statement) supersedes rather than replaces an earlier
  one when a further instalment comes in; both were true when issued.

## Design system — "ink, paper, one accent, flat"

Source: `apps/web/tailwind.config.js`, `apps/web/src/index.css`. Light-only;
`color-scheme: light` is intentional, not an oversight to "fix" with dark
mode.

- **Palette**: `ink` scale (950 page → 100 primary text, though the scale
  still runs the old dark-theme direction — 950 is lightest, 100 is
  darkest/strongest); `paper` (#F2F2F4 page / #ffffff surface); one accent,
  gold `#FFC20E`, used almost nowhere except hover state on primary actions
  and the sidebar mark — gold never carries body text (fails contrast on
  paper; use `accent.soft` `#8a6a00` when gold needs to be legible text).
- **Hierarchy via borders, not shadows.** `boxShadow` is deliberately flat
  (`none`). Three border weights carry all hierarchy: 1px hairline (row
  separators), 2px (component off page), 3px (encloses one object meant to
  be read whole — see `.card`).
- **Division palette** (`div.software` blue, `div.skill` orange,
  `div.education` green, `div.shared` purple) is categorical and fixed —
  never cycle or reassign; validated for contrast/CVD (one known residual
  warning: green↔orange under protanopia, mitigated with legends + direct
  labels, not a color-only encoding).
- **Status band** colors (`band.strong/stable/watch/strained/critical`) are
  the only semantic-severity colors; don't invent new ones for one-off
  states.
- **Type**: Archivo for all headings and *all numbers* (its width axis makes
  digit columns read as a block); IBM Plex Sans for body. Headings are
  uppercase, extrabold, tight tracking — that's a system convention, not a
  per-page choice. Any table of money/counts must use `.num`/`.tabular`
  (`font-variant-numeric: tabular-nums`, `font-stretch: 112%`).
- **Radius**: 14px small/default/medium, 20px lg, 28px xl — soft corners
  paired with hard borders is the house look; don't sharpen to 0 or blow out
  past `xl`.
- **The sidebar is the one dark region** in an otherwise light app —
  literal `#0F0F12`/`#c9c9ce` values, not scale tokens, because the `ink`
  scale points at paper elsewhere. Gold is allowed to fill a whole element
  only on the active sidebar link and the brand mark — nowhere else.
- Reusable component classes already exist for card, btn (primary/gold/
  ghost/quiet/danger), input, label, chip, kpi (with a 4px left status
  rail: good/warn/bad), table (2px header rule vs 1px row rules), sidebar —
  extend these rather than inventing parallel patterns.

## Tech stack

- **Web**: React + Vite + Tailwind, one shell with ~24 surfaces
  (`apps/web/src/pages/*.tsx`).
- **API**: Express 4 + Prisma, organized into `platform/` (kernel),
  `domains/` (services), `jobs/` (durable scheduler), `agents/` (AI layer).
- **Shared**: `packages/shared` holds the vocabulary both sides must agree
  on — event grammar, grant letters, pipeline ordinals, AI tiers, the HR
  lifecycle state machines, finance arithmetic. A screen that needs to know
  which actions exist on a record should consult this, not hardcode a copy
  of the state diagram.
- **Deploy**: web → Cloudflare Worker (`ooss`) serving the built SPA and
  proxying `/api`; API runs on a Node host with Postgres (not portable to
  Workers as-is — Prisma-over-TCP, a long-lived job scheduler, Express's
  stream-based req/res).
- 114 Prisma models, 372 backend tests (assert real requirements, see
  `docs/acceptance.md`), 4 browser (Playwright-style) e2e tests by design —
  deliberately not a full UI-coverage suite.

## Non-goals / constraints worth remembering

- No dark mode — the palette is defined once, for light, on purpose.
- No demo/seed business data — every list starts genuinely empty; empty
  states are a first-class design surface, not a "coming soon" placeholder.
- Don't add UI that lets a role bypass the five-axis permission model
  (WHO/WHERE/WHAT/HOW MUCH/WHY) or the self-dealing/approval-gate rules —
  these are enforced server-side and tested; a screen that looks like it
  offers an action the grant model would deny should not render that
  action at all (avoid disabled-button dead ends).
- Health scores and metrics must be able to say "not yet measured" —
  don't design a metric widget that can only render a number or a zero.

## Where to read more

- `README.md` — the fullest single account of the product, ships-first
  documentation, written in-voice (worth matching tone if writing UI copy
  or empty-state text).
- `docs/architecture.md` — the ten "planes," each a question the system
  answers exactly once; also documents what each plane deliberately never
  does.
- `docs/invoicing.md`, `docs/operations.md`, `docs/acceptance.md`.
