# DECISIONS — merged leadership decision register

Merged from the twelve analysis files and `docs/plan/README.md` decisions A/B/C (A = D-01, B = D-06, C = D-05). Near-identical items from different agents are folded into one row; the agent source is in the Decision column. Nothing below is an engineering default: each needs a named owner. "Blocks" lists CAP rows that cite the decision, computed from CAPABILITIES.md, plus plan phases. Deadlines are plan phases (P0 to P8, CEO-n = `docs/plan/ceo-office.md` phase n).

Statutory and legal items are flagged for professional sign-off, not decided here (CLAUDE.md "Statutory uncertainty").

| ID   | Decision                                                                                                                                                                          | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Recommendation + reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Blocks (CAP/phase)                                                                                                                                                       | Deadline (before)                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| D-01 | Legal-entity and group model, and the intercompany mechanism (README decision A; agents 02 D1/D2, 06 D1)                                                                          | (a) Tenant = legal company, group by tenant tree and snapshots (runs today; `CompanyProfile.tenantId @unique` `main.prisma:97`). (b) One tenant with many `LedgerEntity` rows (schema intent `compliance-books.prisma:54`). (c) Tenant = legal company, `LedgerEntity` only for branch/GSTIN units inside a tenant. Intercompany: Transaction flag + pairing record vs reciprocal journal entries via `post()`.                                                                                                               | Recommend (c). Rule 6 and the one-company-per-tenant constraint make the tenant the legal entity; the `entityId` column on the journal already exists (README A is satisfied in schema, unused). Pair intercompany rows now (cheap), post reciprocal entries through `post()` once Phase 1 lands. Confirm with the accountant (D-02).                                                                                                                                                                                                                                                           | GRP 01/03/19, FND 01/02, MED 01; P1 (any journal writer), P3 consolidation                                                                                               | Phase 1 (before the first `post()` caller)                 |
| D-02 | Accounting and tax policy ownership: name the accountant and tax/legal adviser who sign every statutory or policy uncertainty (agents 01 D9, 02 D3/D4, 03, 04, 06 D11, 07 D8/D12) | Items needing sign-off: consolidation framework and elimination policy; shared-service charging basis; revenue recognition (professional services, placement fee, success fee); cash receipt restrictions and whether cash is accepted; GST exemption per course or per payer; TDS on commission; labour-code and gratuity parameters; Income-tax Act 2025 section mapping. Options: external retainer, internal finance head, or both with dual sign-off.                                                                    | Name one accountant and one tax/legal adviser now; each item becomes a dated `StatutoryRule` or policy row with a source citation, owned by them. Engineering encodes none of it (CLAUDE.md rule 4 and "Statutory uncertainty"). Reason: every ⚠️ in CAPABILITIES.md waits on this person.                                                                                                                                                                                                                                                                                                      | GRP 09/17/20/22, CON 10, CAR 04, FND 02/04, MED 02, CRM 11, FIN 18/22/25, REC 10/11, HRM 26; P1 (recognition), P3 (all statutory rows), consolidation, success fees      | Phase 1 (recognition, cash rules); Phase 3 at latest       |
| D-03 | Ledger cutover, money type and payments scope (agents 07 D1/D2/D4/D10)                                                                                                            | Cutover: route every flow to `post()` in Phase 1.5 and retire `Transaction` as the reporting source, or mirror and keep both. Money: bigint paise end to end vs Decimal in storage. Payments: statement feeds and reconciliation only, or initiate bank payments in release 1. Imports into closed periods: allow or require reopen.                                                                                                                                                                                          | Cut over now; bigint paise in application code (Decimal only at the DB boundary); statement feeds first, payment initiation deferred; no imports into closed periods, use reopen with reason. Until cutover, do not present TB, P&L or cash as statutory. Reason: `post()` has no caller and every report reads the legacy table.                                                                                                                                                                                                                                                               | GRP 21, EDU 15, FND 03, MED 03, FIN 02/05, REC 13, INT 03/05/06; P1.5, P1.6; Done-means 1, 2, 6                                                                          | Phase 1 start (money helper first)                         |
| D-04 | First-release scope, pilot, sequencing and build-vs-integrate (agents 01 D2, 12 R-1/R-3/P-1/P-3/P-11; 11 D3)                                                                      | Scope: adopt or reject the defer list (CCTV, pantry, MSP, hybrid desk booking, ventures platform, logistics). Sequencing: plan Phase 0-8 vs proposal Phase 0-4 (conflict on meaning of Phase 1; plan Phase 0 is nine defects, proposal Phase 0 is discovery). Build vs integrate per capability: payroll engine, e-signature, IdP, storage, mailbox and WhatsApp provider, accounting system of record, commission engine.                                                                                                    | Ledger first with the proposal's operating gate added to every phase; run a time-limited discovery pilot, then plan Phase 0 defects; rename proposal phases R0-R4. Adopt the defer list. Record build-vs-integrate per row with quotes (TCO). Pilot on collections and delivery (proposal p61).                                                                                                                                                                                                                                                                                                 | GRP 07, CON 01, FND 04, MED 04, CRM 11, HRM 07, DOC 04, SHR 18, INT 02/04; P0-P4 ordering; INT rows; scope of every "L" row                                              | Phase 0 (before funding Phase 1)                           |
| D-05 | Product intent and resourcing (README decision C; agents 12 S-1/S-2)                                                                                                              | Tenant-zero (hardcode Tamil Nadu, faster) vs product (PT per local body, versioned statutory packs, onboarding state machine, ~25% more work). Staffing: plan assumes one senior plus AI-assisted developers; proposal assumes 4-6 FTE. Funding: all at once vs phase by phase with a stop rule.                                                                                                                                                                                                                              | Plan assumes product; confirm it. Fund phase by phase with a stop rule and a standalone-value test for Phase 1; measure productive hours before committing the staffing model. Reason: decides Phase 3 and Phase 7 shape and whether the extra 25% is funded.                                                                                                                                                                                                                                                                                                                                   | FND 05, MED 05, SHR 20, INT 08; P3, P7; CAP-SHR-20; usage budgets                                                                                                        | Phase 1 start                                              |
| D-06 | E-invoicing route: direct to the IRP (round 25 item f), and applicability (README decision B; agent 07 D5)                                                                        | GSP (commercial, monthly cost) vs direct NIC access (static IPs per GSTIN, ~5 lakh all-in) vs not enabling until applicability confirmed.                                                                                                                                                                                                                                                                                                                                                                                     | Direct to the government e-invoice portal (IRP), not a GSP (owner answers, rounds 2, 11 and 25). Accountant confirms whether and when each tenant must report and the reporting window before any e-invoice rule is enabled; the window is a `StatutoryRule` row. Reason: unconfirmed applicability must not be coded.                                                                                                                                                                                                                                                                          | FND 06, MED 05/06, FIN 24; CAP-FIN-24; P3.2                                                                                                                              | Phase 3                                                    |
| D-07 | Identity, party and tenancy architecture (agents 02 D6, 06 D6, 11 D1, 12 R-2)                                                                                                     | Cross-company identity: one identity with per-company grants, or one user per tenant with a linked principal. Party supertype vs separate Person/Organization tables. IdP/SSO choice. Cross-tenant sharing: aggregate snapshots only, or `ProjectionGrant` record exchange. Tenancy hardening: plan Phase 7 vs proposal Phase 0 (before external exposure).                                                                                                                                                                   | Linked principals per tenant (keeps rule 6 and clear audit) plus explicit `ProjectionGrant` for any cross-tenant read; defer the Party supertype unless an Affiliation must point at an Organization; pick the IdP in the pilot; pull tenant and access checks forward of any external exposure. Reason: shared-services staff, portals and group views all depend on it.                                                                                                                                                                                                                       | GRP 10, FND 07, MED 07, TEC 11, SHR 08/10/20, INT 01, PRV 01; CAP-GRP-10, CAP-SHR-08/10/20, CAP-INT-01, CAP-PRV-01; P7 ordering                                          | Phase 2 (before any external user)                         |
| D-08 | External users and portals at launch: customers, institutions, learners, guardians, clients, auditors (agents 03 #9, 05 D4, 09 #3, 10 D4, 12 R-4)                                 | None at launch (staff-assisted intake, internal team records external decisions). Read-only status portal. Full portal with approvals.                                                                                                                                                                                                                                                                                                                                                                                        | None at launch; capture through one staff-assisted record. Build a portal as a separate product after Phase 4 and D-07, with a leakage fuzzer and negative tests. Reason: there is no external-user identity or permission model, and the plan has no phase for it.                                                                                                                                                                                                                                                                                                                             | FND 08, MED 08, DEL 15; CAP-DEL-15/16, CAP-MED-08, CAP-CON/SEC client acceptance; Done-means 5                                                                           | Phase 4                                                    |
| D-09 | Authority model: DoA matrix, delegation, alternates and reserved matters (agents 10 D1/D2/D8/D9, 03 #7, 02 D9, 01 D10, 12 P-5)                                                    | Thresholds and alternates per decision class; which classes are founder-only (proposal implies none for routine work); one delegation store (retire decision `Delegation` `main.prisma:905`, keep HR `DelegationOfAuthority`, or a new `DelegationLog`); single approvals inbox vs separate; who names reserved matters; who may publish a public correction or customer status.                                                                                                                                              | One delegation model; union inbox read model; no founder default routing (`decisions.ts:62`); directors enter thresholds as data with a named alternate per class; reserved matters owned by the board via Resolution. Reason: the 24-hour absence test cannot pass otherwise; no number is hardcoded.                                                                                                                                                                                                                                                                                          | GRP 14, FND 09, MED 07/09, TEC 11, DEC 04/05/06/08; CAP-DEC-04/05/06/08, CAP-GRP-11/14, CAP-MED-07, CAP-TEC-11; CEO-5                                                    | CEO-office Phase 5 (before the absence test)               |
| D-10 | Privileged access and independent review (agents 10 D5-D7, 11 D9)                                                                                                                 | Break-glass: permitted actions, duration, alert list, after-action reviewer. Platform admin access to HR and finance content. Auditor role scope and duration. Independent reviewer for related-party and founder transactions (authorised director, accountant, or other). Data-owner approval for access grants.                                                                                                                                                                                                            | Break-glass is time-limited, alerts named people, needs after-action review, and cannot bypass audit, tenant gate or period close. No platform-admin content access by default. Name the related-party reviewer now (an authorised director or the accountant). Reason: these roles do not exist in the 7-role register.                                                                                                                                                                                                                                                                        | FND 10, MED 01/10, DEC 04/09/10, PRV 05; CAP-DEC-04/09/10/11, CAP-PRV-05                                                                                                 | Phase 2                                                    |
| D-11 | Operating ownership, service levels and metrics (agents 11 D2, 08 D2/D3, 10 D11, 03 #8, 01 D6, 07/10 cash view)                                                                   | Which object types make primary owner, backup and accountable position mandatory; how long a default owner may stand; which roles need a backup; whether final settlement is blocked until handover is acknowledged; service-level targets (enquiry, complaint, delivery risk); owner of the qualification register; metric definitions and baselines (duplicate entry, approval delay, owner coverage, which revenue figure marketing reports); whether the founder cash forecast excludes unverified receipts.              | Mandatory on pilot processes only; block settlement for customer-facing roles until receivers acknowledge; set service levels and targets after a measured baseline; forecast excludes unverified receipts by default; one metric dictionary before any pack. Reason: proposal values are design targets and several pilot gates have no baseline.                                                                                                                                                                                                                                              | CON 08, MED 11/13/16, CRM 01, REC 06, HRM 16/17, COM 13, DOC 06, DEC 14, SHR 02; CAP-SHR-02, CAP-HRM-16/17, CAP-DEC-14, CAP-DOC-06, CAP-CON-08, CAP-REC-06               | Phase 4 (pilot gate)                                       |
| D-12 | Customer case ownership and delivery acceptance (agents 09 D3-D6, 10 D3, 07 D6/D7/D11, 01 D3)                                                                                     | Complaints: new `Case` model vs extend the learner exception. Accountable delivery owner on a won deal (sales, delivery or finance). Won = executed contract only, or an executed MoU too. Who owns acceptance and whether it drives billing. Free-change approval class. Collection policy owner and promise-vs-cash rule. Work-log boundary (aggregate only vs person-level).                                                                                                                                               | New `Case` with an exception raised from it; named delivery owner at handoff; won = executed contract (MoU counts only when executed and typed); acceptance separate from technical completion and drives the billing trigger; work logs reported in aggregate. Reason: complaints are the central lifecycle and have no model.                                                                                                                                                                                                                                                                 | MED 12, CRM 04/13, REC 08, DEL 04/07/11; CAP-DEL-04/07/11, CAP-CRM-04/11/13, CAP-REC-08                                                                                  | Phase 4 (before R1 pilot)                                  |
| D-13 | Communication capture and recording (agents 01 D4, 09 D1/D2/D14, 08 #9, 12 R-9/P-6/P-7)                                                                                           | Providers: WhatsApp route (Cloud API, BSP, coexistence), email (Microsoft 365 or Google Workspace), telephony. Whether recordings and transcripts are in scope at all. Consent wording and retention. Business-number and mailbox ownership. Historical communications import scope.                                                                                                                                                                                                                                          | Start with structured call/outcome logging and the official WhatsApp Cloud adapter already built; no recording or transcripts until counsel signs notice, consent, retention and India-region transcription; choose the mailbox provider with an eligibility check. Reason: recording law and DPDP application are unverified.                                                                                                                                                                                                                                                                  | EDU 21, MED 13, COM 02/04/05/06/07; CAP-COM-02/04/05/06/07, CAP-EDU-21; Phase 6 transcription                                                                            | Phase 4 (capture); Phase 6 (transcription)                 |
| D-14 | Privacy, retention, erasure and residency (agents 11 D4-D6/D13, 12 R-7/R-8/R-10, 09 #10, 04 #8, 06 #7)                                                                            | DPDP commencement date (plan says 14 May 2027, proposal says do not assume). One retention table and sign-off per class. Erasure vs eight-year audit retention: crypto-shredding, minimised audit facts with an erasable content store, or a separate keyed store. Legal-hold authority. Backup erasure rule. KMS and per-tenant key holder. India residency per provider and backup. Learner data to funders and careers sharing purposes.                                                                                   | Counsel confirms dates before any copy states them. Single retention table in `StatutoryRule` shape; audit chain holds minimised facts plus a salted subject token, content in an erasable store; restore-then-re-erase for backups; per-tenant DEK via KMS; legal hold overrides purge. Reason: the three plan documents propose three different resolutions.                                                                                                                                                                                                                                  | CAR 03, FND 07, MED 14, COM 07, DOC 01/05, SHR 07/10, PRV 03/07/11/12/13/17; CAP-PRV-03/07/11/12/13/17, CAP-DOC-01/05, CAP-SHR-07/10, CAP-CAR-03, CAP-FND-07, CAP-COM-07 | Phase 2                                                    |
| D-15 | AI autonomy, providers and evaluation (agents 06 D2/D3/D9/D10, 11 D7/D11, 01 D5, 05 D5, 12 T-1)                                                                                   | Keep or remove the "AI-native" claim (`README.md:3`). Keep any AUTONOMOUS_WITHIN_POLICY touchpoint (revenue treatment, owner resolution, identity link, routing). Provider, accounts, credentials, approved models, spend caps, India-region rule. Evaluation owner, 200-case floor per module, mandatory human-only baseline arm. Test-double policy (sandbox or recorded contracts vs "no mock"). Defer OCEL, bottleneck and predictive analytics until an event-completeness metric exists. External content for research. | Remove the claim until an adapter, eval harness and first gated feature exist. Downgrade revenue treatment, owner resolution and identity link to RECOMMEND; keep routing/lead scoring only after the tier and prohibition fixes. Use sandboxes or recorded contracts, not mocks. Name an owner per use case. Reason: zero model calls exist and the fence has bypasses.                                                                                                                                                                                                                        | MED 15, COM 10, SHR 15/18, INT 08/09, AI 01/02/04/05/16/17; CAP-AI-01..17, CAP-COM-10, CAP-INT-08/09; Phase 5.3, Phase 6                                                 | Phase 6 (claim wording now)                                |
| D-16 | Event delivery and tamper-evidence claims (agents 06 D4/D5, 11 D8)                                                                                                                | Transactional outbox in Postgres vs external queue. Claim "tamper-evident" externally or call it an integrity log. Anchoring: where, who holds the key, how often verified.                                                                                                                                                                                                                                                                                                                                                   | Postgres outbox; describe the chain as an integrity log until the verifier recomputes content hashes across the whole chain; name the anchor-key holder before any auditor-facing claim. Reason: `verifyChain` reports valid without recomputing and checks 5,000 rows.                                                                                                                                                                                                                                                                                                                         | MED 16, SHR 11/13, PRV 07; CAP-SHR-11/13, CAP-PRV-07                                                                                                                     | Phase 2                                                    |
| D-17 | Foundation, restricted funds and funding vocabulary (agents 04 #2/#3, 06 D8, 02 D5, 12 R-6)                                                                                       | Which legal entity receives donor and CSR money (a separate tenant); tax status (Section 8, 12A, 80G, CSR eligibility); whether the platform tracks restricted funds at all and who validates a purpose; name the funding model `FundingAward` (not `Grant`).                                                                                                                                                                                                                                                                 | Do not build the Foundation module until legal form and a tax adviser's opinion exist. If tracked, enforce a fund dimension at `post()` only (after D-01 and Phase 1), never in the UI. Use `FundingAward`. ⚠️ No eligibility rule is encoded without adviser sign-off.                                                                                                                                                                                                                                                                                                                         | FND 01/02/03; CAP-FND-01..10, CAP-GRP-21/22, CAP-VEN-14                                                                                                                  | Phase 1 (if a fund dimension is wanted), otherwise Phase 7 |
| D-18 | Practice offers: security, careers and consultancy (agents 03 #1-#10)                                                                                                             | Practice placement: same tenant with a practice discriminator vs separate entities/tenants. Whether the platform holds client restricted evidence. Who signs authorised testing scope and who may accept a client risk. CCTV go/no-go. Careers launch order and whether guarantees, refunds and success fees are offered.                                                                                                                                                                                                     | Same tenant with a practice discriminator and a `Project` fix until D-01 says otherwise. Hold finding summaries only; keep client evidence outside the platform until a restricted store and counsel review exist. Remove CCTV from this programme or use a partner VMS (privacy impact assessment first). Launch only models the code and counsel support; defer Kaizen-employed deployment, third-party-employed and payroll-only until counsel confirms status. Offer guarantees and success fees only after the accountant (D-02) settles recognition and the refund-liability ledger path. | SEC 01/02/05/10, CAR 01/07/12; CAP-SEC-01/02/05/10, CAP-CAR-01/07/12, CAP-CON-10                                                                                         | Phase 4 (before any engagement model is built)             |
| D-19 | Education and skill-development policy (agents 04 D1/D4-D10, 08 D7-D11, 10 D10)                                                                                                   | Scheme-specific claim workflows now vs funding guards only. Who verifies competence and who revokes a certificate; whether verification is public. Attendance denominator (excused sessions) and biometric. Trainer-substitution notice and refund basis. Programme and cohort version pinning. Fee-calculator margin definition (on revenue vs markup). GST exemption per course vs per recipient. LMS: build bounded modules vs integrate.                                                                                  | Guards only until a scheme is contracted (enrolment-level funding, invoicing guard); completion asserts claimed, not assessed; pin versions on cohorts from creation; margin on revenue; per-course exemption with a visible invoice flag until counsel answers; state LMS portability and identity needs before choosing. Reason: person-level funding rows already exist and the proposal disclaims scheme assertions.                                                                                                                                                                        | SKL 02, EDU 08/10/11/16/20/23, FIN 22; CAP-SKL-01..10, CAP-EDU-01/08/10/11/16/20/23                                                                                      | Phase 4 (before cohort schema change)                      |
| D-20 | Ancillary module scope and tenancy (agents 05 D1-D7/D9, 08 D5, 11 D10, 06 D6)                                                                                                     | MSP tenancy: tenant per customer vs customer dimension inside the company tenant. Shared logistics and procurement: in or out. Ventures: record only vs pipeline and approval flow. Social publishing: manual until a provider is approved. Remote workspace and hybrid desk booking: build, buy or defer. Spin-off: accept the documented approval bypass on the opening allotment, and script-carry vs counsel-led legal transfer.                                                                                          | Defer MSP, logistics, remote workspace and desk booking; ventures record-only; manual social publishing stays the default; spin-off must pass the normal approval path and be audited, with counsel running the legal transfer and the script moving data only. Reason: none of these has a tenancy or legal design yet.                                                                                                                                                                                                                                                                        | GRP 13, MED 11, TEC 05/10/19, HRM 28, INT 10; CAP-TEC-05/06/07/10/19, CAP-INT-10, CAP-HRM-28, CAP-MED-11, CAP-GRP-13, CAP-VEN-08                                         | Phase 7 (MSP/tenancy); before first spin-off commit        |

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
- Feature 1 needs: the Task completion route fix at `crm.routes.ts:1109` first; tenant row-level security on new work tables (CLAUDE.md rule 6); legal review before Phase B (warning only, round 25); a check against CAP-HRM-32 (no covert monitoring); SSE tested first for realtime; chat kept under the 8-year retention rule (counsel confirmation is warning only, round 25); and the doc's decisions on transactional email and object storage (email open, storage deferred).
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
  - Implication (label): `docs/plan/zen360/` Phase 3 file and `docs/plan/README.md` decision B recommend a GSP and now disagree with the owner. They are not edited in this round. They are flagged for update when Phase 3 is scheduled. Round 25 item f changed the `docs/plan/zen360/` files. Round 26 checked `docs/plan/README.md`: it has no decision B and no GSP text, so the GSP recommendation now survives only in the archive (`docs/plan/archive/README-old-index.md:48`, `docs/plan/archive/phase-3-statutory.md:43`). The archive is history and is not edited.
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

## Owner answers, round 18a (recorded 2026-10-10, during Wave 0 and Wave 1 implementation)

_renamed from round 18 to remove a numbering collision (2026-10-11)_

- **(a) IT-policy self-dealing approvals go to the chairman.** FX-01 now requires the approver to hold `it_policies:approve`, and only the chairman holds it (`docs/plan/cio.md:144`). So the self-dealing publish step routes to the chairman, not to `finance_head`. Implication: tenants seeded before this change still carry the old approval chain, so a new policy version is needed. Open.
- **(b) No role means no access.** An affiliation with no access role grants nothing. It used to fall back to `sales`. Before deploy, `report:roleless` lists the people affected.
- **(c) Access differs by vertical as well as level.** Owner words: "A telecalling staff is different from a trainer staff." Level (Head, Manager, Staff) alone does not set access. The function or vertical picks the role template, and the level then sets the duties. This confirms `QUESTIONNAIRE-DRAFT.md` section 0, step 2. The function list there is still open and must include verticals such as telecalling and training.
- **(d) Creating a new hire prompts the onboarding owner to run the stakeholder-mapping questionnaire.** Owner words: "creating a new hire will automatically prompt HR to go through the questionnaire for stakeholder mapping." This is built in Wave 6 with the onboarding state machine. Until it is confirmed, the hire holds the Staff default duties (round 15) and nothing more.
- **(e) Wave 0 goes up as a PR** (THeK1DUNBXR/OOSS#32). Wave 1 lands after Wave 0's CI is green.

Still open after round 18a:

- Who receives the new-hire prompt. Round 13 says "the founder or the onboarding owner". The owner said "HR". Is HR the onboarding owner by default?
- The function and vertical list, and the role template for each (telecalling, training, and others).
- Whether an interim hire-time role, before Wave 6, matches the Staff baseline. This is under check against the existing `employee` role.
- Whether `sysadmin@` should hold the chairman role in the seed. The FX-01 tests routed a chairman step to it.

## Owner answers, round 19a (recorded 2026-10-10, access-model plan review)

_renamed from round 19 to remove a numbering collision (2026-10-11)_

Context: the access-model plan draft (`docs/plan/zen360/ACCESS-MODEL-PLAN.md`, DRAFT v2) and the owner's corrections given during its drafting.

- **(a) HR runs employee onboarding.** HR answers the stakeholder-mapping questionnaire and owns the onboarding case. This resolves round 13 (D:428, "founder or onboarding owner") against round 18a (d), in favour of HR.
- **(b) Nothing is set up by hardcode.** No employees or roles are set up through hardcode; they are set up only during onboarding. Levels, verticals and every person's access become tenant data. The seeded role matrix (`apps/api/src/seed/grants.ts`) stops being the source of access. Open: whether an unassigned, editable starter template may ship, given round 10's "template ships with the app".
- **(c) Statutory sign-off is a guided in-app setup.** It runs after the application is set up: the accountant logs in, and a guided setup takes her through approving the statutory rules. Onboarding and access mapping no longer wait on statutory sign-off. Features that depend on statutory rules stay gated until the accountant approves those rules. This reverses the BLOCKED-BY on P7 in ORDERED-PLAN (OP:125) (owner answer to plan question 6: "yes").
- **(d) The access model is level × vertical, not a job-role model.** A vertical (with units) decides which records a person reaches. A level decides how far that reach goes and how much the person may approve. Telecalling versus training, and every similar case, comes from the vertical or unit, never from a job title.
- **(e) The vertical structure is researched, not inherited.** The owner directs that verticals must not rely on the list defined at inception (`packages/shared/src/domain.ts:9-20`). The verticals must be researched and fixed firmly, so that growth of the app or the company does not break records, access or reports. Research is under way; a vertical taxonomy proposal follows for approval.
- **(f) Multiple placements are allowed.** A person may hold placements in more than one vertical or unit, each with its own level.
- **(g) Who confirms access.** HR answers. The vertical Head confirms placements in their vertical. The founder confirms sensitive extra duties, Head placements and HR's own mapping (owner answer to plan question 5: "yes").

## Owner answers, round 20v (recorded 2026-10-10, vertical taxonomy)

Context: the vertical taxonomy proposal (`docs/plan/zen360/VERTICAL-TAXONOMY.md`), which answers round 19a (e). The owner approved all five decisions ("yes to all 5").

- **(a) Five business lines.** SKL Skill Development, EDU Education, CLR Corporate Learning, TEC Technology Services and WFS Workforce Solutions. Media & Marketing stays a shared function until it earns external revenue; the five-question test in the taxonomy decides when it graduates.
- **(b) The registry is group-level.** `BusinessLine` IDs are immutable and shared across the group's legal entities. A split or merge creates successors through a dated mapping. History stays as it was booked, never rewritten.
- **(c) The payer decides the line.** Revenue goes to the line of the customer who pays, not the team that delivers. Shared delivery cost is distributed in basis points that total 10,000.
- **(d) SAP work splits by payer.** SAP consulting is TEC. SAP training sold to companies is CLR.
- **(e) Five things are not lines.** Research is a cost centre. Partnerships is a channel. Telecalling is a unit or channel. Ventures are legal entities. The Foundation is a separate Section 8 entity.

Consequence for the plan: the registry and its foreign keys land in Waves 2–3, before the ledger, so `JournalLine` carries `lineId` and `costCentreId` from its first posting.

## Owner answers, round 18b (recorded 2026-10-11)

_renamed from round 18 to remove a numbering collision (2026-10-11)_

Owner answers given after round 17. Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged, except where this round says it supersedes or provisionally holds an earlier answer. This round supersedes the round 17 "Still open" list. Where no answer is recorded here, the earlier rounds and the drafts stand.

Numbering note: an earlier section is also titled "Owner answers, round 18a (recorded 2026-10-10, during Wave 0 and Wave 1 implementation)". Both are round 18. This section is the one recorded 2026-10-11, and the markers in the plan files say so.

1. **Tenancy work is deferred until commercialisation (owner answer, item 1).** The company runs as one tenant for now. Deferred:
   - FX-51, RLS on every table;
   - the second-tenant tenant-leakage fuzzer;
   - the tenant-isolation CI gate (G7);
   - per-tenant webhook HMAC. FX-50 becomes a single webhook secret;
   - per-tenant encryption keys (round 5, item 6);
   - separate subsidiary tenants and the holding-company link (D-01);
   - per-tenant editing of access-level templates.
     Existing tenant scoping in the code stays untouched.
2. **PgBouncer is not a blocker (owner answer, item 2).** This supersedes the ORDERED-PLAN item 1.2 blocker that named PgBouncer in transaction mode. Revisit only if connections run short.
3. **All hosting decisions are deferred until after Phase 1 (owner answer, item 3).** The owner will separately consider how to host efficiently and which caching and routing to use. This covers:
   - server operations (ORDERED-PLAN Wave 4);
   - the reverse proxy (round 7: Caddy);
   - backups tooling. The owner named Databasus as the backup setup. It is a PostgreSQL backup tool, not a connection pooler, and it does not make the app faster. Claude has not read its documentation, and nothing in these docs evaluates it;
   - monitoring, TLS renewal, static IP and redundancy notes;
   - the round 6 and round 7 own-server decisions, which become provisional history.
4. **LiveKit: configurable server address only in Phase 1 (owner answer, item 4).** The code needs only a configurable server address for LiveKit voice and video (ORDERED-PLAN Phase 1 Wave 6). Where the server runs is a hosting decision for after Phase 1. Development and tests use a local setup. Owner words: "the server will obviously run when the app is hosted". This supersedes the round 6 note that LiveKit runs on the own server in Phase 1.
5. **The non-owner database role stays in the build waves (owner answer, item 5).** It is a dev and CI database setting, needed for the ledger immutability test (ORDERED-PLAN item 1.2). It is not a hosting item.

Implications (label):

- (a) CLAUDE.md rule 6 still binds new code. This answer stops new tenancy work. Existing scoping is not removed.
- (b) The ledger `entityId` (D-01, round 2) is kept, because it is cheap now and expensive to retrofit, unless the owner says otherwise.
- (c) Round 4's FX-51 addition, round 5 item 6 (per-tenant key), round 6 operations wave and round 7 infrastructure answers are superseded or provisional, and are kept as history.
- (d) The onboarding state machine, per-state packs and the guided level-mapping flow stay in Phase 0 Wave 6 as recorded. Whether they are also commercialisation-only is OPEN.
- (e) The Resend data-hosting and chat-retention legal checks are unaffected.
- (f) The CLAUDE.md line "the API is served from the company's own server in India" reflects round 6 and is now provisional. It is not edited here.
- (g) The RLS that the existing ledger migration sets on the ledger tables (CI-GATES-DRAFT G7, "exists today"), and the RLS and `set_config` items in ORDERED-PLAN 1.2, stay because rule 6 binds new code. Only the every-table sweep (FX-51) is deferred. Owner to confirm.
- (h) The Wave 0 "Hosting" item (remove the Cloudflare Worker, serve from the own server behind Caddy) is a hosting decision, so it is deferred with the rest. The CURRENT.md status note records the Worker as removed on the branch. Whether that stands is for the owner to confirm.

Still open after round 18b (recorded 2026-10-11, supersedes the round 17 list):

- Hosting, caching and routing (after Phase 1).
- Whether onboarding and level mapping stay in Phase 0 (implication (d)).
- Questionnaire approval.
- Statutory sign-off holder and IT owner (tbd during onboard).
- D-11 numbers.
- Resend data-hosting and chat-retention legal checks.
- E2EE in LiveKit stays UNVERIFIED. Per-tenant LiveKit isolation is deferred with tenancy (item 1). This bullet is drafted from the ORDERED-PLAN Wave 6 marker, not an owner answer.

## Owner answers, round 19b (recorded 2026-10-11)

_renamed from round 19 to remove a numbering collision (2026-10-11)_

Owner answers given after round 18b (recorded 2026-10-11). Each item is an owner answer unless it is marked as a note or an implication. This round answers round 18b implications (f), (g) and (h), and clarifies what "defer FX-51" meant in round 18b item 1.

Numbering note: this section is titled round 19 by the owner's request. An earlier section, "Owner answers, round 19a (recorded 2026-10-10, access-model plan review)", already has that title. Two sections are titled round 18 (see the round 18 numbering note). Read the date to tell them apart.

1. **Row-level security stays (owner answer, item a).** The tenant_rls migration, the app running as a role bound by the security rules, and the test that requires every new tenant table to set up the same security are KEPT. They were merged to main in PR #33. They cost nothing now, and CLAUDE.md rule 6 still requires them for new code. Only the extra proof work stays deferred: the tenant-leakage fuzzer, gate G7, per-tenant keys and HMAC, and subsidiary tenants. Removing RLS later would be a new migration, not a revert.
   - Clarification of round 18b implication (g): FX-51's substance is merged and stays. The "defer FX-51" wording in round 18b item 1 means no further tenancy work beyond what is merged.
   - Note (not an owner answer): Claude checked through the GitHub API that PR #33 is closed and merged into main on 2026-10-11, and that the FX-51 RLS commits are in main's history. Claude did not read the full PR diff, so the exact scope of PR #33 comes from the owner's message.
2. **The Cloudflare Worker removal stands (owner answer, item b).** The Worker that served the built client and proxied `/api` stays removed. Only the hosting choices that replace it (reverse proxy, caching, routing) wait until after Phase 1. This answers round 18b implication (h).
3. **CLAUDE.md says hosting is undecided until after Phase 1 (owner answer, item c).** The CLAUDE.md hosting sentence now says that hosting (server, reverse proxy, caching, routing) is undecided until after Phase 1. The sentence that named the company's own server and Caddy is removed. This answers round 18b implication (f), which had left that line unedited.

Still open after round 19b (recorded 2026-10-11, supersedes the round 18b list):

- Hosting, caching and routing (after Phase 1).
- Whether onboarding and level mapping stay in Phase 0 (round 18b implication (d)).
- Questionnaire approval.
- Statutory sign-off holder and IT owner (tbd during onboard).
- D-11 numbers.
- Resend data-hosting and chat-retention legal checks.
- E2EE in LiveKit stays UNVERIFIED. Per-tenant LiveKit isolation is deferred with tenancy (round 18b item 1).
- Round numbering: two sections titled round 18 exist, and a round 19 section dated 2026-10-10 exists above this one.

## Owner answers, round 20 (recorded 2026-10-11)

Owner answers given after round 19b (recorded 2026-10-11). Each item is an owner answer.

1. **Gate G7 stays DEFERRED as a whole (owner answer, item 1).** The check that every new tenant table sets up RLS is not split out as a named CI gate. The merged test from PR #33 stays in the test suite; it is not a named gate. This answers the round 19b question on G7 in CI-GATES-DRAFT.md.
2. **The README.md hosting section is LEFT AS IS (owner answer, item 2).** The section (README.md lines ~330-354, own server behind Caddy) stays as the provisional round 6/7 answer. CLAUDE.md says hosting is undecided until after Phase 1, so the two differ knowingly. Neither is edited to match the other in this round.

Still open after round 20 (recorded 2026-10-11, supersedes the round 19b list):

- Hosting, caching and routing (after Phase 1).
- Whether onboarding and level mapping stay in Phase 0 (round 18b implication (d)).
- Questionnaire approval.
- Statutory sign-off holder and IT owner (tbd during onboard).
- D-11 numbers.
- Resend data-hosting and chat-retention legal checks.

## Owner answers, round 21 (recorded 2026-10-11)

Owner answers given after round 20 (recorded 2026-10-11). Items 1 to 4 are owner answers. The implications (a) to (g) are Claude's reading of them, not owner statements, and none of them has been researched.

1. **Each employee gets a company mailbox created and hosted by the app, plus an inbox in the app (owner answer, item 1).** This is not a connection to an existing provider, and it is not internal-only messages.
2. **The company has no email service today (owner answer, item 2).** Employees have no company email yet.
3. **Placement: Phase 1, communication wave, alongside COM-02, COM-13 and COM-15 (owner answer, item 3).**
4. **The inbox both sends and reads employees' mail, linked to customers (owner answer, item 4).** This pulls the Z3 communications-capture idea, previously deferred, into this scope for employee mail.

Implications (labelled as implications, not owner statements; Claude has not researched these):

- (a) This is new large scope with no CAP row, spec or phase item. It supersedes round 5's "transactional email only via Resend" only for employee mail. Resend stays for system notifications. Company mailboxes need an SMTP/IMAP (or equivalent) mail service, domain DNS records (MX, SPF, DKIM, DMARC), IP reputation and deliverability, spam and virus filtering, storage and backups, and mailbox quotas.
- (b) It conflicts with "all hosting decisions deferred until after Phase 1" (rounds 18b and 19b). Mailboxes need a host, a stable public IP and reverse DNS. Either email hosting is decided as an exception, or the mail service runs as a configurable external service in development.
- (c) "Read and link to customers" needs permission rules for who can see whose mail (access levels, rounds 9 to 14). It also needs retention and legal-hold rules (legal hold was deferred, warn-only), DPDP considerations for personal data in mail, and audit rows per CLAUDE.md rule 5.
- (d) Round 5 (D-04) says build natively and read open-source code to learn, never copy. A full mail server is a very large build. Building natively versus running an open-source mail server as a service (as with LiveKit) is an OPEN decision. Licences of candidate mail servers are UNVERIFIED.
- (e) CLAUDE.md prohibits any agent from emailing a customer without human approval. This stays.
- (f) The Resend data-hosting check and the chat-retention legal checks are unaffected.
- (g) Effort is not estimated. Phase 1 now has a very large item.

Still open after round 21 (recorded 2026-10-11, supersedes the round 20 list for mail items; the round 20 items are carried below):

- Build versus run an open-source mail server as a service (research needed, licences unverified).
- Email hosting versus the "hosting after Phase 1" deferral.
- Domain name and DNS ownership for company email.
- Mailbox limits and retention.
- Access rules for reading other people's mail.
- Whether this is sequenced late in Phase 1.
- Hosting, caching and routing (after Phase 1).
- Whether onboarding and level mapping stay in Phase 0 (round 18b implication (d)).
- Questionnaire approval.
- Statutory sign-off holder and IT owner (tbd during onboard).
- D-11 numbers.
- Resend data-hosting and chat-retention legal checks.

## Owner answers, round 21b (recorded 2026-10-11)

Renamed from "round 21" on origin/main. The round 21 label is already used for the mail answers above, so this block takes the suffix b. Its items repeat the round 22 items a to d below on the same points; both are kept as recorded.

Owner answers given after round 20 (recorded 2026-10-11). Each item is an owner answer unless it is marked as an implication. Existing rows and the earlier answers above are unchanged. This round supersedes the round 20 "Still open" list. Where no answer is recorded here, the earlier rounds and the drafts stand.

1. **The customer Case record stays in Phase 0 Wave 6 (owner answer, item 1).** This resolves the conflict between the Wave 6 list in `docs/plan/zen360/ORDERED-PLAN.md`, which names the Case record, and the ROADMAP row "Customer Case model (Z2)", which said out of Phase 0. The "Z2: customer case out" entry in the "Phase 0, out or undecided" list under "Owner phase definitions and scope" (recorded 2026-10-10) is superseded by this item and kept as history.
2. **Delegation and the 24-hour absence test are owned by Phase 1A approvals (owner answer, item 2).** They are not Phase 0 Wave 6 items. The 1A item in ORDERED-PLAN.md holds the delegation record with its expiry, the named alternate and the escalation after 24 hours of absence. ROADMAP.md no longer lists the 24-hour founder-absence scenario in the Wave 6 exit.
3. **Onboarding and level mapping stay in Phase 0 (owner answer, item 3).** The P7 onboarding state machine, the per-state packs and the guided level-mapping flow stay in Phase 0 Wave 6. This closes round 18b implication (d), which was OPEN.
4. **Item 3.1 sign-off is not a blocker for the P7 onboarding state machine (owner answer, item 4).** This matches round 19a (c). The "BLOCKED-BY 3.1 sign-off" lines in ORDERED-PLAN.md Wave 6 are struck, and the related note in ROADMAP.md Wave 1 is marked.

Implications (label):

- (a) Phase 0 scope does not grow. The Case record was already in the ORDERED-PLAN Wave 6 list, so the change is to the ROADMAP row and the Wave 6 summary wording.
- (b) Item 2 says who owns the 24-hour absence test, not what its rule is. The D-09 open item for the 24-hour absence test stays open until the Phase 1A design settles it.
- (c) Item 4 removes a build-order block only. It does not unlock any statutory-dependent feature. Those stay gated until the accountant approves the rules (round 19a (c)), and the values stay DRAFT (round 10).

Still open after round 21b (recorded 2026-10-11, supersedes the round 20 list):

- Hosting, caching and routing (after Phase 1).
- Questionnaire approval.
- Statutory sign-off holder and IT owner (tbd during onboard).
- D-11 numbers.
- Resend data-hosting and chat-retention legal checks.

## Owner answers, round 22 (recorded 2026-10-11)

Owner answers given after round 21 (recorded 2026-10-11). Items a to f are owner answers. The caveats and the feature list in the mail items are Claude's research notes, not decisions, unless marked as the owner's.

a. **Customer case record stays in Phase 0 Wave 6 (owner answer, item a).** ROADMAP.md previously said it was out of Phase 0. Fixed in round 22.

b. **Delegation and the 24-hour absence test are owned by Phase 1A (owner answer, item b).** Removed from the Phase 0 Wave 6 exit in ROADMAP.md. Listed as an exit test for 1A in ORDERED-PLAN.md and ROADMAP.md.

c. **Onboarding and level mapping stay in Phase 0 Wave 6 (owner answer, item c).** They do not wait for commercialisation. This answers the open question "whether onboarding and level mapping stay in Phase 0" (round 18b implication (d)), which is closed.

d. **Statutory sign-off is not an onboarding blocker (owner answer, item d).** Round 19a(c) lifted it. Reconciliation applied in round 22: the BLOCKED-BY on P7 onboarding was removed, and the BLOCKED-BY on item 3.1 itself was removed too, because 3.1 is the DRAFT table that onboarding depends on (see ACCESS-MODEL-PLAN.md section on 3.1). Statutory-dependent features stay gated until the accountant approves the rule. Statutory values stay DRAFT.

e. **Account recovery goes through the founder or the IT admin (owner answer, item e).** SMS to employees' phones is NOT a recovery method. The owner chose this over SMS. Reason noted by the owner: SIM-swap risk on a finance system. Implication, not an owner statement: the IT admin is a level assignment (round 10), so the recovery path depends on that assignment being made at onboarding.

f. **Mail server: the owner decided to FORK Stalwart Mail Server and adapt it to Zen 360 (owner decision, item f).** The owner said commercialisation is not a concern now ("our team will take care of it later"). Recorded as the owner's decision. The points below are unresearched caveats, not decisions. Each needs checking before any code is taken.

Caveats (UNVERIFIED unless stated):

- Stalwart is AGPL-3.0. A modified version used over a network means offering its source to its users. Changing the licence later is not possible without the paid Enterprise Licence v2. The terms of that licence have not been read.
- Enterprise-licensed features may not be in the forked code. Not verified.
- Version 0.16 replaced the REST API with JMAP. The 0.15 to 0.16 migration is irreversible without a backup.
- Releases are weekly. Upstream security fixes must be merged by us.
- Not verified: JMAP authentication and impersonation, webhook event names, DNS requirements, backup and restore, resource needs, export format.
- Hosting still conflicts with "hosting after Phase 1" (round 18b, 19b): MX, SPF, DKIM, DMARC, PTR, port 25 and a static IP. The domain and DNS owner is still open.
- Conflict with the ORDERED-PLAN "read and learn only" rule (open-source use). Recorded in ORDERED-PLAN.md as an exception needing review.

Survey notes (Claude's research summary, not decisions):

- Mailflare is ruled out: Cloudflare lock-in, and no IMAP.
- Mailcow was the runner-up.
- Open-source features and the public feature lists of paid products were surveyed.
- Reverse engineering of proprietary software is NOT part of the plan. Only public documentation is used.

Phased inbox feature list (proposal for the owner to confirm; not estimated):

- MVP: mailboxes; send and read; threading; customer linking; founder or IT-admin access, with every access logged; an approval queue for agent-drafted mail (CLAUDE.md rule 5 and the rule that no agent emails a customer without approval); audit via assertCan, then write, then auditWrite, then emit.
- v2: shared inboxes; assignment; internal comments; undo send; rules; out-of-office; search.
- Later: legal hold; retention per tenant; DLP; scheduled send.

DPDP duties for employee mail (personal data in mail, retention, access, erasure against the 8-year retention in D-14): UNVERIFIED. Needs counsel. Not checked here.

Still open after round 22 (recorded 2026-10-11, supersedes the round 21 list for the items below):

- Mail: build versus fork. The owner has decided to fork Stalwart. The caveats above are open. Whether the fork is compatible with the "read and learn only" open-source rule is open.
- Mail: email hosting versus the "hosting after Phase 1" deferral. Still open.
- Mail: domain name and DNS owner for company email. Still open.
- Mail: mailbox limits and retention. Still open.
- Mail: access rules for reading other people's mail. Still open.
- Mail: whether it is sequenced late in Phase 1. Still open.
- Mail: DPDP duties. Unverified, needs counsel.

### Round 22 clarification (recorded 2026-10-12)

Owner clarification of item f. "Fork" in the round 22 answer does NOT mean a literal GitHub fork of Stalwart Mail Server, and does NOT mean running a modified Stalwart. It means: copy code from Stalwart's repository and/or other open-source or public solutions wherever relevant into Zen 360's own mail component.

This supersedes, for the mail component only:

- the round 22 wording "fork Stalwart Mail Server and adapt it" (item f above, ORDERED-PLAN.md and ROADMAP.md 1E);
- the "read and learn only, never copy" open-source rule (D-04 round 5, DECISIONS.md:214; ORDERED-PLAN.md "Open-source use").

The rule stays in force for every other part of the app.

Consequences, stated plainly. These are not decisions; the owner has accepted them and defers the detail to their team.

i. **Licence effect of copying.** Copying AGPL-3.0 code (Stalwart, SnappyMail, SuiteCRM, EspoCRM), GPL-3.0 code (Mailcow, Maddy, Roundcube) or EUPL code into our code makes that part a derivative work. It must then be offered under the same licence to the users of the product, and it may reach the rest of the application it is combined with. MIT-licensed code (Mox, Haraka, Postal) needs only its copyright and licence notice kept. The licences above are as listed in the owner's brief; they are not checked against the upstream LICENSE files.
ii. **Language.** Stalwart is Rust and Zen 360 is TypeScript. Most of what would be taken is a port or a rewrite, not a copy. Whether a close port counts as a derivative work is a legal question for counsel. It is not answered here.
iii. **Owner position.** The owner accepts the consequences in (i) and (ii) and defers the decision on them to the owner's team, including on commercialisation.
iv. **Mitigation to adopt.** Keep a provenance log at `docs/plan/zen360/MAIL-PROVENANCE.md` with one row for each copied or ported file: our file, upstream project, upstream path and commit, licence, date copied, and who approved it. This lets the team later rewrite the code or change its licence. Copied code keeps the upstream licence header and notices.
v. **Limit on proprietary products.** Paid or proprietary products are not copied and not reverse-engineered. Only their public feature lists are used.
vi. **Still applies to copied code.** Copied code must follow CLAUDE.md: tenant scope (rule 6), audit and governed entities (rule 5), no mocks in the API test suite, and money and dates per rules 1 and 3. Hosting and DNS conflicts (round 18b, 19b and round 22) remain open.

Still open, unchanged by this clarification: email hosting against the "hosting after Phase 1" deferral; the domain and DNS owner; mailbox limits and retention; access rules for reading other people's mail; DPDP duties (needs counsel).

### Round 22 second clarification (recorded 2026-10-12)

Owner statement: the app is for personal use for now. Licence and legal concerns about copying open-source mail code are out of scope. The owner's team handles them later.

This supersedes, for the mail component only, the licence consequences listed in the first clarification above:

- item i (licence effect of copying: copyleft, derivative work, licence reach into the rest of the app);
- item ii (whether a close port is a derivative work, for counsel);
- item iii (owner position on the licence consequences);
- item iv, in part (copied code keeps the upstream licence header and notices);
- the Stalwart licence caveats in item f: AGPL-3.0 and Enterprise Licence v2 terms.

This removes the licence caveats only. Nothing else changes. CLAUDE.md still applies in full, including rule 6 (tenant scope), rule 5 (audit and governed entities), DPDP and personal-data handling (no personal data to an inference API without `applyFieldVisibility`, and India residency where a tenant requires it), and human approval before any agent emails a customer. This clarification did not change those rules.

`MAIL-PROVENANCE.md` stays as a plain engineering record of what was copied from where. It is not a legal control.

Still open, unchanged: mail hosting against the "hosting after Phase 1" deferral; the domain and DNS owner; mailbox limits and retention; access rules for reading other people's mail; DPDP duties (needs counsel). The mail item stays OPEN and not estimated.

### Round 22 second clarification, appended clarification (recorded 2026-10-12, round 23 item c)

"Personal use" in the statement above means licences only. It does not mean one person. The app is for internal company use, and the company runs as one tenant for now (round 18b). Internal company use and the multi-tenant design (rounds 1, 4 and 21) stand unchanged. The licence removal above applies to internal company use only, and this clarification does not extend it beyond that.

## Owner answers, round 23 (recorded 2026-10-12): audit rulings

Append-only. These are the owner's answers to a read-only audit of the plan and the decision register against the code, run on 2026-10-12. The audit reports are not in the repository. The register in item e cites them by ID only. Where this section supersedes an earlier round, it says so. No code, schema, CI or CLAUDE.md file changed with these rulings.

### a) C-019 and C-020: the plan follows the code

Owner ruling: the plan follows the code. Built items are marked done in the plan. The Phase 0 session continues in its current order.

- Done in the plan, each re-checked on 2026-10-12 with one grep or ls: 0.7 (`ls scripts/genmap.mjs docs/plan/MAP.md`); 0.2 (`grep -n "jti" apps/api/prisma/schema/main.prisma`); helmet, CORS, rate limit and pino (`grep -n '"helmet"\|"cors"\|"express-rate-limit"\|"pino"' apps/api/package.json`); 0.5 scheduler (`ls apps/api/src/jobs/schedule.ts`); time helpers (`ls packages/shared/src/time.ts`); 0.8 ESLint and Prettier (`grep -n "format:check" .github/workflows/ci.yml`); 0.8 migration baseline (`grep -n "db:drift" .github/workflows/ci.yml`); 0.1 config (`grep -n "envSchema" apps/api/src/platform/config.ts`); FX-01, FX-03, FX-04, FX-05, FX-21, FX-70, FX-71, FX-72 and the task-complete fix (`grep -n "assertCan" apps/api/src/platform/approvals.ts`, and the other cites in ORDERED-PLAN.md); 1.3 posting (`grep -n "export async function post" apps/api/src/platform/ledger.ts`); 1.1 ledger models (`grep -n "model JournalLine" apps/api/prisma/schema/compliance-books.prisma`); Wave 6 spine and access tables (`ls` on the migrations listed in ORDERED-PLAN.md Wave 6).
- Left open, with the reason: 0.1 FX-60 refusal scope (C-003); 0.8 dead classes (not confirmed) and `db push` in `apps/api/docker-entrypoint.sh:30`; 0.3 and 0.4 error-leak fix and G11 redaction test (not located); 0.5 croner licence check (not done); 0.6 SERIALIZABLE wording (code uses ReadCommitted, see ORDERED-PLAN.md 0.6); 1.1 and 1.2 sub-checks (bigint, two-line minimum, `set_config`, not checked); 1.4 L1 to L3 scope (the file's L1 differs from CI-GATES L1); 1.5 cashbook (`model Transaction` still present); 1.6 `round2` (still at `packages/shared/src/finance.ts:150`); FX-02 (transition path not confirmed); FX-22, FX-24, FX-50, FX-61, FX-80 (no check, or commit evidence only); FX-06, FX-07, FX-62 to FX-65; FX-73 (no liability posting); onboarding per-state packs; level mapping; account recovery holder.
- CURRENT.md: the "pending CI on the PR" line is removed (the branch is an ancestor of `origin/main`). The "Prettier reformat deferred" line is removed (`.github/workflows/ci.yml:47` runs `pnpm format:check`).
- CI-GATES-DRAFT.md wave labels: NOT changed. The mapping from "Wave A / B / C" to ORDERED-PLAN wave numbers is ambiguous. Wave B is "Phase 0 new or replace items" and spans ORDERED waves 1 to 5 (for example G10 is "from B, with 3.1" while 3.1 sits in Wave 1 and 0.6 sits in Wave 2, and G12 is "n/a until Phase 4" while ORDERED Wave 5 names the gate). Still open; the owner or the Phase 0 session sets the mapping.

### b) C-006 and C-005: the founder is exempt

Owner ruling: round 10 stands. The founder may self-approve, and the blocked pairs in round 14 do not bind the founder.

This SUPERSEDES, for the founder specifically, the round 14 "founder override with logged reason" (round 14 item 3, DECISIONS.md:462). The founder needs neither an override nor a logged reason for a blocked pair. The other person in a blocked pair remains bound by it. Round 14 item 2, "only the founder may approve their own access", is consistent with this ruling and stands.

Plainly: this is a segregation-of-duties risk. The plan already names it at `docs/plan/zen360/ORDERED-PLAN.md:268` ("The founder's exemption from maker-checker is a segregation-of-duties risk for founder-only classes (payroll run, large payments, statutory filings)") and at `docs/plan/zen360/ROADMAP.md:192`. The owner has accepted the risk by this ruling.

Places where code or plan assume something other than the ruling. These are OPEN follow-ups for the Phase 0 session. No code was changed.

1. `apps/api/src/platform/approvals.ts:367`: "The Self-Dealing Bar is unconditional: a requester may never approve their own step." `decideApprovalStep` (`approvals.ts:330`) has no founder exemption. Also the comment at `approvals.ts:168` ("unconditional, with no override path"). This is the approvals engine, and it conflicts with the ruling.
2. `apps/api/src/domains/access/assignments.ts:16`, `:60` and `:213`: the founder override with a reason, and the founder sole-confirmer rule. This is the access path, separate from (1). Its wording follows round 14, so it should be checked against this ruling.
3. `apps/api/src/tests/accessSod.test.ts:2` and `:7`: the tests pin the founder's recorded override. They need to match this ruling.
4. `docs/plan/zen360/ORDERED-PLAN.md:149` ("The founder is exempt") and `docs/plan/zen360/ROADMAP.md:46`: these match the ruling. The 1A test "maker equals checker is refused" must exempt the founder level, which the approvals code in (1) would fail.
5. `docs/plan/zen360/QUESTIONNAIRE-DRAFT.md:84` and `:91`: "founder exempt", consistent with the ruling. `:106`: the blocked-pair table; check it against the founder exemption.
6. Payments. Round 14 item 2 blocks "create and approve payments" for one person. With the exemption, a founder can create and approve a payment alone. The payment approval gate (item below) says "a payment needs a second person's approval". For founder-created payments those two statements conflict. OPEN: the owner must say whether this is intended.

Payment approval step (C-005), recorded as the owner's decision dated 2026-10-12. The plan says, at `docs/plan/zen360/ORDERED-PLAN.md:127`: "Adds a `payments:approve` gate to the payment flow, so a payment needs a second person's approval before it counts. It goes after Wave 6 PR12, in the finance path, with its own ledger tests including the trial-balance assertion. Owner-approved, 2026-10-12." Status: NOT BUILT. `payments:approve` appears only in `apps/api/src/tests/accessSod.test.ts`. Open: point 6 above.

### c) C-012: "personal use" means licences only

Owner ruling: in round 22b, "personal use" means licences only. Internal company use and the tenant model stand. The wording is fixed by the appended clarification at the end of the round 22 second clarification (above), which precedes this section.

`docs/plan/zen360/README.md:64` said "Do not build it in-house" without saying what the mail exception covers. That line is updated on this branch to point to round 21, the round 22 clarifications, and round 23. No README line calls the app "personal use". C-013 (the mail copy decision itself) remains OPEN, see item e.

### d) C-007 and C-011: the statutory approver and who enters DRAFT rows are decided at onboarding

Owner ruling: TBD at onboarding. Nothing is decided now.

- "The internal finance head", "the qualified holder" and "the accountant" are provisional wordings for the statutory sign-off holder. They are not known to be one person. Until onboarding decides it, the holder is TBD.
- Who enters DRAFT rows, and when, is TBD at onboarding.
- Rate rows stay DRAFT until a holder approves them. No row becomes APPROVED by default.
- ORDERED-PLAN.md:23 and :65, and ACCESS-MODEL-PLAN.md:287 and :285, keep their wording until onboarding closes this item. Read them as provisional.

### e) Open register: remaining conflicts C-001 to C-032

Every conflict not covered by items a) to d). Severity and order follow the audit's checklist, then ID order. Status is OPEN for all rows. Source is the read-only audit of 2026-10-12, report ID only; the report is not in the repository.

| ID    | One-line claim (quoted or summarised)                                                                                                                                                                          | Severity      | Status                     | Source        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------- | ------------- |
| C-013 | "Do not build it in-house. Exception: employee company mailboxes" (zen360 README) against round 21 mail and the round 22 copy decision. README wording updated on this branch; the copy decision is not ruled. | misleads      | OPEN - owner ruling needed | audit-1 C-013 |
| C-008 | "Each person holds one level" (round 10) against identity-first and one level per placement (round 14, round 19a(f)).                                                                                          | blocks coding | OPEN - owner ruling needed | audit-1 C-008 |
| C-009 | "The function picks a role template" (round 14, 18a(c)) against "The access model is level x vertical, not a job-role model" (round 19a(d)).                                                                   | blocks coding | OPEN - owner ruling needed | audit-1 C-009 |
| C-002 | "Expense receipts are stored on the company's own server disk and are included in the backups" (round 12) against backups deferred (round 18b).                                                                | blocks coding | OPEN - owner ruling needed | audit-1 C-002 |
| C-015 | "No employees or roles are set up through hardcode" (round 19a(b)) against the founder-created IT owner stopgap grant; recovery holder unnamed.                                                                | blocks coding | OPEN - owner ruling needed | audit-1 C-015 |
| C-003 | "Boot refuses to start without it" for `FIELD_ENCRYPTION_KEY`, in all environments (round 2), against production only (`apps/api/src/platform/config.ts:150`).                                                 | blocks coding | OPEN - owner ruling needed | audit-1 C-003 |
| C-004 | "Inbound webhooks are authenticated with a per-tenant HMAC" (round 2) and "One key per tenant" (round 5) against the round 18b single secret.                                                                  | misleads      | OPEN - owner ruling needed | audit-1 C-004 |
| C-016 | "The registry and its foreign keys land in Waves 2-3, before the ledger" (round 20, 10-10) absent from ORDERED-PLAN; a `business_line_units` migration already exists.                                         | blocks coding | OPEN - owner ruling needed | audit-1 C-016 |
| C-017 | "Money is bigint paise end to end, including in database storage" (round 1) against the `Decimal(18,2)` columns with no migration item in ORDERED-PLAN.                                                        | blocks coding | OPEN - owner ruling needed | audit-1 C-017 |
| C-014 | "Contractors see their own tasks and timesheets only" (round 12) against guest accounts deferred and "employees only" (round 16).                                                                              | blocks coding | OPEN - owner ruling needed | audit-1 C-014 |
| C-030 | LiveKit on "the Indian VPS plan" and "the own server" (rounds 5, 6) against "where the server runs is a hosting decision for after Phase 1" (round 18b); Resend "processes data outside India" (round 5).      | blocks coding | OPEN - owner ruling needed | audit-1 C-030 |
| C-031 | "No external email or WhatsApp provider" (round 4, COM-02) against company mail that sends and reads (round 21).                                                                                               | blocks coding | OPEN - owner ruling needed | audit-1 C-031 |
| C-001 | "A reverse proxy and network protection must be chosen" (round 6) against no named owner for TLS and rate-limit front after the Worker was removed (round 19b).                                                | misleads      | OPEN - owner ruling needed | audit-1 C-001 |
| C-010 | "The questionnaire is answered by the founder or the onboarding owner" (round 13) against "HR answers the stakeholder-mapping questionnaire" (round 19a(a)); QUESTIONNAIRE-DRAFT.md still says founder.        | misleads      | OPEN - owner ruling needed | audit-1 C-010 |
| C-018 | Two sections titled "round 20" and out-of-order dating of 10-10 sections.                                                                                                                                      | cosmetic      | OPEN - owner ruling needed | audit-1 C-018 |
| C-021 | G7 "expected to fail ... until FX-51 lands" (FX-51 is merged) and "twelve checks" (eleven mandatory).                                                                                                          | misleads      | OPEN - owner ruling needed | audit-1 C-021 |
| C-022 | "`post()` has no non-test caller" (zen360 README:54). Not settled by the audit; the lint rule and `balances.ts` suggest it may be out of date.                                                                 | misleads      | OPEN - owner ruling needed | audit-1 C-022 |
| C-023 | The zen360 README Z-track sequence ("Z2 runs parallel to Phase 1", week counts) superseded by ROADMAP.                                                                                                         | misleads      | OPEN - owner ruling needed | audit-1 C-023 |
| C-024 | "Before the first outside user" (round 7) against an unqualified BLOCKED-BY in ORDERED Feature 1 Wave 3.                                                                                                       | misleads      | OPEN - owner ruling needed | audit-1 C-024 |
| C-025 | `deploy/Caddyfile` states a hosting decision and a DPDP cross-border reason as fact, while hosting is "undecided until after Phase 1".                                                                         | misleads      | OPEN - owner ruling needed | audit-1 C-025 |
| C-026 | Round 11 "own-server operations ... are in Phase 0" against round 18b moving them, without naming round 11.                                                                                                    | cosmetic      | OPEN - owner ruling needed | audit-1 C-026 |
| C-027 | "Until it is confirmed, the hire holds the Staff default duties" (round 18a(d)) against "fail closed" if undefined (ACCESS-MODEL-PLAN).                                                                        | misleads      | OPEN - owner ruling needed | audit-1 C-027 |
| C-028 | "No founder default routing" (round 1, D-09) against founder-only approval classes (round 7).                                                                                                                  | cosmetic      | OPEN - owner ruling needed | audit-1 C-028 |
| C-029 | "No external users at launch" (round 2) against guest accounts (round 15), deferred (round 16).                                                                                                                | cosmetic      | OPEN - owner ruling needed | audit-1 C-029 |
| C-032 | "GSP, per README" (D-06 row) against "direct to the government e-invoice portal (IRP), not a GSP" (rounds 2, 11).                                                                                              | cosmetic      | OPEN - owner ruling needed | audit-1 C-032 |

**Status note, round 24 (recorded 2026-10-12).** C-001, C-002, C-003, C-004, C-008, C-013, C-014, C-015, C-016, C-017, C-030 and C-031 are RULED in round 24 (see the round 24 section below). The rows above are unchanged. The other rows remain OPEN.

**Status note, round 25 (recorded 2026-10-12).** C-009, C-010, C-024, C-025, C-026, C-027, C-028, C-029 and C-032 are RULED in round 25 (see the round 25 section below). The rows above are unchanged. C-018, C-021, C-022 and C-023 are cleanup items with no owner ruling needed (round 25 section, below). The other rows remain OPEN.

Items a) to d) cover C-019, C-020, C-005, C-006, C-007, C-011 and C-012. Those rows are closed by the rulings above, except where the item says otherwise.

### f) Audit findings, not yet ruled (code side)

Each was re-checked on 2026-10-12 with `grep -n`, or is marked UNVERIFIED. These were not in the audit reports read for this round; they were found with grep, so they carry no audit ID.

1. **Money in Decimal columns outside the ledger.** `apps/api/prisma/schema` has 253 `Decimal(` column declarations (grep count). Examples: `apps/api/prisma/schema/main.prisma:3250` (`gstRate Decimal`), `:5315` (`tdsRate Decimal?`). Which of them hold money is UNVERIFIED. Relates to C-017 and CLAUDE.md rule 1.
2. **Statutory rates in separate rate tables, not `StatutoryRule`.** `apps/api/prisma/schema/compliance-payroll.prisma:13` `model PfRateTable`, with `employeeRate Decimal` at `:20`. Re-checked: the table exists. Whether its rows are statutory values under CLAUDE.md rule 4 is UNVERIFIED. The `tdsRate` column at `main.prisma:5315` is the same question.
3. **Platform `StatutoryRule` rows invisible to tenant RLS.** `apps/api/prisma/schema/compliance-statutory.prisma:17` `tenantId String?`. The policy at `apps/api/prisma/migrations/20261010235900_tenant_rls/migration.sql:72-74` is `USING ("tenantId" = current_setting('app.tenant_id', true))`, so a row with a NULL `tenantId` cannot match a tenant session. Whether platform rows are stored with NULL is UNVERIFIED (not read in the seeds).
4. **Agent unknown-tool fallback: checked, not present.** `apps/api/src/agents/index.ts:93-99` now returns `blocked(... 'AUTONOMOUS_WITHIN_POLICY' ...)` for an undeclared tool. Audit-6 agrees (P-022). Not carried as open.
5. **Seed wipe truncation.** `apps/api/src/seed/wipe.ts:59`: `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` through `unscopedPrisma.$executeRawUnsafe`. Whether a production guard exists was not read: UNVERIFIED.
6. **`db push` in the container entrypoint.** `apps/api/docker-entrypoint.sh:30`: `./node_modules/.bin/prisma db push --skip-generate`. CONFIRMED by grep. This conflicts with CLAUDE.md ("never `db push`") and ORDERED 0.8. (The file is under `apps/api/`, not the repository root.)
7. **CLAUDE.md stale lines.** See item g.

### g) CLAUDE.md stale lines: owner decision item

CLAUDE.md is not changed on this branch. Owner decision: correct it, or confirm the lines below are to stay. Each line was re-checked on 2026-10-12.

- Rule 1: "The money helper is not yet written ... `packages/shared/src/money.ts` ... must be created". The file exists (`packages/shared/src/money.ts`), and `allocate` is at `:97`. "`num()` at `apps/api/src/platform/db.ts:150`" is now `db.ts:302`.
- Rule 2: "The lint rule is planned and not yet in `eslint.config.js`". It is present at `eslint.config.js:97-119`.
- Rule 5: "`auditWrite` silently no-ops on an unregistered `subjectType` (`isGoverned`, `:134`)". It throws (`apps/api/src/platform/audit.ts:416-421`). `isGoverned` is at `:55`, `registerGovernedEntities` at `:43`, and `AUDIT_ACTIONS` at `:20` (not `:17`).
- Rule 7: "`Metric` ... does not enforce it". The `MetricProps` discriminated union is at `apps/web/src/components/ui.tsx:145-146`, and the function at `:153`. CLAUDE.md cites `:136` and `:132-135`.
- "Never": "`imports/commit.ts:721` does [hard-delete]". `:721` is inside `DIVISION_NAMES`. There is no hard delete in `apps/api/src/imports/commit.ts`; the revert is by reversal at `:1181-1190`.
- Not in CLAUDE.md but stale in CURRENT.md: `post()` at `platform/ledger.ts:61` is now `:351`.

### Owner answers, round 23: what was not done

- No CLAUDE.md, code, schema or CI change. `docs/plan/MAP.md` is not regenerated (it is generated only for exports and schema changes; the branch changes docs only).
- Not ruled, and not decided here: the founder payment question (b, point 6); the copy decision for mail (C-013); onboarding decisions (d); every item in the open register (e).

## Owner answers, round 24 (recorded 2026-10-12): audit rulings, second batch

Append-only. These are the owner's answers to the second batch of the read-only audit of 2026-10-12 (the round 23 item e register). The audit report is not in the repository and is cited by ID only. Where this section supersedes an earlier round, it says so. No CLAUDE.md, code, schema or CI file changed with these rulings. The register rows are ruled in the status note under the round 23 register.

### a) C-008: level model

Owner ruling: rounds 14 and 19a stand. Identity type is decided first. Level is stored as an attribute. A person holds one level per placement, and may hold placements in more than one vertical or unit (round 19a(f)). Round 10's "one level per person" and "levels by stakeholder type" are retired.

Edited on this branch: `ORDERED-PLAN.md` (access model section) and `ROADMAP.md` (section 3, access-level assignment).

### b) C-003: FIELD_ENCRYPTION_KEY boot refusal applies in every environment

Owner ruling: the boot refusal for `FIELD_ENCRYPTION_KEY` applies in every environment, as round 2 says. Dev uses a dummy key from `.env.example`. CI supplies one.

Edited on this branch: `CI-GATES-DRAFT.md` G5, `ORDERED-PLAN.md` 0.1 and `CURRENT.md`.

OPEN follow-up for the Phase 0 session. No code was changed here.

1. `apps/api/src/platform/config.ts:150` refuses only when `NODE_ENV === 'production'`.
2. `.github/workflows/ci.yml:78` and `:149` set `JWT_SECRET` only. No `FIELD_ENCRYPTION_KEY` is set in CI.
3. `apps/api/.env.example:17` has `# FIELD_ENCRYPTION_KEY=` commented out. There is no dummy key to copy yet. The dummy value is added with the config change.

### c) C-015: recovery holder until onboarding names an IT admin

Owner ruling: until onboarding names an IT admin, the recovery holder is the founder. The founder may also create a stopgap IT owner grant, tagged `to_migrate`. The stopgap is allowed. It is replaced at onboarding.

Tension, stated plainly. Round 19a(b) (line 572 above) says no employees or roles are set up outside onboarding: "No employees or roles are set up through hardcode; they are set up only during onboarding." The audit cited this as "19b(b)". Round 19b has no item (b). The reference is to 19a(b). The owner has chosen to allow the stopgap anyway, as an exception to 19a(b) until onboarding. Round 22 item e (account recovery through the founder or the IT admin) and `ACCESS-MODEL-PLAN.md` "Wave 4 IT-owner conflict" are the sources the stopgap rests on.

### d) C-016: BusinessLine registry and cost-centre foreign key are built

Owner ruling: the BusinessLine registry, with `lineId` and `costCentreId` on `JournalLine`, is already built. The owner asked only for a plan update: `ORDERED-PLAN.md` item 1.1 and Wave 6 record it as done, and it is removed from the open lists.

Checked on 2026-10-12 with grep and ls before marking:

- `apps/api/prisma/schema/business-lines.prisma:11` `model BusinessLine`.
- `apps/api/prisma/schema/compliance-books.prisma:134` `model JournalLine`. `:152-153` `costCentreId` with a composite foreign key to `CostCentre(tenantId, id)`. `:160-161` `lineId` with a composite foreign key to `BusinessLine(tenantId, id)`.
- Migrations `20261010235800_business_lines`, `20261013110000_business_line_units` and `20261013205000_journal_line_cost_centre_fk` exist under `apps/api/prisma/migrations/`.

Edited on this branch: `ORDERED-PLAN.md` 1.1 and Wave 6, and the round 20 row of `ACCESS-MODEL-PLAN.md`.

### e) C-017: money columns outside the ledger move to bigint paise before Phase 0 closes

Owner ruling: the roughly 250 `Decimal(18,2)` money columns outside the ledger are migrated to bigint paise before Phase 0 closes. Items 1.5 (cashbook, `model Transaction` at `apps/api/prisma/schema/main.prisma:5205`) and 1.6 (`round2` at `packages/shared/src/finance.ts:150`) stay in Phase 0. The owner's wording is "ledger first", with trial-balance assertions. The owner says Phase 0 is almost done and wants this finished before it closes. Recorded in `ORDERED-PLAN.md` 1.6 and `CURRENT.md` as the remaining Phase 0 money work.

Tension, not resolved here. `ORDERED-PLAN.md` principle 1 says "money before ledger" (`money.ts` lands before the ledger schema). The owner's "ledger first" points the other way. OPEN: the owner states which order applies. The round 23 item f count (253 `Decimal(` declarations) is not all money. Which columns hold money is UNVERIFIED.

### f) C-014: contractor timesheets and tasks are employee-only. DEFAULT, not an owner decision

No owner preference was given. The following is a DEFAULT applied in the plan, and it is labelled as one. Contractors' timesheets and tasks are employee-only until guest accounts are designed. Round 12 item 4 (contractors see their own tasks and timesheets only) remains the rule for when guests exist. The round 16 deferral stands. The owner may override the default.

Edited on this branch: "Guests" is removed from the Phase 1 row of `ACCESS-MODEL-PLAN.md` (the access-model Phase 1 row).

### g) C-031 and C-013 (widened): shared inboxes, and copying open-source code for any feature

g1. **Shared inboxes.** A shared inbox is one mailbox that several employees open, for example support@, with assignment and internal notes. It may receive AND send to external addresses. Round 4 COM-02 ("internal-only, no external email provider") is superseded. Customer-facing sends keep the human-approval rule (CLAUDE.md, "Never": no agent emails a customer without human approval).

g2. **Copying open-source code is approved for any feature.** Copying code from open-source projects is an approved way to build ANY feature, from any project, not only mail. Licences are set aside for now (round 22 second clarification). This supersedes the "read and learn only, never copy" rule (round 5, D-04; `ORDERED-PLAN.md` principle 9 and "Open-source use") for every part of the app. Copied code still follows CLAUDE.md (round 22 item vi).

g3. **Provenance.** `docs/plan/zen360/MAIL-PROVENANCE.md` is kept under the same name. It now covers any copied code, not only mail.

g4. **Limit.** This is for open-source code only. Reverse engineering, or copying proprietary or paid software, is not part of the plan. For those products only public documentation and feature lists are used.

Edited on this branch: `ORDERED-PLAN.md` principle 9, "Open-source use" and 1E COM-02; `zen360/README.md:64`; `MAIL-PROVENANCE.md` header; `ROADMAP.md` 1E and the shared-inbox row.

### h) C-001 and C-030: local only until hosting is decided

Owner ruling: until hosting is decided after Phase 1, the app runs LOCAL ONLY. There is no non-local deployment and no outside user. Residency for LiveKit media and for Resend is decided together with the hosting choice, not before.

Implication, not an owner statement: while no non-local deployment exists, C-001 (an interim owner for TLS, DDoS and rate-limit) does not arise. The Caddyfile and the DPDP line (C-025) are not changed by this ruling.

### i) C-002: receipt storage and backups are decided with hosting

Owner ruling: the receipt storage location and backups are decided with hosting, after Phase 1. Nothing in Phase 1F waits on them.

Edited on this branch: the 1F "BLOCKED-BY the receipt storage location" line in `ORDERED-PLAN.md`.

### j) C-004: single webhook secret and one encryption key, confirmed deferral

Owner ruling: one webhook secret and one encryption key now, because the company is one tenant. Per-tenant versions come with multi-tenant work. This confirms the deferral. It supersedes round 2 (per-tenant HMAC, D-13) and round 5 item 6 (one key per tenant) for the present.

### Owner answers, round 24: what was not done

- No CLAUDE.md, code, schema, CI or `.env.example` change. The OPEN items in b and e are for the Phase 0 session.
- Not ruled, and not decided here: the order of items 1.5 and 1.6 (e, tension); whether the founder's payment step (round 23 item b, point 6) changes (not in this batch); the statutory approver and the DRAFT-row holder (round 23 item d) remain TBD at onboarding.
- `docs/plan/MAP.md` is not regenerated. The branch changes documents only.

### Round 24 follow-up (recorded 2026-10-12): money migration order

Owner ruling: the money helper and the money columns come first. `ORDERED-PLAN.md` principle 1, "money before ledger", stands. This resolves the open tension recorded in round 24 item e, where the owner's wording was "ledger first". The ledger-first wording is not the order. Money work (`money.ts`, then the `Decimal(18,2)` money columns to bigint paise, then `round2` removal at `finance.ts:150`) lands before the ledger schema work that depends on it.

Still open, unchanged by this ruling: which columns hold money (the round 23 item f count of 253 `Decimal(` declarations is not all money, and is UNVERIFIED).

## Owner answers, round 25 (recorded 2026-10-12): audit rulings, third batch

Append-only. These are the owner's answers to the third batch of the round 23 item e register (C-009, C-010, C-018, C-021 to C-029, C-032). Source: the read-only audit of 2026-10-12, cited by ID only. The audit report is not in the repository.

a. **C-010, who answers onboarding (owner ruling).** HR and the founder (or the onboarding owner) may both answer the onboarding mapping questions. The vertical Head confirms placements. Confirmation rules are unchanged: the person being mapped cannot confirm their own level. Wording fixed in `ACCESS-MODEL-PLAN.md` (section 1 row 4, and the confirmer flag) and `QUESTIONNAIRE-DRAFT.md` (lines 13, 16 and 33).

b. **C-009, starter template (owner ruling).** One editable starter template ships, unassigned. There is no job-role catalogue, no role-to-grant matrix and no seeded roles. Not edited in this round, and still to fix: "the function picks a role template" at `QUESTIONNAIRE-DRAFT.md:14`, `:29` and `:168`, and "function and vertical role templates" at `ROADMAP.md:150`. These contradict this ruling and need a separate edit.

c. **C-027, Staff defaults (owner ruling).** Staff defaults apply to a new hire. A level above Staff that the tenant has not defined fails closed. `ACCESS-MODEL-PLAN.md` section 6 and the open-question row 5 now say this. The "fail closed if undefined" wording for the baseline row itself is unchanged, and is still OPEN 5.

d. **C-028, founder routing (owner ruling).** Founder-only approval classes (payroll run, large payments, statutory filings) stand. Everything else routes by assignment, not to the founder by default. No wording edit in this round.

e. **C-029, external users (owner ruling).** No external users in Phase 0 or Phase 1. Contractors and freelancers, external auditors and accountants, and board and investors have no accounts. Guest accounts are designed later. The identity-type list in `ORDERED-PLAN.md` (Access model) now says this. `ROADMAP.md` already defers guest accounts (round 16).

f. **C-032, e-invoicing route (owner ruling).** E-invoicing goes directly to the government invoice portal (IRP). The GSP route is dropped. The D-06 row above (line 14) is edited to match. This is the one edit to an existing row in this file; it is made because the owner asked for it. No statutory value is added. Whether and when e-invoicing applies is still for the accountant and the tax adviser (D-02). GSP wording not edited in this round: `CAPABILITIES.md:343` (CAP-FIN-24, "through a GSP"), `zen360/evidence/07-crm-finance-recon.md:253` (D5, "accountant or GSP provider"), `zen360/evidence/11-architecture-security-ai.md:158` and `zen360/evidence/12-rollout-acceptance-decisions.md:240`, and `docs/plan/README.md` decision B (cited at line 384 above).

g. **C-024, legal checks (owner ruling: "bypass all legal checks").** The chat-retention counsel check (D-14) and the Resend data-hosting check no longer block any build or the first outside user. Legal checks are set aside as gates for now. This extends round 22b beyond licences. The consequences below are stated as consequences, not as new decisions:

i. CLAUDE.md engineering rules were not changed by this ruling and still bind the code: DPDP personal-data handling, tenant scope, audit, human approval before agents email customers, and "statutory uncertainty: stop and flag" in payroll.

ii. A payroll or tax value that is wrong still produces wrong payslips, regardless of legal checks.

Wording replaced in this round: the Wave 3 build block on the chat-retention check (`ORDERED-PLAN.md`, Feature 1, Wave 3), the COM-15 Resend block (`ORDERED-PLAN.md`, 1E), and the "before the first outside user" gating lines in `ORDERED-PLAN.md` (the round 10 open list) and `ROADMAP.md` (the Phase 0 open list). Each now points to this ruling. Dated "still open" history lines are kept.

Not changed, and open for the owner: `ORDERED-PLAN.md:165` ("BLOCKED-BY the CAP-HRM-32 legal check") and `zen360/README.md:94` ("D-14 ... need legal owners before any capture work"). Both are legal checks the owner did not name. The owner should say whether they are set aside too.

h. **C-025 and C-026, hosting (owner ruling).** Round 18b stands and supersedes round 11's own-server operations in Phase 0. Hosting is deferred until after Phase 1. The owner chose to remove the hosting-specific deploy files. That removal is on branch `chore/remove-deploy-files` (from `origin/main`). It is not merged in this round. The DPDP cross-border line in `deploy/Caddyfile` (C-025) was not sourced and goes with that file. Per round 18b, `docker-entrypoint.sh` and the Dockerfile are not touched by that branch.

### Still unruled after round 25: cleanup, no owner ruling needed

These are recorded so they are not lost. None is a decision.

- **C-018, round numbering and dating.** Two sections titled "round 20", and sections dated 10-10 placed after 10-11 rounds. Cosmetic. Not changed.
- **C-021, G7 text in `CI-GATES-DRAFT.md:96`.** "Expected to fail ... until FX-51 lands": FX-51 is merged (`ROADMAP.md:28`; migration `20261010235900_tenant_rls` exists). The fix is not unambiguous. The sentence's "expected to fail" for tables other than the four ledger tables depends on the catalogue coverage, which is UNVERIFIED in that same paragraph. The "twelve checks" line (`CI-GATES-DRAFT.md:298`) matches its own list of G1 to G12, so it is not changed. Not changed in this round. Proposal: rewrite once the loop's table list has been read.
- **C-022, `post()` callers.** "`post()` has no non-test caller" (`zen360/README.md:54`). Only a code check settles this, and none was run in this round. Not changed.
- **C-023, zen360 README Z-track sequence.** `zen360/README.md:73` (Z0 "1-2 wks"), `:75` ("runs parallel to Phase 1 for non-money parts") and `:76` (Z3 "Phases 2-3"). `ROADMAP.md:172` already says non-money parts of Z2 run alongside Phase 1. `ROADMAP.md` states no Z0 duration. Only the README's week counts and the 24-hour test under Z2 are stale, and their replacement cannot be read from the text. Not changed. Proposal: the owner gives the Z0 and Z2 durations, or the README sequence points to ROADMAP.md.

### Owner answers, round 25: what was not done

- No CLAUDE.md, code, schema, CI or `.env.example` change. No `deploy/` change on this branch (see h).
- `docs/plan/MAP.md` is not regenerated. The branch changes documents only.
- Not ruled, and not decided here: the CAP-HRM-32 and D-14 legal checks in the README (g, above); the GSP wording in the capability and evidence files (f); the role-template wording (b).

### Round 25 follow-up (recorded 2026-10-12): legal checks are warnings

Owner ruling: all legal checks are warning only. They are bypassed as gates and never block a build, a merge or an outside user. This extends item g above, which covered the chat-retention and Resend checks, to every legal check. Where the plan listed a legal check as a gate or blocker, the wording now reads "warning only (round 25)": `ORDERED-PLAN.md:165` (CAP-HRM-32) and `zen360/README.md:94` (D-13 and D-14).

CLAUDE.md engineering rules are unchanged by this ruling. Personal-data handling, tenant scope, audit, human approval before agents act, and "statutory uncertainty: stop and flag" still bind the code.

Wording fixes made in this follow-up, with no change to the rulings they cite (see b and f above): the function-picks-a-template wording in `QUESTIONNAIRE-DRAFT.md` (lines 14, 29, 168) and `ROADMAP.md` (line 150), now one editable starter template with no job-role catalogue (C-009); and the GSP wording in `zen360/CAPABILITIES.md` (CAP-FIN-24) and `zen360/evidence/07`, `11` and `12`, now direct to the IRP (C-032).

Not changed: the dated history sections of this file. The Phase 1 prerequisite note at line 139 ("legal review before Phase B") sits in the 2026-10-10 phase-definition section and is a record of that date. Read it as superseded by this ruling.

## Owner answers, round 26 (recorded 2026-10-13): consolidated PR and follow-ups

Append-only. One consolidated PR (branch `docs/rounds-23-26-consolidated`, from `origin/main`) replaces the three open PRs `docs/claude-md-stale-facts`, `docs/round-25-rulings` and `chore/remove-deploy-files`. Those three PRs are closed with a comment pointing to it. Their branches are kept.

a. **Five code follow-ups, for the Phase 0 session.** These are recorded as owner decisions to build. None is built in this PR, which changes documents only.

i. `FIELD_ENCRYPTION_KEY` refuses to boot in every environment, and the `.env.example` key line is added (round 24 item b).

ii. Founder exemption. Reconcile it with the Self-Dealing Bar at `apps/api/src/platform/approvals.ts:367` ("a requester may never approve their own step") and with the access separation-of-duties code (round 23 item b).

iii. Remove `prisma db push` from `apps/api/docker-entrypoint.sh:30` (CLAUDE.md: never `db push`).

iv. Finish the Decimal to bigint money migration (round 24 item e and the round 24 follow-up).

v. Reconcile the statutory rate tables with `StatutoryRule`, including platform rules (NULL tenant) and their RLS visibility (CLAUDE.md rule 4).

b. **Forms library: react-hook-form.**

c. **Test email: a built-in fake adapter behind the mail interface.** Tests send through the fake, not a real provider.

d. **Commit trailers: Claude Haiku 5.5 going forward.** `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.

e. **Resend: employee and system transactional mail only, kept long-term.**

f. **Mail: the founder owns the domain and DNS. Nobody reads other people's mail. Retention is decided with hosting.**

g. **Statutory approver: "decide at onboarding" stands** (round 23 item d).

h. **`QUESTIONNAIRE-DRAFT.md` is approved as drafted.**

i. **Wave 7 is in progress locally and is not pushed.** It is tagged in progress in `ORDERED-PLAN.md` (Wave 7) and in `docs/plan/CURRENT.md`. This is the owner's statement. The code was not checked for it in this round.

j. **One consolidated PR replaces #53, #56 and #57.**

### Round 26 cleanup (docs only, no owner ruling needed)

- **C-018, round numbering.** The 10-10 vertical-taxonomy section (line 579) is now "round 20v". Where `ACCESS-MODEL-PLAN.md` rows 0 and 1 and the table at its line 336 cite "round 20" for the taxonomy, they now read "round 20v". Other "round 20" citations in that file, and in this file, mean 20v when they concern the vertical taxonomy. The 10-11 section keeps "round 20". Sections are in recording order, so the 10-10 section stays where it is.
- **C-021, G7 text.** `CI-GATES-DRAFT.md` no longer says "until FX-51 lands": FX-51 is merged. The twelve-checks sentence now says eleven are mandatory after G7's deferral (round 18b, item 1).
- **C-022, `post()` callers: closed by a code check.** No non-test module imports `post`, `postInTx` or `reverse` from `platform/ledger.ts`. The only call to `post()` is inside `reverse()` (`ledger.ts:419`), and `reverse()` has no caller. The audit's pointers to `platform/balances.ts` and `domains/compliance/books.ts` are false positives: `balances.ts` mentions `post()` in a comment, and `books.ts` imports `POSTABLE_PERIOD_STATUSES`. `zen360/README.md` now says so and gives `post()` at `ledger.ts:351`.
- **C-023, zen360 README Z-track.** The Z0 week count is removed (round 4: no week labels). The 24-hour founder-absence test is a Phase 1A test, not a Z2 gate (round 21b, item 2). The Z2 "runs parallel to Phase 1 for non-money parts" wording agrees with `ROADMAP.md:172` and is unchanged.
- **Leftover wording.** The "legal review before Phase B" and "counsel confirmation" notes in the Feature 1 list (line 139) are marked warning only (round 25). The conflict 3 implication note in the round 11 answers (line 384) is updated, as recorded there.
- **Dangling Caddyfile references.** `deploy/Caddyfile` was removed with the hosting-specific deploy files. The "Deploying" section of `README.md`, `docs/operations.md` (the `WEB_DIST_DIR` row, the `PORTAL_HOSTS` paragraph and the `JWT` cookie note) now say hosting is undecided and that no reverse proxy is chosen. The DPDP cross-border paragraph that justified a hosted edge is removed, as it was unsourced (C-025). `docs/plan/CURRENT.md` no longer names the Caddyfile.
- **Left as follow-ups, in code and tests.** `apps/api/src/platform/config.ts:112`, `apps/api/src/server.ts:52-74`, `apps/api/src/tests/staticServing.test.ts:3`, `apps/api/src/tests/publicCaptureRateLimit.test.ts`, `apps/api/src/tests/httpHardening.test.ts:67`, `apps/api/src/lib/refreshCookie.ts:10` and `apps/api/src/routes/marketing/public.routes.ts:22` still say Caddy in comments. Changing them is a code change, not part of this PR.
- **CLAUDE.md rule 8.** The example cite is now `domains/invoicing.ts:244` ("this used to be four"), which names a past mistake and its consequence. The old `:505` cite was a comment about tax readings, not a mistake.

### Round 26: what was not done

- No code, schema, test, CI or `.env.example` change. The five follow-ups in item a are for the Phase 0 session.
- `docs/plan/MAP.md` is not regenerated. No export or schema moved.
- Not decided here: the `docs/plan/archive/` GSP text (kept as history).

## Owner answers, round 27 (recorded 2026-10-13): statutory rule data, L2 fixtures and G10

Append-only. Sources: audit 7 (statutory pack 3.1 and rate data) and audit 8 (L2 fixtures and G10), both read against `origin/main` on 2026-10-12. Code cites were re-checked on `origin/main` for this round. Two audit cites were stale and are corrected in item d.

### a) Statutory pack 3.1 and the PF, ESI, PT and TDS rule data stay DRAFT

Owner ruling: the statutory pack (ORDERED-PLAN 3.1) and the PF, ESI, PT and TDS rule data stay DRAFT. The owner treats them as founder signed off as draft.

- This is a status, not an approval. Nothing is presented as law. No row becomes APPROVED by this ruling.
- The repo held no written founder sign-off before this round. This ruling records the owner's statement. It adds no approval.
- The approver role is decided during onboarding and is never hard-coded. Round 23 item d stands.
- The code does not yet enforce DRAFT. See item d(i).

### b) L2 fixtures (CI-GATES-DRAFT open question 9)

- Phase 0 builds the harness and `cashbookToJournal` now (archive/phase-1-ledger.md 1.5). Phase 0 must not claim that L2 passed on synthetic data.
- The real fixture is a frozen export of the Kaizen cashbook for 1 February to 27 August 2026. A named human confirms the figures (1,123 vouchers, 66 ledger accounts, a gap of about 40,500) against the source books at onboarding, and the confirmation is recorded in DECISIONS.md.
- The mapping CSV (`ledgerGroup` to `accountType`) is reviewed at onboarding by the holder of the 1.5 account-mapping review duty. That duty is a level duty (round 9), so the file names no person.
- The questionnaire samples A, B and C (QUESTIONNAIRE-DRAFT.md:136-160) are access-mapping fixtures. They are not L2 inputs.
- L2 stays blocked until both steps are done.

### c) G10 is role-based (CI-GATES-DRAFT open question 10)

Owner ruling: G10 is rewritten as role-based. It checks structure, never values. The approver is resolved from a tenant-level duty, not named in code.

- Check (c), approval, has five parts:
  1. No literal holder name, person id, email or role label (`internal finance head`, `finance_head`, `accountant`, `chairman`) outside the seed folder, in finance, HCM or compliance paths.
  2. The approver of a statutory row is resolved at runtime from the tenant-level duty assignment. A tenant with no holder gets zero APPROVED rows. Each statutory feature fails closed with "awaiting the accountant's setup".
  3. Every seed and migration row is DRAFT. A test asserts that no seed row is APPROVED.
  4. The approver is not the enterer or editor of the row. Round 23 item b (the founder exemption) still applies, and this check does not bind the founder.
  5. Each approval is audited with the resolved approver, the time and the rule version.
- "Internal finance head" stays only as interim wording (round 3, D-02; round 12 item 1). Round 23 item d supersedes it for permanence. The stale line that said the values "stay with the internal finance head" is removed.

### d) Code follow-ups for the Phase 0 session (recorded, not built)

These are audit findings, not verified facts. They are UNVERIFIED against official gazettes. The official sites epfindia.gov.in, esic.gov.in and incometax.gov.in refused fetching, so every figure in item d(v) rests on secondary sources. None is built in this PR.

i. DRAFT has no effect on computation. The live readers for PF, ESI, PT, LWF, TDS, slabs and GST read typed rate tables that have no status column (`apps/api/src/domains/compliance/payroll.ts:94, 114, 143, 165`, `apps/api/src/domains/compliance/tax.ts:133-135, 733`, `apps/api/src/domains/compliance/gst.ts:831`). `ruleAt()` (`apps/api/src/domains/statutory.ts:88`), the only APPROVED-only resolver, has no non-test caller.

ii. Seeded `StatutoryRule` rows have no `createdBy` (`apps/api/src/seed/compliance/statutory.ts`), so `approveStatutoryRule` refuses them (`apps/api/src/domains/statutory.ts:8-12`). Their `source` values are briefs, such as "Phase 3 brief" (`statutory.ts:19, 26, 33, 40, 47`), not notification references.

iii. Figures are hard-coded in the seeds, and the seeds are exists-checks (`apps/api/src/seed/compliance/payroll.ts:11-12`, `apps/api/src/seed/compliance/tax.ts:127`). A corrected value never reaches an existing tenant. This contradicts ORDERED-PLAN 3.1: "Figures are NOT reproduced in the repository."

iv. Approval ladders hard-code role names. The access plan records `resolveApprover` taking the first affiliation with the role (`docs/plan/zen360/ACCESS-MODEL-PLAN.md:142`). The IT licence ladder is `['finance_head', 'chairman']` (`apps/api/src/seed/bootstrap.ts:2123, 2130`). No statutory ladder was found in this check. The approval code path is not traced, and round 23 item d forbids a hard-coded holder for statutory approval.

v. Candidate stale or contested values, for the approver to verify at onboarding:

- PF wage ceiling is seeded at 15,000 (`apps/api/src/seed/compliance/payroll.ts:21`). Secondary sources report 25,000 from 17 Sep 2026 (S.O. 5109(E)).
- 194H is seeded at 5% with a 15,000 threshold (`apps/api/src/seed/compliance/tax.ts:55-59`). Secondary sources report 2% and 20,000 from 1 Apr 2025. Audit 7 cited `:41-43`; on `origin/main` the 194H row is at `:55-59`.
- Tamil Nadu PT is seeded as 135, 315, 690, 1,025 and 1,250 half-yearly (`apps/api/src/seed/compliance/payroll.ts:49-56`). The spec (archive/phase-3-statutory.md 3.1) and the Greater Chennai table give 100, 235, 510, 760 and 1,095.
- The PF wage base is basic plus DA (`packages/shared/src/compliance/payroll.ts:42`). Secondary sources report the 50% wage-definition rule from 21 Nov 2025.
- TDS section labels use 1961 numbering (`apps/api/src/seed/compliance/tax.ts:27-86`). Secondary sources report Income-tax Act 2025 numbering from 1 Apr 2026.
- Surcharge is not modelled. `IncomeTaxSlabTable` holds only a cess percentage (`apps/api/prisma/schema/compliance-tax.prisma:151-170`).

### e) Document edits in this PR

- `CI-GATES-DRAFT.md`: open questions 9 and 10 are marked answered. The G10 section is rewritten as role-based, with check (c). The L2 reviewer sentence and gate status are updated.
- `ORDERED-PLAN.md`: the "waiting on" wording for 1.5, 3.1, the PF, ESI, PT and TDS blocker, and the statutory sign-off open item now points to this round.
- `CURRENT.md`: no change. It lists no statutory or L2 item as waiting on the owner.

### Round 27: what was not done

- No code, schema, seed, test or CI change. Items d(i) to d(v) are for the Phase 0 session.
- No seed value is changed and no value is verified.
- Not decided: the holder's name and the duty key name for statutory approval. Both are set at onboarding (round 23 item d).
- The Kaizen figures are not confirmed, and no named human has confirmed them.

## Owner answers, round 28 (recorded 2026-10-12, night)

Append-only. Source: the owner's answers of 2026-10-12 (night), as written in the owner's decision note of the same date. Where a later line in that note supersedes an earlier one, the earlier line is marked as superseded and the later one governs. "What was built" lines give the PR where one is known. "in progress" means the work is not merged, and no PR number is given for it.

- **Enforce DRAFT.** Build the status, maker-checker and duty resolver now. Switch the live readers at onboarding.
  - What was built: #66 (merged): status, maker-checker and the duty resolver. The live readers are not switched; that waits for onboarding.
- **Rate store.** Readers move to `StatutoryRule` (`ruleAt`). The typed rate tables become read-only legacy. There is one approval flow. This happens after the money slices.
  - What was built: no PR recorded.
- **FX-73 payroll: division to business line.** A division-to-business-line map, date-effective and kept by finance. An unmapped division refuses with HTTP 422.
  - What was built: in progress.
- **FX-73 payroll: ledger entity link.** A nullable `ledgerEntityId` foreign key on `EmploymentRelationship`, backfilled by exact match.
  - What was built: in progress.
- **FX-73 payroll: one entry per run.** One balanced entry per ledger entity per run. Unmapped refuses (the note does not say which unmapped case; read it as the same rule as the division map).
  - What was built: in progress.
- **FX-73 payroll: accrual date.** The payroll accrual is dated the last day of the pay month, in IST.
  - What was built: in progress.
- **GST return check (`gstReturns.ts:500`).** Keep the ₹1 tolerance, held exactly as 100 paise.
  - What was built: not yet; it rides a later money slice. #70 (money S1) does not change the GST path.
- **Statutory approver duty.** The founder holds it unless onboarding changes it.
  - What was built: #66 (merged).
- **Statutory figures.** The owner approves the approach. Each rule is approved in-app by the duty holder, with a verified citation. Seeds stay DRAFT and UNVERIFIED.
  - What was built: #66 (merged): the in-app approval flow, with seeds left DRAFT and UNVERIFIED. The G10 sweep is in progress.
- **Founder authority.** The owner's words, verbatim: "The founder is end all be all, he can do whatever he wants."
  - Implementation: a tenant duty `founder` (`DutyAssignment`), held by the owner's founding account unless onboarding changes it.
  - The founder is exempt from maker-checker and separation of duties everywhere: statutory author equals approver, duty self-assignment, approval ladders, and `payments:approve`. Round 23 item b applies, so founder-created payments need no second approver.
  - Every waived check is recorded in the audit metadata as `founderOverride`.
  - Not waivable, because the CLAUDE.md rules say they cannot be disabled: the audit trail, tenant scope, period close, and posted-entry immutability. A founder correction is still a reversal.
  - This supersedes the D-10 in-app gate for founder deals.
  - Flag: Companies Act s.188 related-party board approval is outside the app. The app does not check it.
  - What was built: #69 (founder exemption). `payments:approve`: in progress.
- **L2 harness (current).** Kaizen has no legacy books, and books are created by using the ERP. L2 does not apply to Kaizen until the cashbook-to-journal cutover. The harness is kept for pre-cutover ERP cashbook rows and for later tenants. L2 is never passed on synthetic data.
- **L2 fixture: "real books" (withdrawn).** An uploaded spreadsheet was first recorded as Kaizen's real books, with L2 applying to them. That was a misreading, withdrawn by the next item. The plan's "1,123 vouchers" figure is not supported either way.
- **L2 fixture: test data (current).** The owner: the uploaded spreadsheet is test data only. Its imbalance and the mapping review are not owner items. It still stays out of git, because it may carry personal-looking data, and is loaded from `L2_FIXTURE_DIR`. The L2 harness item above stands.
  - What was built: #68 (L2 harness).
- **L2 mapping: "Suspence - Rishikesh".** The owner's account of this treatment: transfers to the founder's personal savings account, so that he could pay company expenses by debit card or UPI, because the current account had neither. Treat it as a balance-sheet clearing account, class asset, with the founder as paying agent. The net is held by the founder (positive) or owed to the founder (negative). It is not an expense and not capital.
  - Founder-related transactions: the independent reviewer is an authorised director (D-10). The founder authority ruling above supersedes D-10 for founder deals.
- **Quote money to paise (2026-10-13).** Quote, QuoteLine and PriceBookEntry money moves to paise with ties rounded half away from zero (`toMinorHalfUp`, `packages/shared/src/money.ts:104`). Some stored quote figures change by one paisa at exact half-paisa ties, and the PR names them.
- **S10 statutory tables (2026-10-13).** The statutory parameter tables (GST, TDS, income-tax slabs, PF, ESI, LWF, minimum wage, stamp duty) move to date-effective `StatutoryRule` rows (CLAUDE.md rule 4), with the 0.00015 stamp-duty rate in `apps/api/src/domains/filings.ts:849` and the 15/26 gratuity factor in `apps/api/src/jobs/compliance/payroll.ts:61` — not a type change in place.
- **Invoice posting in Phase 0 (2026-10-13).** Invoice issue and collection post to the journal in Phase 0 through `platform/ledger.ts` `post()`/`postInTx()` with trial-balance tests. Today they post nothing: `buildInvoiceIssueEntry` (`packages/shared/src/postingRules.ts:177`) has no app caller; its only callers are in `apps/api/src/tests/ledger/postingPlumbing.test.ts`.
- **CMP-PAY-004 fixture (2026-10-13).** The CMP-PAY-004 test fixture (`apps/api/src/tests/compliance/payroll.test.ts:344`) gets a fee at the seeded minimum-wage floor so the payroll suite reruns on one database.
- **demoDataset.ts edits (2026-10-13).** Agents may edit only the lines the typecheck names after a column rename (field name and paise value), nothing else in the file.

Built, not tied to a decision in this note: FX-51 and FX-64 are in PR #67, which is open, not merged.

- **payments:approve on money out (C-005; owner, 2026-10-13).** `payments:approve` gates money out only. Gated: vendor bill payments, manual cashbook entries with direction out, the asset purchase cash leg, recurring out-rules, and a reversal of an inward row. A request writes no Transaction and moves no bill until a second person with `payments:approve` approves it, in the same database transaction as that write (`PayoutRequest`, `apps/api/src/domains/payouts.ts`). The requester may not approve. The founder's requests count at once, audited as founderOverride `payment_second_approver`, under the founder exemption at DECISIONS.md:1232. An agent may neither request nor approve. Recurring out-rules are approved once as a rule, and each occurrence then posts without another approval; a change to a rule's amount, direction or account needs a fresh approval. Money in (receipts, bank credits) is recorded at once: money in carries no outflow risk for a second approver to catch. Not gated, and why: bank-statement import debits (the money has already left, so a gate would only record it late); own-account transfers as such (there is no transfer endpoint, and the manual out leg is gated while the in leg is not); payroll posting (already gated upstream by payroll approval); refunds (`refunds:approve`); payroll journals (`payroll_journals:approve`); the import undo (`revertImport`), which reverses inward rows and is left ungated pending an owner decision; reversePayment (`domains/finance.ts`), which writes no Transaction and is left as it is. Approvers today are the chairman only (`seed/grants.ts`); no grant or separation-of-duties change is made. This answers the open point 6 at DECISIONS.md:862 for founder-created payments, and builds C-005 (DECISIONS.md:864). Open for the owner: finance_head as approver (it conflicts with `payment_create_approve`, `sod.ts:37`); whether the import undo's reversal of inward rows needs a gate; the books post of payroll not rechecking the run approval; a receipt paid back in cash, which no flow records.
- **Import undo stays ungated (owner, 2026-10-13).** `revertImport` (`apps/api/src/imports/commit.ts`) reversing inward rows is not gated by `payments:approve`. The original import was money in, and the gate is money out only. This closes the import-undo point left open in the line above.

### Still open

- D-02, exact rounding for GST, for the finance head. The note's example: 5% of 42.70 gives 2.14 under exact rounding, where the current rounding gives 2.13.
- C-008, C-009 and C-015 (level model and account recovery holder; the owner has not answered them).
- FX-24: consumer idempotency and the EventRecord and AuditRecord cross-anchor, pending the D-16 deferral.
- FX-62: how audit and event personal values are handled under s.128(5).
- FX-80: the certificate snapshot is returned unfiltered, and there is no public verify.
- The 0.6 deviation: the hash chain uses an advisory lock under ReadCommitted, not SERIALIZABLE. The owner has not yet accepted it (`ORDERED-PLAN.md`, 0.6).
- The croner licence record. It is not yet in the repository.

### Round 28: what was not done

- No code, schema, seed, test or CI change. This round changes docs only.
- The spreadsheet was not opened, and no figure from it is recorded.
