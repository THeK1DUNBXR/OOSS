# Payroll statutory (workstream E)

What this workstream built against `docs/plan/compliance.md` §E, the
requirement IDs it satisfies, and the test that pins each one.

## Boundary

PF, ESI, professional tax and LWF are computed in-platform, against dated
rate tables, as the plan's recommended default. Salary TDS (Sec 192) is
workstream C's — `PayrollInstruction.tdsAmount` is left at whatever that
module writes; a contractor/consultant instruction instead carries a
`tdsSectionHint` of `194J` in `computedFrom` and no computed statutory
lines, for workstream C to key off. The platform files nothing with EPFO
or ESIC: `GET /runs/:id/ecr` and `.../esic` prepare the text a signatory
uploads by hand, audited via `auditExport`, the same posture GST returns
already take.

## Rate tables

`PfRateTable`, `EsiRateTable`, `ProfessionalTaxSlabTable`, `LwfRateTable`,
`MinimumWageTable` — each dated (`effectiveFrom`), each editable only by
`rate_tables:edit` (Finance Head; HR sees but does not edit). Pure
arithmetic lives in `packages/shared/src/compliance/payroll.ts`
(`computePf`, `computeEsi`, `computePt`, `computeLwf`, `statutoryLines`,
`gratuity`, `bonus`) and takes the rates as arguments — never a constant in
domain code.

Seeded in `apps/api/src/seed/compliance/payroll.ts`: PF (12%/12%, EPS
8.33% capped at ₹15,000, EDLI 0.5%, admin 0.5%), ESI (0.75%/3.25%, ceiling
₹21,000), Tamil Nadu Professional Tax half-yearly slabs and Tamil Nadu
Labour Welfare Fund (₹20/₹40, due December) — both marked
`confirmNote: "confirm against the corporation's/notification's current
schedule"` rather than presented as settled, and a minimum-wage row
(`general`, ₹12,000/month) as a placeholder floor.

## Salary structures

`SalaryStructure` (CTC breakdown: basic, HRA, special allowance,
conveyance, other allowances) is proposed by whoever holds
`salary_structures:create` (HR Ops) and approved by
`salary_structures:approve` (Finance) — the Self-Dealing Bar extended to
compensation structure the same way it already applies to payroll and
MoUs: `approveSalaryStructure` refuses when the approver's partyId matches
the proposer's, whoever they are (`docs/plan/compliance.md` Principle 3).

`computeInstruction(payrollRunId)` fills every statutory line on each
`PayrollInstruction` from the approved structure in force plus the dated
tables, sets `computedFrom = { pfTableId, esiTableId, ptTableId,
lwfTableId, structureId }`, and writes `deductions`/`netAmount`
accordingly. `engagementType !== 'employee'` (contractor, consultant,
intern, apprentice) computes none of PF/ESI/PT/LWF and instead carries
`computedFrom.tdsSectionHint = '194J'`.

Wired: `POST /compliance/payroll/runs/:id/compute` (idempotent, callable
standalone) and, since `payroll.ts`'s own `COMPUTE` transition now calls
`computeInstruction` too, the existing `/hr/payroll/runs/:id/transition`
endpoint computes the same way.

## The write-path hooks

Registered on `payroll_run.before_approve` (`apps/api/src/domains/compliance/payroll.ts`):

- **CMP-PAY-002** — refuses when `approverPartyId === run.preparedById`.
  `PayrollRun.preparedById` is set on `openPayrollRun` and again on the
  `COMPUTE` transition (`domains/payroll.ts`), so whoever last touched the
  figures is who gets barred, not merely whoever opened the run.
- **statutory lines not computed** — refuses when an instruction whose
  employee has a salary structure on file still has `computedFrom: null`.
  Scoped to employees the tenant has actually onboarded to structured
  payroll: an employee with no salary structure at all is unmeasured, not
  blocking, per Principle 6 — otherwise this would freeze every existing
  payroll run company-wide the day this workstream ships.
- **CMP-PAY-005** — refuses when a *computed* instruction's gross is below
  the `MinimumWageTable` floor for the company's state/category, and
  raises a named exception per instruction, owned by the run's preparer.

Registered on `payroll_run.approved`: issues one payslip per computed
instruction (`issuePayslipsForRun`).

## Payslips

`Payslip` (instruction, employment, pay period, `number` from the `P`
document series via `nextDocumentNumber`, `snapshot` Json, `issuedAt`,
`supersededById`). Issued once, on approval, never edited afterwards
(**CMP-PAY-003**) — the domain has no update path for a payslip at all; a
correction is a new row whose `supersededById`, or a new row referencing
it via `supersededById` on the original, points back while the original's
snapshot is untouched. The snapshot carries employer name/address/PF
code/ESI code, employee name/designation/UAN/masked ESIC number, earnings
and deductions by component, net, and the bank account's last four digits
only.

`GET /payslips` scopes to the caller's own employment when the caller
holds `payslips` at `own` (an employee), or the given
`employmentRelationshipId`/all when held at `all`. `GET /payslips/:id` and
`.../document` use `assertEmploymentVisible`'s scope-then-404 discipline
via a direct scope check (the model has no Prisma relation to
`EmploymentRelationship` — see "Field wanted on main.prisma" below).

## Exports

