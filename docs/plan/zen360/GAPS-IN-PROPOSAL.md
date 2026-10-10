# GAPS-IN-PROPOSAL — what the proposal omits or gets wrong

From the advisor notes in findings 01–12, deduplicated, most consequential first inside each theme. Items that conflict with `docs/plan/` or CLAUDE.md say so. ⚠️ = needs professional confirmation; none is asserted here as law.

## 1. Conflicts with the existing plan or CLAUDE.md

- Phase numbering collides: proposal Phase 0–4 (discovery, operations pilot) vs plan Phase 0–8 (defects, ledger); proposal "Phase 1" is operations, plan Phase 1 is the journal. Rename to R0–R4 (`README.md:45`, `phase-1-ledger.md:3`).
- Proposal Phase 0 wants tenancy and access resolved before external exposure; plan defers tenancy to Phase 7 ("when a second tenant is real"). Ordering conflict (D-07).
- Plan gates are engineering-only ("Done means", `README.md:45-57`); the proposal's operating gate (owner, scenario, negative test, support, training, export, rollback) is absent from the plan. Ten proposal scenarios have no plan Done item (absence test, broken detector, provider replay, bank-change, group close).
- Staffing conflict: plan assumes the most senior person plus AI-assisted developers on the ledger (`sequencing.md:8`); the proposal costs 4–6 FTE not dedicated to the work (D-05).
- Proposal says "bounded AI" while naming OpenAI Responses, Codex and Claude Team as runtimes; CLAUDE.md says zero model calls exist and forbids claiming it. The README "AI-native" line is unsupported (`README.md:3`).
- Proposal never states the money rule (signed bigint paise) or the ledger-only write rule; many of its capabilities touch money while the schema is Decimal/number (CLAUDE.md rules 1 and 2).
- Proposal "legal entity" implies several entities under one group; CLAUDE.md and `CompanyProfile.tenantId @unique` make one tenant one company. README decision A ("put entityId on the journal now") is already satisfied in schema but unused (`compliance-books.prisma:74`).
- Proposal assumes "Party and Affiliation" exist; code has Person and Organization as separate tables and Affiliation points at Person only (`main.prisma:222,368,299`).
- Proposal bans AI actions softly ("may propose"); CLAUDE.md requires hard prohibitions in `packages/shared/src/ai.ts` (journal, IRN, filing, payroll, customer email). Several proposed AI tasks (refund, salary, credential, grant submission) have no prohibition code.
- Test policy: proposal scenarios need provider doubles (outage, 429, bank timeout); CLAUDE.md forbids mocks in the API suite (D-15).
- Plan drift to fix, not code: `README.md:39` cites `schema.prisma:81` (actual `main.prisma:97`); CLAUDE.md cites `db.ts:150` (actual `db.ts:166`); phase 6 counts agents, prohibitions and line numbers wrongly (finding 06 F25); `marketing.md:87` describes an adapter directory and providers that do not exist.
- DPDP commencement: plan states 14 May 2027, proposal says do not assume (`phase-2-audit.md:22`). ⚠️ Counsel to confirm before any date appears in copy.
- Plan 1.5 book figures (1,123 vouchers, ₹40,500 gap) are listed as unverifiable; the proposal's pilot finance gate must not inherit them.

## 2. Money, ledger and statutory

