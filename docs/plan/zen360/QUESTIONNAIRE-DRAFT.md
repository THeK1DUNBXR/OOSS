# Access-mapping questionnaire and rules (draft)

**Status: DRAFT by Claude for owner review; not approved; no statutory values.**

Nothing in this file is an owner decision. It is a proposal built from the owner answers in `DECISIONS.md` rounds 9 to 15, and it must be approved by the owner before it is built. No statutory rate, limit, threshold or number appears here. Money thresholds are tenant data entered at onboarding (`ROADMAP.md` section 3).

Sources: `DECISIONS.md` rounds 9 to 15 (round 13: guided flow; round 14: hybrid design, blocked pairs, questionnaire shape; round 15: staff defaults, guest accounts); `ORDERED-PLAN.md` Wave 6 and the access model section; `ROADMAP.md` sections 2 and 3.

---

## 0. How the flow runs

1. **Identity type, first.** HR, the founder or the onboarding owner chooses **employee** or **founder** (round 25 item a). Guests (auditors, board members, contractors) are not in this flow. They are guest accounts (round 15), and their design is open.
2. **Function, then level.** The function is recorded as an attribute and does not pick a template. There is one editable starter template, unassigned (round 25 item b; C-009). The function list is open, see section 6. The questionnaire then sets the level: **Head**, **Manager** or **Staff**.
3. **Baseline.** Every employee starts on the **Staff default duties** (round 15): see and edit own records (profile, attendance, leave and expense requests); log own time and tasks; use chat and notifications. These are low risk.
4. **Twelve yes/no questions and one scope choice** (section 1), answered by HR, the founder or the onboarding owner for each employee (round 13; round 25 item a).
5. **Mapping** (section 2) suggests a level and extra duties. **Nothing takes effect until a named confirmer confirms it.** The person being mapped cannot confirm their own level.
6. **Sensitive permissions are never defaults.** Approvals, payroll, bank, user administration, company-wide data and statutory rules each need an explicit request, a named approver and a conflict check (round 14, item 1). A reviewer then confirms, adds or removes, with a reason and the rule version (section 4).
7. **Least access when unclear.** A missing or unclear answer is treated as "no", and the case is flagged for the reviewer.

---

## 1. The questions

Each question asks about a task, not a permission name (round 14, item 8). Answers are yes or no. "Sensitive" means the answer can add a duty from the round 14 sensitive list and therefore needs the sensitive review in section 4.

Step A, identity type (single choice, not counted): employee or founder.

Step B, function (single choice, not counted): one function from the list in section 6. It is recorded as an attribute and selects no template (round 25 item b).

### Yes/no questions (12)

