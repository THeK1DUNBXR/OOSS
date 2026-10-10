# 02 Group structure, governance, intercompany, consolidation (proposal p10-p12)

## Pages covered
- p10: Group structure and complete operating coverage (divisions, nine archetypes, workflow packs, dimensions)
- p11: Group governance, shared services, entity activation (mandates, reserved matters, shared capacity, group views)
- p12: Intercompany transactions and consolidated reporting (service flow, matching, elimination, group cash, FX, acceptance)

## Verdict on multi-entity (the question asked)
- **One tenant = one company is what runs.** `CompanyProfile.tenantId @unique` (apps/api/prisma/schema/main.prisma:97) enforces one legal profile per tenant.
- **Groups are multi-tenant.** `Tenant.parentTenantId` (main.prisma:53) and computed `Tenant.kind` holding|subsidiary|standalone (main.prisma:55; `reconcileTenantKinds` platform/tenantKind.ts:39-52). Cross-tenant reads only via `EntitySnapshot` (main.prisma:2587), written by the publisher (domains/group.ts:171-364, `buildEntitySnapshot` :203, `publishEntitySnapshot` :279). Group sees only snapshots (group.ts:558-625).
- **Within-tenant multi-entity exists in schema only.** `LedgerEntity` (compliance-books.prisma:54), `JournalEntry.entityId` required (compliance-books.prisma:74), `AccountingPeriod.entityId` nullable (compliance-books.prisma:15). Migration `20260920173000_ledger_invariants` creates `ledger_entities` with RLS. Nothing creates a LedgerEntity: grep for `ledgerEntity|LedgerEntity` in apps/api/src finds only `audit.ts:110` (governed registration). The only journal writer is `platform/ledger.ts:128` (`tx.journalEntry.create`), and it has no domain caller (only the reversal at ledger.ts:203 calls `post`).
- **Live books are not on the journal.** Money lives in `Transaction` (main.prisma:4920) and `LedgerAccount` (main.prisma:4827). `Transaction` carries no entity id. Two parallel ledgers, no bridge.
- Plan drift: docs/plan/archive/README-old-index.md:39 cites `schema.prisma:81` for CompanyProfile.tenantId. Actual: main.prisma:97 (schema is split into files). The README's recommendation "put entityId on the journal now" is already done in the schema (compliance-books.prisma:74), but unused.

## Capability table

