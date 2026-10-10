# Planned features

Single source of truth for features that are planned but not yet in a phase file. Phase files (`phase-*.md`) are the executable plan for the current sequence and are read one at a time. This file is where a feature is researched, argued and sized before anyone schedules it. When a feature is scheduled, move its phases into a phase file (or a new one) and leave a one-line pointer here with status `scheduled`.

Do not put ordinary bugs or tasks here. Those go in the issue tracker. This file holds decisions that need a reason written down, so the next person can see why the option was chosen and what was rejected.

## How to add a feature

Copy the template below under a new `## Feature N:` heading and add a row to the index. Keep it terse. Cite `file:line` for every claim about existing code, and re-check the line with `grep -n` before writing it; the plan's own audit point says plausible descriptions of absent code are the common failure.

```
## Feature N: <name>

- **Status:** proposed | accepted | scheduled | in progress | shipped
- **Owner:** <person or TBD — product>
- **Depends on:** <features, phase items, or "none">
- **Reuses:** <file:line — what already exists and what it does>
- **Gaps:** <what does not exist; each gap is a claim that must hold on origin/main>
- **Phases:** <A, B, C... each with scope, what it excludes, and its own exit test>
- **Decisions:** <open questions, each with an owner and the recommended default>
- **Compliance:** <statutory or regulatory exposure; mark unverified legal points ⚠️ and do not state them as fact>
- **Sources:** <URLs with the date read; mark secondary sources as such>
```

Rules that apply to every feature here:

- Money is signed `bigint` paise. Dates are IST. Statutory parameters are `StatutoryRule` rows (CLAUDE.md rules 1, 3, 4).
- Every write is `assertCan` → write → `auditWrite` → `emit`, and the entity is registered with `registerGovernedEntities` (rule 5).
- Tenant scope is resolved server-side and never taken from a body, query or JWT claim (rule 6).
- An agent never posts a journal entry, generates an IRN, files a return, runs payroll or emails a customer without human approval (`packages/shared/src/ai.ts`).

## Index

| #   | Feature                                                             | Status   | Researched | Target                       |
| --- | ------------------------------------------------------------------- | -------- | ---------- | ---------------------------- |
| 1   | Native work management & team communication (Jira- and Slack-style) | proposed | 2026-10-10 | not scheduled                |
| 2   | Product rename: KaiERP → Zen 360                                    | accepted | 2026-10-10 | not scheduled (Tier 1 first) |

## Feature 1: Native work management & team communication (Jira- and Slack-style workflows)

- **Status:** proposed (researched 2026-10-10)
- **Owner:** TBD — product
- **Depends on:** the Task defect fix below, which is independent and can ship first. Phase A depends on nothing outside the repo. Phase C depends on a realtime transport decision. Phase D depends on Phase A and on the AI prohibitions in `packages/shared/src/ai.ts`.

**Goal.** Replicate Jira (issues, workflows, boards, sprints, SLAs, automation) and Slack (channels, DMs, threads, mentions, notifications) natively. Not integrations. The aim is that a Kaizen team can run its work and its conversation inside KaiERP, with the same audit trail and tenant scoping as the finance and HR paths.

### Reuses

What already exists to build on:

- **Ticket with status, priority, SLA and comments.** IT Service Desk: `ItTicket` `apps/api/prisma/schema/it-servicedesk.prisma:56`, `ItTicketComment` `:122`, `ItSlaPolicy` `:19`. Domain `apps/api/src/domains/it/servicedesk.ts`: `createTicket:186`, `transitionTicket:386`, `addComment:445`, governed at `:53`. It already does `assertCan` + `auditWrite` + `emit`. This is the closest Jira-issue template in the repo.
- **Status machine.** `apps/api/src/platform/lifecycle.ts:74` `transition()`, `:125` `availableTransitions()`. Machine factory `packages/shared/src/hr.ts:51` `createMachine`. IT ticket machine `packages/shared/src/it/servicedesk.ts:46` `ticketMachine`.
- **IST business-hours SLA arithmetic.** `packages/shared/src/it/servicedesk.ts:114` `dueFrom()`, `:153` `slaAttainment()`. SLA job `apps/api/src/jobs/it/servicedesk.ts:31` `runServicedeskJob`.
- **Approvals.** `apps/api/src/platform/approvals.ts:109` `evaluateApprovalGate`, `:309` `decideApprovalStep`. Inbox read model `apps/api/src/domains/hcm/workflow.ts:370` `listInbox`, delegation of authority `:533` `listDelegations`. Web: `apps/web/src/components/hcm/RequestInbox.tsx`.
- **Events and jobs.** `apps/api/src/platform/eventBus.ts:207` `emit()`, subscribe alongside. Event name grammar `packages/shared/src/events.ts:14` (`EVENT_NAME_PATTERN`), `:16` `isCanonicalEventName`. Scheduler `apps/api/src/jobs/scheduler.ts`, DB-claimed minute ticks, gated on `JOBS_ENABLED` at `:745`. Marketing journeys `apps/api/src/domains/marketing/journeys.ts` are the existing automation precedent.
- **Notifications.** Model `Notification` `apps/api/prisma/schema/main.prisma:3747`. Writer `apps/api/src/platform/exceptions.ts:257` `notify()`. Read API `apps/api/src/routes/auth.routes.ts:185` (`GET /notifications`). Client poll `apps/web/src/components/Shell.tsx:103-106`, `refetchInterval: 60_000`.
- **Activity timeline.** `Interaction` `apps/api/prisma/schema/main.prisma:1980`, `apps/api/src/domains/interactions.ts:289` `timelineFor`.
- **Platform rules.** `assertCan` `apps/api/src/platform/permissions.ts:317`. `registerGovernedEntities` `apps/api/src/platform/audit.ts:39`. `auditWrite` `apps/api/src/platform/audit.ts:349`, which no-ops on an unregistered `subjectType` (`:350`, via `isGoverned` `:51`). `AUDIT_ACTIONS` `:19` is the verb list and is not the registry. Tenant extension `apps/api/src/platform/db.ts`. Navigation `NAV_REGISTRY` `apps/api/src/seed/bootstrap.ts:122`.

### Gaps

Each of these is a claim about origin/main. Re-check before relying on it.

- **No realtime.** No WebSocket or SSE anywhere. The client polls every 30–120s. `worker/index.ts:110` strips the `upgrade` header, so WebSockets cannot pass the Worker. `wrangler.jsonc` has no Durable Objects.
- **No chat model.** No channel, thread, DM or message model. No `@mentions`.
- **No outbound user email or push.** `notify()` sets `dispatchedAt` at creation and only writes `in_app`. The marketing email adapters are bound to marketing consent and purpose, so they cannot be reused for transactional mail.
- **No file storage or upload pipeline.** `Document` (`main.prisma:2080`) is metadata only. There is no S3 or R2 client. The JSON body limit is 2mb (`apps/api/src/server.ts:20`), so attachments need their own route.
- **No board, sprint, epic, label, watcher or dependency model.** `Task` (`main.prisma:2046`) is a flat reminder row.
- **Work tables have no RLS.** Only the ledger tables have it (migration `20260920173000_ledger_invariants`).
- **Event dead letters are written but never replayed.** Subscribers are in-process only. This matters for multi-instance fan-out.
- **DEFECT to fix first.** `POST /tasks/:id/complete` (`apps/api/src/routes/crm.routes.ts:1109`) updates the row by id with no `assertCan`, no `auditWrite` and no `emit`. `TASK_COMPLETED` is never emitted. `Task` is not governed. Any tenant user can complete any task. This violates CLAUDE.md rule 5. Fix with a failing test against the old code first, then the route goes through the write path. Ship it separately from the feature.

### Phases

**Phase A — Work items (Jira core, no new infrastructure).**

- Generalise the `ItTicket` pattern into projects and work items (epic, story, task, subtask).
- Per-project statuses and transitions as table rows: from, to, roles, conditions, validators, post-actions. Set-status is a built-in transition that cannot be removed. Execution goes through `lifecycle.ts:74`, not a new engine.
- Kanban with WIP limits, backlog, sprints.
- Comments, watchers, links (blocks, relates, duplicates).
- Structured filter bar. No free-text query language, consistent with the no-text-to-SQL rule.
- Reuse the SLA arithmetic and approvals.
- Fix the Task defect first. Fold `Task` and HR cases in as item types.
- Excludes: per-tenant workflow configuration and permission schemes (see Decisions 5).

**Phase B — Discussion (Slack core, polling).**

- Channels (public and private), DMs, `@user` and `@channel` mentions, reactions.
- Edit and delete as tombstones with edit history. The original is kept.
- Record-attached discussions (on a lead, invoice or ticket) using Zulip-style topics rather than nested reply trees.
- Read cursors per (member, channel), storing `last_read_seq`. Unread is `head_seq − last_read_seq`.
- Create a task from a message.
- Postgres `tsvector` with a GIN index for search, behind an interface so it can be replaced.
- About 5s polling is acceptable for v1.
- Exit test: a message in a private channel is not readable by a non-member at the API, not only hidden in the UI.

**Phase C — Realtime and delivery.**

