# Zen 360 Phase 1 Master Plan

Oct 23, 2026 · @Kaizen Infinities

## 1. Purpose and how to read this doc

This doc combines three Zen 360 planning files dated 23 Oct 2026 into one Phase 1 master plan: the Phase 1 draft v2 (the spine), the gap list of capabilities missing from the plan ("G" numbers), and the migration connectors. Sections 2 to 11 follow the draft; Appendices A to D carry the gap list and connectors in full.

- **Status codes:** B = Built, P = Partial, Pl = Planned, Pr = Proposed, C = Conflict, D = Deferred, GAP = not in plan.
- **l.** = line in the extracted plan text (Zen 360 Capability plan, 22 Oct 2026).
- **G** = item number in the gap list. Appendix A holds Part 1 (relevant, 91 items); Appendix B holds Part 2 (not relevant, 210 items).
- **Scheduled** (Appendix A) = the sub-phase where this draft uses the G number, or the later-phase row that names it.

## 2. Goal and approach

Applied Corp runs its operations on Zen 360 from Month 1 (April 2027).

- **1A to 1P: general features.** Each sub-phase builds features any services company could use, and none is written only for Applied Corp. They run in priority order.
- **1Z: Applied Corp configuration.** Applied Corp's own setup and rules, applied on top of the general features.
- **Single company.** Phase 1 runs for one company. Tenancy (several companies on one installation) comes in a later phase.
- **Stop rule.** The phase ends at its stop rule (section 9), not at a date (l.10520). April 2027 is the target.

The plan's current Phase 1 sub-phases ("developers can work from home", l.143) are kept, under new letters:

| Current                  | New |
| ------------------------ | --- |
| 1A Approvals             | 1C  |
| 1B Attendance and remote | 1D  |
| 1C Time and projects     | 1K  |
| 1D Delivery              | 1K  |
| 1E Communication         | 1I  |
| 1F Staff expense claims  | 1N  |

## 3. Scope rules

1. **Single company.** No tenant creation, no tenant-isolation work, no subsidiaries in Phase 1.
2. **Staff users only.** The rule "No external users in Phase 0 or 1" stays (l.10549). Learners, guardians, clients, investors and auditors are held as records and served by staff. Auditors use time-bound evidence access (l.1319).
3. **Hosting is in Phase 1.** It is currently Deferred, "after Phase 1" (l.10268). The app runs locally only (l.10557).
4. **Entry condition: Phase 0 closed.** See section 5.
5. **Opening data.** Opening data loads through the existing import engine (l.9566). Migration connectors are not needed in Phase 1.

## 4. Build and review policy

Who does the work depends on how costly a mistake would be. This follows the organisation setting that subagents use Haiku, or Sonnet at low to medium effort, with Opus as orchestrator only.

| Tier   | Who                   | Used for                                                                            |
| ------ | --------------------- | ----------------------------------------------------------------------------------- |
| Build  | Haiku                 | All writing of code, docs, extraction and research                                  |
| Review | Sonnet, fresh context | Reviews every change in a high-stakes area before merge; never reviews its own work |
| Advise | Opus                  | Planning, splitting work, final judgement on disagreements; no hands-on work        |

