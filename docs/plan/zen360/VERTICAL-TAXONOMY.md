# Vertical Taxonomy: a firm business-line set, and the axes around it

Status: DRAFT for owner review. Planning only. No code or repo changes.
Replaces section 3 of ACCESS-MODEL-PLAN.md (the starter structure) and feeds sections 2.1 and 5.5 of that plan.
Labels: PROPOSED = my recommendation. OPEN = the owner must decide. UNVERIFIED = seen only in notes or snippets, not checked at source.
Citations like `domain.ts:9-20` come from T3-repo-verticals.md unless another note is named. T1 = ERP dimensions. T2 = India peers.

---

## 1. Summary

The owner asked for verticals that stay firm as the company grows. Today there is no firm set. There are three hardcoded lists that disagree, free-text columns that hold them, and web copies that differ again.

The fix is not a better list. The fix is to stop asking one word ("vertical") to do ten jobs. Mature ERPs keep the legal entity, the management dimensions and the external reporting segment apart (T1 section 1, "Pattern across all five"). This plan does the same.

Core position:

1. **Business line** is the firm "vertical". It is defined by who pays and how revenue is earned. Those two things change rarely. It is a small group-level list with immutable IDs.
2. **Unit** (the team that does the work) changes often. It is tenant data under a line. Telecalling, counselling, training delivery and the candidate desk are units, not lines.
3. **Channel, scheme, programme, location, cost centre and reporting segment** are separate axes. None is a line.
4. **Legal entity** is separate again. A line can move to a new subsidiary and keep its ID.
5. Records keep the line they were posted with. Reorganisation never rewrites history. A restated view is derived through a dated successor mapping.

PROPOSED firm line set: Skill Development, Education, Corporate Learning, Technology Services, Workforce Solutions. Media & Marketing Services is a sixth line only if it sells to outsiders. Everything else the founders call a vertical is a unit, channel, cost centre or entity.

### Decisions needed (top 5)

| # | Decision | Recommended default |
|---|---|---|
| 1 | Approve the five-line set, with Media & Marketing as a shared function until it has external revenue | Yes |
| 2 | Is the business-line registry group-level (same IDs in holding and every subsidiary), whichever way D-01 and equity-portal 6b are settled? | Yes. A line is not an entity, so both answers work |
| 3 | Boundary rule: when payer is not the beneficiary (sponsor, scheme, CSR), the work is Skill Development, not Corporate Learning or Education | Yes |
| 4 | SAP: consulting sits in Technology Services, SAP training sits in Corporate Learning, told apart by offering | Yes |
| 5 | Treat Research, Partnerships, Telecalling, Ventures and Foundation as non-lines | Yes |

---

## 2. The problem today

Three hardcoded taxonomies describe the same business and do not agree.

| List | Values | Where | Used for |
|---|---|---|---|
| VERTICALS (9) | education, corporate_training, sap_enterprise, cybersecurity, software_ai, placement, partnerships, research, other | `domain.ts:9-20` | CRM: leads, opportunities, offerings, MoUs, routing, pipelines, marketing |
| DIVISIONS (4) | software, skill, education, shared | `finance.ts:19-27` | Money: invoices, transactions, budgets, payroll, P&L |
| COMMERCIAL_MOTIONS (5) | enterprise_direct, institution_partnership, learner_admission, workforce_placement, renewal_expansion | `domain.ts:167-173` | Seeded as pipelines |

Why this breaks:

- **Mixed axes.** VERTICALS mixes business lines (education), a channel (partnerships), a cost centre (research), a catch-all (other) and a delivery product (cybersecurity). COMMERCIAL_MOTIONS mixes sales channels with a lifecycle stage (renewal_expansion).
- **One-to-one bridge.** The only link is `DIVISION_TO_VERTICAL` (`events.ts:41-46`). Skill maps to corporate_training there, which is a different thing (T3 "Lines").
- **No link between CRM and books.** Lead, Opportunity, Offering and Mou carry no division. The CRM-to-books link is a manual `Invoice.division` (T3).
- **Free text, no constraint.** There is no DB enum or CHECK. Zod enums guard only some routes (`commercial.routes.ts:106`, `crm.routes.ts:780`, `:958`, `pipeline.routes.ts:92`, `books.routes.ts:54`, `finance.routes.ts:37`, `education.routes.ts:224`).
- **Web copies differ from shared** (`createForms.tsx:72-77`, `:1261-1270`). Defaults such as `'sap_enterprise'` (`Forms.tsx:277`, `Leads.tsx:158`) and fallbacks to `'other'` (`opportunities.ts:117`, `referrals.ts:223`, `capture.ts:480`) hide bad data instead of refusing it.
- **The executive chart drops unknown values** (`Executive.tsx:80`, `:348-352`).

What each change breaks today (T3 "Breakage"):

