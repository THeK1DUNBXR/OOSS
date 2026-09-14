# Compliance — income tax and TDS (workstream C)

What was built against `docs/plan/compliance.md` §C, and the test that pins
each requirement. Read `docs/plan/compliance.md` for the law and the
acceptance criteria this answers to.

## What exists

- `TdsSectionRate` — a dated section-rate table (194C individual/company,
  194J professional/technical, 194H, 194I land-building/plant, 194Q, 192
  marker), rate, per-transaction and per-FY thresholds, and the Sec 206AA
  PAN-missing rate. Seeded in `src/seed/compliance/tax.ts`; every figure is
  this platform's best-known rate and carries a note to confirm against the
  Finance Act in force.
- `computeTds`, `computeAnnualTax`, `monthlyTds`, `advanceTaxSchedule`,
  `msmeDueDate` in `packages/shared/src/compliance/tax.ts` — pure arithmetic,
  no database, taking every rate and threshold as an argument.
- Vendor TDS: `POST /compliance/tax/vendor-bills/:id/tds` computes and writes
  `tdsSection`/`tdsRate`/`tdsAmount` on the bill from the dated table and
  records a `TdsDecision`. `POST /compliance/tax/vendor-bills/:id/tds/waive`
  records an explicit not-applicable decision with a reason. The books'
  `vendor_bill.before_pay` hook (registered in `domains/compliance/tax.ts`,
  which must be imported somewhere reachable from boot — it is, through the
  route file) refuses payment of a bill whose ledger category defaults to a
  TDS section (`TdsApplicabilityRule`, tenant-editable via
  `POST /compliance/tax/applicability-rules`) on which nobody has recorded a
  decision. **CMP-TDS-001**, pinned by
  `src/tests/compliance/tax.test.ts` › "CMP-TDS-001 — a bill under an
  applicable TDS category cannot be paid until TDS is settled".
- Challans: `TdsChallan`, `POST /compliance/tax/challans` (proposes, amount
  defaults to the computed liability), `POST /compliance/tax/challans/:id/paid`
  (approves — refuses if the approver is the preparer, compared by partyId).
  A daily job (`runTdsDepositDueJob`, `jobs/compliance/tax.ts`) raises
  `CMP_TDS_DEPOSIT_DUE` with `slaDueAt` the 7th (30 April for March),
  escalating through three rungs (3 days before, on the day, after) via
  `raiseException`'s own escalation. **CMP-TDS-002**, pinned by "CMP-TDS-002 —
  TDS challans › the deposit ladder fires before the 7th, and a challan is
  marked paid only against BSR/challan number".
- MSME 43B(h): `POST /compliance/tax/vendor-bills/:id/msme` sets
  `msmeDueAt = billDate + min(agreedTermDays ?? 45, 45)`. A daily job
  (`runMsmeLadder`) raises `CMP_MSME_45_DAY` (S2) once per bill past due,
  unpaid. The before-pay hook does not block on this — `GET
  /compliance/tax/msme/exposure` shows the disallowance exposure instead.
  **CMP-TDS-003**, pinned by "CMP-TDS-003 — MSME 45-day payment term".
- Salary TDS (Sec 192): `TaxDeclaration` per employment per FY (regime,
  declared deductions), `IncomeTaxSlabTable` dated per regime per FY.
  `GET /compliance/tax/salary/:employmentId/projection` shows the annual
  estimate and the monthly figure still outstanding. `applySalaryTds`
  (`POST /compliance/tax/salary/apply/:payrollRunId`) is the only place
  `PayrollInstruction.tdsAmount` is written for salary — workstream E's
  payroll run calls the route.
- Returns and forms: `TdsReturn` (24Q/26Q, `prepared`/`filed`/`superseded`,
  snapshot Json, never edited once filed — pinned by "Quarterly TDS returns —
  snapshot, superseded, never edited"). `POST /compliance/tax/returns/prepare`,
  `POST /compliance/tax/returns/:id/file`, `GET
  /compliance/tax/returns/:id/export` (deductee-row CSV: PAN, name, section,
  amount paid, TDS, challan) — prepares, does not transmit.
  `TdsCertificate` (Form 16A per vendor per quarter, Form 16 per employee per
  FY), final once issued — a correction supersedes via `supersedesId`.
  `GET /compliance/tax/certificates/:id/document` is the printable shape.
- Advance tax: `GET /compliance/tax/advance-tax/:fy` estimates from books
  `profitAndLoss` (read-only, called through the route — this module never
  writes to the books) annualised and taxed at `CorporateTaxRate` (115BAA,
  seeded at 25.17%), shown against the Sec 211 15/45/75/100% schedule and
  `AdvanceTaxPayment` rows.

## Web

`apps/web/src/pages/compliance/Tax.tsx` — seven tabs: TDS on bills (set
section modal), challans, salary TDS, returns, certificates, advance tax,
MSME.

## What this does not do

- Section rates are this platform's best-known figures, not a live feed from
  the Income Tax Department — each carries a note to confirm before a live
  filing.
- 194Q's separate 50-lakh aggregate-purchase exemption and 206AB's
  higher-rate-for-non-filer rule are not modelled — only the per-transaction
  and per-FY thresholds `computeTds` takes.
- Declared deductions (80C, 80D, HRA, etc.) are summed as given; this
  platform does not enforce each section's own statutory cap.
- Returns are prepared for upload; nothing here transmits to the portal.

## Open questions (from the plan, unanswered by this build)

Has TAN been obtained and has TDS been deducted to date — a standing
exposure for the company's auditor, not something this platform can answer.
Which vendors hold a Sec 197 certificate, and which are Udyam-registered —
both are entered per bill as they come to light, not backfilled.
