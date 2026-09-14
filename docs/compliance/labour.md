# Labour law and conduct

Workstream F of `docs/plan/compliance.md`. What was built, the requirement IDs
and the test that pins each.

---

## What exists now

**Holidays.** `Holiday` (date, name, kind `national|state|restricted`, state),
seeded for the current calendar year with the three fixed national holidays
(26 Jan, 15 Aug, 2 Oct) plus a note that state and restricted holidays are
declared by notification through the year, not fixed in advance. CRUD under
the `holidays` grant.

**Holiday-aware leave counting.** `leave.ts`'s day count for a leave request no
longer counts the calendar span — it calls `leaveWorkingDayCount`, which skips
Sundays and any holiday in range (`workingDayCount` in
`packages/shared/src/compliance/labour.ts`, pure and tested with no database).

**Leave carry-forward, lapse and encashment.** A 1 April job (`0 1 1 4 *`)
walks every `LeaveType` carrying `carryForwardCapDays`. Each balance above the
cap gets a `lapse` `LeaveTransaction` trimming it to the cap; each balance at
or under it gets a zero-amount `carry_forward` transaction, so the ledger
states what happened rather than leaving silence to be read as "nothing to
carry". A `LeaveYearClose` row per `(leaveTypeId, fy)` is the idempotency
guard — a second run in the same financial year finds it and changes nothing
(CMP-LAB-004). `POST /compliance/labour/leave/:employmentId/encash
{leaveTypeId, days}` writes an `encashment` transaction (encashable types
only, at most `maxEncashDays`) and a `LeaveEncashment` row at basic/26 × days,
for payroll to pick up.

**Working hours and overtime.** `WorkingHoursRule` is a dated table (TN Shops
& Establishments Act reading: 8h/day, 48h/week, 12h spread-over, OT at 2×, a
50h/quarter OT cap) with a `confirmed` flag that stays false until somebody
checks it against the live state notification — this plan's own reading of
the Act is not that confirmation. A Monday 02:00 job sums `WorkAttendance` per
employment per ISO week; a total past the weekly cap raises
`CMP_LAB_HOURS_BREACH` (S2), once per employee per week
(`triggerFingerprint: hours_breach:<employmentId>:<isoWeek>`), owned by the
`hr_ops_manager` affiliation resolved by role. Every week with logged overtime
— breach or not — posts an `OvertimeAccrual` row: hours × 2 × basic/(26×8).

**Statutory registers.** `GET /compliance/labour/registers/wages?period`
(from `PayrollInstruction`), `/registers/leave?fy` (from
`LeaveBalance`/`LeaveTransaction`), `/registers/muster-roll?period` (from
`WorkAttendance`), `/registers/employees` (a Form Q-like register — name,
father's name left blank because this platform does not carry it, DOB left
blank likewise, DOJ, designation, engagement type). Each downloads as CSV
under the register's statutory name and each download is itself audited via
`auditExport`.

**POSH.** `InternalCommitteeMember` (personId or externalName, role
`presiding|member|external`, `isWoman`, appointedOn, termEnds).
`POST /compliance/labour/posh/committee/validate` checks the POSH Act Sec
4(2) composition — presiding officer a woman, at least half the active
members women, one external member — and reports what is missing as true
statements about the current roster
(`validateIccComposition` in the shared package). `PoshComplaint`
(complainant/respondent by personId or free text, receivedOn, status
`received|inquiry|report_submitted|closed|withdrawn`, `inquiryDueAt =
receivedOn + 90d`, `reportDueAt = inquiryClosedAt + 10d`, findings, action,
`concealed: true`) is listed only to a holder of `posh_cases:view` and is
never folded into any other listing or count. A daily job raises
`CMP_POSH_INQUIRY_OVERDUE` (S3) for a complaint past `inquiryDueAt` and not
closed or withdrawn (CMP-LAB-001). `GET
/compliance/labour/posh/annual-report/:year` computes counts (received,
disposed, pending, pending past 90 days, workshops held from
`PoshWorkshop`) as a `PoshAnnualReport` snapshot document, `prepared` until
`POST .../file` marks it `filed` — filed is final and is never recomputed
under the same id.

