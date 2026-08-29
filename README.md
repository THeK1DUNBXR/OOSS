# Kaizen Unified Operating Platform

An AI-native, multi-tenant operating system for a company. CRM is the first
domain to ship; Finance, Education, Projects, Commercial, Governance and the
Command Center ship alongside it because the platform's premise is that they
are one system, not nine that integrate.

Built from the *Kaizen Developer Handoff* — 39 numbered CRM requirements with
PASS/FAIL acceptance criteria, plus structured briefs for every other domain
and experience surface.

---

## Run it

```bash
git clone https://github.com/THeK1DUNBXR/OOSS.git
cd OOSS
./scripts/setup.sh          # PostgreSQL, dependencies, schema, demo data
./scripts/dev.sh start      # API and web
```

Then open **http://localhost:5173** and sign in as
`chairman@kaizen.co.in` / `kaizen2026`.

`setup.sh` runs PostgreSQL 16 in Docker. If you would rather use a PostgreSQL
already installed on your machine, run `./scripts/setup.sh --native` — it
creates the role and database for you. Either way it needs **Node 22 or newer**;
it will enable pnpm through corepack if you do not have it.

Both scripts are safe to re-run. `setup.sh` checks before every step and will
not reseed a database that already has data.

```bash
./scripts/dev.sh status     # what is up
./scripts/dev.sh logs       # follow both logs
./scripts/dev.sh stop
```

### Sign in as someone else

Every account uses the same password. The point of having fourteen of them is
that the *same screen* shows different things to each — that is the five-axis
permission model working, not a demo mode.

| Account | Role | What is different about them |
|---|---|---|
| `chairman@kaizen.co.in` | chairman | Sees everything; approves at the top tier |
| `sysadmin@kaizen.co.in` | system_admin | Platform administration and **no domain content authority at all** — no grant on people, leads, opportunities or agreements, and structurally barred from approving |
| `bhead@kaizen.co.in` | business_head | First approval tier, ₹10L MoU ceiling |
| `director@kaizen.co.in` | director | Second approval tier, ₹50L ceiling |
| `controller@kaizen.co.in` | finance_controller | Discount authority above the sales ceiling |
| `arun@kaizen.co.in` | sales | Owns deals; sees all, edits own |
| `divya@kaizen.co.in` | telecaller | `own`-scoped: views every lead, edits only hers |
| `meera@kaizen.co.in` | education_counsellor | `own_or_unowned` — may claim an unowned institution in her branch |
| `ravi@kaizen.co.in` | trainer | Narrowed to his own batches by a **grant scope resolver**, not by a role check in code |
| `latha@kaizen.co.in` | finance | Records payments — which the chairman cannot |
| `multi@kaizen.co.in` | (three) | Holds three affiliations; use the context switcher in the sidebar |

`sysadmin` and `latha` are the two worth trying first: they show that authority
here is not a ladder. The system administrator, with the highest platform
privilege, cannot read a single opportunity. The chairman, at the top of the
company, holds `payments:VXF` and cannot record a payment — because recording
one is the finance function's, and the matrix says so.

### What to look at

- **Command Center** — ten domain health scores, an attention queue ranked by
  severity and ownership, and a decision queue. Four domains read
  *Not yet measured* rather than zero, because no evidence is not the same
  fact as bad evidence.
- **Pipeline** — five commercial motions, each with its own stage vocabulary,
  reporting across them on a canonical ordinal rather than on stage names.
- **Governance (Admin)** — the live grant matrix, policy versions, the event
  chain, agent registrations and their action tiers.
- **People** — an open merge candidate, raised by the resolver refusing a
  partial match rather than guessing.

The seeded dataset deliberately contains broken records: an unrouted lead, a
stale commit, an unpriced offering, an unaccepted delivery handoff, an
over-ceiling quote and an overdue win/loss review. Every detector and every
surface therefore has something real to show.

---

## Test

```bash
./scripts/test-db.sh          # provision the suite's own database
cd apps/api && pnpm test      # 110 acceptance tests
```

The suite runs against a real PostgreSQL database, inside real request
contexts, through the same `evaluate()` and the same tenant gate that serve
production traffic — a mocked permission check proves nothing about the one
that actually runs. It gets a database of its own (`kaizen_test`) because it
creates and mutates records, and the development dataset is a demonstration
rather than a scratchpad.

Each test names the requirement it verifies. See
[docs/acceptance.md](docs/acceptance.md) for the requirement-to-test map.

---

## Layout

```
packages/shared    the vocabulary: planes, event grammar, grant letters,
                   pipeline ordinals, AI tiers, exception codes
apps/api           Express + Prisma. platform/ is the kernel; domains/ are
                   services; jobs/ is the durable scheduler; agents/ is the
                   AI layer
apps/web           React + Vite + Tailwind. One shell, thirteen surfaces
scripts            dev.sh (run), test-db.sh (provision the test database)
docs               architecture, acceptance map, operations
```

Roughly 28,000 lines: 76 Prisma models, 121 canonical events, 16 domain
services, 16 detectors, 13 exception codes, 13 web surfaces.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — the ten planes and the
  decisions behind them
- [docs/acceptance.md](docs/acceptance.md) — every requirement and the test
  that proves it
- [docs/operations.md](docs/operations.md) — running, seeding, changing the
  permission matrix
