# Compliance — plan

What it would take for Kaizen Infinities to run every legal, tax and
statutory obligation it holds as KIPL on KaiERP itself, with figures that
tie to the books, in the same structural style as the rest of the
platform: authority separated, documents final once issued, everything
audited, deadlines run as jobs rather than remembered by a person.

This is a plan, not a build. It says what exists, what principles the
compliance work would extend from the platform's own rules, what eight
workstreams would need to build, in what order, and what the company
alone can answer before any of it can be sized precisely.

---

## Where the platform stands

The platform carries real compliance machinery for GST and for regulated
employee data. It carries almost nothing for income tax, payroll
statutory deductions, labour law process, or a calendar that turns any
of this into a job rather than a memory.

| Area | Exists | Partial | Absent |
|---|---|---|---|
| GST core | GSTIN validation, place-of-supply/CGST-SGST-IGST split, HSN/SAC, GSTR-1 and GSTR-3B computation, offline-utility JSON export | Credit notes (generic sequence, no reason codes) | Reverse charge, e-invoicing, GSTR-2B/ITC reconciliation, exempt/composition/education exemption, debit notes, late fee/interest, e-way bill |
| Income tax / TDS | — | — | TAN, TDS on vendor bills, TDS on salary, Form 16/16A, 26Q/24Q, advance tax, MSME 43B(h) |
| Books and audit | Governed-entity diff audit (5 model types), gapless document numbering, FY Apr-Mar, FixedAsset register (SLM/WDV) | Period lock (GST only); depreciation (no Schedule II table) | Ledger entities in the audit registry, hash-chain on AuditRecord, 8-year retention enforcement, trial balance/GL export, bank-reconciliation matching |
| Payroll statutory | Instruction/audit layer, structural exclusion of PAN/Aadhaar/UAN | CompensationRecord (amount + basic only) | PF, ESI, PT, TDS 192, LWF, gratuity, bonus, payslip document, ECR/ESIC export |
| Labour law/conduct | Statutory leave types seeded, offboarding state machine, notice period | — | Paternity leave, carry-forward/encashment, holidays, hours caps, POSH model, structured disciplinary process, statutory registers |
| Data protection (DPDP) | Classification/sensitivity registry, structural field exclusion, purpose-required WHY axis, retention floor | — | Consent model (plumbing present, always empty), data-principal rights, breach register, minor/guardian consent, cross-border control |
| Corporate / security | GSTIN/PAN/CIN, expiry ladders on MoU/Contract, self-dealing bar | — | TAN, statutory registers, MCA filing reminders, e-sign/DSC, MFA, password policy, secrets management, backups |
| Compliance calendar | — | — | Entirely absent: no obligation model, no deadline job, no screen |

The gap has a consistent shape: the platform has built the *structural*
primitives compliance work would reuse — audited governed writes,
hash-chained events, idempotent ladder jobs, a classification/purpose
axis, document finality — and has not pointed any of them at a statutory
obligation yet. Most of what follows is new domain modules wired onto
existing plumbing, not new plumbing.

---

## Principles for compliance work

These extend rules the platform already enforces elsewhere.

1. **A statutory computation is data, not a constant.** PF/ESI/PT rates,
   TDS thresholds, minimum wages and Schedule III groupings each change
   by notification on their own timeline, so each lives in a dated rate
   table with an effective-from date — the way `finance.ts` already keeps
   the GST set-off order as pure, tested arithmetic, never an inline
   number.
2. **A return or filing is a snapshot, superseded, never edited.**
   `GstFiling` already does this. TDS returns, PF ECR, ESIC returns and
   any other periodic filing follow the same shape.
3. **The proposer never approves.** Payroll preparation, a TDS challan
   payment, a filing submission — each needs a distinct propose step and
   approve step on the Self-Dealing Bar the platform already runs for
   MoUs and contracts (`approvals.ts`). Nobody approves their own filing.
