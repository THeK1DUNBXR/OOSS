# KaiERP — ERP Platform of Kaizen Infinities

An AI-native, multi-tenant ERP for Kaizen Infinities. CRM, HRM and Finance are
the three domains the company runs on; Education, Projects, Commercial,
Governance and the Command Center ship alongside them because the platform's
premise is that they are one system, not nine that integrate.

Built from the *Kaizen Infinities Unified Operating Platform — Master
Architecture*: 39 numbered CRM requirements with PASS/FAIL acceptance criteria,
§14's eleven HRM lifecycle state machines, §15's finance model, and structured
briefs for every other domain and experience surface.

The interface follows the Kaizen Infinities design system — ink, paper and one
accent, flat, with borders rather than shadows carrying hierarchy.

---

## Run it

Two ways. Pick one.

### Everything in Docker

Nothing needed on your machine but Docker Desktop — no Node, no PostgreSQL.

```bash
git clone https://github.com/THeK1DUNBXR/OOSS.git
cd OOSS
docker compose up --build
```

Then open **http://localhost:8080** and sign in as
`chairman@kaizen.co.in` / `kaizen2026`.

Those credentials come from `OWNER_EMAIL` and `OWNER_PASSWORD` in
`docker-compose.yml`, which are there so a local stack has something you can
actually type. Change them before this is anywhere but your own machine — and
if you clear them, the seed generates a password instead and prints it once
into the API's log, which `docker compose logs api` will show you.

The first build takes a few minutes. The API container waits for the database,
applies the schema and prepares the tenant — the permission matrix, the pipeline
definitions, statutory leave types and that one account — before it accepts
traffic, and skips all of it on every later start, so your data survives a
restart. There is no demo data: the company is empty until you import or type
something in, and **Getting Started** in the sidebar walks you through it.

The web container serves the built client and proxies `/api` to the API, which
is why port 8080 is the only one you need.

```bash
docker compose logs -f api     # watch the schema push and seed
docker compose down            # stop, keep the data
docker compose down -v         # stop and discard the database volume
```

### On your machine, with hot reload

Better for development: the API and web run on the host, so edits reload
immediately and a debugger attaches normally.

```bash
./scripts/setup.sh          # PostgreSQL, dependencies, schema, demo data
./scripts/dev.sh start      # API and web
```

Then open **http://localhost:5173**, same sign-in.

`setup.sh` runs PostgreSQL 16 in Docker and everything else on the host. If you
would rather use a PostgreSQL already installed, `./scripts/setup.sh --native`
creates the role and database for you. Either way it needs **Node 22 or newer**,
and will enable pnpm through corepack if you do not have it.

Both scripts are safe to re-run: every step checks before it acts, and neither
reseeds a database that already holds data.

```bash
./scripts/dev.sh status     # what is up
./scripts/dev.sh logs       # follow both logs
./scripts/dev.sh stop
```

### Signing in

`pnpm seed` creates one account — the chairman — and prints a generated password
once. Set `OWNER_EMAIL` and `OWNER_PASSWORD` to choose them; otherwise the
password is random and shown only on that run.

Everyone else is created inside the product. There are four roles, and the same
screen genuinely shows different things to each:

| Role | What they hold |
|---|---|
| **Employee** | Their own leave, attendance, goals, skills and payslip, plus the staff and skills directories. No colleague's file, no company money. |
| **HR & Operations Manager** | The employment lifecycle end to end, payroll preparation, disciplinary records, projects, education and tasks. Proposes pay and cannot approve it. |
| **Finance Head** | The books outright, and the money side of people: approves compensation and payroll and sees what the establishment costs, without running it. |
| **Chairman** | Superadmin. Every resource, every verb, every scope — nothing is hidden or inaccessible. |

The HR/Finance split is the one worth understanding. `hr_ops_manager` holds
`compensation:VCEDXF` and no `approve`; `finance_head` holds `approve` and
neither `create` nor `edit`, so the signatory is never the author. Neither can
move a salary alone, and nobody at all can approve their own — the bar holds
for the chairman too.

Scope is real on reads as well as writes. An employee holding `leave` at `own`
scope gets their own ledger, not the company's. Where a read should reach
everything the matrix says so with an explicit `V@all` cell, so the reach is
something you read off the matrix rather than a rule you have to know about the
evaluator.

---

## Bring your data in

The platform ships empty on purpose: a company installing it should not have to
identify and delete somebody else's demonstration data before their own figures
mean anything. **Import Data**, under Set up, reads three things:

- **A Tally export.** Both the Excel reports and the XML. The Excel workbook
  carries a Balance Sheet and a Profit & Loss beside the vouchers, and between
  them they name every ledger and say which side of the books it belongs on —
  so the chart of accounts is read from your own statements rather than guessed
  from ledger names.
- **A bank statement.** CSV, in whatever dialect. Columns are found by name, the
  preamble above the header is skipped however long it is, and day-first dates
  are inferred from the file rather than from your locale.
- **A spreadsheet.** A staff list, a salary sheet, an attendance grid, or a
  plain list of transactions.

Nothing is written until you have seen the preview: every row that will be
created, every row that will not, and why. Reverting removes exactly what the
batch created.

On the reference dataset the imported figures tie back to Tally to the paisa —
bank ₹12,965.36, cash ₹56,730, income ₹427,930.00, expenses ₹1,002,060.07.

### What to look at

