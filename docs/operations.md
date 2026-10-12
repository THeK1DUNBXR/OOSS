# Operations

## Running everything in Docker

```bash
docker compose up --build     # database, API, web
docker compose logs -f api    # follow the schema push and seed
docker compose down           # stop, keep the data
docker compose down -v        # stop and discard the database volume
```

Three services. `postgres` holds a named volume, so data survives `down`.
`api` builds from `apps/api/Dockerfile` and runs its entrypoint before serving:
wait for the database, `prisma db push`, then seed **only if no tenant exists**
— so a restart never overwrites your data. `web` builds the client to static
assets, serves them with nginx, and proxies `/api` to `api:4000`; the client
fetches a relative `/api`, so there is no build-time API URL and no CORS.

Ports: web on 8080, API on 4000, PostgreSQL on 5432. The last two are published
so host tooling — psql, Prisma Studio, the acceptance suite — can reach them
while the stack runs.

The `JWT_SECRET` in `docker-compose.yml` is a development value committed to the
repository. A real deployment injects a secret instead.

To run only the database in Docker and the rest on the host:

```bash
docker compose up -d postgres
```

which is what `scripts/setup.sh` does.

## First run

```bash
./scripts/setup.sh            # Docker PostgreSQL, deps, schema, first account
./scripts/setup.sh --native   # or use a PostgreSQL already on this machine
```

The native path creates the `kaizen` role (`LOGIN CREATEDB`, password `kaizen`)
and the `kaizen` database, trying the current account first and falling back to
the `postgres` system account. It writes `apps/api/.env` from `.env.example`
with freshly generated `JWT_SECRET` and `FIELD_ENCRYPTION_KEY` values, and skips
seeding entirely if the database already holds a tenant — so re-running it never
touches your data. An `apps/api/.env` from before `FIELD_ENCRYPTION_KEY` was
required is left alone and reported: the API will not start until the key is
added. A key generated for a database that was seeded under the old development
fallback will not decrypt that database's PAN and bank values. If that data
matters, ask the owner which value it was encrypted under before changing the key.

## Running

```bash
./scripts/dev.sh start     # Postgres if down, then API and web
./scripts/dev.sh status
./scripts/dev.sh logs
./scripts/dev.sh restart
./scripts/dev.sh stop
```

Logs land in `.dev/api.log` and `.dev/web.log`.

## Before a deploy: people with no role

An affiliation with no role gives its holder no access. Before a deploy, run the read-only report to see who that is:

```
pnpm --filter @kaizen/api report:roleless
```

It prints, per active tenant, the count of active affiliations with no role and the person record codes behind them. It prints no names or emails. Anyone listed cannot sign in to work until someone names a role for them; fix that in the people area before the deploy, not after a complaint.

## Databases

|               |                                                           |
| ------------- | --------------------------------------------------------- |
| `kaizen`      | development and demonstration                             |
| `kaizen_test` | the acceptance suite, provisioned by `scripts/test-db.sh` |

```bash
./scripts/test-db.sh            # create and seed if absent
./scripts/test-db.sh --reseed   # drop and rebuild
```

Point the suite elsewhere with `TEST_DATABASE_URL`.

### Moving an existing db-pushed database onto migrations

Databases built with `prisma db push` already have the tables that the baseline
creates, so `migrate deploy` would fail on them. Mark the baseline as applied,
then deploy the rest:

```bash
cd apps/api
npx prisma migrate resolve --applied 20260901000000_baseline
npx prisma migrate deploy
```

Warning: the three later migrations install triggers and immutability
boundaries (journal balance, closed-period guard, audit and consent
append-only) that `db push` never installed. Run them on a copy of the
database first, and look at the failures before pointing the real database at
them. Tenant row-level security is in `20261010210000_tenant_rls` (FX-51): every
table with a `tenantId` column is forced under a policy keyed on
`app.tenant_id`. Two database roles carry this, and both are checked at boot
(`platform/rlsGuard.ts`):

| Role                                               | Connects as              | Required privilege                                                 | Used for                                                                                                                         | Boot check                                |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Application role `kaizen_app`                      | `DATABASE_URL`           | neither `rolsuper` nor `rolbypassrls`; row-level security binds it | every request, through the scoped client                                                                                         | refuses to start with either privilege    |
| Unscoped role (the owner, `kaizen` in development) | `UNSCOPED_DATABASE_URL`  | `rolbypassrls` or `rolsuper`                                       | the cross-tenant jobs (outbox drain, scheduler, audit chain), the seed, and the session lookup by token before a tenant is known | refuses to start without either privilege |
| Migration owner                                    | `MIGRATION_DATABASE_URL` | owns the tables                                                    | `prisma migrate` only                                                                                                            | none; it is never the request role        |

