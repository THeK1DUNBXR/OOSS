# Compliance — Books and audit

What this workstream built against `docs/plan/compliance.md`, section D, and
where each requirement is pinned by a test.

## The audit-trail proviso (CMP-AUD-001)

`domains/books.ts` registers the seven entities the Companies (Accounts)
Rules 2014 proviso to Rule 3(1) targets — `transaction`, `vendor_bill`,
`fixed_asset`, `loan`, `ledger_account`, plus `ledger_category` and
`budget_line` — with `registerGovernedEntities('fin', [...])`, and calls
`auditWrite()` on every create, update, reverse and pay path: `recordTransaction`,
`reverseTransaction` (both the original's update and the reversal's create),
`recordVendorBill`, `payVendorBill`, `createAsset`, `createLoan`,
`createAccount`, `createCategory`, `setBudgetLine`.

Pinned by `tests/compliance/books.test.ts`, describe block `CMP-AUD-001`.

## The AuditRecord hash chain (CMP-AUD-002)

`platform/audit.ts` — the file every domain's `auditWrite`/`auditExport`/
`auditRegulatedRead`/`auditBulkOperation` already goes through — now chains
every record it writes: `hash = sha256(prevHash + canonicalJson({tenantId,
action, subjectType, subjectId, actorId, diff, timestamp}))`, with `prevHash`
read as the tenant's latest hashed record inside a transaction holding
`pg_advisory_xact_lock(hashtext(tenantId))`, so two concurrent writes for one
tenant serialise rather than race for "the latest hash". This mirrors
`eventBus.ts`'s `computeHash`, with one addition: `canonicalJson` deep-sorts
object keys (and unwraps anything with its own `toJSON`, so a `Date` or a
Prisma `Decimal` hashes as its serialised value rather than as `{}`) so the
hash is independent of how Postgres's `jsonb` column happens to have stored a
key order.

`verifyAuditChain(tenantId)` walks the chain with the unscoped client and, for
every hashed row, recomputes its hash from its own stored content and checks
both that recomputation and the `prevHash` linkage — so a row edited directly
(content changed, hash left alone) is caught, not only a row whose hash field
was corrupted. Returns `{ ok, checked, brokenAt }`. Exposed at
`GET /compliance/books/audit/verify`, gated on `audit:view`.

Rows written before this shipped (`hash` null) are backfilled once by
`chainUnhashedAuditRecords(tenantId)`, called from `seedBooks()`, in
timestamp order, continuing from whatever the chain's current head is.

Pinned by `tests/compliance/books.test.ts`, describe block `CMP-AUD-002` —
including a test that tampers a row directly with the unscoped client and
confirms `verifyAuditChain` reports `ok: false` with `brokenAt` naming it.

## Accounting periods (CMP-AUD-003)

`AccountingPeriod` (`prisma/schema/compliance-books.prisma`): one row per
`(tenantId, period)`, `status` one of `open | closing | closed | reopened`.
Two-step close, the proposer-never-approves rule the self-dealing bar already
runs elsewhere: `POST /periods/:period/request-close` (`accounting_periods:edit`)
sets `closing`; `POST /periods/:period/close` (`accounting_periods:approve`)
refuses when the approver is the same party who requested it, and on success
snapshots a trial balance into `snapshot`. `POST /periods/:period/reopen`
needs a reason and is itself audited.

`books.ts`'s `recordTransaction` already called
`runHooks('transaction.before_record', { txnDate, source })`; this workstream
registers a hook there (`domains/compliance/books.ts`) that throws a named
`ApiError` when `txnDate` falls in a closed period — independent of GST's own
`assertPeriodOpen` lock. `reverseTransaction` was already dating its reversal
row `new Date()` rather than the original's date, so a closed-period entry
stays reversible, always as of today, with no code change needed there.

Pinned by `tests/compliance/books.test.ts`, describe block `CMP-AUD-003`.

## Retention

