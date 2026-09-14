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

## Entities

All models live in `apps/api/prisma/schema/marketing.prisma`, tables `mkt_*`,
and follow the tenant/soft-delete/audit conventions of every other model in
the schema (`id` cuid, `tenantId`, a unique `recordCode`, `createdById?`,
`updatedById?`, `deletedAt?`, `createdAt`, `updatedAt`).

**MarketingCampaign** (`CPG`) is the unit of intent: an objective (awareness,
lead_gen, enrolment, partnership, placement, retention, event), a channel mix,
a division, a date range, and a budget (planned, committed, actual — actual is
computed from spend, never entered by hand). State: `draft → pending_approval
→ scheduled → live → completed`, with `paused`/`resumed` as a live↔paused
loop, and `archived` or `cancelled` reachable from most states. `submit` moves
a draft to `pending_approval` when `approvalRequired`, otherwise straight to
`scheduled`. `approve`/`reject` resolve the pending state.
`launch` (`scheduled → live`), `pause`, `resume`, `complete`, `archive`, and
`cancel` (with a reason) round out the machine. A campaign that goes live past
its own `endAt` without being completed is `EX-MKT-010`, not an automatic
transition.

**MarketingCampaignApproval** is the approval record behind `submit`: who
requested it, who decided, the decision (`pending → approved|rejected`), a
reason, and the threshold amount the decision was measured against. One row
per approval cycle — a rejected-and-resubmitted campaign gets a new row, not
a reopened one.

**MarketingChannel** (`CHN`) is the channel registry: a fixed key (email,
sms, whatsapp, social_meta, social_linkedin, social_youtube, google_ads,
website, event, referral, partner, print, walk_in, phone, other), a kind
(owned/paid/earned/direct), and `providerAdapter` — null means genuinely not
configured, not a placeholder. No state machine; `active` is a flag, flipped
from Settings.

**MarketingAudience** (`AUD`) is a segment: dynamic (defined by a rule tree
over an entity type), static (a fixed member list), or suppression (a list
that excludes rather than includes). `evaluate` re-runs a dynamic audience's
rules and reports what was added and removed; it does not fire for static
audiences, which are edited directly through the members endpoints.

**MarketingAudienceMember** is one row per member of an audience —
`entityType`/`entityId`, how it got there (rule/manual/import), and whether
it has been suppressed. Suppression is per-membership, not a delete: a
suppressed member stays visible with the reason attached.

**MarketingConsent** does not exist as a separate model. Marketing uses the
existing `Consent` model from `compliance-privacy.prisma` with
`purposeCode='marketing'` — see Consent & DPDP below. There is no duplicate
consent table to fall out of sync with the one Compliance already owns.

**MarketingPreference** is per-channel opt-in state for a person — `channelKey`,
`optedIn`, `source`, `doNotContact`, and `evidence`. This is finer-grained
than consent: a person can hold a granted marketing consent and still be
opted out of SMS specifically, or flagged do-not-contact entirely regardless
of consent. Both gates are checked at send time; either one blocks.

**MarketingTemplate** (`TPL`) is a versioned message body for one channel,
with merge fields and a language. State: `draft → pending_review → approved`,
or `retired` from either. Editing an approved template does not mutate it —
`PATCH` on an approved template creates a new `version + 1` draft, so a live
send always points at an immutable, approved version. WhatsApp and SMS
templates additionally carry `dltTemplateId`/`waTemplateName`, which gate
`approved` (see Messaging).

**MarketingSend** (`SND`) is one batch dispatch of one template over one
channel to one audience, optionally tied to a campaign. State: `draft →
queued → sending → sent`, with `failed` and `cancelled` as exits. `request`
moves `draft → queued` only if the channel's adapter is configured;
otherwise it raises `EX-MKT-011` and the send stays `draft` with a
`blockedReason`. Above the tenant's send-approval threshold, `request` lands
at an approval gate instead of `queued` directly — see Authority. `dispatch`
is what actually calls the adapter over queued recipients; it is also what
the send job calls, so a stuck send can be re-driven by hand the same way the
scheduler drives it.

**MarketingSendRecipient** is one row per person on a send, with its own
status (`queued → sent → delivered → opened/clicked`, or
`skipped_no_consent`, `skipped_dnc`, `bounced`, `unsubscribed`, `failed`) and
a raw `events` log from the provider. The skip reasons are first-class states,
not a side note — a send's "recipientCount" the caller sees at creation time
already excludes them.

**MarketingJourney** (`JRN`) is a drip sequence: a trigger kind
(audience_join, lead_created, form_submitted, event_registered, enrolment,
manual) and an ordered list of steps, each a delay, a template, a channel and
an optional condition. State: `draft → active`, `paused` either direction,
`retired` terminal.

