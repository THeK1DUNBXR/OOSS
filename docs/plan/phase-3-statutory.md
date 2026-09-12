> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 3 — Statutory India

**Duration:** six to eight weeks. Largest phase. Gate is per-module.

## 3.1 The statutory master pack — build this first

Every parameter below is date-effective and versioned. **Not one of them may be a constant in a TypeScript file.** Every single one changed in the last eighteen months.

```prisma
model StatutoryRule {
  id         String   @id @default(cuid())
  /// Null tenantId = a platform-wide rule shipped in the pack.
  tenantId   String?
  domain     String   // gst | tds | pf | esi | pt | gratuity | bonus | labour
  key        String   // "pf.wage_ceiling" | "pt.tn.madurai_corp.slabs" | "gst.rate.998313"
  jurisdiction String // "IN" | "IN-TN" | "IN-TN-MADURAI"
  effectiveFrom DateTime @db.Date
  effectiveTo   DateTime? @db.Date
  value      Json
  source     String   // notification number / circular / gazette reference
  @@index([domain, key, jurisdiction, effectiveFrom])
}
```

Seed it with a versioned pack. The values you need, as of September 2026, with their known uncertainties:

- **GST rates.** Slabs were rationalised to **0 / 5 / 18** with a **40%** demerit rate effective **22 September 2025**. Your tax engine must be date-effective *per rate*, not a current-rate-per-HSN, because you will be issuing credit notes and amendments against pre-22-September-2025 invoices for years.
- **PF.** Wage ceiling is **₹15,000**. **Do not build ₹25,000.** Media reported a hike effective July 2026; legal analysis of the EPF Scheme 2026 (notified 29 June 2026) says Cabinet approval and gazette notification are still pending and the ceiling remains ₹15,000. Make it a date-effective row so the change is a data update. Splits: employee 12% → EPF; employer 12% → EPS 8.33% capped at the ceiling, balance to EPF; plus EDLI 0.5% and admin 0.5%. ECR by the 15th. **New schema requirement from the EPF Scheme 2026: statutory and voluntary contributions must be separately identifiable in payroll and in filings — add the split column now.**
- **ESI.** 10+ employees. Ceiling ₹21,000 (₹25,000 for employees with disability). Employer 3.25% + employee 0.75%. Payment by the 21st. Contribution periods Apr–Sep and Oct–Mar; **an employee crossing the ceiling mid-period continues contributing until the period ends** — model the period, not the month.
- **Professional tax, Tamil Nadu.** TN is unusual: PT is levied and collected by **local bodies** under the TN Municipal Laws (Second Amendment) Act 1998, so Kaizen registers with **Madurai Corporation** and rates vary by municipality. Half-yearly slabs on half-yearly income: ≤21,000 nil; 21,001–30,000 → ₹100; 30,001–45,000 → ₹235; 45,001–60,000 → ₹510; 60,001–75,000 → ₹760; >75,000 → ₹1,095. Max ₹2,190/year. Due 30 September and 31 March. **Model this per local body from the first line of code.** It is the most state-fragmented thing in Indian payroll and a multi-tenant product cannot hardcode Tamil Nadu.
- **Labour Codes.** All four are **in force from 21 November 2025**, repealing 29 central Acts. Central draft rules published 30 December 2025. **Tamil Nadu state rules were still in draft as of the research for this brief — verify current status with the TN Labour Department before go-live.** The payroll-critical rule is the wage definition: excluded allowances cannot exceed **50% of total remuneration**, and the excess is **deemed to be wages**, pulling into PF, gratuity, bonus and leave-encashment bases. So: a per-component "included in wages?" flag, an automatic 50%-deeming reclassification each period, and **separate wage bases per statute — PF wage, ESI wage, gratuity wage and bonus wage are no longer the same number.**
- **Gratuity** now sits under the Social Security Code. 15/26 × last-drawn wages × completed years, five years' continuous service — **except fixed-term employees, who get pro-rata with no five-year threshold.** Cap ₹20 lakh. Book the accrual monthly as a provision.
- **TDS.** The **Income-tax Act 2025 replaced the 1961 Act with effect from 1 April 2026.** "Assessment Year" is gone, replaced by "Tax Year". Sections are consolidated: **s.392** salary, **s.393** all other deductions, **s.394** TCS — the 192/194C/194J/194I/194H numbering no longer exists. Income-tax Rules 2026 were notified by Notification 22/2026 dated 20 March 2026. Forms are renumbered (reportedly 16→130, 16A→131, 24Q→138, 26Q→140, 27Q→144, 26AS→168) and **all FVU codes were reassigned, so any existing TDS return-generation code is dead.** ⚠️ **The form-renumbering table is from tax-media reporting, not read from the gazette. Read Notification 22/2026 / Appendix III directly before generating any certificate.**

