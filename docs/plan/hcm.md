# HCM — plan

What it would take for Kaizen Infinities to build a complete Human Capital Management platform on KaiERP, from employee master and organisational design through compensation, payroll and separation, using the platform's own structural disciplines: authority separated, documents final once issued, everything audited, deadlines run as jobs rather than remembered by a person.

This is a plan, not a build. It says what exists, what principles the HCM work extends from the platform's own rules, what thirteen workstreams would build, in what order, and the surface model — both for HR operations and for the employee (the "Me" group).

---

## Where the platform stands

The platform carries the infrastructure for HR lifecycle state machines, leave ledgers and compliance records. It carries almost nothing for workforce design, time tracking, performance review cycles, recruitment from pipeline to offer, or the operational surfaces staff and managers use day to day.

What exists under `/api/hr`:

- **HR lifecycle.** Eleven state machines in `packages/shared/src/hr.ts` — Employment with thirteen states from Offer to Alumni, Leave with its balance ledger, Onboarding, PayrollRun, PerformanceReview, Skill capability evidence, Requisition and Application, Goal, Offboarding with a state machine for the exit process and full-and-final settlement. Routes under `/api/hr` in `hr.routes.ts`, with tests in `hr.test.ts` and `hrLifecycle.test.ts`.
- **Leave, payroll, hiring as data models.** LeaveType, LeaveBalance, LeaveTransaction (a ledger of accrual/use/carry/encash), LeaveRequest, LeaveApproval. PayrollRun, PayrollInstruction (gross, deduction, net). Requisition, Application, OfferLetter. All seeded through the company's own employment data.
- **Compliance domain.** Labour law (Holiday, LeaveYearClose, LeaveEncashment, WorkingHoursRule, OvertimeAccrual, POSH, DisciplinaryCase, HrLetter), payroll statutory (rate tables, SalaryStructure, Payslip, GratuityAccrual, F&F settle), tax (TaxDeclaration, TDS). Routes under `/api/compliance/{labour,payroll,tax}`.
- **Web surfaces.** `PeopleOps.tsx` listing Employees, with tabs for EmployeeDetail, Leave, Attendance, Payroll, Hiring, Skills, and compliance pages.
- **Platform.** Tenant gate, five-axis permissions with a Self-Dealing Bar on approvals, event bus emitting `kz.<domain>.<entity>.<verb>`, audit trail, exception handling, record codes via `nextRecordCode`, jobs scheduler, roles and grants.

The gap has a consistent shape: the platform has built the *state machines and ledgers* — how people move through their employment, how leave accrues and is spent — and has not surfaced the *work* people and managers do day to day — designing teams, rosters, timesheets, reviews, compensation change, severance, recruitment pipelines, communication. Most of what follows is new domain modules wired onto existing machinery.

---

## Principles for HCM work

These extend rules the platform already enforces elsewhere.

1. **Authority is separated structurally.** The proposer of a salary change, a promotion, an offer or a resignation cannot also approve it — enforced by the Self-Dealing Bar on every such decision, never by a norm someone could override.
2. **Every state change emits an event.** A timesheet submitted, a review cycle closed, an expense approved, a resignation accepted — each fires an event `kz.hr.<entity>.<verb>` so watchers can wire up consequent work without polling or hand-offs.
3. **What is withheld is held as null with a reason, never as zero.** Regulated data (PAN, Aadhaar, bank account numbers) is structurally excluded from responses unless the grant allows. Money fields the viewer does not see are present as masked — `null` with a named reason — so they know something is there.
4. **Record codes are generator-assigned, never caller-supplied.** A timesheet, an offer, a review, an expense claim — each gets a unique identifier from the system, never from the user. Documents (letters, payslips) are final once issued; correction is a new row.
5. **Every new model goes into its own schema file.** `apps/api/prisma/schema/hcm-<workstream>.prisma`, never edits to `main.prisma`. References to existing models are plain `*Id String` columns with `tenantId` and an index, exactly as the compliance schema files do.
6. **A job runs the deadline.** Leave accrual on 1 April. Comp-off expiry. Certification warnings at 90/30/7 days. Every recurrence with a due date is a keyed, idempotent ladder job, firing at the tightest crossed rung, not a memory.
7. **Regulated fields are excluded, not just masked.** PAN, Aadhaar, bank account, any identifier held under a statute — absent from the response shape entirely to all but holders of the specific grant. Absence is the guarantee.

