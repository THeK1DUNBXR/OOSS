> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 2 — The audit spine

**Duration:** two weeks. **Gate:** an external reviewer can be handed a tenant's audit export and verify it independently.

## 2.1 Rule 3(1)

The Companies (Accounts) Rules require, for every company using accounting software: an audit trail of **each and every** transaction, an edit log of each change **with the date**, and that **the audit trail cannot be disabled**. The statutory minimum for the edit log is the date; record user ID, timestamp, old value and new value, because that is what auditors actually ask for.

"Cannot be disabled" is a storage-layer requirement, not a middleware feature. If a privileged operator of your SaaS can turn it off for a tenant, you have failed the rule and so has every tenant.

The Phase 1 design gives you most of this free: posted journal entries have no `UPDATE` grant, so there is nothing to disable. What remains:

- A hash-chained `AuditRecord` over the mutable business layer, using the same chain machinery as `eventBus.ts` (with the Phase 0 race fix).
- Write the chain from a **database trigger**, not from application code, on every table classified as books-of-account. A trigger cannot be bypassed by a forgotten `auditWrite` call — which is exactly the failure currently present in `domains/books.ts`.
- An append-only store with an 8-year retention policy that **survives tenant churn**. Section 128(5) requires retention for not less than eight financial years, and your offboarding process must not delete it. Offer a signed export on termination and say so in the contract.
- `verifyAuditChain(tenantId, from, to)` exposed as an admin endpoint and run nightly.

## 2.2 DPDP

The DPDP Rules were notified on 14 November 2025 and the substantive obligations — consent and notice, breach reporting, security safeguards, data-principal rights, children's data, retention limits — commence on **14 May 2027**. That is one product cycle away. Retrofitting consent and erasure into a live ERP is brutal; do it now.

- **`ConsentLedger`** — append-only: `dataPrincipalId`, `purpose`, `noticeVersion`, `channel`, `givenAt`, `withdrawnAt`, `evidence`. Withdrawal must be as easy as giving consent, and must suppress across every module.
- **Purpose tagging on columns.** Extend the existing classification machinery in `permissions.ts` (which already has a WHAT axis and a regulated-key list) with a purpose tag per field, and a generated per-data-subject data map.
- **Rights endpoints**: `export-my-data` (a summary of the data, the processing, and the recipients), `correct`, `erase`. Erasure must interact correctly with the 8-year audit retention — resolve this deliberately: keep the audit trail in a separately-keyed store with its own retention policy, and put the conflict in the contract.
- **Breach workflow**: initial intimation to the Data Protection Board without delay, detailed report within **72 hours**, and notification to affected principals in plain language with nature, extent, timing, likely consequences, mitigation taken, steps the individual should take, and a named responder's business contact. Penalties run to ₹200 crore for notification failure and ₹250 crore for inadequate safeguards. Build it as a runbook plus a workflow, not a policy document.
- **Log retention ≥ 1 year** (Rule 6). Your Phase 0 `pino` output needs a retention destination.
- **Children.** The education module is the sharp edge: student records are usually children's data, which requires **verifiable parental or guardian consent** with the verification artefact retained, a guardian-linked account model, and a hard product-level ban on tracking, behavioural monitoring and targeted advertising in the student-facing surface. Do not put a marketing analytics SDK in the student portal.
- **HRM** has "legitimate uses" relief for employment purposes under s.7(i), so core payroll does not need consent — but notice, security, breach reporting, retention and rights all still apply.
- **Your LLM provider is a cross-border transfer.** An inference API in a US region receiving employee or student data is a data transfer, and the Rules permit government restriction of transfers to specified countries. Phase 6 must account for this: either an India-region inference endpoint, or field-level redaction before the call, or both.