`UNSCOPED_DATABASE_URL` is required when `NODE_ENV=production`. Outside
production it must still be set for the server to start, because the check
applies to every non-test run. `scripts/app-role.sql` creates `kaizen_app`
with no superuser and no BYPASSRLS; `scripts/setup.sh` and `docker-compose.yml`
run it. Every tenant table has the `tenant_isolation` policy, and
`rls.test.ts` (RLS-003) fails if one is missing.

## Seeding

```bash
cd apps/api
pnpm db:push      # apply the schema
pnpm seed         # tenant, roles, grants, policies, pipelines, leave types, first account
```

The seed is written to be re-runnable: roles and reference data upsert, and the
grant step **short-circuits on an existing row rather than replacing it**. A
deployment pipeline running twice does not rewrite a tenant's permission state.

The seed creates structure and no records. There is no demo dataset: a tenant
comes up empty and is filled by import or by hand, so nothing a user sees was
invented by us.

To go back to that state on a database that already holds data:

```bash
pnpm wipe --yes   # from apps/api; `pnpm db:wipe --yes` from the root
```

`src/seed/wipe.ts` truncates every table the database reports except Prisma's
own migration bookkeeping, then re-runs the bootstrap. It asks the database
which tables exist rather than carrying a hand-maintained list, because such a
list is wrong the first time somebody adds a table and forgets it — and wrong
silently, which is the worst way for a wipe to fail. `RESTART IDENTITY` puts
record numbering back to `00001`.

## Changing the permission matrix

Because the seed never overwrites a grant, a deliberate change to
`apps/api/src/seed/grants.ts` does not reach an already-seeded tenant on its
own. That is the intended asymmetry: re-running a deployment must not silently
rewrite permissions, but a real matrix change still has to land.

```bash
cd apps/api
npx tsx src/seed/reconcileGrants.ts            # report the diff, write nothing
npx tsx src/seed/reconcileGrants.ts --apply    # apply it
```

It prints every add, change and revocation before touching anything, requires
`--apply` to write, and emits `kz.gov.grant.changed` per change carrying the
before and after. A permission change leaves the same trail as any other
governed act.

The acceptance suite asserts the plan is empty, so drift between the declared
matrix and what a tenant holds fails the build.

## Encrypting bank advices written before FX-61

Bank advices generated before FX-61 was fixed store the NEFT file and each
beneficiary's account number and IFSC in clear. Anyone with DB or backup access
could read every employee's bank details. New advices are sealed on write. Run
this once per deployment to seal the old rows:

```bash
cd apps/api
npx tsx scripts/encrypt-bank-advices.ts               # every tenant
npx tsx scripts/encrypt-bank-advices.ts <tenant-slug> # one tenant
```

It prints scanned, converted and already-encrypted counts per tenant. It is
idempotent: plaintext is detected by the missing `enc:v1:` prefix, so a second
run converts nothing. It changes only the storage encoding; the bank file
content is unchanged, and no advice is deleted or regenerated.

## Sealing holder PANs written before the equity writers sealed them

Until the equity writers sealed holder PAN, the holder form, the holder update
and the opening-register import wrote `Holder.panNumber` in clear. New writes
are sealed with `encryptField`. Run this once per deployment to seal the old
rows:

```bash
cd apps/api
npx tsx scripts/encrypt-holder-pans.ts               # every tenant
npx tsx scripts/encrypt-holder-pans.ts <tenant-slug> # one tenant
```

It prints scanned, converted and already-encrypted counts per tenant, and is
idempotent in the same way as the bank advice pass. Reads are unchanged for
callers at the regulated ceiling; everyone else sees the PAN masked to its last
four characters, before and after the run.

## Jobs

```bash
cd apps/api && pnpm jobs:run     # run every detector once
```

Sixteen detectors: MoU, contract and partner-agreement expiry ladders,
untouched leads, stage-age breaches, pending proposals and payments, offering
coverage, stale commits, overdue win/loss reviews, won-without-contract audit,
SLA escalation, overdue tasks, merge-candidate sweep, daily metrics and health
scores.