4. **Deadlines are jobs, not memory.** The 7th (TDS deposit), the 15th
   (PF/ESI), GST and advance-tax due dates: each is an idempotent ladder
   job keyed the way expiry ladders already are, firing once at the
   tightest crossed rung.
5. **Regulated identifiers are structurally excluded and encrypted.** PAN
   and Aadhaar already leave the response shape. Bank details and any new
   identifier (TAN, ESIC IP number) get the same exclusion, plus
   field-level encryption at rest, which no field has today.
6. **"Not yet measured" is distinct from "compliant."** A domain with no
   PF computation wired up is unmeasured, not "0% variance" — the same
   discipline health scores already apply.
7. **What the platform does not do is stated on screen.** The GST returns
   screen already says it prepares but does not transmit returns; every
   compliance surface added here states its own boundary the same way.

---

## Workstreams

### A. Compliance calendar and register

**Law.** No single statute; the spine for every deadline below —
GSTR-1/3B, TDS deposit by the 7th and returns 26Q/24Q quarterly, PF ECR
by the 15th, ESI by the 15th, Tamil Nadu Professional Tax (half-yearly),
advance tax (Income-tax Act Sec 211), AOC-4/MGT-7/DIR-3 KYC (Companies
Act 2013), the POSH annual report (POSH Act 2013 Sec 21).

**Today.** `scheduler.ts` `ALL_JOBS` runs idempotent ladder jobs and
`ExceptionRecord`/`Notification` carry SLA/escalation, but no
GST/TDS/PF/ESI deadline is registered (`apps/api/src/jobs/scheduler.ts:56-73` holds only the agreement expiry ladders, SLA and health jobs).

**Build.** A `ComplianceObligation` model — type, governing section,
recurrence, due-date rule, owner role, evidence link, status
(upcoming/due/filed/overdue/waived) — with exception codes registered
against `ExceptionRecord`. A ladder job per recurrence class. A
Compliance screen listing obligations by status with a drill path, in the
health-score idiom.

**Acceptance.**
- CMP-CAL-001: PASS when every obligation above has a
  `ComplianceObligation` row with a correct recurrence rule and owner.
- CMP-CAL-002: PASS when marking an obligation filed requires a linked
  evidence document, FAIL if status flips with none.
- CMP-CAL-003: PASS when an unowned obligation surfaces in `H_OPS` as a
  routing defect rather than silently going unowned.

**Open questions.** Which registrations does the company currently hold
— GST, TAN, PF code, ESI code, PT (which state), CIN?

---

### B. GST completion