| Proposal item | p. | Status | Evidence file:line | Gap / action | Size |
|---|---|---|---|---|---|
| Multi-legal-entity group inside one platform | 10 | PARTIAL | Group = tenant tree: main.prisma:53-55, tenantKind.ts:32-52. Entity-in-tenant: compliance-books.prisma:54,74; ledger.ts:35,128 | Two incompatible group models coexist (tenant tree vs LedgerEntity). No LedgerEntity create API, UI or seed. Decide model (Decision D1) before any journal writer. | L |
| Legal entity as explicit dimension on every posting | 10 | PARTIAL | JournalEntry.entityId compliance-books.prisma:74; Transaction has none (main.prisma:4920-4990) | Entity is on the entry, not the line; Transaction and invoices have no entity. Phase 1 `post()` is the only path. | M |
| Separate dimensions: division, brand, programme, engagement, location, cost centre | 10 | PARTIAL | JournalLine division :108, costCentreId :109 (no FK), projectId, partyId, taxCodeId (compliance-books.prisma:96-112); Transaction.division main.prisma:4938 (single string); OrgUnit.division main.prisma:4161; DIVISIONS finance.ts:19 (software/skill/education/shared) | No brand, location, engagement (projectId only) dimension. `costCentreId` has no FK, only presence is enforced (ledger.ts:100,109). Cost centre master is HCM-only (hcm-workforce.prisma:108, domains/hcm/workforce.ts:549). | M |
| Historical records keep original contracting entity after restructuring | 10 | MISSING | No contracting-entity field on Transaction (main.prisma:4920), courses/contracts UNVERIFIED | Needs contract header with entity + effective-dated approval record. Journal immutability helps only once posted. | M |
| Division / practice / brand / programme as separate dimensions with restructuring | 10 | MISSING | No restructuring or effective-dated org dimension; OrgUnit has no effectiveFrom (main.prisma:4154-4170) | Effective-dated org-to-entity mapping needed. | M |
| Three divisions (Software, Skill, Education) | 10 | EXISTS | DIVISIONS finance.ts:19, labels finance.ts:22 | None. Also includes `shared`. | S |
| Consultancy as a required practice | 10 | MISSING | Not in DIVISIONS (finance.ts:19); not in OrgUnit comment (main.prisma:4161) | Add as practice tag, not a division; placement "configurable" needs a config table. | S |
| Nine capability archetypes activated only through readiness gates | 10 | MISSING | "archetype" in code is UI surface type only: packages/shared/src/api.ts:147, seed/bootstrap.ts:330 | No business archetype, no pack registry, no activation gate. | L |
| Specialised workflow packs on a common core (objects, stages, SLAs, roles) | 10 | MISSING | Tenant.config is free-form JSON (main.prisma:46) | Pack registry, pack versioning, per-pack stages. Must be built on existing lifecycle (platform/lifecycle.ts, do not rewrite). | L |
| One account buys software + consulting + learning with separate contracts and liability | 10 | PARTIAL | Organization is exclusive institution|organization (main.prisma:368-380); single-tenant divisional posting via Transaction.division (main.prisma:4938) | Contract-level separation and liability per division not modelled. | M |
| Cross-tenant coordination via separately authorised identities and projections | 10 | PARTIAL | Projections: EntitySnapshot (main.prisma:2587), publisher group.ts:203-279. Authorised identities: MISSING (Person main.prisma:222-224 and User main.prisma:1115-1117 are tenant-scoped). | Projection exists; identity-across-tenants does not. | L |
| Group governance through entity-specific mandates, not blanket admin | 11 | MISSING | AuthorityGrant (main.prisma:779-800) has principalId, authorityClass, ceilingValue; no entity or company dimension. DelegationOfAuthority (hcm-workflow.prisma:109-128) covers HR resolvers only (domains/hcm/workflow.ts:116-586). | Add `entityId` (or tenant) to AuthorityGrant ceiling checks in `assertCan`. Permission system is not to be rewritten (CLAUDE.md "Never"); extend. | M |
| Shared-services employee acts for several companies with affiliation and context preserved | 11 | MISSING | Person (main.prisma:222-224), User (main.prisma:1115-1117) per-tenant; Affiliation (main.prisma:299-315) has counterpartyId but single tenant | Cross-tenant principal with per-company context on every audit row. Identity design decision (D6). | L |
| Subsidiary activation: business case, legal evidence, signatory, bank, tax setup, opening balances, service agreements | 11 | MISSING | Tenant.status is active|suspended|archived only (main.prisma:33); no proposed/inactive state; no guard in books.ts create (books.ts:292 checks only intercompany) | Add `proposed` status and a readiness record (checklist items each with evidence and approver). Binding actions blocked until ready. | L |
| Spin-out of a division into a subsidiary tenant | 11 | PARTIAL | seed/spinOutEngine.ts:1-25 (preview/commit/revert, CLI `division:spin-out`, not in API path) | Mechanism exists; it is not an activation workflow. Copies transactions/employment/courses/orgs; sets `migratedToTenantId` (main.prisma:438 and others). | M |
| Entity-activation readiness checklist with authorised activation | 11 | MISSING | none found (grep "readiness|activation" in domains: no entity match) | Build on Decision/Approval (main.prisma:852; platform/approvals.ts). | M |
| Capital allocation: funding source, downside, milestones, release authority | 11 | PARTIAL | BudgetLine (main.prisma:5049); Decision (main.prisma:852); approvals.ts | No funding source, milestone release, or tranche model. | M |
| Shared-service request with mandate, service level, cost basis, receiving acknowledgement | 11 | MISSING | No service-agreement or recharge model; books.ts:282-284 comment declines to split shared costs | Service agreement + allocation basis + acknowledgement event. See FIX F5. | L |
| Shared capacity ledger (engineers, trainers, reviewers, rooms) with availability and competence | 11 | MISSING | No allocation/capacity model (grep `^model .*(Allocation|Capacity|Staffing)` empty). Assignment (main.prisma:4354) exists, semantics UNVERIFIED. | Allocation ledger with percent-of-time, competence link, no double counting. | L |
| Moving a specialist shows displaced work, cost and customer impact | 11 | MISSING | none | Depends on allocation ledger above. | L |
| Entity, group and personal views distinct | 11 | PARTIAL | Group read model domains/group.ts:371-456 (structure), :558 (financials); page apps/web/src/pages/equity/Group.tsx | Group view is solid; certified-report state absent. | S |
| Group oversight via permission-filtered records or certified reports | 11 | PARTIAL | Group tenant gate kept: group.ts:1-20 header; `assertScopeAll('group')` group.ts:563; EntitySnapshot only | "Certified" state on snapshots MISSING. | M |
| Group sign-in with content scoped per company | 11 | MISSING | User per tenant (main.prisma:1115-1117) | Identity decision D6. | L |
| Reserved matters (formation/disposal, capital commitment, borrowing/guarantees, related-party, IP transfer, risk acceptance, group policy) | 11 | MISSING | Mechanism: BoardMeeting (main.prisma:5307), Resolution (main.prisma:5356), owned by board.ts (docs/plan/ceo-office.md:203). No reserved-matter type or catalogue (grep "reserved.?matter" empty). | Reserved-matter catalogue (enum + approval threshold per entity) on top of Resolution. | M |
| Policy change with consultation, version, entity applicability, effective date | 11 | MISSING | Dated statutory rows are planned (CLAUDE.md rule 4); no policy versioning or entity applicability found | Policy table with entityScope and effectiveFrom/To. | M |
| Foundation / trust relationships with validated control | 11 | MISSING | tenantKind.ts:32 holding|subsidiary|standalone only; Grant model main.prisma:744 (restriction link UNVERIFIED) | Model non-controlling and trust relationships; legal confirmation needed (D5). | L |
| Intercompany service: supplier, receiver, scope, rate/basis, period, currency, budget, acceptance | 12 | PARTIAL | Transaction.intercompanyTenantId (main.prisma:~4951, indexed :~4987); set books.ts:231,292-294; counterparty validated by isInSameGroup books.ts:68-80 | One-sided field. No rate/basis, budget, acceptance, delivery evidence. | L |
| Reciprocal references and matched due-to/due-from | 12 | MISSING | No pairing key; the counterparty tenant gets no record. intercompanyTotals group.ts:132-141 sums each side independently. | Pairing record with both ids, status matched/unmatched/exception. Needs Phase 1 journal. | L |
| Settlement and reconciliation of intercompany balances | 12 | MISSING | none | Depends on pairing. | L |
| One-sided success becomes an exception, not a balanced group view | 12 | MISSING | group.ts:612-617 sums without match check | Exception queue on unmatched pairs (exceptions.ts exists: platform/exceptions.ts). | M |
| Wrong-company invoice rejection | 12 | PARTIAL | Check only on Transaction create (books.ts:292-294); invoicing.ts has no intercompany check (grep empty) | Extend check to invoices and vendor bills. | S |
| Group view: external revenue once, each unit's contribution, internal services shown separately | 12 | PARTIAL | groupFinancials group.ts:558-625; totals labelled "before eliminations" group.ts:621; GROUP_LABELS | Totals add pnlMonth income (sumPnl group.ts:613) with intercompany income included; external-once view MISSING. | M |
| Consolidation: eliminate approved internal income/expense/balances | 12 | MISSING | group.ts:704-706 states consolidation "stays an accountant's act" | Elimination proposals with evidence and independent approval (proposal p12 table). | L |
| Define scope: verified ownership/control, inclusion dates, reporting purpose | 12 | MISSING | Tenant.parentTenantId is binary (main.prisma:53); no ownership %, no dates. Cap table exists in equity (group.ts:456-557, EntitySnapshotHistory main.prisma:2630). | Ownership record with % , control basis, inclusion dates. | M |
| Collect certified close packs with cut-off and chart mapping | 12 | PARTIAL | EntitySnapshot.financial JSON (main.prisma:2587; read group.ts:598-608); AccountingPeriod status (compliance-books.prisma:12) | No certification, cut-off or chart mapping. Snapshot is trusted as written by the subsidiary. | M |
| Normalise: approved period, currency, accounting-policy and dimension mappings | 12 | MISSING | none | Mapping tables per entity. | L |
| Match internal activity (reciprocal IDs, counterparties, periods, mismatch review) | 12 | MISSING | see pairing row above | - | L |
| Freeze and report versioned pack with pre-elimination, eliminated and reconciling totals | 12 | MISSING | EntitySnapshotHistory (main.prisma:2630) is versioned for equity snapshots only | Versioned consolidation pack model. | L |
| Group cash by legal ownership, transfer restrictions, earmarked, committed, available | 12 | MISSING | cashPosition books.ts:1277-1284 is one tenant's bank/cash/wallet balances; LedgerAccount (main.prisma:4827) has no owner-entity or restriction field | Add ownership and restriction fields; committed-payments source UNVERIFIED. | L |
| Restricted grants and trust funds excluded from unrestricted cash | 12 | MISSING | Grant (main.prisma:744); link to ledger not verified | Restricted-fund dimension on ledger lines (Phase 1 journal). | L |
| Intercompany receivable is not external cash | 12 | PARTIAL | Cash from bank-type accounts only (books.ts:1282-1284), so a receivable is not counted by construction | Holds today by accident of design; no intercompany receivable object exists. | S |
| Group guarantee or loan with own authority and obligation record | 12 | MISSING | AuthorityGrant authorityClass has no guarantee class (main.prisma:779-790); Loan model exists per spinOutEngine.ts header (UNVERIFIED file:line) | New obligation record with its own authority. | M |
| Transaction and functional currency, approved rates, realised/unrealised differences, source dates | 12 | PARTIAL | JournalLine currency, baseAmountMinor, fxRate Decimal(18,8) (compliance-books.prisma:105-107); Transaction currency default INR (main.prisma:4930), no base amount | No exchange-rate table (grep `fxrate|exchange_rate` in prisma empty). Journal unused. | M |
| Acquisition, disposal, partial ownership, non-controlling interests | 12 | MISSING | none; proposal correctly says do not derive from sum of sales | Specialist configuration; Ind AS 110/103 applicability to confirm with accountant (D3). | L |
| Acceptance: two entities, reciprocal transactions, unmatched pair, wrong-company rejection, ended delegation, restricted-fund denial, reproducible elimination pack | 12 | MISSING | DelegationOfAuthority revokedAt (hcm-workflow.prisma:~118) exists for HR only | Real-Postgres acceptance suite (no mocks, CLAUDE.md "Never"). | M |
| Finance approves legal reporting and management contribution definitions | 12 | MISSING | GROUP_LABELS only (group.ts:621) | Definition record with approver, version. | S |

