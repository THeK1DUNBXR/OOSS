## Summary (under 150 words)

Pages p45-p52, checked against the repo at file:line. Status counts over 119 capability rows: EXISTS 1, PARTIAL 55, FIX 16, MISSING 40, INTERCONNECT 4, PLANNED 2, UNVERIFIED 1. Not written to the findings .md file because the agent rules bar report files; this handback is the full report.

Top 3 findings:
1. Decisions are routed to the Chairman by default (`decisions.ts:62`), the queue hides `Delegated` items (`decisions.ts:169`), and the evidence pack can deadlock: the first decision of any subject type has no precedents, and no endpoint can add missing components, so it is never decidable.
2. Visibility and authority gaps: `decisionQueue` and `attentionQueue` are unscoped, `GET /command` is gated only on `health_scores:view`, and `decideApprovalStep` has no `assertCan`. Escalation climbs only one rung (`scheduler.ts:321-323`).
3. Customer complaints have no model. The only complaint path is the learner exception, which drops a second complaint and never resolves when its log is resolved.

---

# Decisions, approvals, exceptions and lifecycles (p45-p52)

## Pages covered
- p45 Decision ledger and role-based visibility
- p46 Approvals, delegation and independent review
- p47 Exceptions and escalation command centre
- p48 A day of remote founder oversight
- p49 Lifecycle, lead to cash and complaint resolution
- p50 Lifecycle, hiring to exit with open cases
- p51 Lifecycle, college agreement to collected payment
- p52 Institution fee and margin calculator (p52 was included in scope; the margin calculator is the only item on it)