**Law.** CGST Act/Rules: reverse charge (Sec 9(3)/9(4)); exempt/nil
supplies; the education-services exemption under Notification
12/2017-CT(R) entry 66 (a narrow, defined category — needs checking
against each offering, not assumed from the division's name);
e-invoicing (Rule 48(4), mandatory above a turnover threshold currently
₹5 crore, changed by notification repeatedly); GSTR-2B/ITC
reconciliation (Rule 36(4)); debit notes (Sec 34); late fee (Sec 47) and
interest (Sec 50); e-way bill (Rule 138, goods only).

**Today.** `computeGstr1`/`computeGstr3b` (`gstReturns.ts:138-750`), the
ITC set-off order (`finance.ts:356-409`), offline export
(`gstReturns.ts:1047-1205`). Reverse charge is hard-coded 'N'
(`gstReturns.ts:101,217,235`; the 3B `isup_rev` block is never populated
at 1166-1169). Nil/exempt/non-GST are hard-coded to zero, with a comment
that the platform "cannot yet mark a supply as exempt"
(`gstReturns.ts:637-649`). CreditNote exists (schema:2263-2280;
`gstReturns.ts:310-343`) but on a generic `REC` sequence with no reason
code; there is no DebitNote model.

**Build.** A `supplyType` field on InvoiceLine (taxable/nil/exempt/
non-GST) feeding GSTR-1/3B in place of the hard zero. An `rcmApplicable`
flag on VendorBill populating `isup_rev`. A DebitNote model with its own
document series and mandatory reason code, matching CreditNote. An
e-invoicing provider adapter (IRN/QR fields plus a pluggable boundary,
the posture `payroll.ts` already takes toward an external engine).
GSTR-2B import for ITC reconciliation. Late fee/interest as a dated rate
table. E-way bill fields, gated on goods vs service.

**Acceptance.**
- CMP-GST-001: PASS when a nil/exempt line reports as such with zero tax
  and does not add to taxable turnover.
- CMP-GST-002: PASS when a reverse-charge vendor bill populates
  `isup_rev` and creates the self-invoice obligation.
- CMP-GST-003: PASS when a debit note has its own gapless series and a
  mandatory reason code, distinct from credit notes.
- CMP-GST-004: PASS when e-invoicing is declared not-configured on a
  fresh tenant rather than silently omitting IRN/QR.

**Open questions.** Is turnover above the e-invoicing threshold (₹5
crore, confirm live figure)? Does any offering genuinely qualify for the
Notification 12/2017 entry 66 exemption, or is composition relevant to
any part of the business? Are any goods (not services) sold, triggering
e-way bill?

---

### C. Income tax and TDS

**Law.** Income-tax Act: TAN (Sec 203A); TDS on vendor payments —
194C (contractors), 194J (professional fees), 194H (commission), 194I
(rent), 194Q (goods purchase) — each with its own rate/threshold, and
lower-deduction certificates (Sec 197); TDS on salary (Sec 192) per
employee's declared regime; challan by the 7th; Form 16/16A; quarterly
24Q/26Q; advance tax (Sec 211); MSME Sec 43B(h) — a bill to a
Udyam-registered enterprise unpaid past the agreed term or 45 days,
whichever is shorter, is disallowed.

**Today.** Nothing. No TAN on CompanyProfile (schema:90-94 has only
gstin/pan/cin). No TDS field on VendorBill (schema:3866-3899). Payroll
posts to books with no tax line (`books.ts:1181`).

**Build.** TAN on CompanyProfile, validated like GSTIN
(`companyProfile.ts:78-85`). A dated section-rate table (194C/194J/194H/
194I/194Q) with a lower-deduction-certificate override per payee. A
`tdsDeducted` line on VendorBill computed at approval (proposer/approver
split preserved), feeding challan tracking. Salary TDS 192 as its own
module keyed on regime + declarations. Form 16/16A as final-once-issued
documents. 26Q/24Q quarterly exports, "prepares, does not transmit" like
GSTR-1. Advance-tax computation from YTD profit. A `udyamRegistered` flag
and agreed-term field on Vendor with a 45-day ladder feeding a Sec
43B(h) exception.

**Acceptance.**
- CMP-TDS-001: PASS when a bill above a section's threshold computes TDS
  from the dated table and blocks payment until deducted or waived with
  a certificate reference.
- CMP-TDS-002: PASS when the TDS deposit ladder fires before the 7th and
  is marked paid only against a linked challan.
- CMP-TDS-003: PASS when a Udyam-flagged vendor bill unpaid past 45 days
  raises a named Sec 43B(h) exception.

**Open questions.** Has TAN been obtained, and has TDS been deducted to
date (if not, that is a standing exposure to raise with the company's
auditor, separate from this plan)? Are lower-deduction certificates used
for any vendor? Which vendors are Udyam-registered?

---

### D. Books and audit

**Law.** Companies Act 2013 with the Companies (Accounts) Rules 2014
proviso to Rule 3(1) — accounting software must record every change in
an audit trail that cannot be disabled; retention norms of roughly 6-8 years; Schedule III (statement
format) and Schedule II (depreciation).

**Today.** The audit registry (`audit.ts:83-92`) excludes `transaction`,
`vendor_bill`, `fixed_asset`, `loan`, `ledger_account` — exactly the set
the audit-trail proviso targets. `AuditRecord` is not hash-chained (only
`EventRecord` is, `eventBus.ts:95-110`). Chart of accounts is explicitly
"the company's own, not statutory" (schema:3773), no Schedule III
grouping. Period lock exists only via GST's `assertPeriodOpen`
(`invoicing.ts:232-256`), no GL-wide close. Depreciation
(`finance.ts:576-600`) runs on user-entered useful life, no Schedule II
table. Bank reconciliation is a bare `reconciledAt` timestamp
(schema:3847), no matching function. No trial balance/GL export.

**Build.** Add the five excluded models to the governed-entity registry.
A hash chain on `AuditRecord` matching `EventRecord`'s integrity block. A
GL period-close job independent of GST. A retention job reading
`EventRecord.retentionClass` (schema:874, written but unused today) at
an 8-year floor. Schedule III tags alongside the existing CoA grouping.
A Schedule II useful-life table flagging mismatches against the
user-entered value, plus a separate IT Act block-of-assets WDV
computation. Bank-reconciliation matching. Trial balance/GL/auditor
exports; a Tally export to match the existing import.

**Acceptance.**
- CMP-AUD-001: PASS when a write to any of the five newly-governed
  models produces an `AuditRecord` with a field-level diff.
- CMP-AUD-002: PASS when `verifyChain()` on `AuditRecord` detects
  tampering, the same guarantee `EventRecord` already has.
- CMP-AUD-003: PASS when a transaction dated inside a closed GL period
  cannot be created or edited, independent of GST filing status.

**Open questions.** None specific to the company beyond the statutory
auditor's preferred export format.

---

### E. Payroll statutory

**Law.** EPF & MP Act 1952 (12%/12% split, 8.33%/3.67% EPS, wage ceiling
currently ₹15,000/month); ESI Act 1948 (wage ceiling currently
₹21,000/month); Payment of Gratuity Act 1972 (15 days' wages per year
past 5 years); Payment of Bonus Act 1965; Tamil Nadu Professional Tax;
Sec 192 TDS (covered in C, computed inside the run).

**Today.** `PayrollInstruction` (schema:3634-3661) carries gross, a
single lump deduction and net, human-typed (`payroll.ts:152-182`).
`payroll.ts:4` states plainly: "Computing pay is not this system's job."
None of PF, ESI, PT, 192, LWF, gratuity, bonus, a payslip document, or
ECR/ESIC export exist. `CompensationRecord` has amount and basic pay
only, no HRA/CTC breakdown.

**Build.** The one real design decision in this plan: compute the
statutory lines in-platform against versioned rate tables, or stay an
instruction/audit layer in front of an external provider. Recommended:
define the boundary as an adapter that a provider could sit behind, and
ship in-platform computation of PF/ESI/PT/TDS as the default behind it,
because at this headcount the figures should tie directly to the books
rather than sit inside a provider's black box. Concretely: CTC-component models
(basic, HRA, allowances) above `CompensationRecord`; PF/EPS/ESI/PT/LWF/
TDS lines on `PayrollInstruction` from dated rate tables; a payslip
document, final once issued like a tax invoice; ECR and ESIC exports;
gratuity/bonus accrual replacing the manual `Offboarding.settlementAmount`
Decimal (schema:3719); a minimum-wage check; bank/IFSC/nominee/ESIC
fields under the same exclusion-and-encryption discipline as PAN; an
`engagementType` field (employee vs contractor) driving 192 vs 194C/194J.

**Acceptance.**
- CMP-PAY-001: PASS when PF computes the correct split for a wage at or
  below the ceiling, from the dated table, FAIL if from a code constant.
- CMP-PAY-002: PASS when the payroll proposer cannot also approve the
  same run (Self-Dealing Bar extended to payroll).
- CMP-PAY-003: PASS when an issued payslip cannot be edited — a
  correction is a new payslip referencing the original.
- CMP-PAY-004: PASS when a contractor-flagged engagement computes
  194C/194J instead of Sec 192 on the same payment.

**Open questions.** In-platform computation or an external provider —
and if a provider, which, and what export format does it need? Is any
employee's wage at or below the ESI ceiling (₹21,000, confirm live
figure) or PF ceiling (₹15,000)? Which state(s) is PT owed in? Are any
current engagements contractor/intern/apprentice, and is that
classification correct?

