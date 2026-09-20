> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 8 — Proof

Continuous, from Phase 1 onward.

- The ten CI gates in `00-BRIEF.md §5`.
- **Concurrency tests**, because the existing 370-test suite is serial by construction (correctly — gaplessness and chain continuity are ordering claims) and therefore **every concurrency defect in this plan is invisible to it**. Add a parallel suite specifically for races.
- **A tenant-leakage fuzzer** that walks every route, every background job, every cache key and every export path with tenant A's token and tenant B's identifiers.
- **Load tests** at ten times projected peak, with payroll and month-end close running concurrently against interactive traffic.
- **A monthly automated restore drill** from the India-region backup into a clean environment, asserting a bit-identical trial balance. Note the RLS trap: `pg_dump` run as the table owner can export **zero rows** under RLS, and logical replication can ship nothing. **Test the restore, not the backup.**
- **SOC 2 Type II and ISO 27001.** Your customers' auditors must report under Rule 11(g) whether the audit trail existed, operated throughout the year for all transactions, was not tampered with, and was preserved. SOC 2 Type II is how vendors evidence that. Budget for it before selling to any company with a real auditor.
- An annual independent penetration test.
