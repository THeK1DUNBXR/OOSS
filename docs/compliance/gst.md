# GST completion (workstream B)

What this workstream built against `docs/plan/compliance.md`'s section B, and
the test that pins each requirement. Tests live in
`apps/api/src/tests/compliance/gst.test.ts` unless noted.

## 1. Supply classification (CMP-GST-001)

`InvoiceLine.supplyType` (`taxable | nil | exempt | non_gst`) and
`exemptionNotification` (both on `main.prisma`, already present before this
workstream started). `priceLines` (`domains/invoicing.ts`) defaults a course
line to `exempt` — notification `12/2017-CT(R) entry 66` unless the course's
own `CourseGstExemption` row names another — only when nothing was said
explicitly and the course carries an active exemption. A nil/exempt/non-GST
line always carries `gstRate 0` and `taxAmount 0`: enforced in `priceLines`,
in `classifyInvoiceLine` (`domains/compliance/gst.ts`), and again in the
`invoice.before_issue` hook as the last gate before a document exists.

`GET /compliance/gst/classification/unclassified` lists draft lines billing
an exempt-flagged course still marked taxable (added before the flag was set,
or entered by hand). `PATCH
/compliance/gst/invoices/:invoiceId/lines/:lineId/classify` sets a line's
classification on a draft invoice and recomputes the invoice's totals.

GSTR-1 and GSTR-3B (`domains/gstReturns.ts`) report nil/exempt/non-GST lines
in their own rows (`nil.nilRated/exempted/nonGst`,
`otherOutwardSupplies.nilRatedAndExempt/nonGst`) read from each line's
`supplyType`, and exclude them from taxable turnover
(`outwardSupplies.taxableValue`, `totals.taxableValue`) — replacing the
former hard-coded zeros and the 0%-rate heuristic.

A `bill_of_supply` invoice (Rule 49) is derived, not asked for: the
`invoice.before_issue` hook sets `Invoice.invoiceType` to `bill_of_supply`
when every line is non-taxable or the company is on the composition scheme
(`CompanyProfile.compositionScheme`), else `tax_invoice`. A composition
tenant is refused outright if any line still carries tax at issue —
composition dealers do not charge GST at all (Sec 10). `InvoiceDocument.tsx`
prints "Bill of Supply" instead of "Tax Invoice" from this field, and prints
"Tax payable: Reverse charge (recipient)" when `Invoice.reverseCharge` is
set (Rule 46(p)).

