# Archive: superseded phase plan

Everything in this folder was the repo's original P0 to P8 plan. It was superseded on 2026-10-11 by the owner's plan in `docs/plan/zen360/`. Files here are kept for item specs and history. They are not an instruction source.

**Source of truth:** `docs/plan/zen360/ORDERED-PLAN.md`, with `docs/plan/zen360/ROADMAP.md` for stop rules and the deferred list, and `docs/plan/zen360/DECISIONS.md` where any of them differ (DECISIONS governs).

## Naming

- Only two phases exist now: **owner Phase 0** (streamline and fix, in waves) and **owner Phase 1** (developers can work from home). Deferred work has no phase.
- Old labels `P0` to `P8` are retired. Do not use them in new work.
- Old item numbers (`0.7`, `1.6`, `3.1`, `4.2a` and so on) remain valid references. Look them up in the file named below, and find the owner wave they now sit in with the table.
- Old `docs/plan/*.md` paths in DECISIONS.md rounds before round 17 point to files in this folder. Round 17 records the move.

## Files in this folder

| File                      | What it was                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `README-old-index.md`     | The old index (`docs/plan/README.md` before 2026-10-11). Renamed here because `archive/README.md` is this page. |
| `phase-0-stabilise.md`    | Old P0, items 0.1 to 0.8                                                                                        |
| `phase-1-ledger.md`       | Old P1, items 1.1 to 1.6                                                                                        |
| `phase-2-audit.md`        | Old P2, items 2.1 and 2.2                                                                                       |
| `phase-3-statutory.md`    | Old P3, items 3.1 to 3.5                                                                                        |
| `phase-4-interface.md`    | Old P4, items 4.1 to 4.6 (including 4.2a)                                                                       |
| `phase-5-semantic.md`     | Old P5, items 5.1 to 5.3                                                                                        |
| `phase-6-intelligence.md` | Old P6, items 6.1 to 6.5                                                                                        |
| `phase-7-product.md`      | Old P7, product and tenancy items                                                                               |
| `phase-8-proof.md`        | Old P8, proof and assurance items                                                                               |
| `sequencing.md`           | Old staffing and order notes                                                                                    |
| `rationale.md`            | Old reasoning for the P0 to P8 shape                                                                            |
| `prompts.md`              | Old kick-off prompts, one per old phase                                                                         |

## Mapping: old phase to owner plan

Derived only from `ORDERED-PLAN.md` and `ROADMAP.md`. "Deferred" means ROADMAP section 2 lists it as not in Phase 0 or Phase 1. Rows marked UNVERIFIED are the mapper's inference, not stated in either document.

| Old | Old item                                                                         | Owner position                 | Where it sits                                                                                      |
| --- | -------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| P0  | 0.1 Secrets and boot assertions                                                  | In plan                        | Phase 0, Wave 0 (item 0.1)                                                                         |
| P0  | 0.2 Session hardening                                                            | In plan                        | Phase 0, Wave 1                                                                                    |
| P0  | 0.3 HTTP hardening                                                               | In plan                        | Phase 0, Wave 1                                                                                    |
| P0  | 0.4 Structured logging                                                           | In plan                        | Phase 0, Wave 1                                                                                    |
| P0  | 0.5 The scheduler                                                                | In plan                        | Phase 0, Wave 2                                                                                    |
| P0  | 0.6 The correctness fixes (hash chain, `verifyChain`, audit gaps)                | In plan                        | Phase 0, Wave 2; the task-complete fix and FX-xx items sit in Wave 1                               |
| P0  | 0.7 Split the schema, and build the map                                          | In plan                        | Phase 0, Wave 0                                                                                    |
| P0  | 0.8 CI                                                                           | In plan                        | Phase 0, Wave 0                                                                                    |
| P1  | 1.1 to 1.5 Ledger models, migration, posting, balances, cashbook migration       | In plan                        | Phase 0, Wave 3 (serial, one person)                                                               |
| P1  | 1.6 Money everywhere                                                             | In plan                        | Phase 0, Wave 3 (`money.ts`, bigint)                                                               |
| P2  | 2.1 Rule 3(1) audit spine                                                        | Deferred                       | ROADMAP section 2                                                                                  |
| P2  | 2.2 DPDP                                                                         | Deferred                       | ROADMAP section 2                                                                                  |
| P3  | 3.1 Statutory master pack                                                        | In plan, pulled early by owner | Phase 0, Wave 1 (BLOCKED-BY statutory sign-off)                                                    |
| P3  | 3.2 E-invoicing                                                                  | Deferred                       | ROADMAP section 2                                                                                  |
| P3  | 3.3 Returns, 3.5 other outputs                                                   | Deferred                       | ROADMAP section 2                                                                                  |
| P3  | 3.4 Payroll                                                                      | Partly in plan                 | Payroll posts liabilities (FX-73) in Phase 0, Wave 5, BLOCKED-BY statutory sign-off. Rest deferred |
| P4  | 4.2a Make the `Metric` rule real                                                 | In plan                        | Phase 0, Wave 5, item 1 (`MetricProps` discriminated union)                                        |
| P4  | 4.1, 4.2, 4.3, 4.6 Foundations, design system, accessibility, frontend tests     | In plan                        | Phase 0, Wave 5, items 2 to 9. Which sub-item maps to which numbered item: UNVERIFIED              |
| P4  | 4.4 Mobile                                                                       | Deferred                       | ROADMAP section 2                                                                                  |
| P4  | 4.5 Feel                                                                         | UNVERIFIED                     | Not named in ORDERED-PLAN or ROADMAP                                                               |
| P5  | 5.1 to 5.3 Semantic layer, eval harness                                          | Deferred                       | 5.2 undecided; 5.3 eval harness dropped (ROADMAP section 2)                                        |
| P6  | 6.1 to 6.5 Intelligence layer                                                    | Deferred, all dropped for now  | ROADMAP section 2                                                                                  |
| P7  | Onboarding state machine and per-state packs                                     | In plan                        | Phase 0, Wave 6 (BLOCKED-BY 3.1 sign-off)                                                          |
| P7  | Tiering, noisy-neighbour, India residency controls, billing, real API deployment | Deferred                       | ROADMAP section 2                                                                                  |
| P8  | Concurrency suite, tenant-leakage fuzzer                                         | In plan                        | Phase 0, Wave 7                                                                                    |
| P8  | CI gates                                                                         | In plan                        | Phase 0, Wave 7 (all twelve, per `zen360/CI-GATES-DRAFT.md`)                                       |
| P8  | Load tests, monthly restore drill, SOC 2, ISO 27001, penetration test            | Deferred                       | ROADMAP section 2                                                                                  |

## Other archived files

- `sequencing.md`: staffing and order. ORDERED-PLAN does not restate staffing. Its status is UNVERIFIED.
- `rationale.md`: background to the old shape. Not an owner position. Status UNVERIFIED.
- `prompts.md`: kick-off prompts keyed to old phase files. Superseded with the files they name. Do not reuse without rewriting against ORDERED-PLAN.
- `README-old-index.md`: the old reading order. Superseded by `docs/plan/README.md`.