Write a `statutory-pack` CLI that diffs a new pack against the installed one and reports what changes for which tenants. This is a product feature: your competitors' customers find out about a rate change from their auditor.

## 3.2 E-invoicing

Go through a **GSP**. Direct NIC API access whitelists up to four static public IPs per GSTIN at roughly ₹5 lakh all-in, which does not scale to a tenant roster and fights elastic infrastructure.

- IRN is **not** issued by the government — it is a SHA-256 of `Supplier GSTIN + FY(YYYY-YY) + Document Type + Document Number`. You compute the INV-01 JSON, POST it, the IRP validates and dedupes on that hash, signs, and returns the signed payload, the IRN and a **signed QR code** which must be printed on the invoice.
- **The 30-day reporting limit is a hard business rule, not a reminder.** Documents must reach the IRP within 30 days of document date, and the IRP hard-rejects anything older — there is no late filing, and no IRN means no valid tax invoice and a broken input-tax-credit chain for the buyer. So: block back-dating beyond 30 days in the UI for e-invoice-liable tenants; escalate at T+25; dead-letter queue and paging alert on IRP failures. The threshold is AATO ≥ ₹10 crore for the 30-day rule (from 1 April 2025) and AATO > ₹5 crore for e-invoicing itself. Applies to B2B, exports, deemed exports, SEZ and B2B credit/debit notes — not B2C.
- **IRN can be cancelled within 24 hours only.** After that the correction is a credit note. This is exactly why the Phase 1 ledger is append-only — the compliance model and the engineering model are the same model.
- Cache and refresh the auth token per tenant, never per request. 2FA is mandatory on the portal.
- **Build the dual-instance failover.** Since July 2024 NIC runs interoperable e-invoice-1/e-invoice-2 and ewb-1/ewb-2 with the same credentials. It is the single highest-value resilience feature available and it is nearly free.
- E-way bill for goods-trading tenants: >₹50,000 consignment value; validity 1 day per 200 km from Part-B entry; **since 1 January 2025, no EWB against a document dated more than 180 days prior, and total validity including extensions capped at 360 days.**

⚠️ Verify the live schema and API version against the NIC sandbox before coding. The notified schema is INV-01 v1.1 and the API is v1.03, but NIC ships silent validation changes without renumbering.

## 3.3 Returns

- **GSTR-1 Table 12/13, Phase 3 (from May 2025):** manual HSN/SAC entry is removed — it must be picked from a portal-supplied dropdown, 4 digits for AATO ≤ ₹5 Cr and 6 digits above. Table 12 is split into B2B and B2C tabs. **Table 13 — summary of documents issued, with series ranges — is mandatory.** So HSN/SAC becomes a validated master, not free text; document series must be gapless *and tracked per series*; and B2B/B2C classification must be reliable at line level.
- **GSTR-3B is hard-locked.** Tables 3.1 and 3.2 auto-populate from GSTR-1/1A/IFF and have been non-editable since the July 2025 period; Table 4A (ITC) auto-populates from GSTR-2B and locks from the July 2026 period. **Therefore GSTR-1A is now the only correction path for outward liability within a period, and it must be a first-class product workflow, not a support ticket.**
- **IMS.** Live since 14 October 2024. Accept / Reject / Pending per supplier document; GSTR-2B generates on the 14th from accepted plus no-action documents; **no action is deemed acceptance**; actions after the 14th roll forward. Only IMS-accepted invoices flow to 2B and therefore only those become claimable ITC. Build IMS reconciliation as a daily job with a worklist surface. ⚠️ Reports that IMS action became mandatory from 1 April 2026 come from tax media; the underlying CBIC notification was not located. Verify before putting it in product copy.

## 3.4 Payroll

Rebuild `apps/api/src/domains/payroll.ts` on the statutory pack. A payroll run becomes: resolve wage components per employee → apply the 50% deeming rule → compute each statutory wage base separately → compute PF/ESI/PT/TDS → produce a payslip → **post one balanced journal entry per run** through `platform/ledger.ts` → generate ECR, ESI and 24Q-successor files.

Run both the old and the new income-tax regimes with the new as default. Support investment declarations and proof verification, s.87A rebate, surcharge and cess, and Q4 year-end true-up.

Seed from the real roster already documented: twelve employees, ₹2,15,000 monthly gross, divisions from HR codes KI/KE/KD/KCS/KM.

## 3.5 Other statutory outputs

- **MSME-1**: flag MSME-classified vendors and age their invoices against the **45-day** limit — half-yearly filing on 30 April and 31 October, and s.43B(h) disallows the income-tax deduction if unpaid. Put the 45-day clock in the AP ageing view.
- **MCA**: AOC-4 within 30 days of AGM, MGT-7 within 60, ADT-1 within 15, DPT-3 by 30 June, DIR-3 KYC by 30 June. Penalty for AOC-4/MGT-7 default is ₹100/day, uncapped. Generate the data, not the filing.