| Change | Consequence now |
|---|---|
| Rename | Filters silently miss. Pipeline lookup falls back or throws. Routing reports `no_vertical_coverage`. Zod rejects. Audience rules go stale. Imports throw (`commit.ts:1309-1318`) |
| Split | Nothing re-tags old rows. Territories, grants and claims are orphaned. Overlapping pipelines pick the earliest. Budget unique keys collide (`BudgetLine` unique on tenant, period, category, division) |
| Merge | Two P&L rows for one line. Budget key collisions |
| Move to a new entity | Pipelines, territories and grants must be recreated. The spin-out carries only transactions, employment, courses, enrolments and owned orgs (`spinOutEngine.ts:21-22`). CRM has no carry-over. `Transaction` has no entity id. Group views group by division only, so a vertical cannot be consolidated |

Good news to keep: document numbers carry no division or vertical (`documentNumber.ts:153`). That must stay true.

---

## 3. The axis model

Ten axes. Each answers a different question and changes at a different speed. They must never share a column.

| # | Axis | Question it answers | Rate of change | Owner | Lives where |
|---|---|---|---|---|---|
| a | Legal entity | Whose books, which GSTIN and statutory filings? | Rare, and each change is a legal event | Founder, with the accountant | Tenant (one tenant per legal company, D-01 owner answer, DECISIONS.md ~:34) |
| b | Business line | Who pays, and how is revenue earned? | Slow. Years | Founder (the CODM) | **Group registry** (section 6) |
| c | Unit | Which team does the work? | Often. Per hire plan or reorg | HR with the line head | Tenant data, under a line |
| d | Channel | How did this record reach us? | Quarterly. Campaigns, MoU waves | Line head and marketing | Attribute on lead, opportunity, MoU |
| e | Shared delivery capability | Which pool of people serves several lines? | Occasional | Founder | A unit with no line, plus allocation |
| f | Funding source / scheme | Who funds this programme, and under which rules? | Changes with each government or CSR cycle | Line head and finance | `FUNDING_SOURCES` in `domain.ts` today; should be data |
| g | Programme / offering | What exactly is sold or delivered? | Fast | Line head | Course, Offering, Programme tables |
| h | Location / branch / GSTIN | Where, for tax and premises? | Moderate | Finance and admin | Branch table, GST registration |
| i | Cost centre / department | Who spends, who answers for it? | Frequent | Finance and HR | `CostCentre` (`hcm-workforce.prisma:106-122`, dated assignments, unlinked today) |
| j | Reporting segment | What does the CODM review, and what do we disclose? | Rare. Disclosure rules apply | Founder with the accountant | **Derived** from lines by a dated mapping. Never a column on records |

Notes on each:

**(a) Legal entity.** KIPL today. The chairman said the three divisions become subsidiaries "in the near future" (`equity-portal.md:34-37`). Each subsidiary is its own tenant (D-01 owner answer). The entity changes books, tax and statutory identity. It must not appear in a line's ID or a record's line column.

**(b) Business line.** Defined by payer and revenue model. A line is something a sensible reader of the accounts would call "a business". It is the only axis a CODM review pack should be built from. T1 recommends a stable set of 8 to 12 lines. Kaizen needs far fewer.

**(c) Unit.** Defined by the record set a team works (ACCESS-MODEL-PLAN 3.2: a unit earns its place only if it owns a record set no other unit owns). Units live under exactly one line, or under none (shared function units such as Finance).

**(d) Channel.** Telecalling, college MoUs, referrals and digital marketing are ways of finding or reaching people. A telecalling desk is a unit (people). Telecalling as a source is a channel (a value on the lead). Keep both, with two names. PROPOSED: channel is a tenant-managed list. A unit may be tagged as the "owner" of a channel so routing can use it, but the two are not the same row.

**(e) Shared delivery.** Training delivery serves Education and Corporate Learning. Consulting delivery serves Technology Services and Corporate Learning. These are units with no single line. Their cost is spread by a line distribution (section 6.5). Their staff get access by placement, not by line.

**(f) Scheme.** Naan Mudhalvan, Vetri Nichayam, TNSDC/NSDC and CSR are already `FUNDING_SOURCES` (T3 "Lines", README:266-270). A scheme is a funder's rulebook, with claims and evidence. It attaches to a programme or a batch. It can be spread across lines (CSR funds both a skilling batch and a research study). It is not a line.

**(g) Programme / offering.** Finer than a line. Tax category and sector-skill-council tags attach here (T2 section 2: the tax category attaches to the programme or contract, not the brand; section 3: do not organise skilling by sector council).

**(h) Location.** GST is per state, so a branch or GSTIN is needed from the start (T2 section 2). Delivery locations (`DELIVERY_LOCATION_LABELS`, `domain.ts:160-165` area) are a related but different list.

**(i) Cost centre.** An internal accountability tag. Reorganises often. If it is used as the segment, an internal reorg silently changes external numbers.

**(j) Reporting segment.** Ind AS 108 follows what the CODM actually reviews, not the legal structure (T1 section 2). A segment is a derived grouping of lines with dates. Aggregation and threshold rules come from the standard text and the accountant (UNVERIFIED here, T1 says the numbers were not read). The taxonomy diverging from the internal review pack gets recut externally (T2 section 1).

