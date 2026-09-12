> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 0 — Stop the bleeding

**Duration:** one week. Do 0.1, 0.7 and 0.8 first — the schema split, the map and CI make every later item in this phase cheaper. **Gate:** every item below has a test that fails on the old code and passes on the new.

## 0.1 Secrets and boot-time assertions

Create `apps/api/src/platform/config.ts`. Parse the entire environment through a Zod schema **once, at module load**, and export a frozen typed object. Required with no default: `JWT_SECRET` (minimum 32 characters), `DATABASE_URL`, `NODE_ENV`. The process must refuse to start otherwise, with a message naming the missing variable.

Delete the `?? 'dev-secret-change-me'` fallback at `apps/api/src/lib/auth.ts:31`. Replace every `process.env.X` read across the API with an import from `config.ts` — `grep -rn "process.env" apps/api/src` and convert all of them.

Delete `TENANT_ENFORCE_MODE` entirely (`apps/api/src/platform/context.ts:94`, consumed at `platform/db.ts:82`). The gate does not get an off switch.

## 0.2 Session hardening

Add `jti` (a ULID) to the JWT payload and a `Session` model: `id`, `tenantId`, `userId`, `jti @unique`, `issuedAt`, `expiresAt`, `revokedAt`, `userAgent`, `ip`. Verify the `jti` is live on every request in `contextMiddleware`. Add `POST /auth/logout` (revokes this session) and `POST /auth/logout-all`. Add a refresh-token flow: 15-minute access token, 30-day rotating refresh token stored hashed.

Add login rate limiting — five attempts per identity per fifteen minutes, exponential backoff, and an audit record on **failure** as well as success (today `apps/api/src/lib/auth.ts:98` audits only success, which means a brute-force attempt is invisible).

## 0.3 HTTP hardening

In `apps/api/src/server.ts`: add `helmet` with a real CSP; replace `app.use(cors())` — `:14` at the audit point, **`:18` on the current branch** — with an explicit origin allowlist from config; add `express-rate-limit` with per-tenant and per-IP buckets and a stricter bucket on `/auth` and `/imports`.

Fix `apps/api/src/lib/http.ts:116-118`: never return `err.message` for an unhandled exception. The shape already carries `code: 'INTERNAL'`; drop `message`, add `requestId`, and log the full error server-side keyed by that same `requestId`.

## 0.4 Structured logging

Add `pino`. Wire it into `AsyncLocalStorage` so every log line automatically carries `requestId`, `correlationId`, `tenantId`, `userId`. Log request start and finish with duration and status. Add `pino-http`. Redact every field in `REGULATED_EXCLUDED_FIELDS` (`packages/shared/src/permissions.ts:276`, used by `applyFieldVisibility` at `apps/api/src/platform/permissions.ts:488`) at the serialiser, so a stack trace cannot leak a salary into a log aggregator.

This is the single highest-leverage addition to operability in the whole plan — today production logging is three `console.*` calls in `server.ts`.

## 0.5 The scheduler

Rewrite `apps/api/src/jobs/scheduler.ts`:

- Use `croner` (or `cron-parser`) to compute each job's genuine next fire time from its declared `cron` string. Tick every 60 seconds; fire only what is due.
- **Call `claimFiring`.** It already exists at line 346, is correct, and has exactly one grep hit — its own definition. Its doc comment at `:343` already claims it makes concurrent firing safe; make that true. Wrap it so a claim is an atomic conditional insert on `(tenantId, jobKey, scheduledFor)` with a unique constraint — a second instance's insert fails, so it skips.
- Add a lease with a heartbeat, so a crashed worker's job is reclaimed after the lease expires rather than being stuck forever.
- Add per-job timeout, retry with exponential backoff, and a dead-letter row.
- Add a test that asserts a job declared `'0 6 * * *'` fires once per simulated day, not twenty-four times.

## 0.6 The correctness fixes