---

### F. Labour law and conduct

**Law.** Tamil Nadu Shops and Establishments Act (hours, holidays,
registers); Maternity Benefit Act 1961; POSH Act 2013 (Internal
Committee, 90-day inquiry, 10-day report, annual report to the District
Officer); Payment of Bonus/Gratuity Acts (accrual in E, registers here);
EPF/ESI Forms 11, 10C, 19 at offboarding.

**Today.** `seedLeaveTypes` (`bootstrap.ts:664-683`) seeds CL/SL/EL/ML —
no paternity type. `LeaveBalance`/`LeaveTransaction` are a running
ledger with no carry-forward job or encashment. No `Holiday` model.
`WorkAttendance` tracks minutes with no hours cap or OT rate rule. The
offboarding machine (`shared/hr.ts:440-468`) has no gratuity computation,
no relieving/experience letter, no Form 10C/19 item.
`PerformanceEvidence.caseScoped` is a generic evidence bucket labelled
for ICC use, but there is no Internal Committee model, complaint
workflow, or structured disciplinary process. `affiliationType` is
`'employee'` only — no contractor/intern/apprentice.

**Build.** A `Holiday` model; a carry-forward/encashment job; a
paternity leave type; hours caps (8/day, 48/week under the Tamil Nadu
Act) and OT rate on
`WorkAttendance`; statutory register exports (wages, leave, muster roll)
reading existing data. A POSH Internal Committee model, a Complaint case
type with the 90-day/10-day deadlines as ladder jobs, and an annual-
report export. A structured disciplinary process (show-cause, inquiry,
decision). Offer/appointment/relieving/experience letters as issued
documents, extending the hiring flow (currently reaches `OfferAccepted`
with none, `hiring.ts:264-266`). FnF wired to E's accrual. Form
11/10C/19 as offboarding checklist items. Contractor/intern/apprentice
as new `affiliationType` values.