### 3.1 Failure modes of conflating pairs

| Conflated pair | What goes wrong (T1 section 5, T3) |
|---|---|
| Line = legal entity | A subsidiary or merger forces re-tagging of every historic posting. This is today's D-01 versus equity-portal 6b argument |
| Line = unit | A team reorg changes a line's revenue history. Telecalling becomes a "line" with a P&L it cannot own |
| Line = channel | Partnerships shows up as a business with margin, while the same MoU feeds three lines. Admissions as channel hides its cost inside line margin; admissions as line makes it look like a product (T2 disagreements) |
| Line = scheme | A grant claim cannot be reported without re-tagging the line (T1 failure 4). Two schemes pay for one programme and it is counted twice |
| Line = programme | Every new course is a "vertical". The list grows without limit |
| Line = location | Madurai becomes a business |
| Line = cost centre | An internal reorg changes external segment numbers (T1 failure 3). Research becomes a "vertical" because it has a budget |
| Line = segment | The registry is bent to match disclosure thresholds. A merge of segments forces an operational merge |
| Unit = cost centre | Acceptable overlap if mapped one-to-many with dates. Not acceptable as one column |
| Single "vertical" column holding values from several axes | Reports sum the wrong thing and nobody can say which axis they read (T1 failure 5). This is what VERTICALS is today |
| Line coded into document numbers or account codes | A rename breaks the series and the audit trail (T1 failure 2). Already avoided (`documentNumber.ts:153`) |

---

## 4. The firm business-line set

### 4.1 The test: is this a business line? (PROPOSED)

A candidate is a line only if all five answers are yes.

1. **Distinct payer.** The party that pays is a different kind of party from the payer of every existing line (self-paying learner, sponsor or scheme, enterprise, employer).
2. **Distinct revenue model.** Revenue is earned differently (course fees, scheme tranches, contract fees, placement fee on joining, subscription or project fees).
3. **Own P&L.** Revenue and direct cost can be separated without arbitrary allocation, and the founder (the CODM function) would review it on its own.
4. **Not another axis.** It is not a product or programme, a channel, a scheme, a location, a team, or an entity.
5. **Stable for years.** It would survive a rename of every team and every campaign.

If it fails 1 or 2 it is a programme, channel or scheme. If it fails 3 it is a cost centre or shared function. If it fails 4 it is the other axis. If it passes everything except 5, wait a year and keep it as a unit.

### 4.2 The five lines

| Code (editable label) | Name | Payer | Revenue model | NIC-2008 attribute (dated, UNVERIFIED) |
|---|---|---|---|---|
| SKL | Skill Development | Sponsor, scheme or CSR donor. The beneficiary (learner) pays nothing | Programme fees in tranches against enrolment and placement evidence | Division 85 (education), group to confirm. Also check NIC-2025 |
| EDU | Education | Self-paying learners, plus institutions paying course or institutional fees | Learner fees and instalments; institutional billing to colleges | Division 85 |
| CLR | Corporate Learning | Enterprise buying training for its own staff (including SAP training) | Per-engagement or per-seat training fees | Division 85 (training), possible Division 70 for advisory |
| TEC | Technology Services | Business customers | Project, subscription, managed-service and product fees (software, AI, SAP consulting, cybersecurity, managed security) | Division 62 (computer programming and consultancy); 58 if software publishing |
| WFS | Workforce Solutions | Employer, on joining | Placement fee, or staffing margin | Division 78 (employment activities) |

NIC codes are a dated attribute on the line (section 6), never a key. T1 says verify against the MoSPI PDF (not read) and check whether NIC-2025 replaces NIC-2008 (one snippet says it was released November 2025, UNVERIFIED). I state division numbers only because T1 listed them. Group and class codes are left to the accountant. NIC divisions are a classification aid, not a statutory choice for this document.

### 4.3 Reconciling T2's five with Kaizen's own structure

T2 proposed: Education and Learner Programmes; Corporate Learning and Consulting; Technology Services and Products; Workforce Solutions; Media, Marketing and Research. Kaizen's own structure is Software, Skill Development, Education and Shared (`PRODUCT.md:134-137`).

Where I follow T2: Workforce Solutions as its own line (licence and fee rules, likely separate entity, T2 section 2). Technology Services containing software, AI and cybersecurity.

Where I depart from T2:

- **Skill Development stays a line.** T2 treats schemes as an attribute on lines 1 or 4. The evidence here says otherwise. The payer is a sponsor or scheme, the beneficiary pays nothing, revenue arrives in tranches against evidence, and compliance is audited (T2 section 2 on PMKVY; T3 "Lines"). That is a different payer and a different revenue model, so it passes tests 1 and 2. Kaizen's own structure already names it as one of its three founding divisions. The scheme (Naan Mudhalvan, PMKVY and so on) stays an attribute, so the line does not change when a scheme ends.
- **Research is not in the media line.** T2 joins them with an "if external revenue" caveat. I treat Research as a cost centre (section 4.4).
- **Corporate Learning drops "and Consulting".** Consulting delivery is a shared unit (T2 table). SAP consulting is paid as a technology project, so it lives in Technology Services.
- **Software division is not one line.** Its SAP training slice is paid by enterprises for learning, so it goes to Corporate Learning. The split is told apart by offering (section 6.4).