- No statement of the system of record: p55 says "one ledger owns postings" and also "integrate a statutory ledger". Which one owns GST and internal reports is unstated.
- No rule for which of entity, division or brand a journal line carries (p10); schema carries entity on the entry, rest on the line.
- Collections: p29 and p32 say "collections" and "who owns the next action" but define no collection case, promise state or dispute pause. ⚠️ MSME payment-timeline applicability to be confirmed.
- No accounting-policy owner named: "accountant-reviewed" appears throughout (GST/TDS classification, recognition, eliminations, success fee) with no named reviewer or approval record (D-02).
- Cash: p33 sets restrictions "under the law applicable on the transaction date" but not whether Kaizen accepts cash for courses at all. ⚠️ Income-tax Act 2025 section mapping and limits unverified; do not hardcode.
- Consolidation: elimination basis, matching tolerance, FX treatment, ownership percentage, owner and retention of the "reproducible elimination pack" are unspecified. ⚠️ Ind AS 110/103 applicability.
- Group cash: which accounts count as committed and how earmarked money is recorded are not stated.
- Revenue recognition for success fees, placement fees and subscriptions has no owner; payment-alone-is-not-revenue is stated but no policy store exists. ⚠️ Standard applicability unverified.
- Tax on advances and deposits, GST on placement and manpower fees (SAC), GST on SaaS and managed services, and the e-invoicing window are absent or deferred. ⚠️ Applicability unconfirmed; rows must be `StatutoryRule`.
- Payroll: "send inputs to a designated engine" but no statement whether the in-house engine is retained; gratuity and wage definitions are in transition under the labour codes. ⚠️ Stop and flag.
- Salary-account changes (p35): verification channel, cutoff days and bank return codes are bank and counsel facts the proposal leaves open. ⚠️ Not inventable by engineering.
- Fee calculator (p52): margin definition is not stated; the formula C/(1-m) is margin on revenue, not markup, and GST must be on tax-exclusive revenue.
- Multi-currency and FX revaluation have no owner; foreign receipts exist in schema.

## 3. Identity, tenancy and external users

- External users are assumed everywhere (customer, institution, learner, guardian, client acceptance, sponsor views) but there is no external identity or permission model, and the plan has no phase for it. Largest silent item (D-08).
- Group access to subsidiary data is undefined: p54 says group access never bypasses tenant boundaries but gives no model for when a group may see a subsidiary's records.
- Shared-services employee acting for several companies: no statement of identity model or how audit shows which company the person acted for (D-07).
- MSP and "customer environment" access limited to contracted scope presumes a tenancy model for external customers that the proposal does not choose.
- Account structure undefined: one person buying from several divisions in one account — one tenant or several?
- Founder authority: "founder role is not automatic permission to bind every legal organisation" is right, but how the founder role is scoped today (no entity dimension on `AuthorityGrant`) is not stated.
- Only 7 role slugs exist; the proposal's audiences (unit head, trainer, auditor, collection owner, customer) cannot be expressed.

## 4. Privacy, security and retention

- No India-residency statement for inference, transcription, documents or backups; CLAUDE.md forbids personal data to a non-India inference region for tenants requiring it. Costs for AI and transcription (p62) assume none.
- Legal hold is absent from proposal and plan (0 hits); retention and purge (p67, p68) need holds that override purge.
- Erasure vs audit retention: proposal, phase 2 and phase 7 each propose a different resolution; backups' erasure is unaddressed. ⚠️ Counsel (D-14).
- Retention source of truth: three retention tables exist, seeded periods are unsourced; the proposal names retention without naming the schedule owner or sign-off.
- Call recording, transcripts, CCTV and employee monitoring: proposal says "specific review needed" but still plans 50 consented calls and live CCTV. ⚠️ DPDP notice and consent, telecom rules, lawful basis not settled.
- Data-processing role (processor vs fiduciary) for Careers and security client data, and a vendor DPA register for every integration, are not mentioned. ⚠️ Counsel.
- Identity verification for data-principal requests, grievance redress workflow and vulnerability management are missing.
- "Append-only logs alone are insufficient" (p57) is stated without an anchoring option or key holder; embedding personal data in hash-chained rows is the unresolved defect.
- Sharing learner data with sponsors or funders is a disclosure with a purpose; whether the current notice covers it is unverified.

## 5. AI

- p28 evaluates AI features but never states that zero model calls exist; every AI row is a future commitment, not a description of the platform.
- Autonomous tiers already cover revenue treatment, owner resolution, identity link and routing; with the tier-ceiling and exact-string prohibition bypasses these can execute. The proposal does not mention it.
- No statement of who approves an AI proposal (code lets any authenticated user decide) or who owns the use case, cost ceiling and kill switch.
- Tamil/English evaluation is named but no language handling exists; "research-informed" is not "state of the art" and no cited result is reproduced on Kaizen data.
- "Organisational intelligence" and scenario simulation (p27) have no named assumption owner; analytics needs an event-completeness metric first.
- Event integrity claims (tamper-evident memory, PROV) rest on a verifier that does not recompute hashes, and on no outbox, so events can be lost between commit and emit.

