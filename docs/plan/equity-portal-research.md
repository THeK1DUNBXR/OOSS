# Equity portal — market and regulatory research

Companion to [equity-portal.md](equity-portal.md). Researched 14 Sep 2026
from vendor pages, help centres and Indian statutory sources. Anything that
could not be opened or confirmed is marked *unverified*. Several Carta pages
refused the fetch, so Carta findings rest on its help centre and blog.

## A. Products

### Vestd (UK; India at vestd.com/en-in)
- Cap table: share classes with rights and terms; instruments from issue to
  conversion; transfers; bulk upload; time-stamped audit trail; round
  modelling with waterfall. UK adds Companies House sync and statutory
  registers. CCPS/CCD, MGT-1/PAS-3/SH-4 generation and demat/RTA linkage are
  not stated on the India pages.
- ESOP (India): pool grants with over-allocation prevention, cliffs and custom
  schedules, performance vesting, exercise and cancellation, buyback
  digitisation, RSU/SAR/phantom. SH-6 and Ind AS 102 not stated.
- Shareholder portal: vested/unvested holdings with current valuation,
  ownership summary, dilution per round, transaction history. Role tiers:
  investors see the ownership summary only; employees see grants and vesting;
  finance sees everything.
- Board: DocuSign signing of certificates and resolutions; no meetings module.
- Multi-entity: "multi-company support", no detail; no look-through.
- India pricing: ₹5,000/yr (≤10 stakeholders), ₹20,000/yr (≤30), enterprise.
- Sources: vestd.com/en-in/solutions-by-stage-private-listed-companies,
  /en-in/cap-table-management, /en-in/esop-management,
  /en-in/shareholder-dashboards-investor-reporting-vestd-india, vestd.com/features,
  vestd.com/help/how-does-digital-signing-work-on-vestd

### Carta
- Cap table: multiple classes, liquidation preferences, participation, SAFEs,
  notes, warrants, options, RSUs.
- Board consents: drafted from cap-table data (option grants, 409A, plans,
  rounds), templates, e-signature, stored against the record. Written
  consents, not a meetings portal.
- Multi-entity: toggle between entity cap tables in one account; a
  "look-through ownership for fund structures" update exists but whether it
  is available to operating companies is *unverified*. No product called
  "Carta for Groups" was found.
- Sources: carta.com/blog/how-carta-does-board-consents/,
  support.carta.com (board consents, stakeholder cap-table access),
  carta.com/product-updates/look-through-ownership-fund-structures/ (403)

### Ledgy (EU)
- Classes, convertible loans, warrants, splits, pools; diluted and
  non-diluted views; IFRS 2 expensing; 70+ HRIS integrations; SAML/SCIM.
- Employee and investor dashboards; document e-sign only; "native
  multi-entity reporting", no look-through.
- Sources: ledgy.com, ledgy.com/cap-table

### Qapita (Singapore/India) — most India-complete
- Equity, CCPS, CCDs, convertible notes, warrants, phantom/SARs; certificate
  and SAFE issuance with e-sign; dilution modelling; ROC filing support.
- ESOP India: grant letters; time/milestone/hybrid vesting; exercise; lapse,
  surrender, buyback; SH-6 generation; MCA forms; perquisite tax and TDS;
  Ind AS 102 reports; ESOP trust services.
- Founder/investor/employee dashboards; "board-level dashboards" and minutes
  mentioned, no meetings module found; "multi-entity/group support" claimed,
  depth *unverified*.
- Pricing: free ≤25 stakeholders and <$1M raised; from $1,600/yr.
- Sources: qapita.com, qapita.com/equity-management/cap-table,
  qapita.com/in/esop-management, qapita.com/in/esop-consulting/valuations

### Hissa (India, formerly Rulezero)
- Ordinary and preferred series, ESOP grants; issuances, transfers, buybacks,
  conversions; a rights matrix (anti-dilution, pro-rata, information rights,
  board seats); round, top-up and exit waterfall modelling.
- ESOP: plan design, grant letters, pool utilisation, exercise to settlement,
  buyback, Ind AS 102 exports, employee tax-impact modelling.
- Investor portfolio module (MOIC/IRR across companies); no board module; no
  holding/subsidiary group model; a secondary/liquidity desk.
- Sources: hissa.com, /captable-management/, /esop-management/,
  /portfolio-management/

### Eqvista (US)
- Shares, options, SAFEs, notes, warrants; vesting; waterfall; ASC 718.
- Board resolutions with online voting (open or anonymous); shareholders vote
  in the portal, sign e-certificates and grant acceptances; delegated access.
- Multi-company under one account; no look-through.
- Sources: eqvista.com, eqvista.com/create-board-resolutions-on-eqvista/,
  eqvista.com/support/board-resolutions-in-shareholder-portal/

### Pulley (US) — the clearest multi-entity mechanism
- A subsidiary is added to the parent's cap table as an "Institution"
  stakeholder flagged as a company on Pulley, linked to its own account;
  nesting to any depth; one stakeholder portal across entities. No
  consolidated percentage maths documented.
