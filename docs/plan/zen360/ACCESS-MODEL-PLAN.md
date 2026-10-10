# Access Model Plan: Level x Vertical, built from onboarding data

Status: v3 — taxonomy approved (DECISIONS round 20). Planning only. No code changed.
Labels: **OWNER ANSWER** (decided, cited), **PROPOSED** (this draft), **OPEN** (needs the owner), **UNVERIFIED** (not confirmed against source).
Short forms: D = `docs/plan/zen360/DECISIONS.md`, Q = `QUESTIONNAIRE-DRAFT.md`, OP = `ORDERED-PLAN.md`, CAP = `CAPABILITIES.md`, R1-R4 = research notes.

## Summary

Access is **Level x Vertical**, not a job-role catalogue. A **vertical** is tenant data: a name, the record types it owns, and optional sub-units. A **level** is tenant data: how far a person reaches (own, team, unit, vertical, company) and how much they may approve. A person's access is one or more **placements** (vertical, optional unit, level) plus named extra duties. At confirmation the placements compile into ordinary `Grant` rows, so the evaluator and its cache stay as they are. Nothing is hardcoded: no seeded people, no role slugs, no role-to-grant matrix. The only thing that ships is an unassigned, editable starter template. The very first user (the founder) is created by tenant provisioning with a narrow setup authority and builds everything else through onboarding. HR runs onboarding. The accountant runs a guided statutory setup after the application is set up, so access mapping no longer waits on statutory sign-off. The engine is extended, never rewritten: a `vertical` / `unit` scope resolver composing with the owner rule, wider list filters, fail-closed when a record type has no vertical binding.

## Decisions needed from the owner (top 6)

| # | Decision | Recommended default |
|---|---|---|
| 0 | **Answered — round 20 (five lines, units beneath).** **Confirm the interpretation of the cut-off note** "not just telecalling and training but every similar and relevant thing": division, then vertical, then unit, covering every comparable unit in section 3. | Confirm; HR and the founder enter it as data. |
| 1 | **Answered — round 19 (d), round 20.** Is a **unit** (desk) inside a vertical acceptable? It is how telecalling differs from training. Alternative: split Education into two verticals. | Units. They are defined by the records worked, not by job titles (section 3). |
| 2 | Does anything ship with the app? | Only an unassigned, editable starter template (capability catalogue and defaults), never assigned roles (OPEN 2). |
| 3 | **Answered — round 19 (f).** Can a person hold different levels in different verticals? | Yes, one level per placement; most people have one placement (section 3). |
| 4 | **Answered — round 19 (g).** Who confirms a mapping, given HR answers it? | HR answers; the vertical Head confirms placements; founder confirms sensitive duties and Head placements (section 7). |
| 5 | **Answered — round 19 (c).** Reorder the plan: onboarding and access first, statutory sign-off after, as the accountant's guided setup. | Yes (sections 8, 9). |

## 1. Owner corrections applied

| Owner correction | Effect on this draft |
|---|---|
| HR does onboarding | HR is the questionnaire answerer and case owner. Resolves D:428 vs D:552 for HR. Founder stays confirmer for founder-only and sensitive duties (D:278, D:454); flagged in section 7. |
| Nothing set up by hardcode | Section 5. The role matrix and slugs stop being the source of access. |
| Statutory sign-off after setup, by the accountant | Section 9. Access mapping decoupled. |
| Not a job-role model; level-based vertical split | The function catalogue is dropped. Sections 2 and 3. |
| "Verticals should." (finished: every similar operational unit) | Section 3 (lines → units); answered, round 20. |

## 2. The model

### 2.1 Vertical (PROPOSED, tenant data)

| Field | Meaning |
|---|---|
| key, name | One of the five business lines (SKL, EDU, CLR, TEC, WFS) or a shared function, from the `BusinessLine` registry (`VERTICAL-TAXONOMY.md`). The inception list in `packages/shared/src/domain.ts:9-20` is the legacy source being replaced by that registry (see 5.5). |
| kind | `business` or `shared` (section 2.5) |
| owned record types | The record types this vertical's people work, each with a **binding** (how a record says which vertical it belongs to; section 4) |
| units | Optional sub-units. Each unit names a subset of the vertical's record types |
| capability rules | For each owned record type, which verbs each level rank may use |