**High-stakes areas** (from the repo's CLAUDE.md):

1. Money and the ledger: ledger.ts, money.ts, invoicing, payments, refunds
2. Payroll and statutory rules: PF, ESI, PT, TDS, GST and StatutoryRule rows
3. Login, permissions and approvals: permissions.ts, 2FA, sessions, approvals and maker-checker
4. Data access and the audit trail: tenant scoping, audit.ts, row-level security
5. Personal data: DPDP consent, field visibility, anything sent to an AI model
6. Database schema changes: migrations

Everything else (screens, styling, docs, design system) is Haiku-built and checked by CI only.

**How review works**

- Independence: the reviewer gets the change and the rules, not the builder's reasoning.
- Pass or fail: findings must name file and line, or state "no findings".
- Disagreement: Haiku fixes, reviewer re-checks; after two disagreements it goes to Opus, then to the owner in plain language.
- Human review (external penetration test, CA sign-off on statutory tables) is not part of this policy for now; to be revisited before hosting with real data.

## 5. Phase 0 carry-over (entry condition)

| Capability                                                                                       | Now                             | Work                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------- |
| Cashbook to journal cutover; single journal writer for invoice, receipt, credit note and payroll | Pl / C (l.1600, l.1615, l.285)  | Complete. No flow writes legacy Transaction rows. |
| Import commit through the ledger                                                                 | P (l.1677, l.2407)              | Imports post only through `post()`                |
| Money in paise; GST rounding                                                                     | P / C (l.1717, l.1724, l.10380) | Remove float money. Fix rounding.                 |
| Payment approval gate                                                                            | Pl (l.1915)                     | Build                                             |
| Audit force-flag bypass (about 48 sites); hash-chain recomputation                               | C (l.9237, l.10662)             | Close bypasses. Confirm recomputation.            |

## 6. Sub-phases 1A to 1P

Each table is as in the draft. G references carry the gap-list reference in brackets where it adds context. Status codes are in section 1.

### 1A Platform foundation

| Capability                                                                        | Now                                             | Work                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------- |
| Users, level model, starter role templates                                        | P / C (l.1174, l.1156)                          | Ship configurable role templates  |
| Two-factor sign-in; mandatory for privileged roles                                | B / P (l.8929, l.8934)                          | Enforce for privileged roles      |
| Session and credential revocation at exit                                         | C / Pl (l.8946, l.9016)                         | Build                             |
| Field-level security by role                                                      | GAP (G 1.12) \[Salesforce\]                     | Add                               |
| Field-encryption key with no development fallback                                 | P (l.8586)                                      | Remove fallback                   |
| Hosting in an India region, TLS, monitoring                                       | D (l.10268)                                     | Build                             |
| Encrypted backups, unique file names, tested restore                              | P / D (l.9371, l.10719)                         | Build and run a restore drill     |
| Object storage for documents; malware scan                                        | P / Pl / D (l.9539, l.9544, l.9545)             | Replace local disk. Add scanning. |
| Account recovery via a named IT administrator                                     | B (l.8988)                                      | Use as built                      |
| Security logging: CERT-In 6-hour incident record, 180-day logs in India, NTP sync | GAP (G 8.4–8.6) \[CERT-In Directions 2022\]     | Add                               |
| Patch management; security-awareness training records                             | GAP (G 8.2, 8.7) \[ManageEngine; Vanta, Drata\] | Add                               |

### 1B Accounting core

| Capability                                                                                                                                                                                                                            | Now                                                                                                                                                                                                     | Work                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Opening balances through import with control totals; revert by reversal; open-period check                                                                                                                                            | P (l.1341, l.1352, l.1496)                                                                                                                                                                              | Build                                                          |
| Invoices, receipts, final tax invoice                                                                                                                                                                                                 | B (l.1750, l.1758, l.1774)                                                                                                                                                                              | Use as built                                                   |
| One invoice form: course sale as a mode of the invoice editor, with student search, the institution the student came from, tenure and add-on pricing, the live sheet preview, the guardian and age checks and the Kaizen print layout | P (owner request, 23 Oct 2026). Two forms write the same invoices: the editor on `/finance/invoices` and the course-sale screen `/finance/invoices/new`, where the student is typed rather than picked. | Build. Then retire `/finance/invoices/new` and its menu entry. |
| GST rates and SAC as dated rules                                                                                                                                                                                                      | P (l.1998)                                                                                                                                                                                              | Replace hard-coded rates                                       |
| E-invoicing (IRN)                                                                                                                                                                                                                     | P, refuses (l.1993, l.10704)                                                                                                                                                                            | Configure a provider. Stop printing a non-existent IRN or QR.  |
| Credit notes capped at invoice balance                                                                                                                                                                                                | C (l.1852)                                                                                                                                                                                              | Enforce                                                        |
| Payables; vendor bills, refunds and depreciation posted to the journal                                                                                                                                                                | B / P / Pr (l.1952, l.1957, l.1609)                                                                                                                                                                     | Post through `post()`                                          |
| TDS on vendor bills; TDS returns                                                                                                                                                                                                      | B (l.2011, l.2015)                                                                                                                                                                                      | Use as built                                                   |
| GSTR-1/3B from books; GSTR-2B matching                                                                                                                                                                                                | B (l.1970, l.8230)                                                                                                                                                                                      | Use as built                                                   |
| Bank statement import without duplicates; matching with reviewer                                                                                                                                                                      | C / P (l.2103, l.2115)                                                                                                                                                                                  | Fix FX-34. Complete matching.                                  |
| Monthly close checklist; 13-week cash forecast                                                                                                                                                                                        | C (l.2148, l.2134)                                                                                                                                                                                      | Build                                                          |

### 1C Approvals and controls (current 1A)

| Capability                                 | Now                        | Work                                      |
| ------------------------------------------ | -------------------------- | ----------------------------------------- |
| Single approvals inbox; delegation record  | Pl (l.146–172)             | Build                                     |
| Maker-checker; founder exemption classes   | C (l.6651); open (l.10586) | Settle the rule and align tests (l.10655) |
| Money-out approver                         | C (l.2362)                 | One rule with separation of duties        |
| Approval thresholds as configuration       | Open (l.10596)             | Make thresholds configurable              |
| Refunds: atomic, requester is not approver | C (l.1924)                 | Fix                                       |

### 1D People core (current 1B, plus payroll and hiring)

| Capability                                                                 | Now                                                      | Work                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| Employee record, org structure, probation                                  | B                                                        | Use as built                       |
| Recruiting: requisitions, interviews, scorecards                           | B                                                        | Use as built                       |
| Resume parsing; interview scheduling                                       | GAP (G 6.1, 6.2) \[Darwinbox\]                           | Add                                |
| Offers with a conditional state and conditions                             | B offer, GAP conditions                                  | Add the conditional state          |
| Background-verification gate; onboarding tasks for access and assets       | P / C                                                    | Complete                           |
| Leave, accrual job, backup approver in leave chain                         | B / C / P                                                | Schedule accrual. Wire delegation. |
| Attendance derivation job; lateness                                        | P                                                        | Schedule. Store lateness.          |
| Work-from-home requests and policy                                         | Pl (l.173–192, l.3213)                                   | Build                              |
| Holiday calendars per state as dated tables                                | GAP (3 national holidays seeded)                         | Add                                |
| Payroll run with Indian statutory deductions                               | B                                                        | Use as built                       |
| Salary TDS (s.192)                                                         | C (l.8301 vs l.2021)                                     | Settle one rule                    |
| Statutory payables posted to the ledger; run approval rechecked at posting | P (l.2317) / C (l.2309)                                  | Fix                                |
| PF ECR export                                                              | P (l.3468)                                               | Fix NCP days                       |
| PT, LWF, minimum-wage tables per state; per-person floor check             | P (l.8335); GAP (G 6.7) \[TN minimum-wage notification\] | Confirm tables. Add the check.     |
| Code on Wages 50% wage definition                                          | GAP (G 6.6) \[Code on Wages\]                            | Add                                |
| E-signature on employee documents                                          | GAP (G 6.9) \[Darwinbox\]                                | Add                                |
| Full-and-final gated on exit clearance                                     | P                                                        | Gate                               |
| Supervisor-to-report ratio cap as a setting                                | GAP (G 6.12) \[BIBB guidance\]                           | Add                                |

### 1E Compliance and privacy

| Capability                                                                  | Now                                | Work                                             |
| --------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Filing calendar (GST, TDS, PF, ESI, PT, ROC); dates and evidence            | B / P / C (l.8158, l.8175, l.8193) | Confirm dates. Settle evidence.                  |
| Statutory approver and adviser sign-off gate                                | C (l.8097, l.8134)                 | Make the approver configurable. Enable sign-off. |
| Consent ledger and notices; consent enforced across modules                 | B / C (l.8469, l.8480)             | Wire `requiredConsent`                           |
| Data-subject requests                                                       | B (l.8501)                         | Use as built                                     |
| POSH committee and complaints                                               | B (l.8419)                         | Use as built                                     |
| Statutory licence and permit tracking; internal financial controls register | GAP (G 9.5, 9.2)                   | Add                                              |

### 1F Training management

| Capability                                                                   | Now                                         | Work                              |
| ---------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| Catalogue with levels above courses; price lists per organisation            | GAP (l.4934); C (l.4718)                    | Add levels. Separate price lists. |
| Entry assessment with scoring and placement rules                            | GAP (assessment Pr, l.5089)                 | Add                               |
| Programme tracks (e.g. weekday, weekend)                                     | GAP                                         | Add a track model                 |
| Enrolment with enforced status transitions                                   | B / P (l.4760, l.4767)                      | Enforce transitions               |
| Batches with enforced capacity; creation audited                             | P / C (l.4780, l.4789)                      | Enforce capacity setting. Audit.  |
| Timetable and sessions; trainer assignment and substitution                  | C / P / Pr (l.4961, l.4942, l.4948)         | Build                             |
| Attendance audited; no 100% default                                          | P (l.4902, l.4918)                          | Fix                               |
| Completion with a pass mark; progression rules                               | P / Pr (l.4926, l.5084)                     | Add                               |
| Certificates: eligibility gate, verification, revocation, wording controls   | P / C (l.5103, l.5111, l.5128); GAP (G 4.9) | Fix and add                       |
| Fee plans and instalments in exact paise; instalment charges with disclosure | B / P (l.5184, l.5190); GAP (G 3.25)        | Fix rounding. Add charges.        |
| Refund policy as configuration                                               | P (l.4744)                                  | Make configurable                 |
| Learning agreements for employed learners, linked to an offer on completion  | GAP (G 4.13)                                | Add                               |
| Learner concerns: owner, SLA, escalation                                     | P (l.4996)                                  | Fix                               |
| Prospectus disclosures                                                       | GAP (G 4.11)                                | Add                               |
| Enrolment and completion reporting                                           | P (l.5042)                                  | Complete                          |

### 1G Enquiries and CRM

| Capability                                            | Now                            | Work                                                 |
| ----------------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| Lead capture: forms, walk-in and phone intake         | B forms (l.4335); walk-in GAP  | Add walk-in and phone intake                         |
| Lead dedupe                                           | Pr (l.3783)                    | Build                                                |
| Routing, follow-up alert as a setting, backup owner   | B / P (l.3734, l.3758, l.3767) | Make the threshold a setting. Complete backup owner. |
| Source attribution                                    | B (l.4366)                     | Add walk-in source                                   |
| Referral rewards payable through Finance              | P / C (l.4426, l.3968)         | Pay through Finance                                  |
| Accounts, opportunities, price book, quotes, renewals | B                              | Use as built                                         |
| Ad-copy review and testimonial consent                | GAP (G 7.12)                   | Add                                                  |
| Customer CSAT/NPS                                     | GAP (G 7.3)                    | Add                                                  |

### 1H Assets

| Capability                                                                             | Now                                              | Work                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| Asset register, lifecycle, warranty                                                    | B (l.7534, l.7545)                               | Use as built                |
| Issue and return to any person (staff or learner record), condition, proof of delivery | B for staff (l.7551); GAP for non-staff (G 4.12) | Extend to non-staff records |
| Item and serial tracking for issued kits                                               | GAP (G 2.5, 2.8)                                 | Add                         |
| Fixed assets; capital work-in-progress                                                 | B (l.2039); GAP (G 3.21)                         | Add CWIP                    |
| Deposits and advances register; recurring rent payouts                                 | C / B (l.1637, l.1896)                           | Settle register             |

### 1I Communication (current 1E)

| Capability                                                              | Now                 | Work                              |
| ----------------------------------------------------------------------- | ------------------- | --------------------------------- |
| In-app and email notifications                                          | C (l.5999)          | Settle gating. Send.              |
| Shared inbox and company number                                         | C (l.5802)          | Add the model                     |
| Staff mailboxes                                                         | C (l.5811)          | Decide with hosting (l.10740)     |
| Team chat: channels, DMs, mentions; realtime                            | Pl (l.5952, l.5976) | Build                             |
| Service messages (WhatsApp, email) with their own purpose and templates | Pl / Pr (l.5728)    | Build the service path            |
| Single consent source for messaging                                     | C (l.4204, l.4221)  | Use the Compliance consent ledger |

### 1J Governance and equity

| Capability                                                     | Now                     | Work             |
| -------------------------------------------------------------- | ----------------------- | ---------------- |
| Directors, meetings, minutes, resolutions, statutory registers | B (l.6087–6127)         | Use as built     |
| Share register, cap table, rounds, valuations, filings         | B (l.7043–7146, l.7410) | Use as built     |
| ESOP                                                           | B (l.7339)              | Use as built     |
| Board pack; investor updates                                   | C / P (l.6140, l.7448)  | Settle and build |
| NDA records and e-sign                                         | GAP (G 9.7)             | Add              |

### 1K Projects and delivery (current 1C and 1D)

| Capability                                                                     | Now                     | Work                                          |
| ------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------- |
| Contract won gate: signed contract or executed MoU                             | C (l.3539)              | Enforce                                       |
| Project from a won deal with owner and economics                               | P (l.5294, l.5303)      | Build                                         |
| Projects, tasks, sprints                                                       | Pl (l.5544)             | Build                                         |
| Timesheets with project foreign key, billable flag, rate snapshot, period lock | Pl / C (l.5428, l.5431) | Build                                         |
| Rate cards; project templates                                                  | GAP (G 5.1, 5.17)       | Add                                           |
| Allocation calendar; change requests                                           | Pl / Pr                 | Build                                         |
| Customer acceptance as the only billing trigger; milestone billing             | Pl / Pr (l.215, l.5361) | Build. Remove status-click delivery (l.5490). |
| Client SLA and warranty periods                                                | GAP (G 5.12, 5.13)      | Add                                           |

### 1L Subscription billing

| Capability                                         | Now         | Work   |
| -------------------------------------------------- | ----------- | ------ |
| Plans, recurring invoices, renewals, metered usage | Pr (l.2283) | Build  |
| Revenue recognition policy per offering            | C (l.2260)  | Settle |

### 1M Software delivery tooling

| Capability                                                                      | Now               | Work |
| ------------------------------------------------------------------------------- | ----------------- | ---- |
| Git and CI linked to work items; pull-request review with SLA and reviewer load | GAP (G 5.7, 5.8)  | Add  |
| AI first-pass review with human sign-off; open-source licence scanning          | GAP (G 5.9, 5.15) | Add  |

### 1N Expense claims (current 1F)

| Capability                                             | Now            | Work  |
| ------------------------------------------------------ | -------------- | ----- |
| Claim, approve, post through `post()`; receipt storage | Pl (l.246–257) | Build |
| OCR receipt capture                                    | GAP (G 3.4)    | Add   |

### 1O Loans and covenants

| Capability                                                                 | Now          | Work |
| -------------------------------------------------------------------------- | ------------ | ---- |
| External loan register: schedule, guarantee, covenant tracking (DSCR, MIS) | GAP (G 3.19) | Add  |
| Startup tax and recognition calendar (80-IAC, DPIIT)                       | GAP (G 3.23) | Add  |

### 1P Dashboards and budgets

| Capability                                                           | Now                    | Work                  |
| -------------------------------------------------------------------- | ---------------------- | --------------------- |
| KPI readings; KPI library                                            | B / C (l.6715, l.6729) | Settle library        |
| Budget lines and variance; financial plan page fed from real budgets | B / P (l.2075, l.6740) | Replace sample values |
| Ad hoc report builder                                                | GAP (G 1.17)           | Add                   |

## 7. 1Q Interface: Kaizen Glass migration (Proposed, owner to confirm)

**Why.** apps/web runs the KaiERP design system (Tailwind tokens, Archivo and IBM Plex Sans, light-only, left sidebar in components/Shell.tsx). Kaizen Glass (root DESIGN.md and design/tokens.css, PR #99) is the target.

- Footprint: about 3,150 token-class uses in 133 of 166 screen files.
- ui.tsx is imported by 134 files; DataTable by 38.
- No screenshot tests.
- Lighthouse accessibility gate of 95 or more.
- scripts/check-tailwind-tokens.mjs enforces the current tokens.

| Stage                        | When                                                                                               | Work                                                                                                                                                                                                    | Exit check                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stage 1 Foundation           | Alongside Phase 0 close and 1A (frontend-only, no backend conflict)                                | Decide colour-meaning map (accent, gold, division colours, primary button). Map Kaizen tokens into tailwind.config.js and the token guard. Self-host Poppins and Archivo. Restyle ui.tsx and DataTable. | Token guard and Lighthouse 95 or more pass. Every new 1A to 1P screen built on the new tokens. |
| Stage 2 Shell and navigation | With 1C Approvals (the toolbar's Approvals and Requests tabs depend on the single approvals inbox) | Replace sidebar Shell with desktop toolbar and phone bottom capsule. Settle D-39 (left rail vs capsule) and tab names (Modules vs Go). Update e2e nav selectors.                                        | e2e and browser smoke pass                                                                     |
| Stage 3 Sweep and dark mode  | After 1P, before 1Z                                                                                | Restyle remaining screens. Fix hard-coded colours (118 in 9 files). True-black dark mode. Glass contrast on dense finance tables.                                                                       | Lighthouse 95 or more in light and dark. Contrast check on ledger tables.                      |

1Q is not in the stop rule unless the owner adds it (see section 9 and decision 10).

### 1Q usability requirements (owner request, 23 Oct 2026)

Routine work should take the fewest possible steps. Speed never removes a control: approvals, maker-checker, 2FA and the journal rules stay as they are.

**Principles**

1. Click budget. Every routine task has a maximum number of steps, checked by an end-to-end test that counts interactions. A screen change that exceeds its budget fails CI.
2. Act where you see it. Approve, reject, assign and record from the list row or from Home, without opening the record first. Bulk actions where safe, within the bulk-approve limit once D-35 is settled.
3. Smart defaults. Forms prefill from context (current cohort, project, student, client) and from the user's last entry. Routine entries become confirmations.
4. Keyboard first. The Go palette (Ctrl+K) runs actions, not only navigation ("new invoice", "approve leave"). Tally F-keys in Finance and mnemonics elsewhere (D-36). Every action is reachable without a mouse.
5. Undo over confirm. Reversible actions act at once and offer Undo. Confirmation is kept for irreversible or money-moving actions; posted journal entries are corrected only by reversal.
6. Home shows today. Each person's Home lists only what needs them today, each item with its action button.
7. Phone one-handed. Approvals and Requests are one tap from the bottom capsule. Money-out approval needs a deliberate tap, never a swipe.
8. Plain forms. Fewer fields, more shown only when needed, inline validation, Indian formats (₹ with lakh grouping, IST dates).

**Initial click budgets (to confirm with users before Stage 2)**

| Routine task                                       | Budget (steps from Home)     |
| -------------------------------------------------- | ---------------------------- |
| Approve or reject one pending item                 | 1 (2 with a required reason) |
| Request leave or work-from-home                    | 3                            |
| Log today's timesheet (copy from yesterday)        | 2                            |
| Mark a session's attendance                        | 2 plus exceptions            |
| Record a walk-in or phone enquiry                  | 3                            |
| Raise an invoice for an existing student or client | 4                            |
| Record a receipt against an invoice                | 3                            |
| Submit an expense claim with receipt               | 4                            |

**Macros, staged**

- Stage A, templates and saved routines: recurring invoices, copy-last timesheet, saved filters and views, preset checklists such as month-end close and new-cohort setup.
- Stage B, user-built macros: a sequence of actions saved and run with one command. Linked to the unscheduled visual workflow builder (G 1.3); planned with it, after 1Z.
- Guard for both stages: a macro prepares work; it never posts a journal entry, pays, runs payroll, files a return or emails a customer without human approval (repo CLAUDE.md "Never" list). Every macro run is audited like any other write.

**Where each lands in 1Q**

| 1Q stage                     | Usability work                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Stage 1 Foundation           | Click-budget test harness; row actions and Undo in the shared table and components                 |
| Stage 2 Shell and navigation | Go palette actions and shortcuts; Home of today's actions; one-tap Approvals and Requests on phone |
| Stage 3 Sweep and dark mode  | Smart defaults on routine forms; Stage A templates and saved routines; all budgets passing         |

## 8. 1Z Applied Corp configuration

| Configuration                                                                                                                                               | Uses       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Company setup: entity profile (GSTIN, PAN, TAN, Udyam, DPIIT); opening balances, share register and staff loaded with control totals                        | 1A, 1B, 1J |
| Role templates: facilitator, centre manager, assessor/HR, sysadmin, Labs senior, developer, finance, founder; named IT administrator and statutory approver | 1A, 1E     |
| Approval thresholds and founder exemption classes                                                                                                           | 1C         |
| Tamil Nadu payroll tables, holiday calendar, working-hours rules                                                                                            | 1D         |
| studyApplied catalogue: tiers T1 to T6 with fees incl. GST; weekday, full-day and weekend tracks; cohort size 12                                            | 1F         |
| Entry assessment content and placement rules                                                                                                                | 1F         |
| Instalment charges (3%, 5%, 8%) and the studyApplied refund rule                                                                                            | 1F         |
| Learning agreement for full-day trainees; T5 completion triggers a Labs conditional offer and 3-month probation                                             | 1F, 1D     |
| Tablet kit issued on entry to T2 and above, returned and reissued                                                                                           | 1H, 1F     |
| Kaizen referral reward (₹2,000 per enrolment)                                                                                                               | 1G         |
| Applied Labs price book, rate cards and SaaS plans                                                                                                          | 1G, 1K, 1L |
| Labs senior ratio (1 per 5 graduates)                                                                                                                       | 1D         |
| KPIs matched to the DPR dashboard                                                                                                                           | 1P         |

## 9. Stop rule (exit criteria)

**General features (1A to 1P)** pass on a hosted installation:

1. **Ledger.** Opening balances load with control totals that tie to the paisa. All flows post through `post()`. No float money.
2. **Approvals.** Every money-out, refund and payroll run needs a second person. An ungranted approver gets 403 and state does not change. The 24-hour absence test passes.
3. **Recovery.** An encrypted backup restores on a clean host and passes check 1.
4. **Security and privacy.** 2FA is enforced for privileged roles. Consent is checked on messaging. Security logs are retained as required.
5. **Existing exits.** The current sub-phase exit tests pass under their new letters.

**Applied Corp configuration (1Z)** passes on Applied Corp's data:

6. **Training cycle.** One full cycle runs:
   - enquiry, then entry assessment, placement, enrolment and invoice with instalments
   - cohort and sessions, attendance, assessment, certificate
   - progression to the next tier
   - for a T5 completer, a conditional Labs offer
   - a tablet kit issued and returned
7. **Payroll.** One Tamil Nadu payroll passes:
   - statutory deductions computed from confirmed tables
   - the floor check
   - posting with the run approval rechecked
   - ECR and ESI files that validate
8. **Delivery.** One Labs deal goes from quote to signed contract to project. Its timesheets are invoiced after customer acceptance.
9. _Proposed:_ **Interface.** 1Q stages 1 to 3 exits pass before 1Z sign-off.

## 10. Later phases

| Item                 | Notes                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy              | Several companies on one installation, tenant creation, forced RLS proven on every tenant table, tenant-leakage fuzzer (l.10420) |
| Multiple entities    | City subsidiaries, consolidation, intercompany (C, l.2183)                                                                       |
| Year-end             | Schedule III statements, tax audit report (Form 3CD), GSTR-9C (G 3.9, 3.22, 3.6)                                                 |
| Client-work finance  | 26AS/AIS reconciliation, WIP write-downs, utilisation targets (G 3.7, 10.1.4, 10.1.6)                                            |
| Business planning    | Plan writer, forecasts and investor sharing (G 11.x); annual budget by division (Pl, Phase 8)                                    |
| Learner insight      | At-risk flags, alumni (G 4.1, 10.3.10)                                                                                           |
| Staff augmentation   | Client cost sheets and submissions (G 10.1.10)                                                                                   |
| Migration connectors | Appendix C (Proposed, no phase set)                                                                                              |
| Portals              | Learner and client portals (D, l.10266)                                                                                          |

## 11. Decisions needed before Phase 1 starts

1. Hosting provider and India region; staff mailboxes (l.10740).
2. Founder exemption classes and approval thresholds (l.10586, l.10596).
3. Named IT administrator and statutory approver (l.10593, l.8097).
4. E-invoicing scope and provider (l.10608).
5. studyApplied refund rule: non-refundable, or pro-rata (pending).
6. How referral rewards are paid: the commission engine (C, l.3968) or a plain payable.
7. The plan's open question "Feature 1 audience: internal first or a sellable product" (l.10629).
8. _Proposed:_ Kaizen Glass colour-meaning map (section 7, Stage 1).
9. _Proposed:_ Navigation model D-39 and tab names (section 7, Stage 2).
10. _Proposed:_ Whether 1Q enters the stop rule (section 9, check 9).

11) Build and review policy — decided 23 Oct 2026 (see Build and review policy section; decision D-48).

12. _Proposed:_ Click budgets for routine tasks: confirm the initial table in section 7 with staff before 1Q Stage 2.

## Appendix A. Gap list Part 1: relevant to Applied Corp (91)

**Source:** Kaizen Infinities "Zen 360 Capability plan", 22 Oct 2026 (1,376 capabilities). Each item is absent from the plan under every status. Line numbers (l.) refer to the extracted plan text. Item numbers keep the numbering of the full list.

**How relevance was decided (verified 23 Oct 2026).**

- An operating profile of Applied Corp was compiled from the project docs, mainly the DPR decisions log.
- Every item was then classified against that profile by independent reviewers, and disagreements were resolved against the profile.
- **Relevant** means the profile shows Applied Corp doing the activity the capability supports, now or in its stated plans.
- Activities the docs mark "not in docs" or "not decided" are classed **not relevant**. Examples are overseas clients and export, NBFC lending, minors, online checkout, named office-software suites (Google Workspace, Microsoft 365), the accounting standard (Ind AS) and CGTMSE. Such items move to Part 1 if those decisions change.

**Profile basis:**

- studyApplied in-person tiered training: entry assessment, cohorts, facilitators, certificates, in-house fee instalments with charges, tablet kits issued and returned.
- Full-day trainees employed under learning agreements, with a Labs offer on T5 completion.
- Applied Labs: SaaS products, client projects, staff augmentation.
- Structure and premises: Madurai HQ with consolidated Tamil Nadu city subsidiaries and 51% product spin-outs; leased premises with fit-out, VDI server and IT equipment.
- Funding: MSME, START and city loans; equity rounds, ESOP and 80-IAC/DPIIT.
- Planning: DPR with lender, investor and schemes annexes; 10-year scenario model.
- Payroll in Tamil Nadu only; marketing and admissions services from Kaizen.

**LivePlan (section 11).** Features were verified on LivePlan's own pages (liveplan.com, help.liveplan.com). Break-even, valuation tools, dividends, multi-currency and separate startup/ongoing templates were not found on LivePlan's pages and are excluded.

**Split.** Part 1, relevant to Applied Corp: 91. Part 2, not relevant: 210. Total: 301. Slack integration is excluded: Zen360's own team chat (Messages, "Team chat and voice", l.5944–6027) covers channels, DMs, mentions, voice/video and tasks from messages.

**Scheduled** = the sub-phase where section 6 uses the G number, or the later-phase row (section 10) that names it. **Unscheduled** = neither.

### 1 Platform and technical (6)

| #    | Capability                                                   | Reference                    | Nearest in plan                           | Scheduled   |
| ---- | ------------------------------------------------------------ | ---------------------------- | ----------------------------------------- | ----------- |
| 1.2  | Custom fields and custom objects per tenant                  | Salesforce, Zoho             | none                                      | Unscheduled |
| 1.3  | Visual workflow builder                                      | Zoho Creator, Power Automate | Approval chains (l.525)                   | Unscheduled |
| 1.12 | Field-level security by role                                 | Salesforce                   | Field encryption (l.10025)                | 1A          |
| 1.16 | Self-service full tenant data export                         | —                            | Per-report CSV export                     | Unscheduled |
| 1.17 | Ad hoc report builder                                        | —                            | Fixed analytics plus CSV (l.3370)         | 1P          |
| 1.21 | Multi-language UI, including Tamil and right-to-left scripts | —                            | Tamil message templates (Planned, l.5773) | Unscheduled |

### 2 Procurement, stock and facilities (5)

| #    | Capability                                                  | Reference   | Nearest in plan                | Scheduled   |
| ---- | ----------------------------------------------------------- | ----------- | ------------------------------ | ----------- |
| 2.1  | RFQ and competitive sourcing                                | SAP S/4HANA | Purchase request (l.10191)     | Unscheduled |
| 2.4  | Price catalogues and blanket POs                            | —           | IT vendor contracts (l.7624)   | Unscheduled |
| 2.5  | Item and SKU master                                         | NetSuite    | Pantry stock ledger (l.3200)   | 1H          |
| 2.8  | Serial-number tracking for goods                            | NetSuite    | IT asset serials (l.7571)      | 1H          |
| 2.17 | Planned maintenance and meters for facilities and equipment | Oracle EAM  | IT device maintenance (l.1434) | Unscheduled |

### 3 Finance, accounting and tax (9)

| #    | Capability                                                               | Reference                               | Nearest in plan                  | Scheduled                  |
| ---- | ------------------------------------------------------------------------ | --------------------------------------- | -------------------------------- | -------------------------- |
| 3.4  | OCR receipt capture for expenses                                         | SAP, Odoo                               | Expense claim (l.246)            | 1N                         |
| 3.6  | GSTR-9C reconciliation                                                   | GST                                     | GSTR-9 (l.8171)                  | Later: Year-end            |
| 3.7  | TDS credit reconciliation against 26AS/AIS                               | Income-tax                              | Form 16 (l.2016)                 | Later: Client-work finance |
| 3.9  | Schedule III statement formats                                           | Companies Act                           | Financial statements (l.7276)    | Later: Year-end            |
| 3.19 | Bank covenant tracking: DSCR, stock/book-debt statements, MIS, CMA       | Bank term loans                         | none                             | 1O                         |
| 3.21 | Capital work-in-progress                                                 | —                                       | Fixed assets (l.2036)            | 1H                         |
| 3.22 | Tax audit report (Form 3CD)                                              | Income-tax s.44AB                       | Income tax (l.8066)              | Later: Year-end            |
| 3.23 | 80-IAC (Form 10CCB) and DPIIT compliance calendar                        | Income-tax, DPIIT                       | GST compliance calendar (l.1984) | 1O                         |
| 3.25 | Fee instalment ledger with finance charges, disclosures and cancellation | CFPB v. BloomTech (disclosure failures) | Fee instalments (l.5184)         | 1F                         |

### 4 Academy and learning (9)

| #    | Capability                                                                                                                                 | Reference                                            | Nearest in plan                               | Scheduled              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------- | ---------------------- |
| 4.1  | At-risk / dropout flags with a follow-up workflow                                                                                          | Learning-analytics practice                          | none                                          | Later: Learner insight |
| 4.4  | Learner portfolio, performance scoring and work-based assessment mapped to competencies                                                    | UK Software Developer L4 assessment plan; Andela LMS | Competency claims, staff only (l.2493)        | Unscheduled            |
| 4.5  | Training-hours ledger linked to evidence, splitting learning time from work time                                                           | UK off-the-job hours rule                            | Training hours "not measured" (l.3364)        | Unscheduled            |
| 4.6  | Wellbeing check-ins and workload caps for learners who also work                                                                           | —                                                    | Staff wellbeing channel (l.3199)              | Unscheduled            |
| 4.9  | Certificate wording controls and awarding-body (NCVET) affiliation record                                                                  | NCVET                                                | Certificates (l.3098)                         | 1F                     |
| 4.11 | Prospectus disclosures: tutor qualifications, curriculum, fees, refund policy, outcomes                                                    | MoE Coaching Guidelines 2024                         | Course catalogue (l.4742)                     | 1F                     |
| 4.12 | Proof-of-delivery log for learner materials and devices                                                                                    | Consumer-court refund orders                         | Staff asset inventory (l.3286)                | 1H                     |
| 4.13 | Learning agreements for employed learners, with fees kept separate from payroll, and conditional offer letters linked to course completion | —                                                    | Fee instalments (l.5184); HR letters (l.3256) | 1F                     |
| 4.19 | Employer feedback on placed learners                                                                                                       | TeamLease, Year Up                                   | none                                          | Unscheduled            |

### 5 Projects, PSA and delivery (15)

| #    | Capability                                                            | Reference                  | Nearest in plan                    | Scheduled   |
| ---- | --------------------------------------------------------------------- | -------------------------- | ---------------------------------- | ----------- |
| 5.1  | Rate cards by role or grade                                           | PSA tools                  | Billing basis (l.3563)             | 1K          |
| 5.2  | Earned value (SPI, CPI)                                               | —                          | Milestone variance (l.5508)        | Unscheduled |
| 5.3  | Gantt charts, critical path and dependency scheduling                 | ClickUp, MS Project        | Dependencies field (l.5360)        | Unscheduled |
| 5.4  | Project-level profitability, including per-hour margin                | PSA tools                  | Implementation budgets (l.5377)    | Unscheduled |
| 5.5  | RAID log for projects                                                 | —                          | IT risk register (l.7753)          | Unscheduled |
| 5.6  | Real-time document co-editing                                         | —                          | Document store (l.10721)           | Unscheduled |
| 5.7  | Git and CI linked to work items                                       | Jira, Azure DevOps         | Internal GitHub workflows (l.9917) | 1M          |
| 5.8  | Pull-request code review: review SLA, reviewer routing, reviewer load | Google eng-practices       | Code-review note (l.2446)          | 1M          |
| 5.9  | AI first-pass code review and progress summaries, with human sign-off | GitHub Copilot, CodeRabbit | Agent framework only               | 1M          |
| 5.10 | Remote pair-programming support                                       | —                          | none                               | Unscheduled |
| 5.11 | Cloud dev environments and sandbox or synthetic test data             | GitHub Codespaces, Gitpod  | none                               | Unscheduled |
| 5.12 | Client SLA tracking for project delivery                              | —                          | IT service-desk SLA (l.7657)       | 1K          |
| 5.13 | Warranty and defect-liability periods                                 | —                          | IT asset warranty (l.7559)         | 1K          |
| 5.15 | Open-source licence scanning for deliverables                         | —                          | Dependency licence report (l.9903) | 1M          |
| 5.17 | Reusable project templates                                            | Asana, Monday, Jira        | Project hierarchy (l.5551)         | 1K          |

### 6 People and payroll (8)

| #    | Capability                                                       | Reference                    | Nearest in plan                   | Scheduled   |
| ---- | ---------------------------------------------------------------- | ---------------------------- | --------------------------------- | ----------- |
| 6.1  | Resume parsing                                                   | Darwinbox                    | Candidate records (l.2713)        | 1D          |
| 6.2  | Interview scheduling with calendar slots                         | Darwinbox                    | Interview rounds (l.2713)         | 1D          |
| 6.3  | Geo-fenced or selfie mobile attendance                           | greytHR                      | Biometric import (l.2868)         | Unscheduled |
| 6.5  | Labour Code compliance, named (Code on Wages and the 2020 codes) | greytHR                      | Labour compliance (l.3227)        | Unscheduled |
| 6.6  | Wage definition under the 50% rule                               | Code on Wages                | none                              | 1D          |
| 6.7  | Minimum-wage floor check per person, by zone and category        | TN minimum-wage notification | One general category (l.8335)     | 1D          |
| 6.9  | E-signature on employee documents                                | Darwinbox                    | Document templates (l.8864)       | 1D          |
| 6.12 | Supervisor-to-report ratio cap and visible mentor load           | BIBB guidance                | "Span of control" metric (l.3358) | 1D          |

### 7 Sales, marketing and service (3)

| #    | Capability                                                                          | Reference                     | Nearest in plan          | Scheduled   |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------ | ----------- |
| 7.3  | Customer CSAT and NPS scoring                                                       | Freshdesk                     | Staff eNPS (l.3147)      | 1G          |
| 7.4  | Customer-facing chatbot (web, WhatsApp)                                             | —                             | AI agents (l.83)         | Unscheduled |
| 7.12 | Ad-copy review, claim substantiation, disclaimer prominence and testimonial consent | CCPA coaching guidelines 2024 | Claims register (l.4464) | 1G          |

### 8 Security and IT (7)

| #   | Capability                                                                 | Reference               | Nearest in plan                           | Scheduled   |
| --- | -------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- | ----------- |
| 8.2 | Patch management                                                           | ManageEngine            | "Patch obligations" (l.1452)              | 1A          |
| 8.3 | Data-leak prevention and endpoint monitoring                               | —                       | Remote gateway (Conflict), MDM (Proposed) | Unscheduled |
| 8.4 | SIEM / central security logging, with logs kept 180 days in India          | CERT-In Directions 2022 | Hash-chained audit log (l.10336)          | 1A          |
| 8.5 | CERT-In incident reporting within 6 hours                                  | CERT-In Directions 2022 | Breach workflow (l.7859)                  | 1A          |
| 8.6 | Clock sync to NIC/NPL NTP servers                                          | CERT-In Directions 2022 | none                                      | 1A          |
| 8.7 | Phishing simulation and security-awareness training                        | Vanta, Drata            | none                                      | 1A          |
| 8.8 | Per-client/per-project data separation, with access removed at project end | ISO 27001 A.8.30        | Exit-time access removal (l.3453)         | Unscheduled |

### 9 Governance and compliance (3)

| #   | Capability                                                         | Reference                 | Nearest in plan                    | Scheduled |
| --- | ------------------------------------------------------------------ | ------------------------- | ---------------------------------- | --------- |
| 9.2 | Internal financial controls testing                                | Companies Act s.134(5)(e) | Maker-checker (l.155)              | 1E        |
| 9.5 | Statutory licence and permit tracking (Shops Act, labour licences) | —                         | Software licence register (l.1418) | 1E        |
| 9.7 | NDA management and e-signature                                     | —                         | Contract approval (l.3499)         | 1J        |

### 10.1 IT/ITeS, BPO/KPO, staffing and professional services (3)

| #       | Capability                                                         | Benchmark / rule          | Nearest in plan          | Scheduled                  |
| ------- | ------------------------------------------------------------------ | ------------------------- | ------------------------ | -------------------------- |
| 10.1.4  | WIP write-downs and realisation tracking                           | Accounting practice tools | none                     | Later: Client-work finance |
| 10.1.6  | Utilisation and billable-hour targets by grade                     | BigTime                   | none                     | Later: Client-work finance |
| 10.1.10 | Staffing: client cost sheets and candidate submissions with margin | Ceipal                    | Own hiring only (l.2695) | Later: Staff augmentation  |

### 10.3 Education and research (3)

| #       | Capability                                          | Benchmark / rule | Nearest in plan             | Scheduled              |
| ------- | --------------------------------------------------- | ---------------- | --------------------------- | ---------------------- |
| 10.3.5  | Timetable and room allocation                       | IIT-H spec       | Partial (l.4961)            | Unscheduled            |
| 10.3.10 | Alumni engagement                                   | IIT-H spec       | Alumni status only (l.4846) | Later: Learner insight |
| 10.3.23 | Course registration, electives and faculty workload | IIT-H spec       | Enrolment (l.4880)          | Unscheduled            |

### 11 Business planning, LivePlan benchmark (20)

| #     | Capability                                                        | Benchmark                                     | Nearest in plan                                    | Scheduled                |
| ----- | ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- | ------------------------ |
| 11.1  | Guided business-plan writer with section prompts and examples     | LivePlan Business Plan Builder                | none                                               | Later: Business planning |
| 11.2  | One-page pitch builder                                            | LivePlan                                      | none                                               | Later: Business planning |
| 11.3  | Pitch deck creator                                                | LivePlan                                      | Investor updates (Planned, l.6667)                 | Later: Business planning |
| 11.4  | Market research reports in the plan                               | LivePlan                                      | none                                               | Later: Business planning |
| 11.5  | Forecast by revenue stream                                        | LivePlan forecasting                          | Annual budget by division (l.2081)                 | Later: Business planning |
| 11.6  | Direct costs linked to revenue streams                            | LivePlan forecasting                          | Shared-cost keys (l.2422)                          | Later: Business planning |
| 11.7  | Industry benchmarks for forecasts                                 | LivePlan pricing page ("Industry benchmarks") | External pay benchmarks only (l.3032)              | Later: Business planning |
| 11.8  | Advisor and accountant access to plans                            | LivePlan "Work with Partners"                 | Access grants (l.1124)                             | Later: Business planning |
| 11.9  | Lender-ready plan and projected statements (bank DPR/CMA format)  | LivePlan lender-ready reports                 | Statutory exports (l.2368)                         | Later: Business planning |
| 11.10 | Investor sharing links for plans                                  | LivePlan pitch deck and one-page pitch links  | Investor updates register (l.7448)                 | Later: Business planning |
| 11.12 | Debt service coverage (DSCR) table and margin charts on forecasts | LivePlan cash-flow forecast                   | none                                               | Later: Business planning |
| 11.15 | Idea canvas / idea validation for new products                    | LivePlan                                      | none                                               | Later: Business planning |
| 11.21 | Themes (branding) for plan documents                              | LivePlan plan themes                          | none                                               | Later: Business planning |
| 11.22 | AI forecast builder (AI drafts the financial forecast)            | LivePlan "Help Me Forecast"                   | 13-week cash forecast (l.2134)                     | Later: Business planning |
| 11.23 | AI review of a business plan, section by section                  | LivePlan AI Plan Review                       | none                                               | Later: Business planning |
| 11.24 | Milestone planner for a plan (dates, owners, budgets)             | LivePlan milestones                           | Initiative record (l.5591)                         | Later: Business planning |
| 11.25 | Forecast version history and restore                              | LivePlan forecast versions                    | As-of snapshots (l.6654)                           | Later: Business planning |
| 11.26 | Plan document version history and import of an existing plan      | LivePlan plan import                          | Versioned document templates (l.6508)              | Later: Business planning |
| 11.27 | Import of an existing forecast from a spreadsheet                 | LivePlan forecast import                      | Tally/Excel import for ledger and HR data (l.9587) | Later: Business planning |
| 11.28 | Connector for external AI assistants (MCP)                        | LivePlan MCP Connector                        | Internal agents only (l.1292)                      | Later: Business planning |

**Count of Unscheduled in Part 1: 25** (1.2, 1.3, 1.16, 1.21, 2.1, 2.4, 2.17, 4.4, 4.5, 4.6, 4.19, 5.2, 5.3, 5.4, 5.5, 5.6, 5.10, 5.11, 6.3, 6.5, 7.4, 8.3, 8.8, 10.3.5, 10.3.23).

## Appendix B. Gap list Part 2: not relevant to Applied Corp (210)

Items in this part are absent from the plan and judged not relevant to Applied Corp under the rules in Appendix A. Item 1.25 is covered by the migration connectors in Appendix C, now set as Proposed, Later phase.

### 1 Platform and technical (18)

| #    | Capability                                                                                                                                                                                                               | Reference                         | Nearest in plan                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1.1  | Low-code app and form builder                                                                                                                                                                                            | Zoho Creator, Odoo Studio         | Lead forms (l.4335)                                                                                       |
| 1.4  | Public REST/GraphQL API with developer docs                                                                                                                                                                              | Zoho Developer API                | Internal admin API (l.1128)                                                                               |
| 1.5  | Tenant API keys and developer self-service                                                                                                                                                                               | Zoho                              | Rate limits on forms and login only                                                                       |
| 1.6  | Integration marketplace or app directory                                                                                                                                                                                 | Odoo Apps, Salesforce AppExchange | Connectors (l.9770)                                                                                       |
| 1.7  | Google Workspace integration (Gmail, Calendar, Drive)                                                                                                                                                                    | —                                 | Google Ads adapter (l.4660)                                                                               |
| 1.8  | Microsoft 365 integration (Outlook, Teams, Calendar)                                                                                                                                                                     | —                                 | none                                                                                                      |
| 1.10 | iPaaS or no-code integration builder (mapping, transforms, retries)                                                                                                                                                      | SAP Integration Suite             | Connectors (l.9770)                                                                                       |
| 1.11 | SCIM 2.0 user provisioning                                                                                                                                                                                               | Enterprise security checklists    | SSO "not evidenced" (l.7592)                                                                              |
| 1.13 | IP allowlisting for tenant admins                                                                                                                                                                                        | —                                 | none                                                                                                      |
| 1.14 | Sandbox or staging tenants for customers                                                                                                                                                                                 | Zoho developer environments       | Demo tenant (l.1153)                                                                                      |
| 1.15 | Configuration export and promotion between environments                                                                                                                                                                  | Power Platform ALM                | none                                                                                                      |
| 1.18 | Embedded BI for external use                                                                                                                                                                                             | —                                 | Lead-form embed (l.4336)                                                                                  |
| 1.19 | Native iOS and Android apps                                                                                                                                                                                              | —                                 | Mobile capture (Deferred, l.2429)                                                                         |
| 1.20 | Offline and low-bandwidth mode                                                                                                                                                                                           | —                                 | none                                                                                                      |
| 1.22 | Statutory packs for countries other than India                                                                                                                                                                           | —                                 | Tamil Nadu state rules (l.8399)                                                                           |
| 1.23 | Public status page and contractual uptime SLA                                                                                                                                                                            | —                                 | Status page "not built" (l.1402)                                                                          |
| 1.24 | White-labelling: custom domain, logo and theme per tenant                                                                                                                                                                | —                                 | none                                                                                                      |
| 1.25 | Direct migration connectors for major suites (SAP, NetSuite, Dynamics, Zoho, Salesforce, HubSpot, Odoo, QuickBooks, Busy, Marg, Keka, greytHR, Darwinbox) and imports for CRM history, projects, tickets and attachments | Vendor migration tools            | Tally XML and spreadsheet templates only (l.9587, l.9597). Covered by Appendix C (Proposed, Later phase). |

### 2 Procurement, stock and facilities (12)

| #    | Capability                                      | Reference      | Nearest in plan                |
| ---- | ----------------------------------------------- | -------------- | ------------------------------ |
| 2.2  | Vendor self-service portal                      | —              | IT vendor register (l.7624)    |
| 2.3  | Vendor performance scorecards                   | ERPNext        | IT vendor risk rating (l.7626) |
| 2.6  | Bin locations within warehouses                 | NetSuite       | "Warehouse" (Proposed, l.1388) |
| 2.7  | Batch and lot tracking                          | NetSuite       | none                           |
| 2.9  | Expiry dates and first-expiry-first-out picking | NetSuite       | none                           |
| 2.10 | Stock valuation (FIFO, weighted average)        | —              | none                           |
| 2.11 | Reorder points and safety stock                 | NetSuite       | none                           |
| 2.12 | Returns and RMA                                 | Odoo           | none                           |
| 2.13 | Landed cost                                     | NetSuite       | none                           |
| 2.14 | Barcode and RFID scanning                       | Zoho Inventory | none                           |
| 2.15 | Drop-shipping                                   | NetSuite       | none                           |
| 2.16 | Import and customs (HS codes, duty)             | —              | E-way bill (Deferred, l.8253)  |

### 3 Finance, accounting and tax (16)

| #    | Capability                                                                                                                                        | Reference                           | Nearest in plan             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------- |
| 3.1  | Treasury: cash pooling, investments, FX exposure                                                                                                  | NetSuite                            | Cash-flow forecast (l.2420) |
| 3.2  | RBI Account Aggregator bank-data feeds                                                                                                            | RBI AA framework                    | Bank feed (l.2380)          |
| 3.3  | Lease accounting (Ind AS 116)                                                                                                                     | Ind AS 116                          | Fixed assets (l.2036)       |
| 3.5  | Corporate cards and card-feed reconciliation                                                                                                      | —                                   | Expense claim (l.246)       |
| 3.8  | XBRL filing of financial statements                                                                                                               | MCA                                 | AOC-4/MGT-7 (l.8170)        |
| 3.10 | Export-of-services invoice checks (IGST s.2(6)) and LUT tracking                                                                                  | IGST Act                            | Zero-rated exports (l.8254) |
| 3.11 | Export Declaration Form (EDF, replacing SOFTEX from 1 Oct 2026) and e-FIRA records                                                                | RBI FEMA 23(R)/2026-RB              | none                        |
| 3.12 | Export-proceeds realisation deadline per invoice                                                                                                  | FEMA                                | FIRC sweep (l.8636)         |
| 3.13 | Forms 15CA/15CB for outward foreign payments                                                                                                      | Rule 37BB                           | none                        |
| 3.14 | Post-dated cheque management                                                                                                                      | —                                   | none                        |
| 3.15 | Letters of credit and bank guarantees                                                                                                             | —                                   | none                        |
| 3.16 | Inventory costing and COGS                                                                                                                        | —                                   | Inventory (l.1333)          |
| 3.17 | Expected credit loss provisioning (Ind AS 109)                                                                                                    | Ind AS 109                          | Receivables ageing (l.1950) |
| 3.18 | Borrowings accounting (effective interest)                                                                                                        | Ind AS 109                          | none                        |
| 3.20 | CGTMSE guarantee tracking                                                                                                                         | CGTMSE                              | none                        |
| 3.24 | Lending-partner (NBFC EMI) controls: Key Fact Statement, cooling-off, no handling of loan funds, subvention reconciliation, refunds to the lender | RBI Digital Lending Directions 2025 | EMI calculator (l.1728)     |

### 4 Academy and learning (10)

| #    | Capability                                                                               | Reference                    | Nearest in plan                         |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------- |
| 4.2  | Parent and sponsor progress view                                                         | —                            | Guardian access (l.4825)                |
| 4.3  | Spaced revision scheduling                                                               | Spaced-practice research     | none                                    |
| 4.7  | Counsellor and distress-intervention records; helpline display                           | MoE Coaching Guidelines 2024 | none                                    |
| 4.8  | Safeguarding records for learners under 18                                               | —                            | Minor consent gate (l.8488)             |
| 4.10 | Programme-approval status that gates enrolment and invoicing                             | California BPPE v. Holberton | Programme versions (l.4735)             |
| 4.14 | Aadhaar biometric attendance (AEBAS) import and tranche gating                           | Naan Mudhalvan, PMKVY        | Biometric punch import (l.2868)         |
| 4.15 | Placement evidence store (offer letter plus salary slip) and tranche calculator          | Naan Mudhalvan               | Placement outcome record (l.5064)       |
| 4.16 | Scheme batch scheduler with size caps and filing deadlines                               | Naan Mudhalvan, TNSDC        | Batch capacity "never checked" (l.4780) |
| 4.17 | CSR funding records: CSR-1 agency, utilisation certificates, impact baseline and endline | CSR Rules r.4                | Charitable status (l.2032)              |
| 4.18 | Placement data export for third-party audit, with a fixed denominator                    | Scaler/B2K                   | Placement records (l.3987)              |

### 5 Projects, PSA and delivery (2)

| #    | Capability                                                   | Reference | Nearest in plan                                 |
| ---- | ------------------------------------------------------------ | --------- | ----------------------------------------------- |
| 5.14 | SBOM generation                                              | —         | Code provenance register (l.9935)               |
| 5.18 | Billable work by interns and trainees, billed by their hours | —         | "Billable amounts derived from work" (Proposed) |

### 6 People and payroll (4)

| #    | Capability                                   | Reference    | Nearest in plan                      |
| ---- | -------------------------------------------- | ------------ | ------------------------------------ |
| 6.4  | Salary advance                               | —            | Employee loans (l.3014)              |
| 6.8  | Gratuity for fixed-term staff                | Labour Codes | Gratuity accrual (l.8358)            |
| 6.10 | Multi-country payroll and employer of record | Rippling     | Multi-currency (l.1741)              |
| 6.11 | DEI and pay-equity analytics                 | Workday      | Gender ratio "not measured" (l.3364) |

### 7 Sales, marketing and service (9)

| #    | Capability                                                                                        | Reference                     | Nearest in plan                    |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------- |
| 7.1  | CPQ product configurator, constraint rules and bundles                                            | Salesforce CPQ                | Quotes with discount gate (l.3611) |
| 7.2  | Field service scheduling and work orders                                                          | Dynamics 365 Field Service    | none                               |
| 7.5  | Account-based marketing                                                                           | —                             | Segmentation (l.4170)              |
| 7.6  | E-commerce storefront and checkout                                                                | —                             | Price book (l.3589)                |
| 7.7  | Loyalty points and tiers                                                                          | —                             | Referral rewards (l.4419)          |
| 7.8  | Landing-page builder                                                                              | —                             | Lead-capture forms (l.4083)        |
| 7.9  | SEO tooling                                                                                       | —                             | none                               |
| 7.10 | IVR phone menus                                                                                   | —                             | Telephony (Planned, l.5897)        |
| 7.11 | Checkout controls against dark patterns: one total price, no pre-ticked add-ons, no false urgency | Dark Patterns Guidelines 2023 | Add-ons as own line (l.4707)       |

### 8 Security and IT (1)

| #   | Capability                       | Reference                | Nearest in plan         |
| --- | -------------------------------- | ------------------------ | ----------------------- |
| 8.1 | CMDB for ITSM change and problem | ServiceNow, ManageEngine | Asset register (l.7534) |

### 9 Governance and compliance (5)

| #   | Capability                                           | Reference           | Nearest in plan               |
| --- | ---------------------------------------------------- | ------------------- | ----------------------------- |
| 9.1 | Internal audit management: plan, findings, follow-up | Companies Act s.138 | Admin audit-log page (l.1310) |
| 9.3 | Whistleblower / vigil mechanism                      | Companies Act s.177 | none                          |
| 9.4 | Litigation and case management                       | —                   | Legal hold (Deferred, l.8861) |
| 9.6 | ESG/BRSR reporting                                   | SEBI BRSR           | none                          |
| 9.8 | Insurance policy register (PI, cyber, D&O)           | —                   | none                          |

### 10.1 IT/ITeS, BPO/KPO, staffing and professional services (11)

| #       | Capability                                                       | Benchmark / rule          | Nearest in plan                  |
| ------- | ---------------------------------------------------------------- | ------------------------- | -------------------------------- |
| 10.1.1  | Independence register and restricted-list checks (audit firms)   | Practice-management tools | none                             |
| 10.1.2  | Client-money (trust/escrow) ledger with three-way reconciliation | Law practice tools        | none                             |
| 10.1.3  | Retainer drawdown against prepaid balance                        | Law/consulting tools      | Billing basis label (l.3563)     |
| 10.1.5  | Partner profit allocation (lockstep, origination/billing credit) | Law/accounting tools      | Commission engine (l.4067)       |
| 10.1.7  | CPE/CPD credit tracking for professionals                        | ICAI (sr)                 | none                             |
| 10.1.8  | Client document requests                                         | Accounting practice tools | none                             |
| 10.1.9  | Per-client statutory filing calendar and e-file deadlines        | CA practice tools         | Own compliance calendar (l.8158) |
| 10.1.11 | Onsite/offshore cost-plus billing (ODC)                          | BigTime; ODC billing (sr) | Rate snapshot (l.201)            |
| 10.1.12 | BPO metrics: AHT, occupancy, first-contact resolution            | Verint (sr)               | none                             |
| 10.1.13 | Call-quality audit scorecards                                    | BPO QA tools (sr)         | Plan avoids recording (l.241)    |
| 10.1.14 | HIPAA/PCI client-contract attestations                           | Verint (sr)               | SOC 2 / DPDP mapping (l.7783)    |

### 10.2 Healthcare and wellness (25)

| #       | Capability                                          | Benchmark / rule          | Nearest in plan         |
| ------- | --------------------------------------------------- | ------------------------- | ----------------------- |
| 10.2.1  | OPD appointments and token queue                    | Practo Ray (sr)           | none                    |
| 10.2.2  | Doctor roster and slot booking                      | Practo Ray (sr)           | Staff shifts            |
| 10.2.3  | EMR/EHR visit records                               | ABDM                      | none                    |
| 10.2.4  | e-Prescription (coded, FHIR R4)                     | ABDM                      | none                    |
| 10.2.5  | Lab orders, LIS, sample tracking                    | KareXpert                 | none                    |
| 10.2.6  | Radiology RIS/PACS                                  | KareXpert                 | none                    |
| 10.2.7  | IPD admission/discharge and bed management          | KareXpert                 | none                    |
| 10.2.8  | OT scheduling                                       | KareXpert                 | none                    |
| 10.2.9  | Cath lab, daycare, emergency workflows              | KareXpert                 | none                    |
| 10.2.10 | Diet, CSSD and clinical housekeeping                | KareXpert                 | none                    |
| 10.2.11 | TPA receivables                                     | KareXpert                 | Scheme claim (l.2230)   |
| 10.2.12 | Insurance pre-authorisation at the front desk       | NHCX                      | none                    |
| 10.2.13 | NHCX FHIR claims                                    | NHCX                      | Scheme claims (l.5259)  |
| 10.2.14 | PM-JAY claims                                       | NHA                       | none                    |
| 10.2.15 | Package billing                                     | NHCX package mapping      | none                    |
| 10.2.16 | IP/ER/daycare billing                               | KareXpert                 | none                    |
| 10.2.17 | Doctor revenue share and payouts                    | KareXpert                 | Vendor payouts (l.1893) |
| 10.2.18 | Schedule H1 drug register                           | Drugs and Cosmetics Rules | none                    |
| 10.2.19 | Prescription-gated H1 dispensing                    | Drugs and Cosmetics Rules | none                    |
| 10.2.20 | Clinical consent forms                              | ABDM                      | DPDP consent (l.8480)   |
| 10.2.21 | ABHA creation and care-context linking              | ABDM                      | none                    |
| 10.2.22 | ABDM health-data consent grant/revoke               | ABDM                      | none                    |
| 10.2.23 | Telemedicine                                        | KareXpert (sr)            | none                    |
| 10.2.24 | Class booking and capacity (wellness, gyms)         | Mindbody (sr)             | none                    |
| 10.2.25 | Biomedical waste records; NABH controlled documents | BMW Rules 2016; NABH (sr) | none                    |

### 10.3 Education and research (20)

| #       | Capability                                                          | Benchmark / rule           | Nearest in plan                 |
| ------- | ------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| 10.3.1  | Admission merit lists from entrance scores                          | IIT Hyderabad ERP spec     | Admissions (l.4800, partial)    |
| 10.3.2  | Fee concessions, quotas, scholarships (RTE 25%, NSP)                | RTE Act; NSP (sr)          | "No concession model" (l.4801)  |
| 10.3.3  | Semester results, grade sheets, transcripts                         | IIT-H spec                 | Generic assessment (l.5087)     |
| 10.3.4  | Online exam proctoring                                              | —                          | none                            |
| 10.3.6  | SCORM/xAPI conformance and learning record store                    | Standards (sr)             | LMS without SCORM (l.5194)      |
| 10.3.7  | Hostel allotment and mess                                           | IIT-H spec                 | none                            |
| 10.3.8  | Transport routes with GPS tracking                                  | IIT-H spec                 | none                            |
| 10.3.9  | Library catalogue and circulation                                   | —                          | none                            |
| 10.3.11 | Anti-ragging and student grievance (UGC)                            | UGC regulations (sr)       | none                            |
| 10.3.12 | DigiLocker / NAD certificate push                                   | NAD (PIB)                  | Verification (Conflict, l.5122) |
| 10.3.13 | ABC credit upload, APAAR ID, multiple entry/exit (NCrF)             | UGC / PIB                  | none                            |
| 10.3.14 | Sponsored-project accounts: UC/SE, PFMS upload, interest remittance | DST grant conditions       | none                            |
| 10.3.15 | Grant-funded asset ownership and disposal approval                  | DST grant conditions cl. 6 | Fixed assets (l.2039)           |
| 10.3.16 | Lab and instrument booking with calibration                         | IIT-H spec                 | Venue reservation (l.1382)      |
| 10.3.17 | Publications, citations and bibliometrics (NAAC/NIRF)               | NAAC/NIRF (sr)             | none                            |
| 10.3.18 | Patent and trademark portfolio tracking                             | —                          | Search only (l.6904)            |
| 10.3.19 | Ethics approvals, thesis and PhD tracking                           | —                          | none                            |
| 10.3.20 | Incubatee cohorts and milestones                                    | —                          | Investees only (l.7518)         |
| 10.3.21 | AISHE, UDISE+ and NAAC/AQAR data exports                            | AQAR (sr)                  | AISHE code only (l.5143)        |
| 10.3.22 | UGC/AICTE/CBSE approvals and affiliations register                  | —                          | none                            |

### 10.4 Financial services intermediaries and real estate (24)

| #       | Capability                                               | Benchmark / rule    | Nearest in plan              |
| ------- | -------------------------------------------------------- | ------------------- | ---------------------------- |
| 10.4.1  | Customer KYC, including video KYC                        | PMLA / SEBI         | Director KYC only (l.8170)   |
| 10.4.2  | Sanctions and PEP screening                              | AML practice        | none                         |
| 10.4.3  | Transaction monitoring and STR reporting to FIU-IND      | PMLA                | none                         |
| 10.4.4  | AMFI ARN trail-commission tracking                       | AMFI                | none                         |
| 10.4.5  | IRDAI POSP commission disclosure and caps                | IRDAI               | Internal rev-share (l.3968)  |
| 10.4.6  | Policy renewal and lapse tracking                        | LeadSquared (sr)    | Contract renewal (l.3515)    |
| 10.4.7  | Insurance claims assistance                              | —                   | none                         |
| 10.4.8  | Loan origination                                         | Salesforce FSC (sr) | none                         |
| 10.4.9  | Loan servicing and customer EMI schedules                | Salesforce FSC (sr) | Employee loans (l.3015)      |
| 10.4.10 | Collections field app                                    | —                   | none                         |
| 10.4.11 | NPA / days-past-due classification                       | RBI NBFC norms (sr) | none                         |
| 10.4.12 | Borrower grievance redress (Fair Practices Code)         | RBI FPC             | HR grievances (l.3157)       |
| 10.4.13 | Mutual fund SIP and folio management                     | —                   | none                         |
| 10.4.14 | Sub-broker / stockbroking back office                    | —                   | none                         |
| 10.4.15 | Property unit inventory and booking                      | Sell.Do (sr)        | none                         |
| 10.4.16 | Construction-stage payment schedules                     | Sell.Do (sr)        | Services milestones (l.2264) |
| 10.4.17 | RERA project registration and quarterly progress reports | RERA                | none                         |
| 10.4.18 | RERA 70% escrow tracking                                 | RERA s.4(2)(l)(D)   | none                         |
| 10.4.19 | Stamp duty and sale-deed registration tracking           | —                   | Share stamp duty (l.7411)    |
| 10.4.20 | Tenant lease management                                  | Yardi, MRI (sr)     | none                         |
| 10.4.21 | Rent invoicing and escalation                            | Yardi, MRI (sr)     | none                         |
| 10.4.22 | CAM charge allocation                                    | —                   | none                         |
| 10.4.23 | Property maintenance tickets                             | Facilio (sr)        | HR helpdesk (l.3156)         |
| 10.4.24 | Visitor management                                       | Nexudus (sr)        | Event check-in (l.4432)      |

### 10.5 Hospitality, travel and logistics (26)

| #       | Capability                                                | Benchmark / rule      | Nearest in plan                         |
| ------- | --------------------------------------------------------- | --------------------- | --------------------------------------- |
| 10.5.1  | Room inventory and rate plans                             | Hotelogix             | Training venues (l.1382)                |
| 10.5.2  | Channel manager / OTA sync                                | Hotelogix             | none                                    |
| 10.5.3  | Front-desk check-in and guest folio                       | —                     | none                                    |
| 10.5.4  | Housekeeping                                              | —                     | none                                    |
| 10.5.5  | Form C for foreign guests (within 24h) and guest register | FRRO                  | none                                    |
| 10.5.6  | Restaurant POS with KOT                                   | Petpooja (sr)         | none                                    |
| 10.5.7  | Table reservations                                        | —                     | none                                    |
| 10.5.8  | Recipe costing                                            | —                     | none                                    |
| 10.5.9  | Banquet and event booking                                 | —                     | Training venues (l.1382)                |
| 10.5.10 | Guest loyalty                                             | —                     | none                                    |
| 10.5.11 | GST hotel room-tariff slabs (5% / 18% by unit-day value)  | GST, from 22 Sep 2025 | Generic GST table (l.8259)              |
| 10.5.12 | Itinerary builder                                         | —                     | Travel request, "no itinerary" (l.1461) |
| 10.5.13 | Hotel/airline supplier contracts and allotments           | —                     | none                                    |
| 10.5.14 | Booking amendments and cancellations                      | Hotelogix             | none                                    |
| 10.5.15 | TCS on overseas tour packages (s.206C(1G))                | Income-tax            | TDS only (l.10444)                      |
| 10.5.16 | IATA BSP settlement, ADM/ACM                              | IATA (sr)             | none                                    |
| 10.5.17 | Fleet GPS tracking                                        | LogiNext              | none                                    |
| 10.5.18 | Route optimisation                                        | LogiNext              | none                                    |
| 10.5.19 | Proof of delivery                                         | LogiNext              | none                                    |
| 10.5.20 | Driver app                                                | LogiNext              | none                                    |
| 10.5.21 | Fuel and vehicle maintenance logs                         | LogiNext              | none                                    |
| 10.5.22 | Shipment tracking for customers                           | LogiNext              | Internal shipments (l.1388)             |
| 10.5.23 | FASTag integration                                        | —                     | none                                    |
| 10.5.24 | Vehicle permits and fitness renewals                      | Motor Vehicles Act    | none                                    |
| 10.5.25 | Driver hours-of-service                                   | LogiNext              | none                                    |
| 10.5.26 | FSSAI licence records                                     | FSSAI                 | none                                    |

### 10.6 Retail and trade, media and agencies, nonprofits (23)

| #       | Capability                                             | Benchmark / rule                | Nearest in plan                   |
| ------- | ------------------------------------------------------ | ------------------------------- | --------------------------------- |
| 10.6.1  | POS billing with offline mode                          | Ginesys                         | none                              |
| 10.6.2  | Multi-store stock view                                 | Ginesys                         | none                              |
| 10.6.3  | Marketplace order sync (Amazon, Flipkart, Shopify)     | Ginesys, Unicommerce (sr)       | none                              |
| 10.6.4  | Omnichannel returns                                    | Unicommerce (sr)                | none                              |
| 10.6.5  | Gift cards and e-vouchers                              | Ginesys                         | none                              |
| 10.6.6  | Distributor/dealer trade schemes and claims            | Ginesys                         | Beneficiary scheme claim (l.2230) |
| 10.6.7  | Beat planning for field sales reps                     | (sr)                            | none                              |
| 10.6.8  | E-commerce TCS (CGST s.52) reconciliation to GSTR-8/2B | GST                             | E-invoice only (l.1993)           |
| 10.6.9  | Legal Metrology MRP and package declarations           | Legal Metrology Rules           | none                              |
| 10.6.10 | Creative job tickets and job costing                   | Function Point, Workamajig (sr) | Billing basis (l.5444)            |
| 10.6.11 | Estimates vs actuals per creative job                  | (sr)                            | Scope-change estimate (l.5365)    |
| 10.6.12 | Media planning and buying                              | (sr)                            | none                              |
| 10.6.13 | Insertion orders                                       | (sr)                            | none                              |
| 10.6.14 | Donor CRM: donors, pledges, appeals                    | Salesforce Nonprofit Cloud (sr) | Donor report (l.6290)             |
| 10.6.15 | 80G donation receipts                                  | Income-tax                      | Status field (l.2032)             |
| 10.6.16 | Form 10BD donor statement and 10BE certificates        | Income-tax                      | none                              |
| 10.6.17 | Recurring giving                                       | (sr)                            | none                              |
| 10.6.18 | Programme indicators and M&E                           | (sr)                            | Outcome reporting (l.6290)        |
| 10.6.19 | Volunteer management                                   | (sr)                            | none                              |
| 10.6.20 | FCRA foreign-contribution ledger                       | FCRA                            | none                              |
| 10.6.21 | FC-4 annual return                                     | FCRA                            | none                              |
| 10.6.22 | NGO Darpan unique ID capture                           | MHA                             | none                              |
| 10.6.23 | CSR-2 reporting                                        | Companies Act                   | CSR tax status (l.2032)           |

### 11 Business planning, LivePlan benchmark (4)

| #     | Capability                       | Benchmark                   | Nearest in plan                  |
| ----- | -------------------------------- | --------------------------- | -------------------------------- |
| 11.14 | Sample plans library             | LivePlan (550+ plans)       | none                             |
| 11.16 | Plan review and coaching service | LivePlan                    | Approvals inbox (l.146)          |
| 11.19 | QuickBooks / Xero sync           | LivePlan                    | Tally import (l.2374)            |
| 11.29 | Multilingual plan documents      | LivePlan multilingual plans | Tamil messaging wording (l.5771) |

**Notes (from the gap list).**

- Matching was by keyword. Items marked Conflict in the plan were counted as in the plan.
- Some benchmark references come from search results the agents did not open.
- The research could not confirm two points: whether the MoE Coaching Guidelines apply to skill centres, and whether the FEMA realisation period is 9 or 15 months.

## Appendix C. Migration connectors

This section adds connectors that read data directly from other accounting, HR and payroll, CRM, support, project and ERP suites, and map it into Zen360 tenants. It extends the existing import engine (l.9566) and the migration items (l.1333 to l.1352); it does not replace them. All rows below are Proposed and carry no phase until one is set.

### Table A. Migration framework

| Area              | Capability                                                                                                                                                                           | Status   | Phase  | Evidence                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Framework         | Connector framework with one adapter interface for file adapters and API adapters; every adapter feeds the existing parse, detect, classify, extract and preview-before-write stages | Proposed | To set | Extends l.9566                                                                                                   |
| Framework         | Adapter versioned per source; each batch records the adapter version used, so a change in a source's format does not alter earlier batches                                           | Proposed | To set | Extends l.9566                                                                                                   |
| Source connection | Per-tenant source credentials held in a secrets vault, never stored in import batches, logs or staging                                                                               | Proposed | To set | Depends on l.10034                                                                                               |
| Source connection | Read-only scopes requested from the source; connection refused if write scopes are granted                                                                                           | Proposed | To set | Extends l.9566                                                                                                   |
| Source connection | Regional endpoint chosen per tenant for each source (for example zohoapis.in for Zoho India accounts)                                                                                | Proposed | To set | https://www.zoho.com/books/api/v3/                                                                               |
| Source connection | Consent record: who authorised the connection, scopes granted, date, and revocation date                                                                                             | Proposed | To set | Extends l.1333                                                                                                   |
| Extraction        | Rate-limit-aware extraction: HTTP 429 handling, Retry-After honoured, exponential back-off                                                                                           | Proposed | To set | https://developer.atlassian.com/cloud/jira/platform/rate-limiting/                                               |
| Extraction        | Per-source daily quota budgeting; extraction plan shows estimated requests against the tenant's plan limit before it starts                                                          | Proposed | To set | https://www.zoho.com/books/api/v3/                                                                               |
| Extraction        | Resumable checkpoints with paging and continuation tokens, so an interrupted extraction continues without re-reading completed pages                                                 | Proposed | To set | https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-rate-limits |
| Staging           | Sealed raw staging snapshot of extracted data, with content hash and row counts per entity                                                                                           | Proposed | To set | Extends l.9566, l.1352                                                                                           |
| Staging           | Data profiling of the snapshot: blank, duplicate and invalid values per field, before mapping                                                                                        | Proposed | To set | Extends l.1333                                                                                                   |
| Mapping           | Pre-built mapping templates per source, applied on connection and editable per tenant                                                                                                | Proposed | To set | Extends l.9587                                                                                                   |
| Mapping           | Field mapping screen with name matching, manual override and mapping version saved with the batch                                                                                    | Proposed | To set | Extends l.9587                                                                                                   |
| Mapping           | Value mapping for tax codes, GST rates, voucher types, picklists, leave types, salary components and ticket statuses                                                                 | Proposed | To set | Extends l.9587                                                                                                   |
| Mapping           | Chart-of-accounts mapping from source ledgers to Zen360 accounts, with unmapped ledgers listed as errors                                                                             | Proposed | To set | Extends l.1333                                                                                                   |
| Mapping           | Custom-field mapping from source custom fields to tenant custom fields                                                                                                               | Proposed | To set | Depends on custom fields per tenant (gap list; not in plan)                                                      |
| Mapping           | User and owner mapping from source users to Zen360 users, for record ownership and assignment                                                                                        | Proposed | To set | Extends l.9587                                                                                                   |
| Mapping           | Dedupe across sources, with each decision and exclusion recorded                                                                                                                     | Proposed | To set | Extends l.1333                                                                                                   |
| Identity          | External source ID kept on every record, with relationships between records preserved                                                                                                | Proposed | To set | Extends l.9566                                                                                                   |
| Loading           | Dependency-ordered loading: taxes, contacts and items before bills, invoices and other documents                                                                                     | Proposed | To set | https://www.zoho.com/books/kb/general/migration-import-data.md                                                   |
| Loading           | Opening balances posted on a single opening-balance date and tied to the source trial balance                                                                                        | Proposed | To set | https://www.zoho.com/books/kb/general/migration-import-data.md; Extends l.1352                                   |
| Loading           | Open items (unpaid invoices and bills, open deals and tickets) loaded as live records; closed items loaded as history-only                                                           | Proposed | To set | Extends l.1352                                                                                                   |
| Loading           | Attachments and documents migrated with a configurable size limit; files over the limit listed in the rejected-row report                                                            | Proposed | To set | Extends l.9566                                                                                                   |
| Verification      | Control totals: record counts, amount sums, trial-balance tie-out and payroll year-to-date tie-out                                                                                   | Proposed | To set | Extends l.1341                                                                                                   |
| Verification      | Reconciliation report comparing source totals with Zen360 totals per entity                                                                                                          | Proposed | To set | Extends l.1341, l.1347                                                                                           |
| Parallel run      | Delta sync by modified date during the parallel run, with changes applied in batches and logged in the discrepancy log                                                               | Proposed | To set | Extends l.1347                                                                                                   |
| Cutover           | Rollback by reversal entries instead of hard delete, with an open-period check before reversal                                                                                       | Proposed | To set | Extends l.9578, l.1352, l.1496                                                                                   |
| Audit             | Batch provenance in the audit chain: source, extraction time, mapping version and operator                                                                                           | Proposed | To set | Extends l.9600                                                                                                   |
| Data protection   | DPDP controls: minimum fields extracted, purpose recorded per batch, staging purged after cutover sign-off, storage in India region                                                  | Proposed | To set | Extends l.9566                                                                                                   |
| Workspace         | Migration workspace with checklist, owners, issue log and sign-offs                                                                                                                  | Proposed | To set | Extends l.1333, l.1352                                                                                           |
| Workspace         | Time-bound access for an outside consultant, limited to the migration workspace and expiring on a set date                                                                           | Proposed | To set | Extends l.1333                                                                                                   |

### Table B. Source adapters

| Area                      | Capability                                                                                                                                                                                                                                            | Status   | Phase  | Evidence                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounting                | TallyPrime: extend the existing XML import with JSON over HTTP via TDL for masters, vouchers and reports                                                                                                                                              | Proposed | To set | https://help.tallysolutions.com/json-based-export-import/ ; Extends l.9587                                                                                  |
| Accounting                | Zoho Books (India): API at zohoapis.in with OAuth; 30 requests per minute and 1,000 to 10,000 per day by plan. Opening balance date must match                                                                                                        | Proposed | To set | https://www.zoho.com/books/api/v3/ ; https://www.zoho.com/books/kb/general/migration-import-data.md                                                         |
| Accounting                | Zoho Books file fallback: CSV, XLS and XLSX module exports, capped at 25,000 rows per export; full backup available once per 15 days. Import order: taxes, contacts, items, then bills and invoices                                                   | Proposed | To set | https://www.zoho.com/in/books/help/import-export/export.md ; https://www.zoho.com/in/books/kb/documents/backup-data.html                                    |
| Accounting                | QuickBooks Online: REST API, 500 requests per minute per company, at most 1,000 entities per query, batch of 30 payloads                                                                                                                              | Proposed | To set | https://static.developer.intuit.com/output\_html/qbo/docs/learn/limits-and-throttles.html                                                                   |
| Accounting                | QuickBooks Desktop: file adapter for IIF list exports. Transactions are not exportable as IIF, so they come from report exports; payments need relinking                                                                                              | Proposed | To set | https://quickbooks.intuit.com/learn-support/en-us/help-articles/export-or-import-intuit-interchange-format-iif-files/00/262337                              |
| Accounting                | Busy Accounting: file adapter for Excel and CSV report exports; no public API found                                                                                                                                                                   | Proposed | To set | https://busy.in/faqs/data-conversion/other-software                                                                                                         |
| Accounting                | Marg ERP 9+: file adapter for Excel and CSV exports, masters before vouchers; no official documentation or API found (third-party source)                                                                                                             | Proposed | To set | https://univik.com/blog/marg-to-busy-data-transfer-options.html                                                                                             |
| Accounting                | Odoo: JSON-2 API at /json/2/\<model>/\<method> with bearer API key; keys expire within three months; requires the Odoo Custom plan. XML-RPC and JSON-RPC are deprecated for removal in Odoo 20                                                        | Proposed | To set | https://www.odoo.com/documentation/19.0/developer/reference/external\_api.html                                                                              |
| HR and payroll            | Keka: OAuth API limited to 50 requests per minute; endpoints for employee, payroll register, full-and-final settlement and Form 16                                                                                                                    | Proposed | To set | https://developers.keka.com/docs/rate-limit                                                                                                                 |
| HR and payroll            | greytHR: Employee API using access ID and secret, plus an Excel file adapter                                                                                                                                                                          | Proposed | To set | https://greythr-api-docs.readthedocs.io/en/latest/overview.html                                                                                             |
| HR and payroll            | Zoho People API: 250 calls per user, 5,000 to 25,000 per day by plan. Zoho Payroll history import is limited to the current financial year, so a mid-year migration loads current-FY year-to-date earnings and TDS                                    | Proposed | To set | https://www.zoho.com/people/api/api-limits.html ; https://www.zoho.com/in/payroll/kb/general/how-many-years-prior-payroll.html                              |
| HR and payroll            | Darwinbox: master API at {subdomain}.darwinbox.in/masterapi with API key or OAuth; access is granted on request from Darwinbox                                                                                                                        | Proposed | To set | https://api-docs.darwinbox.com/view/metadata/SWDzg2Pp                                                                                                       |
| HR and payroll            | SAP SuccessFactors: file-based extraction preferred; SAP states its APIs are not designed for high-volume extraction                                                                                                                                  | Proposed | To set | https://userapps.support.sap.com/sap/support/knowledge/en/2516640                                                                                           |
| HR and payroll            | Workday: REST and SOAP with throttling (429) and extract caps per 24 hours and per 60 minutes; paged results are cached for two hours                                                                                                                 | Proposed | To set | https://doc.workday.com/admin-guide/en-us/manage-workday/tenant-configuration/it-administrator-resources/limitations-and-availability/dan1370797408285.html |
| CRM, support and projects | Salesforce: Bulk API 2.0 query jobs, limited to 10,000 jobs and 1 TB of results per 24 hours; results are deleted after 7 days                                                                                                                        | Proposed | To set | https://developer.salesforce.com/docs/atlas.en-us.230.0.api\_bulk\_v2.meta/api\_bulk\_v2/bulk\_api\_2\_limits.htm                                           |
| CRM, support and projects | HubSpot: CRM API at 100 to 190 requests per 10 seconds by tier, plus CSV export (300 exports per 24 hours). Associations truncate at 1,000 unless "all associated records" is chosen; calls and notes are not in record exports, so they come via API | Proposed | To set | https://knowledge.hubspot.com/import-and-export/export-records ; https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines            |
| CRM, support and projects | Zoho CRM: bulk read of 200 records per request; daily API credits per organisation by edition                                                                                                                                                         | Proposed | To set | https://www.zoho.com.cn/crm/help/api/api-limits.html                                                                                                        |
| CRM, support and projects | Freshdesk: API with per-minute limits by plan (for example Growth 100 per minute, ticket list 40 per minute)                                                                                                                                          | Proposed | To set | https://support.freshdesk.com/support/solutions/articles/225439                                                                                             |
| CRM, support and projects | Jira Cloud: REST API under a points-based limit (65,000 points per hour global pool; 429 with Retry-After). CSV export is capped at 1,000 issues, so the API is used                                                                                  | Proposed | To set | https://developer.atlassian.com/cloud/jira/platform/rate-limiting/                                                                                          |
| ERP                       | SAP Business One: Service Layer with a session per company database, 30-minute idle expiry and paging via nextLink; no joins, so complex reads use SQL queries (third-party source)                                                                   | Proposed | To set | https://www.apideck.com/blog/sap-business-one-api-integration-guide                                                                                         |
| ERP                       | SAP S/4HANA: file adapter for CSV and XML extracts; migration templates up to 100 MB                                                                                                                                                                  | Proposed | To set | https://learning.sap.com/courses/implementing-sap-s-4hana-cloud-public-edition/migrating-data-to-sap-s-4hana-cloud-public-edition-with-local-templates      |
| ERP                       | Oracle NetSuite: REST with OAuth 2.0 (SOAP retiring after 2028.2); account-level concurrency is shared with RESTlets                                                                                                                                  | Proposed | To set | https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section\_N3448861.html                                                                        |
| ERP                       | Microsoft Dynamics 365 Business Central: API v2.0 with continuation-token paging, 429 and 503 back-off, a 10-minute request limit and serialised child inserts                                                                                        | Proposed | To set | https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-rate-limits                                            |

### Table C. Record types accepted by import

| Area       | Capability                                                                            | Status   | Phase  | Evidence               |
| ---------- | ------------------------------------------------------------------------------------- | -------- | ------ | ---------------------- |
| CRM        | Accounts, contacts, leads, deals and pipeline stages                                  | Proposed | To set | Extends l.9587         |
| CRM        | Activities, notes, emails and calls linked to their parent records                    | Proposed | To set | Extends l.9587         |
| Projects   | Projects, tasks and timesheets                                                        | Proposed | To set | Extends l.9587         |
| Support    | Tickets and knowledge-base articles                                                   | Proposed | To set | Extends l.9587         |
| Documents  | Documents and attachments linked to their parent records                              | Proposed | To set | Extends l.9587         |
| Accounting | Fixed asset register with accumulated depreciation                                    | Proposed | To set | Extends l.9587         |
| Accounting | Open receivables and payables with ageing                                             | Proposed | To set | Extends l.9587, l.1352 |
| Payroll    | Payroll year-to-date for the current financial year (gross, TDS, PF, ESI) for Form 16 | Proposed | To set | Extends l.9587         |
| HR         | Statutory IDs (PAN, UAN, ESI IP number) and bank details, sealed as regulated cells   | Proposed | To set | Extends l.9587, l.9566 |
| HR         | Leave balances and carry-forward                                                      | Proposed | To set | Extends l.9587         |
| Payroll    | Salary structures and components                                                      | Proposed | To set | Extends l.9587         |
| Masters    | Vendor and customer masters with GSTIN                                                | Proposed | To set | Extends l.9587         |

### Not verified

The following were not confirmed from vendor documentation and are not relied on above:

- Zoho CRM and Zoho Desk export limits
- Salesforce weekly export
- QuickBooks Online export screen
- Odoo export screen
- SAP S/4HANA OData
- NetSuite SuiteQL paging
- Keka, greytHR and Darwinbox export files

### Counts

Table A: 31 rows. Table B: 23 rows (22 sources; Zoho Books has an API row and a file-fallback row). Table C: 12 rows. Total: 66 rows, all Proposed.

## Appendix D. Key sources and notes

**Notes.** Matching was by keyword. Items marked Conflict in the plan were counted as in the plan. Some benchmark references come from search results the agents did not open. The research could not confirm two points: whether the MoE Coaching Guidelines apply to skill centres, and whether the FEMA realisation period is 9 or 15 months.

**Key sources.**

- CERT-In Directions 2022: https://www.cert-in.org.in/PDF/CERT-In\_Directions\_70B\_28.04.2022.pdf
- RBI Digital Lending Directions 2025: https://www.rbi.org.in/scripts/FS\_Notification.aspx?Id=12848
- CCPA coaching guidelines: https://www.medianama.com/2024/11/223-ccpa-new-guidelines-curb-misleading-ads-coaching-sect/
- ISO 27001 A.8.30: https://www.upguard.com/compliance/iso-27001/8-30.md
- EDF replacing SOFTEX: https://www.winvesta.in/blog/businesses/fema-2026-what-indian-service-exporters-must-do-now
- Google review speed: https://google.github.io/eng-practices/review/reviewer/speed.html
- NetSuite inventory: https://www.netsuite.com/portal/products/erp/warehouse-fulfillment/inventory-management.shtml
- ERPNext BOM: https://docs.frappe.io/erpnext/bill-of-materials
- Zoho Creator plans: https://www.zoho.com/creatorplus/plan-comparison.html
- Salesforce CPQ: https://www.salesforce.com/in/products/sales-cloud/tools/cpq-software/
- Darwinbox features: https://www.g2.com/products/darwinbox/features
- Workday people analytics: https://www.workday.com/content/dam/web/uk/documents/datasheets/workday-people-analytics.pdf
- UK Software Developer L4 assessment plan: https://skillsengland.education.gov.uk/media/5222/st0116\_software-developer\_l4\_ap-for-publication\_270521.pdf
- Naan Mudhalvan guideline: https://www.tnskill.tn.gov.in/tnskillnew/shared-files/6178

## Consistency check

**Counts verified:** Part 1 = 91, Part 2 = 210, MIG rows = 66 (Table A 31, Table B 23, Table C 12). Part 1 section counts add to 91. Part 2 section counts add to 210. Table B has 23 rows covering 22 sources.

**Issues found across the three files:**

1. **Scheduling of 11.x (judgement).** Section 10 row "Business planning" names "G 11.x" as a range, not each number. All 20 Part 1 items in 11.x are marked "Later: Business planning" on that basis. The draft does not name them individually.
2. **G numbers in the draft.** Every G number used in section 6 and section 10 is found in Part 1. None is missing.
3. **Unscheduled Part 1 items: 25.** These are listed in Appendix A with "Unscheduled". Several (for example 5.10, 5.11, 6.3, 6.5, 8.3) may need a home before 1Z sign-off.
4. **GAP "Nearest in plan" versus the draft.** G 8.2 gives "Patch obligations (l.1452)" as nearest in plan, but the draft and Part 1 treat patch management as absent. Check l.1452.
5. **G 4.9 line reference.** Part 1 gives the nearest item as "Certificates (l.3098)", while the draft cites certificate rows at l.5103, l.5111 and l.5128. These are different lines in the same area and should be reconciled.
6. **Migration rows versus scope rule 5.** Scope rule 5 says migration connectors are not needed in Phase 1. Appendix C rows are all Proposed with phase "To set". Consistent, but the phase is still open.
7. **Item 1.25 is in Part 2 and in Appendix C.** It is not relevant in the gap list, yet the connectors cover it as a Later-phase item. Noted in Appendix B.
8. **Draft numbering.** The source draft numbers its sections 1 to 7. This doc numbers them 1 to 11 with appendices added. Cross-references in the draft (for example its stop rule at "section 5") now point to section 9 here.
9. **Stop-rule check 9 is Proposed.** The draft's stop rule has checks 1 to 8 only. Check 9 is added as Proposed and is not in the draft.
