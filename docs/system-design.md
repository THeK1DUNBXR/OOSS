# System design: flows and topology

This page is the picture. The reasoning behind the rules (tenancy as a gate, identity resolving once, the event fabric's ordering) is in [architecture.md](architecture.md). Every node below names the file that implements it, so the diagrams can be checked against the code with `Read offset/limit` on the line given. Line numbers are as of this writing; `docs/plan/MAP.md` is the index that stays current.

## 1. Deployment topology

One server in India runs everything. No request leaves for a third-party edge. The Cloudflare Worker that once sat in front of the client has been removed.

```mermaid
flowchart LR
    U[Browser<br/>React SPA] -->|HTTPS :443| C[Caddy<br/>TLS, HSTS, gzip/zstd<br/>deploy/Caddyfile]
    C -->|reverse_proxy 127.0.0.1:4000| N[Node / Express<br/>apps/api/src/server.ts]
    N -->|/api/*| R[Route handlers<br/>apps/api/src/routes]
    N -->|everything else| S[Built client<br/>WEB_DIST_DIR<br/>server.ts:69]
    R --> P[(Postgres<br/>RLS + tenant_id)]
    N --> J[Scheduler<br/>jobs/scheduler.ts]
    J --> P
    subgraph Box[Our server, India]
      C
      N
      J
      P
    end
```

Facts this rests on:

- Caddy terminates TLS and proxies everything to Node. `deploy/Caddyfile` sets `reverse_proxy 127.0.0.1:{$API_PORT:4000}`.
- Express trusts `X-Forwarded-For` only from a loopback peer (`server.ts:24`, `trust proxy` = `loopback`). A client that reaches Node without going through Caddy cannot spoof its IP, but the port still has to be firewalled.
- The API serves `/api` and the client from one origin, so there is no CORS between them (`server.ts:44`, `:69`).
- In development, Vite proxies `/api` to `localhost:4000` (`apps/web/vite.config.ts:46`).

## 2. Request lifecycle

Every HTTP request runs through the same three steps before a handler sees it: a request context, an identity, and then the route's own checks.

```mermaid
flowchart TD
    A[HTTP request] --> B[Caddy<br/>deploy/Caddyfile]
    B --> C[express.json 2mb<br/>server.ts:26]
    C --> D[contextMiddleware<br/>lib/http.ts:27<br/>new RequestContext<br/>x-request-id]
    D --> E{Bearer token?}
    E -- no --> F[ctx.auth unset]
    E -- yes --> G[verifyToken<br/>lib/auth.ts:118]
    G -- invalid --> F
    G -- valid --> H[AuthContext<br/>tenant from session<br/>platform/context.ts:15]
    F --> I[runWithContext<br/>platform/context.ts:53]
    H --> I
    I --> J{Route needs auth?}
    J -- yes --> K[requireAuth<br/>lib/http.ts:78]
    K -- no ctx.auth --> X1[401 ApiError.unauthorized]
    J -- no --> L[handler wrapper<br/>lib/http.ts:84]
    K -- ok --> L
    L --> M[assertCan<br/>platform/permissions.ts:317]
    M -- denied --> X2[403]
    M -- allowed --> N2[Domain logic<br/>domains/*]
    N2 --> O[Prisma, tenant-scoped<br/>platform/db.ts:80]
    O --> P2[JSON response]
    N2 -- throws --> X3[errorMiddleware<br/>lib/http.ts:100]
```

The tenant is never read from a body, query string or JWT claim. It comes from the resolved session (`CLAUDE.md`, rule 6). Prisma's extension injects it and Postgres RLS enforces it underneath.

## 3. The write path

Every write follows the same order. The order matters: the audit record is written before the event is emitted, so a subscriber never sees a change that has no audit trail.

```mermaid
flowchart LR
    A[Route handler] --> B[assertCan<br/>permissions.ts:317]
    B --> C[Domain write<br/>parent first,<br/>then children<br/>explicit, never nested]
    C --> D[auditWrite<br/>audit.ts:349]
    D -->|isGoverned? no-op if unregistered<br/>audit.ts:51| D2[(AuditRecord<br/>hash-chained<br/>audit.ts:218)]
    D --> E[emit<br/>eventBus.ts:207]
    E --> F[(EventRecord<br/>eventBus.ts:295)]
    E --> G[Subscribers<br/>events/handlers.ts]
    G --> H[Follow-on writes<br/>same path again]
```

Two checks keep this honest:

- `auditWrite` silently does nothing for an entity that is not registered with `registerGovernedEntities` (`audit.ts:39`, `isGoverned` at `:51`). The check is on the registration list, not on the verb list `AUDIT_ACTIONS` (`:19`). Registering a new entity is part of adding it.
- Events are validated against the `kz.<domain>.<object>.<verb>` grammar when emitted and again when stored (`CLAUDE.md`, rule 5).

## 4. Ledger posting

Only `platform/ledger.ts` writes to the journal. Posted entries are immutable: the application database role has no `UPDATE` or `DELETE`. A correction is a reversal, not an edit.

```mermaid
flowchart TD
    A[Domain: invoice, payroll,<br/>bank import, ...] -->|PostInput| B[post<br/>platform/ledger.ts:61]
    B --> C{Lines balance<br/>in signed bigint paise?}
    C -- no --> X[reject]
    C -- yes --> D[(journal_entries /<br/>journal_lines)]
    D --> E[auditWrite + emit<br/>as in section 3]
    F[Correction needed] --> G[reverse<br/>ledger.ts:191]
    G --> D
    H[Anything else that<br/>inserts into journal_*] -.->|forbidden| D
```

Money is signed `bigint` in paise throughout. There is no `number`, `float` or `Decimal` in application code. The money helper (`packages/shared/src/money.ts`, item 1.6) is not yet written, so `packages/shared/src/finance.ts` still uses `number` and is a known defect, not a pattern to copy.

## 5. Background jobs

The scheduler is a per-tenant loop. It checks which jobs are due, claims each occurrence in the database so two instances cannot both run it, and runs it under a timeout with a heartbeat.

```mermaid
flowchart TD
    T[tickOnce<br/>jobs/scheduler.ts:662] --> U[Load active tenants<br/>unscopedPrisma, :666]
    U --> V{For each tenant,<br/>each job in ALL_JOBS}
    V --> W{dueOccurrence<br/>cron window?}
    W -- no --> V
    W -- yes --> X[claimOccurrence<br/>DB claim row, :676]
    X -- lost claim --> S[skipped++]
    X -- claimed --> Y[heartbeat interval]
    Y --> Z[withTimeout<br/>runJobsForTenant<br/>scoped to the tenant, :697]
    Z -- ok --> OK[mark claim done]
    Z -- error or timeout --> R{attempts < MAX_ATTEMPTS?<br/>schedule.ts:26}
    R -- yes --> BO[lease pushed out by backoffMs<br/>scheduler.ts:723]
    R -- no --> DL[dead-letter row<br/>scheduler.ts:580]
    V --> ALL[Rule: every job receives<br/>the tenant id, never a global scope]
```

Every job is tenant-scoped. A background job that forgets the tenant is among the most common ways a multi-tenant system leaks data (`CLAUDE.md`, rule 6). Nested Prisma writes also bypass the tenant extension, so jobs write the parent and then each child explicitly.

## 6. Agent proposals and approval gates

Agents never act directly. They propose an action, and a policy decides whether a human must approve it first. The hard prohibitions (no journal posting, no IRN generation, no return filing, no payroll run, no customer email without a human) are in `packages/shared/src/ai.ts`, not in configuration.

```mermaid
flowchart TD
    A[Agent proposes action<br/>agents/index.ts:61 propose] --> B[classifyAction<br/>platform/llm.ts:77]
    B --> C{assertActionAllowed<br/>llm.ts:92}
    C -- prohibited --> X[refused]
    C -- allowed --> D[evaluateApprovalGate<br/>platform/approvals.ts:109]
    D -- gate passes --> E[Execute through the<br/>normal write path, section 3]
    D -- needs approval --> F[Pending ApprovalStep<br/>approvals.ts:309 decideApprovalStep]
    F -- human approves --> E
    F -- human rejects --> G[Recorded, not executed]
    H[Personal data to a model] --> I[applyFieldVisibility<br/>permissions.ts:481]
    I --> J[redactPersonalFields /<br/>sanitizeForModel<br/>llm.ts:118,141]
    J --> K{India region required?<br/>llm.ts:103}
    K -- yes --> L[ModelGateway<br/>India endpoints only]
    K -- no --> M[ModelGateway]
```

The personal-data branch is a cross-border control under DPDP. Data that leaves for a model without `applyFieldVisibility` is a violation even when the model is one we trust.

## 7. Import pipeline

Imports are staged first and committed later, so a human can see every row, decide on the matches, and revert the whole batch.

```mermaid
flowchart LR
    A[Upload<br/>MAX_UPLOAD_BYTES<br/>imports/service.ts:33] --> B[detectWorkbook<br/>imports/detect.ts:219]
    B --> C{Format}
    C -->|Tally XML| D[extractTallyXml<br/>tallyXml.ts:51]
    C -->|Workbook / CSV| E[readWorkbook / parseCsv<br/>imports/parse.ts]
    E --> F[extract*<br/>imports/extract.ts]
    D --> G[Staged rows]
    F --> G
    G --> H[matchPerson<br/>imports/matchName.ts:81]
    H --> I[Human reviews rows<br/>setRowStatus<br/>service.ts:331]
    I --> J[commitImport<br/>imports/commit.ts:78]
    J --> K[Writes via post / write path]
    K --> L[revertImport<br/>commit.ts:715<br/>reversal, not delete]
```

`commit.ts:721` currently hard-deletes on revert. That path is a known defect. It should become a reversal through `post()`, and it is a bug to fix, not a precedent to follow (`CLAUDE.md`, "Never").

## 8. Where to look next

| Question | Start here |
|---|---|
| Why the system is shaped this way | [architecture.md](architecture.md) |
| Which file or symbol does X | `docs/plan/MAP.md`, or `/where <thing>` |
| Current work and what is next | `docs/plan/CURRENT.md`, `docs/plan/zen360/ORDERED-PLAN.md` |
| Money rules | `CLAUDE.md` rule 1; `docs/plan/archive/phase-1-ledger.md` |
| Statutory parameters | `CLAUDE.md` rule 4; `StatutoryRule` in `apps/api/prisma/schema` |
| Schema changes | `apps/api/prisma/migrations`, gated by `pnpm --filter @kaizen/api db:drift` |
