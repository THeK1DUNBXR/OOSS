# HCM — compensation (WS7)

Comp & benefits, on top of the existing `CompensationRecord` lifecycle
(`apps/api/src/domains/employment.ts`) and `SalaryStructure` (statutory
breakdown, `apps/api/src/domains/compliance/payroll.ts`). This workstream is
the money conversation *around* those two: pay grades to check an offer or a
revision against, an annual (or off-cycle) revision round with a budget
ceiling, variable pay, benefit enrolment, employee loans and expense claims.

Applying an approved revision line writes a new, `Effective`
`CompensationRecord` directly (superseding whatever was `Effective` before
it) rather than re-running the plain compensation record's own
propose→approve state machine a second time — the line has already been
through its own two-party approval, and asking a second pair of humans to
approve the identical number a second time would not add a control, only a
click.

## What exists now

### Models (`apps/api/prisma/schema/hcm-compensation.prisma`)

- **PayGrade** — the money side of a band: `code`, `level`, `minPay` /
  `midPay` / `maxPay` (annual CTC), `currency`. WS1's `Grade` is the
  org-level level/code with no money in it; this table is WS7's.
- **SalaryRevisionCycle** — a round (`draft → proposed → approved →
  applied`), `budgetPct` the ceiling on its lines' aggregate increase,
  `recordCode` (`SREV-YYYY-NNNNN`).
- **SalaryRevisionLine** — one employment's line in a cycle: `currentCtc`,
  `proposedPct`/`proposedCtc`, `approvedCtc`, `status`
  (`proposed → approved|rejected → applied`), `proposedById`/`approvedById`.
- **VariablePayPlan** — a bonus/commission/incentive scheme with a `formula`
  (`percentage_of_base` | `fixed` | `tiered`, from `@kaizen/shared`) and a
  period.
- **VariablePayout** — one plan's computed figure for one employment for one
  period (`computed → approved → paid`).
- **BenefitPlan** — health/life/accident/meal/fuel/nps/other, employer and
  employee monthly contributions, an optional enrolment window.
- **BenefitEnrollment** — one employment's enrolment in one plan
  (`enrolled`/`waitlisted`/`cancelled`), dependants as a JSON list.
- **EmployeeLoan** — `principal`/`interestPct`/`tenureMonths`/`emi`
  (`requested → approved|rejected → disbursed → closed`), `recordCode`
  (`LOAN-YYYY-NNNNN`); the EMI schedule itself is computed on demand from
  `emiSchedule()` rather than persisted row by row.
- **ExpenseClaim** — `category`/`amount`/`receipts`
  (`submitted → approved|rejected → reimbursed`), `recordCode`
  (`EXP-YYYY-NNNNN`). "Reimbursed" here is the claim's own record of having
  been asked to be paid — WS8 payrollops owns the ad-hoc pay line and the
  journal that actually move the money.

### Pure logic (`packages/shared/src/hcm/compensation.ts`)

- `compaRatio` / `compaBand` — current pay against a grade's midpoint, in
  words (`below_range`/`below_mid`/`at_mid`/`above_mid`/`above_range`).
- `emiSchedule` — a reducing-balance EMI schedule; the final instalment
  absorbs rounding drift so the balance closes at exactly zero.
- `revisionBudgetCheck` — a cycle's approved lines' aggregate increase
  against its `budgetPct`.
- `computeVariablePayout` — evaluates a `VariablePayFormula` against a
  supplied base figure.

### Domain (`apps/api/src/domains/hcm/compensation.ts`)

Pay grades (`listPayGrades`, `createPayGrade`, `updatePayGrade`,
`compaRatioFor`); revision cycles (`listRevisionCycles`, `getRevisionCycle`,
`createRevisionCycle`, `addRevisionLine`, `listRevisionLines`,
`proposeCycle`, `approveRevisionLine`, `rejectRevisionLine`, `approveCycle`,
`applyCycle`, `myRevisionLines`); variable pay
(`listVariablePayPlans`, `createVariablePayPlan`, `computePayout`,
`listVariablePayouts`, `approvePayout`, `markPayoutPaid`); benefits
(`listBenefitPlans`, `createBenefitPlan`, `enrolInBenefit`,
`cancelBenefitEnrollment`, `listMyBenefitEnrollments`,
`listBenefitEnrollments`); loans (`scheduleFor`, `requestLoan`, `listLoans`,
`approveLoan`, `rejectLoan`, `disburseLoan`, `recordLoanRepayment`);
expense claims (`submitExpenseClaim`, `listExpenseClaims`,
`approveExpenseClaim`, `rejectExpenseClaim`, `reimburseExpenseClaim`); and
`myEmploymentId()`, which resolves the caller's own employment relationship
id (what `/me/money` needs before it can call anything `@own`-scoped) —
this does not go through the `employees:view` grant, since it is "find my
own record," not a listing of anyone else's.