**Acceptance.**
- CMP-LAB-001: PASS when a POSH complaint's inquiry deadline fires an
  exception at 90 days if unclosed.
- CMP-LAB-002: PASS when weekly hours exceeding 48 raise an exception
  rather than posting silently to payroll.
- CMP-LAB-003: PASS when an accepted offer generates an appointment
  letter as a final document, not a bare state flip.
- CMP-LAB-004: PASS when leave carry-forward is idempotent against a
  re-run in the same period.

**Open questions.** Current Internal Committee composition — does it
meet the external-member requirement? Is there a paternity-leave policy?
Any contractors/interns/apprentices currently engaged?

---

### G. Data protection and privacy (DPDP)

**Law.** DPDP Act 2023 and DPDP Rules 2025: consent as the basis for
processing; a privacy notice; data-principal rights (access, correction,
erasure); verifiable parental consent for minors; 72-hour breach
notification; IT Act 2000 reasonable-security norms.

**Today.** The WHY axis requires purpose when classification is
`regulated` and denies `purpose_unbound` (`permissions.ts:229-245`), but
purpose is always `'operational'` and `consentCodes` is always `[]`
(`context.ts:31,121,149`). `deletedAt` is a stated "never a hard delete"
(schema:14). `statutoryRetentionFloor` exists on employee/student
affiliations (`employment.ts:249,331`). `EventRecord.retentionClass`
(schema:874) is written but never read by a purge job. No consent model,
no data-principal workflow, no guardian-consent field for minors
(`bootstrap.ts:196-197` names this gap in a comment), no breach log.