The substrate is durable and keyed on
`(automationVersionId, subjectRef, triggerFingerprint, ladderRung)`, so a job
that runs twice does not act twice.

## Environment

| Variable                 | Default      |                                                                                                                                                                                                                                            |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | —            | required. The application role (`kaizen_app`); see the database roles above                                                                                                                                                                |
| `MIGRATION_DATABASE_URL` | —            | the owner, for `prisma migrate` (schema `directUrl`)                                                                                                                                                                                       |
| `UNSCOPED_DATABASE_URL`  | —            | required in production; the unscoped role above. Without a `rolbypassrls` or `rolsuper` role the server refuses to start                                                                                                                   |
| `JWT_SECRET`             | —            | required                                                                                                                                                                                                                                   |
| `FIELD_ENCRYPTION_KEY`   | —            | required in every environment, at least 32 characters. Keys encryption of PAN, Aadhaar and bank values; the API refuses to start without it, and there is no development fallback                                                          |
| `PORT`                   | `4000`       |                                                                                                                                                                                                                                            |
| `WEB_DIST_DIR`           | _(unset)_    | path to the built client (`apps/web/dist`). Set in production so the API serves the client as well as `/api`; Caddy proxies to it (`deploy/Caddyfile`)                                                                                     |
| `JOBS_ENABLED`           | `true`       | in-process scheduler                                                                                                                                                                                                                       |
| `TENANT_ENFORCE_MODE`    | `enforce`    | `warn` logs an unscoped query instead of throwing — for migration only                                                                                                                                                                     |
| `PORTAL_HOSTS`           | _(empty)_    | comma-separated hostnames the equity portal shell serves — read into `surfaceHosts.portal` by `/api/meta/version`                                                                                                                          |
| `TENANT_KIND`            | `standalone` | read once at a tenant's first bootstrap as a stated starting guess — `reconcileTenantKinds` (run at the end of every bootstrap and at boot) recomputes it from the actual parent/child rows regardless, so a wrong guess here never sticks |
| `PARENT_TENANT_SLUG`     | _(unset)_    | the parent tenant's slug, read by `pnpm seed` for the default tenant and overridable per call to `pnpm tenant:create --parent`                                                                                                             |

`TENANT_ENFORCE_MODE=warn` is a migration aid, not a configuration. Running it
in production means a service that forgets a tenant predicate returns another
tenant's rows.

**`PORTAL_HOSTS` is read by the API alone.** It is the source `/api/meta/version`
reads into `surfaceHosts.portal` (`routes/meta.routes.ts`), which is what the
client checks to render the portal shell (equity-portal plan §3.1). It is read
from `process.env` directly rather than through the Zod config, so a hostname
change needs no code. The Caddy site block in `deploy/Caddyfile` must also
answer on that hostname, since Caddy is what routes by host now.

---

## Setting the company up to invoice

Three things, in order, before the first invoice is raised. All of them live
under **Company details**, in the Set up group.

1. **The registration.** The legal name, the address and the GSTIN. An invoice
   without them is a letter about money rather than a tax invoice, and a return
   is filed _under_ a GSTIN. The GSTIN is validated on shape, state code and
   check digit, because a mistyped registration is rejected by the portal weeks
   later with nothing to say which field caused it.

2. **The document numbering.** The short code every number begins with —
   `KIPL` — and whether the financial year is written `26-27` or `2026-27`. The
   screen prints the next number in each series with its length beside it,
   because the portal accepts a tax invoice number of at most sixteen characters
   and `KIPL/I/2026-27/001` is eighteen.

3. **Where each series starts.** A company adopting the platform part-way
   through a year has already issued some of this year's documents by hand.
   _Start from…_ moves a series forwards so the platform does not re-issue a
   number that is already on a document somebody is holding. It only ever moves
   forwards.

### Filing a return

```
Compute  →  Prepare  →  (fix what it found)  →  Prepare again  →  File
```

Computing is free and repeatable. Preparing snapshots the figures with their
findings on them, and supersedes any earlier preparation for the same month.
Filing records the portal's ARN and **closes the month**: an invoice dated inside
it can no longer be edited or voided.

Filing refuses while any blocking check stands. That is the point of it — a
closed month on a return that never went through is the worst of both. Fix the
invoices the finding names, prepare again, and file that one.

The platform prepares returns and does not transmit them. The JSON download is
the offline utility's file; `File` records what the portal gave back.