Counts (rows above): EXISTS 1, PARTIAL 15, MISSING 30, FIX 0 as rows (fixes F1-F9 listed separately below).

## Interconnections

- I1. Journal `platform/ledger.ts:128` ↔ live books `Transaction` main.prisma:4920. No bridge; no entity on Transaction. Missing link: posting event or FK from Transaction to JournalEntry.
- I2. `Transaction.intercompanyTenantId` (main.prisma:~4951) ↔ counterparty tenant's own Transaction. No reciprocal id. Missing link: pairing key shared by both rows.
- I3. `EntitySnapshot` (main.prisma:2587) ↔ source ledger. Snapshot is JSON with no source record ids (group.ts:598-608). Missing link: source period and batch id.
- I4. `LedgerEntity` (compliance-books.prisma:54) ↔ `Tenant` (main.prisma:28) ↔ `CompanyProfile` (main.prisma:95-97). Legal name, GSTIN, PAN duplicated across three places; no FK. Missing link: CompanyProfile or Tenant id on LedgerEntity.
- I5. `OrgUnit` (main.prisma:4154) ↔ `LedgerEntity`/`Tenant`. unitType `company` exists but has no link. Missing link: orgUnit.entityId.
- I6. `CostCentre` (hcm-workforce.prisma:108) ↔ `JournalLine.costCentreId` (compliance-books.prisma:109). No FK. Missing link: relation or validated lookup.
- I7. `AuthorityGrant` (main.prisma:779) ↔ `DelegationOfAuthority` (hcm-workflow.prisma:109). Two authority systems, no shared resolver. Missing link: DoA applies to grants or grants read DoA.
- I8. `Decision` (main.prisma:852) / `Resolution` (main.prisma:5356) ↔ approvals (platform/approvals.ts). No reserved-matter type. Missing link: reserved-matter tag on Decision/Resolution.
- I9. Group UI `Group.tsx` ↔ `groupFinancials` (group.ts:558): EXISTS. Counterparty picker `createForms.tsx:124-198` ↔ `groupCounterpartyOptions` (books.ts:240) and route books.routes.ts:185: EXISTS.
- I10. Spin-out `seed/spinOutEngine.ts` ↔ Tenant tree (main.prisma:53) and `migratedToTenantId`: the spin-out creates the subsidiary but nothing records ownership or inclusion date. Missing link: ownership record.