Rule that decides the boundary cases (PROPOSED): **payer decides the line, beneficiary does not.** Employer pays for its staff to learn: Corporate Learning. A sponsor or CSR donor pays for people who are not its staff: Skill Development, with funding source CSR. A learner pays: Education. A college pays for its students: Education by default, with a funding-source tag of institution (OPEN 6).

### 4.4 Explicit non-lines

| Candidate | Why it fails | Where it lives instead |
|---|---|---|
| Research | No external payer today (T3: demo advisory retainer only). Fails test 1 | Cost centre. If a funder pays (grant, advisory contract), the funded work is tagged to the line that matches its payer, with a funding source |
| Partnerships | A way to reach colleges and employers. Fails test 4 | Channel on leads and opportunities, plus the MoU record. The MoU carries the line(s) it serves through its programmes |
| Telecalling | A team and a source. Fails test 4 | Unit (people), and a channel value (source) |
| Ventures | A portfolio, not a business with one payer | Each venture is a legal entity (tenant). If it sells, it has its own lines. The holding holds an equity stake, not a line |
| Foundation / CSR | Must be a Section 8 company (T2 section 2) | Its own tenant. A funding-source value for the donor side |
| Media & Marketing | Internal marketing serves other lines. Fails test 1 | Shared function (cost centre, allocated by distribution). Becomes a sixth line (code MKT, NIC Division 58/59 range, UNVERIFIED) the day it sells to outside clients |
| Finance, HR, IT/Admin, Leadership | Shared services. Fail tests 1 to 3 | Function units with no line (ACCESS-MODEL-PLAN 2.5) |
| Placement as Education add-on | Different payer and licensing | Not a non-line. It is WFS, see above |
| "Other" | Not a thing | Removed. Unclassified is an explicit empty value that blocks posting (section 8) |
| "Shared" (DIVISIONS value) | A cost pool, not a line | A line distribution (section 6.5), or a function unit |

### 4.5 Old value to new home

| Old value | Source list | New axis | New value |
|---|---|---|---|
| education | VERTICALS | Line | EDU |
| corporate_training | VERTICALS | Line | CLR (but see skill note below) |
| sap_enterprise | VERTICALS | Line, by offering | TEC (SAP consulting); CLR (SAP training) |
| cybersecurity | VERTICALS | Line + unit | TEC, unit "Security practice" |
| software_ai | VERTICALS | Line | TEC |
| placement | VERTICALS | Line | WFS |
| partnerships | VERTICALS | Channel | channel = partnership; the line comes from the programme or offering sold |
| research | VERTICALS | Cost centre | Research cost centre; no line |
| other | VERTICALS | Nothing | Unclassified, resolved by hand during migration |
| software | DIVISIONS | Line | TEC (plus SAP training offerings to CLR) |
| skill | DIVISIONS | Line | SKL |
| education | DIVISIONS | Line | EDU |
| shared | DIVISIONS | Function / allocation | Function units; shared cost uses line distribution |
| enterprise_direct | COMMERCIAL_MOTIONS | Pipeline template, channel | Direct enterprise sales pipeline under CLR or TEC |
| institution_partnership | COMMERCIAL_MOTIONS | Channel | channel = partnership |
| learner_admission | COMMERCIAL_MOTIONS | Pipeline template | Admissions pipeline under EDU |
| workforce_placement | COMMERCIAL_MOTIONS | Pipeline template | Placement pipeline under WFS |
| renewal_expansion | COMMERCIAL_MOTIONS | Pipeline stage or type | A stage type on any pipeline. Not an axis value |

Skill note: `events.ts:41-46` maps the Skill division to corporate_training. That is wrong under the payer rule. Skill division records go to SKL. Existing records that sit under corporate_training for real enterprise buyers stay CLR. This is a manual review, not a rule.

---

## 5. Units per line

Units are tenant data. They are a STARTER template. HR and the founder confirm them in onboarding. This replaces ACCESS-MODEL-PLAN.md section 3. A unit earns its place only if it owns a record set no other unit owns. Record names follow R1 and the access plan (UNVERIFIED where marked there).

