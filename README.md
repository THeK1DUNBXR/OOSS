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
definitions, statutory leave types and the four accounts — before it accepts
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
./scripts/setup.sh          # PostgreSQL, dependencies, schema, first account
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

### Starting over

Emptying the company is a supported operation rather than something you do with
`psql`. It deletes every business record — people, organisations, leads, the
ledger, employment, enrolments, imports, events — and then rebuilds exactly what
a fresh install has: the permission matrix, the pipelines, the navigation
registry, the statutory leave types and the four accounts to sign in with.

```bash
pnpm db:wipe --yes                                  # on your machine
docker compose exec api node dist/seed/wipe.js --yes  # in the Docker stack
```

It refuses to run without `--yes`, because a command that empties a company on a
typo is a bad command. Record numbering restarts at `00001`.

Under Docker you can also throw the volume away — `docker compose down -v` —
which has the same effect on the data and additionally discards the schema, so
the next `up` pushes it again.

### Signing in

`pnpm seed` creates four accounts, one per role, and prints a generated password
for each — once. Four rather than one because the matrix's point is that
authority is divided: a pay rise takes two parties and the books are not the
people function, and a tenant with a single superadmin cannot demonstrate any of
it. Whoever signed in first used to have to create three colleagues before the
product behaved the way it is designed to.

Every name, address and password is overridable, so another company does not
inherit these ones: `OWNER_*`, `OPERATIONS_*`, `FINANCE_*` and `EMPLOYEE_*`, each
with `_EMAIL`, `_NAME` and `_PASSWORD`, plus `SEED_EMAIL_DOMAIN`. An account that
already exists keeps its password.

Everyone else is created inside the product. The same screen genuinely shows
different things to each of the four:

| Role | Signs in as | What they hold |
|---|---|---|
| **Employee** | employee@ | Their own leave, attendance, goals, skills and payslip, plus the staff and skills directories — and they raise invoices for what they sell, seeing the ones they raised and no others. No colleague's file. |
| **Operations Head** | operations@ | The employment lifecycle end to end, payroll preparation, disciplinary records, projects, education and the course catalogue. Proposes pay and cannot approve it. |
| **Finance Head** | finance@ | The books outright, the GST returns, and the money side of people: approves compensation and payroll and sees what the establishment costs, without running it. |
| **Chairman** | chairman@ | Superadmin. Every resource, every verb, every scope — nothing is hidden or inaccessible. |

The HR/Finance split is the one worth understanding. `hr_ops_manager` holds
`compensation:VCEDXF` and no `approve`; `finance_head` holds `approve` and
neither `create` nor `edit`, so the signatory is never the author. Neither can
move a salary alone, and nobody at all can approve their own — the bar holds
for the chairman too.

The employee row is the other one. An employee holds `invoices:VCEF@own`: they
raise a tax invoice for what they sell, take the payment, hand over the receipt
— and see the invoices they raised and nobody else's. Somebody has to be able
to take a walk-in through a course enrolment and give them a document, and
routing that through the finance head means either the finance head sits at the
counter or the customer waits.

Scope is real on reads as well as writes. An employee holding `leave` at `own`
scope gets their own ledger, not the company's. Where a read should reach
everything the matrix says so with an explicit `V@all` cell, so the reach is
something you read off the matrix rather than a rule you have to know about the
evaluator.

---

## Bring your data in

The platform ships empty on purpose: a company installing it should not have to
identify and delete somebody else's demonstration data before their own figures
mean anything. **Import Data**, under Set up, reads five things:

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
- **Your student register.** The list a training business already keeps: student,
  registration number, contact, course, the fee and the discount off it, the
  registration and course dates, and the instalments with the receipt numbers
  they were issued under. It is recognised before the bank sniffer, because a
  register carries a date column and an amount column and would otherwise read
  as a statement.

  What it writes is the enrolment and only that: the course, a rolling intake for
  it, the student, and their place on it under the registration number the
  register already gives them. The money columns are read, checked and reported,
  and not written. A course's price belongs to the course and is set
  deliberately — a dozen rows quoting a dozen discounted figures are not a price
  list — and the payments in a register were receipted outside this platform, so
  inventing invoices to match would produce documents the customer never
  received.

  It does not reconcile the rows for you either. Where the taxable value plus GST
  does not come to the total, or the instalments come to a rupee more than is
  owed, the preview says which row and by how much, and the enrolment still
  imports: losing a real student over a spreadsheet error is the worse trade.
- **One of our own templates, filled in.** For the lists you keep yourself —
  courses, training batches, colleges, client companies, students, contacts,
  staff — the platform hands out the file instead of guessing at yours.
  Download it from the Import page, type your rows under the headings that are
  already there, upload it back.

  Each template is an .xlsx with two sheets: **Data**, which has the headings
  and nothing under them, and **How to fill this in**, which says what every
  column wants and gives an example of each. The examples are deliberately not
  in the Data sheet — a demonstration row left in by mistake becomes a real
  student.

  They are numbered in the order they have to be imported, because a student
  points at a batch by name and a batch points at a course by code. A row
  naming a batch that does not exist is refused and says so; it never invents
  the batch.

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
- **Invoices** — a tax invoice, priced per line when it is raised and final once
  it is issued. The document prints two figures side by side — what the whole
  thing costs and what is being paid now — and says which of *full payment*,
  *part payment* or *payable on credit* it is, and how the money changed hands.
  A draft carries no invoice number: the tax series has to be consecutive, so
  the number is allocated at the moment the document exists.