**Build.** A `Consent` model populating `consentCodes`, tied to a stated
purpose and a data principal. A privacy-notice model with versioning. A
data-principal-request workflow (access/correction/erasure) that reasons
against `statutoryRetentionFloor` and explains a refusal rather than
silently denying. A guardian-consent field required wherever
`StudentProfile` is a minor. A retention job that actually reads
`retentionClass` and purges/flags past its window. A breach register
with a 72-hour notification ladder. Field-level encryption for PAN,
Aadhaar and bank values (structural exclusion from responses is not
encryption at rest). An offboarding-triggered `Affiliation` revocation —
access today is evaluated live with no automatic revocation on exit
(`permissions.ts:12`).

**Acceptance.**
- CMP-DPD-001: PASS when a regulated-field access has a matching consent
  record, FAIL if permitted under `'operational'` with none.
- CMP-DPD-002: PASS when an erasure request inside the retention floor
  is refused with the floor named, not silently ignored.
- CMP-DPD-003: PASS when a minor `StudentProfile` cannot be created
  without a linked guardian-consent record.
- CMP-DPD-004: PASS when PAN/Aadhaar/bank values are encrypted at rest,
  verified by reading the raw database column directly.

**Open questions.** What age threshold applies for a minor student, and
how is it determined today? Does the company receive personal data from
outside India? Who is the named DPO/grievance contact?

---

### H. Corporate, contracts and security hygiene

**Law.** Companies Act 2013 (registers of members/directors/charges;
board minutes; AOC-4/MGT-7/DIR-3 KYC, feeding A); Indian Stamp Act and IT
Act 2000 (e-signature, Aadhaar eSign/DSC); FEMA (FIRC on foreign
receipts); no single Act governs certificate issuance but it is a
document-finality question the platform already models.

**Today.** `CompanyProfile` has gstin/pan/cin, no TAN and no
PAN-in-GSTIN cross-check. `Decision`/`ApprovalStep` are business
governance, not statutory minutes — no register distinct from
`Decision`. `Mou`/`Contract`/`PartnerAgreement` (schema:1530-1677) carry
status, signing, renewal and expiry ladders (`scheduler.ts:56-73`) with
a self-dealing bar (`approvals.ts:13,137-169`) — solid ground to extend.
`Document` (schema:1829) is metadata only, no e-signature. No
`Certificate` or `Refund` model. On security: `JWT_SECRET` falls back to
a literal `'dev-secret-change-me'` (`auth.ts:33`); no MFA — step-up is
password re-entry (`auth.ts:35,175-217`); plaintext secrets in
`docker-compose.yml:35-50`; no rate limiting (`server.ts:15-17`); no
backup job.

**Build.** TAN plus a PAN-in-GSTIN cross-check. Statutory-register
models (members, directors, charges). A board-minutes model distinct
from `Decision`. MCA filings as `ComplianceObligation` rows (feeds A).
Stamp-duty and e-signature fields on `Document`/`Mou`/`Contract` with an
Aadhaar-eSign-or-DSC adapter (same pluggable posture as e-invoicing).
Document retention-period fields. FEMA/FIRC tracking. A `Refund` model
following the Obligation/Movement/Allocation discipline. A `Certificate`
model, final once issued. Security: enforce `JWT_SECRET` at boot, a
password policy, TOTP MFA for Finance Head and Chairman specifically,
rate limiting, a backup job.

**Acceptance.**
- CMP-COR-001: PASS when the API refuses to start with `JWT_SECRET`
  unset or equal to the fallback value.
- CMP-COR-002: PASS when Finance Head and Chairman logins require a
  second factor to approve payroll or a filing.
- CMP-COR-003: PASS when a board resolution is immutable once recorded
  and distinct from a `Decision` row.
- CMP-COR-004: PASS when a refund is its own Movement fact (a negative
  Payment-shaped row), never an edit to the original invoice or receipt.

**Open questions.** Current directors and any registered charges, for
statutory-register seed data? Any foreign receipts (FEMA/FIRC)? Is there
a written refund policy today?

---

## Sequencing

Four phases, ordered by legal exposure against build cost.