| #   | Task wording (shown to HR, the founder or the onboarding owner)                                                 | Attribute or duty it flips                                                          | Sensitive review?                                                 |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Q1  | Does this person set the work and priorities of other people?                                                   | Level: at least **Manager**                                                         | No                                                                |
| Q2  | Does this person lead more than one team, or a whole function?                                                  | Level: **Head** (only together with Q1 yes)                                         | No                                                                |
| Q3  | Does this person approve other people's leave, attendance or expense requests?                                  | Duty: approve team requests (only with Q1 yes)                                      | **Yes** (approvals)                                               |
| Q4  | Does this person create or prepare payments to suppliers, freelancers or staff?                                 | Duty: create payments                                                               | **Yes** (payments)                                                |
| Q5  | Does this person approve payments?                                                                              | Duty: approve payments (up to the tenant's threshold, set at onboarding)            | **Yes** (payments)                                                |
| Q6  | Does this person run payroll?                                                                                   | Duty: run payroll. Founder-only class: founder confirmation required                | **Yes** (payroll)                                                 |
| Q7  | Does this person approve payroll?                                                                               | Duty: approve payroll                                                               | **Yes** (payroll)                                                 |
| Q8  | Does this person need to see or change bank accounts or bank files?                                             | Duty: bank                                                                          | **Yes** (bank)                                                    |
| Q9  | Does this person need to add, remove or change other people's access or levels?                                 | Duty: user administration                                                           | **Yes** (user admin)                                              |
| Q10 | Does this person need to change the company's statutory rule settings?                                          | Duty: change statutory rules. Sign-off is never mapped from this answer (section 3) | **Yes** (statutory)                                               |
| Q11 | Does this person need to read company-wide records outside one team, such as all books or all staff HR records? | Duty: company-wide read                                                             | **Yes** (company-wide data)                                       |
| Q12 | Does this person need to read the company directory (a list of all employees)?                                  | Duty: company directory read. Not a default (round 15)                              | No, but it is a non-default duty and the reviewer must confirm it |

Notes on the questions:

- Q1 and Q2 decide the level. Q3 to Q12 decide extra duties. The round 14 target is "about 8 to 12" questions, and 12 is at the top of that range. Owner may drop Q12 and treat the directory as a reviewer-only toggle (section 6).
- Q3 uses the word "approve" because approvals are a sensitive class in round 14. Whether team-scoped approvals should be sensitive is an open question (section 6).
- Q6 and Q7 are split so that the blocked pair "run and approve payroll" (section 3) can be checked question by question.

### Scope choice (one choice, not yes/no)

**S1. Does this person's access cover the whole company, or only one branch?**

- Options: **company** or **branch** (one or more named branches).
- Flips: the scope attribute, which applies to every duty above.
- Sensitive review: **yes for company scope**, because company scope gives company-wide reach by default.
- Branch scope needs a definition of branch in the data model. It is an open question (section 6).

---

## 2. Mapping rules

Rules run top to bottom. Each rule is data, versioned, and recorded with the suggestion (round 13 audit row).

| Answers                   | Suggested level            | Extra duties suggested                       | Notes and flags                                                                                              |
| ------------------------- | -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Q1 no, Q2 no              | **Staff**                  | None beyond the Staff baseline               | Default for everyone who does not match a later rule                                                         |
| Q1 yes, Q2 no             | **Manager**                | None by level alone                          | Manager default duties are tbd during onboard (round 12)                                                     |
| Q1 yes, Q2 yes            | **Head**                   | None by level alone                          | Head variants are an open question (section 6)                                                               |
| Q1 no, Q2 yes             | **Manager** (least access) | None                                         | Flag "leads a function but sets no one's work". Reviewer decides; Head is not suggested                      |
| Q3 yes with Q1 yes        | As above                   | Approve team requests (sensitive)            | Scope follows S1                                                                                             |
| Q3 yes with Q1 no         | As above                   | **None added**                               | Flag "approves requests but sets no one's work". Reviewer decides                                            |
| Q4 yes                    | As above                   | Create payments (sensitive)                  | Blocked if Q5 is also yes (section 3)                                                                        |
| Q5 yes                    | As above                   | Approve payments (sensitive)                 | Blocked if Q4 is also yes (section 3). Threshold from onboarding data                                        |
| Q4 yes and Q5 yes         | As above                   | **Neither suggested**                        | Blocked pair. Reviewer removes one side, or founder overrides with a reason                                  |
| Q6 yes                    | As above                   | Run payroll (sensitive, founder-only class)  | Needs founder confirmation before it takes effect (round 13)                                                 |
| Q7 yes                    | As above                   | Approve payroll (sensitive)                  | Blocked if Q6 is also yes                                                                                    |
| Q6 yes and Q7 yes         | As above                   | **Neither suggested**                        | Blocked pair (section 3)                                                                                     |
| Q8 yes                    | As above                   | Bank (sensitive)                             |                                                                                                              |
| Q9 yes                    | As above                   | User administration (sensitive)              | Cannot approve own access (section 3). Founder exempt                                                        |
| Q10 yes                   | As above                   | Change statutory rules (sensitive)           | Sign-off is not mapped (section 3)                                                                           |
| Q11 yes with S1 company   | As above                   | Company-wide read (sensitive)                | Reviewer confirms                                                                                            |
| Q11 yes with S1 branch    | As above                   | **None added**                               | Flag "company-wide read asked for a branch-scoped person". Reviewer decides                                  |
| Q12 yes                   | As above                   | Company directory read (non-default)         | Reviewer confirms. Not a default (round 15)                                                                  |
| S1 company                | As above                   | None by scope alone                          | Company scope is itself a sensitive review                                                                   |
| S1 branch                 | As above                   | None by scope alone                          | Every duty is limited to the named branch(es)                                                                |
| Identity founder          | **Founder**                | Founder level, not mapped by these questions | Founder self-approval exemption applies (round 10). Who reviews the founder's own access is open (section 6) |
| Missing or unclear answer | Treated as "no"            | None added                                   | Flag for reviewer. Least access (round 13)                                                                   |

Level never rises above Manager from duties alone. Head comes only from Q1 and Q2 together.

---

## 3. Blocked conflict pairs

A conflict is blocked. Neither side takes effect until the conflict is resolved. The founder may override a block with a **logged reason**. Each override is shown in the exceptions view (round 14, item 3).

| Pair                                                                     | Why blocked                                                         | Mapping check                                                                                                                                                                                                    | Founder override                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Create and approve payments (Q4 and Q5)                                  | One person could pay and approve their own payment                  | Blocked if both are yes                                                                                                                                                                                          | Yes, with reason                                                                                    |
| Run and approve payroll (Q6 and Q7)                                      | One person could run a payroll and approve it                       | Blocked if both are yes                                                                                                                                                                                          | Yes, with reason. Payroll run is founder-only in any case                                           |
| Manage access levels and approve own access (Q9 and any access approval) | A person could grant themselves access                              | Blocked for anyone holding user administration who would confirm their own access. The founder alone may approve their own access                                                                                | Founder exemption (round 14): the founder may approve their own access. Other overrides need reason |
| Change and sign off statutory rules (Q10 and the sign-off duty)          | A person could change a rule and then approve it (round 15, item 1) | Q10 can be mapped, but the sign-off duty is never mapped from any answer. It is assigned only by the founder during onboarding, to a qualified holder (round 12). The review screen blocks a person who has both | Yes, with reason. The reason must name the qualified holder who signs off                           |

Notes:

- The statutory sign-off duty is not one of the eleven questions. Its holder is named per tenant at onboarding (round 12). Q10 only asks whether a person changes rules. This keeps the sign-off holder a deliberate founder choice.
- Founder-only classes (payroll run, large payments, statutory filings) need explicit founder confirmation before they are assigned (round 13).
- Round 10 weakened segregation for founder-only classes. The founder's self-approval is visible only in the audit row. The exceptions view is the main control. This is a known risk, not an objection.

---

## 4. Reviewer screen outline

The reviewer is a named confirmer who is not the person being mapped (round 13).

1. **Header.** Person's name, identity type, function template, suggested level, scope (company or named branch(es)), rule version used.
2. **Plain-language summary.** Two short lists: "This person can ..." and "This person cannot ...", written from the duties, not permission names. Example line: "Can create payment requests. Cannot approve payments."
3. **Per-duty toggles.** One row per duty, grouped by Staff baseline, extra duties, and sensitive. Baseline duties are shown on and locked. Sensitive duties start off unless the questionnaire answer requested them, and each shows its named approver field.
4. **Conflict panel.** Lists any blocked pair. Each pair offers "remove one side" or "founder override with reason". The override is disabled for anyone who is not the founder.
5. **Reason field.** Required for any change from the suggestion, and for any founder override. Free text, saved with the change.
6. **Founder-only banner.** Shown for payroll run, large payments and statutory filings. Confirmation needs the founder.
7. **Confirm.** Writes one audit row per confirmed assignment: answers given, suggestion, changes made, reason, rule version, confirmer. The person being mapped cannot press Confirm for themselves.
8. **After confirm.** Link to the exceptions view. Proposed: where a confirmed change reduces access, the person's live sessions end for the changed scope, as round 14 item 7 does for leavers. This is a proposal, not an owner answer.

The same screen is reused for joiners and role changes (round 13, item 4).

---

## 5. Worked examples (SAMPLE, invented)

These three employees are invented for illustration. They are not real people or real records. Answers are shown as yes (Y) or no (N) for Q1 to Q12, with scope S1.

### Sample A: accounts assistant

Answers: Q1 N, Q2 N, Q3 N, Q4 Y, Q5 N, Q6 N, Q7 N, Q8 N, Q9 N, Q10 N, Q11 N, Q12 N. Scope: company.

- Rule path: Q1 no, Q2 no gives Staff. Q4 yes gives create payments.
- Suggested: **Staff**, Finance template, Staff baseline, plus **create payments** (sensitive).
- Review: needs an explicit request, a named approver who is not the creator, and a conflict check. The conflict check passes because Q5 is no.
- Company scope adds a sensitive review of its own, so the reviewer sees both items.

### Sample B: site lead for one branch

Answers: Q1 Y, Q2 N, Q3 Y, Q4 N, Q5 N, Q6 N, Q7 N, Q8 N, Q9 N, Q10 N, Q11 N, Q12 N. Scope: branch (one named sample branch).

- Rule path: Q1 yes, Q2 no gives Manager. Q3 yes with Q1 yes gives approve team requests.
- Suggested: **Manager**, Operations template, Staff baseline, plus **approve team requests** (sensitive), limited to the named branch.
- Review: the reviewer confirms the approver field and the branch. Team-scoped approval sensitivity is an open question (section 6).

### Sample C: finance lead with three blocked pairs

Answers: Q1 Y, Q2 Y, Q3 N, Q4 Y, Q5 Y, Q6 Y, Q7 Y, Q8 Y, Q9 N, Q10 Y, Q11 Y, Q12 Y. Scope: company.

- Rule path: Q1 yes and Q2 yes gives Head. Q4 and Q5 are both yes, so create and approve payments is blocked. Q6 and Q7 are both yes, so run and approve payroll is blocked. Q10 is yes, so change statutory rules is suggested, but sign-off is not mapped.
- Suggested: **Head**, Finance template, Staff baseline. Extra duties suggested: bank, company-wide read, company directory read, change statutory rules. **Neither side of either payment pair is suggested**, and neither payroll duty is suggested.
- Review: the reviewer must remove one side of each blocked pair, or the founder overrides with a reason. Payroll run needs founder confirmation. The reviewer checks that the person is not also the statutory sign-off holder.
- Outcome shows why the least-access rule matters: the first pass suggests fewer duties than the answers asked for.

---

## 6. Open questions for the owner

1. **Function list.** Which functions are offered as an attribute (for example finance, HR, operations, education, sales, engineering, admin)? Proposed placeholder only. No role template is attached to any function (round 25 item b).
2. **Head variants.** Does a Head of a function get a different default set from a Head of the whole company? Head default duties are still tbd (round 12).
3. **Branch scope.** How is a branch defined in the data model? Can a person hold more than one branch? Does branch scope apply to records as well as to people?
4. **Team-scoped approvals.** Is approving team leave, attendance and expenses (Q3) a sensitive class, or only payments and payroll? Round 14 says "approvals" without a finer split.
5. **Company directory.** Is the directory (Q12) a sensitive class, or only a non-default duty? Round 15 says it is not a default and does not say more.
6. **Payments threshold.** Does Q5 mean all payments, or only payments above the tenant threshold? The threshold is tbd during onboard.
7. **Founder's own access.** If the founder is the only founder, who reviews the founder's own access and levels?
8. **Statutory sign-off.** Confirm that the sign-off duty is never mapped from any answer and is assigned only by the founder (section 3).
9. **Leavers.** Should the employee's leave date be captured in this flow, as the round 14 leaver rule requires, or in HR?
10. **Recertification.** Should the same questions be asked again at the quarterly (sensitive) or annual (other) recertification, or only the reviewer's toggles?
11. **Approval of wording.** Who approves the question wording and the rule table before build? Status stays DRAFT until then.