| Line | Unit | Records the unit owns | Note |
|---|---|---|---|
| EDU | Telecalling desk | Lead, Interaction, Task | Lead exists with vertical (`main.prisma:1476`); PL-ADMISSION pipeline |
| EDU | Counselling / admissions | Lead, Opportunity, StudentProfile, Enrollment, FeeInstalment (view) | Admissions is a unit, not a line (OPEN 3) |
| EDU | Training delivery | Cohort, Attendance, DailyProgress, LearnerLog, TrainingSession | `Cohort.trainerPartyId`; shared with CLR (see below) |
| EDU | Institutional relations | Mou, Organization, Lead, Opportunity | Partnership channel owner |
| SKL | Mobilisation | Lead, Beneficiary candidate, Interaction | No scheme model yet (access plan 3.2) |
| SKL | Programme delivery | Cohort, Attendance, TrainingSession | Shared delivery pool in practice |
| SKL | Scheme compliance | Claim, evidence, batch reports | Model needed. UNVERIFIED |
| CLR | Corporate sales | Lead, Opportunity, Contract (draft), Organization | PL-ENTERPRISE (`pipelines.ts:45`) |
| CLR | Training delivery (shared pool) | Cohort, TrainingSession, Attendance | Serves EDU, SKL, CLR |
| CLR | SAP training | Cohort, Offering | A unit because its trainers are SAP specialists |
| TEC | Software and AI delivery | Project, Task, Contract (view) | `demoDataset.ts:152` |
| TEC | SAP consulting | Project, Task, timesheet | No consultant model (R1) |
| TEC | Security practice | Engagement, rules of engagement | No model yet. OPEN 2 |
| TEC | Product | Product backlog, release | Appears when a product sells |
| TEC | Technology sales | Lead, Opportunity, Contract | Pipeline per offering |
| WFS | Candidate desk | CandidateProfile, Application, BackgroundVerification, OfferLetter | PL-PLACEMENT (`pipelines.ts:118-150`) |
| WFS | Employer relations | Organization, Requisition, Position, Opportunity | |
| Function (no line) | Marketing, Media | MarketingCampaign, forms, audiences | Line comes from the campaign's target, not the team |
| Function | Finance (receivables, payables, books) | Invoice, Payment, Receipt, VendorBill, bank lines | |
| Function | HR (recruitment, payroll, employee relations) | Requisition, EmploymentRelationship, PayrollRun, LeaveRequest | Payroll its own unit for separation of duties |
| Function | IT / Admin | Assets, tickets, letters, travel | |
| Function | Leadership | Decision, BoardMeeting | Company reach |

Telecalling versus training now reads clearly. Telecalling desk (EDU) owns Lead, Interaction, Task. Training delivery owns Cohort and Attendance. Same line, different record sets, different access. Candidate desk versus Employer relations separates the same way.

Two rules for shared units:

1. A **shared delivery unit** has no line. Its staff placement names the unit. Reach to cohort records is decided by the cohort's own line.
2. Per ACCESS-MODEL-PLAN 2.3, a person can hold several placements. Access = union of placements within one affiliation. The line only picks records. The level sets how far.

---

## 6. Data model (PROPOSED)

### 6.1 Group-level BusinessLine registry

Owner: the holding company (KIPL). Needed so a line has the same ID in every subsidiary once divisions become tenants, and group consolidation by line is possible.

| Field | Rule |
|---|---|
| `id` | Immutable surrogate (UUID). Minted once, never reused. The only thing records reference |
| `code`, `name` | Editable labels. Never a key. Never in document numbers |
| `status` | `active` or `retired`, with `effectiveFrom`, `effectiveTo` |
| `payerKind`, `revenueModel` | Short descriptors stating the test answers from 4.1, for future decisions |
| `nic` | Child table: `(lineId, scheme, code, effectiveFrom, effectiveTo)`. Scheme field allows NIC-2008 and NIC-2025 side by side |
| `successors` | Child table: `(fromLineId, toLineId, effectiveFrom, shareBasisPoints?)` for split and merge. Optional share only where a split has a stated rule |
| `version` | Change log row per edit (who, when, why). Founder approval recorded |

Tenant scope (CLAUDE.md rule 6): the registry is not read across tenants. Each tenant holds a local **LineActivation** row copied from the group registry, keeping the same `id`. A holding pushes updates to a linked subsidiary through the consented link layer (D-01 owner answer). A standalone tenant mints its own IDs and, if it later joins a group, maps them by an explicit one-time reconciliation approved by the founder. Whether the link layer supports this push is UNVERIFIED and part of the D-01 design.

### 6.2 Unit table (tenant-level)

`Unit(id, tenantId, lineId nullable, name, status, effectiveFrom, effectiveTo, ownedRecordTypes, parentUnitId?)`. A unit with `lineId` null is a function unit. A unit may move between lines by closing one row and opening another, never by editing `lineId` in place. Placements point at a unit.

Fits the existing `OrgUnit` (`OrgUnit.division`, `main.prisma:4161`, used by the spin-out walk) and `CostCentre`. Whether Unit extends OrgUnit or sits beside it is a design choice for the build wave. UNVERIFIED which is cleaner.

### 6.3 Other axes get their own tables