## Fixes

- F1. Money as float in group totals. `intercompanyTotals` group.ts:132-141 returns `num(...)` (`platform/db.ts:166-169`, which returns `Number(value.toString())`). `groupFinancials` group.ts:612-617 uses `round2` and `reduce` on floats. Violates CLAUDE.md rule 1 (`bigint` paise). Before fixing, write a test that sums `Decimal` values such as 0.1 + 0.2 and fails on the current code.
- F2. Cross-currency totals. `totalCash` group.ts:612 and `totalPnlMonth` group.ts:613 sum entity figures with no currency check. Entity `currency` is not carried in `GroupEntityFinancialView` (group.ts:575-585). Mixed-currency groups produce a meaningless total.
- F3. Self-reported intercompany figures. `intercompany.in/out` in each snapshot (group.ts:598-608, 605-607) comes from the subsidiary. Parent sums without matching. This is the one-sided success the proposal says must become an exception.
- F4. Intercompany flag only checked on create. `books.ts:292-294` validates `intercompanyTenantId` on create. Whether the update path re-validates is UNVERIFIED (not opened).
- F5. Shared-cost comment and schema disagree. books.ts:282-284 and main.prisma:4822-4826 say a shared cost split is a judgement "made at the time". `Transaction.division` (main.prisma:4938) holds one value. A shared cost cannot be split on one row; the `shared` division (finance.ts:19) becomes a catch-all. Fix requires a split table, not the comment.
- F6. AccountingPeriod entity is nullable. `AccountingPeriod.entityId` is `String?` (compliance-books.prisma:15) while `JournalEntry.entityId` is required (:74). The unique key `[tenantId, entityId, startsOn]` (:47) does not stop duplicate periods where entityId is NULL (Postgres NULLs are distinct). `post()` looks periods up by entityId (ledger.ts ~L74-80). Make entityId required before any writer exists.
- F7. Plan drift. docs/plan/archive/README-old-index.md:39 cites `schema.prisma:81`; actual main.prisma:97. README decision A says "put entityId on the journal now" which is already in the schema; the open decision is the group model (tenant tree vs LedgerEntity), not the column.
- F8. Journal immutability grant. Migration `20260920173000_ledger_invariants` line 139 is `REVOKE UPDATE, DELETE ON journal_entries, journal_lines FROM PUBLIC`. docs/plan/archive/phase-1-ledger.md:102 asks for the revoke against the app role. Whether the app role holds direct grants is UNVERIFIED. Verify before relying on immutability. (Finance path: trial-balance assertion required per CLAUDE.md.)
- F9. Own-entity figures. `pnlFyToDate: null` for the holding (group.ts:581) is correct "not measured ≠ zero" practice. Keep it.

