# DECISIONS — merged leadership decision register

Merged from the twelve analysis files and `docs/plan/README.md` decisions A/B/C (A = D-01, B = D-06, C = D-05). Near-identical items from different agents are folded into one row; the agent source is in the Decision column. Nothing below is an engineering default: each needs a named owner. "Blocks" lists CAP rows that cite the decision, computed from CAPABILITIES.md, plus plan phases. Deadlines are plan phases (P0 to P8, CEO-n = `docs/plan/ceo-office.md` phase n).

Statutory and legal items are flagged for professional sign-off, not decided here (CLAUDE.md "Statutory uncertainty").

| ID | Decision | Options | Recommendation + reason | Blocks (CAP/phase) | Deadline (before) |
|---|---|---|---|---|---|
| D-01 | Legal-entity and group model, and the intercompany mechanism (README decision A; agents 02 D1/D2, 06 D1) | (a) Tenant = legal company, group by tenant tree and snapshots (runs today; `CompanyProfile.tenantId @unique` `main.prisma:97`). (b) One tenant with many `LedgerEntity` rows (schema intent `compliance-books.prisma:54`). (c) Tenant = legal company, `LedgerEntity` only for branch/GSTIN units inside a tenant. Intercompany: Transaction flag + pairing record vs reciprocal journal entries via `post()`. | Recommend (c). Rule 6 and the one-company-per-tenant constraint make the tenant the legal entity; the `entityId` column on the journal already exists (README A is satisfied in schema, unused). Pair intercompany rows now (cheap), post reciprocal entries through `post()` once Phase 1 lands. Confirm with the accountant (D-02). | GRP 01/03/19, FND 01/02, MED 01; P1 (any journal writer), P3 consolidation | Phase 1 (before the first `post()` caller) |
| D-02 | Accounting and tax policy ownership: name the accountant and tax/legal adviser who sign every statutory or policy uncertainty (agents 01 D9, 02 D3/D4, 03, 04, 06 D11, 07 D8/D12) | Items needing sign-off: consolidation framework and elimination policy; shared-service charging basis; revenue recognition (professional services, placement fee, success fee); cash receipt restrictions and whether cash is accepted; GST exemption per course or per payer; TDS on commission; labour-code and gratuity parameters; Income-tax Act 2025 section mapping. Options: external retainer, internal finance head, or both with dual sign-off. | Name one accountant and one tax/legal adviser now; each item becomes a dated `StatutoryRule` or policy row with a source citation, owned by them. Engineering encodes none of it (CLAUDE.md rule 4 and "Statutory uncertainty"). Reason: every ⚠️ in CAPABILITIES.md waits on this person. | GRP 09/17/20/22, CON 10, CAR 04, FND 02/04, MED 02, CRM 11, FIN 18/22/25, REC 10/11, HRM 26; P1 (recognition), P3 (all statutory rows), consolidation, success fees | Phase 1 (recognition, cash rules); Phase 3 at latest |
| D-03 | Ledger cutover, money type and payments scope (agents 07 D1/D2/D4/D10) | Cutover: route every flow to `post()` in Phase 1.5 and retire `Transaction` as the reporting source, or mirror and keep both. Money: bigint paise end to end vs Decimal in storage. Payments: statement feeds and reconciliation only, or initiate bank payments in release 1. Imports into closed periods: allow or require reopen. | Cut over now; bigint paise in application code (Decimal only at the DB boundary); statement feeds first, payment initiation deferred; no imports into closed periods, use reopen with reason. Until cutover, do not present TB, P&L or cash as statutory. Reason: `post()` has no caller and every report reads the legacy table. | GRP 21, EDU 15, FND 03, MED 03, FIN 02/05, REC 13, INT 03/05/06; P1.5, P1.6; Done-means 1, 2, 6 | Phase 1 start (money helper first) |
| D-04 | First-release scope, pilot, sequencing and build-vs-integrate (agents 01 D2, 12 R-1/R-3/P-1/P-3/P-11; 11 D3) | Scope: adopt or reject the defer list (CCTV, pantry, MSP, hybrid desk booking, ventures platform, logistics). Sequencing: plan Phase 0-8 vs proposal Phase 0-4 (conflict on meaning of Phase 1; plan Phase 0 is nine defects, proposal Phase 0 is discovery). Build vs integrate per capability: payroll engine, e-signature, IdP, storage, mailbox and WhatsApp provider, accounting system of record, commission engine. | Ledger first with the proposal's operating gate added to every phase; run a time-limited discovery pilot, then plan Phase 0 defects; rename proposal phases R0-R4. Adopt the defer list. Record build-vs-integrate per row with quotes (TCO). Pilot on collections and delivery (proposal p61). | GRP 07, CON 01, FND 04, MED 04, CRM 11, HRM 07, DOC 04, SHR 18, INT 02/04; P0-P4 ordering; INT rows; scope of every "L" row | Phase 0 (before funding Phase 1) |
| D-05 | Product intent and resourcing (README decision C; agents 12 S-1/S-2) | Tenant-zero (hardcode Tamil Nadu, faster) vs product (PT per local body, versioned statutory packs, onboarding state machine, ~25% more work). Staffing: plan assumes one senior plus AI-assisted developers; proposal assumes 4-6 FTE. Funding: all at once vs phase by phase with a stop rule. | Plan assumes product; confirm it. Fund phase by phase with a stop rule and a standalone-value test for Phase 1; measure productive hours before committing the staffing model. Reason: decides Phase 3 and Phase 7 shape and whether the extra 25% is funded. | FND 05, MED 05, SHR 20, INT 08; P3, P7; CAP-SHR-20; usage budgets | Phase 1 start |
| D-06 | E-invoicing route: GSP vs direct IRP, and applicability (README decision B; agent 07 D5) | GSP (commercial, monthly cost) vs direct NIC access (static IPs per GSTIN, ~5 lakh all-in) vs not enabling until applicability confirmed. | GSP, per README. Accountant confirms whether and when each tenant must report and the reporting window before any e-invoice rule is enabled; the window is a `StatutoryRule` row. Reason: unconfirmed applicability must not be coded. | FND 06, MED 05/06, FIN 24; CAP-FIN-24; P3.2 | Phase 3 |
| D-07 | Identity, party and tenancy architecture (agents 02 D6, 06 D6, 11 D1, 12 R-2) | Cross-company identity: one identity with per-company grants, or one user per tenant with a linked principal. Party supertype vs separate Person/Organization tables. IdP/SSO choice. Cross-tenant sharing: aggregate snapshots only, or `ProjectionGrant` record exchange. Tenancy hardening: plan Phase 7 vs proposal Phase 0 (before external exposure). | Linked principals per tenant (keeps rule 6 and clear audit) plus explicit `ProjectionGrant` for any cross-tenant read; defer the Party supertype unless an Affiliation must point at an Organization; pick the IdP in the pilot; pull tenant and access checks forward of any external exposure. Reason: shared-services staff, portals and group views all depend on it. | GRP 10, FND 07, MED 07, TEC 11, SHR 08/10/20, INT 01, PRV 01; CAP-GRP-10, CAP-SHR-08/10/20, CAP-INT-01, CAP-PRV-01; P7 ordering | Phase 2 (before any external user) |
| D-08 | External users and portals at launch: customers, institutions, learners, guardians, clients, auditors (agents 03 #9, 05 D4, 09 #3, 10 D4, 12 R-4) | None at launch (staff-assisted intake, internal team records external decisions). Read-only status portal. Full portal with approvals. | None at launch; capture through one staff-assisted record. Build a portal as a separate product after Phase 4 and D-07, with a leakage fuzzer and negative tests. Reason: there is no external-user identity or permission model, and the plan has no phase for it. | FND 08, MED 08, DEL 15; CAP-DEL-15/16, CAP-MED-08, CAP-CON/SEC client acceptance; Done-means 5 | Phase 4 |
| D-09 | Authority model: DoA matrix, delegation, alternates and reserved matters (agents 10 D1/D2/D8/D9, 03 #7, 02 D9, 01 D10, 12 P-5) | Thresholds and alternates per decision class; which classes are founder-only (proposal implies none for routine work); one delegation store (retire decision `Delegation` `main.prisma:905`, keep HR `DelegationOfAuthority`, or a new `DelegationLog`); single approvals inbox vs separate; who names reserved matters; who may publish a public correction or customer status. | One delegation model; union inbox read model; no founder default routing (`decisions.ts:62`); directors enter thresholds as data with a named alternate per class; reserved matters owned by the board via Resolution. Reason: the 24-hour absence test cannot pass otherwise; no number is hardcoded. | GRP 14, FND 09, MED 07/09, TEC 11, DEC 04/05/06/08; CAP-DEC-04/05/06/08, CAP-GRP-11/14, CAP-MED-07, CAP-TEC-11; CEO-5 | CEO-office Phase 5 (before the absence test) |
| D-10 | Privileged access and independent review (agents 10 D5-D7, 11 D9) | Break-glass: permitted actions, duration, alert list, after-action reviewer. Platform admin access to HR and finance content. Auditor role scope and duration. Independent reviewer for related-party and founder transactions (authorised director, accountant, or other). Data-owner approval for access grants. | Break-glass is time-limited, alerts named people, needs after-action review, and cannot bypass audit, tenant gate or period close. No platform-admin content access by default. Name the related-party reviewer now (an authorised director or the accountant). Reason: these roles do not exist in the 7-role register. | FND 10, MED 01/10, DEC 04/09/10, PRV 05; CAP-DEC-04/09/10/11, CAP-PRV-05 | Phase 2 |
| D-11 | Operating ownership, service levels and metrics (agents 11 D2, 08 D2/D3, 10 D11, 03 #8, 01 D6, 07/10 cash view) | Which object types make primary owner, backup and accountable position mandatory; how long a default owner may stand; which roles need a backup; whether final settlement is blocked until handover is acknowledged; service-level targets (enquiry, complaint, delivery risk); owner of the qualification register; metric definitions and baselines (duplicate entry, approval delay, owner coverage, which revenue figure marketing reports); whether the founder cash forecast excludes unverified receipts. | Mandatory on pilot processes only; block settlement for customer-facing roles until receivers acknowledge; set service levels and targets after a measured baseline; forecast excludes unverified receipts by default; one metric dictionary before any pack. Reason: proposal values are design targets and several pilot gates have no baseline. | CON 08, MED 11/13/16, CRM 01, REC 06, HRM 16/17, COM 13, DOC 06, DEC 14, SHR 02; CAP-SHR-02, CAP-HRM-16/17, CAP-DEC-14, CAP-DOC-06, CAP-CON-08, CAP-REC-06 | Phase 4 (pilot gate) |
| D-12 | Customer case ownership and delivery acceptance (agents 09 D3-D6, 10 D3, 07 D6/D7/D11, 01 D3) | Complaints: new `Case` model vs extend the learner exception. Accountable delivery owner on a won deal (sales, delivery or finance). Won = executed contract only, or an executed MoU too. Who owns acceptance and whether it drives billing. Free-change approval class. Collection policy owner and promise-vs-cash rule. Work-log boundary (aggregate only vs person-level). | New `Case` with an exception raised from it; named delivery owner at handoff; won = executed contract (MoU counts only when executed and typed); acceptance separate from technical completion and drives the billing trigger; work logs reported in aggregate. Reason: complaints are the central lifecycle and have no model. | MED 12, CRM 04/13, REC 08, DEL 04/07/11; CAP-DEL-04/07/11, CAP-CRM-04/11/13, CAP-REC-08 | Phase 4 (before R1 pilot) |
| D-13 | Communication capture and recording (agents 01 D4, 09 D1/D2/D14, 08 #9, 12 R-9/P-6/P-7) | Providers: WhatsApp route (Cloud API, BSP, coexistence), email (Microsoft 365 or Google Workspace), telephony. Whether recordings and transcripts are in scope at all. Consent wording and retention. Business-number and mailbox ownership. Historical communications import scope. | Start with structured call/outcome logging and the official WhatsApp Cloud adapter already built; no recording or transcripts until counsel signs notice, consent, retention and India-region transcription; choose the mailbox provider with an eligibility check. Reason: recording law and DPDP application are unverified. | EDU 21, MED 13, COM 02/04/05/06/07; CAP-COM-02/04/05/06/07, CAP-EDU-21; Phase 6 transcription | Phase 4 (capture); Phase 6 (transcription) |
| D-14 | Privacy, retention, erasure and residency (agents 11 D4-D6/D13, 12 R-7/R-8/R-10, 09 #10, 04 #8, 06 #7) | DPDP commencement date (plan says 14 May 2027, proposal says do not assume). One retention table and sign-off per class. Erasure vs eight-year audit retention: crypto-shredding, minimised audit facts with an erasable content store, or a separate keyed store. Legal-hold authority. Backup erasure rule. KMS and per-tenant key holder. India residency per provider and backup. Learner data to funders and careers sharing purposes. | Counsel confirms dates before any copy states them. Single retention table in `StatutoryRule` shape; audit chain holds minimised facts plus a salted subject token, content in an erasable store; restore-then-re-erase for backups; per-tenant DEK via KMS; legal hold overrides purge. Reason: the three plan documents propose three different resolutions. | CAR 03, FND 07, MED 14, COM 07, DOC 01/05, SHR 07/10, PRV 03/07/11/12/13/17; CAP-PRV-03/07/11/12/13/17, CAP-DOC-01/05, CAP-SHR-07/10, CAP-CAR-03, CAP-FND-07, CAP-COM-07 | Phase 2 |
| D-15 | AI autonomy, providers and evaluation (agents 06 D2/D3/D9/D10, 11 D7/D11, 01 D5, 05 D5, 12 T-1) | Keep or remove the "AI-native" claim (`README.md:3`). Keep any AUTONOMOUS_WITHIN_POLICY touchpoint (revenue treatment, owner resolution, identity link, routing). Provider, accounts, credentials, approved models, spend caps, India-region rule. Evaluation owner, 200-case floor per module, mandatory human-only baseline arm. Test-double policy (sandbox or recorded contracts vs "no mock"). Defer OCEL, bottleneck and predictive analytics until an event-completeness metric exists. External content for research. | Remove the claim until an adapter, eval harness and first gated feature exist. Downgrade revenue treatment, owner resolution and identity link to RECOMMEND; keep routing/lead scoring only after the tier and prohibition fixes. Use sandboxes or recorded contracts, not mocks. Name an owner per use case. Reason: zero model calls exist and the fence has bypasses. | MED 15, COM 10, SHR 15/18, INT 08/09, AI 01/02/04/05/16/17; CAP-AI-01..17, CAP-COM-10, CAP-INT-08/09; Phase 5.3, Phase 6 | Phase 6 (claim wording now) |
| D-16 | Event delivery and tamper-evidence claims (agents 06 D4/D5, 11 D8) | Transactional outbox in Postgres vs external queue. Claim "tamper-evident" externally or call it an integrity log. Anchoring: where, who holds the key, how often verified. | Postgres outbox; describe the chain as an integrity log until the verifier recomputes content hashes across the whole chain; name the anchor-key holder before any auditor-facing claim. Reason: `verifyChain` reports valid without recomputing and checks 5,000 rows. | MED 16, SHR 11/13, PRV 07; CAP-SHR-11/13, CAP-PRV-07 | Phase 2 |
| D-17 | Foundation, restricted funds and funding vocabulary (agents 04 #2/#3, 06 D8, 02 D5, 12 R-6) | Which legal entity receives donor and CSR money (a separate tenant); tax status (Section 8, 12A, 80G, CSR eligibility); whether the platform tracks restricted funds at all and who validates a purpose; name the funding model `FundingAward` (not `Grant`). | Do not build the Foundation module until legal form and a tax adviser's opinion exist. If tracked, enforce a fund dimension at `post()` only (after D-01 and Phase 1), never in the UI. Use `FundingAward`. ⚠️ No eligibility rule is encoded without adviser sign-off. | FND 01/02/03; CAP-FND-01..10, CAP-GRP-21/22, CAP-VEN-14 | Phase 1 (if a fund dimension is wanted), otherwise Phase 7 |
| D-18 | Practice offers: security, careers and consultancy (agents 03 #1-#10) | Practice placement: same tenant with a practice discriminator vs separate entities/tenants. Whether the platform holds client restricted evidence. Who signs authorised testing scope and who may accept a client risk. CCTV go/no-go. Careers launch order and whether guarantees, refunds and success fees are offered. | Same tenant with a practice discriminator and a `Project` fix until D-01 says otherwise. Hold finding summaries only; keep client evidence outside the platform until a restricted store and counsel review exist. Remove CCTV from this programme or use a partner VMS (privacy impact assessment first). Launch only models the code and counsel support; defer Kaizen-employed deployment, third-party-employed and payroll-only until counsel confirms status. Offer guarantees and success fees only after the accountant (D-02) settles recognition and the refund-liability ledger path. | SEC 01/02/05/10, CAR 01/07/12; CAP-SEC-01/02/05/10, CAP-CAR-01/07/12, CAP-CON-10 | Phase 4 (before any engagement model is built) |
| D-19 | Education and skill-development policy (agents 04 D1/D4-D10, 08 D7-D11, 10 D10) | Scheme-specific claim workflows now vs funding guards only. Who verifies competence and who revokes a certificate; whether verification is public. Attendance denominator (excused sessions) and biometric. Trainer-substitution notice and refund basis. Programme and cohort version pinning. Fee-calculator margin definition (on revenue vs markup). GST exemption per course vs per recipient. LMS: build bounded modules vs integrate. | Guards only until a scheme is contracted (enrolment-level funding, invoicing guard); completion asserts claimed, not assessed; pin versions on cohorts from creation; margin on revenue; per-course exemption with a visible invoice flag until counsel answers; state LMS portability and identity needs before choosing. Reason: person-level funding rows already exist and the proposal disclaims scheme assertions. | SKL 02, EDU 08/10/11/16/20/23, FIN 22; CAP-SKL-01..10, CAP-EDU-01/08/10/11/16/20/23 | Phase 4 (before cohort schema change) |
| D-20 | Ancillary module scope and tenancy (agents 05 D1-D7/D9, 08 D5, 11 D10, 06 D6) | MSP tenancy: tenant per customer vs customer dimension inside the company tenant. Shared logistics and procurement: in or out. Ventures: record only vs pipeline and approval flow. Social publishing: manual until a provider is approved. Remote workspace and hybrid desk booking: build, buy or defer. Spin-off: accept the documented approval bypass on the opening allotment, and script-carry vs counsel-led legal transfer. | Defer MSP, logistics, remote workspace and desk booking; ventures record-only; manual social publishing stays the default; spin-off must pass the normal approval path and be audited, with counsel running the legal transfer and the script moving data only. Reason: none of these has a tenancy or legal design yet. | GRP 13, MED 11, TEC 05/10/19, HRM 28, INT 10; CAP-TEC-05/06/07/10/19, CAP-INT-10, CAP-HRM-28, CAP-MED-11, CAP-GRP-13, CAP-VEN-08 | Phase 7 (MSP/tenancy); before first spin-off commit |

## Owner answers (recorded 2026-10-10)

Answers given by the owner. Existing rows above are unchanged. Where no answer is recorded here, the recommendation above stands.

- **D-01 (entity model).** Owner answer: a tenant is one legal company. Each subsidiary is its own tenant. Holding companies connect to their subsidiaries through an optional, consented link layer between tenants (closest to option (a)'s group layer). Divisions are not separate tenants. Every company owns its own subscription.
  - Open: intercompany recording choice (pairing record vs reciprocal `post()` entries); accountant confirmation of Ind AS 110/103 consolidation applicability (D-02).
  - Implication to confirm, not an owner statement: CLAUDE.md rule 6 (tenant scope from session only) means a holding-company view needs an explicit link with consent and read-only snapshots, not a relaxed tenant check.
- **D-03 (cutover and money).** Owner answer: money is bigint paise end to end, including in database storage; no Decimal at the DB boundary. This replaces that part of the recommendation above and matches CLAUDE.md rule 1.
  - Not yet answered; the recommendation stands, unconfirmed: cutover timing, payments scope and closed-period imports.
- **D-05 (product intent).** Owner answer: internal first, product later. Statutory parameters stay date-effective `StatutoryRule` rows (seed Tamil Nadu as data, no hardcoding), consistent with CLAUDE.md rule 4. Subscription ownership and billing rules are deferred to the product phase.
  - Not yet answered; the recommendation stands, unconfirmed: funding model and staffing.
- **D-09 (authority model).** Owner answer: decided during onboarding. When employees and roles are created at setup, authority (approval limits, delegation, alternates) is selectable at that time, entered as data, not hardcoded.
  - Open: which delegation store to keep (decision `Delegation` at `main.prisma:905`, HR `DelegationOfAuthority`, or new `DelegationLog`); single vs separate approvals inbox; founder-only classes; who names reserved matters; the 24-hour absence test.
- **D-15 (AI claim).** Owner answer: reword the "AI-native" claim as a roadmap statement, not a current capability (there are zero model calls today).
  - Open: all other D-15 items (autonomy touchpoints, provider, spend caps, India-region rule, evaluation owner) remain open; the recommendation stands, unconfirmed.

Conflict to resolve: CLAUDE.md says the platform is intended for commercialisation and PRODUCT.md says it is internal-only; the D-05 answer (internal first, product later) is consistent with both only if the multi-tenant design is kept. Not edited here.

## Owner answers, round 2 (recorded 2026-10-10)

Answers given by the owner in a second round. Existing rows and the first-round answers above are unchanged. Where no answer is recorded here, the recommendation above stands.

- **Status of the work.** Owner answer: planning only for now; nothing is to be built yet.
  - Not answered: D-04 (Z0 stop-ship before the discovery pilot). The question was therefore not answered and stays open.
- **D-01 (intercompany).** Owner answer: pair the two sides now; post reciprocal ledger entries once Phase 1 lands.
- **D-03 (cutover).** Owner answer: retire the legacy `Transaction` table at cutover (Phase 1.5). Imports into a closed period require reopening the period, with a reason. Combined with the first-round answer, money is bigint paise end to end.
  - Implication to confirm, not an owner statement: existing `Decimal(18,2)` columns need a migration plan (see FIXES.md FX-31).
- **FX-31 (paise remainder).** Owner answer: the leftover paise go to the first allocation line, so allocations always sum to the total.
- **Plan decisions A and C.** Owner answer: `entityId` goes on the journal now, and Phase 1 is built for many companies.
- **D-09 (authority store).** Owner answer: one new delegation model. Thresholds are entered as data at onboarding, consistent with the first-round answer. The two existing stores (decision `Delegation` at `main.prisma:905` and HR `DelegationOfAuthority`) are to be replaced or folded into the new model.
  - Not stated by the owner: the migration path for the two existing stores.
- **D-15 and FX-04.** Owner answer: nobody holds the `agents:decide` permission for now, so no agent proposal can be accepted until the AI phase. The other D-15 items stay open.
- **D-13 and FX-50.** Owner answer: inbound webhooks are authenticated with a per-tenant HMAC. The live WhatsApp, email and telephony providers are not yet named.
- **FX-02.** Owner answer: no skill or score feeds pay or promotion automatically; a human decision is always required.
- **D-19 and D-08.** Owner answer: certificate verification is internal only (requires sign-in) for now; no external users at launch.
- **D-20.** Owner answer: no approval bypass on a spin-out's opening allotment (FX-22).
- **D-02.** Owner answer: the accountant and the tax/legal adviser are not yet named. Every statutory item (revenue, cash, payables, GST, TDS, Ind AS 110/103 consolidation, Income-tax Act 2025 mapping) remains awaiting professional sign-off. Nothing here asserts law.
- **D-06 and plan decision B.** Owner answer: direct to the government e-invoice portal (IRP), not a GSP. This differs from the recommendation above, which is a GSP. Whether and when e-invoicing applies still needs the tax adviser.
- **D-14 (encryption key).** Owner answer: the encryption key is platform-held, one per tenant; boot refuses to start without it (FX-60).
- **D-05 (staffing and funding).** Not decided yet. The doc says to measure productive hours before committing.
- **D-17 (restricted funds).** Owner answer: restricted funds are tracked in the ledger from Phase 1.
  - Implication to confirm, not an owner statement: this adds a fund dimension to the ledger design. The legal form (for example Section 8, 12A, 80G) still needs professional advice.
- **Still open, not asked yet (later phases).** D-07, D-10, D-11, D-12, D-16, D-18, and the list of live inbound providers under D-13.

## Owner phase definitions and scope (recorded 2026-10-10)

Owner's definitions, paraphrased:

- **Phase 0** = streamline and fix the existing workflow without adding new features.
- **Phase 1** = complete the features that let software developers work from home with no issues (daily workflow tools and delivery/project work).
- These are not the plan's phases 0-8 (`docs/plan/README.md`) nor the zen360 tracks Z0-Z4. The mapping is the lists below.
- The owner chose to include some new-build items in Phase 0. That departs from "no new features" and is the owner's choice.

Phase 0, fix items (all kept):

- Plan P0 0.1, 0.3, all of 0.6 (including FX-40 and FX-41, UTC financial-year fixes), and the 0.8 fixes (two dead style classes, build identity).
- Stop-ship: FX-01, 02, 03, 04, 05, 20, 21, 22, 50, 60, 61, 80 (internal only: verification requires sign-in, no public verify endpoint), 81.
- Ledger defects: FX-30 to 35 and FX-70 to 73.
- Interface fixes: code splitting, 401 handling, 4.2a metric rule.

Phase 0, new or replace items chosen:

- 0.2 session hardening; 0.4 structured logging; 0.5 scheduler; 0.7 schema split, map and scoped test scripts; 0.8 CI pipeline, lint and migration baseline.
- P1 ledger 1.1, 1.2, 1.3, 1.4, 1.5, 1.6.
- P3 3.1 statutory master pack.
- P4 error boundaries, token storage (httpOnly cookie), typed client, component library, forms, 4.5 feel, 4.3 accessibility, 4.6 frontend tests.
- P7 onboarding state machine, per-state statutory packs, static egress IPs.
- P8 concurrency test suite, tenant-leakage fuzzer, ten CI gates.
- Z2 commitment record, one document store, typed task source, decision links, founder exception view.
- Z3 continuity and handover gate.

Phase 0, out or undecided:

- P2 (2.1 audit trail, 2.2 DPDP): undecided.
- P3: 3.2 e-invoicing out; 3.3, 3.4, 3.5 undecided.
- P4: 4.4 mobile out.
- P5: 5.2 undecided; 5.3 dropped.
- P6: all dropped for now (needs 6.1, P2, P5).
- P7: per-tenant encryption, noisy-neighbour controls and India residency undecided; tiering, billing and real API deployment out.
- P8: load tests, monthly restore drill, SOC 2 / ISO 27001, annual pentest out.
- Z2: customer case out (could be reconsidered now that D-12 is answered).
- Z3: lifecycles out.
- Z4: all undecided.

Phase 0 prerequisite notes:

- Onboarding and per-state packs need 3.1 (added for that reason).
- 1.5 needs a named accountant (D-02), the Kaizen book figures and a named human reviewer.
- FX-70 to 73 likely need 1.1 to 1.3 (implication from the docs, not an owner statement).
- 1.2 needs PgBouncer transaction mode and a non-owner database role.
- Token storage needs 0.2; error boundaries need 0.4; accessibility and frontend tests need 0.8 CI.
- Tenant-leakage fuzzer needs a second tenant's test data and D-07 (now answered).
- P8 ten CI gates are defined in `00-BRIEF.md` section 5, which was not read for this record.

Phase 1 scope chosen:

- Approvals: single approvals inbox (CAP-DEC-08); one delegation record (DEC-06); maker-checker (DEC-07); routing and authority matrix (DEC-05).
- Attendance and remote work: remote and field attendance (HRM-06); WFH and hybrid policy (HRM-28); leave approval with backup approver (HRM-19); access revoked at exit (HRM-15).
- Time and projects: time against engagement (CON-09); work logs (DEL-07); project with owner and acceptance (DEL-01); milestones and acceptance (DEL-02).
- Delivery: estimates (DEL-03); change requests (DEL-04); release records (DEL-05); exit gates (DEL-06); sales-to-delivery handoff (CRM-13); single engagement with packages (CON-05); allocation calendar and capacity ledger (HRM-18).
- Sprints, backlog, ~~standups~~ (dropped per round 4) and internal chat: `planned-features.md` Feature 1, phases A (work items), B (discussion), C (realtime and delivery), D (automation).
- Communication: shared inboxes (COM-02); meetings and minutes (COM-11); response SLA (COM-13); notifications (COM-15).
- Staff expense claims: no capability row exists.
- Voice calls: open-source LiveKit (Apache-2.0) under the existing API; no recordings; recording service not deployed.
- Out of Phase 1 or not chosen: device custody, issued kit, exit asset return (TEC-13, HRM-29, HRM-14); object storage for chat attachments (decision deferred).

Phase 1 prerequisite notes:

- Phase 1 sits on the Phase 0 selection above.
- Feature 1 needs: the Task completion route fix at `crm.routes.ts:1109` first; tenant row-level security on new work tables (CLAUDE.md rule 6); legal review before Phase B; a check against CAP-HRM-32 (no covert monitoring); SSE tested first for realtime; chat kept under the 8-year retention rule (needs counsel confirmation); and the doc's decisions on transactional email and object storage (email open, storage deferred).
- DEL-04, CON-05, CRM-13 and DEL-07 depend on D-12 (now answered).
- DEL-03 depends on HRM-18. DEL-02 needs the one document store and an exact money type. COM-13 depends on D-11 (service levels after a baseline).
- Conflict to resolve: COM-02 shared inboxes depend on D-13 provider decisions, but email and WhatsApp capture are deferred.
- HRM-28 WFH policy was on the proposal's defer list under D-04, but the owner included it in Phase 1.
- Effort: the docs give per-phase effort totals only (plan P0 1 week, P1 3-4 weeks, P3 6-8 weeks, P4 4-6 weeks, P5 3 weeks, P6 4-6 weeks, P7 3-4 weeks), with no per-item sizes.

## Owner answers, round 3 (recorded 2026-10-10)

Answers given by the owner in a third round. Existing rows and the earlier answers above are unchanged. Where no answer is recorded here, the recommendation above stands.

- **D-02 (accounting and tax sign-off).** Owner answer: for now an internal finance head signs off. No outside accountant or tax/legal adviser is named. Every statutory item (GST, TDS, labour codes, revenue recognition, consolidation, Income-tax Act 2025 mapping) remains awaiting professional sign-off. CLAUDE.md "statutory uncertainty means stop and flag" still applies.
- **D-07 (identity and tenancy).** Owner answer: confirmed. One login per person; separate permissions per company; an explicit share record for any cross-company read; access and tenant checks in place before any external user.
- **D-11 (ownership and service levels).** Owner answer: owners and backups required on pilot processes only. Service-level numbers wait for a measured baseline. "Settlement without handover" and "forecast with unverified receipts": warn only, do not block.
  - Interpretation, not an owner statement: the system warns the user; it neither blocks the settlement nor silently excludes receipts.
- **D-12 (customer case and acceptance).** Owner answer: a new Case record, from which an exception can be raised. "Won" means a signed contract; an MoU counts only when executed and typed. One named delivery owner at sales-to-delivery handoff. Customer acceptance, separate from technical completion, triggers billing.
  - Implication, not an owner statement: revenue and invoicing rules need professional sign-off under D-02.
  - Not answered: whether work logs are aggregate or per person.
- **D-04 (first-release scope).** Owner answer: the defer list is adopted. CCTV, pantry, MSP catalogue, hybrid desk booking, ventures platform and logistics are out of this programme's first release. Phase order: the owner's own Phase 0 and Phase 1 definitions (see the section above) apply.
  - Not answered: build vs integrate per capability.
- **D-05 (resourcing).** Owner answer: one senior person plus AI-assisted developers, funded phase by phase with a stop rule. This resolves the staffing and funding part. The 25% product-design extra remains per the "internal first, product later" answer.
- **D-10 (privileged access and review).** Owner answer: an authorised director is the independent reviewer of related-party and founder deals. Platform admins have no default access to HR or finance content.
  - Not answered: break-glass details.
- **D-13 (voice, email and WhatsApp).** Owner answer: voice calls via open-source LiveKit in Phase 1, with no recordings or transcripts. Email and WhatsApp capture are deferred; chat comes from Feature 1. Providers for email, WhatsApp and telephony remain unnamed. Recordings stay out until counsel signs off.
  - LiveKit notes, unverified: recording is a separate egress service and is not deployed; per-tenant key separation, end-to-end encryption, release years and Indian data-hosting obligations are unverified.
- **D-14 (privacy, erasure and residency).** Owner answer: erasure is handled by minimised audit facts plus an erasable content store. The audit chain keeps facts and a salted subject token; personal content lives in a separate erasable store. Legal hold is deferred: for now the software only warns the user that something looks illegal.
  - Not answered: counsel owner. Every DPDP, retention and residency item awaits counsel; no DPDP date is stated as fact.
- **D-16 (integrity claims).** Owner answer: Postgres outbox for event delivery. The audit trail is called an "integrity log" until the checker recomputes content fingerprints across the whole chain (FX-81). Anchor-key holder: not needed until an auditor-facing claim is planned.
- **D-18 (practice offers).** Owner answer: CCTV stays deferred. When built, it is live view only, with no recording.
  - Not answered: summaries-only client evidence, the careers launch model, and practice labels vs separate companies.
- **Feature 1 decisions (`planned-features.md`).** Owner answers: realtime transport, test SSE first. Chat retention, keep with the 8-year rule, subject to counsel. Object storage, deferred. Transactional email, open.

Still open after round 3:

- D-02: real statutory sign-off (no named accountant or tax/legal adviser).
- D-14: counsel owner.
- D-18: remaining items (summaries-only client evidence, careers launch model, practice labels vs separate companies).
- Feature 1: transactional email decision.
- CLAUDE.md vs PRODUCT.md commercial conflict (see the conflict note in the first-round answers).
- D-04: build vs integrate per capability.

## Owner answers, round 4 (recorded 2026-10-10)

Answers given by the owner in a fourth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, except the one in-place annotation to the Phase 1 scope list (standups). Where no answer is recorded here, the recommendation above stands.

- **Task-complete fix (owner answer).** `POST /tasks/:id/complete` (`crm.routes.ts:1109`; no `assertCan`, audit or emit) is moved into Phase 0 as a stop-ship-class fix. Write the failing test first.
- **3.1 statutory master pack (owner answer).** Placed early in Phase 0 (owner override).
  - Implication, not an owner statement: this departs from the repo README's "do not reorder" rule and from the "1 before 3" sequencing rule. It is recorded here as an explicit owner override of both.
- **Phase length (owner answer).** Each phase has a stop rule: a phase ends when its done-criteria pass. The one-week label for Phase 0 no longer applies. Each wave is sized when it starts.
- **Added to Phase 0 (owner answer).** FX-24 (outbox); FX-51 (RLS on every table); FX-42 (UTC financial period at `invoicing.ts:266-269`); FX-06 and FX-07; FX-62 to FX-65.
- **Phase 1 items (owner answers).**
  - COM-02 shared inboxes: internal-only inbox. No external email or WhatsApp provider.
  - Work logs: per person, plus project aggregates for insights (D-12). This answers the round 3 question on aggregate versus per person.
  - Field and remote attendance: self-declared request plus manager approval. No location, device ID or IP is stored.
  - Staff expense claims: claim, approve, then post to the ledger on approval via `post()`. Desktop capture only.
  - Counsel owner (D-14): the internal finance head, for now.
  - Statutory sign-off (D-02): the internal finance head only. Statutory values stay DRAFT until signed off.
  - Standups: dropped from Phase 1. They had no spec in `planned-features.md`.
- **Product aim (D-05, owner answer).** Internal first, product later. The multi-tenant design is kept. `PRODUCT.md` (Capabilities and Constraints, audience bullet) and `CLAUDE.md` (line 3) were edited minimally so the commercial-versus-internal wording no longer conflicts. This resolves the conflict noted in the first-round answers.

Still open after round 4:

- D-04: build vs integrate per capability.
- D-18: summaries-only client evidence, careers launch model, practice labels vs separate companies.
- Feature 1: transactional email decision.
- D-10: break-glass details.

## Owner answers, round 5 (recorded 2026-10-10)

Answers given by the owner in a fifth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. Where no answer is recorded here, the recommendation above stands.

- **00-BRIEF gates (owner answer, OPEN).** `00-BRIEF.md` is missing from the branch. The ten CI gates and the ledger gate tests are to be defined fresh. Claude will draft them for owner approval. Status: OPEN until drafted and approved.
- **1.5 cashbook mapping and Kaizen book figure check (owner answer).** The reviewer for both is the internal finance head.
- **Transactional email (owner answer).** The provider is chosen now: Resend, in Phase 1 scope.
  - Implication, not an owner statement: Resend processes data outside India, and sending relies on domain verification. A legal and data-hosting check by the internal finance head (the D-14 counsel owner) is needed before real customer data is sent.
- **Build vs integrate (D-04, owner answer).** Build natively for work items, chat, voice and video. The owner's method: do NOT fork or copy third-party code. Read open-source source code to learn what it did and why, then write custom code for this app. LiveKit is the voice and video media layer, used as a dependency or service.
  - Implication, not an owner statement: this matches the existing clean-room rule. No code from third-party repos is copied, regardless of licence.
- **Video calls (owner answer).** Video calls are added to Phase 1. Previously voice only. Recording, egress and transcripts remain off (D-13).
  - Implication, not an owner statement: video adds bandwidth and server cost to the LiveKit Indian-VPS plan.
- **Per-tenant encryption (owner answer).** One key per tenant. D-14 stands. P7 "undecided" is to be read as decided.
- **Deferred items (owner answer).** D-18 client files summaries-only, careers model and practice labels are all DEFERRED. None is in Phase 0 or Phase 1.

Still open after round 5:

- D-02: real statutory sign-off (internal finance head only; statutory values stay DRAFT).
- 00-BRIEF gates: draft pending Claude's draft and owner approval.
- D-14: chat-retention counsel check.
- Resend: data-hosting check (cross-border processing and domain verification).
- D-03: payments scope and cutover timing.
- D-09: open items (founder-only classes, reserved matters, 24-hour absence test).
- D-11: service-level numbers.
- Expense receipt storage (object storage deferred).
- VPS provider for LiveKit.

## Owner answers, round 6: hosting (recorded 2026-10-10)

Answers given by the owner in a sixth round, on hosting. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, including the round 5 "Still open" list, which is superseded by the list at the end of this section. Where no answer is recorded here, the recommendation above stands.

- **Hosting (owner answer).** The application is hosted on the company's own server, located in India, on-premises.
- **Cloudflare Worker (owner answer).** `worker/index.ts` is to be removed. Everything is served from the company's own server.
  - Implication, not an owner statement: `CLAUDE.md` (line 4) and the repo README still describe `worker/` as the serving layer. Not edited here.
  - Implication, not an owner statement: SSE is served directly by the Express API. The Feature 1 Phase C "SSE through the Worker" spike gate no longer applies.
  - Implication, not an owner statement: removing the Worker removes Cloudflare as the TLS, DDoS and rate-limit front. A reverse proxy and network protection must be chosen for the own server.
- **Operations wave in Phase 0 (owner answer).** An operations wave is added to Phase 0 with four items: database backups with tested restores; monitoring and alerts; TLS certificate renewal; non-owner application database role setup.
  - Implication, not an owner statement: the non-owner app role (blocking 1.2) and PgBouncer in transaction mode are now the own server's setup.
- **LiveKit hosting (owner answer, by implication of the hosting answer).** LiveKit self-hosting runs on the own server.
  - Implication, not an owner statement: needs TCP 7880 and 7881, UDP 50000-60000, and TURN/TLS on 443 open at the on-premises network edge, plus a public IP. The VPS provider question is superseded.
  - Implication, not an owner statement: video (round 5) adds bandwidth load on the on-premises connection.
- **P7 static egress IPs (implication).** These depend on the office or ISP providing static IPs.
- **Single-site risk (implication).** On-premises raises single-site risk: power, internet, hardware failure and off-site backup each need a named owner.
- **Data location and email (implication).** Indian data hosting is simpler for in-India storage. Resend (round 5) still processes data outside India, so the round 5 data-hosting check still applies.
- **Object storage (implication).** Object storage, still deferred, would also be on the own server. Receipts and attachments remain deferred.

Still open after round 6 (supersedes the round 5 list; the round 5 item "VPS provider for LiveKit" is closed by the hosting answer):

- D-02: real statutory sign-off (internal finance head only; statutory values stay DRAFT).
- 00-BRIEF gates: draft pending Claude's draft and owner approval.
- D-14: chat-retention counsel check.
- Resend: data-hosting check (cross-border processing and domain verification).
- D-03: payments scope and cutover timing.
- D-09: open items (founder-only classes, reserved matters, 24-hour absence test).
- D-11: service-level numbers.
- Expense receipt storage (object storage deferred).
- Owner of server operations and off-site backup.
- Reverse proxy and network protection choice.
- Static public IP availability (office or ISP).
- Internet and power redundancy.

## Owner answers, round 7 (recorded 2026-10-10)

Answers given by the owner in a seventh round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, including the round 6 "Still open" list, which is superseded by the list at the end of this section. Where no answer is recorded here, the recommendation above stands.

- **Server operations and off-site backup owner (owner answer).** An internal IT person or team will own server operations and off-site backup. The name is not yet given.
- **Reverse proxy (owner answer).** Caddy, with automatic TLS and certificate renewal.
- **Connectivity and power (owner answer).** The office has a static public IP. It has a second internet line and backup power, both.
  - Implication, not an owner statement: this resolves the static public IP and internet and power redundancy risks listed in round 6. The P7 static egress IP dependency and the single-site power and internet risk are resolved on this answer. Off-site backup and server operations still need the named owner above.
- **D-03 payments scope (owner answer).** Record only. No online payment gateway.
- **Cashbook cutover (owner answer).** The cashbook moves to the new ledger at a financial year start (1 April), and only after the trial balance ties to the paisa.
- **D-09 approvals (owner answer).**
  - Founder-only approval classes are: payroll run, large payments, and statutory filings.
  - If an approver is absent for 24 hours, the request escalates to the named alternate stored on the request.
  - Reserved matters are named by the founder at onboarding and entered as data.
- **D-11 service-level numbers (owner answer).** Measure first, set later. Build the mechanism, collect about one month of real data, then the owner sets the numbers.
- **Resend data-hosting check and chat-retention legal check (owner answer).** Both are done by the internal finance head before the first outside user. Internal testing proceeds meanwhile.

Still open after round 7 (supersedes the round 6 list):

- Real statutory sign-off beyond the internal finance head. Statutory values stay DRAFT.
- Ten CI gates and ledger gate tests, to be drafted by Claude for owner approval. The 00-BRIEF.md file is missing.
- Name of the internal IT owner for server operations and off-site backup.
- Large-payment threshold value and other thresholds, to be set at onboarding.
- Expense receipt storage. Object storage remains deferred.

## Owner answers, round 8 (recorded 2026-10-10)

Answers given by the owner in an eighth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. This round supersedes the round 7 "Still open" list at the end of the round 7 section. Where no answer is recorded here, the recommendation above stands.

- **Tenant setup data (owner answer).** Where a decision is tenant setup data, it is closed as "tbd during onboard" (to be entered during onboarding). It is entered as data, not hardcoded. Closed this way, and only these:
  - **Large-payment threshold and other approval thresholds (D-09).** Status: tbd during onboard.
  - **Reserved matters list (D-09).** The founder names them at onboarding. Status: tbd during onboard.
  - **Named alternates and delegates per role (D-09).** Status: tbd during onboard.
  - **Per-tenant practice labels, careers model and client-file summary rules (D-18).** Already deferred in the round 5 answer ("D-18 client files summaries-only, careers model and practice labels are all DEFERRED"). Status: tbd during onboard / deferred.
- **Not closed by this answer.** These stay open, and are not tenant setup data:
  - Real statutory sign-off (D-02). Statutory values stay DRAFT.
  - The internal IT owner's name (server operations and off-site backup, round 7).
  - D-11 numbers. Measure first, set later (round 7); the one-month measurement has not been collected.
  - Legal checks: the chat-retention counsel check (D-14) and the Resend data-hosting check (round 7). Both are done by the internal finance head before the first outside user.
- **CI gates and ledger tests (implication, not an owner statement).** Claude drafted the ten CI gates and the three ledger gate tests for owner approval in `docs/plan/zen360/CI-GATES-DRAFT.md`. That file carries the draft status line that `00-BRIEF.md` section 5 is missing from the branch and is not reconstructed. Nothing in the draft is in force until the owner approves it.

Still open after round 8 (supersedes the round 7 list):

- Real statutory sign-off beyond the internal finance head (D-02). Statutory values stay DRAFT.
- Name of the internal IT owner for server operations and off-site backup.
- Ten CI gates and ledger gate tests: awaiting owner approval of `docs/plan/zen360/CI-GATES-DRAFT.md`.
- Expense receipt storage location: object storage on the company's own server, deferred.
- D-11 numbers after the one-month measurement.
- Legal checks carried over from round 7, not closed by this round: the chat-retention counsel check (D-14) and the Resend data-hosting check. Both are due before the first outside user.

## Owner answers, round 9 (recorded 2026-10-10)

Answers given by the owner in a ninth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. This round supersedes the round 8 "Still open" list at the end of the round 8 section. Where no answer is recorded here, the recommendation in `docs/plan/zen360/CI-GATES-DRAFT.md` stands, and that draft's status line says what is approved.

- **CI gates G1 to G10 (owner answer).** All ten CI gates G1 to G10 are approved as the required set.
- **Log redaction and accessibility become required gates (owner answer).** The log-redaction check and the accessibility (axe) check are required gates too, so there are twelve checks in total. In the draft's numbering they are added as G11 (log redaction) and G12 (axe).
- **Mock scan (owner answer).** The mock scan fails the build.
- **Failing-test-first proof (owner answer).** The failing test sits in a separate first commit that fails on the old code. CI checks this.
- **Governed-write scan (owner answer).** The governed-write scan is registry-driven and blocks the build. Unregistered writes fail the build, and `force: true` fails the build.
- **Dependency licence check (owner answer).** The licence check is REPORT ONLY. It lists the licences found and never fails the build.
  - Implication (label): the clean-room, no-copy rule in CLAUDE.md and the owner's "read, understand, write custom" method are now enforced by review, not by CI.
- **fast-check (owner answer).** fast-check (MIT) is approved as a test-only dependency.
- **Ledger test budget (owner answer).** Short runs of the ledger property test happen on every pull request. The full ten-thousand-operation test and the full concurrency runs happen at phase end.
- **Statutory gate G10 (owner answer).** G10 checks structure only. It fails on hard-coded rates and never checks values.
- **CI database approach (owner answer).** CI moves from `prisma db push` to real migrations in Wave 0.
- **Gate sequencing (owner answer).** Gates are listed per wave only. The team sequences the work within a wave.
- **Access model (owner answer).** Named reviewers and signers are replaced by a level-based access system. Each employee is assigned a level during onboarding. Sign-off duties are attached to levels, not to named people. Examples of duties: the Kaizen fixture sign-off, the 1.5 account-mapping review, statutory rule approval, legal checks and approval classes.
  - Implication (label): this extends D-09, where thresholds and roles are entered as data at onboarding.
  - Implication (label): until onboarding exists, the internal finance head remains the interim holder of every sign-off duty previously assigned to them.
  - Implication (label): the per-tenant assignment of duties to levels is "tbd during onboard". The level model itself (level names, number of levels, which duties sit at each level, and whether levels are per tenant) still needs a design decision. It is open, listed below.

Still open after round 9 (supersedes the round 8 list):

- Statutory sign-off still needs a real qualified person, even when the duty is held by a level. Statutory values stay DRAFT.
- Name of the internal IT owner for server operations and off-site backup. This becomes a level assignment at onboarding.
- Level model design: the levels, the duties at each level, and whether levels are per tenant.
- Expense receipt storage location: object storage on the company's own server, deferred.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).

## Owner answers, round 10 (recorded 2026-10-10)

Answers given by the owner in a tenth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. This round supersedes the round 9 "Still open" list at the end of the round 9 section. Where no answer is recorded here, the recommendation in `docs/plan/zen360/CI-GATES-DRAFT.md` stands, and that draft's status line says what is approved.

- **Ledger gate tests (owner answer, item 1).** L1 (ten-thousand-operation property test), L2 (migration equivalence) and L3 (200 concurrent allocations) are approved as the required ledger gate. Budget: the short run of the property test on each pull request; the full ten-thousand-operation test and the full concurrency runs at phase end.
- **CI migration baseline (owner answer, item 2).** The CI migration baseline sits in Wave 0. Draft G3 in `docs/plan/zen360/CI-GATES-DRAFT.md` is corrected from "from Wave B" to Wave 0, and the draft's open question 11 is resolved. Who owns the baseline is not recorded.
- **Governed writes (owner answer, item 3).** BOTH checks are required: the registry scan (static, blocks the build) and a runtime test that a write leaves an audit row. This resolves the draft's check (b) and its open question 4.
- **Ordered plan location (owner answer, item 4).** The final ordered plan is committed to the repository branch as `docs/plan/zen360/ORDERED-PLAN.md`. It is not published as a separate document.
- **Access levels by stakeholder type (owner answer, item 5; extends the round 9 access-model answer).** Levels are split by stakeholder type:
  - Employees: Head, Manager, Staff.
  - Founders and owners.
  - Contractors and freelancers.
  - External auditors and accountants.
  - Board and investors.
  The levels are a template that ships with the app. Each tenant can edit the template at onboarding. Each person holds one level, plus named extra duties.
- **Maker-checker: the founder is exempt (owner answer, item 6).** The founder may approve the founder's own requests. No extra flag is recorded beyond the normal audit row.
  - Implication (label): this departs from the CLAUDE.md-style maker-checker rule, where the requester never approves.
  - Implication (label): this departs from the Phase 1A draft test "maker equals checker is refused". That test must exempt the founder level.
  - Implication (label, recorded as a risk, not an objection): self-approval by the founder is traceable only through the ordinary audit row. Segregation of duties is weaker for founder-only classes: payroll run, large payments and statutory filings.
  - Still undefined after this answer: the exact duties per level; whether contractors, auditors and board members are users of the same tenant; and the read scope for each level.

Still open after round 10 (supersedes round 9):

- Statutory sign-off by a qualified person. Statutory values stay DRAFT.
- Duties per level, and read scope of the non-employee levels (founders and owners, contractors, external auditors and accountants, board and investors), including whether they are users of the same tenant.
- IT owner: a level assignment at onboarding. The name is not recorded.
- Expense receipt storage location: object storage on the company's own server, deferred.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).

## Owner answers, round 11 (recorded 2026-10-10)

Answers given by the owner in an eleventh round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, except where this round says it supersedes an earlier answer. This round resolves the four conflicts flagged in `docs/plan/zen360/ROADMAP.md`. Where no answer is recorded here, the earlier rounds and the drafts stand.

- **Restricted funds (owner answer, conflict 1).** Restricted-fund tracking is DEFERRED until D-17, which follows `docs/plan/zen360/README.md`. The round 2 answer that restricted funds are "tracked in the ledger from Phase 1" is superseded.
- **Intercompany pairing (owner answer, conflict 2).** Intercompany pairing and reciprocal entries are DEFERRED together with the holding-company link between tenants (D-01). The round 2 answer to "pair both sides now" is superseded.
- **E-invoicing route (owner answer, conflict 3).** The route is direct to the government invoice registration portal (IRP), not through a GSP. The round 2 answer stands.
  - Implication (label): `docs/plan/zen360/` Phase 3 file and `docs/plan/README.md` decision B recommend a GSP and now disagree with the owner. They are not edited in this round. They are flagged for update when Phase 3 is scheduled.
- **Own-server operations in Phase 0 (owner answer, conflict 4).** The own-server operations in `docs/plan/zen360/ORDERED-PLAN.md` Wave 4 are in Phase 0. The Phase 0 selection line that says "real API deployment is out" is superseded for the own-server operations. The deploy manifest and deploy pipeline are not changed by this answer and stay as recorded in the earlier rounds.

Still open after round 11 (supersedes round 10):

- Statutory sign-off by a qualified person. Statutory values stay DRAFT.
- Duties per level, and read scope of the non-employee levels (founders and owners, contractors, external auditors and accountants, board and investors), including whether they are users of the same tenant.
- IT owner: a level assignment at onboarding. The name is not recorded.
- Expense receipt storage location: object storage on the company's own server, deferred.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).
- Owner of the CI migration baseline (Wave 0). Round 10 recorded that the owner is not recorded; it remains unrecorded.

## Owner answers, round 12 (recorded 2026-10-10)

Answers given by the owner in a twelfth round. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. This round supersedes the round 11 "Still open" list. Where no answer is recorded here, the earlier rounds and the drafts stand.

- **Statutory sign-off (owner answer, item 1).** Statutory sign-off is a LEVEL DUTY. The holder is named per tenant during onboarding ("tbd during onboard"). Until onboarding exists, the internal finance head remains the interim holder (rounds 3 and 9).
  - Implication (label): the duty must be held by a genuinely qualified person for the rule values to leave DRAFT. The access model alone does not make a value correct.
- **Expense receipt storage (owner answer, item 2).** Expense receipts are stored on the company's own server disk and are included in the backups.
  - Implication (label): this is the first file storage on the own server. It needs size limits, backup coverage and a restore test in the Wave 4 operations work. Object storage stays deferred.
- **CI migration baseline owner (owner answer, item 3).** The lead developer owns the CI migration baseline. This is the person doing 0.7 and 0.8. It resolves the round 11 open item on the baseline owner.
- **Non-employee level duties (owner answer, item 4).**
  - External auditors and accountants read books and filings. Read-only, no HR data.
  - The board reads summaries only. No individual records.
  - Contractors see their own tasks and timesheets only. No payroll or HR data.
  - Implication (label): whether these levels are users of the same tenant is still not stated.
- **Head and Manager default duties (owner answer, item 5).** Decided at onboarding ("tbd during onboard"). The values are entered as data per tenant. Staff default duties were not asked and remain open.
- **Push and pull request (owner request, item 6).** The owner asked for round 11 and round 12 to be pushed and a pull request opened after these answers were recorded. This is a process request, not a design decision. It is recorded here for the trail. The pull request is not merged by this round.

Still open after round 12 (supersedes round 11):

- Qualified holder of statutory sign-off, named per tenant at onboarding. Statutory values stay DRAFT.
- Whether auditors, board members and contractors are users of the same tenant.
- Staff level default duties.
- IT owner: a level assignment at onboarding. The name is not recorded.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).

## Owner answers, round 13 (recorded 2026-10-10)

Answers given by the owner in a thirteenth round. Each item is an owner answer unless it is marked as an implication or proposed design. Existing rows and the earlier answers above are unchanged. This round supersedes the round 12 "Still open" list. Where no answer is recorded here, the earlier rounds and the drafts stand.

- **Level assignment by guided questionnaire (owner answer, item 1).** Access levels are assigned to employees during onboarding through a guided stakeholder-mapping questionnaire. The reviewer then reviews the final result and can add or remove access before it takes effect.
- **Who answers (owner answer, item 2).** The questionnaire is answered by the founder or the onboarding owner for each employee.
- **Review step (owner answer, item 3).** The review step shows a plain-language summary of what each person will be able to see and do, with per-duty toggles.
- **Reuse for joiners and role changes (owner answer, item 4).** The same flow is reused for new joiners and role changes.
- **Placement (owner answer, item 5).** The guided level-mapping flow is in Phase 0 Wave 6, built with the onboarding state machine and level assignment (ROADMAP.md Wave 6).
- **Fixed rules, not AI (implication, proposed design, not an owner statement).** The mapping uses fixed rules. AI-assisted mapping features remain on the roadmap and are not part of this round.
- **Suggestion only until confirmed (implication, proposed design).** The flow proposes a level and duties. Nothing takes effect until a named confirmer confirms it.
- **Least access when unclear (implication, proposed design).** When an answer is unclear or missing, the flow assigns the least access that still lets the person work.
- **Audit row per confirmed assignment (implication, proposed design).** Each confirmed assignment writes the usual audit row, including the answers given and the confirmer.
- **No self-confirmation (implication, proposed design).** The person being mapped cannot confirm their own level.
- **Founder-only classes (implication, proposed design).** Founder-only classes (payroll run, large payments, statutory filings) need explicit founder confirmation before they are assigned.
- **Open, not decided.** The exact questions in the questionnaire, the rules that map answers to levels and duties, and the Staff level default duties.

Still open after round 13 (supersedes round 12):

- Qualified holder of statutory sign-off, named per tenant at onboarding. Statutory values stay DRAFT.
- Whether auditors, board members and contractors are users of the same tenant.
- Staff level default duties.
- IT owner: a level assignment at onboarding. The name is not recorded.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).
- Questionnaire content and mapping rules.

## Owner answers, round 14: access mapping design (recorded 2026-10-11)

Owner answers:

1. **Hybrid design adopted (owner answer, item 1).** Identity type is decided first: employee, founder, contractor, external auditor, or board/investor. Level (Head, Manager or Staff) and function are stored as attributes. The attributes select a role template. The template grants a low-risk baseline. Sensitive permissions (approvals, payroll, bank, user administration, company-wide data) are never defaults. Each needs an explicit request, a named approver and a conflict check. A reviewer confirms, adds or removes. Each change records a reason and the rule version.
2. **Blocked conflicts (owner answer, item 2).** One person may not hold both sides of these pairs:
   - create and approve payments;
   - run payroll and approve payroll;
   - manage access levels and approve own access. Only the founder may approve their own access.

   Not selected, so not a blocked conflict: edit statutory rules and sign them off.
3. **On conflict (owner answer, item 3).** A conflict is blocked. The founder can override it with a reason. Overrides are logged and shown in the exceptions view.
4. **Non-employee levels (owner answer, item 4).** Contractor, auditor and board levels require an end date, with a maximum of 12 months. Renewal needs reviewer confirmation.
5. **Recertification (owner answer, item 5).** Sensitive access is recertified quarterly. Everything else is recertified annually.
6. **No response to a scheduled review (owner answer, item 6).** Access is kept. A warning is raised and escalated to the founder. Overdue reviews show in the exceptions view.
7. **Leavers (owner answer, item 7).** Access is removed on the marked leave date. The date is marked by the founder or the onboarding owner. Sessions end, history is kept, and the removal is audited.
8. **Questionnaire (owner answer, item 8).** About 8 to 12 yes/no questions plus one scope choice. The questions ask about tasks, not permission names.

Implications (labelled, not owner statements):

- **Single point of control (implication).** The founder override (round 10 rule) and the founder self-approval exemption (round 10) make the founder the single point of control. Segregation of duties for founder-only classes therefore rests on the audit rows and the exceptions view, not on a second person.
- **Statutory rule edit and sign-off (implication, open).** The pair "edit statutory rules and sign them off" is not a blocked conflict. The same person could therefore change a rule and sign it off, unless the level duties prevent it. This is open.

Research basis (implication, the research itself is not an owner statement): the research covered NIST RBAC and ABAC, OWASP least privilege, birthright access, Entra access reviews, Frappe role profiles and midPoint exclusion rules. Some items were **UNVERIFIED**: ISACA, SANS and NIST AC-5 and AC-6 were not read, and Okta, Rippling and Odoo were not verified. No third-party code was copied.

Still open after round 14 (supersedes round 13):

- The exact questions and mapping rules (the questionnaire wording and the rules that map answers to levels and duties).
- Staff level default duties.
- Whether statutory rule edit and sign-off should be separated.
- Qualified holder of statutory sign-off, named per tenant at onboarding. Statutory values stay DRAFT.
- Whether auditors, board members and contractors are users of the same tenant.
- IT owner as a level assignment at onboarding. The name is not recorded.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).

## Owner answers, round 15 (recorded 2026-10-11)

Owner answers. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, except where this round says it supersedes an earlier answer. This round supersedes the round 14 "Still open" list. Where no answer is recorded here, the earlier rounds and the drafts stand.

1. **Statutory rule change and sign-off are separate people (owner answer, item 1).** Changing a statutory rule and signing it off are a BLOCKED conflict pair. The founder can override it with a logged reason, as for the other pairs (round 14, items 2 and 3). This adds to the round 14 blocked pairs and supersedes the round 14 note that this pair was not blocked.
   - Implication (label): the round 14 open item "whether statutory rule edit and sign-off should be separated" is resolved by this answer.
   - Implication (label): the round 14 implication that the same person could change a rule and sign it off no longer stands.
2. **Staff level default duties (owner answer, item 2).** A Staff employee has these default duties:
   - see and edit own records: profile, attendance, leave requests and expense requests;
   - log own time and tasks: timesheets and assigned work items;
   - use chat and notifications.
   Not selected, so not a default: company directory read. The directory is an explicit extra duty only.
   - Implication (label): Head and Manager default duties are still tbd during onboard (round 12).
3. **Auditors, board members and contractors are guest accounts (owner answer, item 3).** They are separate guest accounts, not users in the employee list of the tenant. This supersedes the open question whether auditors, board members and contractors are users of the same tenant.
   - Owner statement: "We need to add freelancers management features."
   - Implication (label): a guest-account type is needed. It needs a design for invitation, authentication, tenant scoping (CLAUDE.md rule 6), expiry (maximum 12 months, round 14 item 4) and audit. No design exists yet.
   - Implication (label): freelancer management is NEW SCOPE. It has no phase, capability row or placement yet. Its scope is OPEN: onboarding, contracts, timesheets, invoices and payments to freelancers, and tax deducted at source on contractor payments. Tax on contractor payments needs statutory sign-off, and no statutory values are stated here. Its phase is OPEN and it is not scheduled.
   - Implication (label): contractors' timesheets and tasks in ORDERED-PLAN Phase 1C and 1D must be reconciled with the guest-account model before those items are built.
4. **Questionnaire draft (owner request, item 4).** The owner asked for the questionnaire questions and the mapping rules to be drafted for review. The draft is `docs/plan/zen360/QUESTIONNAIRE-DRAFT.md`. It is NOT approved. Its content and rules are not owner decisions until the owner approves them.

Still open after round 15 (supersedes round 14):

- Freelancer management: scope, phase, and the guest-account design (invitation, authentication, tenant scoping, expiry, audit).
- Questionnaire content and mapping rules: owner approval of `docs/plan/zen360/QUESTIONNAIRE-DRAFT.md`.
- Qualified holder of statutory sign-off, named per tenant at onboarding. Statutory values stay DRAFT.
- IT owner as a level assignment at onboarding. The name is not recorded.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).

## Owner answers, round 16 (recorded 2026-10-11)

Owner answers. This round supersedes the round 15 "Still open" list, and only the freelancer management part of round 15 item 3. Round 15 items 1, 2 and 4 are unchanged.

1. **Freelancer management is deferred (owner answer, item 1).** Freelancer management is not in Phase 0 or Phase 1. It has no phase and is not scheduled. Its scope is not decided.
   - Guest accounts for auditors, board members and contractors (round 15 item 3) stay as the access model. Their design is deferred together with freelancer management, unless an earlier phase needs them.
   - Implication (label): contractors' timesheets and tasks in ORDERED-PLAN Phase 1C and 1D must work for employees only until guest accounts are designed. Contractor access is not built in those phases.
   - Implication (label): tax on freelancer payments would need statutory sign-off when freelancer management is scheduled. No statutory value is stated here, and the deferral adds none.

Still open after round 16 (supersedes round 15):

- Questionnaire content and mapping rules: owner approval of `docs/plan/zen360/QUESTIONNAIRE-DRAFT.md`.
- Qualified holder of statutory sign-off, named per tenant at onboarding. Statutory values stay DRAFT.
- IT owner as a level assignment at onboarding. The name is not recorded.
- D-11 numbers after the one-month measurement.
- Legal checks before the first outside user: the Resend data-hosting check, and the chat-retention counsel check (D-14).
- Guest-account design (invitation, authentication, tenant scoping, expiry, audit). Deferred with freelancer management (round 16 item 1).
- Freelancer management scope, phase and statutory sign-off for tax on freelancer payments. Deferred (round 16 item 1).

## Owner answers, round 17 (recorded 2026-10-11)

- **(a) Archive the superseded plan.** The old index, `phase-0-stabilise.md` to `phase-8-proof.md`, `sequencing.md`, `rationale.md` and `prompts.md` move to `docs/plan/archive/`, each with a SUPERSEDED banner. `zen360/ORDERED-PLAN.md` is the source of truth. `docs/plan/archive/README.md` maps each old phase to the owner plan.
- **(b) Naming.** From now on the phases are called "owner Phase 0" and "owner Phase 1" only. The old P0 to P8 labels are retired. Old item numbers (for example 0.7, 1.6, 3.1) stay valid as references into the archive.
- **(c) Entry point.** `CLAUDE.md` now starts at `docs/plan/CURRENT.md` and `zen360/ORDERED-PLAN.md`. `docs/plan/CURRENT.md` records the active wave (owner Phase 0, Wave 0) and is updated when a wave closes. `docs/plan/README.md` is a short index.
- **(d) Method.** Done on a branch, `docs/plan-archive-superseded`, with a PR for owner review. Owner words: "Just do it on a branch, owner reviews the PR."

Consequences and open points:

- Old path references in earlier rounds (1 to 16) point to files now in `docs/plan/archive/`. For example, "`docs/plan/README.md` decisions A, B and C" now means `docs/plan/archive/README-old-index.md`. The text of those rounds is not rewritten. Round 16 and earlier are otherwise unchanged.
- The domain specs `ceo-office.md`, `cio.md`, `compliance.md`, `equity-portal.md`, `hcm.md`, `marketing.md` and `ceo-office-asbuilt/` are not phase files and are not moved. Code comments and the zen360 reference docs cite them. Whether they are superseded, and by what, is **open for owner decision**. The `docs/plan/ceo-office-asbuilt/phase-0.md` file also uses the word "Phase 0" for a CEO-office build record, which is not the owner Phase 0.
- Old phase labels without a file path (for example "phase-0 0.4" in the zen360 reference docs) are not rewritten in this round. They are read as old item references into the archive.