## Spinning a division out into a subsidiary

Equity-portal plan §3.3 and §6b: a division becomes its own legal entity
(subsidiary tenant), carrying across the rows that belonged to it and leaving
the holding's own history untouched. Two steps, both from `apps/api`.

### 1. Create the subsidiary tenant

```bash
pnpm tenant:create --slug kz-edu --name "Kaizen Education Pvt Ltd" \
  --parent kaizen --origin-division education \
  --chairman-email chairman@kaizen.co.in
```

This is the ordinary tenant bootstrap (`docs/plan/equity-portal.md` §6, phase 0) — a new tenant, its own founding accounts, `parentTenantId` pointing at
the holding, `config.originDivision` recording which division it grew out of.
Before the spin-out can commit, set the subsidiary's **company details**
(legal name, and at least two certificate signatories — a share certificate
needs them like any other) and, separately, register the subsidiary for its
own GSTIN — that is a real filing with the tax department, not something this
platform can do for you, and the subsidiary cannot invoice until it is done.

### 2. Preview, then commit

```bash
pnpm division:spin-out --from kaizen --division education --to kz-edu
```

Without `--yes` this only previews: every transaction, employment
relationship, course, cohort, enrolment and organisation it would carry
across, every one it would refuse and why, and whether it is ready to commit
right now (the subsidiary must exist, name the holding as its parent, have an
**empty** share register, and carry two certificate signatories). Nothing is
written. The same preview, scoped to the caller's own tenant, is what the
"Divisions" card on the cap table shows — read-only; it never commits.

**What is carried**, copied under a fresh id and record code in the
subsidiary, business dates and amounts preserved: transactions tagged to the
division, employment relationships whose current position sits in it,
courses (with their cohorts and enrolments), and organisations invoiced only
under that division. The source row is marked `migratedToTenantId` and never
edited or deleted otherwise — the holding's own history still reads exactly
as it did.

**What is refused, by name:** a transaction tagged `shared` (it cannot be
attributed to one subsidiary — split it first); a transaction linked to an
invoice, vendor bill, payroll run, fixed asset or loan (this script does not
carry those — record the equivalent directly in the subsidiary); an employee
whose current assignments span more than one division, or sit in a `shared`
unit; a person with no email or phone on file (nothing to resolve them by in
the new tenant); an organisation invoiced from more than one division.

**Cash never moves by data migration.** The subsidiary's ledger accounts open
at zero, named after the accounts the carried transactions used, with a note
that the opening balance is to be set from the transfer of funds — moving the
actual money into the subsidiary's own bank account is a bank transfer a
human makes, not a database write.

**Not done by this script, on purpose:**

- **Ending the migrated employment relationships in the holding.** The
  source rows are marked `migratedToTenantId`, not separated — deciding when
  someone's employment with the holding actually ends is an HR act the
  chairman takes deliberately.
- **Moving the cash.** See above.
- **Registering the subsidiary for its own GSTIN**, and completing its
  company profile before it can invoice.

To commit:

```bash
pnpm division:spin-out --from kaizen --division education --to kz-edu --yes \
  --kipl-stake 7000 --face-value 10 --class "Equity" \
  --other-holder "Jane Founder|jane@example.com=3000"
```

This carries the rows above, then writes the subsidiary's **opening
allotment**: a share class, the holding recorded as an `entity` holder
(`--kipl-stake`) alongside anyone else named (`--other-holder
"<name>|<email>=<count>"`, repeatable), an allotment per holder approved and
made effective under the system principal with `boardResolutionRef:
'spin-out'`, and certificates issued. `tenant.config.spinOut` on the
subsidiary then records which division, which holding, and the batch id.

### Reverting

```bash
pnpm division:spin-out --revert <batchId> --from kaizen --to kz-edu --yes
```

Removes only the rows this batch created in the subsidiary, and clears
`migratedToTenantId` on the sources — safe only while the subsidiary has not
yet acquired a life of its own. It refuses outright if the subsidiary carries
any transaction or register row from outside the batch.

## Deploying the session change (0.2)

Access tokens are now bound to a server-side Session. Tokens issued before this
deploy carry no `jti` and are refused, so every signed-in user is asked to sign
in once after the deploy. Expect one re-login per user; there is nothing to
migrate. Sessions are 30 days from sign-in, and the refresh secret lives in an
httpOnly cookie scoped to `/api/auth`, which Caddy passes through unchanged.