**MarketingJourneyRun** is one person's progress through one journey —
current step, status (`active → completed`, or `exited` early with a reason),
and `nextAt`, the time the next step is due. A run overdue on `nextAt` by more
than two days is `EX-MKT-015`; the journey tick job is what should have
advanced it and didn't.

**MarketingForm** (`FRM`) is a public capture form: a field schema, a slug, a
public token, and an optional default campaign. Publishing and unpublishing
toggle `active`; `rotate-token` invalidates the old public URL without
touching submissions already recorded against it.

**MarketingFormSubmission** is one raw submission — payload, UTM, and a
status (`received → converted`, or `duplicate`/`spam`/`rejected`). A
submission unconverted 24 hours after `receivedAt` is `EX-MKT-007`.
Conversion is a deliberate action (`POST /submissions/:id/convert`), not
automatic, except where a form is explicitly configured to auto-convert.

**MarketingTouchpoint** is an immutable attribution log entry — a person,
lead or organization touched by a channel through some kind of contact
(impression, click, visit, form, call, event_attend, referral,
message_reply, walk_in) at a point in time, with UTM and an optional cost.
There is no update or delete route for a touchpoint; a wrong one is
corrected by recording a compensating fact, never by editing history.

**MarketingAttribution** is a computed row, not an input: for a lead,
opportunity or enrolment, under one of four models (first_touch, last_touch,
linear, position_based), a campaign and channel get a weight. Rows are
produced by `attribution/recompute`, not written directly — see Capture &
attribution.

**MarketingLeadScoreRule** is a named, ordered condition-to-points rule used
only to add marketing-sourced score reasons to a lead; see Lead scoring.

**MarketingEvent** (`EVT`) is a seminar, webinar, open day, demo, college
visit, placement drive or fair — a venue or online link, a capacity, a cost
(planned and actual), and a division. State: `planned → open → closed → live
→ completed`, with `cancelled` (reason required) reachable from any
non-terminal state. Marketing owns the event's own lifecycle; it does not own
who is assigned to work it — see Authority.

**MarketingEventRegistration** is one registrant on one event —
`registered → confirmed → attended` or `no_show`, `cancelled` as an exit —
with a `checkedInAt` timestamp and a `followUpDone` flag. An event completed
with outstanding follow-ups three days later is `EX-MKT-008`.

**MarketingAsset** (`AST`) is the content library entry: a brochure, creative,
video, deck, copy, landing page, email, social post, print piece or other,
versioned like a template. State: `draft → in_review → approved`, or
`retired`; editing an approved asset creates a new version rather than
mutating it. Usage past `expiresAt` on an approved asset is `EX-MKT-012`.