Plan cross-check: `docs/plan/ceo-office.md` (Chairman's Office, Phases 0-10, planned 14 Sep 2026). Phase 0 is stubs only: every `domains/ceo/*.detectors.ts` exports an empty array (for example `domains/ceo/doa.detectors.ts:10`), and `routes/ceo/doa.routes.ts:1-41` returns `{items: []}` for every GET with no permission check. `web/src/pages/ceo/Approvals.tsx` and `Doa.tsx` are 17-line "not built yet" pages. Phase 5 (DoA, approvals inbox) is PLANNED at `ceo-office.md:442-462` and `:1106-1170`. No plan file mentions a customer complaint, mandate, purchase order, milestone/acceptance, margin calculator or break-glass.

Code facts that matter across the table:
- Role register: only 7 seeded role slugs (`packages/shared/src/permissions.ts:299-311`: chairman, finance_head, hr_ops_manager, employee, shareholder, director, company_secretary). No unit head, trainer, collection owner, sales or delivery head, auditor, or institution role. Trainer scoping exists only as the `batch_member` resolver (`platform/permissions.ts:278-280`).
- Approval ladder is fixed to `['finance_head','chairman']` (`packages/shared/src/permissions.ts:316`).
- Governed audit registry includes `decision` and `delegation` (`platform/audit.ts:88`) but not `approval_step` or `exception_record`.

## Capability table

Status key: EXISTS, PARTIAL, FIX (existing code wrong or unsafe), MISSING, INTERCONNECT, PLANNED, UNVERIFIED.

| # | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| 1 | Decision record fields: owner, type, urgency, cost of delay, options, evidence versions, consulted, conflicts, conditions, execution tasks, learned-at | 45 | PARTIAL | `prisma/schema/main.prisma:852-903` (Decision: recordCode, question, subject, authorityBasis, requiredAuthorityValue, evidencePack Json, chosenOption, rationale, reviewDueOn, outcomeAssessment, raisedAt) | Missing owner, decisionType, urgency, cost-of-delay (only pointOfNoReturn), consulted, conflicts, conditions, learnedAt | M |
| 2 | Lifecycle Raised, Framed, Analysing, AwaitingAuthority, Deferred, Decided, Implemented, Reviewed, Reversed | 45 | FIX | `packages/shared/src/domain.ts:761-772`; `domains/decisions.ts:262` writes `Implemented` directly on decide; `Decided` is listed but never written; `Framed` and `Reversed` absent; `Delegated` and `EvidenceRequested` exist in code but not plan | Reconcile state list with plan (or amend plan); route all transitions through `platform/lifecycle.ts` (see Fixes) | S |
| 3 | Execution state (not started, executing, blocked, complete) and execution tasks | 45 | MISSING | No field in `main.prisma:852-903`; `disposeDecision` creates no Task (`decisions.ts:262-285`); `Task` model at `main.prisma:2046` unlinked | Add execution sub-record with `decisionId` FK, link to Task | M |
| 4 | Defer: date, reason, consequence of delay; refuse if past point of no return | 45 | PARTIAL | Date, reason and point-of-no-return refusal exist (`decisions.ts` defer branch ~325-337) | Consequence-of-delay field missing | S |
| 5 | Deliberate no-action: risk accepted, owner, monitoring condition, review date; unclicked approval is not acceptance | 45 | PARTIAL | `decisions.ts:113-117` noActionOption; default `by: 'indefinitely'` at `decisions.ts:~117` | No risk-acceptance record; a `decide` with "Take no action" is indistinguishable from any other choice | S |
| 6 | Revision reopens a decision via linked revision; prior preserved | 45 | MISSING | No `revisionOfId`/supersedes on Decision (`main.prisma:852-903`); no route | Add self-FK; never mutate prior decision | M |
| 7 | Cancel decision accounts for commitments already made | 45 | MISSING | `DECISION_DISPOSITIONS` (`domain.ts:774`) has no cancel | Add disposition plus commitments list | S |
| 8 | Role-based decision visibility by audience (founder, unit head, employee, specialist, customer, auditor) | 45 | MISSING | `decisions.ts:163-207` unscoped; no `scopeWhere` use; `command.routes.ts:128-133` checks only `decisions:view`; 7-role register (`shared/permissions.ts:299-311`) cannot express unit head, auditor, customer | Role model extension plus `scopeWhere` on decisionQueue; plan visibility table is not implementable with current roles | L |
| 9 | Restricted detail distinct from concealed (no inference from counts, search, errors) | 45 | MISSING | `commandCenter.ts:244-300` returns `detail` and `subjectLabel` to every caller; counts in `commandCenter.ts:206-221` unscoped | Visibility tiers per field; counts scoped | M |
| 10 | Evidence pinned to document/record versions; flag stale or corrected data | 45 | MISSING | `decisions.ts:90-95` snapshots last five transitions only; no version or hash in evidencePack | Store source versions in pack; staleness check at queue render | M |
| 11 | Founder access to sensitive matters tied to declared purpose and independent review | 45 | MISSING | `platform/permissions.ts:131` evaluate has no purpose axis | Purpose-of-access record plus reviewer | M |
| 12 | Scenario planning (base/downside/growth), capex, variance, approval versions | 45 | PLANNED | `docs/plan/ceo-office.md:510` (Phase 8, FinancialPlan); no code (`domains/ceo/*` stubs) | Phase 8 | L |
| 13 | Calendars, recurring obligations, SOP checklists, workload, exception queues derived from records | 45 | PARTIAL | `ComplianceObligation` `compliance-calendar.prisma:70`; `OnboardingTaskTemplate` `hcm-recruiting.prisma:203`; exception queue `commandCenter.ts:244`; no workload view | Workload view; SOP checklist generic model | M |
| 14 | Decision calibration (confidence before outcome) | 45 | FIX | `decisions.ts` calibration function (MAP: 402-425); route `command.routes.ts:206` has no `assertCan`; "realised" counts `as_expected` OR `within` (lenient); sample capped at 50 most recent | Permission check; single realised test; document sample size | S |
| 15 | Seven-component evidence pack, decidable only when complete | 45 | FIX | `domain.ts:778-786` lists seven; completeness checks three (`decisions.ts:153-156`); no endpoint to supply missing components; first decision on a new `subjectType` has no precedents, so it can never reach `Decided` | Check all seven; allow pack update before decision; precedents optional with explicit "no precedent" component. Test: new subject type plus rejectedOptions must become decidable | S |
| 16 | Nearest precedents paired with their lessons | 45 | FIX | `decisions.ts:131` `lesson: lessons[i]?.body` pairs by position across all tenant lessons, not by `sourceId` | Join lesson on `sourceType='decision'`, `sourceId=precedent.id` | S |
| 17 | Review closes loop only with lesson and resolved change commitment | 45 | FIX | `decisions.ts:366-398`; `changeCommitmentResolved: true` hard-set at `decisions.ts:393` regardless of commitment status; no `assertCan` (`command.routes.ts:194-203`); no audit | Commitment becomes its own record; resolved only when executed | S |
| 18 | Dispositions are human-only | 45 | EXISTS | Agent guard `decisions.ts:221-229`; `assertCan decisions:approve` `decisions.ts:231` | None | S |
| 19 | Raising a decision: permission and routing | 45 | PARTIAL | Route `command.routes.ts:136-160` checks `decisions:create`; `raiseDecision` (`decisions.ts:42`) checks nothing itself; `routedToRole` defaults to `'chairman'` (`decisions.ts:62`) | Routing by policy, not default | S |
| 20 | Decision audit trail | 45 | FIX | `decision` is governed (`audit.ts:88`) but `decisions.ts` contains zero `auditWrite` calls; same for `platform/approvals.ts` and `platform/exceptions.ts` | Add `auditWrite` before `emit` in every write (CLAUDE rule 5) | S |
| 21 | Decision events consumed (notification, projection) | 45 | INTERCONNECT | `kz.gov.decision.*` emitted (`decisions.ts` raise, decided, delegated, deferred, evidence_requested); `events/handlers.ts` subscribes to 4 events, none governance | Subscriber for decided/deferred/delegated | M |
| 22 | Decision links to execution task and to approval steps | 45 | INTERCONNECT | Decision (`main.prisma:852`) has no FK to Task (`main.prisma:2046`) or ApprovalStep (`main.prisma:810`) | Add FKs; a decision that needs an approval gate must create an ApprovalStep | M |
| 23 | Approval routing by action, amount, risk, entity, business unit, policy version (not title) | 46 | PARTIAL | Tier by value and strategic flag `platform/approvals.ts:152-170`, `tierForValue` `:286`; policyVersion stored in step `:199-213`; action stored but not used for routing | Add action/risk/entity axes to policy content | M |
| 24 | Thresholds and alternates defined before enforcement (DoA matrix) | 46 | PLANNED | `ceo-office.md:442-462, 1106-1170`; `routes/ceo/doa.routes.ts:1-41` stub | Phase 5; do not hardcode thresholds; statutory-style values are not invented here | L |
| 25 | Routine actions within approved budget delegable | 46 | PARTIAL | `AuthorityGrant` per principal per class (`main.prisma:779-808`); no budget link; `resolveAuthorityCeiling` `platform/permissions.ts:295-311` | Budget linkage | M |
| 26 | Vendor or beneficiary change: maintainer and verifier differ; verify via known contact | 46 | MISSING | `ItVendor` (`it-vendors.prisma:18`) has no bank fields; no bank-change model anywhere (grep none) | New `BeneficiaryChange` record with two-person rule and verification evidence | M |
| 27 | Payment or refund: preparer and releaser differ; beneficiary and obligation checked | 46 | FIX | Requester cannot approve: `domains/compliance/corporate/refunds.ts:80-82`; `payRefund` `refunds.ts:98-125` checks only `refunds:edit`, no releaser-differs check; `accountId` is a free input (`refunds.ts:98-113`), not bound to the receipt or invoice | Payer must differ from approver; bind beneficiary to receipt | S |
| 28 | Journal or period reopen: independent review | 46 | PARTIAL | `domains/compliance/books.ts:115-128` refuses accounting-period self-approval; reopen path not checked (UNVERIFIED) | Confirm reopen goes through this | S |
| 29 | Compensation or own expense: subject cannot approve own benefit | 46 | PARTIAL | Salary structure proposer != approver `domains/compliance/payroll.ts:332-334`; `ExpenseClaim` (`hcm-compensation.prisma:237`) approval self-check UNVERIFIED | Confirm for expenses | S |
| 30 | Capability or credential verification: claimant cannot verify own claim | 46 | PARTIAL | `verifiedById` set `domains/hcm/workforce.ts:229`, `domains/hcm/learning.ts:561`; no self-verify check seen | Add check | S |
| 31 | Access grant: data owner approves sensitive reach; administrator implements | 46 | MISSING | `Grant` model (`main.prisma`, after `PolicyVersion`) has no approval step; `platform/grantSync.ts` syncs without owner approval | Data-owner approval record | M |
| 32 | Material policy exception with authority, expiry and owner | 46 | MISSING | `Policy`/`PolicyVersion` (`main.prisma:698-737`) have effectiveTo only; no exception object | Exception record with expiry, owner, authority ref | M |
| 33 | Founder related-party transaction: independent reviewer | 46 | MISSING | Self-dealing only for equity transactions `domains/equity.ts:746`; no related-party register | Register plus independent reviewer; reviewer identity is a decision for leadership | M |
| 34 | Delegation record: principal, delegate, actions, scope, limits, dates, absence trigger, exclusions, revocation | 46 | PARTIAL | HR: `DelegationOfAuthority` (`hcm-workflow.prisma:109-124`) has from/to/dates/scope/revokedAt, consulted by resolver `domains/hcm/workflow.ts:~116-127`. Decision: `Delegation` (`main.prisma:905-924`) has no limits, no absence trigger | Unify into one model; add limits and exclusions | M |
| 35 | Delegation expires automatically | 46 | FIX | No job writes `'expired'` for `Delegation` (only IT vendor jobs do); decision delegation state `'active'` never changes; `decisions.ts:~295-315` writes delegation and nothing reads it. `permissions.ts` never consults any delegation | Expiry job; wire into authority resolution or retire | S |
| 36 | Absent approver's queue moves to authorised alternate; no silent elevation | 46 | PARTIAL | HR resolver uses DoA (`workflow.ts:~100-127`). ApprovalStep resolver ignores absence: `platform/approvals.ts:295-305` picks earliest active affiliation with the role | Use DoA in approval resolver | M |
| 37 | Decisions beyond every grant escalate, showing consequence of delay | 46 | PARTIAL | Escalation exists for approval steps (`platform/approvals.ts:216-232`); consequence text absent | Add consequence to step | S |
| 38 | Approval clocks, stalled evidence, reassignment history visible | 46 | PARTIAL | `ApprovalStep` `slaDueAt`, `escalatedAt`, `escalationRung` (`main.prisma:810-850`); approvals list `commercial.routes.ts` (GET list ~:490); no reassignment history table | History table | S |
| 39 | Reminder escalation reaches backup and responsible position before founder | 46 | MISSING | No backup field on ApprovalStep (`main.prisma:810-850`) or ExceptionRecord (`main.prisma:3697-3742`); ladder hard-coded `scheduler.ts:331,345` | Backup and position per policy | M |
| 40 | 24-hour absence test (founder not sole actor for ordinary work) | 46 | FIX | `decisions.ts:62` default routes to chairman; `APPROVAL_LADDER` (`shared/permissions.ts:316`) is finance_head then chairman; decision route is `decisions:approve` (`decisions.ts:231`) | Remove chairman default; per-class alternates | M |
| 41 | Break-glass: narrow time-limited intervention, reason, alerts, after-action review | 46 | MISSING | No break-glass code (grep none); only ITSM "emergency change" in `seed/bootstrap.ts:491` | New policy and record; must not bypass separation or legal requirements | M |
| 42 | Approval pins version, terms, amount, beneficiary; change invalidates | 46 | FIX | ApprovalStep stores policyVersion, requestedValue, currency (`main.prisma:810-850`) but no subject version or hash; no invalidation on subject edit (UNVERIFIED on edit paths) | Pin subject version; invalidate on change | M |
| 43 | Automated actions only within declared policies under own service identity | 46 | PARTIAL | AgentPrincipal `main.prisma:3848`; agents refused at gate `platform/approvals.ts:109-130`; jobs run under system scheduler `jobs/scheduler.ts:230-260` | Service identity per job in audit | S |
| 44 | Self-Dealing Bar on approvals | 46 | FIX | Subject-owner reroute `platform/approvals.ts:152`; requester cannot decide `:322-324`; but `decideApprovalStep` (`:309-337`) has no `assertCan` and route `commercial.routes.ts:497-503` none; resolver excludes subject owner only (`:295-305`), so it can resolve to the requester and strand the step | Exclude requester in resolver; add `assertCan`; check tier | S |
| 45 | Maker-checker as a platform control | 46 | INTERCONNECT | Per-domain copies: `refunds.ts:80`, `books.ts:125`, `tax.ts:519`, `payroll.ts:332`, `equity.ts:746`, `hcm/workflow.ts:406-430`. No shared control | One helper called by all | M |
| 46 | Single approvals inbox | 46 | INTERCONNECT | ApprovalStep (`main.prisma:810`), HrRequestApproval (`hcm-workflow.prisma:80`), LeaveRequestApproval (`hcm-leavepolicy.prisma:149`), MarketingCampaignApproval (`marketing.prisma:88`), HR request inbox `hcm/workflow.ts:370`; CEO Approvals page is a stub | Union read model; no new table | M |
| 48 | Exception carries rule and version | 47 | PARTIAL | ExceptionRecord (`main.prisma:3697-3742`) has code; `EXCEPTION_CODES` (`domain.ts:792`); no rule version | Version field | S |
| 49 | Exception carries evidence | 47 | MISSING | Only `detail` string (`main.prisma:3697-3742`) | Evidence refs | M |
| 50 | Affected records (more than one) | 47 | PARTIAL | Single `subjectType`/`subjectId` (`main.prisma:3697-3742`) | Many-to-many or affected list | S |
| 51 | Owner, backup, due time, consequence of inaction, permitted responses, escalation path | 47 | PARTIAL | `ownerPartyId`, `accountablePositionId` (`main.prisma:3697-3742`); `slaDueAt` optional (`platform/exceptions.ts:57-100`); no backup, consequence, permitted responses | Add fields; SLA mandatory on policy | M |
| 52 | Duplicate signals attach to the same case | 47 | FIX | Fingerprint and open-match dedupe `platform/exceptions.ts:57-91`; learner case: second complaint returns the open record without linking its log or elevating (equal severity), so the learner comment at `domains/learnerTimeline.ts:147-152` is wrong | Attach evidence to existing case; append detail | S |
| 53 | States: acknowledged, investigating, awaiting external response, resolved, suppressed, closed | 47 | PARTIAL | `EXCEPTION_STATES` `domain.ts:857` = open, acknowledged, resolved, escalated, suppressed; no investigating, awaiting_external, closed. `resolveException` `platform/exceptions.ts:163-176` resolves from any state; route `command.routes.ts:270-276` has no permission check | State machine via `lifecycle.ts`; permission check | S |
| 54 | Suppression with reason, expiry, review owner | 47 | MISSING | `suppressed` in `EXCEPTION_STATES` (`domain.ts:857`) with no writer and no fields | Suppression record | S |
| 55 | Service levels (enquiry two business hours, complaint one day, next-day delivery two staffed hours) | 47 | MISSING | `slaDueAt` caller-supplied (`platform/exceptions.ts:57-100`); `ItSlaPolicy` (`it-servicedesk.prisma:19`) exists for IT only; proposal calls these design targets | Reuse `ItSlaPolicy` pattern; calibrate in pilot (leadership) | M |
| 56 | Empty queue not mistaken for safety (detector freshness, unmonitored areas, integration health, suppressed count, unowned records) | 47 | PARTIAL | Unowned records `commandCenter.ts:257`; automation failures `commandCenter.ts:324-395`; no detector heartbeat; no suppressed count; `GET /command` returns empty with no freshness | Staleness block in command centre | M |
| 57 | Escalation ladder climbs through severity and time | 47 | FIX | `jobs/scheduler.ts:321-323` selects `state in [open, acknowledged]` and `escalatedAt: null`, so an escalated exception never escalates again; `:331` ladder `['finance_head','chairman']` hard-coded; approvals `:341` select `state:'open'` only | Ladder from policy; allow repeated rungs with backup first | S |
| 58 | Repeated exceptions trigger policy or process review | 47 | MISSING | No code | Counter per code or subject that raises a review | S |
| 59 | Founder priority by severity, value at risk, urgency, dependencies, confidence; "unknown impact" | 47 | PARTIAL | Ranking band and score use severity and SLA only (`commandCenter.ts:286-311`); no value-at-risk or confidence on ExceptionRecord | Add value-at-risk (bigint paise), confidence, dependency; show "unknown impact" | M |
| 60 | Inspect why an item appeared | 47 | PARTIAL | `whyRanked` sentences `commandCenter.ts:~305-311` | Show rule and version | S |
| 61 | Protected complaint not visible to unauthorised viewers | 47 | FIX | Learner exception detail carries log title `domains/learnerTimeline.ts:~145`; `attentionQueue` unscoped `commandCenter.ts:244-300`; command route gated on `health_scores:view` only `command.routes.ts:25-31` | Scope queue by record visibility; keep detail out of queue for confidential logs | S |
| 62 | Command centre includes approvals | 47 | PARTIAL | Only counted in banner `commandCenter.ts:512-518`; not in queue; `commandCenter.ts:532-550` assembles attention, decisions, what changed, live | Include approval steps | S |
| 63 | Sensitive access anomaly: security owner plus independent reviewer | 47 | MISSING | No security incident model; `ItAccessReview` (`it-governance.prisma:228`) is periodic, not anomaly-driven | Incident model | M |
| 64 | Cash last reconciled, unallocated receipts, unconfirmed expected collection | 48 | PARTIAL | `cashPosition` `domains/books.ts:1272`; allocation `domains/finance.ts:21, 241`; no "expected, unconfirmed" category | Category on receipts or expected collections | M |
| 65 | Downside cash forecast excluding unverified receipts | 48 | MISSING | `GET /command/forecast` `command.routes.ts:122` is `opportunities.forecastRollup` (pipeline, not cash) | Cash forecast; Phase 8 | L |
| 66 | Balance drills to approved statement and matching records | 48 | PARTIAL | `BankStatementLine` `compliance-books.prisma:216`; drill not verified | Drill path | S |
| 67 | Daily digest of changes (delivery pack accepted, customer payment promise, instructor absence, vendor bank change) | 48 | PARTIAL | `whatChanged` `commandCenter.ts:129-240`; no acceptance, promise or bank-change events; leave exists (`domains/leave.ts`) without link to cohort sessions | Events and models for each | M |
| 68 | Vendor bank change assigned for independent verification | 48 | MISSING | See 26 | As 26 | M |
| 69 | Instructor absence covered by qualified backup under delegated authority | 48 | MISSING | `Cohort` `main.prisma:3481` has single `trainerPartyId`; no absence-to-cover link | Cover assignment record | M |
| 70 | Free software change: founder sees scope, estimate, teaching allocation, contribution, owner recommendation | 48 | MISSING | Decision evidence pack has no financial or contribution components (`decisions.ts:113-133`; `domain.ts:778-786`) | Add components | M |
| 71 | Approve revised plan with condition; evidence version and rationale recorded | 48 | PARTIAL | `disposeDecision` decide (`decisions.ts:221-290`) records option and rationale; no conditions; no evidence version | Conditions array | M |
| 72 | Decision creates customer confirmation task; forecast updated only after acknowledgement; prior kept | 48 | FIX | Decide creates no Task (`decisions.ts:262-285`); receivables projection is overwritten by upsert (`domains/invoicing.ts:1838-1852`), so prior value is lost | Versioned projection; task on decide | M |
| 73 | Complaint owner absent: backup receives case and clock | 48 | MISSING | No customer complaint model; no absence model | See 88 | L |
| 74 | Permitted transcript marked uncertain (fee amount) | 48 | MISSING | No transcript or call model; `Interaction` `main.prisma:1980` has no uncertainty field | Interaction uncertainty flag; transcript consent (DPDP, flag uncertainty) | M |
| 75 | Evening view: executed decisions, pending promises, tomorrow's uncovered commitments, cash confidence | 48 | PARTIAL | `Implemented` state exists; no promise or coverage model; no cash confidence | Promise-to-pay model; coverage view | M |
| 76 | Integration warning when email capture is delayed; empty enquiry queue not treated as complete | 48 | MISSING | No inbound mail or capture code (grep imap, mailbox, inbound email none) | Capture integration with heartbeat | M |
| 77 | Founder logs off while routine work continues under delegated authority | 48 | PARTIAL | Depends on 34-36 | As 34-36 | M |
| 78 | Pilot journey measured by unstructured status requests | 48 | MISSING | No metric | Define metric | S |
| 79 | Lead capture: consented form, dedupe, owner and backup, source, contact preference, response task | 49.1 | PARTIAL | `Lead` `main.prisma:1464-1537` (ownerPartyId, source, sourceDetail, campaignId, convertedOpportunityId); routing `domains/routing.ts:338` (EX-CRM-004); untouched `domains/leads.ts:419` (EX-CRM-010); `Consent` `compliance-privacy.prisma:54` not linked to Lead; backup and response task MISSING | Backup; task; consent link | M |
| 80 | Propose and commit: approved offering and price; exceptions to authority; executed contract or explicit exception | 49.2 | PARTIAL | `Proposal` `main.prisma:1691`, `Quote` `:1722`, `Contract` `:1836` (status default `'proposed'`); gate `domains/agreements.ts:333`; discount class `main.prisma:779-808` comment | Executed-state guard UNVERIFIED | M |
| 81 | Scope, milestones, acceptance and payment terms pinned | 49.2 | MISSING | No milestone or acceptance model (grep none); `FeeInstalment` `main.prisma:3052` is education only | Milestone and acceptance records | M |
| 82 | Delivery acknowledges handoff, books capacity, change requests with effort and commercial impact, QA evidence, missed commitments become exceptions | 49.3 | PARTIAL | Win creates Project with contractId `domains/opportunities.ts:238-262`; handoff acceptance EX-CRM-012 `domains/health.ts:281`; `Assignment` `main.prisma:4354`; change requests and QA evidence MISSING | Change request model; QA evidence | M |
| 83 | Billing trigger confirmed before invoice | 49.4 | MISSING | `Invoice` `main.prisma:2841-2976` has no billing-trigger field; `domains/invoicing.ts:692` `createInvoice` no trigger check | Trigger reference to milestone or acceptance | M |
| 84 | Payment imported once and allocated | 49.4 | EXISTS | `Payment` `@@unique([tenantId, gatewayReference])` `main.prisma:3078-3131`; allocation join and `domains/finance.ts:21` | None | S |
| 85 | Bank or gateway fees and withholding separately represented | 49.4 | MISSING | No fee or withholding fields on `Payment` `main.prisma:3078-3131` | Fields; TDS rate rows must be StatutoryRule (CLAUDE rule 4) | M |
| 86 | Collection communication attached to case; dunning | 49.4 | PARTIAL | Dunning stage by overdue days only `domains/invoicing.ts:1828-1831`; no case | Case-linked dunning | M |
| 87 | Reconciliation confirms cash | 49.4 | PARTIAL | `BankStatementLine` `compliance-books.prisma:216`; matching UNVERIFIED | Verify matching | S |
| 88 | Customer complaint: linked to scope, delivery, communications, invoices; owner and response clock | 49.5 | MISSING | No customer complaint model. Nearest: `LearnerLog` `main.prisma:3620` (students), `PoshComplaint` `compliance-labour.prisma:144` (statutory POSH), `HrCase` `hcm-engagement.prisma:172` (HR), `ItTicket` `it-servicedesk.prisma:56` (internal IT, not customers) | New case model; see Advisor notes | L |
| 89 | Active dispute pauses inappropriate dunning | 49.5 | MISSING | `invoicing.ts:1828-1831` has no dispute input | Pause flag tied to case | S |
| 90 | Repair, replacement, credit or refund proposed with evidence and authority | 49.5 | PARTIAL | `CreditNote` `main.prisma:3267`; `Refund` `compliance-corporate.prisma:244-262` (requested/approved/paid); no complaint link | Complaint link | M |
| 91 | Refund: verified beneficiary, entitlement approval, independent payment authorisation, confirmation | 49.6 | FIX | Approval and self-approval refusal `refunds.ts:71-90`; `payRefund` `refunds.ts:98-125` no payer check, free account input, no beneficiary verification; `paidPaymentId` set (`compliance-corporate.prisma` Refund) | Add payer check and beneficiary binding | S |
| 92 | Credit note and accounting adjustment linked to refund | 49.6 | PARTIAL | Refund has `invoiceId`, `receiptId` (`compliance-corporate.prisma:244-262`); no `creditNoteId` | Add FK | S |
| 93 | Customer receives approved response; case closes only after promised actions | 49.6 | MISSING | No case; no promise model | Case close guard | M |
| 94 | Review updates SOP or sales policy | 49.6 | PARTIAL | `reviewDecision` `decisions.ts:366-398` and `Lesson` `main.prisma:3964` exist for decisions only | Extend to cases | S |
| 95 | Attributed statement with evidence gap, confirmation request, commercial review | 49.7 | PARTIAL | `Interaction` `main.prisma:1980`; `domains/interactions.ts`; no "claim unproven" state or review routing | State and routing | M |
| 96 | Acceptance proof: campaign source to signed terms to delivery to milestone to invoice to partial payment to dispute to credit to reconciled receipt | 49.8 | PARTIAL | `MarketingTouchpoint` `marketing.prisma:467`, `Lead.campaignId`; Contract to Project EXISTS; milestone MISSING; dispute MISSING; credit `CreditNote` exists; receipt `main.prisma:3132` | Milestone and dispute chain breaks | M |
| 97 | Customer-facing view conceals margin and private discussion | 49.8 | MISSING | No customer portal; portal pages only for equity (`seed/bootstrap.ts:325-332`) | Customer portal scope; decision for leadership | L |
| 98 | Role approval: need, budget, position, competencies; HR validates; approver accepts | 50.1 | PARTIAL | `createRequisition` `domains/hiring.ts:53`; `transitionRequisition` `hiring.ts:90-112` (approve verb); `Position` `main.prisma:4199`; budget link and competencies UNVERIFIED or MISSING | Budget link; competency model | S |
| 99 | Candidate evidence and offer terms versioned; consent; dated affiliation without duplicating identity | 50.2 | PARTIAL | `Application` `main.prisma:4323`; `OfferLetter` `hcm-recruiting.prisma:120`; join gated on OfferAccepted `domains/hiring.ts:274-300`; `hire` checks person exists `domains/employment.ts:303-345`; candidate dedupe and consent UNVERIFIED | Versioned offer; dedupe check | M |
| 100 | Onboarding: documents, probation objectives, access, mailbox, number, asset custody; policy acknowledgement | 50.3 | PARTIAL | `Onboarding` `main.prisma:4764`; `OnboardingTask` `hcm-recruiting.prisma:223`; `PolicyAcknowledgement` `hcm-engagement.prisma:256`; `AssetAssignment` `hcm-assets.prisma:42`; mailbox and number MISSING | Mailbox and number provisioning | M |
| 101 | Operate: attendance, leave, expenses, payroll inputs, objectives, learning, capability; one combined capacity plan; compensation pins terms | 50.4 | PARTIAL | `ExpenseClaim` `hcm-compensation.prisma:237`; `ReviewAssignment` `hcm-performance.prisma:59`; `TrainingEnrollment` `hcm-learning.prisma:72`; leave `domains/leave.ts`; combined capacity MISSING (`Assignment` `main.prisma:4354`, `TrainingSession` `hcm-learning.prisma:43`, `Cohort` `main.prisma:3481` separate) | Combined capacity view | M |
| 102 | Exit initiation: controlled workflow, notice, settlement inputs, access plan, handover; restricted grievance; no self-clearance | 50.5 | PARTIAL | Resignation own-scope `domains/hcm/separations.ts:229`; Offboarding `main.prisma:4782-4800`; self-clearance refused `separations.ts:~519-524`; access plan MISSING; `HrCase` confidential `hcm-engagement.prisma:168-172`; `DisciplinaryCase` `compliance-labour.prisma:218` | Access plan record | M |
| 103 | Transfer continuity: all owned open leads, cases, payments, tasks, sessions, documents, accounts listed; receiving owners acknowledge; credentials rotated; mailbox and number assigned | 50.6 | MISSING | `reassignLead` `domains/leads.ts:212-232` is per lead only; `transitionOffboarding` `domains/employment.ts:1176-1205` runs hooks only at ClosedArchived or FFSettlementCompleted (`:1200-1205`); no acknowledgement model; no `raiseException` in `domains/hcm/separations.ts` | Continuity inventory, transfer record with acknowledgement, exit-triggered exceptions | L |
| 104 | Access revoked at closure | 50.6 | PARTIAL | Hook `domains/compliance/privacy.ts:843-850` revokes affiliations only; credentials and sessions UNVERIFIED | Credentials and sessions revocation | M |
| 105 | Settlement, asset return, knowledge transfer, outstanding obligations with receiving owners, residual exceptions with accountable positions | 50.7 | PARTIAL | Settlement components `main.prisma:4782-4800`; `AssetAssignment` `hcm-assets.prisma:42`, `ItAssetAssignment` `it-assets.prisma:101`; `ExceptionRecord.accountablePositionId` not auto-set; knowledge transfer MISSING | Receiving owner on each obligation | M |
| 106 | Failure walk: trainer resigns with open learner complaint and two sessions; coverage exception raised | 50 | MISSING | No exit-to-exception link. Complaint keeps the departed trainer as owner (`domains/learnerTimeline.ts:138`, `ownerPartyId: enrollment.cohort.trainerPartyId`) | Exit trigger reassigns owner and raises coverage exception | L |
| 107 | Acceptance: departed account loses access; successor acknowledged; HR evidence not visible to successor | 50 | PARTIAL | Employment visibility restricted `platform/recordScope.ts:36-74`; access revoke only at closure; successor acknowledgement MISSING | As 103-104 | M |
| 108 | College relationship: institution, department, contacts, introductions, source, authority, next action; introduction is not commercial | 51.1 | PARTIAL | `InstitutionProfile` `main.prisma:494`; `Interaction` `main.prisma:1980`; `Opportunity` `main.prisma:1539`; department and authority UNVERIFIED | Authority and next-action fields | S |
| 109 | Programme approval: curriculum, duration, outcomes, trainer readiness, venue, equipment, cohort size, fee, tax, delivery cost; who may accept | 51.2 | PARTIAL | `Course` `main.prisma:3379`; `CourseFeePlan` `main.prisma:3435`; `Cohort` `main.prisma:3481`; no programme approval gate (callers of `evaluateApprovalGate` are agreements, equity, IT, ESOP, marketing; none in education) | Programme acceptance gate | M |
| 110 | Executed agreement, PO or MoU; milestones; attendance and assessment format; signatory; invoice instructions; no blank-signature draft shown as executed | 51.3 | PARTIAL | `Mou` `main.prisma:1787`; `Contract` `main.prisma:1836` (default 'proposed'); no PurchaseOrder (grep none); no milestone model; signatory UNVERIFIED | PO model; milestones | M |
| 111 | Cohort and session plans; attendance; trainer substitutions; assessment; issues; attributed and versioned corrections; learner identity; institution access limited | 51.4 | PARTIAL | `Enrollment` `main.prisma:3511`; `Attendance` `main.prisma:3573`; `LearnerLog` `main.prisma:3620`; `Cohort.trainerPartyId` single-valued (no substitution history); correction versioning UNVERIFIED; institution access MISSING (`seed/bootstrap.ts:325-332` portal is equity only) | Substitution history; institution portal | M |
| 112 | Frozen evidence pack; submission, rejection, correction and acceptance tracked; original retained | 51.5 | MISSING | No model | Evidence pack versioning | M |
| 113 | Invoice on approved billing trigger; due schedule; payment allocated once; commitments and disputes tracked; funded receipts separate from cash | 51.6 | PARTIAL | `FeeInstalment` `main.prisma:3052`; Payment unique gateway reference `main.prisma:3078-3131`; expected-funded-receipt concept MISSING; disputes MISSING | Expected receipts; disputes | M |
| 114 | Contribution: collected revenue against trainer time, travel, venue, vouchers; outcomes; renewal evidence | 51.7 | MISSING | No model; `LearnerLog` rating `main.prisma:3620` only | Contribution view | M |
| 115 | Failure walk: rejected attendance pack after invoice raised; dispute case; correction owner; confidence updated; invoice preserved; reminders paused | 51 | MISSING | No dispute case; dunning is overdue-days only (`invoicing.ts:1828-1831`) | Dispute model; dunning pause | L |
| 116 | Acceptance proof items: substitution, corrected attendance, moderation, resubmission, partial payment, final receipt | 51 | PARTIAL | Partial payment allocation `domains/finance.ts:21`; receipt `main.prisma:3132`; substitution, moderation, resubmission MISSING | As 111, 112 | M |
| 117 | Institution fee and margin calculator: cost base, per-learner and cohort cost, minimum viable enrolment, GST, contribution, margin, assumptions with date and owner | 52 | MISSING | No calculator (grep for margin and minimum viable finds only routing and portfolio code); not in plan | New model; leadership to confirm margin definition | L |
| 118 | Required revenue C/(1-m) and per-learner minimum fee (only when margin definition approved and m below 1; markup uses different formula) | 52 | MISSING | As 117 | Formula is correct for margin on revenue; must be stated explicitly, not as "markup" | M |
| 119 | Sensitivity on volume and collection delay; approved quote retains calculation version | 52 | MISSING | `Quote` `main.prisma:1722` exists; no calculation version | Calculation snapshot on quote | M |
| 120 | Instalments connected to invoices, reminders, receipts, refunds, bank reconciliation; mandate-based payment initiation | 52 | PARTIAL | `FeeInstalment` `main.prisma:3052`, Payment allocation, dunning `invoicing.ts:1828`; no Mandate model (grep none) | Mandate model with explicit consent and terms | L |
| 121 | GST on tax-exclusive revenue, tax-inclusive payable | 52 | UNVERIFIED | Invoice GST amounts `main.prisma:2841-2976`; rate source must be a StatutoryRule row (CLAUDE rule 4); StatutoryRule presence not checked | Verify rate source before any fee calculator | S |

## Lifecycle chain walks

Each step: records present, links present, events present, and where the chain breaks.

### p49 Lead to cash and complaint resolution
1. Capture and qualify. Lead (`main.prisma:1464`) exists with owner and source. Break: no response task link, no backup owner, consent not linked to lead (`compliance-privacy.prisma:54`). Event `LEAD_CREATED` is consumed by marketing journeys (`events/handlers.ts:248`).
2. Propose and commit. Proposal, Quote, Contract exist (`main.prisma:1691, 1722, 1836`). Authority gate exists (`domains/agreements.ts:333`). Break: no milestone or acceptance record, so scope and payment terms are not pinned to an entity.
3. Plan and deliver. Win creates Project with contractId (`domains/opportunities.ts:238-262`); handoff acceptance is measured (`domains/health.ts:281`). Break: no change-request record, no QA or release evidence, no link from missed commitment to exception.
4. Invoice and collect. Invoice and Payment exist; import is idempotent (`main.prisma:3078-3131`); allocation exists (`domains/finance.ts:21`). Break: invoice has no billing-trigger reference; no fee or withholding fields on Payment; dunning is not tied to any case (`invoicing.ts:1828-1852`).
5. Support and resolve. Break at the root: no customer complaint model. Learner and HR complaint models do not apply to customers.
6. Close and learn. Refund approval works (`refunds.ts:71-90`). Break: payment has no releaser check (`refunds.ts:98-125`); refund has no credit-note FK; no case to close; review exists for decisions only (`decisions.ts:366-398`).

### p50 Hiring to exit with open cases
1. Approve role. Requisition and transition exist (`hiring.ts:53, 90-112`). Break: transition emits before the row is written (see Fixes F9); no budget or competency link.
2. Select and offer. Application and OfferLetter exist; join requires OfferAccepted (`hiring.ts:274-300`). Break: candidate dedupe and consent link UNVERIFIED.
3. Onboard. Onboarding tasks, policy acknowledgement and asset assignment exist. Break: mailbox and number provisioning absent; access comes from role grants only (`platform/grantSync.ts`).
4. Operate and develop. Records exist separately. Break: no combined capacity record for a person who teaches and develops.
5. Initiate exit. Resignation, Offboarding and self-clearance refusal exist (`separations.ts:229`, `main.prisma:4782`, `separations.ts:~519-524`). Break: no access plan; no exception raised on exit (no `raiseException` in `domains/hcm/separations.ts`).
6. Transfer continuity. Break at every link: no inventory of owned records; `reassignLead` works per lead only (`leads.ts:212-232`); no acknowledgement event or record; hook fires only at closure (`employment.ts:1200-1205`).
7. Settle and close. Settlement components exist (`main.prisma:4782-4800`); access revocation at closure only (`privacy.ts:843-850`); residual exceptions have no auto-assigned accountable position. Break: knowledge transfer and receiving owner for each obligation.

Failure walk (trainer resigns with open complaint): the learner exception keeps the departed trainer as ownerPartyId (`learnerTimeline.ts:138`). No event on exit reaches it. Chain breaks at the exit-to-exception link and the owner reassignment.

### p51 College agreement to collected payment
1. Relationship. InstitutionProfile, Interaction exist (`main.prisma:494, 1980`). Break: authority and next-action fields.
2. Programme approval. Course, CourseFeePlan, Cohort exist (`main.prisma:3379, 3435, 3481`). Break: no programme acceptance gate.
3. Agreement. Mou and Contract exist (`main.prisma:1787, 1836`). Break: no PO model, no milestone model, executed-state guard UNVERIFIED.
4. Delivery and evidence. Enrollment, Attendance, LearnerLog exist. Break: trainer substitution history; correction versioning UNVERIFIED; institution access.
5. Submit and accept. Break at root: no frozen evidence pack, no submission or acceptance record.
6. Invoice and collect. FeeInstalment, Invoice, Payment exist. Break: billing trigger check; funded-receipt expectation; mandates.
7. Review. Break: no contribution record; LearnerLog ratings only.
Failure walk (rejected attendance pack): no dispute case; dunning continues on overdue days (`invoicing.ts:1828-1831`).

### p48 A day of remote oversight (chain breaks)
- Morning: cash position exists (`books.ts:1272`); no expected-unconfirmed category; no downside forecast.
- What changed: digest exists (`commandCenter.ts:129-240`); no events for pack acceptance, promises or vendor bank change.
- Decisions: vendor change routing (no model); instructor cover (no link); free software change (evidence pack lacks contribution).
- Execution: decision creates no task (`decisions.ts:262-285`); forecast overwritten (`invoicing.ts:1838-1852`).
- Midday: complaint absent (no model); transcript uncertainty (no model).
- Evening: email capture warning (no capture code); decisions delegated (state missing from queue, `decisions.ts:169`).

## Interconnections

| Piece A (file:line) | Piece B (file:line) | Missing link |
|---|---|---|
| Decision (`main.prisma:852`) | ApprovalStep (`main.prisma:810`) | No FK; a decision needing authority does not create an approval step |
| Decision (`main.prisma:852`) | Task (`main.prisma:2046`) | No FK; decided items create no task |
| Decision `decide` (`decisions.ts:221-290`) | Event subscribers (`events/handlers.ts`) | No subscriber for decided, deferred, delegated |
| Delegation (`main.prisma:905`) | permissions (`platform/permissions.ts`) | Never consulted by authority checks; never expires |
| DelegationOfAuthority (`hcm-workflow.prisma:109`) | ApprovalStep resolver (`platform/approvals.ts:295-305`) | HR uses it (`hcm/workflow.ts:~116`); approval resolver does not |
| ExceptionRecord (`main.prisma:3697`) | ExceptionRecord escalation job (`jobs/scheduler.ts:316-370`) | Job excludes escalated state; single bump |
| LearnerLog resolve (`learnerTimeline.ts:171-205`) | EX-EDU-002 (`learnerTimeline.ts:136-152`) | Resolving the log does not resolve the exception |
| Offboarding (`main.prisma:4782`) | ExceptionRecord (`main.prisma:3697`) | No exit-triggered exception; no owner reassignment |
| Offboarding completion hook (`employment.ts:1200-1205`) | Access revocation (`privacy.ts:843-850`) | Revokes affiliations only, at closure only |
| ApprovalStep (`main.prisma:810`) | Command centre (`commandCenter.ts:512-518`) | Counted only, not listed |
| HrRequestApproval, LeaveRequestApproval, MarketingCampaignApproval, ApprovalStep | One inbox | No union read model |
| Refund (`compliance-corporate.prisma:244`) | CreditNote (`main.prisma:3267`) | No FK |
| Receivables projection (`main.prisma` ReceivablesProjection) | Dunning and dispute | No dispute pause |
| Contract (`main.prisma:1836`) | Milestone or acceptance | No model |
| Learner complaint (EX-EDU-002) | Customer complaint | Not a customer model; no shared case |

## Fixes (existing code wrong or unsafe; ordered by consequence)

F1. Evidence-pack deadlock. `domains/decisions.ts:153-159` checks three of seven components and never lets a caller add the rest. First decision of each subject type has no precedents, so it cannot reach Decided. Fix: check all seven; accept an explicit "no precedent" component; add a pack update path. Test that fails today: raise on a new subject type with rejectedOptions, then dispose, expecting success.

F2. Delegated decisions vanish. `decisions.ts:169` omits `Delegated` from the queue states, and nothing else lists them. Test: delegate, then fetch queue; expect the item for the delegate.

F3. Unscoped visibility and missing checks.
- `decisionQueue` (`decisions.ts:163-207`) returns all tenant decisions to any caller who reaches it.
- `attentionQueue` (`commandCenter.ts:244-300`) is unscoped.
- `GET /command` (`command.routes.ts:25-31`) gates on `health_scores:view` but returns the decision queue (`commandCenter.ts:532-550`).
- `POST /decisions/:id/review` (`command.routes.ts:194-203`), `GET /decisions/calibration` (`:206`), `POST /exceptions/:id/acknowledge` and `resolve` (`:265-276`) have no permission check.
- The header of `decisions.ts:4-9` says nothing reaches the queue unless authority exceeds everyone below. `decisionQueue` does not implement that gate. The comment at `commandCenter.ts:44-50` says the same.

F4. Approval step without permission. `decideApprovalStep` (`platform/approvals.ts:309-337`) has no `assertCan`; route `commercial.routes.ts:497-503` has none. It does not check that the decider holds the resolved tier. Resolver (`approvals.ts:295-305`) excludes subject owner only, so it can resolve to the requester, and then `:322-324` refuses the requester, stranding the step.

F5. Refund payment. `payRefund` (`domains/compliance/corporate/refunds.ts:98-125`) lacks a payer-differs-from-approver check; `accountId` is free input, not bound to the original receipt or invoice.

F6. Money as number (CLAUDE rule 1). `platform/approvals.ts:69` `commercialValue: number`; `platform/permissions.ts:120` magnitude `value: number`; `platform/permissions.ts:310` `Number(grant.ceilingValue)`; `domains/decisions.ts` `num(requiredAuthorityValue)` in list output; `command.routes.ts` POST body `requiredAuthorityValue: z.number()`. All must become signed bigint paise.

F7. Escalation climbs one rung only. `jobs/scheduler.ts:321-323` selects `state in [open, acknowledged]` and `escalatedAt: null`; escalated exceptions never climb again. Approval escalation (`:341`) selects `state:'open'` only. Ladder hard-coded `:331, :345`.

F8. Learner complaint path.
- Second complaint on same enrollment is dropped. `platform/exceptions.ts:87-91` returns the open record for equal severity; `learnerTimeline.ts:147-152` comment claims it escalates; it does not.
- No response clock: raise call (`learnerTimeline.ts:136-152`) passes no `slaDueAt`, so `escalateBreachedSlas` never picks it up.
- Resolving the log (`learnerTimeline.ts:171-205`) does not resolve EX-EDU-002.
- Exception detail carries the complaint title to every queue viewer (`learnerTimeline.ts:~145`).
- Owner is the trainer and is never reassigned on exit (`learnerTimeline.ts:138`).

F9. Audit and ordering (CLAUDE rule 5).
- `decisions.ts`, `platform/approvals.ts`, `platform/exceptions.ts`: zero `auditWrite` calls.
- `approval_step` and `exception_record` are not in the governed registry (`platform/audit.ts:88-115`), so `auditWrite` would no-op for them.
- `platform/lifecycle.ts:74-119` emits, then audits with `force: true`, and never writes the row; the caller writes afterward (`domains/employment.ts:1176-1205`, `domains/hiring.ts:90-112`). Order is emit, audit, write. CLAUDE rule 5 requires assertCan, write, auditWrite, emit. A failed row write after emit leaves a published event with no state change.
- `force: true` is the bypass CLAUDE forbids.

F10. Review loop. `decisions.ts:393` sets `changeCommitmentResolved: true` regardless of execution. `decisions.ts:131` pairs precedent with lesson by array index, not by source.

F11. Delegation (decision) is write-only. `decisions.ts:~295-315` creates a `Delegation` row; nothing reads it, nothing expires it, and `permissions.ts` never consults delegation. Either wire into authority or retire in favour of one model (plan wants `DelegationLog`, `ceo-office.md:621`).

F12. Decision state drift. `decisions.ts:262` sets `Implemented` on decide; `Decided` is in `domain.ts:761-771` but never written. Plan lifecycle in ceo-office and the brief differ (Framed, Reversed). Record the choice.

F13. Exception state and suppression. `suppressed` is listed (`domain.ts:857`) with no writer and no fields; `resolveException` (`platform/exceptions.ts:163-176`) accepts any prior state.

F14. Projection overwrite. `domains/invoicing.ts:1838-1852` upserts the receivables projection in place; prior dunning stage and amount are lost. Plan requires retained prior forecast (proposal p48).

F15. Routing default. `decisions.ts:62` defaults to `'chairman'`. Founder-only routing fails the 24-hour absence test (proposal p46).

F16. Stub approvals return success. `routes/ceo/doa.routes.ts:~14-16` returns `{items: []}` on every GET with no permission check. An empty approvals inbox looks like "nothing waiting". Return 501 or hide until built.

F17. Command centre attention queue as an empty signal. `commandCenter.ts:244-300` returns an empty array when detectors are dead, with no staleness field (proposal p47).

## Advisor notes (what the proposal misses)

Risks and ambiguities in the proposal:
- Customer complaints are the central lifecycle (p49, p51, p48) but no customer complaint model exists or is planned. The proposal does not say who owns complaints, what the response clock is, or whether the complaint case is the same object as the exception.
- Customer and institution visibility (p45 table, p49, p51) assumes external users. The code has no customer or institution role and no portal beyond equity. The proposal does not say whether external users are in scope for launch.
- Decision visibility by audience assumes roles that do not exist (unit head, auditor, collection owner, trainer, HR specialist). The seven-role register is the actual constraint.
- Service levels (p47) are labelled design targets; leadership must set them.
- The margin formula on p52 is correct only for margin on revenue. It must not be called markup. The proposal does not state the margin definition. Leadership must choose.
- Several items depend on statutory or contested rates (GST on fees, TDS on institution payments, data retention and cross-border LLM use). Per CLAUDE rule 4, any rate is a StatutoryRule row, never a constant. Do not infer the law here; flag for professional review.
- Transcripts and complaint records about learners or customers are personal data. Under DPDP (applicability and rules to be confirmed by counsel), access and retention need a basis. CLAUDE forbids sending such data to a non-India inference region for a tenant requiring India inference.

Things the proposal should have said:
- A minimum complaint case model: id, recordCode, subject (customer, organisation or enrollment), channel, statement attributed to a person, evidence status (missing, conflicting, verified), owner, backup, responseDueAt, state, linked invoice/contract/project ids, remedy proposals (type, amount in paise, authority reference), visibility tier, audit registration, exception code.
- A minimum mandate model if auto-debit is wanted: consent reference, bank reference (masked), amount cap, frequency, start and end, revocation, audit.
- A milestone and acceptance model: milestone id, due, acceptance criteria, acceptance signatory, acceptance evidence, billing trigger link.
- An execution sub-record for decisions: task links, owner, status (not started, executing, blocked, complete), blocked reason.
- Break-glass policy: which actions, maximum duration, who is alerted, who reviews after the fact, what is logged. It must not disable audit, tenant scope or period close (CLAUDE "never").
- Who approves the approvers: decision on alternates and the DoA matrix owner (Phase 5 plan).

## Decisions for leadership

1. Authority thresholds and alternates per decision class and action (DoA matrix values). The code must not hardcode numbers. Name a backup for each class.
2. Founder's role in routine work: which classes are founder-only. Proposal's 24-hour test implies none for routine work.
3. Customer complaint process: owner, backup, response clock per channel, and whether complaints are a new model (recommended) or an extension of the learner exception.
4. External visibility: whether customers and institutions log in at launch, and what they see. Current code has no such role.
5. Auditor role: whether it exists, and scope and duration of access.
6. Related-party register: who is the independent reviewer (proposal names an authorised director, accountant or other valid reviewer; choose one).
7. Break-glass: permitted actions, duration, notification list, after-action reviewer.
8. Single approvals inbox across ApprovalStep, HR requests, leave, marketing and IT changes, or keep separate.
9. Delegation model: retire the decision-scoped `Delegation` (`main.prisma:905`) in favour of `DelegationOfAuthority` (HR) or a new `DelegationLog` (plan). Recommended: one model.
10. Margin definition for the fee calculator (margin on revenue, or markup), the revenue basis, and whether fully allocated margin is a decision basis.
11. Service levels for enquiry, complaint and delivery risk (proposal's values are targets, not commitments).
12. Whether founder-visible cash forecasts exclude unverified receipts by default (proposal says yes; confirm).

Plan drift to record: decisions lifecycle states (code vs plan vs brief), Delegation vs DelegationLog (`ceo-office.md:621`), and approval routing ladder (fixed `finance_head` then `chairman`, `packages/shared/src/permissions.ts:316`) versus policy-driven tiers planned in `ceo-office.md:259-264`.