### 2.2 Level (PROPOSED, tenant data)

| Field | Meaning |
|---|---|
| name, rank | Staff, Manager, Head are the owner's three (D:355-361); the tenant can add more |
| reach | One of **own** (the owner rule), **team** (reporting line, existing `management_chain`), **unit**, **vertical**, **company** |
| verb band | Which verbs the vertical's capability rules grant at this rank |
| authority | Approve limits per class of approval, as bigint paise, tenant data. No figure in code or in this document |

Starter reach (PROPOSED): Staff = own; Manager = team; Head = vertical; company reach belongs to the leadership vertical (founder). Unit reach exists for tenants who add a unit-lead level.

### 2.3 Placement and extra duties

A **placement** is (person, vertical, optional unit, level). A person's **assignment** is one or more placements plus **named extra duties**: each approved, expiring, conflict-checked (D:454). Extra duties are where sensitive grants live (approvals, payroll, bank, user admin, company-wide data); they are never part of a level.

### 2.4 How they combine

For one placement, for each record type R owned by vertical V (narrowed to the unit's types if a unit is set):

| Question | Answered by | Example |
|---|---|---|
| WHICH modules and record types? | Vertical (and unit) | Education owns Lead, Cohort, Enrollment |
| WHICH records? | Vertical binding plus the level's reach | Lead.vertical in the person's verticals AND owner rule per reach |
| HOW FAR? | Level reach | own, team, unit, vertical, company |
| WHAT VERBS? | Vertical's capability rule at the level's rank | Staff V/C/E; Manager adds reassign; Head adds approve |
| WHAT AUTHORITY? | Level authority limits | approve up to a limit held as data |

Compile step (PROPOSED): confirming a placement writes `Grant` rows (`principalType: individual` exists, `main.prisma:744-774`) with `conditions` carrying vertical, unit and the assignment id, and `effectiveFrom/To` for expiring duties. The evaluator reads them as today (`permissions.ts:131`, `resolveGrants :54-94`). A mover or leaver deletes the rows by assignment id. Tenant edits to a vertical, a level or a capability rule raise review tasks and recompile (templates versioned, R4).

### 2.5 Cross-vertical functions: propose they ARE verticals

Finance, HR, IT/Admin and Leadership have no vertical field on their records (Invoice has none, R1) and are not business verticals. Make them **shared verticals** with the same model.

| Shared vertical | Owns (R1) | Why a vertical works |
|---|---|---|
| Finance | Invoice, Payment, Receipt, FeeInstalment, CreditNote, GstFiling, VendorBill, bank lines | Records bind by fixed owner vertical, not a column. Business-vertical staff never see them |
| HR | EmploymentRelationship, Position, Requisition, Application, LeaveRequest, PayrollRun, Payslip, DisciplinaryCase, ExpenseClaim | Same. Payroll is a unit so it can be gated apart |
| IT/Admin | IT assets, tickets, letters, ID cards, travel | User admin stays a named extra duty, never a level |
| Leadership | Decision, BoardMeeting | Company reach lives here |

A business-vertical person who must see a shared record (a counsellor viewing fee status) gets it through a named extra duty or a derived binding (section 4), not through Finance membership.

## 3. Verticals: business lines → units

**OWNER ANSWER (D round 19 (d), round 20).** The vertical axis is the five business lines of the group-level `BusinessLine` registry: SKL Skill Development, EDU Education, CLR Corporate Learning, TEC Technology Services, WFS Workforce Solutions. Definitions, the five-question test, successor mapping and the old→new mapping live in `VERTICAL-TAXONOMY.md`. This section does not repeat them.

Why lines and not the inception list: the inception list mixed lines, channels and cost centres, so a split or a new scheme would have broken records, access and reports. Lines are fixed, immutable IDs. Everything beneath them is data.

### 3.1 Structure

- A **unit** sits under one line, or under a shared function: Media & Marketing, Finance, HR, IT/Admin, Leadership. A unit is a group of people who work the same record types, not a job title.
- Telecalling, training, admissions, delivery and similar desks are **units or channels**, never verticals.
- A **placement** is (person, line or shared function, unit, level). A person may hold several, each with its own level (D round 19 (f)).
- Shared functions use the same model. Their records bind by fixed owner, not a line column. Payroll is its own unit so it can be gated apart (SoD, section 8).

### 3.2 Starter units, re-homed under lines (PROPOSED, unassigned, editable)

| Line or function | Units | Records the unit owns |
|---|---|---|
| EDU | Telecalling desk; Admissions / counselling; Training / delivery; Placement-linked candidate desk | Lead, Interaction, Task; Opportunity, StudentProfile, Enrollment; Cohort, Attendance, DailyProgress, LearnerLog |
| CLR | Corporate sales; Training delivery; SAP training sold to companies (round 20 (d)) | Lead, Opportunity, Contract (draft), Organization; Cohort, TrainingSession |
| TEC | Consulting delivery (SAP consulting); Software / AI delivery; Cybersecurity; Sales | Project, Task, timesheet, Contract (view); no engagement model yet |
| WFS | Candidate desk; Employer relations | CandidateProfile, Application, BackgroundVerification, OfferLetter; Organization, Requisition, Position |
| SKL | Mobilisation; Programme delivery | No programme or scheme model yet |
| Media & Marketing (shared) | Campaigns; Content | MarketingCampaign; content has no model |
| Finance, HR, IT/Admin, Leadership (shared) | Receivables, Payables, Books; Recruitment, Payroll, Employee relations; Techops, Admin; Founder office | As in R1 |

Moved out of the vertical list by round 20 (e): Research is a cost centre, Partnerships is a channel, Ventures are legal entities, the Foundation is a separate Section 8 entity.

### 3.3 What narrows scope without being a vertical

Legal entity, channel, scheme, programme, location/GSTIN, cost centre and reporting segment are **not** access verticals. Each can narrow a person's scope as a filter. None decides which record types a person reaches.

### 3.4 Telecalling versus training, and people in several placements

The unit's record set makes the difference (D:551: "vertical picks template, level sets duties"). EDU / Telecalling gets Lead, Interaction, Task at own reach and no learner record. EDU / Training gets Cohort, Attendance, DailyProgress, LearnerLog for assigned cohorts and no Lead or money.

An `Affiliation` has one `roleSlug` (`main.prisma:299-339`) and reach never unions across contexts (`auth.ts:698-700`). Recommended (PROPOSED): one affiliation holding several placements, unioned inside it. Contexts stay for different identities (employee vs student/trainer), not for lines.

### 3.5 Fit test

A unit earns its place only if it owns a record set no other unit owns; otherwise it folds into a neighbour. Units under SKL and TEC cybersecurity have no record model yet, so a placement there falls back to baseline only.

## 4. Engine: extend, never rewrite

CLAUDE.md forbids rewriting `permissions.ts`, `recordScope.ts`, `db.ts`, `lifecycle.ts`.

| Change | Today (evidence) | Proposal |
|---|---|---|
| Vertical/unit scope | `evaluate` never reads `conditions` (R2 §3). Only `routing.ts:79-99` reads `conditions.verticals` | New `scopeResolver` branch in `checkScope` (`permissions.ts:270-293`) comparing the record's vertical binding to `grant.conditions` |
| Compose, don't replace | A `scopeResolver` REPLACES scope (R2 §3) | Resolver result is combined with the owner rule per reach: Staff = in vertical AND mine; Head = in vertical |
| Lists narrow | `scopeWhere :369-378` and `visibilityWhere :423-435` know only owner and branch; WHERE skipped with no record (R2 §8) | Emit a vertical predicate in both. `scopeFor` returns the resolver |
| Lifecycle | `lifecycle.transition` passes only `ownerPartyId` (`lifecycle.ts:77-81`) | Pass the vertical binding too |
| Trainer reach | `batch_member` exists (`:278-279`, reads `record.trainerPartyId`), UNSEEDED, inert | Compile it into Training-unit Staff grants. `TrainingSession.trainer` is free text (`hcm-learning.prisma:52`); needs a party reference first |
| Team reach | `management_chain` exists (`interactions.ts:394-410`), UNSEEDED | Compile it for Manager reach |
| Branch | Scope reads `User.branch` (`http.ts:66`); routing reads `Affiliation.branch` (R2 §8) | Unify on `Affiliation.branch` before any branch-scoped grant |
| Admin API | `POST /admin/grants` writes one row per role+resource (`admin.routes.ts:115-156`); two-scope pattern unwritable (R2 §1) | Compiler writes rows directly with a typed assignment path; also allow multi-scope rows in the admin API |
| Fail closed | Missing `@` means all (`permissions.ts:72`) | A vertical-scoped grant on a type with no binding DENIES on read, list, create, update. Startup check lists such pairs |
| Approvals | `resolveApprover` takes first affiliation with the role, ignores scope (`approvals.ts:302-314`); ladder is hardcoded `['finance_head','chairman']` | Resolve by level authority and vertical from assignment data (see 5.4) |
| Agents | Own grant rows only (`permissions.ts:71`, R2 §6) | Out of scope; an agent never inherits a human's new scope |

Tenant scope still comes from the session, never a body or query (CLAUDE.md rule 6). The vertical set is read from the confirmed assignment on the server.

### Record binding table

How each record says which vertical it belongs to. Binding kinds: **field** (a column), **fixed** (the type belongs to one shared vertical), **derived** (via a parent), **none** (denies for vertical-scoped grants).

| Record | Touched by | Binding today | Schema change |
|---|---|---|---|
| Lead | Telecalling, Admissions, BD | field, required (`main.prisma:1481`) | None |
| Opportunity | Admissions, BD | UNVERIFIED | field, or derive via Lead / `PipelineDefinition.appliesToVerticals` (`:1254`) |
| Interaction, Task | Telecalling, all | UNVERIFIED | Derive via Lead; non-lead tasks stay own-only |
| Person, Organization | CRM | none | Keep own-or-unowned; not vertical-scoped (OPEN 9) |
| StudentProfile | Admissions | UNVERIFIED | field or derive via Enrollment |
| Enrollment | Admissions, Finance | UNVERIFIED | derive via Cohort |
| Cohort | Admissions, Training | UNVERIFIED (has `trainerPartyId`, `:3492`) | Add `vertical` column |
| Attendance, DailyProgress, LearnerLog | Training | UNVERIFIED | derive via Cohort |
| TrainingSession | Training | trainer is free text | party reference, derive via Cohort |
| Project | Delivery verticals | UNVERIFIED | Add `vertical` |
| Mou, Contract | Partnerships, BD | UNVERIFIED | Add `vertical` |
| Requisition, Application, CandidateProfile, OfferLetter, BackgroundVerification | Placement; HR for internal hires | UNVERIFIED | Placement: field on Requisition, derive the rest. Internal-hire use belongs to HR (fixed) via a purpose field |
| MarketingCampaign | Marketing | field (`marketing.prisma:28`) | None |
| Invoice, Payment, Receipt, FeeInstalment, CreditNote | Finance | none (R1) | fixed to Finance. Business-vertical read via derived binding or extra duty |
| Payroll, Leave, Expense, Disciplinary | HR | none | fixed to HR |
| IT assets, tickets | IT/Admin | none | fixed to IT/Admin |
| Decision, BoardMeeting | Leadership | none | fixed to Leadership |

Most education records are UNVERIFIED. One schema pass over `main.prisma` should settle it before the capability rules are written.

## 5. No hardcode: moving off the role matrix

### 5.1 What is hardcoded today (R2 §1, §7)

Seven slugs `ROLE_SLUGS` (`shared permissions.ts:299-311`), `ROLE_DEFINITIONS` and `ROLE_GRANT_MATRIX` in `apps/api/src/seed/grants.ts:1135-1208`, `ROLE_CLASSIFICATION_CEILING`, demo users with titles (`demoDataset.ts:149-157`), boot sync that adds missing rows (`grantSync.ts:56-115`), and approvers by slug (`approvals.ts`).

### 5.2 What replaces it

| Today | Replacement (PROPOSED) |
|---|---|
| Role matrix as source of grants | Vertical capability rules + level definitions, as tenant tables. Grants are compiled output, never authored in code |
| `ROLE_SLUGS` as the role list | Gone as a source. Persisted `AccessRole` rows remain only for legacy holders until migrated |
| Classification ceiling per slug | Ceiling per level (and per named duty), tenant data; missing ceiling defaults to the lowest, not `internal` silently (R2 §7) |
| Seed demo users | Demo tenant is built by a script that calls the same onboarding API; no people in seed files (OPEN 4) |
| Boot `grantSync` | Retired for new tenants. Replaced by recompile-on-change with review tasks |
| Approver ladder by slug | Approver resolved by level authority limits and scope |

What stays in code is **vocabulary**, not assignment: the resource and verb catalogue (`RESOURCES :100-269`, verbs `:22-36`) and the non-editable SoD pairs (section 8). OPEN 2 asks whether the starter template ships.

### 5.3 Bootstrapping the first user

Tenant provisioning creates the founder identity and one grant set tagged `bootstrap`: onboarding, access administration, vertical and level setup, and the exceptions view. Nothing else. It is written as data by the provisioning step, not read from a matrix. The founder then creates the starter levels and verticals, then onboards HR through the same questionnaire (founder answers and confirms, D:428), and the accountant. The bootstrap grants are replaced when the founder's own placement (Leadership, company reach) is confirmed. Who reviews the sole founder is OPEN (Q:174).

### 5.4 Tests that pin the matrix change

| Pinning test (R2 §7) | Change |
|---|---|
| `acceptance.test.ts:355-362` grants == `planFor` | Replace with: compiled grants equal the compile of the stored assignments, and no source file contains a role-to-grant matrix (a static check) |
| `acceptance.test.ts:695-720` boot never touches rows | Keep. Add: recompile only touches rows carrying an assignment id |
| `acceptance.test.ts:364-374` no literal roleSlug comparisons | Keep, extend to forbid vertical-name literals in domains, agents, jobs |
| `acceptance.test.ts:195-227, :282-297`; `equityPhase0.test.ts:224-258`; `ceo/foundation.test.ts:71-115` | Rewrite their setup to build the tenant through test factories that create verticals, levels and assignments as data |
| ~10 tests naming `hr_ops_manager` | Same: a factory creates a Finance/HR placement. No mocks (CLAUDE.md) |

### 5.5 Existing tenants and the vertical list

Existing tenants already hold the seven roles as `Grant` rows. Keep them as **legacy** until each holder passes the questionnaire; never silently trim. A report shows who still holds a legacy role and how far it exceeds their answers. The legacy hardcoded list in `domain.ts:9-20` is replaced by the `BusinessLine` registry (`VERTICAL-TAXONOMY.md`); `Lead.vertical` is required today (`main.prisma:1481`) so the column keeps a key reference.

### 5.6 Tension with D:355-361

Round 10 says the template "ships with the app, editable per tenant". The new owner rule says nothing assigned by hardcode. Proposal (OPEN 2): what ships is, at most, an unassigned starter template (the capability catalogue and sensible default level definitions), copied into the tenant during onboarding as editable data. No assigned role, no person, no grant ships.

## 6. Staff baseline

OWNER ANSWER (D:493-497): own profile, attendance, leave, expense; own time and tasks; chat and notifications. The directory is not default.

PROPOSED: the baseline is itself a level-0 data row, instantiated in tenant setup from the starter template, and sits under every placement. A new hire holds only this until confirmed. If the tenant has not defined it, the hire holds nothing but their onboarding page (fail closed); that case is OPEN 5.

Today's `employee` role exceeds this (R2 §8; `grants.ts:1153-1201`): directory people viewable at all scope, payments and invoices create, students view and create at all scope, education create at all scope, regulated ceiling (R2 §4). New hires never get it. Existing holders migrate only through the questionnaire as recertification (section 5.5).

## 7. Onboarding questionnaire and Wave 6 enforcement

OWNER ANSWERS used: HR does onboarding; reviewer can add or remove before effect (D:427); plain-language review with per-duty toggles (D:429); same flow for joiners and role changes (D:430); about 8-12 task-worded questions (D:466); unclear answers give least access (proposed D:434).

### States (PROPOSED; no onboarding state list exists, R3 §D)

| State | Entered when | Person holds | Exit |
|---|---|---|---|
| `draft` | Employee record started | Nothing | Hire saved |
| `access_mapping_pending` | Hire saved; case created for HR | Baseline only | HR submits answers |
| `proposed` | Answers in; placements and duties computed by fixed rules (not AI, proposed D:432) | Baseline only | SoD check |
| `conflict_blocked` | Blocked pair found | Baseline only | Duty removed, or founder override with logged reason |
| `in_review` | Clean | Baseline only | Reviewer edits toggles, confirmer confirms |
| `confirmed` | Named confirmer approves | Compiled grants | Audit row written |
| `active` | Grants live | As above | Mover, leaver, recertification |
| `recertify_due` | Sensitive duties quarterly, rest annually (D:463) | As above | Reconfirmed, narrowed or revoked |
| `mover_pending` | Vertical, unit or level change | Old placements removed first; baseline held | Same flow |
| `revoked` | Leaver date | Nothing | Terminal; history kept (D:465) |

SLA and escalation on `access_mapping_pending`: OPEN 6, suggested reminder to HR at 2 business days, to founder at 5. Placeholders.

### Flow

1. Identity type (D:454). Only employee and founder run the full flow now; guests are deferred (D:519-521).
2. Vertical(s), multi-select (shared verticals included).
3. Unit, if the vertical has units.
4. Level, per placement.
5. 8-12 task questions (Q:31-46 are a PROPOSED draft; Q:111 says eleven but twelve are listed; wording approval Q:178).
6. System proposes placements and extra duties; unclear gives least access.
7. SoD check (section 8).
8. Review screen with per-duty toggles.
9. Named confirmer confirms (not the person; not the answerer if a second person exists).
10. Audit row: answers, rule version, template/level/vertical versions, confirmer.

Writes follow `assertCan` then write then `auditWrite` then `emit`. Register assignment, placement, duty and case with `registerGovernedEntities` (CLAUDE.md rule 5) or `auditWrite` no-ops. Events like `kz.access.assignment.confirmed`.

**Confirmer and the HR/founder conflict (flag).** HR answers. If HR also confirmed, one person would both answer and confirm. D:454 and D:278 keep sensitive duties and founder-only classes with the founder. Proposal: HR answers; the vertical Head confirms placements in their vertical; the founder confirms sensitive extra duties, Head placements, and HR's own mapping. This adds founder load; OPEN 7 whether the Head may confirm at all.

**Wave 6 enforcement.** Two hard rules: a hire cannot reach `active` without a confirmed assignment, and until then the person holds only the baseline. No bypass flag (CLAUDE.md "Never").

**Movers:** remove old grants, then add new (R4); rescan SoD. **Leavers (D:465):** access removed on the marked date, sessions end. Code gap: exit revokes affiliations only; session revocation is PARTIAL (CAP:396). Leaver date source is OPEN (Q:176). Session end on reduced scope is proposed (Q:128), OPEN.

## 8. Separation of duties

OWNER ANSWER blocked pairs: create payment + approve payment (D:455-460); run payroll + approve payroll; manage access levels + approve own access; change a statutory rule + sign it off (D:490). Founder override needs a logged reason, shown in the exceptions view (D:461).

PROPOSED standard pairs from R4 (tenant may add, never remove built-ins): create/edit party + approve payment to that party; enter invoice or bill + approve it; create payment + release it; payroll new-hire setup, entry, approval and bank file not one person; bank reconciliation + payment authority.

Enforcement: preventive at confirm time, detective rescan on movers and nightly, transaction-time maker-checker as compensating control (ad hoc today: `refunds.ts:80`, `books.ts:127`, `messaging.ts:759`, `workflow.ts:349,:515`). Small team: record the overlap with a named compensating reviewer (R4). The built-in pairs are code, not access; OPEN 8 confirms that is consistent with the no-hardcode rule.

## 9. Statutory setup: the accountant's guided flow (PROPOSED)

Owner: statutory sign-off happens after the application is set up; the accountant logs in and a guided setup walks her through approvals.

| Step | What happens |
|---|---|
| 0 | Accountant is onboarded through the same flow: a Finance-vertical placement plus the named extra duty "statutory approver". Holder is named per tenant (D:401) |
| 1 | First login shows the guided setup, not a dashboard, while any needed rule is `DRAFT` |
| 2 | Rules are grouped by area (PF, ESI, PT, TDS, GST, as listed in CLAUDE.md rule 4). Each shows jurisdiction, effective dates and the citation in `source` |
| 3 | For each rule she chooses `APPROVED` or `HOLD` (statuses DRAFT/APPROVED/HOLD, OP:60-61). A `HOLD` needs a reason |
| 4 | Approval is audited: who, when, rule version. The person who entered or edited a rule cannot approve it (D:490) |
| 5 | Features gate on approval for the effective date. Payroll, PF/ESI/PT/TDS posting (FX-73, OP "BLOCKED-BY statutory sign-off") and filings fail closed with "awaiting the accountant's setup" |

No figure is entered in this document or in code. OPEN 10: where DRAFT rows come from (the 3.1 pack states figures are not reproduced in the repository) and who enters them.

**Effect on the plan.** OP:125 makes the P7 onboarding state machine BLOCKED-BY 3.1 sign-off, and 3.1 itself is BLOCKED-BY statutory sign-off (OP:63). Reverse it: 3.1 (the table, the `btree_gist` exclusion, the statuses) lands with DRAFT rows; onboarding and access mapping do not wait; only statutory-dependent features gate on approval. OPEN 11 whether approving a rule collides with founder-only "statutory filings" (D:278). Reading: approving a rule is not filing; confirm.

## 10. Phasing against ORDERED-PLAN

OP Wave 6 lists commitment, case, document store, typed task source, decision keys, founder exception view, Z3 handover gate, P7 onboarding (BLOCKED-BY 3.1), the level-based access system "assigned at onboarding", thresholds as data, static public IP (OP:115-128). Wave 4 lists the internal IT owner "as a level assignment at onboarding" (OP:95).

| When | What |
|---|---|
| Before Wave 6, with **Wave 2** (correctness) | Vertical/unit resolver with fail-closed; `scopeWhere`/`visibilityWhere`/`scopeFor`; `lifecycle` carries binding; admin API multi-scope; `User.branch`/`Affiliation.branch` unification; register governed entities |
| Before Wave 6, with **Waves 2–3**, ahead of the ledger | `BusinessLine` registry (group-level, immutable IDs) and `lineId` / `costCentreId` foreign keys, so `JournalLine` carries both from its first posting (D round 20) |
| Before Wave 6, independent migrations beside Wave 3 | Vertical columns (Cohort, Project, Mou, Contract, Requisition, maybe Opportunity), nullable first. Finance and HR records stay unbound (fixed owner) |
| Before Wave 6, with **Wave 5** | `resolveApprover` by authority and scope (Phase 1A approvals depend on it) |
| **Wave 6** | Vertical, unit, level and capability tables; compile step; bootstrap; onboarding state machine and HR case; SoD; recertification; exceptions view; leaver session revoke; accountant's statutory setup |
| **Phase 1** | Guests, tenant-defined SoD pairs, break-glass, agent scope, recertification dashboards |

**Wave 4 IT-owner conflict.** The IT owner needs access before Wave 6. Resolution (PROPOSED): the founder creates the IT owner an individual grant set as tenant data through the admin API, tagged `to_migrate` and listed in the exceptions view; in Wave 6 the IT owner goes through the questionnaire and the stopgap is removed. No hardcoded role.

## 11. Test plan

Real Postgres, real contexts, real evaluator, no mocks (CLAUDE.md). Fixtures create verticals, levels and assignments as data through factories.

| Group | Proves |
|---|---|
| Level x vertical x unit matrix | Generated from the fixture data: each cell allows exactly its record types, verbs and reach and denies the rest. Telecalling-desk Staff and Training Staff each denied the other's records |
| Fail closed | A vertical-scoped grant on a type with no binding denies on read, list, create, update; one test per record in the binding table |
| List narrowing | Lists, counts and exports return only in-scope rows; a Head in one vertical sees zero rows from another |
| Composition | Staff sees own records in own vertical only; not own records elsewhere; not others' records in own vertical |
| Trainer / team reach | `batch_member` allows assigned cohort, denies another; `management_chain` includes direct and indirect reports, excludes peers |
| Multi-placement | Union inside one affiliation; no leak across contexts |
| Authority | Approve limits from level data; above-limit routes up |
| Mover | Remove then add with no overlap; SoD rescan; in-flight approvals re-resolved |
| Leaver | Grants end on date; sessions rejected; history kept; audit row (covers CAP:396) |
| SoD | Each blocked pair denies at confirm; founder override needs a reason and shows in exceptions; a mover creating a conflict is caught |
| Baseline | New hire holds only the baseline; legacy holders unchanged until confirmed |
| Bootstrap | Fresh tenant: founder can only set up; cannot read finance or HR data until placed |
| Statutory gate | Payroll refuses while rules are DRAFT or HOLD; editor cannot approve |
| No-hardcode | Static check: no role-to-grant matrix or role slug as an authority source |
| Audit / tenant | Every write audited with registered entities; no cross-tenant reads |

## 12. Compliance notes

All **UNVERIFIED** against primary sources; no legal conclusions. DPDP Rules 2025 Rule 6 (access control and logs; commencement disputed, check G.S.R. 846(E)); CERT-In Directions 2022 (log retention in India); ISO 27001:2022 A.5.15, A.5.18, A.8.2, A.8.3. The state machine, recertification and SoD map to these; no certification claim. Personal data to any inference API passes `applyFieldVisibility` (CLAUDE.md); the questionnaire is fixed rules, not AI.

## 13. Open questions for the owner

Ordered by what blocks design first.

| # | Question | Recommended default |
|---|---|---|
| 0 | **Answered — round 20.** **Confirm the interpretation** of the owner's note ("not just telecalling and training but every similar and relevant thing"): every operational unit across all business lines is a unit under a vertical, entered as data (section 3) | Confirm the section 3 starter structure, or correct it |
| 1 | **Answered — round 19 (d), round 20.** Units inside a vertical, or split Education into separate verticals? | Units, defined by records worked, not titles |
| 2 | Does anything ship? Round 10 says the template ships (D:355-361) | At most an unassigned, editable starter template (catalogue and default levels); no assigned role, person or grant |
| 3 | **Answered — round 19 (f).** One level per placement, so a person can be Manager in one vertical and Staff in another? | Yes; most have one placement |
| 4 | Is a demo tenant built by calling the onboarding API acceptable, or no demo people at all? | Script via the same API; no people in seed files |
| 5 | Baseline undefined in a tenant: hire sees only the onboarding page? | Yes, fail closed |
| 6 | SLA and escalation for `access_mapping_pending` | 2 business days to HR; 5 to founder |
| 7 | **Answered — round 19 (g).** Who confirms: Head for placements, founder for sensitive duties and HR's own mapping? | As section 7 |
| 8 | Built-in SoD pairs as code: consistent with "no hardcode"? | Yes, they are invariants, not access (non-editable, D:490 spirit) |
| 9 | Directory and CRM contacts: sensitive? Vertical-scoped? (Q:172) | Directory off at baseline; CRM contacts own-or-unowned |
| 10 | Where do DRAFT statutory rows come from, and who enters them? | HR/IT or the vendor enters; accountant only approves |
| 11 | Does approving a rule collide with founder-only statutory filings (D:278)? | No; approving a rule is not filing |
| 12 | **Line list answered — round 20 (a); capability rules still open.** Capability rules for SAP, cybersecurity, corporate training, research (INFERRED or no model, R1); skill development, media, ventures as verticals | HR drafts rules with the Head; add lines when a model exists |
| 13 | Branch scope definition (Q:170), team-scoped approvals sensitive (Q:171) | Branch is `Affiliation.branch` |
| 14 | Sole founder's access review (Q:174); leaver date source (Q:176); break-glass; recert via questionnaire (Q:177); wording approval and count (Q:178, Q:111) | Second named person; HR exit record; founder-only time-limited; yes pre-filled; owner approves final list |
| 15 | Platform admin without HR/finance (CAP:580, UNVERIFIED); `sysadmin@` as chairman | Confirm in code first |

### Contradictions from R3 section H that touch access

| Contradiction | Resolution |
|---|---|
| Prompt recipient D:428 vs D:552 | HR (owner correction) |
| Statutory pair D:460 vs D:490 | D:490 (later) |
| Statutory assigner Q:107 "founder only" vs D:401 | D:401, now the accountant's setup |
| Sessions end on leave vs code revoking affiliations only | Code gap (CAP:396); fix in leaver work |
| IT owner Wave 4 vs level system Wave 6 | Tagged stopgap data grant |
| Template ships (D:355-361) vs no hardcode | OPEN 2 |
| P7 label retired but used (OP:125) | Reword; remove BLOCKED-BY 3.1 from onboarding |

## Could not resolve

- Which education and CRM records carry a vertical (UNVERIFIED in section 4).
- Capability rules for verticals R1 marks INFERRED.
- Answered — round 20: whether the section 3 reading of the owner's verticals note is right (OPEN 0).
- Question wording is unapproved, so the flow is designed, not the questions.
- Compliance references need primary-source checks.