- **Receipts** — where the part payments live. Every instalment against an
  invoice produces its own numbered document: the time it was issued, the
  invoice it is against, the amount, the mode, and the balance it left. Those
  figures are snapshotted, so reprinting the first receipt six months later
  still shows the balance as it stood on the day.
- **Final Invoices** — the statement raised when the instalments are done. It
  names every receipt it consolidates, restates what was billed so it stands on
  its own, and prints the total payable against the total received. Raising a
  second one after a further instalment supersedes the first rather than
  replacing it: both were true when they were handed over.
- **GST Returns** — GSTR-1 and GSTR-3B computed from the books, with everything
  the portal would reject listed above the figures and naming the invoices
  behind it. Preparing snapshots the return; filing records the portal's ARN and
  closes the month, so an invoice already reported can no longer be edited. A
  return that would be rejected cannot be recorded as filed.
- **Courses** — the catalogue, and a price list as much as a syllabus. A course
  carries its fee, its tax rate and its SAC, so raising an invoice for one means
  choosing what was sold rather than knowing the price list.
- **Students, Schools & Colleges, Organisations** — three lists, because they
  are three different parties. A learner who takes a course, a college that
  sends learners, a trust or business that buys training. They used to be one
  screen called "Companies & Colleges" and one word, *customer*, which meant
  neither "how many students do we have" nor "which colleges do we work with"
  had anywhere to be answered, and billing a walk-in meant inventing a company
  for them. Billing detail sits on any of the three, because being invoiced is
  not an identity: a polytechnic that buys a staff programme is invoiced like
  anyone else and stays a college.

  Each carries what the company actually deals in. A student records **who is
  paying** — themselves, a sponsor, a scheme, or their college — because a
  beneficiary of a funded cohort owes nothing and no invoice is addressed to
  them; a scheme names its framework, Naan Mudhalvan or Vetri Nichayam or a
  TNSDC or NSDC-linked programme or CSR, since each reports differently. An
  organisation records **what it does with us** — buys, funds cohorts, hires our
  learners, or is a department appointing partners — and several at once, which
  is what a good relationship looks like. A college records **which of the six
  engagements** the partnership runs at, from academic alignment to the
  admissions portal we built for them.
- **A student's own page** — their day-by-day record: attendance, weekly
  scores, the questions they asked, the feedback they gave and anything that
  went wrong, merged into one timeline. A query and a complaint stay open until
  somebody closes them, and what they have been invoiced is on the same page as
  whether they are turning up.
- **Pipeline** — five commercial motions, each with its own stage vocabulary,
  reporting across them on a canonical ordinal rather than on stage names.
- **Governance (Admin)** — the live grant matrix, policy versions, the event
  chain, agent registrations and their action tiers.
- **Contacts** — an open merge candidate, raised by the resolver refusing a
  partial match rather than guessing.

Every one of those surfaces starts empty, because the seed creates structure and
not records. What fills them is your own data: import a Tally export, a bank
statement or a filled-in template under **Imports**, or type the first few rows
in. The
detectors that flag an unrouted lead, an unclosed probation or a late supplier
bill are live from the first record — they have nothing to say until there is
one.

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
cd apps/api && pnpm test      # 363 tests
```

The suite runs against a real PostgreSQL database, inside real request
contexts, through the same `evaluate()` and the same tenant gate that serve
production traffic — a mocked permission check proves nothing about the one
that actually runs. It gets a database of its own (`kaizen_test`) because it
creates and mutates records, and the development dataset is a demonstration
rather than a scratchpad.

Each test names the requirement it verifies. See
[docs/acceptance.md](docs/acceptance.md) for the requirement-to-test map.

A second, small suite drives a real browser against a running stack, for the
one thing the first cannot see — a button whose label promises one thing and
whose link does another:

```bash
pnpm --filter @kaizen/api dev            # :4000
pnpm --filter @kaizen/web dev            # :5173
E2E_EMAIL=… E2E_PASSWORD=… pnpm test:e2e
```

It signs in as a real account and holds the getting-started checklist and its
banner to what their own buttons say. Four tests, on purpose: a browser suite
that tries to cover the product becomes the slowest and least trusted thing in
the repository.

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
e2e                the browser suite: what a signed-in person can press
scripts            dev.sh (run), test-db.sh (provision the test database)
docs               architecture, acceptance map, operations
```

114 Prisma models, 26 domain services plus five for People and one for the
books, 363 tests and four in a browser.

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
- [docs/invoicing.md](docs/invoicing.md) — the three documents, the numbering,
  and what invoicing owes the GST returns
- [docs/operations.md](docs/operations.md) — running, seeding, changing the
  permission matrix
