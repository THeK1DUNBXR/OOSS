# Invoicing, receipts and the GST returns

Three documents, one numbering scheme, and one rule that decides most of the
design: **a tax invoice is final**.

---

## The three documents

A customer paying in instalments needs three different things handed to them,
and the platform used to produce one.

### The tax invoice

Raised once, priced when it is raised, and never changed afterwards. It states
the whole obligation and what was handed over on the day.

Tax is computed **per line**, because one invoice can carry an 18% service and a
5% good and halving the total would misstate both. The split follows from where
the supply was made — CGST and SGST within the state, a single IGST across a
state line — and it is *stored*, not recomputed at render time: the invoice was
raised under one reading of the place of supply, and reprinting it must not
silently restate the tax if that reading later changes.

The document prints two figures side by side, and both even when they are equal:

- **Total payable** — the whole obligation.
- **Amount payable now** — what is being collected as it is handed over.

and says which of three things it is: *full payment*, *part payment* or *payable
on credit*, with the mode of payment beside it. On a full payment the two figures
are the same number and it is still printed twice, because a customer should not
have to work out which of the two they are looking at.

A draft is editable. An issued invoice is not: changing the lines or the tax on a
document the customer holds would make two different invoices with one number,
and the answer to that is a credit note.

### The receipt

Every instalment against an issued invoice produces one. Its own number, its own
time, the invoice it is against, the amount, the mode and the balance it left.

Those figures are **snapshotted onto the receipt row** rather than recomputed at
print time. A receipt saying "₹20,000 of ₹70,800, ₹50,800 still owed" has to keep
saying that after the next instalment lands — which is the whole reason a receipt
is a document and not a view of the current position.

`RECEIPT` was always the allocation join, and always made part payment
representable in the ledger. What was missing was that it is also a document.

### The final invoice

Raised once the instalments are done. Neither of the other two can answer the
question a customer asks at the end — *what did I owe, what have I paid, and
against which receipts* — because the invoice predates the payments and each
receipt only knows about itself.

So this names them all: the total payable, every instalment with its receipt
number and date, what has been received, and what is left. It restates what was
billed so it stands on its own without the invoice beside it.

Raising a second one after a further instalment **supersedes** the first rather
than replacing it. Both were true when they were handed over.

---

## Numbering

Every customer-facing document carries the company's own number:

```
KIPL / I / 26-27 / 001
 │     │     │      └── sequence, restarting each financial year
 │     │     └───────── the financial year, April to March
 │     └─────────────── the series: I invoice, R receipt, F final invoice
 └───────────────────── the company's short code
```

Three properties make this more than string formatting.

**Gapless within the year.** A tax invoice series has to be consecutive: GSTR-1
reports the range issued and the count cancelled within it, and a number nothing
explains is a question at an audit. The atomic increment is the same one the
record codes use, so two invoices raised in the same millisecond cannot take one
number.

**Allocated at issue, not at creation.** A draft carries a reference from its own
series — `DRF-2026-00004`, obviously not an invoice number — and takes a real
number at the moment it becomes a document. A number sitting on a draft somebody
abandoned is a gap the return cannot explain.

**It can start where the paper series stopped.** A company adopting the platform
mid-year has already issued fifteen receipts by hand; starting again at 001 would
put two documents into the world with one number. *Company details → Document
numbering* shows the next number in each series and sets it forwards.

### The sixteen-character limit

The portal accepts a tax invoice number of **at most sixteen characters**.
`KIPL/I/2026-27/001` is eighteen: correct on paper, rejected by GSTR-1.
`KIPL/I/26-27/001` is exactly sixteen, which is why the short year is the
default — a default that cannot be filed is not a default.

The full year stays available for a company with a shorter prefix. The Company
details screen prints the next number in each series **with its length**, so this
is seen before the first invoice rather than at the filing deadline.

---

## What invoicing owes the returns

The two are one system. Every figure GSTR-1 reports comes from an invoice, and
every check the return runs is about something the invoice screen could have got
right:

| The return needs | The invoice provides |
|---|---|
| A number, consecutive, ≤16 characters | The company series, allocated at issue |
| A customer GSTIN that validates | Checked on the way in, on the account rather than retyped per sale |
| B2B or B2C | Read from whether the registration is real, never a tick box |
| A place of supply | From the customer's GSTIN, then the account, then our own state |
| CGST+SGST or IGST, never both | Derived from the two state codes, stored on the invoice |
| An HSN/SAC on every line | From the course or offering being billed |
| A rate and a taxable value per line | Priced per line at creation |
| The range issued and the count cancelled | Drafts take no number; a void invoice is reported as cancelled |

A line with no HSN is accepted by the books and rejected by the portal. The
returns screen lists everything in that state **above the figures**, naming the
invoices behind each finding, because the filing deadline is the worst possible
moment to find out.

---

## Filing

Three acts, deliberately separate.

**Compute.** GSTR-1 and GSTR-3B from the books, on demand, for any month. Free,
repeatable, and never written down.

**Prepare.** Snapshots the figures as they stand, with its findings on it. A
return that could not be filed *can* be prepared — preparing is arithmetic, and
seeing the blockers is the reason to do it. Preparing again supersedes the
earlier preparation rather than overwriting it, so "what did we think the
liability was last week" stays answerable.

**File.** Records the portal's acknowledgement. This is the one that bites:

- It **refuses** while any blocking check stands. Recording a filing closes the
  month, and a closed month on a return that never went through is the worst of
  both: the books refuse corrections and the government has nothing.
- It requires an **ARN**. A return with no acknowledgement was not filed,
  whatever anybody remembers.
- It **closes the period**. An invoice dated inside a filed month can no longer
  be edited or voided; the lawful correction to an invoice already reported is a
  credit or debit note in the current period.
- It **stamps the invoices** it reported, so "which return was this in" is a
  question the invoice itself can answer — the first thing asked when a customer
  says the credit never arrived.

### What this platform does not do

It prepares returns; it does not transmit them. There is no GSP integration
behind this, and a "File now" button that only wrote a row would be worse than
the honest split. The JSON download is the offline utility's file, in the shape
the portal accepts, and `File` records what came back.

### The arithmetic worth knowing about

Input credit is set off **head by head, in the statutory order**: IGST credit
against IGST first and only then against CGST and SGST; CGST credit against CGST
alone. Netting the totals — output minus input — produces a figure that is too
small whenever the mix differs, and the shortfall is discovered as interest. The
order lives in `packages/shared/src/finance.ts` as pure arithmetic, with tests
that need no database.

---

## Where it lives

```
packages/shared/src/finance.ts    GST arithmetic, the set-off order, GSTIN
                                  validation, rupees in words — all pure
apps/api/src/platform/
  documentNumber.ts               the company's series
apps/api/src/domains/
  companyProfile.ts               who the company is, on paper
  invoicing.ts                    the obligation: draft, price, issue, collect,
                                  void, and the printable document
  receipts.ts                     receipts, and the final invoice
  finance.ts                      payments, allocation, credit notes
  gstReturns.ts                   GSTR-1, GSTR-3B, the checks, prepare and file
apps/web/src/
  components/invoiceEditor.tsx    raising and correcting one
  pages/documentSheet.tsx         the look of a document somebody is handed
  pages/InvoiceDocument.tsx       the tax invoice
  pages/ReceiptDocument.tsx       receipts
  pages/FinalInvoiceDocument.tsx  the final invoice
  pages/GstReturns.tsx            the returns, and Company details
```