---

## Workstreams

### WS1 — Workforce

Employee master extensions and organisational design.

**Models:** EmployeeProfileExtension (personal: DOB, gender, marital, blood group, nationality, PAN/Aadhaar masked, passport, emergency contacts, addresses, education history, previous employment, dependants); EmployeeDocument (kind: id_proof/address_proof/education/offer/contract/other; file; verified; expiry); ReportingLine (managerId, kind primary/dotted, effectiveFrom/To); CostCentre + assignment; Location (offices, state for tax); Grade + Band (code, level, pay range); EmployeeStatusChange log (transfer/promotion/demotion/redesignation with approval); cross-link CRM person ↔ employee.

**Endpoints:** `/api/hcm/workforce/org-chart` (tree), `/directory` (search with filters), `/360/:id` (aggregated employee detail + profile + reporting + history), `/transfers` (with approval), `/documents` (upload).

**Screens:** /people/org-chart, /people/directory, /people/employees/:id/360 (new page), /people/profiles, /people/org-structure.

**Jobs:** Reporting-line effective-date transitions.

**Requirement IDs:** HCM-WS1-NNN.

---

### WS2 — Time

Shifts, rosters, timesheets, clock in/out, overtime and comp-off.

**Models:** Shift (name, start, end, grace, break, night flag); WorkSchedule/RosterAssignment (employmentId, shiftId, dates/pattern); ClockEvent (in/out, source web/mobile/biometric, IP, geo optional); Timesheet (week, draft/submitted/approved/rejected); TimesheetEntry (date, projectId optional, task, hours, billable); OvertimeRequest; CompOff (earned/expiry/consumed); AttendanceRegularisation.

**Endpoints:** `/api/hcm/time/shifts`, `/rosters`, `/clock`, `/timesheets`, `/overtime`, `/comp-off`, `/regularisations`.

**Screens:** /people/time (tabs: Shifts, Roster, Clock, Timesheets, Overtime, Comp-off, Regularisations), /me/attendance (clock in/out button, my week).

**Jobs:** Nightly WorkAttendance derivation from ClockEvents against roster; comp-off expiry.

**Requirement IDs:** HCM-WS2-NNN.

---

### WS3 — Leave Policy

Leave policy engine.

**Models:** LeavePolicy (name, applicability: grade/location/engagementType, effectiveFrom); LeavePolicyRule (leaveTypeId, accrual frequency, days, proration, max balance, carry-forward cap, negative allowed, notice days, max consecutive, sandwich rule, document requirement, applicable gender); AccrualRun (idempotent per policy/period); LeaveApprovalChain (levels: manager, HR, custom grant).

**Endpoints:** `/api/hcm/leave-policy/policies`, `/rules`, `/accrual-runs`, `/approval-chains`.

**Screens:** /people/leave-policies (policies, rules, run accrual, chains), /people/leave-calendar (team calendar month grid), /me/leave (balances, apply, history).

**Jobs:** Monthly accrual into LeaveBalance/LeaveTransaction via existing leave.ts helpers.

**Requirement IDs:** HCM-WS3-NNN.

---

### WS4 — Recruiting

Full ATS on top of Requisition/Application.

**Models:** JobPosting (requisitionId, title, description, channel internal/external/referral, publishedAt, closesAt, slug); CandidateProfile (personId, source, resumeText, currentCtc/expectedCtc masked, noticeDays); InterviewRound (applicationId, round, kind phone/technical/hr/panel, scheduledAt, interviewers[], status); InterviewScorecard (roundId, interviewerId, competency scores, recommendation, notes); OfferLetter (applicationId, ctc, joiningDate, validUntil, status draft/pending/approved/sent/accepted/declined; proposer ≠ approver); Referral (referrerEmploymentId, candidatePersonId, bonus); BackgroundVerification; PreboardingTask/OnboardingTask.

**Endpoints:** `/api/hcm/recruiting/postings`, `/candidates`, `/interviews`, `/scorecards`, `/offers`, `/referrals`, `/bgv`, `/onboarding-tasks`.