- **The Business** — the founder's dashboard. Cash, runway, and the result cut
  by division, which is the question a consolidated total cannot answer: three
  businesses run inside one legal entity, and the month reads Software +₹1.00L,
  Skill +₹47.6K, Education +₹20.7K, Shared −₹2.93L. Funding is excluded from
  the result and counted in the cash, because capital put in is money in the
  bank and not revenue. The trend chart shows complete months only.
- **Command Center** — ten domain health scores, an attention queue ranked by
  severity and ownership, and a decision queue. Four domains read
  *Not yet measured* rather than zero, because no evidence is not the same
  fact as bad evidence.
- **People** — the §14 lifecycle, end to end. Every record carries the
  transitions its state machine says exist, so the buttons on a row cannot
  drift from the diagram. Leave balances are never written directly: approval
  places a hold, completion settles it, cancellation reverses it, and the
  balance is the sum of its own ledger.
- **Ledger** — every movement of money, whatever raised it. A transaction has
  no edit control, only *Reverse*, which posts the opposite entry and leaves
  both rows visible.
- **Pipeline** — five commercial motions, each with its own stage vocabulary,
  reporting across them on a canonical ordinal rather than on stage names.
- **Governance (Admin)** — the live grant matrix, policy versions, the event
  chain, agent registrations and their action tiers.
- **Sales & Customers → People** — an open merge candidate, raised by the
  resolver refusing a partial match rather than guessing.

The seeded dataset deliberately contains broken records: an unrouted lead, a
stale commit, an unpriced offering, an unaccepted delivery handoff, an
over-ceiling quote, an overdue win/loss review, a probation nobody closed, an
employee with no pay record in force, a disputed attendance day inside an open
payroll period and a supplier bill ten days late. Every detector and every
surface therefore has something real to show.

The books are seeded with the company's own chart of accounts and seven real
months, down to the ₹32,000 rent that starts in the second month. With invented
round numbers this would show that the arithmetic runs; with these it shows the
thing the founder wants to see.

---

## Deploying

The client deploys to Cloudflare as a Worker named **ooss**, which serves the
built SPA and forwards `/api` to the API.

```bash
pnpm run build:worker    # builds apps/web/dist
pnpm run deploy          # builds, then wrangler deploy
pnpm run preview         # builds, then wrangler dev locally
```

Set **`API_ORIGIN`** on the Worker to the URL of the running API. Until it is
set, every `/api` call returns a 503 saying exactly that, which the client
renders — an unconfigured deployment should say what is missing rather than
fail blankly.

### Why the API is not on Cloudflare

Pages and Workers are the same runtime, so this is not a Workers-versus-Pages
question. The API cannot run on either as written:

- **Prisma reaches PostgreSQL over TCP.** On Cloudflare that needs a driver
  adapter plus a Hyperdrive binding, and Hyperdrive is created against a
  specific database in a specific account.
- **The job scheduler is a long-lived interval.** Cloudflare has no long-lived
  process; the equivalent is a Cron Trigger or a Durable Object.
- **Express 4 is built on Node's stream-based req/res**, not on `fetch`.

Porting it is real work — `@prisma/adapter-pg` over Hyperdrive, a fetch-based
router in place of Express, and the scheduler moved to Cron Triggers. Until
that is done the API runs on any Node host with a PostgreSQL connection, and
this Worker points at it. A Worker that deployed green and then failed on every
request would be worse than an honest split.


---

## Test

```bash
./scripts/test-db.sh          # provision the suite's own database
cd apps/api && pnpm test      # 252 tests
```

The suite runs against a real PostgreSQL database, inside real request
contexts, through the same `evaluate()` and the same tenant gate that serve
production traffic — a mocked permission check proves nothing about the one
that actually runs. It gets a database of its own (`kaizen_test`) because it
creates and mutates records, and the development dataset is a demonstration
rather than a scratchpad.

Each test names the requirement it verifies. See
[docs/acceptance.md](docs/acceptance.md) for the requirement-to-test map.

The lifecycle machines and the finance arithmetic are tested without a database
at all, because they are pure: whether Absconded can reach Alumni, and whether
GST halves within a state, are wrong on their own terms and need no persistence
to demonstrate. The suite passes twice against the same database — a test that
moves somebody through their lifecycle builds its own subject, since
terminating a seeded person would leave them terminated and fail the next run.

---

## Layout

```
packages/shared    the vocabulary: planes, event grammar, grant letters,
                   pipeline ordinals, AI tiers, exception codes, the twelve
                   HR lifecycle machines and the finance arithmetic
apps/api           Express + Prisma. platform/ is the kernel; domains/ are
                   services; jobs/ is the durable scheduler; agents/ is the
                   AI layer
apps/web           React + Vite + Tailwind. One shell, twenty-four surfaces
scripts            dev.sh (run), test-db.sh (provision the test database)
docs               architecture, acceptance map, operations
```

108 Prisma models, 16 domain services plus five for People and one for the
books, and 252 tests.

The HR lifecycle machines and the finance arithmetic live in `packages/shared`
rather than in the API, and that placement is the point: a surface rendering a
depreciation schedule and a service posting one must agree, and the only way to
guarantee that is for there to be one of them. It is also what lets a screen
ask the same machine the API will ask which actions exist on a record, instead
of keeping its own copy of the diagram.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — the ten planes and the
  decisions behind them
- [docs/acceptance.md](docs/acceptance.md) — every requirement and the test
  that proves it
- [docs/operations.md](docs/operations.md) — running, seeding, changing the
  permission matrix