## 6. Operating model

- Continuity is a concept the proposal leans on (backup owner, coverage, handover) but no object stores it: only 22 of 377 models carry an owner field, none a backup, and the proposal gives no migration path or default for existing rows.
- "One allocation calendar" has no owner; the shared-capacity ledger also solves vacant ownership, shared specialists and displaced work, which the proposal treats as separate problems.
- Service levels (enquiry, complaint, next-day delivery) are labelled targets with no scale; severity (S1–S3 exists in code) is not defined in the proposal.
- No owner is named for any capability or domain, although p04 says every commitment has one.
- Success criteria have no thresholds or baselines (duplicate-entry reduction, approval delay, admin burden); metric gaming (p60) has no measure.
- Founder exception view has no content list; 24-hour absence test is proposed without the delegation rules that must exist for it to pass (two unlinked delegation stores today).
- Who is the accountable delivery owner on a won deal (sales, delivery or finance) is not said.
- Customer complaints are the central lifecycle (p48, p49, p51) with no model, owner, clock, or statement whether the case is the same object as the exception.

## 7. Domain omissions and ambiguities

- Conflict-of-interest check, professional liability and insurance per package, reviewer independence and a qualification register are not mentioned for Consultancy and Security. "Sell only qualified services" cannot be enforced.
- Security: authority to test is the legal basis and is not made a gate; incident disclosure timing and security-practice vs Kaizen's own IT risk review (different records and access rules) are conflated. ⚠️ CERT-In timing and IT Act exposure to be confirmed.
- Careers: "recruitment-only" implies a path the code cannot produce (join always creates Kaizen employment); statutory mapping for apprentices, interns, contract labour and third-party employment is absent; guarantee and refund liability, placement-fee GST and who approves a guarantee are not specified.
- Foundation and skill programmes presuppose a charitable or trust entity and tax status without naming it; "grant" in the schema is an RBAC permission, so the funding model needs a different name. ⚠️ Section 8, 12A, 80G, CSR unverified.
- Skill Development: scheme claims are external records (portal is authoritative); the proposal omits learner placement evidence, per-programme cost, partial funding splits, and sponsor withdrawal mid-cohort. p16's "no scheme is asserted" conflicts with code that names schemes.
- Education: concessions, refund and replacement-teaching entitlements, learner-level support ownership, and what happens to learner records when a trainer is replaced are missing. Education GST exemption machinery (`CourseGstExemption`) exists and the proposal does not mention it.
- Media: no structured rights, talent-release or Creative Commons record; "no universal automated posting" is stated but not what happens to scheduled posts when no provider is approved. Ad standards and publicity rights are unverified.
- Ventures: outbound investment regime, what a venture is as a legal entity, and budgets for shared logistics are not stated. Comparators (Affinity, Workfront) are unverified.
- Customer-success "usage signals where available" names no source; no product telemetry exists.
- "Legitimate cash", "consultancy archetype", "managed service provider" and "Chapter 26" are used but not defined or not in the pages provided; chapter cross-references 1–48 (p75) point to a document not in the packet.
- Communication hub names WhatsApp, email and calling as first-class but no provider, number-ownership model or BSP, and does not say whether recordings will be stored at all.

## 8. Rollout, migration and cost

- Migration plan covers data, not schema: the project runs on `db:push` with no migrations directory (`phase-0-stabilise.md:71`).
- Migration of historical communications needs provider permission and has no import kind; imports today hard-delete on revert, skip period checks and are non-transactional.
- Cost model (p62) gives formulas without rates; no build-vs-integrate TCO for any integration (README B answers one case only).
- Product naming: proposal says "Zen 360", code is KaiERP; confirm before any external use.
- Backups: restore drill is planned only; backups are silently skipped when `BACKUP_DIR` is unset, which is the "empty dashboard conceals failure" pattern.
- Pilot sample sizes (20 decisions, 100 messages per channel, 50 calls, one payroll cycle) are reasonable but need approved tolerances and a baseline owner.