- Channel: tenant-managed list; value on Lead, Opportunity, Mou.
- Funding source / scheme: data, not the `FUNDING_SOURCES` constant, with effective dates.
- Cost centre: exists; add a real FK on journal lines (`JournalLine.costCentreId` has no FK today, T3).
- Segment: `ReportingSegment` and `SegmentMapping(segmentId, lineId, effectiveFrom, effectiveTo)`, group-level, accountant-confirmed.

### 6.4 Which records carry the line directly, which derive it

Direct columns replace the free-text strings. Each is a nullable FK to the line's surrogate ID first, then enforced.

| Record | Line | How |
|---|---|---|
| Offering (`main.prisma:1623`) | Direct | The master source. A SAP training offering says CLR; SAP consulting says TEC |
| Course (`:3411`) | Direct | Replaces `division` default `education` |
| Lead (`:1476`) | Direct | Copied from the offering or pipeline at capture. Routing reads it |
| Opportunity (`:1552`) | Direct | Inherited from lead; one line per opportunity, so a mixed deal is split into two opportunities |
| Mou (`:1802`) | Derived | MoU lists the lines it serves through a join table. A single field cannot be true |
| CapabilityClaim (`:1426`), Territory (`:1357`), PipelineDefinition (`:1254`), Grant conditions (`routing.ts:94-97`) | Direct, plural | Replace `vertical`/`appliesToVerticals` strings with line IDs, and gain `unitId` where needed |
| MarketingCampaign / Form (`marketing.prisma:28,406`), audience rules (`audiences.ts:89`) | Direct | Replace strings. Marketing budgets drop the default `education` (`marketing.prisma:583`) |
| Invoice (`:2899`) | Direct at line level | Header may carry a default; the true line sits on invoice lines (an invoice can bill two offerings) |
| Transaction (`:4938`), VendorBill, RecurringRule, FixedAsset, Loan | Line distribution (6.5) | Replaces the single `division` and the manual tags |
| BudgetLine (`:5064`) | Direct | Unique key becomes (tenant, period, category, lineId). A retired line closes, it does not collide |
| LedgerCategory.defaultDivision (`:4896`) | Direct (default line) | A suggestion, not a posting |
| PayrollInstruction (`:4702`) | Derive from placement or cost centre | Payroll groupBy via cost-centre-to-line mapping, with a dated rule |
| OrgUnit.division (`:4161`) | Derived from Unit | Retired |
| JournalLine.division (`compliance-books:108`) | Line distribution plus cost centre | See section 8 |
| Training budget unique(tenant, fy, division), IT portfolio | Direct | Same pattern as BudgetLine |
| EntitySnapshot (`:2587-2613`, P&L by division) | Direct, keyed by lineId and entity | So holding view can group by line |

### 6.5 Line distribution for shared cost

Replaces the single `shared` string. For a shared-cost Transaction, a set of `(transactionId, lineId, basisPoints)` rows must total 10,000 basis points (that is, 100%). Money is bigint paise (CLAUDE.md rule 1). Percentages are integers. The resulting paise per line come from `allocate()` (item 1.6, not yet written). Remainder paise are assigned by a fixed rule so totals always match exactly. No `Math.round`, no float. This mirrors the Odoo analytic distribution map (T1; its Odoo 17 versus 19 timing is UNVERIFIED, so we borrow the idea, not the behaviour).

A default distribution can be stored per cost centre and per ledger category, dated. Changing it never rewrites old transactions.

### 6.6 As-was, restated, and document numbers

- A record keeps the line it was posted with. This is the "as-was" view and the default for every report (T1 section 4).
- A restated view applies the successor table at report time to show history as if the new structure had existed. It is derived, never stored over the original.
- Correcting a wrong tag is a new event, with a reason (T1 section 4). In the accounting path it is a reversal and re-post through `post()`. Only `platform/ledger.ts` writes the journal (CLAUDE.md rule 2).
- Document numbers keep their entity and financial-year series only (`documentNumber.ts:153`).

---

## 7. Change governance

The founder approves every change to the line list. HR and line heads approve unit changes. Every change writes a registry change log row (who, when, why), is audited and emits an event (`assertCan`, write, `auditWrite`, `emit`; CLAUDE.md rule 5). Registry entities must be registered governed entities.