**MarketingSocialPost** (`PST`) is a scheduled or published post on one
channel, referencing assets, with engagement `metrics` recorded after the
fact. State: `draft → scheduled → published`, or `failed`/`cancelled`.
Publishing through an unconfigured adapter reports that honestly rather than
pretending success (see Messaging's adapter contract, which this shares).

**MarketingShortLink** (`LNK`) is a tracked redirect: a slug, a target URL,
optional campaign/channel/UTM, and a click counter incremented by the public
redirect route.

**MarketingReferralProgram** (`RFP`) defines the rules of a referral scheme —
kind (student/partner/institution/employee), reward kind (cash, discount,
credit, none) and amount, active or not.

**MarketingReferral** (`REF`) is one issued code and its life:
`issued → used → qualified → rewarded`, or `void` (reason required) from any
non-terminal state. `used` is set on redemption; `qualified` is a
Marketing-side judgment call (the referred lead met the program's bar);
`rewarded` carries a `rewardTransactionRef` — again a reference into
Finance's own record, not a payment Marketing makes itself. A referral
sitting in `qualified` more than 30 days without `rewarded` is `EX-MKT-013`.

**MarketingBudget** (`BDG`) is planned/committed spend for a period
(month or quarter), scoped to a division and optionally a channel or
campaign. `approve` is a distinct action from create/edit — see Authority —
and is where the self-dealing bar applies to budgets specifically.

**MarketingSpend** (`SPN`) is one recorded outlay against a channel and
division, optionally a campaign, with `transactionId`/`vendorBillId` as the
link into Finance once reconciled. `recorded → reconciled` is the only
transition; spend that pushes a campaign over its planned budget is
`EX-MKT-002`, and spend recorded against a period with no approved budget is
`EX-MKT-014`.

**MarketingVendor** wraps an existing `Organization` with marketing-specific
facts — services offered, a contract reference, active status, a rating.
It does not duplicate the organization record; it annotates it.

**MarketingClaim** is the ASCI/brand compliance register: a claim's text, its
evidence, and a state (`proposed → approved`, or `rejected`/`retired`) plus
the assets it applies to. A claim is never assumed true because an asset
using it looks approved — the claim and the asset are approved separately.

**MarketingPlan** (`PLN`) is the quarterly plan for a division — a theme,
goals, and the campaign IDs under it. State: `draft → approved → active →
closed`.

**MarketingWebhookInbound** is the raw record of every inbound provider
callback (email/sms/whatsapp/forms) — payload, processing status, and error
if parsing failed. Nothing is dropped silently; a webhook that fails to parse
still exists as a row with `status` reflecting the failure.

---

## Authority

Four roles touch this module, each with a distinct posture:

- **`hr_ops_manager`** (the operations head) **proposes**. Full
  view/create/edit/delete/assign/export on campaigns, audiences, templates
  (including template approval — content review is theirs), sends, journeys,
  forms, events, assets (including asset approval), referrals, and marketing
  settings; can create and edit budgets but does not approve them. This role
  runs the module day to day and drafts everything that spends money, but
  every campaign it proposes and every budget it drafts goes to someone else
  for the money decision.
- **`finance_head`** **approves budgets and campaigns**. View and approve on
  campaigns (cannot create or edit one); full control plus approve on
  budgets; view/export/filter on analytics; view on sends. Finance sits at
  exactly the gate its name implies — the money question — and nowhere else
  in the module.
- **`employee`** **owns events and referrals at the individual level**.
  View on campaigns and assets; create/view/edit on their own events with
  view-all across the rest; create on their own referrals; view on
  analytics, forms, and their own sends. This is the role that actually runs
  a college visit or hands out a referral code — it does not touch budgets,
  templates, or anything requiring approval.
- **`chairman`** has the superadmin cell on everything in the module — every
  resource, every verb, including approve. That access is total but not
  exempt: the self-dealing bar still holds. A chairman who authored or
  requested a campaign, budget, template, asset or send is not the one who
  approves it, and the approval platform (`platform/approvals.ts`) enforces
  that at the same layer it enforces it for everyone else. Total authority
  over the module is not authority over one's own proposal.

Resources: `campaigns`, `audiences`, `marketing_templates`, `marketing_sends`,
`marketing_journeys`, `marketing_forms`, `marketing_events`,
`marketing_assets`, `marketing_budgets`, `marketing_referrals`,
`marketing_analytics`, `marketing_settings` (channels, score rules, vendors,
claims, plans).

---

## Consent & DPDP

Marketing does not define its own consent model. It uses the Consent model
Compliance already owns, filtered to `purposeCode='marketing'` — one consent
record type across the platform, not a marketing-specific copy that could
drift from what Compliance considers valid. `POST /preferences/consent`
records a grant through the existing consent domain function; it is not a
new write path invented for this module.

Consent and preference are two different gates, and both apply independently
at send time:

- **Consent** (`Consent`, `purposeCode='marketing'`) is the DPDP-meaningful
  grant: does this person's data have a lawful basis for marketing contact at
  all. Recorded with an evidence channel (portal, in-app, paper, verbal,
  guardian intake) so the basis is auditable, and withdrawable at any time
  (`POST /preferences/withdraw`) — withdrawal takes effect immediately, not
  at the end of a campaign.
- **Preference** (`MarketingPreference`) is finer control layered on top of a
  valid consent: which channels a person accepts, and a hard
  `doNotContact` flag that blocks every channel regardless of per-channel
  opt-in.

A send computes its recipient list by excluding anyone lacking a granted
marketing consent, anyone with `doNotContact` set, and anyone opted out of
the specific channel — and records each exclusion as
`skipped_no_consent`/`skipped_dnc` rather than quietly shrinking the count. A
send *requested* against recipients who fail this check is `EX-MKT-003` and
is blocked, not queued. The public unsubscribe link
(`GET/POST /public/unsubscribe/:token`) is unauthenticated by design — DPDP
withdrawal cannot require a login — and calls the same withdrawal path.

---

## Capture & attribution

**Capture.** The only way an anonymous visitor becomes a form submission is
`POST /public/forms/:publicToken/submit` — unauthenticated, guarded by the
form's own rotating `publicToken` rather than a shared secret, and hardened
three ways: a honeypot field (`website`) that must arrive empty, an in-memory
rate limit of 30 submissions per minute per IP, and deduplication against
recent submissions from the same identity before a new row is created. A
submission is recorded, a touchpoint is recorded alongside it, and — only
when the form is explicitly configured to auto-convert — a person
(`findOrCreatePerson`, never a direct create) and a lead are created from it.
Otherwise conversion is the deliberate `POST /submissions/:id/convert` call.
An event registration and a referral redemption follow the same shape: they
resolve identity through `findOrCreatePerson`, log a touchpoint, and hand a
lead to CRM with `source` set accordingly (`form`, `event`, `referral`).

**Touchpoints are immutable.** Once recorded, a `MarketingTouchpoint` is
never edited or deleted — an impression, click, visit, form, call,
event_attend, referral, message_reply or walk_in, each with its own
timestamp, UTM, source reference and optional cost. Attribution is only ever
as good as this log, so the log does not get to be revised after the fact.

**Attribution is a computed view, not a stored opinion.** Four models sit
over the same touchpoint log — first-touch, last-touch, linear, and
position-based — and `POST /attribution/recompute` (also run as a scheduled
job) produces `MarketingAttribution` rows under all four. Nothing about a
lead's touchpoints changes based on which model a report asks for; the model
picks how weight is distributed across the same immutable facts, and
`GET /attribution/lead/:leadId` returns all four side by side so nobody
mistakes one model's answer for the only answer.

**"Unattributed" is always visible, never dropped.** A lead, opportunity or
enrolment with no qualifying touchpoint is not excluded from attribution
reporting — it appears as `campaignName: 'Unattributed'` in every attribution
view, and a lead created with no attributable source at all is `EX-MKT-001`.
Hiding the unattributed share would make the channel numbers look better
than the truth; the model keeps it in the denominator on purpose.

---

## Lead scoring

`MarketingLeadScoreRule` rows (a condition, a point value, active/inactive,
an order) exist to let Marketing contribute signal to a lead's score based on
marketing-observable facts — engagement with a send, attendance at an event,
touchpoint volume. `POST /score-rules/apply` recomputes score for open leads
by **adding** marketing-sourced reasons to `Lead.scoreReasons` — it never
removes or overwrites the reasons CRM's own scoring already put there.
Marketing's rules and CRM's rules are two contributors writing into the same
reasons list, not two owners of the same field; a `POST /score-rules/preview`
call for a single lead makes clear exactly which reasons and points came
from marketing rules before `apply` touches anything in bulk.

---

## Messaging

**Templates are versioned, not overwritten.** `MarketingTemplate` moves
`draft → pending_review → approved`, and once approved, an edit does not
touch the approved row — it opens a new `version + 1` draft. A live send
always references a specific approved version; a subject line changed
tomorrow does not retroactively change what already went out today.

**DLT and WhatsApp templates gate on registration, not on approval alone.**
SMS and WhatsApp channels in India run under DLT and WhatsApp Business
template registration respectively. A template's `dltTemplateId` or
`waTemplateName` must be present before that template can reach `approved`
for those channels; using one that hasn't cleared registration is
`EX-MKT-009`. This is a regulatory gate layered on top of the ordinary
review gate, not a replacement for it.

**Dry-run before dispatch.** `GET /sends/:id/dry-run` computes the eligible
recipient list and every skip reason without sending anything, so a send can
be sanity-checked — consent coverage, opted-out counts, dead audience — before
it commits to `queued`. `POST /sends/test` sends exactly one message, to the
caller, so a template and adapter combination can be checked end to end
without touching a real audience.

**Approval threshold.** `request` on a send queues it directly only when the
recipient count is at or below the tenant's configured
`sendApprovalThreshold` (`GET/PATCH /settings/policy`). Above it, the send
lands at an approval gate before `queued` — the same self-dealing bar applies
here as everywhere else: whoever requested the send does not approve it.

**Adapters are honest about not being configured.** `MarketingChannel
.providerAdapter` is null when nothing is wired up, and every place that
would call an adapter — send dispatch, social post publish, webhook
parsing — checks for that null and reports it as `EX-MKT-011` /
`blockedReason`, not as a false success. `GET /settings/adapters` exposes
adapter status directly so this is visible before anyone tries to send.

**Delivery webhooks** land at `POST /public/webhooks/:provider`
(unauthenticated, provider-keyed: email/sms/whatsapp/forms), are stored
verbatim as `MarketingWebhookInbound`, and — when the adapter can parse
them — update the matching `MarketingSendRecipient` rows (delivered, opened,
clicked, bounced, unsubscribed). A send whose bounce rate crosses 5% is
`EX-MKT-005`; an unsubscribe spike over 2% is `EX-MKT-006`. Both are computed
from these recipient-level updates, not estimated.

**Journeys** are the automation layer above individual sends: a trigger
(audience join, lead created, form submitted, event registered, enrolment,
or manual enrolment) starts a `MarketingJourneyRun` per person, and each step
in the journey's ordered list fires a template over a channel after a delay,
optionally gated by a condition. `POST /journeys/tick` advances every run
whose `nextAt` is due — the scheduled job calls exactly this endpoint, so a
journey stuck in production can be nudged by hand the same way. A run whose
`nextAt` has passed by more than two days without advancing is `EX-MKT-015`.

---

## Events

Marketing owns the lifecycle of a marketing event — webinar, seminar, open
day, demo, college visit, placement drive, fair — from `planned` through
`open`, `closed`, `live`, to `completed`, with `cancelled` available from any
non-terminal state and a reason required. It does not own who staffs the
event or how that person's time is tracked; it owns the event record and its
registrations.

Registration follows a person through `registered → confirmed → attended` or
`no_show`, with `cancelled` as an exit. Registering accepts either an
existing `personId` or raw contact details, resolved through
`findOrCreatePerson` exactly like form capture — there is no separate
person-creation path for events. `POST /events/:id/convert-attendees`
creates leads (`source='event'`) for every attended registration that
doesn't already have one, in bulk, once the event is done; leads created this
way still go to CRM for ownership and routing like any other lead Marketing
originates.

Follow-up is tracked explicitly per registration
(`POST /events/registrations/:id/follow-up`), which also logs an Interaction
against the lead or person — the one place Events writes into CRM's
interaction history rather than only its own tables, because a follow-up
call is a CRM-visible fact about the relationship, not only a marketing
housekeeping item. An event marked `completed` with follow-ups still
outstanding three days later is `EX-MKT-008`.

---

## Assets, social, claims

**Assets** are versioned exactly like templates: `draft → in_review →
approved`, or `retired`, and editing an approved asset opens a new version
rather than mutating the approved one. `usageRights` and `expiresAt` are
tracked per asset; using an approved asset past its own expiry is
`EX-MKT-012` — the system does not assume a past approval still holds once
the rights window has closed.

**Social posts** reference assets and go through `draft → scheduled →
published`, with `failed`/`cancelled` as exits. Publishing goes through the
same adapter contract as messaging: an unconfigured channel adapter reports
that honestly instead of marking the post published. Engagement numbers
(likes, comments, shares, reach, clicks) are recorded after the fact via
`POST /social-posts/:id/metrics`, not invented at publish time.

**Claims** are the ASCI/brand-compliance register, deliberately separate
from assets: a claim's text and evidence go through its own
`proposed → approved`/`rejected`/`retired` cycle, and an asset lists the
claims it relies on rather than an asset's own approval implying every claim
inside it has been checked. A brochure being "approved" as an asset says its
content review passed; it says nothing about whether a specific performance
claim in it has cleared compliance — that is what the claim's own state
answers.

---

## Referrals

A `MarketingReferralProgram` sets the terms (kind, reward kind and amount,
active flag); `POST /referral-programs/:id/activate` and `/deactivate`
control whether new referrals can be issued under it. Issuing
(`POST /referrals/issue`) creates a code tied to a referring person or
organization; redemption (`POST /referrals/redeem`) resolves the referred
party through `findOrCreatePerson`, logs a touchpoint, moves the referral to
`used`, and creates a lead with `source='referral'` — handed to CRM the same
way every other Marketing-originated lead is.

From there a referral is a judgment call, not an automatic pipeline:
`qualify` marks that the referred lead met the program's bar,
`reward` records that a reward was earned and carries a
`rewardTransactionRef` pointing at the actual payment Finance makes — this
module records that a reward is owed and references the transaction that
paid it, it never issues the payment — and `void` (with a reason) closes a
referral out at any point before reward. A referral sitting `qualified`
without `rewarded` for more than 30 days is `EX-MKT-013`; the leaderboard
(`GET /referrals/leaderboard`) is a read-only rollup of issued/used/
qualified/rewarded counts per referrer, not a separate source of truth.

---

## Budget & spend

A `MarketingBudget` is planned/committed money for a period (a calendar month
or a quarter), scoped to a division and optionally narrowed to a channel or a
single campaign. `hr_ops_manager` proposes budgets (create/edit); only
`finance_head` — or the chairman, subject to the same self-dealing bar —
approves one. A budget is not itself money moving; it is the ceiling spend
gets measured against.

A `MarketingSpend` row is what actually happened: an amount, a date, a
division and channel, optionally a campaign and a vendor organization, moving
`recorded → reconciled` once it carries a `transactionId` or `vendorBillId`
linking it to the real financial record Finance created. Marketing writes the
reference; it does not write the Transaction or VendorBill itself. Spend
against a campaign that exceeds that campaign's planned budget is
`EX-MKT-002`; spend recorded in a period/division/channel combination that
has no approved budget at all is `EX-MKT-014` — the two exceptions catch
different failures: one is overspending against a real ceiling, the other is
spending with no ceiling set.

`GET /budgets/variance` is the reconciliation view — planned, committed,
actual and the variance between them, per division/channel/campaign, with
`measured` set false wherever there is nothing yet to compare (see Analytics
below for what `measured` means generally). `MarketingVendor` rows annotate
an existing `Organization` with the marketing-specific facts (services,
contract reference, rating) needed to work with a vendor without duplicating
the organization record Finance and CRM already maintain.

---

## Analytics & health

`H_MKT` is measured on five factors, each falsifiable and each with a drill
path back to the rows that produced it:

1. **Attributed-lead share** — the proportion of leads with at least one
   qualifying touchpoint, versus landing in "Unattributed". Drills into
   `GET /analytics/attribution`.
2. **Campaign-to-opportunity conversion** — of leads a campaign produced, how
   many became an opportunity. Drills into `GET /analytics/campaigns`.
3. **Cost per lead, trend versus the prior period** — spend divided by leads
   produced, tracked as a trend rather than a single number, because a single
   period's cost per lead says less than whether it is moving. Drills into
   `GET /analytics/channels`.
4. **Consent coverage of contacted people** — of everyone Marketing has
   actually reached, what share holds a valid marketing consent. Drills into
   `GET /preferences/coverage`.
5. **Send deliverability** — delivered versus sent, bounce and unsubscribe
   rates against the tenant's own alert thresholds. Drills into a send's own
   recipient breakdown (`GET /sends/:id/recipients`).

**Not-yet-measured is a real state, not a zero.** Every KPI, funnel stage,
and channel/campaign performance row carries a `measured: boolean` alongside
its value. Before any campaign in a tenant has ever gone live, `H_MKT` is
reported as not-yet-measured rather than as a health score built on no data —
the same discipline every KPI view in this module follows: a `null` value
paired with `measured:false` reads as "nothing to report yet", never as
"zero", because a lead-gen campaign that hasn't launched is not the same fact
as a lead-gen campaign that launched and produced nothing.

`GET /overview` is the single entry point that assembles KPIs, the funnel,
live campaigns and the current attention list (open exceptions) in one call;
`analytics/funnel`, `/channels`, `/campaigns`, `/attribution`, and `/cohorts`
are the drill-down views behind it, each filterable by date range and, where
relevant, division or campaign. `analytics/export` produces CSV for
campaigns, channels or leads for anyone holding export on
`marketing_analytics`.

---

## Exceptions

| Code | Condition | Severity |
|---|---|---|
| EX-MKT-001 | Lead created with no attributable source (unattributed lead) | S1 |
| EX-MKT-002 | Campaign spend exceeds planned budget | S2 |
| EX-MKT-003 | Send requested to recipients lacking marketing consent (blocked) | S2 |
| EX-MKT-004 | Live campaign with no touchpoints for 7 days (stale) | S1 |
| EX-MKT-005 | Bounce rate above 5% on a send | S2 |
| EX-MKT-006 | Unsubscribe spike on a send (>2%) | S2 |
| EX-MKT-007 | Form submission unconverted for 24h | S1 |
| EX-MKT-008 | Event completed with follow-ups outstanding after 3 days | S1 |
| EX-MKT-009 | DLT/WhatsApp template used before registration/approval | S3 |
| EX-MKT-010 | Campaign live past endAt | S1 |
| EX-MKT-011 | Channel adapter not configured but send requested | S1 |
| EX-MKT-012 | Asset used past usage-rights expiry | S2 |
| EX-MKT-013 | Referral reward pending beyond 30 days | S1 |
| EX-MKT-014 | Budget period has no approved budget while spend recorded | S2 |
| EX-MKT-015 | Journey run stuck (nextAt overdue by 2 days) | S1 |

---

## Events (`kz.mkt.*`)

```
kz.mkt.campaign.created / submitted / approved / rejected / scheduled /
  launched / paused / resumed / completed / archived / cancelled
kz.mkt.audience.created / evaluated / member_added / member_suppressed
kz.mkt.consent.recorded / withdrawn   (only where not already covered by
  compliance's own consent events — reused, not duplicated, where they exist)
kz.mkt.preference.changed
kz.mkt.template.created / submitted / approved / retired
kz.mkt.send.requested / approved / queued / sent / failed / cancelled
kz.mkt.send.recipient_delivered / opened / clicked / bounced / unsubscribed
kz.mkt.journey.activated / paused / retired
kz.mkt.journey.run_started / run_advanced / run_completed / run_exited
kz.mkt.form.created / published / submission_received / submission_converted
kz.mkt.touchpoint.recorded
kz.mkt.attribution.computed
kz.mkt.event.created / opened / closed / completed / cancelled
kz.mkt.event.registered / attended / no_show
kz.mkt.asset.created / submitted / approved / retired
kz.mkt.social_post.scheduled / published / failed
kz.mkt.referral.issued / used / qualified / rewarded / voided
kz.mkt.budget.set / approved
kz.mkt.spend.recorded / reconciled
kz.mkt.claim.proposed / approved / rejected
kz.mkt.plan.created / approved / closed
kz.mkt.webhook.received
```

---

## AI touchpoints

| Code | Touchpoint | Tier |
|---|---|---|
| AI-MKT-001 | Campaign brief drafting | DRAFT |
| AI-MKT-002 | Email/SMS/WhatsApp copy & subject line suggestions | DRAFT (never auto-sent) |
| AI-MKT-003 | Audience/segment suggestion from lead outcomes | RECOMMEND |
| AI-MKT-004 | Lead score rule tuning suggestions | RECOMMEND |
| AI-MKT-005 | Next-best-action for a lead from touchpoints | RECOMMEND |
| AI-MKT-006 | Anomaly alert on send metrics (bounce/unsub) | AUTONOMOUS_WITHIN_POLICY (raises an exception only) |
| AI-MKT-007 | Send approval | PROHIBITED |
| AI-MKT-008 | Budget approval | PROHIBITED |

`POST /ai/draft` is the one entry point for the DRAFT/RECOMMEND touchpoints
above (`campaign_brief`, `copy`, `subject_lines`, `segment`,
`next_best_action`): it registers an `AgentAction` proposal at the
touchpoint's own tier through `agents.propose` and returns the draft text.
That text comes from deterministic template heuristics, not an external LLM
call, and is returned explicitly labelled as a draft — nothing from this
endpoint is ever dispatched, approved, or treated as final without a human
acting on the proposal it created. AI-MKT-007 and AI-MKT-008 are prohibited
outright: no tier of automation approves a send or a budget, matching the
self-dealing bar's insistence that approval is always a separate human
decision from the proposal.

---

## Jobs

Seven scheduled jobs keep the module's derived state honest without a human
having to drive every step by hand:

1. **Send dispatch** — calls the same `POST /sends/:id/dispatch` a human
   would, over every send sitting `queued`, so a queued send does not wait
   indefinitely on someone remembering to press go.
2. **Journey tick** — calls `POST /journeys/tick`, advancing every
   `MarketingJourneyRun` whose `nextAt` is due; the same endpoint a support
   engineer would call to un-stick a run by hand.
3. **Attribution recompute** — calls `POST /attribution/recompute` on a
   rolling window so `MarketingAttribution` stays current as new touchpoints
   and outcomes land, rather than only being correct the moment someone
   requests a report.
4. **Audience re-evaluation** — re-runs `evaluate` on active dynamic
   audiences so segment membership tracks the underlying rule against
   current data instead of going stale between manual triggers.
5. **Webhook reconciliation sweep** — retries parsing on
   `MarketingWebhookInbound` rows still `received`/unprocessed, so a
   transient adapter failure doesn't leave delivery events permanently
   unattached to their recipients.
6. **Exception scan** — evaluates the time- and threshold-based exceptions
   that are not natural side effects of a single write (stale campaigns
   EX-MKT-004, unconverted submissions EX-MKT-007, outstanding event
   follow-ups EX-MKT-008, campaigns live past `endAt` EX-MKT-010, expired
   asset usage EX-MKT-012, pending referral rewards EX-MKT-013, budget-less
   spend EX-MKT-014, stuck journey runs EX-MKT-015) and raises them.
7. **Budget actuals rollup** — recomputes each `MarketingCampaign`'s
   `budgetActual` and each `MarketingBudget`'s `committed`/`actual` from
   reconciled spend, so the numbers on a campaign or budget record reflect
   spend as of the last rollup rather than requiring a live join on every
   read.

---

## API

Base path `/api/marketing`, mounted from
`apps/api/src/routes/marketing/index.ts` over one router file per group in
`apps/api/src/routes/marketing/{campaigns,budget,audiences,preferences,
settings,messaging,journeys,capture,events,assets,referrals,analytics,
public}.routes.ts`. Every authenticated route runs through the same
auth-plus-tenant middleware as `crm.routes.ts`. List endpoints share one
query shape — `?q=&status=&division=&campaignId=&from=&to=&page=&pageSize=`
returning `{ items, total }`; single-record endpoints return the view
directly; mutations return the updated view; errors use the platform's
`ApiError`. Two routes are deliberately unauthenticated and token- or
signature-guarded instead: public form submission and the inbound webhook.

**Overview / analytics** (`marketing_analytics`) — `GET /overview`;
`GET /analytics/funnel|channels|campaigns|attribution|cohorts`;
`GET /analytics/export?kind=campaigns|channels|leads` (CSV, export grant).

**Campaigns** (`campaigns`) — `GET/POST /campaigns`, `GET/PATCH/DELETE
/campaigns/:id`; lifecycle actions `submit`, `approve`, `reject`, `launch`,
`pause`, `resume`, `complete`, `archive`, `cancel`; `GET /campaigns/:id
/timeline` and `/utm`.

**Plans & calendar** (`campaigns` view / `marketing_settings` write) —
`GET/POST /plans`, `PATCH /plans/:id`, `POST /plans/:id/approve|close`;
`GET /calendar` merging campaigns, events, sends and social posts.

**Budget & spend** (`marketing_budgets`) — `GET/POST /budgets`, `PATCH
/budgets/:id`, `POST /budgets/:id/approve`; `GET/POST /spends`, `POST
/spends/:id/reconcile`; `GET /budgets/variance`; `GET/POST/PATCH /vendors`.

**Audiences** (`audiences`) — `GET/POST /audiences`, `GET/PATCH/DELETE
/audiences/:id`; `POST /audiences/:id/evaluate`; member management
(`POST/DELETE .../members`, `POST .../suppress`); `POST /audiences/preview`;
`GET /audiences/fields` (rule-builder vocabulary).

**Consent & preferences** (`audiences` view / `marketing_settings` write,
purpose `marketing`) — `GET /preferences`; `POST /preferences/consent`
(reuses the existing consent domain function), `/withdraw`, `/channel`,
`/do-not-contact`; `GET /preferences/coverage`; public
`GET`/`POST /public/unsubscribe/:token`.

**Templates** (`marketing_templates`) — `GET/POST /templates`, `GET/PATCH
/templates/:id` (PATCH on an approved template opens a new version); `submit`,
`approve`, `reject`, `retire`; `POST /templates/:id/preview`; `GET
/templates/merge-fields`.

**Sends** (`marketing_sends`) — `GET/POST /sends`, `GET /sends/:id`;
`request` (queues if the adapter is configured, else `EX-MKT-011` with
`blockedReason`), `approve` (above the send-approval threshold), `cancel`,
`dispatch`; `GET /sends/:id/recipients`, `GET /sends/:id/dry-run`; `POST
/sends/test`.

**Journeys** (`marketing_journeys`) — `GET/POST /journeys`, `PATCH
/journeys/:id`; `activate`, `pause`, `retire`; `GET /journeys/:id/runs`;
`POST /journeys/:id/enrol`, `/journeys/runs/:runId/exit`; `POST
/journeys/tick` (job entry point).

**Capture** (`marketing_forms`; touchpoints under `campaigns` view) —
`GET/POST /forms`, `GET/PATCH /forms/:id`; `publish`, `unpublish`,
`rotate-token`; `GET /forms/:id/embed`; `GET /forms/:id/submissions`; `POST
/submissions/:id/convert|reject|mark-spam`; unauthenticated `POST
/public/forms/:publicToken/submit` (honeypot, rate limit, dedupe); `GET/POST
/touchpoints`; `POST /attribution/recompute`, `GET /attribution/lead/:leadId`;
`GET/POST/PATCH/DELETE /score-rules`, `POST /score-rules/preview|apply`;
`GET/POST /links`, unauthenticated `GET /public/l/:slug`; unauthenticated
`POST /public/webhooks/:provider`.

**Events** (`marketing_events`) — `GET/POST /events`, `GET/PATCH
/events/:id`; `open`, `close`, `start`, `complete`, `cancel`; `GET
/events/:id/registrations`; `POST /events/:id/register`; registration
actions `confirm`, `check-in`, `no-show`, `cancel`, `follow-up`; `POST
/events/:id/convert-attendees`; `GET /events/:id/export`.

**Assets, social, claims** (`marketing_assets`) — `GET/POST /assets`,
`GET/PATCH /assets/:id` (new version if approved); `submit`, `approve`,
`reject`, `retire`; `GET/POST/PATCH /social-posts`, `publish`, `cancel`,
`metrics`; `GET/POST /claims`, `approve`, `reject`, `retire`.

**Referrals** (`marketing_referrals`) — `GET/POST/PATCH
/referral-programs`, `activate`, `deactivate`; `GET /referrals`; `POST
/referrals/issue`, `/redeem`; `POST /referrals/:id/qualify|reward|void`; `GET
/referrals/leaderboard`.

**Settings** (`marketing_settings`) — `GET/POST/PATCH /settings/channels`;
`GET /settings/adapters`; `GET/PATCH /settings/policy` (approval thresholds,
alert rates, stale-campaign days, form-convert SLA — stored on
`Tenant.config.marketing`); `GET /settings/webhooks`; `GET
/settings/ai-touchpoints`; `POST /ai/draft`.

---

## Screens

`apps/web/src/pages/marketing/` under nav group "Marketing", routes under
`/marketing/...`: `MarketingOverview`, `Campaigns`, `CampaignDetail`,
`Audiences`, `Consent`, `Templates`, `Sends`, `Journeys`, `Forms`,
`MarketingEvents`, `Assets`, `Social`, `Referrals`, `Budget`, `Analytics`,
`MarketingSettings`, `Calendar`. Each screen maps to one resource group above;
`MarketingOverview` and `Calendar` are the two cross-cutting views, reading
across campaigns, events, sends and social posts rather than owning a
resource of their own.

---

## Retention

Touchpoints, sends, and webhook payloads are the module's own audit trail and
are kept for as long as attribution and deliverability reporting need to
reach back — they are never edited, only appended to, so retention here is a
question of how far back reporting looks, not of correcting history.
Consent and preference records follow Compliance's own DPDP retention rules
for the `marketing` purpose, not a Marketing-specific schedule — this module
reads and writes that state, it does not set the policy for how long it is
kept. Where a person withdraws marketing consent or requests erasure,
Marketing's own rows (form submissions, touchpoints, send recipient records)
are handled the same way any other module's personal-data rows are handled
under the platform's erasure flow — this module does not define a separate
erasure path for marketing data.