## Advisor notes (what the proposal misses)

Data model minimum for the group core (proposed, not built):
- `GroupEntity`: id, tenantId (owning group tenant), legalCompanyId, kind (holding|subsidiary|jv|foundation|proposed), status (proposed|active|dormant|dissolved), effectiveFrom/To, readinessStatus.
- `OwnershipInterest`: holderEntityId, heldEntityId, percent (Decimal), controlBasis, inclusionFrom, inclusionTo, evidenceRef.
- `IntercompanyAgreement`: supplier, receiver, scope, basis (rate|cost|cost+margin|allocation key), currency, validFrom/To, approvedBy.
- `IntercompanyPair`: id, agreementId, sideA (entityId + txnId), sideB (entityId + txnId), amountMinor, currency, status (matched|unmatched|exception|settled).
- `ConsolidationPack`: scope version, collected entity packs (with cut-off and chart mapping), normalisation map version, pre-elimination totals, eliminations (with evidence and approver), post-elimination totals, reconciling items, freeze timestamp.
- `ReservedMatter`: code, threshold, approver class; link to Resolution.
- `ServiceAgreement` and `CapacityAllocation` (person|room|lab, percent, period, competence, displaced-work flag).

Controls to attach to every item:
- Permission: `assertCan` on group actions, with entity scope in the grant (extend AuthorityGrant, main.prisma:779).
- Audit: register every new entity with `registerGovernedEntities` (platform/audit.ts:37), not AUDIT_ACTIONS (:17). Current governed list already includes `ledger_entity` (audit.ts:110). Verify `intercompany_pair`, `consolidation_pack` etc. are registered when added.
- Approval: eliminations, activation, reserved matters and cross-entity posting need an independent approver; no agent may post or eliminate (shared rule in packages/shared/src/ai.ts).
- Tenant scope: each entity projection carries sourceTenantId; never join across tenants in SQL (CLAUDE.md rule 6).