| Change | Founder approval | What the system does | What must be updated | Test |
|---|---|---|---|---|
| ADD | Yes. The 4.1 test is recorded | New ID. Status active from a date. Nothing is backfilled | Pipelines, territories, grants, placements, budgets, marketing audiences, segment mapping (explicit "unmapped" warning until set) | New line appears in selectors with no code change |
| RENAME | Yes | Edits `name` or `code` only. ID unchanged. Change logged | Nothing structural. Labels in reports. Saved audience rules by ID, so no staleness | Routing, history, filters, budgets all unaffected |
| SPLIT | Yes, with a rule for old open items | New IDs for successors. Old line retired on a date. Successor rows written (with shares if stated). Old rows stay as-was | Re-route open leads and opportunities by a stated rule. Re-point territories, pipelines, grants and claims. New budgets per successor. Segment mapping. Access placements are re-confirmed by HR | Old rows keep old ID. New leads route to successors. Restated view totals equal the as-was total |
| MERGE | Yes | New ID (or one survivor). Old lines retired with successor row | Budgets per period consolidated by view, not by rewriting. Pipelines combined or kept | Restated view shows one row. As-was view still shows both. No budget key collision |
| RETIRE | Yes | `effectiveTo` set. Blocks new records, not reads. Open items must be closed or moved first | Placements, territories, grants, campaigns closed | Posting to a retired line fails after its date; history readable |
| MOVE-TO-ENTITY | Founder, plus accountant for legal steps | Line ID unchanged. The line is activated in the new tenant with the same ID. Records move under the spin-out engine (6b). Intercompany handling is a D-01 follow-up | Pipelines, territories, grants, placements recreated in the new tenant. CRM carry-over is a gap (`spinOutEngine.ts:21-22`). `Transaction` needs an entity id | Group view by line shows one line across two tenants before and after the move |

### 7.1 D-01 versus equity-portal 6b (OPEN)

The conflict (T3): DECISIONS D-01 says divisions are not separate tenants, yet equity-portal says subsidiaries grow out of divisions and Phase 6b (not built, `equity-portal.md:658-670`) carries rows into a new tenant. The owner answer on 2026-10-10 reads: a tenant is one legal company, each subsidiary is its own tenant, and divisions are not tenants. This reading is consistent with 6b as the later step that creates a subsidiary tenant from a division.

Recommendation: **a line is not an entity, so both answers work.** If divisions stay inside KIPL, the lines live in one tenant. If they become subsidiaries, each subsidiary tenant activates its lines from the group registry with identical IDs. No data model change is needed in either case. The only requirement is that the registry is group-level and IDs are surrogate. Decide D-01 on its own merits (consolidation, intercompany, subscriptions), not on lines.

---

## 8. Migration from today

### 8.1 Steps

1. **Create the registry and the five lines** with surrogate IDs. Create the old-string-to-line map (section 4.5) as data, kept in the migration log.
2. **Add nullable FK columns** (section 6.4) beside the old string columns. Do not drop the strings yet.
3. **Backfill from the mapping.** Rows with `other`, blank, or ambiguous values go to an explicit review list. HR and the line heads resolve them. Do not default them. Log every backfilled row with the old string, new ID, date and the person who approved. This is a classification of history, not an edit of it, and the log says so.
4. **Dual-read period.** Code reads the FK and falls back to the string only for rows not yet resolved. A check report counts unresolved rows by table.
5. **Enforce.** Once the counts reach zero, make the FKs required where the record must have a line, and drop the strings.
6. **Remove hardcode.** Delete the zod enums (`commercial.routes.ts:106`, `crm.routes.ts:780`, `:958`, `pipeline.routes.ts:92`, `books.routes.ts:54`, `finance.routes.ts:37`, `education.routes.ts:224`), the shared arrays (`domain.ts:9-20`, `finance.ts:19-27`), the web copies (`createForms.tsx:72-77`, `:1261-1270`), the `'other'` fallbacks (`opportunities.ts:117`, `referrals.ts:223`, `capture.ts:480`), the `'sap_enterprise'` defaults (`Forms.tsx:277`, `Leads.tsx:158`), the import parser throw on unknown (`commit.ts:1309-1318`, replaced by a lookup that rejects with a message naming the unknown value), and the fixed `DIVISION_ORDER` (`Executive.tsx:80`, `:348-352`). The web reads the registry through the API. Strings like `channel:vertical` in `ai.ts:152` become ID-based.
7. **Unit and placement data** are created in HR onboarding, not in a migration.

### 8.2 Ledger interaction

`JournalLine.division` exists in the compliance-books schema (line 108) and `JournalLine.costCentreId` has no FK (T3). The ledger item (1.6, then the ledger in Wave 3) must not copy the string. PROPOSED: JournalLine carries `lineId` (FK) and `costCentreId` (FK) from day one. Money fields are bigint paise. Because only `post()` writes the journal, a posting with a line distribution produces one journal line per line with allocated paise. The trial balance must still balance (CLAUDE.md finance-path rule).

### 8.3 Where this sits in ORDERED-PLAN

Per ACCESS-MODEL-PLAN section 10: access compile sits in Wave 6, and vertical columns are independent migrations beside Wave 3.

| When | What |
|---|---|
| Wave 2 | Registry tables, change log, LineActivation, Unit table. Admin API for the founder. Governed-entity registration |
| Wave 2 to 3, before the ledger | FK columns and backfill (6.4) on CRM and education records. Offering, Course, Lead, Opportunity first |
| Wave 3 | Ledger lands with `lineId` and `costCentreId` on JournalLine. Line distribution on Transaction. Budgets re-keyed |
| Wave 3 to 5 | Drop strings, remove hardcode, static check on (section 9) |
| Wave 6 | Access compile reads Unit and Line. Placements point at units. Onboarding questionnaire creates units |