- Transport: SSE through the Worker first. This is unverified: test that the Worker streams SSE before committing. Alternative is a Durable Object per channel with the Hibernation WebSocket API (`serializeAttachment` limit 16 KiB). Deploys drop sockets, so clients must resync on reconnect either way.
- Per-channel monotonic `seq` and `client_msg_id` for dedupe.
- Notification delivery worker via a queue (email, push), user preferences, do-not-disturb.

**Phase D — Automation.**

- User-authored trigger → condition → action rules.
- Every action goes through `assertCan` → write → `auditWrite` → `emit`, the same as a human write.
- Rules must not post journal entries, generate IRNs, file returns, run payroll or email customers without human approval. The hard prohibitions in `packages/shared/src/ai.ts` apply equally to rules. They are not configurable.

**Later (not scoped).** Shared and cross-tenant channels (a trust problem, not a technical one). Huddles. Bots and slash commands. Workflow-Builder-style forms. eDiscovery and legal holds. JSM-style request types and queues. Swimlanes. Velocity reports.

### Decisions

Owner: product, for all of these.

1. **Realtime transport.** SSE through the existing Worker, or Durable Objects with WebSockets. Recommendation: polling for Phase B, then SSE. Do not pick WebSockets unless the SSE test in Phase C fails.
2. **Transactional email provider.** And whether notification email is a separate DPDP purpose from marketing consent. Recommendation: treat it as separate and record it in the consent model before any send.
3. **Object storage for attachments.** R2 or S3. Affects egress cost and the Worker binding.
4. **Chat retention.** Messages are audited and deletes are tombstones. This must be reconciled with DPDP erasure and legal holds. Holds per conversation and per custodian, with an explicit exception path. Do not ship a delete that cannot be reconciled with a hold.
5. **Audience.** Internal Kaizen teams first, or a sellable tenant feature. A sellable feature needs per-tenant workflow configuration and permission schemes, which roughly doubles Phase A.

### Compliance

Sourced from secondary commentary. Verify every point against the Gazette before relying on it.

- DPDP Rules 2025 were notified in November 2025. Most obligations (Rules 3, 5–16, 22, 23) commence about 18 months later, around May 2027. ⚠️ Confirm the commencement date.
- Rule 8: erasure when the purpose is served or consent is withdrawn, unless a law requires retention. ⚠️
- Processing logs kept for at least one year. ⚠️
- At least 48 hours' notice before deletion. ⚠️
- Rule 15: cross-border transfer is subject to government orders. ⚠️ Relevant to any inference on messages.
- Messages are personal data. Any inference on them requires `applyFieldVisibility` (CLAUDE.md), and India-region inference where the tenant requires it. Sending them to a non-India region is a cross-border transfer under DPDP.
- IT Rules 2021 applicability to internal messaging has not been researched. Legal review required before Phase B.

### Prior art

- **Plane** (`github.com/makeplane/plane`): cycles and modules model. Licence not verified.
- **Frappe Helpdesk**: SLA by priority, pause statuses, working hours and holiday lists, default SLA.
- **Zulip**: topic threading. Chosen over nested reply trees for record-attached discussion.
- **Not yet reviewed**: Mattermost, Rocket.Chat, OpenProject, Taiga, Odoo, Zoho.

### Sources

- https://support.atlassian.com/jira-cloud-administration/docs/configure-advanced-issue-workflows/
- https://support.atlassian.com/jira/kb/understanding-why-an-sla-is-paused-in-a-jira-service-management-ticket/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://docs.frappe.io/helpdesk/service-level-agreement
- https://zulip.com/for/business/
- https://github.com/makeplane/plane
- https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/

## Feature 2: Product rename: KaiERP → Zen 360