`RetentionPolicy` (entityType, years, basis) seeded for `transaction`,
`vendor_bill`, `fixed_asset`, `loan` at 8 years (Companies Act s128(5)), and
`audit_record`/`event_record` at 8 years (the Rule 3(1) proviso's own floor).
The monthly job `runRetentionSweepJob` finds records past their floor not
already flagged, writes a `RetentionReview` row for each (flagged, never
deleted), and raises one `CMP_RETENTION_REVIEW` exception per sweep,
owned by a `finance_head`/chairman affiliation resolved by role lookup.
`GET /compliance/books/retention` reports the seeded policies and the flagged
list; `POST /compliance/books/retention/sweep` runs it on demand.

## Schedule III

`ScheduleIIIMapping` lets a specific ledger category or account be pinned to
a Schedule III head; where none is seeded, `defaultScheduleIIIHeadForCategory`
/ `defaultScheduleIIIHeadForLedgerGroup` (`packages/shared/src/compliance/books.ts`,
pure functions) supply the kind/ledgerGroup default. Anything neither resolves
lands in an explicit "not yet mapped" bucket — never silently dropped.
`GET /compliance/books/statements/:fy` (fy = the FY's start year, e.g. `2025`
for FY2025-26) returns the P&L and balance sheet in this shape.

## Depreciation

`ScheduleIIUsefulLife` (asset class → useful life years, 5% residual, dated)
seeded for computers (3), office equipment (5), furniture (10), vehicles (8),
plant (15), buildings (60), intangibles (5, within the 3-10 range the plan
names). `IncomeTaxDepreciationBlock` (block → WDV rate, dated) seeded at 40%
computers, 10% furniture, 15% plant, 10% buildings, 25% intangibles.
`GET /compliance/books/depreciation/:fy` computes, per `FixedAsset`, both the
Schedule II charge (prorated for a part year, flagged when the asset's own
useful life differs from the table) and the Income-tax block WDV charge
(walked year by year from acquisition, half rate when used under 180 days in
the acquisition year) — deliberately not reconciled to each other, because
they answer different statutory questions. `classifyAssetClass` is a
best-effort keyword match onto the seeded classes; an asset class the table
has no row for reports `"No ... row for this asset class yet"` rather than a
guessed figure.

## Exports

`GET /trial-balance/:asOf` (JSON, or CSV with `?format=csv`),
`GET /general-ledger?from&to&accountId` (CSV), `GET /tally-export?from&to`
(Tally XML — `ENVELOPE/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/VOUCHER`,
matching the tags `imports/tallyXml.ts` parses, negative-is-debit honoured).
Every export calls `auditExport()`. The trial balance is single-entry data
(one account, one category per transaction — see `LedgerCategory`'s own note
that this is "the company's own chart, not a statutory one") brought to
balance with an explicit "Opening balances / equity" plug row rather than
pretending otherwise.

Pinned by `tests/compliance/books.test.ts`, describe block `Exports` — the
Tally export test round-trips through `imports/tallyXml.ts`'s own
`extractTallyXml`.

## Bank reconciliation

`BankStatementLine`, imported via `POST /bank/:accountId/statement`.
`matchBankLines(accountId)` (`POST /bank/:accountId/match`) pairs an
unmatched line with an unreconciled `Transaction` on the same account by
amount, direction and a ±3-day window (a shared reference corroborates when
both sides carry one — `isLikelyMatch`, `packages/shared/src/compliance/books.ts`),
setting `Transaction.reconciledAt` and the line's `matchedAt`.
`GET /bank/:accountId/reconciliation` reports what matched and what did not,
on both sides.

## Web

`apps/web/src/pages/compliance/Books.tsx` — seven tabs: Periods
(request-close/close/reopen), Audit chain (verify), Statements, Depreciation,
Exports (download buttons via `api.download`), Bank reconciliation, Retention.

## Not done, and why

- No `ScheduleIIIMapping` rows are seeded per category — the kind/ledgerGroup
  default *is* the seeded mapping the plan asks for; an explicit row is for
  a company that wants a specific category to land somewhere the default
  would not put it, which is a bookkeeping decision, not a schema gap.
- The Income-tax block WDV walk is per-asset, not true block accounting
  (which nets every addition and deletion in the block together and applies
  one rate to the pooled balance). Documented in `incomeTaxWdvCharge`'s own
  comment: it is the right figure for "what would this asset's own charge be
  under the block's rate", which is what a mismatch against Schedule II needs,
  not a Form 3CD-ready block schedule.
- No field was wanted on `main.prisma` beyond what was already there
  (`AuditRecord.hash`/`prevHash`, `Transaction.reconciledAt`).