| Phase | Workstreams | Why now | Rough size |
|---|---|---|---|
| **1** | A (calendar spine); D partial (audit-trail proviso: 5 models into the registry, hash chain); C core (TAN, vendor TDS, challan tracking); H security (JWT_SECRET, MFA for Finance Head/Chairman, rate limiting) | Highest exposure at lowest build cost — the audit-trail proviso is a registry addition, not new plumbing; a hard-coded JWT fallback and no MFA on the two money-approving roles is a standing exposure regardless of compliance framing; undeducted TDS compounds interest monthly | A: M · D-partial: S · C-core: M · H-security: S |
| **2** | B (GST: RCM, exempt/education classification, debit notes); C completion (salary TDS, Form 16/16A, 26Q/24Q); E core (PF/ESI/PT, payslip) | GST and payroll are already in daily use; the current gaps (hard zero for exempt supplies, no PF/ESI at all) are producing wrong figures today, not just missing paperwork | B: L · C-rest: M · E-core: L |
| **3** | F (labour law, POSH); G (DPDP consent and data-principal rights) | Lower immediate financial exposure than 1-2 but exposure that grows with headcount and any DPDP enforcement in the sector; POSH's inquiry timelines run whether or not the platform tracks them | F: L · G: L |
| **4** | H remainder (registers, board minutes, e-sign, FEMA, Certificate/Refund); E remainder (accrual polish, ECR/ESIC automation); D remainder (Schedule III/II, trial balance/GL, bank reconciliation) | Lower frequency, lower exposure, or waiting on a provider decision (e-sign vendor, ECR format) phases 1-3 don't need settled | H-rest: M · E-rest: M · D-rest: M |

---

## What the platform will still not do

In the register of `docs/invoicing.md`'s own such section:

- It will not file GST, TDS or PF/ESI returns with the respective
  portals. Like GSTR-1/3B today, it prepares and exports; filing is
  recorded against a real ARN/receipt number, never invented.
- It will not transmit e-invoices to the IRP without a configured GSP
  adapter; without one it says so on screen rather than omitting the IRN
  field silently.
- It will not be an e-signature certifying authority; it integrates with
  an Aadhaar eSign or DSC provider.
- It will not give legal or tax advice. Rate tables and section numbers
  are dated data, but a genuinely ambiguous classification (does a
  course qualify for the education exemption; is a worker a contractor)
  is a question for counsel or the auditor, surfaced as open, not
  resolved silently.
- It will not compute payroll for an external provider's book of record
  if the company takes the adapter path — it verifies and audits what
  the provider reports.
- It will not delete a record protected by a statutory retention floor
  on an erasure request; it explains why, citing the floor.
- It will not act as the company's DPO or company secretary. It carries
  the registers, deadlines and evidence trail; a named human answers to
  the regulator.

---

## Open questions for Kaizen Infinities

- Which registrations does the company hold today — TAN, PF code, ESI
  code, PT (which state(s)), CIN?
- Is turnover above the current e-invoicing threshold (₹5 crore, confirm
  the live figure)?
- Does any offering qualify for the Notification 12/2017 entry 66
  education exemption on a specific read of the notification, and is
  composition status relevant anywhere in the business?
- Is any employee's wage at or below the ESI ceiling (₹21,000/month) or
  PF ceiling (₹15,000/month) — confirm both live figures?
- External payroll provider, or compute in-platform — this decides
  Workstream E's build shape.
- Are any engagements contractor/intern/apprentice rather than employee,
  and is that classification correct?
- Current Internal Committee composition under POSH — external member
  present?
- Is there a paternity-leave policy?
- Any receipts from outside India (FEMA/FIRC)?
- Current directors and registered charges, for statutory-register seed
  data?
- Written refund policy for course fees today?
- Which vendors are Udyam-registered, and what are the agreed payment
  terms with each?
- Has TDS been deducted on vendor and salary payments to date — if not,
  raise this with the company's auditor as a standing exposure,
  independent of when this plan is built.