- **Status:** accepted (decided by product owner 2026-10-10). Not scheduled. Nothing is renamed yet; this entry records the decision and the scope so execution can be sequenced later.
- **Owner:** TBD — product
- **Depends on:** none for Tier 1. Tier 2 needs infra coordination (worker name, domains). Tier 3 is optional and needs a migration plan where noted.
- **Reuses:** nothing in code. There is no product-name constant; the brand is hardcoded (grep `APP_NAME|PRODUCT_NAME|appName|productName|BRAND` over `apps packages worker` returns nothing, 2026-10-10). Introducing one is the first step of Tier 1 for the UI strings.
- **Gaps:** the brand is literal in 24 lines across 18 files (survey on `origin/claude/planned-features-doc`, 2026-10-10, `git grep -i "kaierp|kai erp|kai-erp"`). Company name "Kaizen Infinities" (50 lines) and company domain `kaizen.co.in` are not part of the rename and must stay.
- **Phases:**
  - **Tier 1 — user-visible strings and docs (do first).** No behaviour change, no data change.
    - UI: `apps/web/index.html:15` (`<title>`), `apps/web/src/components/Shell.tsx:295` (sidebar brand), `apps/web/src/pages/Login.tsx:130` (login heading).
    - Authenticator label: `apps/api/src/domains/compliance/corporate/totp.ts:100` (`issuer = 'KaiERP'` default). Changing it changes the label shown in users' authenticator apps for enrolments made after the change; existing entries keep the old label. Exit test: the issuer produced by `otpauthUri` equals the product name; a test fails on the old string.
    - Metadata: `package.json:5` (description), `wrangler.jsonc:2` (comment).
    - Docs: `CLAUDE.md:3`, `README.md:1`, `PRODUCT.md:32,109,130`, `apps/web/DESIGN.md:2,73,79`, `apps/web/.impeccable/design.json:4,111`, `docs/it/README.md:8`, `docs/plan/{ceo-office:10, cio:4, compliance:4, hcm:3, marketing:4}.md`.
    - Exit test: `git grep -i "kaierp\|kai erp\|kai-erp"` returns only this file's history and deliberate references to the old name.
    - Not found in the repo, so nothing to change: PDF/document headers (`apps/web/src/pages/*Document*.tsx`, `documentSheet.tsx` have no product literal), email sender names, manifest, favicon text. Re-check these when the email and PDF templates are built, since they may be added later.
  - **Tier 2 — deploy names (infra coordination).** Worker name is `ooss` (`wrangler.jsonc:9`; `worker/index.ts:62` refers to it). The name is not "KaiERP", so renaming it is a deploy decision, not a find-and-replace. A rename changes the `*.workers.dev` hostname and any bound custom domain; no domain is recorded in the repo. Exit test: the new worker deploys and `/api` proxies to the API, verified on the deployed URL.
  - **Tier 3 — internal identifiers (recommend not renaming).**
    - `kz.*` event names: `packages/shared/src/events.ts:14` (`EVENT_NAME_PATTERN = /^kz\.[a-z]{2,4}\.[a-z_]+\.[a-z_]+$/`) and the registry from `events.ts:53` onward. About 550 distinct `kz.*` strings across `apps` and `packages`. The canonical name is written into the hashed body (`apps/api/src/platform/eventBus.ts:223` sets `eventName: input.name`; hashed at `:169` via `computeHash`, `:96-103`; the dual-publish path hashes the legacy name at `:301`), so renaming them breaks `verifyChain` for existing records and the emission grammar. Recommendation: keep `kz.*`. The `kz` is an internal namespace, not the product name.
    - Storage key `kaizen.token` at `apps/web/src/lib/api.ts:9`. Renaming it signs every logged-in user out on deploy. Only rename with a migration that reads the old key once and copies it across. Recommendation: leave it.
    - Tenant slug default `'kaizen'` at `apps/api/src/platform/config.ts:89` and `parentTenantSlug: 'kaizen'` in several tests. Renaming it touches existing tenant rows. Recommendation: leave it; it names the company, not the product.
    - Package names `@kaizen/{api,web,shared,semantic,e2e}` (their `package.json` `name` fields). Cosmetic, private packages. Optional, and it is the company name, so probably keep.
    - Root package name `kaierp` at `package.json:2` (private package). Safe to rename to `zen-360` or similar in Tier 1 if wanted; no publish, no consumers outside the repo.
- **Decisions:**
  - Logo and brand assets. Owner: product. Default: keep `apps/web/public/kaizen-logo.png` (the company logo, used at `apps/web/src/pages/kaizenInvoice/LedgerSheet.tsx:63`). Add a Zen 360 mark only when supplied.
  - Domain name. Owner: infra. Default: none chosen. Blocks Tier 2 only.
  - Tenant-facing name or white-label. Owner: product. Default: show "Zen 360" as the product name, and the tenant's own legal name from tenant data. Note `PRODUCT.md:109` says the product is not sold or licensed to other companies yet, so white-label is not in scope now.
  - Whether the git repository `THeK1DUNBXR/OOSS` is renamed. Owner: product. Default: no; it is not part of the product name in the UI.
  - Tier 3 items above. Owner: engineering. Default: do not rename.
- **Compliance:** The legal entity KIPL (`PRODUCT.md:130`; document numbering `KIPL/I/26-27/001`) and the GST and e-invoicing identifiers on documents are the company's, not the product's, and must not change. ⚠️ Unverified: confirm with finance that no statutory document or e-invoice field requires the product name, before Tier 1 changes any invoice or receipt header. The TOTP issuer label is not a statutory field, but it is shown to staff who use two-factor authentication, so the change needs a note to users.
- **Sources:** none. Internal repository survey on `origin/claude/planned-features-doc`, 2026-10-10.