**Screens:** /people/recruiting (tabs: Postings, Candidates, Interviews, Offers, Referrals, BGV, Onboarding tasks), candidate pipeline kanban.

**Jobs:** None; driven by user action.

**Requirement IDs:** HCM-WS4-NNN.

---

### WS5 — Performance

Review cycles and talent.

**Models:** ReviewCycle (name, period, kind annual/half/quarter/probation, phases self→manager→calibration→closed); ReviewTemplate (sections/competencies JSON, weights); ReviewAssignment (cycleId, employmentId, reviewerEmploymentId, kind self/manager/peer/upward/skip); ReviewResponse (ratings, comments, submittedAt); CalibrationSession (cycleId, participants, decisions); FinalRating (cycleId, employmentId, rating, band, promotion/increment recommended); Feedback (continuous, from/to, kind praise/constructive); OneOnOne (manager/report, scheduledAt, agenda); Pip (employmentId, start/end, objectives, checkpoints); SuccessionPlan (positionId, successors with readiness); NineBox (derived).

**Endpoints:** `/api/hcm/performance/cycles`, `/templates`, `/assignments`, `/responses`, `/calibration`, `/feedback`, `/one-on-ones`, `/pips`, `/succession`.

**Screens:** /people/performance (Cycles, Calibration, 9-box, Feedback, 1:1s, PIPs, Succession), /me/performance (my reviews, give feedback).

**Jobs:** None; driven by cycle schedules.

**Requirement IDs:** HCM-WS5-NNN.

---

### WS6 — Learning

L&D for staff.

**Models:** TrainingProgram (title, kind classroom/online/certification/mandatory, provider, durationHours, cost, skillIds[], validityMonths); TrainingSession (programId, start/end, trainer, seats, location/link); TrainingEnrollment (sessionId, employmentId, status nominated/approved/attended/completed/no_show, score, feedback); Certification (employmentId, name, issuer, issuedOn, expiresOn, documentRef, verified); MandatoryTrainingRule; IndividualDevelopmentPlan; TrainingBudget.

**Endpoints:** `/api/hcm/learning/programs`, `/sessions`, `/enrollments`, `/certifications`, `/mandatory-training`, `/idps`, `/budget`.

**Screens:** /people/learning (Programs, Sessions, Enrollments, Certifications, Mandatory, IDPs, Budget), /me/learning.

**Jobs:** Certification expiry ladders (90/30/7 days); mandatory training overdue.

**Requirement IDs:** HCM-WS6-NNN.

---

### WS7 — Compensation

Compensation and benefits.

**Models:** PayGrade (code, level, min/mid/max, currency); SalaryRevisionCycle (name, effectiveDate, budget%, status draft/proposed/approved/applied); SalaryRevisionLine (cycleId, employmentId, currentCtc, proposed%, proposedCtc, rating link, approvedCtc; proposer ≠ approver); VariablePayPlan (name, kind bonus/commission/incentive, formula); VariablePayout (planId, employmentId, period); BenefitPlan (kind health/life/accident/meal/fuel/nps, provider); BenefitEnrollment (planId, employmentId, dependants); EmployeeLoan (principal, interest%, tenure, EMI, status; schedule derived); ExpenseClaim (employmentId, category travel/food/phone/other, receipts, status submitted/approved/rejected/reimbursed; approval chain).

**Endpoints:** `/api/hcm/compensation/grades`, `/revision-cycles`, `/variable-pay`, `/benefits`, `/loans`, `/expenses`.

**Screens:** /people/compensation (Grades, Revision cycles, Variable pay, Benefits, Loans, Expenses), /me/money (my expenses, loans, benefits).

**Jobs:** None; applied manually or via payroll handoff.

**Requirement IDs:** HCM-WS7-NNN.

---

### WS8 — Payroll Operations

Payroll operations.

**Models:** PayItem (code, name, kind earning/deduction/reimbursement/employer_contribution, taxable, statutory basis flags); AdHocPayLine (employmentId, payItemId, amount, period, reason, approved); Arrear (employmentId, fromPeriod, amount, reason, status); PayrollJournal (runId, lines [{ledgerAccountCode, debit, credit, costCentre}], postedAt; posts to Books via existing books.ts Transaction if exported, else prepared status); BankAdvice (runId, format NEFT CSV, generatedAt); PayrollReconciliation (runId, previousRunId, deltas, unexplained flags); PayrollCalendar (period, cutoffs: attendance lock, freeze, run, approve, pay date); PayrollQuery (employee raises query on a payslip).

