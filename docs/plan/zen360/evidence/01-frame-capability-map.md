# 01 Frame and capability map (p04-p09, p75)

## Pages covered
- p04 Recommendation and success criteria (six outcome criteria, 24h founder-absence test)
- p05 Illustrative operating risks and design implications
- p06 Philosophy translated into product behaviour
- p07 Priority feedback (single paragraph; folded into M16)
- p08 Scope and stakeholder experiences
- p09 Complete capability map (13 domain rows)
- p75 Additional capability traceability (19 capabilities, chapter refs)

Method: MAP.md first (docs/plan/MAP.md), then targeted schema/domain reads. Plan hits via grep of docs/plan/*.md. Nothing in the repo was modified. Chapter numbers in p75 point to a document not in this packet; they are UNVERIFIED as cross-references.

Counts are in the final section.

## Capability table

Columns: ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size

### A. p04 success criteria (verified)

| ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| SC1 | Founder exception view: finds cash risk, missed commitments, decisions without asking teams for status reports | 4 | PARTIAL | apps/api/src/domains/commandCenter.ts:244 attentionQueue (default S3+), :532 commandCenter; apps/api/src/routes/command.routes.ts:29; apps/api/src/domains/books.ts:1308 cashForecast (route books.routes.ts:704); apps/web/src/pages/Workspace.tsx:220 Exceptions tabs; apps/web/src/pages/Decisions.tsx:28 | No single view joins cash, obligations, decisions, commitments. Chairman OKR page is a stub (apps/web/src/pages/ceo/Okrs.tsx:8, "not built yet"). Plan: docs/plan/ceo-office.md:13 covers decisions/exceptions/approvals in one cockpit (PLANNED). Acceptance test not defined. | M |
| SC2 | Every active customer obligation and critical case has primary owner, backup and next action | 4 | PARTIAL | Owner derived at generation: apps/api/src/domains/compliance/calendar.ts:36 resolveOwnerPartyId (affiliation by roleSlug), :~50 flagUnowned raises CMP_CAL_UNOWNED. Obligation row apps/api/prisma/schema/compliance-calendar.prisma:70-110 has status, filedById, reference, note, notifiedRungs; no ownerPartyId, backupPartyId or nextAction field. Exceptions carry ownerPartyId (apps/api/src/platform/exceptions.ts:57). | Store owner on row (derivation at read time means reassignment can silently move ownership, UNVERIFIED in obligationDetail calendar.ts:182). Add backup and nextAction fields. Customer obligations and collection cases do not exist (R4, M-section). | M |
| SC3 | Cash, invoices, receipts, credits, obligations reconcile to approved sources, unresolved differences shown | 4 | PARTIAL | Bank match and reconciliation: apps/api/src/routes/compliance/books.routes.ts:199 (POST match), :201 (GET reconciliation); BankStatementLine apps/api/prisma/schema/compliance-books.prisma:216; payroll reconciliations apps/api/src/routes/hcm/payrollops.routes.ts:165; payments apps/api/src/domains/finance.ts:99 recordPayment, :218 allocatePayment; receipts apps/api/src/domains/receipts.ts:53; credit notes apps/api/prisma/schema/main.prisma:3267 | Each source reconciles in its own silo. No cross-source difference ledger and no unified "unresolved differences" view. Unresolved-difference display in the bank reconciliation view: UNVERIFIED. | L |
| SC4 | Material decisions retain authority, evidence versions, dissent, execution owner, review date | 4 | PARTIAL | Decision model apps/api/prisma/schema/main.prisma:852-900 (authorityBasis, evidencePack Json, evidenceComplete, confidence, chosenOption, rationale, reviewDueOn, outcomeAssessment, varianceBand, changeCommitment, changeCommitmentResolved); service apps/api/src/domains/decisions.ts:42 raiseDecision, :163 decisionQueue, :221 disposeDecision, :366 reviewDecision; calibration apps/api/src/routes/command.routes.ts:206 | Dissent: zero hits in apps/ or packages/ (grep -i dissent). Execution owner: no field (routedToPartyId at main.prisma:~862 is routing). Evidence versions: one Json snapshot in evidencePack, no versioned source references. See F2 (money typed number). | M |
| SC5 | Staff complete pilot workflows in app with measured reduction in duplicate entry | 4 | MISSING | No metric or telemetry for duplicate entry in MAP.md or docs/plan. Lead scoring apps/api/src/domains/leads.ts:44 scoreLead has no duplicate check (grep duplicate in leads.ts: 0). Only form-submission duplicate suppression: apps/api/src/domains/marketing/capture.ts:302 (10-min window), :367-373 (payload hash). | Define baseline and instrument the write path (count of re-keyed records per workflow). Add lead dedupe key (normalised phone and email) and a merge path. Duplicate-entry metric has no owner in plan. | M |
| SC6 | Access, payment, retention, consent and recovery controls pass negative tests before wider release | 4 | PARTIAL | Tenant isolation negative: apps/api/src/tests/acceptance.test.ts:50-63 (CRM-FOUND-001, cross-tenant read by id). Consent withdrawal: apps/api/src/tests/compliance/privacy.test.ts:106. Retention sweep: apps/api/src/tests/compliance/books.test.ts:236. Payment paths: acceptance.test.ts (recordPayment/reversePayment). Restore drill: PLANNED only (docs/plan/README.md:56, docs/plan/phase-8-proof.md:11). | No consolidated negative-control suite across the five control classes. Recovery drill not built. Access negatives for field-level visibility not located (UNVERIFIED). | M |
| SC7 | Routine operations continue during a 24-hour founder absence (proposed acceptance test) | 4 | MISSING | Delegation exists in two models: apps/api/prisma/schema/main.prisma:905 Delegation; apps/api/prisma/schema/hcm-workflow.prisma:109 DelegationOfAuthority; createDelegation apps/api/src/domains/hcm/workflow.ts:552 | No test scenario defined. Two delegation models with no evident link (see F5). No founder-absence scenario in acceptance suite (grep: none). | M |

### B. p04 recommendation (what the first release should contain)

| ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| R1 | One identity, several effective-dated relationships; context switch never combines unrelated roles | 4, 8 | PARTIAL | Affiliation apps/api/prisma/schema/main.prisma:299 (roleSlug, status, primaryFlag); AccessRole main.prisma:675; permission grants main.prisma:744 (RBAC, not funding); resolver apps/api/src/platform/permissions.ts:54 resolveGrants | Context-switch rule that prevents permission union across roles: UNVERIFIED. Needs an explicit test. | M |
| R2 | Verified obligations and receipts | 4 | PARTIAL | ComplianceObligation apps/api/prisma/schema/compliance-calendar.prisma:70 (filedAt, reference "not filed without ARN", evidenceDocumentId); receipts apps/api/src/domains/receipts.ts:53 | Receipt verification state and evidence link: UNVERIFIED. | M |
| R3 | Common customer and institution register | 4 | PARTIAL | apps/api/src/domains/organizations.ts:42 ORGANIZATION_KINDS; apps/api/src/domains/relationships.ts:37 createRelationship, :80 supersedeRelationship; apps/api/src/domains/leads.ts:91 createLead | No register-level dedupe. Relationships are edges, not a golden record. | M |
| R4 | Owned collection cases; distinguish a promise from available cash | 5, 4 | MISSING | No CollectionCase or promise model (grep collection: 0 in apps/ and schema). Receivables: ReceivablesProjection apps/api/prisma/schema/main.prisma:3355; overdue detection apps/api/src/domains/finance.ts:434 detectOverduePayments. Phase 6 mentions collection letters as drafts only: docs/plan/phase-6-intelligence.md:55. | Model CollectionCase (receivableRef, owner, backup, promisedDate, promiseSource, state, nextAction). Promise must not feed the cash forecast as cash. Posting any money effect goes through post() (CLAUDE rule 2). | L |
| R5 | Contract and delivery evidence | 4, 9 | PARTIAL | Contract apps/api/prisma/schema/main.prisma:1836; createContract apps/api/src/domains/agreements.ts:110; won-without-contract sweep apps/api/src/domains/agreements.ts:571 (EX-CRM-011); Project apps/api/prisma/schema/main.prisma:3661 (opportunityId, contractId, managerPartyId, handoffAcceptedAt) | No delivery evidence (milestones, acceptance records, deliverable versions). See D06. | L |
| R6 | Internal work queue | 4 | PARTIAL | Task apps/api/prisma/schema/main.prisma:2046; Workspace page apps/web/src/pages/Workspace.tsx:31; HR inbox apps/api/src/domains/hcm/workflow.ts:370 listInbox | Task link to obligations, cases and decisions: UNVERIFIED. No cross-domain queue. | M |
| R7 | Company communication (messages, delivery states, calls, permitted transcripts) connected to the business case | 4, 9 | PARTIAL | Interaction log apps/api/src/domains/interactions.ts:105 logInteraction, :289 timelineFor, :69 computeSensitivity; outbound adapters apps/api/src/domains/marketing/adapters/whatsappCloud.ts:57, msg91.ts:49, httpEmail.ts; delivery-status inbound webhook apps/api/src/routes/marketing/public.routes.ts:57, applied by apps/api/src/domains/marketing/messaging.ts:918-936 (applyDeliveryEvents) | No inbound conversation or message model. No mailbox ingestion. No call, recording or transcript model (grep "model Call|Recording|Transcript": 0). Delivery states exist for marketing recipients only. | L |
| R8 | Provider constraints and capture gaps stay visible | 4, 9 | MISSING | Marketing adapter status exists for channels only: apps/api/src/domains/marketing/settings.ts:130 listAdapterStatus | No capture-health model or view for communication. | S |

### C. p05, p06, p08 mechanisms

| ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| M1 | One allocation calendar; displaced work tracked before capacity is promised | 5, 9 | MISSING | grep "allocation|capacity" in MAP.md and apps/: no model or route. Time: apps/api/src/domains/hcm/time.ts:47 (HR shifts/attendance only). | Model AllocationBlock (personPartyId, projectId, fraction, dateRange, displacedWorkRef). Needs project resource plan (D06). | L |
| M2 | Entitlement, payment instruction, actual money movement and outstanding balance kept separate | 5 | PARTIAL | Arrear apps/api/prisma/schema/hcm-payrollops.prisma:84; BankAdvice apps/api/prisma/schema/hcm-payrollops.prisma:146; states apps/api/src/domains/hcm/payrollops.ts (ARREAR_STATES shared at packages/shared/src/hcm/payrollops.ts:18) | Four-state separation as a single model: UNVERIFIED. Arrear has states but no evident bank-settlement link. | M |
| M3 | Unallocated receipt retained with evidence gap until finance confirms mapping | 5 | PARTIAL | apps/api/src/domains/finance.ts:218 allocatePayment; apps/api/src/domains/receipts.ts:53 | Suspense state for unallocated receipts: UNVERIFIED. | S |
| M4 | Scope change keeps scope, estimate, acceptance criteria and authorised commercial response | 5, 9 | MISSING | No ChangeRequest or scope model (grep "ChangeRequest|ScopeChange": 0). | Model ChangeRequest linked to Project and Contract, with approval via assertCan and a decision record for material change. | L |
| M5 | Experiment, readiness, pilot and verified revenue held as separate states | 5, 9 | MISSING | grep "experiment": 0 in apps/ and docs/plan. Opportunity stages exist: apps/api/src/domains/opportunities.ts:132 advanceStage. | Separate states need a product-adoption entity. Not in plan. | M |
| M6 | Engagement without agreed value or date is an unresolved forecast item with owner and next action | 5 | PARTIAL | apps/api/src/domains/opportunities.ts:270 ForecastChangeInput, :418 forecastRollup; apps/api/src/domains/leads.ts:400 detectUntouchedLeads | "Missing value or date" flag and next-action field: UNVERIFIED. | S |
| M7 | Rolling cash view showing confidence, dependencies, exclusions and unresolved balances | 5, 6 | PARTIAL | apps/api/src/domains/books.ts:1308 cashForecast(months = 6); route apps/api/src/routes/books.routes.ts:704 | Signature takes only a horizon. No confidence, dependency or exclusion output. Forecast does not join receivables (ReceivablesProjection main.prisma:3355) or the opportunity forecast (opportunities.ts:418): UNVERIFIED. | M |
| M8 | Visibility is distinct from authority | 6, 8 | PARTIAL | apps/api/src/platform/permissions.ts:131 evaluate, :317 assertCan, :423 visibilityWhere; apps/api/src/platform/permissions.ts:316 APPROVAL_LADDER (packages/shared/src/permissions.ts:316) | Design present. Approval-ladder exclusion for founder: UNVERIFIED. | S |
| M9 | Dissent recorded; outcome compared with original assumptions | 6 | PARTIAL | Decision outcomeAssessment, varianceBand (apps/api/prisma/schema/main.prisma:~884-886); reviewDecision apps/api/src/domains/decisions.ts:366 | Dissent field absent (see SC4). Assumption record (confidence stated before outcome is captured: main.prisma:~876). | S |
| M10 | No automated "believability" scores; capability evidence specific, dated, correctable | 6 | PARTIAL | Evidence model apps/api/src/domains/capability.ts:190 addEvidence, :218 verifyClaim, :301 recordContradiction, :346 changeClaimState | Risk: apps/api/src/domains/capability.ts:406-420 findCapableParties orders people by confidenceRank and returns up to 50. This is a people ranking that p06 forbids. See F4. | S |
| M11 | Confidential grievance and operational stop channels with independent routing; manager cannot erase a complaint | 6, 28 | PARTIAL | PoshComplaint (apps/api/src/domains/compliance/labour.ts; routes apps/api/src/routes/compliance/labour.routes.ts:195); HR case messages apps/api/prisma/schema/hcm-engagement.prisma:208 | General grievance model absent. Immutability and no-delete on complaints: UNVERIFIED. Independent routing: UNVERIFIED. | M |
| M12 | Decision history, handover packs and document version ownership survive turnover | 6 | MISSING | Handover: 0 hits in apps/, docs/plan. Audit: apps/api/prisma/schema/main.prisma:1076 AuditRecord. Versions: PolicyVersion main.prisma:717. | Model HandoverPack (scope, open items, owner transfer, acknowledgement). Owner transfer must go through assertCan and auditWrite. | M |
| M13 | Versioned SOP change; a lesson changes a policy and is checked later | 6 | PARTIAL | PolicyVersion apps/api/prisma/schema/main.prisma:717; Policy main.prisma:698; IT policy governance apps/api/src/domains/it/governance/policies.ts:151 | No lesson-to-policy link or later check. | S |
| M14 | Initiative budgets, funding gates, unit economics and review dates | 6, 32 | PARTIAL | apps/api/src/domains/it/portfolio.ts:135 createInitiative, :255 transitionInitiative, :323 postInitiativeUpdate; spend apps/api/src/domains/marketing/budget.ts:309 recordSpend; Round funding gates apps/api/src/domains/rounds.ts:179 openRound | Unit economics per initiative: UNVERIFIED. Stage gates exist for IT portfolio only. | M |
| M15 | Dashboards show source links, timestamps, confidence and unresolved-evidence markers | 4, 6, 7 | PARTIAL | KPI value states packages/shared/src/ceo.ts:23 (KPI_VALUE_STATES), :29 (COCKPIT_SNAPSHOT_STATES); withheld entries packages/shared/src/api.ts:37 WithheldEntry | Generic evidence marker on every number is not enforced: Metric drillTo/noActionReason is optional (CLAUDE rule 7). | M |
| M16 | Priority feedback loop: urgent routing, severity not popularity, challenged assumptions, corrective action, verification | 7, 3 | PARTIAL | Exception routing apps/api/src/platform/exceptions.ts:57 raiseException, :178 escalateException, :230 severityToPriority | Feedback capture and loop: MISSING. Question generation by AI: not permitted to act; see advisor notes. | L |
| M17 | Founder and directors may see sensitive data only with purpose and authority | 8 | PARTIAL | FIELD_PURPOSES packages/shared/src/api.ts:47; applyFieldVisibility packages/shared/src/api.ts:62; MONEY_FIELDS packages/shared/src/permissions.ts:324 | Purpose capture at access time: UNVERIFIED. | S |
| M18 | Compensating control with review schedule where segregation is not possible | 8 | MISSING | grep "compensating": 0 in apps/ and packages/. | Model CompensatingControl (riskRef, owner, reviewDueOn, evidence). | S |
| M19 | External counter-acceptance never grants internal approval rights | 8 | UNVERIFIED | No portal code: apps/web/src/pages has no portal directory (ls). | Depends on portal (D-section, K-section). | M |
| M20 | Guardians: verified, consent-sensitive, revocable access | 8 | PARTIAL | Minor gate apps/api/src/domains/compliance/privacy.ts:321 MinorGateInput, :334 requireGuardianConsentForMinor; consent withdrawal :241 | Guardian verification and guardian portal: MISSING. | M |
| M21 | Auditors and administrators: time-bounded evidence access; admin does not grant finance or HR access | 8 | PARTIAL | AccessReview apps/api/prisma/schema/compliance-privacy.prisma:209; apps/api/src/domains/it/governance/accessReviews.ts | Time-bounded grant: UNVERIFIED. Admin-separation rule: UNVERIFIED. | S |
| M22 | Group structure: multiple legal entities, consolidation, intercompany | 1, 8, 9 | PARTIAL | Group consolidation apps/api/src/domains/group.ts:203 buildEntitySnapshot, :371 groupStructure, :718 aoc1; tenant kinds packages/shared/src/api.ts:155 (holding, subsidiary, standalone) | Intercompany: MISSING (grep "intercompany|Intercompany": 0 in code). Model differs: CLAUDE.md says multi-tenant per entity, proposal says multiple legal entities under one group. See decision D1. | L |
| M23 | Specialised workflow archetypes (education, institutional, software) and Consultancy, not a generic switcher | 1, 9 | PARTIAL | VERTICALS packages/shared/src/domain.ts:9; onboarding apps/api/src/domains/onboarding.ts:64 | Consultancy archetype: UNVERIFIED (not in TENANT_KINDS api.ts:155). | M |
| M24 | Customer and institution contacts see agreed milestones, documents, invoices; internal margins concealed | 8 | PARTIAL | applyFieldVisibility packages/shared/src/api.ts:62; MONEY_FIELDS packages/shared/src/permissions.ts:324 | No external contact surface. See K9, D9. | M |
| M25 | Employees: own records only; self-service without others' private HR data | 8 | PARTIAL | HR request workflow apps/api/src/domains/hcm/workflow.ts:273 submitRequest, :337 getRequest; attendance corrections apps/api/prisma/schema/hcm-time.prisma:202 AttendanceRegularisation | Field visibility test for others' HR data: UNVERIFIED. | S |

### D. p09 capability map (13 domain rows)

| ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| D1 | Organisation: legal entities, units, locations, positions, reporting lines, calendars, authority, policy ownership | 9 | PARTIAL | OrgUnit, Location (grep "Location|OrgUnit" in MAP.md), Position apps/api/prisma/schema/main.prisma:4199, ReportingLine, PayrollCalendar; authority ceiling apps/api/src/platform/permissions.ts:295 resolveAuthorityCeiling; group apps/api/src/domains/group.ts:203 | Legal entity as first-class record: UNVERIFIED in tenant model. Policy ownership exists (Policy main.prisma:698). | M |
| D2 | CRM and commercial: multi-pipeline leads, institutions, contacts, products, prices, proposals, contracts, renewals, referrals, credit checks | 9 | PARTIAL | Pipelines apps/api/src/domains/pipelines.ts:38 PipelineInput; PriceBookEntry apps/api/prisma/schema/main.prisma:1652; offerings apps/api/src/domains/commercial.ts:32 OfferingInput; renewals apps/api/src/domains/agreements.ts:524 renewAgreement, apps/api/src/domains/opportunities.ts:104 openRenewalOpportunity; referrals apps/api/prisma/schema/main.prisma (MarketingReferral, Referral); win/loss apps/api/src/domains/winLoss.ts:37 | Proposals: UNVERIFIED. Credit checks: MISSING (grep "creditCheck|creditLimit": 0). | L |
| D3 | Finance ERP: accounts, journals, receivables, payables, receipts, credits, bank reconciliation, cash forecast, budgets, assets, close, tax, payroll interfaces | 9 | PARTIAL | Ledger writes apps/api/src/domains/books.ts:264 recordTransaction, :361 reverseTransaction; payables apps/api/src/domains/books.ts:548 payVendorBill, :600 payablesAgeing; credit notes apps/api/src/domains/finance.ts:372; period close apps/api/src/domains/compliance/books.ts:98 requestClosePeriod, :117 closePeriod, :144 reopenPeriod; fixed assets apps/api/src/domains/compliance/books.ts:414, :447 depreciationReport; payroll journal shape packages/shared/src/hcm/payrollops.ts:63 buildPayrollJournalLines | Money typed as number and float in finance paths: CLAUDE.md rule 1, root cause apps/api/src/platform/db.ts:150 num(). Books writes must go through platform/ledger.ts post() (CLAUDE rule 2): not verified for every path. | L |
| D4 | Procurement and assets: purchase requests, vendor onboarding, quotes, orders, receipt, invoice matching, beneficiary changes, inventory, asset custody | 9 | PARTIAL | Asset custody: Asset apps/api/prisma/schema/hcm-assets.prisma:12, AssetAssignment :42, createAsset apps/api/src/domains/hcm/assets.ts:107; IT assets apps/api/src/domains/it/assets.ts:67; vendors apps/api/src/domains/it/vendors.ts:674 (IT vendors); marketing vendors apps/api/src/domains/marketing/budget.ts:540 | Purchase request, quote, PO, goods receipt, three-way match, beneficiary (vendor bank) change, inventory: MISSING (grep "purchaseOrder|purchaseRequest|PurchaseOrder|goods receipt|three.way": 0 relevant hits). Vendor bank-change control: MISSING. | L |
| D5 | HRM and capability: hiring, employment, onboarding, attendance, leave, benefits, compensation inputs, performance, learning, allocation, grievance, exit | 9 | PARTIAL | Recruiting apps/api/src/domains/hcm/recruiting.ts:48; leave apps/api/src/domains/hcm/leavepolicy.ts:54; benefits BenefitPlan apps/api/prisma/schema/hcm-compensation.prisma:149; performance apps/api/src/domains/hcm/performance.ts:87; learning apps/api/src/domains/hcm/learning.ts:89; separations apps/api/src/domains/hcm/separations.ts:96; skills/evidence apps/api/src/domains/capability.ts:49 | Allocation: MISSING (M1). Grievance: POSH only (M11). Capability evidence exists (M10 risk). | L |
| D6 | Projects and service delivery: scope, estimates, milestones, resource plans, work logs, changes, QA, deployment, acceptance, support, project economics | 9 | PARTIAL | Project apps/api/prisma/schema/main.prisma:3661 (status, dates, healthBand, scheduleVariancePct, handoffAcceptedAt); IT service desk apps/api/src/domains/it/servicedesk.ts:6 | Milestones, estimates, change requests, QA, acceptance, project economics: MISSING (grep "model Milestone|model Estimate|model Quote": no hits for project delivery). | L |
| D7 | Education: offering approval, fee plans, cohorts, trainer readiness, timetable, attendance, assessment, credentials, learner support, institutional billing | 9 | PARTIAL | Courses apps/api/src/domains/courses.ts:46 CourseInput, :443 assignCourse; CourseFeePlan apps/api/prisma/schema/main.prisma:3435; Cohort :3481; Enrollment :3511; fee instalments apps/api/src/domains/finance.ts:62 issueFeeInstalments; students apps/api/src/domains/students.ts:43; institutional billing apps/api/src/domains/receipts.ts:275 raiseFinalInvoice; training apps/api/src/domains/education.ts:25 enrolStudent | Timetable: MISSING (grep "timetable": 0). Assessment: MISSING (grep "model Assessment": 0). Trainer readiness: UNVERIFIED. Learner attendance model: UNVERIFIED (Attendance main.prisma:3573 is staff, not confirmed). | L |
| D8 | Marketing: campaigns, consented audiences, content approvals, lead-source capture, spend, attribution, experiments, conversion to collected contribution | 9 | PARTIAL | Campaigns apps/api/src/domains/marketing/campaigns.ts:253 createCampaign, :509 approveCampaign; audiences apps/api/src/domains/marketing/audiences.ts:576; capture apps/api/src/domains/marketing/capture.ts:331 submitPublicForm; spend apps/api/src/domains/marketing/budget.ts:309, :377 reconcileSpend; attribution apps/api/src/domains/marketing/attribution.ts:42; consent ledger apps/api/prisma/schema/compliance-privacy.prisma:54 | Experiments: MISSING (M5). Conversion to collected contribution: UNVERIFIED. Plan: docs/plan/marketing.md (PLANNED). | M |
| D9 | Customer success: onboarding, service ownership, support, complaint handling, renewal, account review, outcome evidence | 9 | PARTIAL | Onboarding task templates (OnboardingTaskTemplate, main.prisma); renewal apps/api/src/domains/agreements.ts:524; outcome of sales only apps/api/src/domains/winLoss.ts:37 | Customer complaint model: MISSING (grep "model Complaint|CustomerComplaint": 0). Customer support queue: MISSING. Account review: MISSING. Outcome evidence after delivery: MISSING. | L |
| D10 | Communication and meetings: shared WhatsApp and email inboxes, managed calling, recordings, transcripts, notes, meeting actions, delivery states, capture health | 9 | PARTIAL | See R7 and R8. Board meetings apps/api/src/routes/compliance/corporate.routes.ts:125, :150 record. Interaction notes apps/api/src/domains/interactions.ts:105. | Shared inboxes, calling, recordings, transcripts, meeting actions, capture health: MISSING. | L |
| D11 | Documents and knowledge: uploads, scanning, metadata, versions, templates, approvals, signatures, acknowledgements, retention, controlled retrieval | 9 | PARTIAL | Document apps/api/prisma/schema/main.prisma:2086; EntityDocument; PolicyAcknowledgement (main.prisma); AnnouncementAck apps/api/prisma/schema/hcm-engagement.prisma:48; retention rule DocumentRetentionRule and RetentionSchedule apps/api/prisma/schema/compliance-privacy.prisma:176; retention sweep apps/api/src/domains/compliance/books.ts:202 sweepRetention | Scanning (grep "scan|ocr": 0 relevant). Signatures (grep "signatureRequest|model Signature": 0). Document version chain and approval workflow: UNVERIFIED. | L |
| D12 | Governance and strategy: decision ledger, policy versions, delegations, risks, compliance calendar, objectives, funding gates, improvement reviews | 9 | PARTIAL | Decision apps/api/prisma/schema/main.prisma:852; policies apps/api/src/domains/it/governance/policies.ts:151; delegations apps/api/src/domains/hcm/workflow.ts:552; IT risks apps/api/src/domains/it/governance/risks.ts:53 scoreAgainstBands, ItRisk apps/api/prisma/schema/it-governance.prisma:46; compliance calendar apps/api/src/domains/compliance/calendar.ts:85 generateObligations; objectives: stub apps/web/src/pages/ceo/Okrs.tsx:8; funding gates apps/api/src/domains/it/portfolio.ts:255 | Enterprise risk register beyond IT: UNVERIFIED. Objectives and key results: MISSING (page is a stub). Improvement reviews: MISSING (win/loss only). | L |
| D13 | Platform operations: access, audit, integration monitoring, alerts, backups, recovery, mobile capture, export, bounded AI assistance | 9 | PARTIAL | Access assertCan apps/api/src/platform/permissions.ts:317; audit apps/api/src/platform/audit.ts:37 registerGovernedEntities, :134 isGoverned; AuditRecord main.prisma:1076; backups BackupRun apps/api/prisma/schema/compliance-corporate.prisma:28; continuity plan apps/api/src/domains/it/continuity.ts:71; export apps/api/src/domains/compliance/books.ts:607 trialBalanceCsv, :653 tallyExportXml; agents AgentPrincipal apps/api/prisma/schema/main.prisma:3848, AgentAction :3870; integration webhook settings apps/api/src/routes/marketing/settings.routes.ts:16 recentWebhooks; alerts Notification apps/api/prisma/schema/main.prisma:3747 | Integration monitoring: PARTIAL (marketing webhooks only). Mobile capture: MISSING native; mobile-first PLANNED only (docs/plan/phase-4-interface.md:55). Restore drill: PLANNED (docs/plan/README.md:56). Bounded AI assistance: MISSING runtime (CLAUDE.md: zero model calls); AgentAction is a record shape only. | L |

### E. p75 capability traceability (19 rows)

| ID | Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|---|
| K1 | Live CCTV viewer: authorised site/camera stream, revocable session, separate export rights | 75 (ch.10) | MISSING | grep "CCTV|camera stream|rtsp": 0 in apps/ and schema. Phase 4 "camera" refers to expense capture only: docs/plan/phase-4-interface.md:55. | Do not build before a privacy impact assessment. Employee monitoring requires lawful basis and notice. See advisor notes. | L |
| K2 | Employer and employee CTC: effective-dated package; employer cost, gross and net kept distinct | 75 (ch.26) | PARTIAL | Compensation apps/api/src/domains/hcm/compensation.ts:61; compa ratio packages/shared/src/hcm/compensation.ts:20; SalaryStructure and SalaryRevisionLine (docs/plan/hcm.md:141). CTC component models planned: docs/plan/compliance.md:263 (PLANNED). | Separate employer-cost, gross and net components as statutory rules (CLAUDE rule 4). Component definitions depend on labour-code wage rules: UNVERIFIED current status. | M |
| K3 | Pantry and voluntary breaks: aggregate stock planning; private opt-in reminders | 75 (ch.26) | MISSING | grep "pantry": 0. Inventory: 0 models (grep "model Inventory|StockItem": 0). | Low priority. Needs inventory (D4) and opt-in notification model. | S |
| K4 | Connected work and repetitive tasks: shared identity, one traceable action across views | 75 (ch.23,39,43) | PARTIAL | Automation definition apps/api/prisma/schema/main.prisma:3775 AutomationDefinition; jobs apps/api/src/jobs/scheduler.ts; identity apps/api/src/domains/identity.ts | Traceable action chain across domains: UNVERIFIED. | M |
| K5 | College fees and automatic payments: approved assumptions, mandate, settlement, reconciliation | 75 (ch.25,38) | PARTIAL | CourseFeePlan main.prisma:3435; FeeInstalment; issueFeeInstalments apps/api/src/domains/finance.ts:62; recordPayment :99; overdue detect :434 | Payment mandate (automatic debit): MISSING (grep "mandate|nach|autopay": 0). Settlement reconciliation to bank: partial via books.routes.ts:199. | L |
| K6 | Employee salary account management: verified changes, frozen payee versions, confidential payment resolution | 75 (ch.25,26,48) | PARTIAL | Outgoing bank advice apps/api/prisma/schema/hcm-payrollops.prisma:146 BankAdvice; payroll approvals apps/api/src/routes/hcm/payrollops.routes.ts:80,105 | Payee or bank account model: MISSING (grep "BankAccount|PayeeAccount": 0). Maker-checker on account change: MISSING. | M |
| K7 | Business plans and management tools: scenario assumptions, owned execution, actual-versus-plan | 75 (ch.32) | PARTIAL | Plans apps/api/src/domains/marketing/plans.ts:51 createPlan, :121 approvePlan; budget variance apps/api/src/domains/marketing/budget.ts:420 budgetVariance; cash scenarios apps/api/src/domains/books.ts:1308 | Enterprise business-plan entity with scenarios: MISSING. | M |
| K8 | Priority feedback and deeper questions: urgent routing, challenged assumptions, checked corrective action | 75 (ch.3,28,32) | MISSING | Routing: apps/api/src/platform/exceptions.ts:57, :230. Assumption challenge and corrective-action loop: no model (grep "Feedback" returns HR only). | See M16. | L |
| K9 | Customer, client and stakeholder feedback: contextual intake, owned action, customer update, verified outcome | 75 (ch.28,36,48) | MISSING | No customer feedback model. HR feedback only: apps/api/prisma/schema/hcm-performance.prisma:171. Interaction log apps/api/src/domains/interactions.ts:105 is the nearest base. | Model FeedbackItem (source, context refs, owner, actionDueOn, response, verifiedOutcome). | M |
| K10 | Lead and relationship database: deduplicated enquiries with source, permission and next action | 75 (ch.23) | PARTIAL | Lead apps/api/prisma/schema/main.prisma:1464; createLead apps/api/src/domains/leads.ts:91; routeLead apps/api/src/domains/routing.ts:141; relationships apps/api/src/domains/relationships.ts:37; untouched-lead detection apps/api/src/domains/leads.ts:400 | Deduplication: MISSING (SC5). Source and permission capture on lead: UNVERIFIED in fields. | M |
| K11 | Video calls, classes and transcripts: controlled sessions, correctable source-linked evidence | 75 (ch.27,30) | MISSING | No call, session-recording or transcript model. Plan mention only: docs/plan/phase-6-intelligence.md (transcript, 1 hit). | Consent per participant, retention, and provider region (DPDP). See advisor notes. | L |
| K12 | Full LMS: content version, enrolment, assessment, progress, certificate | 75 (ch.13,27) | PARTIAL | Programs and sessions apps/api/src/domains/hcm/learning.ts:89, :157; enrolment apps/api/src/domains/hcm/learning.ts:253 nominate; certifications apps/api/src/domains/hcm/learning.ts:448; student enrolment apps/api/src/domains/education.ts:25; courses apps/api/src/domains/courses.ts:67 | Content versioning: MISSING. Assessment: MISSING (grep "model Assessment": 0). Learner-facing certificate: UNVERIFIED (Certificate model at compliance-corporate.prisma:277 is corporate). | L |
| K13 | Digital marketing: approved campaign, consent, routed lead and reconciled spend | 75 (ch.15,23) | PARTIAL | See D8. Spend reconciliation apps/api/src/domains/marketing/budget.ts:377 reconcileSpend; plan docs/plan/marketing.md (PLANNED) | Experiments and conversion to collected cash: MISSING or UNVERIFIED. | M |
| K14 | GST and legitimate cash: documented tax treatment, cash custody, accountant-reviewed exceptions | 75 (ch.24,25) | PARTIAL | GST returns apps/api/src/domains/gstReturns.ts; tax apps/api/src/domains/compliance/tax.ts; FY helper apps/api/src/domains/compliance/tax.ts:60-66 (contains FIX F1); petty or cash custody: UNVERIFIED | Cash custody model and accountant-review workflow: MISSING. "Legitimate cash" is undefined in the proposal (see decision D7). Statutory: see advisor notes. | M |
| K15 | Ventures research and grant discovery: sourced evidence, verified funding eligibility and deadline | 75 (ch.16,22) | MISSING | "Grant" in code is an access grant: apps/api/prisma/schema/main.prisma:744 Grant (principalType, roleId). Funding rounds apps/api/prisma/schema/main.prisma:2428 FundingRound are equity rounds (rounds.ts:68). No grant-funding or research model. | Name collision (F6). Sourced research with AI drafting must not be treated as verified evidence. | M |
| K16 | Managed service provider: entitled service, provisioning, incident, change and renewal trail | 75 (ch.17,28) | MISSING | Internal ITSM only: apps/api/src/domains/it/itsm.ts:100 currentPolicy, DeclareIncident; licences apps/api/src/domains/it/software.ts:348 createLicence; continuity apps/api/src/domains/it/continuity.ts:71. | External service-entitlement and client-facing provisioning: MISSING. Scope ambiguity (decision D7). | L |
| K17 | Company chatbot and coding agents: bounded tools, authorised evidence, evaluated model and runtime choice | 75 (ch.41,43) | MISSING | Models only: AgentPrincipal apps/api/prisma/schema/main.prisma:3848, AgentAction :3870; AI prohibitions file exists packages/shared/src/ai.ts (content UNVERIFIED). CLAUDE.md: zero model calls in repo. | Build only behind Phase 5 semantic layer (packages/semantic) and Phase 6 gateway. No text-to-SQL. Hard approval prohibitions in packages/shared/src/ai.ts. | L |
| K18 | Claude Team integration: governed seats, connectors, sharing and offboarding | 75 (ch.43) | MISSING | Licence register only: apps/api/src/domains/it/software.ts:331 CreateLicenceInput, :348 createLicence. Plan: docs/plan/cio.md mentions seats (PLANNED-adjacent, UNVERIFIED). | Seat, connector and offboarding governance: MISSING. Vendor data-processing terms: UNVERIFIED. | M |
| K19 | Home and hybrid work facilities: approved kit, support, secure workspace, coordinated exit | 75 (ch.26,41,48) | MISSING | Kit issue via asset assignment apps/api/src/domains/hcm/assets.ts:107 and AssetAssignment apps/api/prisma/schema/hcm-assets.prisma:42; exit apps/api/src/domains/hcm/separations.ts:96. Secure workspace: no model (not app-level). | Asset-return on exit is a plausible link (I-section). Workspace security is outside the app. | S |

## Fixes

| ID | Where | Problem | Why it matters | Test that fails on old code |
|---|---|---|---|---|
| F1 | apps/api/src/domains/compliance/tax.ts:61-62 (fyOf) | Uses getUTCMonth() and getUTCFullYear(). CLAUDE.md rule 3 forbids this for FY. | 1 April 00:00-05:30 IST falls in previous FY. Invoice series and TDS periods shift. | fyOf(new Date('2026-03-31T19:00:00Z')) must equal '2026-27' (IST 1 Apr 00:30). Old code returns '2025-26'. |
| F2 | apps/api/src/domains/decisions.ts:34 (RaiseDecisionInput.requiredAuthorityValue?: number) and Decision.requiredAuthorityValue Decimal(18,2) at apps/api/prisma/schema/main.prisma (~862) | Money as number and Decimal. | CLAUDE rule 1: signed bigint paise only. | Type-level test or a raise with 0.1+0.2 threshold rejected or stored as paise. |
| F3 | apps/api/src/platform/exceptions.ts:51 passesFourPropertyTest | Exported, zero callers (grep). raiseException:57 does not enforce it. | Exceptions without owner or detail can be raised. Proposal wants owned and actionable exceptions. | raiseException without ownerPartyId and accountablePositionId must be rejected. |
| F4 | apps/api/src/domains/capability.ts:406-420 findCapableParties | Orders persons by confidenceRank and returns top 50. | Conflicts with p06 "do not rank by believability". Use as matching for a named skill only; no cross-person ordering in UI. | Test that the API does not return an ordered list of persons for a skill without a named request context. (Design decision first.) |
| F5 | apps/api/prisma/schema/main.prisma:905 Delegation and apps/api/prisma/schema/hcm-workflow.prisma:109 DelegationOfAuthority | Two delegation models, no evident link. | SC7 (24h absence) needs one authority source. | Delegation granted in one model is honoured by the other: UNVERIFIED. |
| F6 | apps/api/prisma/schema/main.prisma:744 Grant | Name collision: "grant" in code means RBAC permission grant. Proposal "grants" means funding. | Naming risk in a multi-owner plan. | Rename decision, not a test. |

## Interconnections

| ID | Ends | Missing link | Evidence |
|---|---|---|---|
| I1 | Opportunity (won) → Contract → Project → Invoice → Collection | Contract and Project have FKs (main.prisma:3661 contractId, opportunityId). No path to a collection case (no model). Won-without-contract is detected only by sweep. | agreements.ts:571; main.prisma:3661 |
| I2 | ComplianceObligation → Task / Exception / Owner | Unowned flagged as exception (calendar.ts flagUnowned) but no task creation or owner stored on row. | calendar.ts:36-~60; compliance-calendar.prisma:70 |
| I3 | Decision ↔ Obligation / Project / Contract | Generic subjectType and subjectId exist (main.prisma:~858-860). No typed link; execution owner absent. | main.prisma:852-900 |
| I4 | Decision ↔ ApprovalStep | Two approval shapes: ApprovalStep (main.prisma:810) and Decision.routedToRole. ceo-office.md:66 and :108 says Decision is reused and not a second flow (PLANNED). | Plan vs code: consistent in plan, not yet built. |
| I5 | Marketing delivery events ↔ CRM interactions | applyDeliveryEvents (messaging.ts:918-936) updates recipient rows. Writing to interaction log: UNVERIFIED. | messaging.ts:918; interactions.ts:105 |
| I6 | Exceptions ↔ CEO attention queue ↔ Workspace Exceptions page | attentionQueue (commandCenter.ts:244) and Exceptions page (Workspace.tsx:220) both show exceptions. Link by shared table is likely but not opened. | UNVERIFIED join |

## Advisor notes (what the proposal misses)

Each MISSING or PARTIAL item needs: data model, controls (assertCan, auditWrite, emit), statutory angle (flagged, not asserted), plan dependency. Plan phases: 0 stabilise, 1 ledger, 2 audit, 3 statutory, 4 interface, 5 semantic, 6 intelligence, 7 product, 8 proof.

Founder exception view (SC1), obligation owner-backup-next-action (SC2), decision dissent and execution owner (SC4), duplicate-entry metric (SC5), negative suite (SC6), founder-absence test (SC7):
- Models: ObligationOwnership (ownerPartyId, backupPartyId, nextAction, nextActionDueOn, setBy); DecisionDissent (decisionId, partyId, statement, evidenceRef); Decision.executionOwnerPartyId; EntryMetric (workflowKey, duplicateCount, sampleWindow).
- Controls: assertCan on each write; auditWrite on owner changes; tenant scope on every query; founder view gated by purpose (M17).
- Statutory: none direct. Obligation dates come from StatutoryRule rows, not constants (CLAUDE rule 4).
- Phase: SC1 needs Phase 4 interface (drillTo, CLAUDE rule 7); SC2-SC4 Phase 2 audit and Phase 1 ledger for money fields; SC6 Phase 8 proof.
- Size: S for dissent and owner fields; M for the cockpit; M for the test suite.

Collection cases (R4):
- Model: CollectionCase (receivableRef, tenantId, ownerPartyId, backupPartyId, state, promisedOn, promiseSource, nextAction, nextActionDueOn). Promises are not cash: forecast reads only posted receipts.
- Controls: assertCan resource collections; contact attempts logged via interaction log; no automated customer email without human approval (CLAUDE hard prohibitions in packages/shared/src/ai.ts).
- Statutory: MSME Development Act 2006 payment timelines apply to MSME buyers. Flag: confirm applicability and current rule; store as StatutoryRule (CLAUDE rule 4), do not hardcode 45 days.
- Phase: Phase 1 ledger (receipts must post via post()). Size L.

Communication capture (R7, R8, D10, K11):
- Models: Conversation, Message (direction, deliveryState, providerRef), CallRecord, Recording, Transcript (sourceId, consentRef, retainUntil), CaptureGap (provider, detectedAt, impact).
- Controls: consent per participant before recording; retention rule per tenant; provider region must be India for tenants requiring India inference (CLAUDE rule on personal data to inference APIs).
- Statutory: DPDP Act 2023 notice and consent for recording and transcription; TRAI rules for calling and messaging apply: flag, verify with counsel. Recording consent law varies: UNVERIFIED for this use.
- Phase: Phase 4 interface; Phase 6 for transcription (intelligence tier). Size L.

Live CCTV (K1):
- Privacy impact assessment before any build. Employee monitoring needs lawful basis and disclosed purpose (DPDP). Do not build without decision D8.
- Size L. Plan: none (phase-4 camera refers to expense capture).

CTC and salary account (K2, K6):
- Models: CompensationPackage (effectiveFrom, effectiveTo, components with kind: employer_cost | gross | net), PayeeAccount (versioned, verifiedAt, verificationMethod, makerId, checkerId, cooldownUntil).
- Controls: maker-checker on payee change; freeze payee version per pay run; payroll preparation and final payment authorisation separated (p08 says this).
- Statutory: Code on Wages 2019 wage definition and other labour-code rules were consolidated in late 2025: effective dates and current wage definition must be confirmed before any component rule is coded. Flag, do not assert.
- Phase: Phase 3 statutory (StatutoryRule rows). Size M.

College fees and automatic payments (K5):
- Models: PaymentMandate (payerRef, limit, frequency, status, authRef), Settlement (mandateId, bankStatementLineId).
- Statutory: RBI e-mandate framework for recurring card and bank debits (limits and authentication). Flag: confirm current rule. Not asserted here.
- Size M. Phase 1 ledger for settlement.

GST and legitimate cash (K14):
- Statutory uncertainty to flag: Income-tax Act 2025 replaced 1961 Act from 1 April 2026 (docs/plan/phase-3-statutory.md:35). Cash receipt limits and penalty sections were numbered under the old Act; the new section mapping: UNVERIFIED. CGST cash-ledger rule (Rule 86B) thresholds and exemptions: UNVERIFIED.
- Model: CashCustody (custodianPartyId, limit, count, reviewedBy, reviewedOn). Accountant-review exception queue.
- Size M. Phase 3.

Procurement (D4):
- Models: PurchaseRequest, Quote, PurchaseOrder, GoodsReceipt, VendorInvoiceMatch (three-way), VendorBankChange (verifiedAt, maker, checker, cooldown).
- Controls: vendor bank change is a top fraud vector: maker-checker and out-of-band verification required.
- Statutory: MSME payment timelines and TDS on vendor payments (already in compliance/tax.ts:149 computeVendorTds). Size L. Phase 1.

Projects and delivery (D6, M4, R5):
- Models: Milestone (projectId, dueOn, acceptanceCriteria, acceptedAt, acceptedBy), Estimate (versioned, approvedBy), ChangeRequest (scopeDelta, estimate, commercialResponse, decisionId), DeliveryEvidence (artifactRef, versionRef, acceptanceRef).
- Controls: change approval via decision record; acceptance by customer counter-signature must not grant internal approval (p08).
- Size L. Phase 1 for project economics.

Education (D7, K12):
- Models: Assessment, AssessmentResult, ContentVersion, TimetableSlot, TrainerReadiness (trainerPartyId, competencies, checkedOn). Learner data: minors gate exists (privacy.ts:321).
- Statutory: approval or affiliation rules for courses or institutions (e.g. sector regulators): UNVERIFIED; leadership should confirm which programmes need external approval.
- Size L.

Customer feedback and complaints (K8, K9, D9, M16):
- Model: FeedbackItem (see K9), Complaint (severity, routedTo, outcome, verifiedAt). Urgent safety, learner and cash routing via exceptions.
- AI may cluster themes and propose questions (p07) but must not set priority. This is an AI-decision line: owners decide.
- Size M.

Ventures and grant discovery (K15):
- Model: GrantOpportunity (sourceRef, fetchedAt, eligibilityRules, deadline, verifiedBy). Evidence must be sourced; AI summary carries confidence and is never the record.
- Size M. No statute.

Chatbot and coding agents (K17, K18, M-AI):
- Data residency: personal data to an inference API requires applyFieldVisibility (packages/shared/src/api.ts:62) and India-region inference where the tenant requires it (CLAUDE.md).
- Hard prohibitions (no journal post, no IRN, no filing, no payroll run, no customer email without approval) in packages/shared/src/ai.ts (content UNVERIFIED).
- Claim discipline: the proposal's "AI-native" and "Claude Team integration" lines must not be presented as live (CLAUDE.md).
- Size L.

Home and hybrid (K19), pantry (K3), Ventures (K15), MSP (K16): low ROI for first release. Recommend deferral. Pantry and voluntary breaks are not finance or statutory items. Home workspace security is outside app scope.

Organisation and group (D1, M22):
- Intercompany is absent. Consolidation exists as snapshot publishing (group.ts:279 publishEntitySnapshot).
- Multi-tenant model per CLAUDE.md conflicts with "multiple legal entities" if the proposal means one tenant with entity dimension. Decision D1.

## Proposal risks and omissions

1. Scope size. 19 p75 capabilities plus 13 p09 domains is roughly 60 modules. Proposal says release phases select workflows, but gives no first-release list. Only p04 names pilots (education, institutional, software workflows, plus Consultancy archetype).
2. Missing statutory and privacy controls: DPDP consent and notice for CCTV, recording, transcripts, guardian access; payment mandates; wage-code components; GST cash and tax-section renumbering. The proposal lists none of these as gates.
3. No money representation rule (signed paise) and no ledger-only write rule in the proposal, though p05 talks about money states.
4. "Dashboards reveal evidence quality and freshness" (p04) has no definition or threshold.
5. p04 success criteria have no thresholds or baselines. Duplicate-entry reduction has no target number. Approval-delay and admin-burden metrics (p06 says measure them) are not in the acceptance list.
6. No owner named for any capability. p04 says "every commitment has an owner" but the proposal does not name who owns each domain.
7. AI boundaries stated softly ("AI may propose", "bounded AI assistance") but no list of prohibited actions. CLAUDE.md has hard prohibitions.
8. Cross-references to chapters 1-48 (p75) point to a document not in this packet. UNVERIFIED.
9. "Claude Team integration" and "company chatbot and coding agents" name a vendor and a runtime without vendor-terms or data-residency analysis.
10. p05 says "discovery should establish actual systems of record" but the proposal assumes Kaizen's systems are Zen-compatible; no reuse decision is specified. Not verified here.
11. Proposal conflates "grants" (funding) with access grants (code). Name collision risk (F6).
12. p07 defines severity versus popularity but no severity scale is defined; exceptions use S1-S3 codes (exceptions.ts:230 severityToPriority).
13. Founder exception view has no defined content list and no permission model beyond "sensitive access requires purpose".
14. The 24-hour founder absence test is proposed without the delegation rules that must exist for it to pass (F5).

## Decisions for leadership

D1. Legal-entity model: one tenant per legal entity with group consolidation (current: group.ts, TENANT_KINDS holding/subsidiary/standalone api.ts:155), or one tenant with an entity dimension? CLAUDE.md commits to multi-tenant. Choose before any intercompany work.
D2. First-release scope: name the pilot archetypes and the capability rows in scope. Recommend excluding K1 (CCTV), K3 (pantry), K15 (ventures), K16 (MSP), K19 (hybrid) from first release.
D3. Collection cases (R4): approve a CollectionCase model on the Phase 1 ledger, and who owns the collections policy.
D4. Communication capture: which providers (WhatsApp Business, email, calling), recording policy, consent wording, and retention. This is a legal decision, not product.
D5. Personal data and AI: approve a data-residency rule for any model call (India-region inference for tenants requiring it) before K17 or K18.
D6. Metrics and thresholds: baseline and target for duplicate-entry reduction (SC5), approval delay (p06), obligation owner coverage (SC2). Assign an owner for the measurement.
D7. Define "legitimate cash" (K14), "consultancy archetype" (M23), "managed service provider" (K16) in one sentence each.
D8. Camera and monitoring (K1): stop or proceed. Requires privacy impact assessment first.
D9. Statutory sign-off: name the person who signs statutory uncertainty items (CTC components, payment mandates, GST cash, tax-section renumbering). CLAUDE.md requires stop-and-flag.
D10. Founder absence cover: name the delegate for each founder-level approval and the limits. Required for SC7.
D11. Decision ledger: confirm dissent, execution owner and evidence versioning as required fields (SC4), and that Decision is the only record (ceo-office.md:66).
D12. Budget and capacity for discovery (p04 closing paragraph): the cap and team. The proposal gives no figure.

## Counts

Status totals across the 72 capability rows (Sections A-E):
- EXISTS: 0 rows. No proposal capability is fully present; evidence exists for parts only.
- PARTIAL: 52 rows.
- MISSING: 19 rows.
- FIX: 6 (F1-F6), listed separately, not counted in the rows above.
- INTERCONNECT: 6 (I1-I6), listed separately.
- PLANNED: referenced inline (CTC components, Decision reuse, marketing, mobile-first, restore drill).
- UNVERIFIED: 1 row as a status (M19), plus inline UNVERIFIED markers where a field or file could not be opened.
