# Archive: zen360 ORDERED-PLAN.md, old Phase 1 (sub-phases 1A to 1F)

Archived 23 Oct 2026. Superseded by docs/plan/zen360/PHASE-1-MASTER-PLAN.md. Old letters map to new ones as follows: 1A→1C, 1B→1D, 1C→1K, 1D→1K, 1E→1I, 1F→1N.

Source: `docs/plan/zen360/ORDERED-PLAN.md`, the Phase 1 section, the section moved out verbatim. Links were changed to `../zen360/` paths. Other text is unchanged, so item numbers resolve as before.

## Phase 1: software developers can work from home

> Superseded for Phase 1 by [`PHASE-1-MASTER-PLAN.md`](../zen360/PHASE-1-MASTER-PLAN.md) (23 Oct 2026). The letters 1A to 1F below are the old scheme and collide with the master plan's 1A to 1P. Its section 2 maps them: 1A to 1C, 1B to 1D, 1C to 1K, 1D to 1K, 1E to 1I, 1F to 1N. Kept for history and item references.

Stop rule for each sub-phase: its items are merged and its listed tests pass. Tests are written first.

### 1A. Approvals (DEC-05, DEC-06, DEC-07, CAP-DEC-08)

- Definition rows.
- A pure transition function, persisted with the decision row and an audit row.
- Requester exclusion. The founder is exempt (DECISIONS.md, round 10). The draft test "maker equals checker is refused" must exempt the founder level.
- Delegation with an expiry and a named alternate. Escalate after 24 hours of absence. **Owned here (round 21b, item 2):** delegation and the 24-hour absence test are Phase 1A items. The 24-hour founder-absence scenario is no longer a Phase 0 Wave 6 exit criterion.
- The 24-hour absence test is an exit test for this sub-phase (round 22 item b). It moved here from Phase 0 Wave 6. Owner-confirmed as 1A scope; ROADMAP follows.
- Typed thresholds, stored as data.
- Prerequisites: FX-01, FX-32.

### 1B. Attendance and remote (HRM-06, HRM-28, HRM-19, HRM-15)

- Self-declared work-from-home and on-duty requests, with manager approval.
- No location, device ID or IP is stored.
- Overlap check.
- Self-approval refused.
- Backup approver.
- Legal check on CAP-HRM-32: warning only (round 25). It does not block.

### 1C. Time and projects (CON-09, DEL-07, DEL-01, DEL-02)

- Timesheets per person, with project aggregates for insights.
- Project and activity foreign keys.
- Billable flag.
- Rate snapshot.
- Approved-period lock, with a permission-gated reopen.

### 1D. Delivery (HRM-18 first, DEL-03 to DEL-06, CRM-13, CON-05)

- Allocation calendar with a Postgres exclusion constraint.
- DEL-04: change request baseline plus delta.
- Billable amounts are derived.
- Customer acceptance is the only billing trigger. A signed contract means won.

### 1E. Communication

- COM-13: response SLA mechanism only. The numbers come after one month of measurement.
- COM-15: notifications in-app and by email via Resend.
  - Not gated by the Resend data-hosting check (round 25 item g; see DECISIONS.md, round 25).
- COM-02: shared inbox. One mailbox that several employees open (for example support@), with assignment and internal notes. It may receive and send to external addresses (round 24 item g). Customer-facing sends keep human approval. Supersedes the round 4 COM-02 rule "internal-only, no external provider".
- Employee company mailboxes and in-app inbox (round 21, OPEN, new large scope, not estimated). Owner answers: the app creates and hosts each employee's mailbox; the inbox sends and reads mail and links it to customers (Z3 capture pulled in for employee mail only). Round 22 owner decision, clarified 2026-10-12: copy code from open-source mail projects where relevant (Stalwart and others) into our own mail component, and log provenance in `docs/plan/zen360/MAIL-PROVENANCE.md`. This is not a literal fork. Unresearched caveats (Enterprise features, JMAP, release cadence, hosting conflict) are listed in DECISIONS.md round 22. Still OPEN and not estimated. No CAP row or spec yet. MVP, v2 and later feature phasing is in DECISIONS.md round 22. See DECISIONS.md round 21 and round 22.
- COM-11: meetings and minutes, typed by people. No recordings.
- Standups are dropped.

### 1F. Staff expense claims

- Claim, approve, and post to the ledger via `post()` on approval.
- Desktop capture only.
- Not BLOCKED-BY the receipt storage location. Storage and backups are decided with hosting after Phase 1 (round 24 item i).

### Feature 1 work items, in waves

- **Wave 2 (projects):** projects, epics, stories, tasks, subtasks. Per-project status rows via `lifecycle.ts:74`. WIP limits. Midpoint fractional rank, with rebalance. A `version` column for optimistic concurrency. RLS.
- **Wave 3 (discussion):** channels, DMs, mentions, reactions. Per-channel sequence numbers. Edits kept as revisions. Deletes kept as tombstones.
  - Not gated by the chat-retention counsel check (D-14; round 25 item g; see DECISIONS.md, round 25).
- **Wave 4 (realtime):** SSE served directly by the Express API. The Worker spike is dropped. A notification worker with do-not-disturb.
- **Wave 5 (automation):** rules cannot post journals, generate IRNs, file returns, run payroll, or email customers without approval.
- **Wave 6 (voice and video):** LiveKit. ~~Self-hosted on the own server in India.~~ **Superseded by round 18b, item 4:** the code needs only a configurable server address; hosting deferred. Development and tests use a local setup. Where the server runs is a hosting decision after Phase 1.
  - Ports: TCP 7880 and 7881, UDP 50000 to 60000, TURN/TLS on 443, public IP. **Hosting detail, DEFERRED (round 18b, item 4).** Kept as history.
  - 5-minute join tokens. Opaque room names. Webhook verification with event-id idempotency.
  - No recording, egress or transcripts.
  - Per-tenant LiveKit isolation is **DEFERRED (round 18b, item 1)**. E2EE is still UNVERIFIED.