Indian statutory and regulatory angle (flagged, not encoded):
- Companies Act s.129(3) consolidated statements and AOC-1: already partly built (group.ts:700-839, the statement of subsidiaries). Consolidation rules themselves: accountant to confirm applicable framework (Ind AS 110 / 103 for acquisitions and NCI; accountant to confirm).
- Transfer pricing and related-party: applies to intercompany service pricing. The Income-tax Act 2025 took effect 1 April 2026 and renumbers sections (docs/plan/archive/phase-3-statutory.md:35). Do not hardcode any margin, safe harbour or form number. Requires StatutoryRule rows (CLAUDE.md rule 4) and tax-adviser sign-off.
- GST on inter-unit services between registered persons where a related-person relationship exists. Treatment UNVERIFIED; do not encode.
- Cross-entity GST and TDS: each entity has its own GSTIN/TAN. LedgerEntity carries gstin/tan (compliance-books.prisma:57-62), but invoices issued by a group entity must use that entity's GSTIN; no check found in invoicing.ts (UNVERIFIED for every invoice path).
- DPDP: cross-tenant projections containing personal data are a transfer if the recipient tenant is elsewhere. CLAUDE.md "Never" bullet applies to any projection that carries personal data.
- Trust and foundation funds (p11): restricted-fund and trust control are legal questions. Do not assume they belong to the holding company (proposal p11 says the same).

Dependencies on plan phases:
- Pairing, elimination, and any posted intercompany entry need Phase 1 `post()` and the period invariants (docs/plan/archive/phase-1-ledger.md:102-103).
- Group consolidation needs Phase 1.6 money helper (`packages/shared/src/money.ts`, not yet written per CLAUDE.md rule 1) before F1 can be fixed cleanly.
- Activation readiness uses Phase 4 decision/approval surfaces (docs/plan/ceo-office.md:203).

Sizes overall: group core model L; pairing and elimination L; activation gate M; shared-service allocation L; entity-scoped authority M.

Ambiguities and omissions in the proposal:
- p10 "legal entity" and "division" are treated as separate dimensions but the proposal never says which one a journal line carries. The schema puts entity on the entry only (compliance-books.prisma:74).
- p10 says the same person can buy from several divisions in one account. It does not say whether that account is one tenant or several.
- p11 "group founder role is not automatic permission to bind every legal organisation" is correct, but the proposal does not say how the founder role is scoped today (AuthorityGrant has no entity dimension).
- p11 shared-services headcount: "recharging staff cost does not create additional hours" is a rule, not a model. No capacity object exists.
- p12 "consolidation eliminates approved internal income and expense" is stated without a basis for approval, matching tolerance, or FX treatment on eliminations.
- p12 "group cash" does not state which accounts count as committed payments or how earmarked money is recorded.
- p12 acceptance list includes "reproducible elimination pack" but no owner or retention rule.
- The proposal does not mention audit trail or tenant-scope implications of the shared-services employee case (one principal acting across tenants).
- The proposal does not state what happens to historical journal data when a subsidiary is later spun out (the spin-out engine copies transactions and marks sources `migratedToTenantId`, main.prisma:438; the journal path is not covered).

## Decisions for leadership

- D1. Group model. Choose: (a) keep tenant-per-company with tenant tree and snapshots (what runs today), or (b) one tenant with many LedgerEntity rows (schema intent in compliance-books.prisma:54). Choice drives Phase 1 and all consolidation work. Decide before any journal writer.
- D2. Intercompany mechanism. Choose: Transaction flag plus pairing record (cheap, what exists in shape), or journal-level reciprocal entries via `post()` (correct for consolidation, needs Phase 1).
- D3. Consolidation authority. Who owns the elimination policy (accountant or group finance), and which framework applies (Ind AS vs Companies Act reporting). Engineering does not encode it.
- D4. Shared-service charging basis (cost, cost-plus, allocation key). Tax and accountant decision; the code will carry a basis code, not a rate.
- D5. Foundation and trust treatment. Legal confirmation required before any fund is tagged as group money.
- D6. Identity across companies. Whether a shared-services employee gets one identity with per-company grants, or one user per tenant with a linked principal. Security and DPDP implications.
- D7. Activation gate owner and evidence list (readiness checklist items and who signs each).
- D8. Pilot scope. The proposal activates multi-company "after the single-company pilot". The tenant tree already supports a group without the ledger. Decide whether the pilot uses the tenant tree or waits for Phase 1.
- D9. Who may name a reserved matter and who approves changes to group policy.