Why before the ledger: adding a line to posted journal lines later means touching immutable rows. The app DB role has no UPDATE or DELETE on them (CLAUDE.md rule 2). The wrong place to find a missing column is after posting starts.

---

## 9. Tests

All run against the real Postgres and the real evaluator (CLAUDE.md: no mocks).

| # | Test | Passes when |
|---|---|---|
| 1 | Rename a line | History, routing, budgets, saved audiences unchanged. Only the label differs |
| 2 | Split a line | New leads route to successors. Old rows keep the old ID. Old open items follow the stated rule. As-was total equals restated total |
| 3 | Merge two lines | Restated view consolidates. As-was view shows both. No budget key collision |
| 4 | Retire a line | New records blocked after the date. History still readable |
| 5 | Move a line to a new tenant | Line ID identical in both tenants. A group view by line shows one line, before and after |
| 6 | Tenant isolation | A subsidiary cannot read another tenant's registry rows. Tenant is from the session (CLAUDE.md rule 6) |
| 7 | Static check: no line literals | No string such as `'education'` or `'sap_enterprise'` in domains or web as a line value. Fails the build |
| 8 | Segment mapping | A dated mapping returns different segments for dates before and after a change. A line with no mapping raises a warning |
| 9 | Distribution | Shares total 10,000 basis points or the write is rejected. Allocated paise sum exactly to the source amount |
| 10 | Document numbers | No line or unit appears in any generated number |
| 11 | Backfill | Every old string maps to a line or sits in the review list. Counts reconcile |
| 12 | Trial balance | After posting with a distribution, the trial balance balances |
| 13 | Governance | Every registry write emits an event with `kz.<domain>.<object>.<verb>` and an audit row |

---

## 10. Open questions for the owner

| # | Question | Where reasonable people disagree | Recommended default |
|---|---|---|---|
| 1 | **SAP placement.** Is SAP a technology matter or a learning matter? | Customer view (T2: Corporate Learning and Consulting) versus technology view | Split by payer. Consulting to Technology Services, training to Corporate Learning, by offering. Avoids one line holding two revenue models |
| 2 | **Cybersecurity.** Its own line or inside Technology Services? | Different delivery and certification (T2) versus adding a line now | A unit inside Technology Services today. Promote to a line when it has its own P&L the founder reviews and a distinct buyer. The registry makes promotion a SPLIT |
| 3 | **Admissions.** Unit or line? | As a unit, costs stay in the line margin. As a line, it looks like a product | Unit in Education. It fails tests 1 and 2 |
| 4 | **Media and Marketing.** Line or shared? | Matters only if it sells externally | Shared function now. Add a line the day outside clients pay |
| 5 | **Research.** | A line only with external revenue (T2) | Cost centre. Funded work tags to the payer's line |
| 6 | **Corporate Learning versus Skill Development for CSR-funded corporate programmes**, and college-paid programmes | The payer is a company but the learners are not its staff. A college pays but students learn | Payer-not-beneficiary rule: CSR-funded programmes for non-staff go to Skill Development. College-paid programmes go to Education with an institution funding tag. Review the first ten cases with the accountant |
| 7 | **Workforce Solutions as its own entity.** | Licence and fee rules argue for separation (T2) | Line now, entity when staffing starts. The registry is entity-neutral, so this costs nothing |
| 8 | **Who is the CODM?** The founder alone, or a committee | Ind AS 108 treats it as a function (T1) | Founder, named in the registry change log. Confirm with the accountant |
| 9 | **Reporting segments.** One segment per line, or aggregated? | Aggregation and thresholds are in the standard, not read here | One segment per line for management. Disclosure grouping decided by the accountant later, through the mapping table |
| 10 | **NIC-2008 versus NIC-2025.** | One snippet says a new version was released (UNVERIFIED) | Store as dated attribute with scheme field. Accountant confirms |
| 11 | **Channel list.** Tenant-managed free list or controlled? | Free list grows messy | Tenant-managed, founder-approved, with merge tool |
| 12 | **Does Unit extend OrgUnit or sit beside it?** | OrgUnit carries `division` and `unitType` | Beside it for now. Retire `OrgUnit.division` at the end of migration |
| 13 | **Group registry reach to a standalone tenant** (future commercialisation) | Not the current aim (CLAUDE.md) | Standalone tenants own their own registry. No group needed |

---

## Unresolved in this draft

- NIC codes: division numbers only, from snippets. Not checked against the MoSPI document.
- Ind AS 108 aggregation and threshold rules: not read. The accountant must confirm.
- Whether the consented link layer (D-01) can push a registry copy to subsidiaries is not designed.
- Several units have no record model today (Security practice, Scheme compliance, SAP consulting). Their record sets above are INFERRED.
- Unit-versus-OrgUnit and CostCentre mapping needs a look at the schema before build.
- Statutory points (GST category per programme, placement licensing) are only flagged and tagged. None is decided here.