**Endpoints:** `/api/hcm/payroll-ops/calendar`, `/pay-items`, `/adhoc`, `/arrears`, `/reconciliation`, `/journal`, `/bank-advice`, `/queries`.

**Screens:** /people/payroll-ops (Calendar, Pay items, Ad-hoc, Arrears, Reconciliation, Journal, Bank advice, Queries), /me/payslips (list + view + raise query).

**Jobs:** Payroll calendar cutoff enforcement; month-end payroll cut-off notifications.

**Requirement IDs:** HCM-WS8-NNN.

---

### WS9 — Engagement

Engagement, communications and HR helpdesk.

**Models:** Announcement (title, body, audience all/division/orgUnit/location, publishAt, expiresAt, pinned, acknowledgementRequired, acks); Recognition (from, to, badge, message, points, public); PulseSurvey (title, questions JSON, anonymous, opens/closes, audience); SurveyResponse (anonymous hashed token or employmentId); HrCase (helpdesk: category payroll/leave/policy/it/grievance/other, priority, status open/in_progress/waiting/resolved/closed, SLA due, messages, confidential flag); PolicyDocument (title, version, body, effectiveFrom, acknowledgementRequired); PolicyAcknowledgement; ExitInterview (offboarding, questionnaire, conductedBy).

**Endpoints:** `/api/hcm/engagement/announcements`, `/recognition`, `/surveys`, `/hr-cases`, `/policies`, `/exit-interviews`.

**Screens:** /people/engagement (Announcements, Recognition, Surveys, Helpdesk queue, Policies), /me/home (my announcements, kudos, open cases, pending acks, surveys, requests inbox).

**Jobs:** HrCase SLA breach exception.

**Requirement IDs:** HCM-WS9-NNN.

---

### WS10 — Separations

Separations and exit management.

**Models:** Resignation (employmentId, submittedOn, requestedLastDay, noticeDays, reason, status submitted/accepted/withdrawn/rejected; acceptedBy ≠ self); NoticePolicy (by grade/engagementType: noticeDays, buyoutAllowed); ExitClearance (offboarding, departments [{dept it/finance/admin/manager/hr, status pending/cleared/blocked, clearedBy}], allCleared derived); NoDuesCertificate (final doc, snapshot); AlumniRecord (personId, lastDesignation, exitDate, rehireEligible, contact consent).

**Endpoints:** `/api/hcm/separations/resignations`, `/clearances`, `/no-dues`, `/alumni`, `/notice-policies`.

**Screens:** /people/separations (Resignations, Clearances, No-dues, Alumni, Notice policies), /me/exit (submit resignation, my clearance status).

**Jobs:** Accepted resignation triggers employment transition; F&F gated on clearance complete.

**Requirement IDs:** HCM-WS10-NNN.

---

### WS11 — Assets

Assets, travel and letters.

**Models:** Asset (tag, category laptop/phone/access_card/other, serial, purchaseDate, status in_stock/assigned/repair/retired); AssetAssignment (assetId, employmentId, issuedOn, returnedOn, condition); TravelRequest (employmentId, purpose, from/to, dates, mode, estimatedCost, advanceRequested, status; approver ≠ self); LetterRequest (employmentId, kind address_proof/salary_certificate/noc/visa/experience, status).

**Endpoints:** `/api/hcm/assets/inventory`, `/assignments`, `/travel`, `/letter-requests`.

**Screens:** /people/assets (Inventory, Assignments, Travel, Letter requests), /me/requests (assets I hold, travel, letter requests).

**Jobs:** None; driven by user action.

**Requirement IDs:** HCM-WS11-NNN.

---

### WS12 — Analytics

HR analytics and reporting.

**Metrics:** Headcount trend by month/division/location; joiners/leavers; attrition % annualised; early attrition; absenteeism %; leave liability (balances × daily rate, masked); overtime hours; time-to-hire; offer acceptance; cost per hire; span of control; gender ratio; tenure distribution; payroll cost trend; comp ratio distribution; training hours per head; engagement eNPS; open cases by SLA.

