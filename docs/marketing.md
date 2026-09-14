# Marketing

Bounded context `mkt`. Health domain `H_MKT`. Event prefix `kz.mkt.<entity>.<verb>`.
Exception codes `EX-MKT-001`–`EX-MKT-015`. Requirement prefixes `MKT-CMP`, `MKT-AUD`,
`MKT-CON`, `MKT-MSG`, `MKT-CAP`, `MKT-EVT`, `MKT-AST`, `MKT-REF`, `MKT-BUD`, `MKT-ANA`,
`MKT-GOV`, `MKT-INT`. Every send carries `X-Purpose: marketing`.

---

## Purpose and boundary

Marketing runs campaigns, audiences, messaging, events, content, referrals and
spend, and it measures what any of that produced. It is the module that asks
"who did we talk to, through what, and did it work" — not the module that
decides what a lead becomes or who is accountable for closing it, and not the
module that moves money.

What Marketing never does:

- **It never writes `Lead.ownerPartyId` or routes leads.** Marketing creates
  leads (from a form, an event, a referral) and hands them to CRM at the
  moment of creation. Ownership assignment, routing rules, and everything
  that happens to a lead after that is CRM's plane, not this one's. A
  campaign can be the reason a lead exists; it is never the reason a lead is
  assigned to a person.
- **It never creates a Person directly.** Every place Marketing needs "a
  person with these details" — form submission, event registration, referral
  redemption — goes through `findOrCreatePerson()`. There is no
  `marketing.createPerson`. Identity forking is prevented once, at P1, and
  Marketing does not get a side door around it.
- **It never moves money.** A campaign has a planned, committed and actual
  budget; a spend row records what was spent and against which channel or
  campaign. Neither is a payment. `MarketingSpend.transactionId` and
  `vendorBillId` are references to Finance's own Transaction and VendorBill
  records, written by Finance's domain when it reconciles — Marketing's
  reconcile endpoint accepts the reference, it does not create the money
  movement behind it.
- **It never sets a pipeline stage.** Opportunity and pipeline stage belong
  to CRM. Marketing's campaign performance views read pipeline value and won
  counts from CRM's data; they do not write them.
- **It never sends without a granted `marketing` Consent.** Every recipient on
  every send is checked against the existing Consent model
  (`purposeCode='marketing'`) and against `MarketingPreference` before
  dispatch. No campaign urgency, no approval, no chairman override skips
  this check — a send with no consent is not sent, it is skipped and counted.
- **It never approves its own campaign, budget, template, asset, or send.**
  The self-dealing bar (`platform/approvals.ts`) holds for every approval
  surface in this module, chairman included: whoever proposed the thing is
  never the one who decides it went ahead.

---

<!-- continue -->