Pinned by: `CMP-GST-001` (two tests — the exemption default and turnover
exclusion, and `classifyInvoiceLine`'s zero-tax enforcement) and the
composition-refusal test.

## 2. Reverse charge on inward supplies (CMP-GST-002)

`POST /compliance/gst/vendor-bills/:id/rcm` (`applyReverseCharge`) takes a
rate, sets `VendorBill.rcmApplicable`/`rcmTaxAmount`, and creates an
`RcmSelfInvoice` row (this workstream's model: `billId`, a gapless number on
its own sequence key `CMP:RCM`, `period`, and the tax split by place of
supply via `computeGst` — the same intra/inter-state reading credit already
uses). `GET /compliance/gst/rcm/self-invoices` and
`/compliance/gst/rcm/flagged-bills` list them.

`computeGstr3b`'s `otherOutwardSupplies.reverseCharge` (what the offline
JSON's `isup_rev` block reports, table 3.1(d)) now reads from
`RcmSelfInvoice` rows for the period — the block was previously hard-coded
zero and, before this workstream, wired to the wrong field entirely. The same
tax is added into that period's input tax credit (`inputTaxCredit`) before
the statutory set-off, since Sec 16 makes RCM tax actually paid eligible for
credit in the same return rather than a later one.

Pinned by: `CMP-GST-002`.

## 3. Debit notes and credit-note reasons (CMP-GST-003)

`DebitNote` (this workstream's model) mirrors `CreditNote`: `invoiceId`,
`amount`, a mandatory `reasonCode` from
`NOTE_REASON_CODES` (`packages/shared/src/compliance/gst.ts` — `rate_difference
| quantity_shortfall | post_supply_price_revision | other`), and its own
gapless series (`DOCUMENT_SERIES.debitNote`, `'D'`, already declared in
`platform/documentNumber.ts`). `issueDebitNote` /
`POST /compliance/gst/invoices/:id/debit-note`; `listDebitNotes`.

`finance.ts`'s `issueCreditNote` moved off the generic `REC` sequence onto
the `'C'` document series (kept backward-compatible: existing callers that
don't pass a reason code still work). Since `CreditNote` itself carries no
structured reason field and `main.prisma` is not this workstream's to edit,
the code is kept on `CreditNoteReason` (`creditNoteId` unique), settable at
issue or after via `setCreditNoteReason` /
`PATCH /compliance/gst/credit-notes/:id/reason`.

Both flow into GSTR-1's `creditNotes`/`debitNotes` arrays — two tables with
their own sign, not a debit note as a negative credit note.

Pinned by: `CMP-GST-003` (series distinctness and gaplessness, the mandatory
reason, and both flowing into GSTR-1).

## 4. E-invoicing (CMP-GST-004)

An adapter boundary, `EInvoiceProvider` (`registerIrn(invoice) => {irn,
ackNo, ackAt, signedQr}`), with `NotConfiguredProvider` as what every fresh
tenant has — the posture `payroll.ts` already takes toward an external
engine. Provider selection is stored on `EInvoiceConfig` (provider name plus
a credentials *reference* only — no secret lives in this row).
`registerEInvoiceProvider` is the deployment/test seam that swaps a real
adapter in without touching callers.

`POST /compliance/gst/invoices/:id/einvoice` (`requestEInvoice`) returns the
named error `EINVOICE_NOT_CONFIGURED` when nothing is configured, rather than
silently leaving IRN/QR blank. The `invoice.before_issue` hook sets
`Invoice.eInvoiceStatus` to `pending` when `CompanyProfile.eInvoicingApplicable`
and `not_applicable` otherwise, at issue — before this workstream the field
existed on the schema but nothing ever wrote to it.

Pinned by: `CMP-GST-004`, plus a configured-provider test.

## 5. GSTR-2B reconciliation

`Gstr2bImport` (period, the offline JSON's `b2b` rows verbatim) and
`Gstr2bMatch` (one row per vendor bill or unmatched 2B row: `matched |
missing_in_2b | missing_in_books | mismatch`, and the tax difference).
`POST /compliance/gst/gstr2b/:period/import` accepts the offline shape
(`ctin`, `inum`, `idt`, `val`, `itms`), matches on vendor GSTIN + bill
number (`matchGstr2b`, pure, `packages/shared/src/compliance/gst.ts`), and
persists the outcome. `GET /compliance/gst/gstr2b/:period/summary` reports
eligible ITC per the 2B upload against what the books have claimed.

Pinned by: the GSTR-2B reconciliation test (all four outcomes).

## 6. Late fee and interest

A dated `GstRateTable` (`lateFeePerDayCgst`, `lateFeePerDaySgst`, `cap`,
`interestPct`, plus each return type's due day — also notified figures, not
constants), seeded once per tenant. Pure arithmetic in
`packages/shared/src/compliance/gst.ts`: `lateFee(daysLate, rates)` (capped)
and `interest(netCashTax, daysLate, pct)` (simple interest, Sec 50(1)).
`GET /compliance/gst/exposure/:period` (`gstExposure`) reads the current
rate table and today's date against each return's `GstFiling`. A daily job
(`jobs/compliance/gst.ts`) raises `CMP_GST_LATE_GSTR1`/`CMP_GST_LATE_GSTR3B`
exceptions for the last three months' unfiled, overdue returns, owned by the
finance_head affiliation (resolved by role slug, falling back to the
chairman — data, not a role check in business logic).

Pinned by: the late-fee/interest arithmetic test and the exposure-endpoint
test.

## Web

`apps/web/src/pages/compliance/Gst.tsx` (`ComplianceGst`, routed at
`/compliance/gst`): six tabs — Classification, Reverse charge, Notes,
E-invoicing, GSTR-2B, Exposure — each a thin view over the endpoints above.
States what the platform does not do the same way the returns screen
already does: prepares, does not transmit.

## What was not built

- **E-way bill** (Rule 138): the plan names it as gated on goods vs.
  services, and the open question ("are any goods, not services, sold") was
  not answered in this pass. Nothing was built; nothing pretends to be a
  no-op either.
- **Zero-rated (export/SEZ) supplies**: `otherOutwardSupplies.zeroRated`
  still reads zero — nothing in this platform marks a supply that way, and
  the return says so rather than implying a measurement.
- No field was wanted on `main.prisma` beyond what was already added before
  this workstream started.
