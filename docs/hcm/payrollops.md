# HCM — payrollops (WS8)

`packages/shared/src/hr.ts`'s `payroll.ts` instructs payroll and settles it
(`PayrollRun`/`PayrollInstruction`); `apps/api/src/domains/compliance/payroll.ts`
makes the statutory numbers on an instruction correct (PF/ESI/PT/LWF, salary
structures, payslips). This workstream is what happens *around* a run once
those two have done their part: the ad-hoc lines and arrears somebody
proposed against it, the double-entry breakdown finance reads it as, the bank
file it becomes, the reconciliation that catches a swing before the money
leaves, the calendar a period runs against, and the question an employee
raises about their own payslip.

## What exists now

### Models (`apps/api/prisma/schema/hcm-payrollops.prisma`)

- **PayItem** — a configured earning/deduction/reimbursement/employer
  contribution component, with a GL account code for costing.
- **AdHocPayLine** — a one-off addition/deduction for a period against one
  employee. Proposed by whoever holds `adhoc_pay:create`, approved by a
  different partyId holding `adhoc_pay:approve` (Self-Dealing Bar).
- **Arrear** — a pay adjustment owed for a past period. Same
  proposer/approver split; `markArrearPaid` records which run actually
  carried it.
- **PayrollJournal** — one row per run: the division-wise double-entry
  breakdown (debit salaries expense, credit net-pay payable and, when gross
  exceeds net, a deductions-payable line), built from `payrollCostByDivision`
  and always balanced by construction. `status` moves Prepared → Posted;
  posting also records the net-pay cash leg in the books.
- **BankAdvice** — the NEFT CSV file for a run's net pay, generated once and
  kept verbatim (an audited export). `rows` holds the same beneficiaries
  structured, so a *view* of the advice can mask each `accountNumber` to its
  last 4 digits without touching `fileText`; only the dedicated download path
  reads `fileText` itself.
- **PayrollReconciliation** — a per-employee delta between two runs, with an
  `unexplainedCount` and a raised exception when a swing exceeds the usual
  range.
- **PayrollCalendar** — the cutoffs (attendance lock, input freeze, run,
  approve, pay date) a period runs against, with a live milestone computed
  from the current time.
- **PayrollQuery** — a question an employee raises about their own payslip,
  routed to HR for a response, open → responded → closed.

### Pure logic (`packages/shared/src/hcm/payrollops.ts`)

`buildPayrollJournalLines` / `journalTotals` (a journal that always balances
by construction), `neftAdviceCsv` / `neftAdviceTotal` (the bank file),
`reconciliationDiff` / `unexplainedCount` (per-employee delta, joiners and
leavers spared from "unexplained"), `payrollCalendarMilestone` (which stage a
period is at right now).

### Domain (`apps/api/src/domains/hcm/payrollops.ts`)

Pay items (`listPayItems`, `createPayItem`, `setPayItemActive`); ad-hoc pay
(`createAdHocPayLine`, `approveAdHocPayLine`, `rejectAdHocPayLine`,
`listAdHocPayLines`); arrears (`createArrear`, `approveArrear`,
`rejectArrear`, `markArrearPaid`, `listArrears`); journal
(`generatePayrollJournal`, `postPayrollJournal`, `getPayrollJournal`,
`listPayrollJournals`); bank advice (`generateBankAdvice`, `getBankAdvice`,
`downloadBankAdvice`, `listBankAdvices`); reconciliation (`generatePayrollReconciliation`,
`getPayrollReconciliation`, `listPayrollReconciliations`); calendar
(`upsertPayrollCalendarEntry`, `listPayrollCalendar`); queries
(`createPayrollQuery`, `respondToPayrollQuery`, `closePayrollQuery`,
`listPayrollQueries`).

Every write is tenant-scoped through `ctx`'s `prisma`, checks a grant via
`assertCan`/`scopeFor` the same way `hr.routes.ts` does, emits an event on
every state change (`kz.hr.adhoc_pay.approved`, `kz.hr.arrear.approved`,
`kz.hr.payroll_journal.posted`, `kz.hr.bank_advice.generated`,
`kz.hr.payroll_reconciliation.unexplained_delta_detected`,
`kz.hr.payroll_query.raised`/`.resolved`), and generates record codes only
through `nextRecordCode` where one is used.