`GET /runs/:id/ecr` — `UAN#~#Name#~#Gross#~#EPF wages#~#EPS wages#~#EDLI
wages#~#EE#~#EPS#~#ER#~#NCP days#~#refund`, one line per instruction with
a nonzero PF line. `GET /runs/:id/esic` — CSV, `IP Number,IP Name,Days,
Wages,Reason Code`. Both call `auditExport`.

## Gratuity, bonus, and full-and-final settlement

Pure functions in `packages/shared`: `gratuity(lastDrawnBasicPlusDa,
monthsOfService, exceptionApplies?)` — 15/26 × wage × years, years rounded
per the Act (more than six months in the part-year rounds up), eligible
at 5+ years or on the death/disablement exception. `bonus(basicMonthly,
eligible, minimumWageMonthly?)` — 8.33% of basic capped at the lower of
₹7,000 or the minimum wage, eligible when basic is at or below ₹21,000.

`GratuityAccrual` — a monthly job (`apps/api/src/jobs/compliance/payroll.ts`,
1st of the month) writes one row per active employee, spreading the
eventual liability across twelve months from whatever salary structure or
compensation record is in force; idempotent against a re-run in the same
month via its unique key.

`POST /compliance/payroll/offboarding/:id/settle` computes gratuity,
leave encashment (`LeaveBalance` rows on `encashable` leave types, capped
at `maxEncashDays`, at basic/26 per day), pro-rata bonus, and writes
`Offboarding.gratuityAmount`/`leaveEncashmentAmount`/`bonusAmount`/
`noticeRecoveryAmount`/`settlementAmount`/`settlementComputedAt`. Notice
recovery is left at zero: the employment model carries no date notice was
actually given, distinct from the separation date, so unserved days
cannot be computed without guessing — `noticeRecovery` is exported from
`packages/shared` for whichever screen collects that date.

## Engagement type and bank/nominee details

`PATCH /compliance/payroll/employees/:id/engagement`
(`{ engagementType }`, one of employee/contractor/consultant/intern/
apprentice) and `.../bank` (`{ bankAccountNumber, bankIfsc,
bankAccountName, nomineeName, nomineeRelationship, esicNumber }`), both
audited — the bank/nominee write records only which fields changed, never
the regulated values themselves, matching `redactRegulatedEmploymentFields`'s
exclusion of the same fields from every read (**CMP-PAY-004**'s other
half: a contractor's instruction computes zero statutory lines and
carries the `194J` hint, asserted directly against `computeInstruction`).

## Web

`apps/web/src/pages/compliance/Payroll.tsx` — tabs for Runs (compute, a
lines table per employee, the Approve action's absence explained when the
viewer prepared the run), Salary structures (propose/approve), Rate
tables (read view of every table with confirm-notes surfaced), Payslips
(list + a printable document view), Exports (ECR/ESIC text, states
plainly that nothing is transmitted), Settlements (full-and-final
computation).

## Requirement IDs and their tests

All in `apps/api/src/tests/compliance/payroll.test.ts` unless noted.

| ID | What PASS means | Test |
|---|---|---|
| CMP-PAY-001 | PF computes the correct split for a wage at or below the ceiling, from the dated table | `PF splits 12% employee and 12% employer…` (pure) and the full-run test's instruction assertions |
| CMP-PAY-002 | The payroll proposer cannot also approve the same run | `CMP-PAY-001 / CMP-PAY-002 / CMP-PAY-003…` — Finance both prepares and is refused approving; the chairman approves instead |
| CMP-PAY-003 | An issued payslip cannot be edited; a correction is a new payslip referencing the original | same test — the original's snapshot is asserted unchanged after a correction row is written |
| CMP-PAY-004 | A contractor-flagged engagement computes no statutory lines and carries the 194C/194J hint | `CMP-PAY-004: a contractor computes no PF/ESI/PT/LWF…` |
| CMP-PAY-005 | An approval is refused when a computed instruction pays below the minimum wage floor | `CMP-PAY-005: a computed run paying below the minimum wage floor…` |

Also pinned: the ECR line format (11 `#~#`-delimited fields), the ESIC CSV
header, rate-table arithmetic (PF split, ESI eligibility, PT slab lookup,
LWF due-month gating, gratuity year-rounding, bonus cap), and a
full-and-final settlement's gratuity/leave-encashment/bonus computation.

## What this does not do

States its own boundary on the Exports tab and in `docs/plan/compliance.md`'s
own register: it does not file anything with EPFO, ESIC or the income tax
department — it exports what a signatory uploads. It does not give tax or
legal advice: the Professional Tax and LWF tables are marked for
confirmation against the corporation's/notification's current schedule
rather than presented as settled. It does not compute Sec 192 salary TDS
— that is workstream C's, left as a zero placeholder with the section
hint set for a contractor engagement.

## Fields wanted on main.prisma (not added; not mine to add)

- A `category` field on `EmploymentRelationship` (or `Position`) for the
  minimum-wage check — CMP-PAY-005 today falls back to one company-wide
  `"general"` category, which is honest about the gap rather than
  inventing a taxonomy.
- A relation from `SalaryStructure`/`Payslip`/`GratuityAccrual` to
  `EmploymentRelationship` — every reference here is a plain id column
  with no `@relation`, since the back-relation array would have to live on
  `EmploymentRelationship` in `main.prisma`.
- A date notice was actually given, distinct from `separationDate`, so
  notice recovery need not stay at zero.
