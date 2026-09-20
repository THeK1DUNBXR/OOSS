# HCM — workstreams

## Workforce

Org chart, directory, employee master and organisational design — employee profiles, regulated document tracking, reporting relationships, cost centres, locations, grades. Extends existing employment with personal details, addresses, education and employment history, and links CRM persons to employees.

See [docs/hcm/workforce.md](workforce.md).

## Time

Shift rosters, timesheets, clock in/out tracking, and overtime and comp-off management. Derives attendance from clock events against assigned rosters; tracks billable hours; manages earned and consumed comp-off.

See [docs/hcm/time.md](time.md).

## Leave Policy

Leave policy engine — defined by grade, location or engagement type, with accrual rules (frequency, days, pro-rata), carry-forward caps, encashment rules, and approval chains. Monthly accrual job updates existing LeaveBalance/LeaveTransaction ledger.

See [docs/hcm/leave-policy.md](leave-policy.md).

## Recruiting

Full applicant tracking system on top of existing Requisition/Application — job postings, candidate profiles, multi-round interviews with scorecards, offer letters with approval gates, referral tracking, background verification, and pre-boarding task checklists.

See [docs/hcm/recruiting.md](recruiting.md).

## Performance

Review cycles with self/manager/peer assessment, calibration sessions, final ratings, continuous feedback, one-on-ones, performance improvement plans, and succession planning with a nine-box grid derived from performance and potential.

See [docs/hcm/performance.md](performance.md).

## Learning

Training programs (classroom, online, certification, mandatory), session enrolments with attendance and scoring, certifications with expiry tracking and verification, mandatory training rules with overdue detection, individual development plans, and training budgets.

See [docs/hcm/learning.md](learning.md).

## Compensation

Pay grades with level-based ranges, salary revision cycles with approval gates (proposer ≠ approver), variable pay plans (bonus, commission, incentive), benefit plans with employee enrolment, employee loans with derived EMI schedules, and expense claims with approval chains and reimbursement routing.

See [docs/hcm/compensation.md](compensation.md).

## Payroll Operations

Payroll operations — pay items, ad-hoc additions, arrears, payroll journals that post to Books, bank advice files, reconciliation with previous runs, payroll calendar with cutoff enforcement, and payslip queries raised by employees.

See [docs/hcm/payroll-ops.md](payroll-ops.md).

## Engagement

Announcements with audience targeting and acknowledgement tracking, recognition/kudos, pulse surveys, HR helpdesk (cases by category with SLA tracking, concealed for grievances), policy documents with acknowledgement, and exit interviews.

See [docs/hcm/engagement.md](engagement.md).

## Separations

Resignation submission and acceptance (acceptedBy ≠ self), notice policies by grade/engagement type, exit clearance tracking across departments, no-dues certificates, and alumni records with rehire eligibility.

See [docs/hcm/separations.md](separations.md).

## Assets

Asset inventory, assignments to employees (issued, returned, condition), travel requests with approval, and letter requests (salary certificate, visa, etc.) that issue via compliance labour's letter flow.

See [docs/hcm/assets.md](assets.md).

## Analytics

HR analytics — headcount trend, joiners/leavers, attrition rate, absenteeism, leave liability, overtime, time-to-hire, offer acceptance rate, gender/tenure distribution, payroll cost trend, training volume, engagement eNPS, and open HR cases by SLA. Metric endpoints return "not measured" when insufficient input.

See [docs/hcm/analytics.md](analytics.md).

## Workflow

Generic HR request and approval engine — request types with multi-level approval chains (by role, HR grant, finance grant, or specific person), requests with payload JSON, approval decisions, delegation of authority. Exposed as `submitRequest()`, `decide()`, `listInbox()` for use by other workstreams via IDs only.

See [docs/hcm/workflow.md](workflow.md).

---

## How the pieces connect

**Workforce reporting lines** feed **Workflow** approval chains — manager-level approvals route through the management chain if a manager approver is defined.

**Time** (clock events and rosters) feed **Payroll Operations** — derived attendance and overtime accrual are inputs to the pay run.

**Leave Policy** accrual jobs update the existing **LeaveBalance/LeaveTransaction** ledger, so employees hold a running leave balance they can see in `Me > Leave`.

**Recruiting** hands off accepted offers to **Workforce** — the new hire enters the employment lifecycle and triggers **Onboarding** tasks.

**Performance** ratings and comp recommendations feed **Compensation** salary revision cycles.

**Separations** (accepted resignations) gate the existing full-and-final settlement — F&F cannot complete until exit clearance is done.

**Analytics** reads every table above and **never writes** — it is a read-only aggregation of the existing system's state.

**Workflow** is used by **Compensation** (salary revision approval), **Recruiting** (offer approval), **Separations** (resignation acceptance), **Assets** (travel approval), and any other workstream needing multi-level approval on structured data via IDs.