**The Self-Dealing Bar** is enforced on every approve action across five
resources (salary revision lines, the cycle itself, variable payouts, loans,
expense claims), in the same shape as `transitionCompensation` in
`employment.ts` and `approveSalaryStructure` in `compliance/payroll.ts`: the
approver may be neither the proposer/requester nor the employee the record
is about, unconditionally, at any amount. In the product's own four-role
matrix this is structural rather than merely checked — `hr_ops_manager`
holds `create`/`edit` on every WS7 resource and no `approve`; `finance_head`
holds `approve` (plus `view`/`export`/`financial`) and no `create`/`edit` —
so proposer and approver are never the same role in the first place. The
bar itself is still enforced in code (not only by the grant matrix, which a
tenant can rewrite), and the test suite proves it with a fixture role that
deliberately holds both verbs.

**Money withholding**: every list/read endpoint that returns a money field
calls `canSeeMoney(resource)` (the `financial` verb) and, when it is not
held, returns `null` with `moneyWithheldReason: 'no_permission'` rather than
a zero or a redacted-looking string. In the shipped matrix, `hr_ops_manager`
does not hold `financial` on `salary_revisions`/`variable_pay`/
`employee_loans`/`expense_claims` (only on `compensation` and `payroll`
generally) — so HR sees status and structure but the finance side sees the
actual figures. `finance_head` and `chairman` see them; an employee sees
their own (`VF@own`/`VC@own` grants).

### Routes (`/api/hcm/compensation`, `apps/api/src/routes/hcm/compensation.routes.ts`)

`GET /_status`, `GET /my-employment`; `/pay-grades` (list/create/update),
`/pay-grades/:id/compa-ratio/:employmentRelationshipId`; `/revision-cycles`
(list/get/create), `/revision-cycles/:id/{propose,approve,apply}`,
`/revision-cycles/:id/lines` (list/create), `/revision-lines/:id/
{approve,reject}`, `/my-revision-lines/:employmentRelationshipId`;
`/variable-pay-plans` (list/create), `/variable-payouts` (list/compute),
`/variable-payouts/:id/{approve,pay}`; `/benefit-plans` (list/create),
`/benefit-plans/:id/enrol`, `/benefit-enrollments` (list),
`/benefit-enrollments/:id/cancel`, `/my-benefit-enrollments/:employmentRelationshipId`;
`/loans/schedule`, `/loans` (list/create), `/loans/:id/{approve,reject,disburse,repay}`;
`/expense-claims` (list/create), `/expense-claims/:id/{approve,reject,reimburse}`.

### Web