- Sources: help.pulley.com/en/articles/6803229-adding-subsidiary-companies-as-stakeholders-on-pulley

### Capdesk
- Acquired by Carta (Sept 2022); customers migrating. Not a standalone option.

### Board portals: Diligent, BoardEffect, OnBoard
- Diligent Boards: board books, agenda builder, AI minutes, action tracking,
  e-signature and voting, director messaging. Diligent Entities: per-entity
  corporate record, group structure charts generated from ownership data, UBO
  surfacing, compliance deadlines.
- BoardEffect: agendas, books, minutes, approvals, polls, committees.
- OnBoard: agenda builder, minutes inside the agenda, voting, DocuSign,
  multi-org support for subsidiary boards, director terms and skills.
- Takeaway: no cap-table tool has a real meetings module; no board portal has a
  cap table.
- Sources: diligent.com/solutions/board-management-software,
  diligent.com/features/entities/organizational-chart-software-new,
  boardeffect.com, onboardmeetings.com

### Valuations
- Equidam: five methods (Scorecard, Checklist, two DCFs, VC method) weighted
  by stage; PDF and Excel; no cap-table integration.
- India: an ESOP perquisite FMV must come from a SEBI Category-I merchant
  banker (Rule 3(8)); a 409A has no Indian standing; a s.247 registered-valuer
  report is what a preferential allotment needs.

### Feature matrix (private company)

| Capability | Vestd IN | Carta | Ledgy | Qapita | Hissa | Eqvista | Pulley |
|---|---|---|---|---|---|---|---|
| CCPS/CCD native | not stated | no | no | yes | preferred series | no | no |
| SAFE/notes/warrants | convertibles | yes | loans, warrants | yes | conversions | yes | yes |
| ESOP full lifecycle | yes | yes | yes | yes + surrender, trust | yes | yes | yes |
| SH-6 / Ind AS 102 / TDS | not stated | no | no | yes | Ind AS 102 | no | no |
| Shareholder portal | yes | yes | yes | yes | yes | yes | yes |
| Consents / e-sign | resolutions | yes | doc e-sign | light | no | resolutions + voting | doc e-sign |
| Meetings / minutes | no | no | no | no | no | no | no |
| Waterfall / scenarios | yes | yes | not stated | yes | yes | yes | yes |
| Multi-entity | multi-company | entity toggle | multi-entity reporting | claimed | investor portfolio | multi-company | subsidiary as stakeholder |
| Look-through | no | fund side | no | no | no | no | no |
| India MCA filings | RTA mention | no | no | yes | implied | no | no |

## B. Indian regulatory requirements to model (private limited company)