**Disciplinary process.** `DisciplinaryCase` (employmentRelationshipId,
status `show_cause|reply_received|inquiry|decision|closed`,
`showCauseIssuedAt`, `replyDueAt = +7d`, inquiryOfficer, decision, outcome
`warning|suspension|termination|none`). Every step —
opening the case and each `advanceDisciplinaryCase` call — records a
case-scoped evidence row through `performance.ts`'s existing
`recordEvidence`, so the case's paper trail lives in the one place ICC and
disciplinary evidence already lives, need-to-know intact. A `termination`
outcome, once the case closes, calls `employment.ts`'s exported
`transitionEmployment(id, 'TERMINATE_POST_DISCIPLINARY', ...)` directly; if
that transition is not legal from the employment's current state the case
still closes and records why, and says HR must apply the transition by
hand rather than failing silently.

**Letters.** `HrLetter` (kind `offer|appointment|confirmation|relieving|
experience|warning`, employmentRelationshipId or applicationId, number,
snapshot built from a template in `packages/shared/src/compliance/labour.ts`,
issuedAt, issuedById, supersededById) — final once issued, a correction is a
new letter, never an edit of the old one (no update path exists for the
model at all). `hiring.ts`'s `transitionApplication` issues an appointment
letter automatically the moment an application reaches `OfferAccepted`
(CMP-LAB-003), rather than a bare state flip. The `offboarding.completed`
hook issues a relieving letter and an experience letter, records the
relieving letter's id on `Offboarding.relievingLetterDocumentId`, and adds
Form 10C (EPF pension withdrawal) and Form 19 (PF final settlement) to
`Offboarding.checklist`. `GET /compliance/labour/letters/:id/document`
returns the letter.

**Consents.** `POST /compliance/labour/employees/:id/bgv-consent` and
`/code-of-conduct-ack` set `backgroundVerificationConsentAt` and
`codeOfConductAcknowledgedAt` on `EmploymentRelationship`, audited. Gated
through `assertEmploymentVisible('employees', id, 'edit')` — the same
ownership check the rest of §14 uses, so an employee holding the `own`-scoped
grant can only set their own, while HR (an `all`-scoped grant) can set
anybody's.

**Paternity leave.** Seeded from `seed/compliance/labour.ts` (not
`bootstrap.ts`'s `seedLeaveTypes`, which is another domain's file): code
`PL`, 7 days, `statutory: false` — a company policy this platform records,
not a central statutory entitlement the way maternity leave is.

**Web.** `apps/web/src/pages/compliance/Labour.tsx` — seven tabs: Holidays,
Leave year-end (run the close, encash), Hours (run the check, look up
overtime accrual), Registers (four CSV downloads), POSH (committee with live
validation, complaints visible only with the grant, annual report), and
Disciplinary and Letters.

---

## Acceptance

- **CMP-LAB-001** — a POSH complaint's inquiry deadline fires
  `CMP_POSH_INQUIRY_OVERDUE` at 90 days if unclosed, and not for one already
  closed. Pinned by `src/tests/compliance/labour.test.ts` — "CMP-LAB-001".
- **CMP-LAB-002** — weekly hours past the cap raise `CMP_LAB_HOURS_BREACH`
  rather than posting silently, and post an `OvertimeAccrual` row for the
  hours actually logged. Pinned by "CMP-LAB-002".
- **CMP-LAB-003** — an accepted offer generates an appointment letter as a
  final document. Pinned by "CMP-LAB-003".
- **CMP-LAB-004** — leave carry-forward is idempotent against a re-run in the
  same period. Pinned by "CMP-LAB-004".
- Holiday-aware leave counting, POSH committee validation (missing statements
  and the compliant case), letter immutability (a second issue is a new row,
  never an edit), and register CSV shape (header row, one row per record) are
  each their own `it` in the same file.

---

## What this does not do

- It does not file the POSH annual report with the District Officer, or any
  other government portal, on its own — `markPoshAnnualReportFiled` only
  records that a human did.
- It does not compute PF/ESI/gratuity/bonus — that is workstream E; this
  workstream's encashment and overtime figures are handed to payroll, not
  posted to it directly.
- The working-hours rule is seeded `confirmed: false`. It is this plan's own
  reading of the Tamil Nadu Shops and Establishments Act, not a reading
  checked against the live state notification.
- The letter template is a plain-text body, not a PDF or a signed document —
  what "final once issued" means here is that the row and its snapshot never
  change, not that the platform notarises anything.

## What was wanted on `main.prisma` and not added

Nothing — every field this workstream needed
(`LeaveType.carryForwardCapDays/encashable/maxEncashDays`,
`EmploymentRelationship.backgroundVerificationConsentAt/
codeOfConductAcknowledgedAt`, `Offboarding.checklist`/
`relievingLetterDocumentId`, `EmploymentRelationship.engagementType`) was
already there per the brief.