**Exports:** Headcount register, attrition report, leave liability, overtime (CSV via auditExport).

**Endpoints:** `/api/hcm/analytics/metrics`, `/exports`.

**Screens:** /people/analytics (KPI tiles with drill paths, simple SVG charts, tables), Reports tab.

**Jobs:** None; computed on read.

**Requirement IDs:** HCM-WS12-NNN.

---

### WS13 — Workflow

Generic HR request and approval engine used by other workstreams.

**Models:** HrRequestType (code, name, approval chain JSON [{level, resolver manager|hr_grant|finance_grant|specific}], slaHours); HrRequest (type, subjectEmploymentId, payload JSON, status, currentLevel, requestedById); HrRequestApproval (level, approverPartyId, decision, note, decidedAt); DelegationOfAuthority (from, to, from/to dates, scope).

**Endpoints:** `/api/hcm/workflow/request-types`, `/requests`, `/approvals`, `/delegations`, `submitRequest()`, `decide()`, `listInbox(forParty)`.

**Screens:** /people/approvals (inbox of everything pending for me, with decide), `RequestInbox` component for reuse.

**Jobs:** None; SLA fired via HrRequestType.

**Requirement IDs:** HCM-WS13-NNN.

---

## Surface model

### People group (HR operations)

Org chart, directory, time tracking, leave management, recruitment, performance, learning, compensation, payroll, engagement, separations, assets and requests, analytics, and approval inbox — accessed by the HR operations head who runs employment, and the finance head who approves compensation and payroll.

### Me group (self-service)

My home, leave, attendance, payslips, performance, learning, money, requests and exit — accessed by each employee to see and act on their own data. An employee holds grants at `own` scope, so they see only their own records; the HR ops and finance heads hold grants at `all` scope and see everything.

---

## What HCM never does

- It never posts directly to the ledger except via the payroll journal handoff. Payroll operations produces a journal that Books ingests; no other HCM surface writes to accounts.
- It never files anything with a government portal, submits to a tax return service, or transmits a form without a human recording that it was done. Offers, letters, forms — all prepared and exported; filing is recorded against a portal's ARN or receipt number, never invented.
- It never approves its own records. The Self-Dealing Bar holds: a proposer of a salary change, a promotion, an offer or a resignation cannot also approve it.
- It never holds a person's regulated identifiers in the response. PAN, Aadhaar, bank account, ESIC number — structurally absent from the shape unless the grant allows, and then masked in every non-admin view.

---

## As built

| Workstream | Doc | Test file | Status |
|---|---|---|---|
| WS1 Workforce | docs/hcm/workforce.md | src/tests/hcm/workforce.test.ts | See doc |
| WS2 Time | docs/hcm/time.md | src/tests/hcm/time.test.ts | See doc |
| WS3 Leave Policy | docs/hcm/leave-policy.md | src/tests/hcm/leave-policy.test.ts | See doc |
| WS4 Recruiting | docs/hcm/recruiting.md | src/tests/hcm/recruiting.test.ts | See doc |
| WS5 Performance | docs/hcm/performance.md | src/tests/hcm/performance.test.ts | See doc |
| WS6 Learning | docs/hcm/learning.md | src/tests/hcm/learning.test.ts | See doc |
| WS7 Compensation | docs/hcm/compensation.md | src/tests/hcm/compensation.test.ts | See doc |
| WS8 Payroll Ops | docs/hcm/payroll-ops.md | src/tests/hcm/payroll-ops.test.ts | See doc |
| WS9 Engagement | docs/hcm/engagement.md | src/tests/hcm/engagement.test.ts | See doc |
| WS10 Separations | docs/hcm/separations.md | src/tests/hcm/separations.test.ts | See doc |
| WS11 Assets | docs/hcm/assets.md | src/tests/hcm/assets.test.ts | See doc |
| WS12 Analytics | docs/hcm/analytics.md | src/tests/hcm/analytics.test.ts | See doc |
| WS13 Workflow | docs/hcm/workflow.md | src/tests/hcm/workflow.test.ts | See doc |