| Area | Law | Forms | Model | Timing | Source |
|---|---|---|---|---|---|
| Register of members | s.88, Rule 3 Mgmt & Admin Rules | MGT-1, MGT-2 | per class: folio, holder details, PAN/CIN, distinctive numbers, paid-up, entry/cessation dates; CCDs in MGT-2 | forthwith on each change | ca2013.com/rule-3-companies-management-and-administration-rules-2014 |
| Share certificates | s.46, Rule 5 Share Capital Rules | SH-1 | certificate no., distinctive range, class, nominal/paid-up, two signatories, stamp duty | within 2 months of allotment; stamp duty within 30 days | ca2013.com/certificate-of-shares |
| Transfers | s.56 | SH-4 | transferor/transferee, consideration, stamp duty, board approval, register update | instrument within 60 days; register within 30 | equimerger.com/blog/sh-4-filing-stamp-duty-register-of-members |
| Allotment | s.39/42/62 | PAS-3, PAS-4, PAS-5 | round ⇒ allotment ⇒ allottee list; private placement: separate bank account, ≤200 persons/yr | PAS-3 within 15 (private placement) / 30 days | treelife.in/compliance/allotment-of-shares-in-india |
| Preferential pricing | s.62(1)(c), Rule 13 | registered valuer (s.247), MGT-14 | price ≥ valuer figure; report stored against round | report before allotment | ca2013.com/rule-13-companies-share-capital-and-debentures-rules-2014 |
| Instruments | s.42/55/62, s.71 | — | equity, CCPS, CCD (≤10-yr conversion), OCD/NCD, convertible note (DPIIT, ≥₹25 lakh), warrant, option, phantom; iSAFE = CCPS | conversion spawns allotment + PAS-3 | mondaq.com …/startup-fundraising-in-india-demystifying-ccds-ccps-and-safes |
| Capital changes | s.61/64 | SH-7, MGT-14 | pre/post authorised by class | 30 days | registerkaro.in/post/form-sh-7-guide |
| Resolutions | s.117 | MGT-14 | special resolutions; private cos exempt from filing s.179(3) board resolutions | 30 days | equitylist.co/blog-post/mgt-14 |
| Annual return | s.92 | MGT-7 / MGT-7A (small: paid-up ≤₹10 cr, turnover ≤₹100 cr, *secondary source*) | shareholding pattern, transfers, directors, meetings | 60 days after AGM | taxguru.in …/form-mgt-7a |
| ESOP | s.62(1)(b), Rule 12 | SH-6, MGT-14 | eligible: employees/directors of company, holding or subsidiary; excluded promoters and >10% directors (DPIIT relief 10 yrs); ≥1 yr grant-to-vest; non-transferable; separate resolutions for holding/subsidiary employees and for ≥1% grants | SH-6 forthwith | ca2013.com/rule-12-companies-share-capital-and-debentures-rules-2014 |
| ESOP tax | s.17(2)(vi), Rule 3(8), s.192(1C) | TDS | perquisite = merchant-banker FMV − exercise price; deferral for 80-IAC start-ups (earliest of 48 months / sale / exit) | month of exercise | incometaxindia.gov.in/w/schedulde_esop |
| Buy-back | s.68–70, Rule 17 | SH-8/9/10/11 | ≤10% by board, ≤25% by SR; D/E ≤2:1; 15–30 day offer; extinguish in 7 days; 1-yr gap | SH-11 within 30 days | ca2013.com/power-of-company-to-purchase-its-own-securities |
| Demat | Rule 9B PAS Rules (Oct 2023) | ISIN via NSDL/CDSL + RTA; PAS-6 | non-small private cos; promoters/KMP in demat before any issue; no physical issue/transfer after deadline | deadline 30 Jun 2025; PAS-6 within 60 days of half-year | jsalaw.com JSA Prism Feb 2025 |
| Angel tax | s.56(2)(viib) | — | abolished from AY 2025-26 | — | legal500.com …/abolition-of-angel-tax-in-india |
| DPIIT | Startup India | certificate, 80-IAC | <10 yrs, turnover cap (₹200 cr per Feb 2026 revision, *secondary source*); ESOP deferral, Rule 12 relief, convertible notes | intimate on crossing limits | startupindia.gov.in |
| FEMA | NDI Rules 2019 | FC-GPR, FC-TRS, FLA | residency per holder; pricing ≥ fair value for non-residents; FOCC test on fully-diluted basis; downstream investment rules | FC-GPR 30 days; FC-TRS 60 days; FLA 15 July | equitylist.co/blog-post/fc-gpr-filing-india |
| SBO | s.90, SBO Rules | BEN-1/2/3 | ≥10% direct or indirect via majority chains; subsidiaries of a holding reporting company report the holding | BEN-2 within 30 days of BEN-1 | corporateprofessionals.com/articles/significant-beneficial-ownership |
| Board meetings | s.173/174, SS-1 (rev. 1 Apr 2024) | notice, agenda, attendance, minutes | first within 30 days; ≥4/yr, gap ≤120 days (small: half-yearly, gap ≥90); notice ≥7 days; quorum 1/3 or 2; draft minutes 15 days, entered 30 days; s.179(3) matters at a meeting only | — | setindiabiz.com/blog/secretarial-standard-1-ss1 |
| Circulation | s.175 | draft + dispatch proof | majority; 1/3 may demand a meeting; noted at next meeting | keep proof 3 yrs | same |
| Interests / RPT | s.184, s.188 | MBP-1, MBP-4, AOC-2 | annual MBP-1 at first meeting of FY; interested director abstains | — | taxguru.in …/form-mbp-1 |
| Directors | s.152/168 | DIR-12, DIR-8, DIR-3 KYC | appointment/resignation | 30 days | capeasy.in/compliance/dir-12 |
| General meetings | s.96/101, SS-2 | notice, MGT-14 | AGM within 6 months of FY end, ≤15-month gap; 21 clear days unless ≥95% consent; minutes 30 days | — | ca2013.com/annual-general-meeting |
| Group | s.2(87), 2(6), s.19, s.129(3), Layers Rules 2017 | AOC-1 with AOC-4, CFS | subsidiary = board control or >50% total share capital; associate ≥20%; subsidiary may not hold holding's shares; ≤2 layers (WOS not counted) | AOC-4 within 30 days of AGM | taxguru.in …/consolidated-financial-statement-section-129 |

Not verified: the Rule 9B wholly-owned-subsidiary exemption; the Feb 2026
DPIIT turnover figure; the Dec 2025 small-company threshold; whether any Rule
9B extension followed 30 June 2025 (none found; treat the deadline as passed).

## C. Group structures

- Vendors model a holding as an institutional stakeholder on each
  subsidiary's cap table (Pulley links it to the holding's own account;
  Carta toggles between entities). Only fund products (Carta) and legal-entity
  tools (Diligent Entities) compute look-through or draw structure charts.
- Look-through: effective % of P in E = Σ over paths of the product of
  fully-diluted % along each edge. Founder 60% of KIPL, KIPL 70% of Sub A,
  founder 5% direct ⇒ 47%. s.19 makes subsidiary→holding edges illegal, so
  refuse them rather than solve cycles. Compute on issued and fully-diluted
  bases (s.2(87) vs FEMA). The same graph drives SBO and the layer limit.
- A group dashboard typically shows: structure chart with % and
  subsidiary/associate/WOS badges; per-entity tiles (capital by class,
  fully-diluted, pool, demat, valuation, DPIIT); consolidated holders with
  direct and look-through; a compliance calendar across entities; the board
  hub; group ESOP by issuing vs employing entity; scenario roll-up.
