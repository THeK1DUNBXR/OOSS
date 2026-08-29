# Operations

## First run

```bash
./scripts/setup.sh            # Docker PostgreSQL, deps, schema, demo data
./scripts/setup.sh --native   # or use a PostgreSQL already on this machine
```

The native path creates the `kaizen` role (`LOGIN CREATEDB`, password `kaizen`)
and the `kaizen` database, trying the current account first and falling back to
the `postgres` system account. It writes `apps/api/.env` from `.env.example`
with a freshly generated `JWT_SECRET`, and skips seeding entirely if the
database already holds a tenant — so re-running it never touches your data.

## Running

```bash
./scripts/dev.sh start     # Postgres if down, then API and web
./scripts/dev.sh status
./scripts/dev.sh logs
./scripts/dev.sh restart
./scripts/dev.sh stop
```

Logs land in `.dev/api.log` and `.dev/web.log`.

## Databases

| | |
|---|---|
| `kaizen` | development and demonstration |
| `kaizen_test` | the acceptance suite, provisioned by `scripts/test-db.sh` |

```bash
./scripts/test-db.sh            # create and seed if absent
./scripts/test-db.sh --reseed   # drop and rebuild
```

Point the suite elsewhere with `TEST_DATABASE_URL`.

## Seeding

```bash
cd apps/api
pnpm db:push      # apply the schema
pnpm seed         # tenant, roles, grants, policies, pipelines, catalog, demo data
```

The seed is written to be re-runnable: roles and reference data upsert, and the
grant step **short-circuits on an existing row rather than replacing it**. A
deployment pipeline running twice does not rewrite a tenant's permission state.

The dataset deliberately includes broken records — an unrouted lead, a stale
commit, an unpriced offering, an unaccepted handoff, an over-ceiling quote, an
overdue win/loss review, an open merge candidate. Detectors and surfaces need
something real to act on, and a dataset where everything is fine demonstrates
nothing.

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

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | required |
| `JWT_SECRET` | — | required |
| `PORT` | `4000` | |
| `JOBS_ENABLED` | `true` | in-process scheduler |
| `TENANT_ENFORCE_MODE` | `enforce` | `warn` logs an unscoped query instead of throwing — for migration only |

`TENANT_ENFORCE_MODE=warn` is a migration aid, not a configuration. Running it
in production means a service that forgets a tenant predicate returns another
tenant's rows.