- `apps/web/src/pages/hcm/Compensation.tsx` (`/people/compensation`) — six
  tabs: Grades, Revision cycles (with a drill-down into one cycle's lines),
  Variable pay, Benefits, Loans, Expenses. Every approve action is offered
  only where the acting role could plausibly hold the grant; the server's own
  refusal message carries the Self-Dealing Bar reason when someone tries
  anyway.
- `apps/web/src/pages/me/Money.tsx` (`/me/money`) — my expense claims (submit
  + status), my loans (request with a live EMI preview + status), my
  benefits (browse open plans, enrol, cancel).

## Acceptance

| ID | What PASS means | Test |
| --- | --- | --- |
| HCM-COMPENSATION-001 | An EMI schedule closes at exactly zero balance and its principal components sum to the original principal. | `EMI schedule closes exactly at zero and totals reconcile` |
| HCM-COMPENSATION-002 | Revision budget check and compa-ratio compute the stated arithmetic. | `revision budget check and compa-ratio compute the plain arithmetic` |
| HCM-COMPENSATION-003 | hrOps creates pay grades and they list in level order. | `hrOps creates a pay grade and it lists in level order` |
| HCM-COMPENSATION-004 | A grade with `minPay > maxPay` is refused. | `a grade with minPay above maxPay is refused` |
| HCM-COMPENSATION-005 | hrOps (holds create/edit, no approve) cannot approve a line; finance (holds approve, no edit) cannot apply a cycle — the roles cannot move money alone. | `hrOps proposes, finance approves and applies is refused to hrOps…` |
| HCM-COMPENSATION-006 | hrOps proposes, finance approves a third employee's line and the cycle, hrOps applies it, and an `Effective` `CompensationRecord` is written with the approved amount. | `hrOps proposes and finance approves a third employee's line, and applying…` |
| HCM-COMPENSATION-007 | A cycle whose approved lines exceed its own `budgetPct` is refused approval. | `a cycle whose approved lines exceed its own budget is refused approval` |
| HCM-COMPENSATION-008 | Money on a revision line is withheld (`null` + `no_permission`) from a role without the `financial` verb, and visible to one that has it. | `money on a salary revision line is withheld…` |
| — | A cross-tenant revision cycle id reads as 404, not 403 or leaked data. | `a cross-tenant revision cycle id is 404` |
| HCM-COMPENSATION-009 | The Self-Dealing Bar refuses a line's own proposer even when that principal (a fixture role) holds `approve`. | `the Self-Dealing Bar refuses a line's own proposer…` |
| HCM-COMPENSATION-010 | A variable payout is computed by hrOps, approved by finance, marked paid by hrOps. | `a payout is computed by hrOps, approved by finance, and marked paid by hrOps…` |
| HCM-COMPENSATION-011 | The Self-Dealing Bar refuses a payout's own computer even when that principal holds `approve`. | `the Self-Dealing Bar refuses a payout's own computer…` |
| HCM-COMPENSATION-012 | An employee enrols in a benefit plan and cancels their own enrolment. | `an employee enrols in a benefit plan and can cancel their own enrolment` |
| HCM-COMPENSATION-013 | An employee requests their own loan; only finance (not the employee) can approve it; hrOps disburses; a full repayment closes it. | `ravi requests his own loan, finance approves it…` |
| HCM-COMPENSATION-014 | Loan principal is withheld from a viewer without `financial`, visible to finance. | `loan principal is withheld from a viewer without the financial verb…` |
| HCM-COMPENSATION-015 | The Self-Dealing Bar refuses a loan for the approver's own employment even when that principal holds `approve`. | `the Self-Dealing Bar refuses a loan for the approver's own employment…` |
| HCM-COMPENSATION-016 | An employee submits their own expense claim; only hrOps/finance (never the employee) can approve it; hrOps reimburses. | `ravi submits his own claim, hrOps approves it…` |
| HCM-COMPENSATION-017 | Approving an already-reimbursed claim is refused as a conflict (invalid transition). | `an invalid transition (approving an already-reimbursed claim)…` |
| HCM-COMPENSATION-018 | The Self-Dealing Bar refuses a claim submitted and approved by the same dual-hatted principal. | `the Self-Dealing Bar refuses a claim submitted and approved by the same dual-hatted principal` |
| HCM-COMPENSATION-019 | A cycle's line list does not leak a colleague's line to an own-scope viewer. | `listing a cycle's lines does not leak a colleague's line to an own-scope viewer` |
| HCM-COMPENSATION-020 | An unfiltered payout list does not leak a colleague's payout to an own-scope viewer. | `an unfiltered payout list does not leak a colleague's payout to an own-scope viewer` |
| HCM-COMPENSATION-021 | An unfiltered loan list does not leak a colleague's loan to an own-scope viewer. | `an unfiltered loan list does not leak a colleague's loan to an own-scope viewer` |
| HCM-COMPENSATION-022 | An unfiltered expense claim list does not leak a colleague's claim to an own-scope viewer. | `an unfiltered expense claim list does not leak a colleague's claim to an own-scope viewer` |
| HCM-COMPENSATION-023 | An unfiltered benefit enrolment list does not leak a colleague's enrolment to an own-scope viewer. | `an unfiltered benefit enrolment list does not leak a colleague's enrolment to an own-scope viewer` |
| HCM-COMPENSATION-024 | An own-scope viewer is refused the cycle list and a single cycle outright (not merely narrowed), since a cycle spans every employee and has no "own" slice. | `an own-scope viewer is refused the cycle list and a single cycle outright, not merely narrowed` |
| HCM-COMPENSATION-025 | An own-scope employee cannot mark a colleague's approved expense claim reimbursed. | `an own-scope employee cannot mark a colleague's approved expense claim reimbursed` |

## Scope-axis audit (post-review)

A cross-workstream review (WS5) found that `assertCan({resource, verb})`
alone only proves a verb is held in *some* scope — it says nothing about
whether an `own`-scope grant is being exercised on the caller's own record,
because the WHERE/scope axis is only evaluated once a record (or an explicit
scope check) is in play. Auditing every function in this file against that
pattern found and closed:

- **List endpoints with no id to narrow by** (`listRevisionLines` when called
  without a matching own line, `listVariablePayouts`/`listLoans`/
  `listExpenseClaims`/`listBenefitEnrollments` when called with no
  `employmentRelationshipId`) returned every employee's rows to a caller
  holding only an `own`-scope grant — for `salary_revisions`/`variable_pay`
  (which also grant `financial` at `own` scope) this meant an employee could
  read a colleague's money outright. Fixed by narrowing the query to the
  caller's own employment whenever `scopeFor(resource, 'view') !== 'all'`.
- **`listRevisionCycles`/`getRevisionCycle`**: a cycle is a company-wide
  object with no "own" slice — `getRevisionCycle`'s aggregate budget in
  particular is exactly the shape `assertScopeAll` exists for. Both now
  require the `view` grant at `all` scope; `myRevisionLines` remains the
  employee's own read path.
- **`reimburseExpenseClaim`**: sat on `expense_claims:edit`, the same grant
  row as an employee's own `create`/`view` (`VCE@own`), with no employment
  check at all — an employee could mark *any* colleague's approved claim
  reimbursed. Now requires `edit` at `all` scope, like the approve/reject
  actions beside it.
- **`addRevisionLine`/`computePayout`**: hardened to require `create` at
  `all` scope outright — these are always proposed by HR *about* someone
  else, never a self-service act, even though no role currently holds either
  verb at `own` scope.
- **`enrolInBenefit`/`requestLoan`/`submitExpenseClaim`**: these legitimately
  serve both an own-scope self-service create and an all-scope HR create.
  They already resolved correctly today because the employee's `view` and
  `create` verbs sit on the same grant row (`VCE@own`/`VC@own`), but the
  employment check was against the *default* `view` verb rather than
  `create` — a coincidence of the current matrix, not a guarantee. Now check
  the `create` verb explicitly.
- Every `approve`/`reject` action, `proposeCycle`/`approveCycle`/
  `applyCycle`, `disburseLoan`/`recordLoanRepayment`, and `markPayoutPaid`
  were checked against the shipped matrix and confirmed to hold their verb
  only at `all` scope for every role that has it at all (`hr_ops_manager`,
  `finance_head`) — no change needed there beyond `reimburseExpenseClaim`
  above.

Tests HCM-COMPENSATION-019 through -025 prove each closed path against
`ravi` (a real `employee`-role principal) and a colleague's record.

## What this does not do

- Does not post anything to the general ledger. Reimbursing an expense claim
  or marking a payout paid records the *fact*, not a journal entry — WS8
  payrollops owns the ad-hoc pay line and the journal handoff into `books.ts`.
- Does not compute PF/ESI/PT/LWF or any statutory deduction on a revised
  CTC — that is `SalaryStructure` (`compliance/payroll.ts`), which reads
  whatever `CompensationRecord` this workstream's `applyCycle` writes.
- Variable pay formulas are evaluated against a caller-supplied `base`
  figure; this workstream does not derive that figure from sales
  performance, attendance, or any other system — the caller (a payroll
  run, a manager, an integration) supplies it.
- `EmployeeLoan` does not generate a persisted month-by-month repayment
  ledger; `outstandingPrincipal` is decremented by whatever
  `recordLoanRepayment` is told, and the EMI schedule shown to an applicant
  is illustrative (`scheduleFor`/`/loans/schedule`), computed on demand.
- No offer-letter or hiring integration: `compaRatioFor` reads an existing
  `CompensationRecord`, it does not check an offer being drafted by WS4
  recruiting.
- `CompBenchmark` (external market-data comparison) named as optional in the
  plan is not built — nothing in this codebase supplies external benchmark
  data to compare against.

## Wanted from the scaffold

- No gaps against the scaffold's grants, events, nav or record-code
  registries — `pay_grades`/`salary_revisions`/`variable_pay`/
  `benefit_plans`/`benefit_enrollments`/`employee_loans`/`expense_claims`
  and their four-role cells, the `kz.hr.salary_revision.*` /
  `kz.hr.variable_pay.*` / `kz.hr.benefit_enrollment.*` /
  `kz.hr.employee_loan.*` / `kz.hr.expense_claim.*` events, the
  `/people/compensation` and `/me/money` nav nodes, and the `SREV`/`LOAN`/
  `EXP` record-code prefixes were all already in place.
- One asymmetry worth flagging for the integrator rather than working
  around silently: `hr_ops_manager` holds `create`/`edit` but not
  `financial` on `salary_revisions`/`variable_pay`/`employee_loans`/
  `expense_claims`, so HR — who proposes every one of these — cannot see
  the money figure on their own proposal once it is listed back to them
  (only its status and structure). That is a real, working consequence of
  the shipped matrix, not a bug in this workstream, but it is worth a
  second look if the intent was for a preparer to see the number they
  themselves entered.
