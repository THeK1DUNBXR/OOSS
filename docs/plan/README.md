# Plan index

**Read one phase file per session.** Each is self-contained. Reading all nine costs ~11k tokens to find ~1.5k of instruction.

| Phase | File | Delivers | Size |
|---|---|---|---|
| 0 | `phase-0-stabilise.md` | Nine verified defects, security headers, logging, CI | 1 week |
| 1 | `phase-1-ledger.md` | Double-entry journal, integer paise, DB-enforced balance, append-only | 3–4 weeks |
| 2 | `phase-2-audit.md` | Rule 3(1) audit spine, 8-year retention, DPDP consent + erasure | 2 weeks |
| 3 | `phase-3-statutory.md` | Statutory pack, e-invoicing, GSTR-1/1A/3B/IMS, payroll, TDS | 6–8 weeks |
| 4 | `phase-4-interface.md` | Design system, `DataTable`, splitting, a11y, mobile | 4–6 weeks |
| 5 | `phase-5-semantic.md` | Typed metric graph, deterministic SQL compiler, evals | 3 weeks |
| 6 | `phase-6-intelligence.md` | Model gateway, the Briefing, Ask Kaizen, approval gates | 4–6 weeks |
| 7 | `phase-7-product.md` | Onboarding state machine, tenancy tiers, India residency | 3–4 weeks |
| 8 | `phase-8-proof.md` | Concurrency tests, leakage fuzzer, restore drills, SOC 2 | ongoing |

`MAP.md` — generated index of every model, symbol, route and page with `file:line`. **Look here before searching.** `EFFICIENCY.md` — how to execute this plan without wasting tokens; read once at setup. `prompts.md` — kick-off prompt per session. `rationale.md` — why the plan is shaped this way; read once, never during execution. `sequencing.md` — who does what, in what order.

**Ordering is dependency-driven.** 1 before 3. 1, 2 and 5 before 6. Do not reorder.

## Audit point

All `file:line` citations were read at `origin/main` @ `1656498`, verified by a Session-0 pass on 12 September 2026. Two commits have landed since (`fef1870`, `dc2c05f`, PR #6). No defect moved. These citations are stale:

| Written | At `1656498` | At `dc2c05f` |
|---|---|---|
| `server.ts` `app.use(cors())` | :14 | **:18** |
| `server.ts` `startScheduler()` | :72 | **:88** |
| API test count | 370 | **372** |
| `platform/*` file count | 14 | **15** |
| `createForms.tsx` `role=sponsor` | :881 | **:878** |

If a citation does not match, re-locate it — do not assume the plan describes a different file.

## Three decisions needed before Phase 1

Not engineering decisions; do not default them silently.

**A. Multi-entity.** `CompanyProfile.tenantId` is `@unique` (`schema.prisma:81`) — one tenant is one registered company. Kaizen has two branches, a separate WFaaS business and a planned JV. Retrofitting `entityId` onto a journal with history is the most expensive migration in this plan. **Put it on the journal now even with one entity.** A column today; a quarter later.

**B. GSP vs direct IRP.** Direct NIC access whitelists four static IPs per GSTIN at ~₹5 lakh all-in — it does not scale to a tenant roster and fights elastic infrastructure. **Go GSP.** Commercial decision with a monthly cost; gates Phase 3.

**C. Tenant-zero or product.** If Kaizen is the customer: hardcode Tamil Nadu, ship faster. If the product is the point: PT per local body from line one, versioned statutory packs, onboarding as a state machine on day one. **This plan assumes the second** — ~25% more work, and the difference between an internal tool and an asset.

## Done means

1. 10,000 random operations; trial balance sums to zero after every one.
2. Legacy `Transaction` replay equals old cashbook balances to the paisa.
3. 200 concurrent allocations against one payment allocate exactly the available amount.
4. 200 concurrent emissions in one tenant; `verifyChain()` clean.
5. Leakage fuzzer: every route, job, cache key and export, tenant A's token + tenant B's ids → 404.
6. `UPDATE`/`DELETE` on a posted journal line fails at the DB as the app role.
7. 200+ golden questions per module, scored on exact numeric match, including fan-out, NULLs, FY boundaries, leakage probes and injection payloads in note fields.
8. Zero axe-core violations; Lighthouse a11y ≥ 95.
9. Full invoice flow usable at 390px.
10. Monthly automated restore from the India-region backup reproduces a bit-identical trial balance.
11. Every `<Metric>` carries `drillTo` or `noActionReason`, enforced by the type system.

## Not verifiable from this repository

Flagged so they are not mistaken for checked facts:

- **The Kaizen book figures** the Phase 1.5 gate depends on — 1 Feb–27 Aug 2026, 1,123 vouchers, 66 ledger accounts, the ~₹40,500 inherited reconciliation gap, the 12-person roster at ₹2,15,000/month. **Confirm with a human before relying on that gate**; it is what decides when `model Transaction` may be deleted.
- Every statutory claim in Phase 3. Legal facts, not codebase facts. The riskiest carry ⚠️.
- The Spider 1.0/2.0 benchmark figures in Phase 5.
- The Platform Canon at `A:\Kai-ZEN\OS` — outside the repo, and nothing in `docs/` references it. Phase 0 copies it into `docs/canon/`.
