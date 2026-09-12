> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 1 — The ledger

This is the heart of the work. Everything downstream is a projection of it.

**Duration:** three to four weeks. **Gate:** the ten-thousand-operation property test and the migration-equivalence test in `00-BRIEF.md §5` both pass.

## 1.1 The new models

Add to `apps/api/prisma/schema.prisma`. **Do not remove `Transaction` yet** — it becomes a read projection during migration and is deleted at the end of the phase.

```prisma
/// A registered legal entity. One tenant may hold several (a group).
/// Added in Phase 1 even for single-entity tenants because retrofitting it
/// onto a journal with history is the most expensive migration available.
model LedgerEntity {
  id        String  @id @default(cuid())
  tenantId  String
  code      String            // "KIPL"
  legalName String
  gstin     String?
  pan       String?
  tan       String?
  stateCode String            // GST state code, drives place-of-supply
  baseCurrency String @default("INR")
  @@unique([tenantId, code])
}

/// An accounting period. Posting into a closed period is refused at the
/// posting path, not at each caller.
model AccountingPeriod {
  id        String    @id @default(cuid())
  tenantId  String
  entityId  String
  startsOn  DateTime  @db.Date
  endsOn    DateTime  @db.Date
  status    String    // open | soft_closed | closed
  closedAt  DateTime?
  closedBy  String?
  @@unique([tenantId, entityId, startsOn])
}

/// The immutable accounting fact. Once status is 'posted' there is no UPDATE
/// and no DELETE — the application role does not hold the grant.
model JournalEntry {
  id           String   @id @default(cuid())
  tenantId     String
  entityId     String
  periodId     String
  entryNumber  String   // gapless per entity per FY
  entryDate    DateTime @db.Date          // the accounting date, IST-derived
  postedAt     DateTime?
  status       String   @default("pending") // pending | posted | reversed
  narration    String
  /// What created it: invoice | receipt | payment | payroll_run | depreciation |
  /// import | manual | opening_balance | fx_revaluation | accrual | reversal
  sourceType   String
  sourceId     String?
  reversalOfId String?
  reversedById String?
  idempotencyKey String?
  lines        JournalLine[]
  @@unique([tenantId, entityId, entryNumber])
  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, entityId, entryDate])
}

model JournalLine {
  id        String @id @default(cuid())
  tenantId  String
  entryId   String
  entry     JournalEntry @relation(fields: [entryId], references: [id])
  lineNo    Int
  accountId String
  /// Signed minor units (paise). Positive = debit, negative = credit.
  /// BigInt, never Decimal, never float. See CLAUDE.md §Money.
  amountMinor BigInt
  currency  String @default("INR")
  /// Functional-currency amount when currency != entity base currency.
  baseAmountMinor BigInt
  fxRate    Decimal? @db.Decimal(18, 8)
  /// Free dimensions, all optional, all indexed where they are queried:
  division      String?
  costCentreId  String?
  projectId     String?
  partyId       String?          // customer / vendor / employee
  taxCodeId     String?
  memo          String?
  @@index([tenantId, accountId, entryId])
  @@index([tenantId, partyId])
}
```

`LedgerAccount` gains a real `accountType` enum (`asset | liability | equity | income | expense`) replacing the free-text `ledgerGroup` at `schema.prisma:3681`, plus `normalBalance`, `isPostable` (control accounts are not directly postable), `parentId` for a tree, and `requiresParty` / `requiresCostCentre` flags.

## 1.2 The database-enforced invariants

These go in a hand-written migration, not in Prisma schema, because Prisma cannot express them. Create `apps/api/prisma/migrations/*_ledger_invariants/migration.sql`:

1. **Balance.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_lines` that, at commit, asserts `SUM(amount_minor) = 0` for every touched `entry_id`. Deferred so lines can be inserted one at a time inside the transaction.
2. **Immutability.** `REVOKE UPDATE, DELETE ON journal_entries, journal_lines FROM <app_role>`. Grant only `SELECT, INSERT`. Posting sets `status` — so model posting as an insert into a separate `journal_posting` table, or allow a narrowly-scoped `UPDATE (status, posted_at)` via a `SECURITY DEFINER` function that refuses any transition out of `posted`. **Prefer the first: a posted entry is written posted.** Pending entries live in a separate mutable `draft_entries` table and are copied on post.
3. **Period.** A `BEFORE INSERT` trigger on `journal_entries` that refuses an entry whose `entry_date` falls in a period with `status = 'closed'`.
4. **Minimum lines.** A deferred constraint asserting every entry has ≥ 2 lines.
5. **Row-level security.** Enable RLS on every table with `FORCE ROW LEVEL SECURITY`, policy on `current_setting('app.tenant_id')`, **both `USING` and `WITH CHECK`** (without `WITH CHECK` a tenant can insert rows it cannot read). Set it with `SET LOCAL` inside the transaction, never a session `SET` — with PgBouncer in transaction pooling mode a session-scoped set leaks tenant context across requests, and that is the single most common RLS multi-tenancy bug. Connect as a **non-owner** role; owners and superusers bypass policies by default. Keep the existing Prisma `$extends` gate as well: belt and braces, and the extension's `findUnique` post-filter (`platform/db.ts:100`) becomes safe once RLS is underneath it.

Add a migration test that runs each of these as the application role and asserts it fails.

## 1.3 The posting service

Create `apps/api/src/platform/ledger.ts`. **This is the only module in the codebase permitted to write to `journal_entries` or `journal_lines`.** Enforce that with a lint rule.

```ts
export async function post(input: {
  entityId: string;
  entryDate: Date;          // IST-derived, see packages/shared/src/time.ts
  narration: string;
  sourceType: SourceType;
  sourceId?: string;
  idempotencyKey: string;   // required, not optional
  lines: Array<{
    accountId: string;
    amountMinor: bigint;    // signed; debits positive
    currency?: string;
    division?: string;
    partyId?: string;
    // ...dimensions
  }>;
}): Promise<JournalEntry>
```

It must: resolve the period and refuse if closed; assert the lines sum to zero *before* hitting the database so the error message is useful; assert every account is postable and that required dimensions are present; allocate `entryNumber` from `RecordSequence` **inside** the transaction; check the idempotency key and return the existing entry on a repeat; insert entry and lines; write an audit record; emit `kz.finance.journal.posted`.

Add `reverse(entryId, reason)` — creates a mirrored entry, links both ways, refuses to reverse a reversal (`domains/books.ts:264` already has this logic and gets it right; port it).

## 1.4 Balances

Balances are **derived**, never stored as truth.

- `balanceOf(accountId, asOf, dimensions?)` sums `journal_lines`.
- `AccountBalanceSnapshot` — a materialised per-account, per-period-end cache, rebuilt by a job. It is a performance artefact only.
- A nightly job re-derives every snapshot from the journal and asserts equality. **Any drift raises an S1 exception.** Drift is your canary for a bug or for tampering, and it is also the evidence an auditor wants under Rule 11(g).
- Trial balance, P&L, balance sheet and cash flow all become projections over `journal_lines`. Delete the bespoke aggregation in `domains/books.ts` and rebuild it on the projection.

## 1.5 Migrating the existing data

Write `apps/api/src/migrations/cashbookToJournal.ts`:

1. For every `LedgerAccount`, assign a real `accountType` from its current `ledgerGroup` plus a hand-written mapping table. **This needs a human to review it once**; generate a CSV, get it signed off, commit it as a fixture.
2. For every `Transaction`, derive the contra account. `direction: 'in'` with a `categoryId` becomes debit-bank / credit-income-category. `source: 'invoice'` becomes debit-receivable / credit-income plus the tax lines. `nonPL` and `noCashImpact` flags in the legacy data — from the Kaizen Ledger app's design — map onto balance-sheet-only and accrual entries respectively.
3. Post every derived entry with `sourceType: 'migration'` and `idempotencyKey: 'legacy:' + transaction.id`, so the migration is re-runnable.
4. **Assert equivalence.** For every account and every month, the journal-derived balance must equal the old cashbook balance to the paisa. Fail the migration loudly on any mismatch and print the offending account and month. Do not "force" a difference to zero — the company snapshot already records an inherited ~₹40,500 reconciliation gap in the source financial model; surface it as an explicit `Opening Balance Difference` suspense account with a visible balance-check line, exactly as the existing app does, rather than hiding it.

Only after this test passes for the real Kaizen books (1 Feb 2026 – 27 Aug 2026, 1,123 vouchers, 66 ledger accounts, trial balance ties exactly) do you delete `model Transaction`.

## 1.6 Money everywhere

`packages/shared/src/money.ts`: a `Money` type of `{ minor: bigint; currency: string }`, with `add`, `sub`, `mul(rational)`, `allocate(ratios)` — the last one distributes remainders deterministically so a three-way split of ₹100 gives 33.34/33.33/33.33 and never loses a paisa.

Then delete `round2` (`packages/shared/src/finance.ts:132`) and every epsilon comparison — `allocated + creditNoted >= payable - 0.001` (`finance.ts:296`), `input.amount > available + 0.001` (`finance.ts:202`). With integers those fudges are not needed, and each one is currently a place where a sub-paisa error is accepted by design.

`num()` (`platform/db.ts:150`), which converts every `Decimal` to a JavaScript float on read, is the root cause. It goes.