- **Hash chain race** (`platform/eventBus.ts:104-105` reads the head, `:158` inserts, no transaction between them). Add `@@unique([tenantId, prevHash])` to `EventRecord` and wrap head-read-plus-insert in a `SERIALIZABLE` transaction with a retry on conflict. The unique constraint is the real fix: two events cannot share a predecessor, so a race fails loudly instead of silently forking the chain.
- **Payment allocation** (`domains/finance.ts:201` reads `available`, `:235` creates the receipt). Wrap the whole read-validate-write in a single `$transaction`, take `SELECT ... FOR UPDATE` on the payment row first, and add a database `CHECK`-backed invariant (a trigger, or a generated total column with a constraint) so that allocations can never exceed the payment amount even if the application logic is wrong. Same treatment for `collectInvoicePayment` (`invoicing.ts:946`).
- **Import commit** (`imports/commit.ts:78`). Make the whole batch one transaction, or — better, given batch sizes — chunk it into transactional batches of 500 rows with a `lastCommittedRowIndex` checkpoint on `ImportBatch`, so a crash resumes rather than restarting. Change `revertImport` (`:721`) from a hard delete to a reversal batch.
- **Invoice numbering** (the `nextDocumentNumber` call at `domains/invoicing.ts:584`, outside the transaction that starts at `:588`). Move `nextDocumentNumber` *inside* the transaction that creates the invoice, so a rollback does not consume a number in a series whose entire justification is gaplessness.
- **Period close.** `assertPeriodOpen` must be called from every write that affects a tax period. Better: move the check into the ledger posting path in Phase 1 so it cannot be forgotten. For now, add it to `recordTransaction`, `issueCreditNote`, vendor bill creation and `commitImport`.
- **Audit gaps.** Register `'transaction'`, `'ledger_account'`, `'ledger_category'` and `'vendor_bill'` through `registerGovernedEntities('books', [...])` (`platform/audit.ts:37`) — **not** in `AUDIT_ACTIONS` (`:17`), which is the list of *verbs* (`create|update|delete|merge|export|login|permission_change|read`) and has nothing to do with the no-op. The gate is `isGoverned(input.subjectType)` at `:134`. Then add `auditWrite` calls throughout `domains/books.ts`. Add `assertCan` + `auditWrite` + `emit` to `reversePayment` (`domains/finance.ts:155`).
- **Timezone.** Create `packages/shared/src/time.ts` with `IST` as an explicit zone and functions `istMonthKey(date)`, `istFinancialYear(date)`, `istPeriodOf(date)`. Replace every `getUTCMonth()` / `getUTCFullYear()` used for a tax period or financial year — `invoicing.ts:225`, `packages/shared/src/finance.ts:78`, and `financialYearStart` at `platform/documentNumber.ts:67`. **Today, an invoice raised at 2am IST on 1 September is an August invoice for period close, GSTR-1, and the document-number series; on 1 April it lands in the wrong financial year.**
- **The ₹60,000.** `events/handlers.ts:86` — read the fee from `enrollment.cohort.course` (already loaded at `:80-83`), and take the instalment schedule from a `FeePlanTemplate` on the course rather than a hardcoded 40/30/30.

## 0.7 Split the schema, and build the map

Two changes that pay for themselves within the first day of Phase 1.

**Split `apps/api/prisma/schema.prisma`.** It is 4,031 lines — roughly 40,000 tokens to read, and Phase 1 will read it repeatedly. Prisma 6.1 supports a schema folder: move it to `apps/api/prisma/schema/` as one file per bounded context (`identity`, `crm`, `finance`, `books`, `education`, `hr`, `platform`, `imports`), and point `package.json` at the folder with `"prisma": { "schema": "prisma/schema" }`. Prisma concatenates them; nothing else changes. Verify with `prisma validate` and a `prisma migrate diff` showing no drift.

**Generate `docs/plan/MAP.md`.** `scripts/genmap.mjs` ships with this plan; run it, commit the output, and add `node scripts/genmap.mjs --check` to CI so a stale map fails the build. It is the index that stops every session from re-discovering the repository. See `docs/plan/EFFICIENCY.md`.

**Add scoped test scripts** to `apps/api/package.json` — `test:books`, `test:invoicing`, `test:hr`, and `test:quick` with `--reporter=dot --bail=1`. The full suite is 372 serial tests against a real Postgres; running all of them after every small change is the second-largest avoidable cost in this plan.

## 0.8 CI, which does not exist

Create `.github/workflows/ci.yml`: typecheck, lint, unit tests against a Postgres service container, e2e, build, and `node scripts/genmap.mjs --check`.

Two things do not exist yet and must be created before CI can reference them:

- **There is no ESLint or Prettier configuration anywhere in the repository, and no `lint` script in any `package.json`.** Add both, for both apps. This is why `band-healthy` and `band-good` ship as dead classes.
- **There is no `apps/api/prisma/migrations/` directory** — the project runs on `db:push`. Baseline the current schema as an initial migration before adding `prisma migrate diff` to CI, and before Phase 1.2 adds a hand-written migration.

Add `eslint-plugin-tailwindcss` with `no-custom-classname` so an unknown token is a build error, then fix the two that ship dead today: `Start.tsx:100,109` and `People.tsx:56`.

Set `BUILD_SEQUENCE`, `GIT_SHA` and `BUILT_AT` in CI so `BuildFootnote` stops rendering `known: false`.