**The Self-Dealing Bar** is enforced directly (same shape as
`approveSalaryStructure`): an ad-hoc pay line's or arrear's `approvedById`
must differ from `proposedById`; a payroll journal's `postedById` must differ
from `preparedById`. Under the shipped grant matrix, `hr_ops_manager` holds
`create` but not `approve` on these resources and `finance_head` the reverse,
so the two roles cannot collide in practice — the record-level check is what
still fires when the same partyId holds both (chairman, or a tenant's own
custom role).

**Posting into the books.** `apps/api/src/domains/books.ts` has one exported,
clean create function — `recordTransaction` — and it is single-entry: one
account, one direction, one amount. It has no multi-line journal-entry
primitive. So the full division-wise debit/credit breakdown lives in
`PayrollJournal` here, and `postPayrollJournal` posts only the net-pay cash
leg into the books via `recordTransaction`, carrying `payrollRunId` (a column
`Transaction` already reserves for exactly this) and `source: 'payroll'`.
The journal's `transactionId` then points at that row. `postPayrollJournal`
also checks `journal.status === 'Posted'` before doing anything else, so a
second post of an already-posted journal is a 409 conflict, never a second
`Transaction` — and it requires the chosen account's `accountType` to be
`bank`, `cash` or `wallet`, since net pay is a cash movement and never a
costing or equity account.

**Money withheld.** List and get endpoints on `adhoc_pay`, `arrears`,
`payroll_journals`, `bank_advices` and `payroll_reconciliations` check
`canSeeMoney(resource)` (the `financial` verb) the same way
`hcm/compensation.ts` does, and null the money fields with
`moneyWithheldReason: 'no_permission'` rather than showing zero when it is
absent — under the shipped matrix that is `hrOps` (who proposes these but
does not hold `financial` on them) viewing anything past their own create
call. A structural zero (a journal line's unused side) stays `0`, since it
carries no figure to withhold.

**Bank account numbers.** `getBankAdvice` (the `view`, held at `hrOps`/
`financeHead` scope) never returns `fileText` and masks every beneficiary's
`accountNumber` to its last 4 digits — the same `bankLast4` shape
`compliance/payroll.ts` already puts on a payslip snapshot. The full NEFT
CSV, unmasked, is served only by `downloadBankAdvice`
(`GET /bank-advices/:id/download`), gated on the `export` verb specifically
(never `view` alone) and audited via `auditExport` on every read — `getBankAdvice`
itself is no longer treated as an export.

### Routes (`/api/hcm/payrollops`, `apps/api/src/routes/hcm/payrollops.routes.ts`)

`GET /_status`; `GET|POST /pay-items`, `PATCH /pay-items/:id/active`;
`GET|POST /adhoc-pay`, `POST /adhoc-pay/:id/approve|reject`; `GET|POST
/arrears`, `POST /arrears/:id/approve|reject|mark-paid`; `GET /journals`,
`GET /journals/:id`, `POST /journals/generate`, `POST /journals/:id/post`;
`GET /bank-advices`, `GET /bank-advices/:id`, `POST /bank-advices/generate`,
`GET /bank-advices/:id/download`;
`GET /reconciliations`, `GET /reconciliations/:id`, `POST
/reconciliations/generate`; `GET|POST /calendar`; `GET|POST /queries`, `POST
/queries/:id/respond|close`.

### Web

- `/people/payroll-ops` (`apps/web/src/pages/hcm/PayrollOps.tsx`) — eight
  tabs: Calendar, Pay items, Ad-hoc pay, Arrears, Reconciliation, Journal,
  Bank advice, Queries. Journal and bank-advice generation read the existing
  `/hr/payroll/runs` list to pick a run; this screen never opens, computes or
  approves a run itself — that stays under People → Payroll.
- `/me/payslips` (`apps/web/src/pages/me/Payslips.tsx`) — every payslip
  issued to the signed-in employee (read from the existing, already
  own-scoped `/compliance/payroll/payslips`), and this workstream's own
  payroll-query thread to raise a question and see HR's response.

## Acceptance

| ID | What PASS means | Test |
|---|---|---|
| HCM-PAYROLLOPS-001 | A journal's debit/credit lines always balance | `payrollops pure logic > HCM-PAYROLLOPS-001` |
| HCM-PAYROLLOPS-002 | A pay item's code is unique per tenant; it can be deactivated | `pay items > HCM-PAYROLLOPS-002` |
| HCM-PAYROLLOPS-003 | The proposer of an ad-hoc pay line cannot approve it themselves; a second decision on an already-decided line is refused | `ad-hoc pay lines > HCM-PAYROLLOPS-003` |
| HCM-PAYROLLOPS-004 | A rejected ad-hoc pay line stays Rejected and is listed by status | `ad-hoc pay lines > HCM-PAYROLLOPS-004` |
| HCM-PAYROLLOPS-005 | An employee sees only their own arrears; hrOps/financeHead see all | `arrears > HCM-PAYROLLOPS-005` |
| HCM-PAYROLLOPS-006 | A journal generated from an approved run balances and its lines sum to the run's gross/net totals | `payroll journal > HCM-PAYROLLOPS-006` |
| HCM-PAYROLLOPS-007 | The preparer of a journal cannot post it themselves; posting records a `Transaction` carrying `payrollRunId` for the net-pay amount | `payroll journal > HCM-PAYROLLOPS-007` |
| HCM-PAYROLLOPS-008 | Generating a bank advice produces one row per employee with net pay and bank details on file | `bank advice > HCM-PAYROLLOPS-008` |
| HCM-PAYROLLOPS-009 | An unexplained swing between two runs raises an exception and flags the row; financeHead-only to generate | `payroll reconciliation > HCM-PAYROLLOPS-009` |
| HCM-PAYROLLOPS-010 | A calendar's milestones must fall in order; a valid one is read back with its live stage | `payroll calendar > HCM-PAYROLLOPS-010` |
| HCM-PAYROLLOPS-011 | An employee raises a query only on their own employment; another employee cannot | `payroll queries > HCM-PAYROLLOPS-011` |
| HCM-PAYROLLOPS-012 | A bank advice's view masks every account number to its last 4 digits and never returns `fileText`; the full CSV is served only by the `export`-gated, audited download | `bank advice > HCM-PAYROLLOPS-012` |
| HCM-PAYROLLOPS-013 | An amount is withheld as null (with a reason) for a caller who lacks the `financial` verb on the resource, and shown to one who holds it | `ad-hoc pay lines > HCM-PAYROLLOPS-013` |
| HCM-PAYROLLOPS-014 | Net pay cannot be posted from a non-cash (e.g. loan or card) ledger account | `payroll journal > HCM-PAYROLLOPS-014` |

21 `it` blocks in total in `apps/api/src/tests/hcm/payrollops.test.ts`,
covering create → approve/reject → refusal (self-dealing, no-grant, cross-
tenant 404, double-decision conflict) for every resource above.

## What this does not do

- **Does not apply an approved ad-hoc line or arrear into a run's actual
  gross/net figures.** `payroll.ts`'s `setInstructionAmounts` is the applying
  end of that, and it is not owned by this workstream — editing it was out of
  scope. Today, applying an approved line is a manual step: HR reads the
  approved amount here and enters it via the existing payroll instruction
  amounts screen. `appliedAt`/`Applied` status exist on the model for when
  that wiring is built.
- **Does not post a multi-line double-entry journal into the books.** The
  books' only create path (`recordTransaction`) is single-entry; this
  workstream posts the net-pay cash leg only, and keeps the full
  debit/credit breakdown on `PayrollJournal` itself rather than pretending
  the books hold it.
- **Does not transmit a bank file to any bank.** `BankAdvice.fileText` is the
  prepared NEFT CSV; sending it anywhere is a manual or future integration
  step, exactly like `compliance/payroll.ts`'s ECR/ESIC exports.
- **Does not carry its own record-code series.** `AdHocPayLine`, `Arrear`,
  `PayrollJournal`, `BankAdvice`, `PayrollReconciliation` and `PayrollQuery`
  have no entries in `RECORD_TYPE_CODES` (`packages/shared/src/domain.ts`) —
  see "Wanted from the scaffold" below. They are addressed by their `id` and,
  where relevant, the `PayrollRun.recordCode` they hang off.
- **Does not gate a run's approval on its calendar.** `PayrollCalendar` is
  informational (the milestone the ops screen highlights); `payroll.ts`'s own
  `transitionPayrollRun` does not consult it. Wiring that would mean editing
  `payroll.ts`, out of scope here.

## Wanted from the scaffold

- `RECORD_TYPE_CODES` (`packages/shared/src/domain.ts`) has no prefixes for
  this workstream's finer-grained rows (an ad-hoc pay line, an arrear, a
  journal, a bank advice, a reconciliation, a payroll query). A future pass
  could add e.g. `ADJ`, `ARR`, `PJL`, `BNA`, `PQR` — not added here since
  `domain.ts` is a single shared array thirteen parallel workstreams could
  collide on editing at once.
