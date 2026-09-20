# Marketing Module Implementation Plan

## Overview
KaiERP Marketing module (bounded context `mkt`, plane P2, health domain `H_MKT`) manages campaigns, audiences, messaging, events, attribution and analytics across all contact channels. The module never writes `Lead.ownerPartyId`, never routes leads, never creates `Person` directly, never records money movement, never sets pipeline stage, and never sends without explicit `marketing` Consent (reused from `compliance/privacy.ts`).

## Phases

### Foundation (Week 1-2)
**Schema, shared vocabulary, permissions, adapters**

- Create `apps/api/prisma/schema/marketing.prisma` with all 28 tables: `mkt_campaigns`, `mkt_channels`, `mkt_audiences`, `mkt_audience_members`, `mkt_preferences`, `mkt_templates`, `mkt_sends`, `mkt_send_recipients`, `mkt_journeys`, `mkt_journey_runs`, `mkt_forms`, `mkt_form_submissions`, `mkt_touchpoints`, `mkt_attributions`, `mkt_lead_score_rules`, `mkt_events`, `mkt_event_registrations`, `mkt_assets`, `mkt_social_posts`, `mkt_short_links`, `mkt_referral_programs`, `mkt_referrals`, `mkt_budgets`, `mkt_spends`, `mkt_vendors`, `mkt_claims`, `mkt_plans`, `mkt_webhooks_inbound`.
- Every model includes: id (CUID), tenantId, recordCode (unique + tenantId), createdById?, updatedById?, deletedAt?, createdAt, updatedAt.
- Export `marketing.ts` vocabulary: campaign/channel/audience/template/send/journey/form/event/asset/referral/budget/spend/claim/plan statuses, transitions, labels, rules, views.
- Add 12 resources to `packages/shared/src/permissions.ts RESOURCES`: campaigns, audiences, marketing_templates, marketing_sends, marketing_journeys, marketing_forms, marketing_events, marketing_assets, marketing_budgets, marketing_referrals, marketing_analytics, marketing_settings.
- Seed grants in `apps/api/src/seed/grants.ts`: chairman SUPERADMIN_CELL; finance_head campaigns V,approve, marketing_budgets VCEDXF,approve, marketing_analytics VXF; hr_ops_manager campaigns VCEDAXF, audiences VCEDXF, marketing_templates VCEDXF,approve, marketing_sends VCEDXF, marketing_journeys VCEDXF, marketing_forms VCEDXF, marketing_events VCEDAXF, marketing_assets VCEDXF,approve, marketing_budgets VCE, marketing_referrals VCEDXF, marketing_analytics VXF, marketing_settings VCED; employee campaigns V, marketing_events VCE@own+V@all, marketing_referrals VC@own, marketing_assets V, marketing_analytics V, marketing_forms V, marketing_sends V@own.
- Self-dealing bar: campaign/budget proposer never approves their own, even chairman (use `platform/approvals.ts`).
- Register 28 exception codes in `packages/shared/src/domain.ts EXCEPTION_CODES`: EX-MKT-001 through EX-MKT-015.
- Register 86 canonical events in `packages/shared/src/events.ts` under `kz.mkt.*`.
- Register 6 AI touchpoints in `packages/shared/src/ai.ts`: AI-MKT-001 through AI-MKT-006 (AI-MKT-007 and AI-MKT-008 are PROHIBITED).

### Domain Layer (Week 2-4)
**13 domain files, 4 helper modules, 1 adapter registry**

- `apps/api/src/domains/marketing/campaigns.ts`: create, read, list, submit (self-dealing bar), approve, reject, launch, pause, resume, complete, archive, cancel, timeline, utm. budgetActual computed from linked spends. utmCampaign unique slug per tenant from campaign name.
- `apps/api/src/domains/marketing/audiences.ts`: create, read, list, update, delete, evaluate (dynamic rule tree into member rows), add member (static), remove member, suppress member, preview (estimate count + sample).
- `apps/api/src/domains/marketing/preferences.ts`: read person preferences, record consent via existing Consent domain, withdraw consent, change channel preference, set do-not-contact.
- `apps/api/src/domains/marketing/messaging.ts`: templates (create, read, list, update, submit, approve, retire), sends (create, read, list, request, approve, cancel, dispatch, dry-run, test), merge-field preview.
- `apps/api/src/domains/marketing/journeys.ts`: create, read, list, update, activate, pause, retire, enrol person, exit run, tick job (advance due runs).
- `apps/api/src/domains/marketing/capture.ts`: forms (create, read, list, update, publish, unpublish, rotate-token, embed), submissions (convert to person+lead, reject, mark-spam), submissions from public POST (honeypot, rate-limit 30/min/ip), touchpoint create/list.
- `apps/api/src/domains/marketing/attribution.ts`: recompute per four models (first_touch, last_touch, linear, position_based), read attribution per lead.
- `apps/api/src/domains/marketing/scoring.ts`: lead score rules CRUD, preview score for a lead, apply rules (adds to existing Lead.scoreReasons, never removes CRM's reasons).
- `apps/api/src/domains/marketing/events.ts`: create, read, list, update, open, close, start, complete, cancel, register, confirm, check-in, no-show, follow-up, convert attendees to leads.
- `apps/api/src/domains/marketing/assets.ts`: create, read, list, update, submit, approve, retire.
- `apps/api/src/domains/marketing/social.ts`: social posts (create, list, update, publish, cancel, record metrics), short links (create, list, read public and record click).
- `apps/api/src/domains/marketing/referrals.ts`: programs CRUD, issue code, redeem code, qualify, reward (reference Finance transaction, never post money), void.
- `apps/api/src/domains/marketing/budget.ts`: budgets (create, list, update, approve), spends (create, list, reconcile), vendors (create, list, update), variance (planned/committed/actual per period/division/channel/campaign).
- `apps/api/src/domains/marketing/analytics.ts`: overview (KPIs, funnel, live campaigns, open exceptions), funnel (touchpoints/leads/qualified/opportunities/won/enrolments by stage + conversion rates), channel performance (touchpoints, leads, spend, ROI per channel), campaigns performance, attribution by model, cohorts, export CSV.
- `apps/api/src/domains/marketing/settings.ts`: channels (list, add, update label/active/senders/config), policy (thresholds, alert rates, SLAs), webhooks (list recent inbound), AI touchpoints registry.

### API Routes (Week 3-4)
**13 route files mounted under `/api/marketing`**

- `apps/api/src/routes/marketing/campaigns.routes.ts`: GET /campaigns, POST (C), GET /:id, PATCH /:id (E), DELETE /:id (D), POST /:id/submit (E), POST /:id/approve (approve), POST /:id/reject, POST /:id/launch (E), POST /:id/pause, POST /:id/resume, POST /:id/complete, POST /:id/archive, POST /:id/cancel.
- `apps/api/src/routes/marketing/audiences.routes.ts`: GET, POST, GET /:id, PATCH, DELETE, POST /:id/evaluate, POST /:id/members (static), DELETE /:id/members/:memberId, POST /:id/suppress, POST /preview, GET /fields.
- `apps/api/src/routes/marketing/preferences.routes.ts`: GET /preferences (auth + purpose marketing), POST /preferences/consent, POST /preferences/withdraw, POST /preferences/channel, POST /preferences/do-not-contact, GET /preferences/coverage, GET /public/unsubscribe/:token (no auth), POST /public/unsubscribe/:token.
- `apps/api/src/routes/marketing/messaging.routes.ts`: templates (GET, POST, GET /:id, PATCH, POST /:id/submit, POST /:id/approve, POST /:id/reject, POST /:id/retire, POST /:id/preview, GET /merge-fields), sends (GET, POST, GET /:id, POST /:id/request, POST /:id/approve, POST /:id/cancel, POST /:id/dispatch, GET /:id/recipients, GET /:id/dry-run, POST /test).
- `apps/api/src/routes/marketing/journeys.routes.ts`: GET, POST, GET /:id, PATCH, POST /:id/activate, POST /:id/pause, POST /:id/retire, GET /:id/runs, POST /:id/enrol, POST /runs/:runId/exit, POST /tick (E).
- `apps/api/src/routes/marketing/capture.routes.ts`: forms (GET, POST, GET /:id, PATCH, POST /:id/publish, POST /:id/unpublish, POST /:id/rotate-token, GET /:id/embed, GET /:id/submissions), submissions (POST /:id/convert, POST /:id/reject, POST /:id/mark-spam, POST /public/forms/:publicToken/submit no auth), touchpoints (GET, POST), attribution (POST /recompute, GET /lead/:leadId), score-rules (GET, POST, PATCH, DELETE, POST /preview, POST /apply), links (GET, POST, GET /public/l/:slug no auth), webhooks (POST /public/webhooks/:provider no auth).
- `apps/api/src/routes/marketing/events.routes.ts`: GET, POST, GET /:id, PATCH, POST /:id/open, POST /:id/close, POST /:id/start, POST /:id/complete, POST /:id/cancel, GET /:id/registrations, POST /:id/register, POST /registrations/:id/confirm, POST /registrations/:id/check-in, POST /registrations/:id/no-show, POST /registrations/:id/cancel, POST /registrations/:id/follow-up, POST /:id/convert-attendees, GET /:id/export.
- `apps/api/src/routes/marketing/assets.routes.ts`: GET, POST, GET /:id, PATCH, POST /:id/submit, POST /:id/approve, POST /:id/reject, POST /:id/retire.
- `apps/api/src/routes/marketing/social.routes.ts`: social-posts (GET, POST, PATCH, POST /:id/publish, POST /:id/cancel, POST /:id/metrics), claims (GET, POST, POST /:id/approve, POST /:id/reject, POST /:id/retire).
- `apps/api/src/routes/marketing/referrals.routes.ts`: programs (GET, POST, PATCH, POST /:id/activate, POST /:id/deactivate), referrals (GET, POST /issue, POST /redeem, POST /:id/qualify, POST /:id/reward, POST /:id/void, GET /leaderboard).
- `apps/api/src/routes/marketing/budget.routes.ts`: budgets (GET, POST, PATCH, POST /:id/approve, GET /variance), spends (GET, POST, POST /:id/reconcile), vendors (GET, POST, PATCH).
- `apps/api/src/routes/marketing/analytics.routes.ts`: GET /overview, GET /funnel, GET /channels, GET /campaigns, GET /attribution, GET /cohorts, GET /export (X).
- `apps/api/src/routes/marketing/settings.routes.ts`: channels (GET, POST, PATCH), policy (GET, PATCH), webhooks (GET), ai-touchpoints (GET).
- `apps/api/src/routes/marketing/plans.routes.ts`: GET, POST, GET /:id, PATCH, POST /:id/approve, POST /:id/close, GET /calendar.
- `apps/api/src/routes/marketing/index.ts`: mounts all route files under `/api/marketing` and exports router; mounted from `apps/api/src/routes/index.ts`.

### Web & Settings (Week 4-5)
**18 page components, marketing library, nav registry**

- `apps/web/src/pages/marketing/MarketingOverview.tsx`: KPI tiles (live campaigns, attributed leads, cost-per-lead, consent coverage), funnel stage breakdown, channel performance grid, drill paths to detail views.
- `apps/web/src/pages/marketing/Campaigns.tsx`: table view (name, objective, status, budget, startAt, endAt, owner), filters by status/division/campaign, action buttons (create, edit, submit, approve, launch, pause, pause, resume, complete, archive, cancel).
- `apps/web/src/pages/marketing/CampaignDetail.tsx`: full campaign view (details, approvals trail, linked events, budget/spend, touchpoint timeline, linked forms/assets).
- `apps/web/src/pages/marketing/Audiences.tsx`: table view (name, kind, entityType, memberCount, lastEvaluatedAt), action buttons (create, edit, delete, evaluate, manage members, suppress), rule builder modal.
- `apps/web/src/pages/marketing/Consent.tsx`: person consent view (marketing purpose status, channel preferences grid, do-not-contact flag), consent change form, evidence history.
- `apps/web/src/pages/marketing/Templates.tsx`: table view (name, channelKey, status, version, approvedBy), channels filter, create/edit/submit/approve/retire buttons, preview pane.
- `apps/web/src/pages/marketing/Sends.tsx`: table view (campaign, template, channel, status, recipientCount, deliveredCount, sentAt), filters by campaign/status/channel, create send wizard (audience/template/schedule/approve).
- `apps/web/src/pages/marketing/Journeys.tsx`: table view (name, triggerKind, status, activeRuns/completedRuns/exitedRuns), create/edit/activate/pause/retire, step editor (delay, template, channel, condition).
- `apps/web/src/pages/marketing/Forms.tsx`: table view (name, slug, submissionCount, active), create/edit/publish/unpublish, field builder, preview, public link + embed code, submissions list with convert/reject/spam.
- `apps/web/src/pages/marketing/MarketingEvents.tsx`: table view (name, kind, startAt/endAt, capacity, status), create/edit, registration list (check-in, no-show, follow-up), convert attendees to leads.
- `apps/web/src/pages/marketing/Assets.tsx`: grid view (kind, status, version, expiry), create/edit/upload/submit/approve/retire, usage rights + tags, version history.
- `apps/web/src/pages/marketing/Social.tsx`: scheduled posts table (channel, body, scheduledAt, status), create post form (channel/body/assets/schedule), publish/cancel, metrics input (likes, comments, shares, reach, clicks).
- `apps/web/src/pages/marketing/Referrals.tsx`: programs list (kind, rewardKind, active), create/edit/activate/deactivate, referrals table (referrer, status, code, reward), issue codes, leaderboard.
- `apps/web/src/pages/marketing/Budget.tsx`: period/division dropdowns, budget rows (channelKey/campaignId, planned/committed/spent/remaining), create/edit/approve buttons, variance report (actual vs planned by channel/campaign).
- `apps/web/src/pages/marketing/Analytics.tsx`: KPI cards, funnel chart, channel performance bar chart, attribution model selector, cohort retention heatmap, export CSV button.
- `apps/web/src/pages/marketing/MarketingSettings.tsx`: tab bar (channels, policy, webhooks, AI), channel add/edit form (label, kind, adapter, senderIds, config), policy thresholds (campaign approval, send approval, bounce/unsub alerts, SLA hours), recent webhook log.
- `apps/web/src/pages/marketing/Calendar.tsx`: month/week calendar view of campaigns, events, sends, social posts with status color coding.
- `apps/web/src/lib/marketingApi.ts`: client library wrapping all `/api/marketing` endpoints with fetch + error handling, type-safe response shapes.

### Integration & Boot (Week 5)
**Database job, navigation, seeding, event wiring**

- `apps/api/src/jobs/marketing.ts`: hourly job: audience evaluation (dynamic rules → members), journey tick (advance due steps), send dispatch (process adapter), exception checks (bounce/unsub rates, stale campaigns, overdue runs, follow-ups due), lead score rule application (add to scoreReasons).
- `apps/api/src/config/navigation.ts`: add Marketing group with nav items (Overview, Campaigns, Audiences, Consent, Templates, Sends, Journeys, Forms, Events, Assets, Social, Referrals, Budget, Analytics, Settings, Calendar).
- `apps/api/src/seed/boot.ts`: on first boot, create default channels (email, sms, whatsapp, social_meta, social_linkedin, google_ads, website, event, referral, partner, print, walk_in, phone, other) with kind (owned/paid/earned/direct), seed default lead score rules (form=10pts, event_attend=20, click=5, referral=25, reply=15, walk_in=30).
- `apps/api/src/adapter/` registry: adapter interface for channels (configure, validate, send, parseWebhook). Built-in: email (HTTP to SendGrid/Postmark), SMS (HTTP to Twilio/Exotel), WhatsApp (API with DLT check), social_meta (Business Account Graph API), Google Ads (REST), website (internal click tracking), print/walk_in/phone/partner/other (no-op or data-only).
- Register Marketing as `InteractionType` (existing interactions entity type) for Interactions domain; journey run/send recipient interactions logged here.
- Wire form submission event (`kz.mkt.form.submission_received`) and event registration (`kz.mkt.event.registered`) to trigger journeys with `form_submitted` and `event_registered` triggers.
- Webhook inbound route for third-party provider events (delivery status, click, open, bounce, unsubscribe) with retry + status recording.

### Verification (Week 5-6)
**Schema validation, type safety, integration tests**

- `tests/marketingCampaigns.test.ts`: campaign create (draft with name/objective/division/channelMix/budget), state transitions, proposal + approval with self-dealing bar, spend computed from spends, utmCampaign slug unique per tenant.
- `tests/marketingAudiences.test.ts`: dynamic audience evaluation (rule tree into member rows), static audience manual add/remove, suppression list exclusion from sends, rule operator validation (only AUDIENCE_RULE_OPS).
- `tests/marketingConsent.test.ts`: send rejection when recipient lacks marketing consent, do-not-contact skipping, unsubscribe link withdrawal, preference change source tracking.
- `tests/marketingMessaging.test.ts`: template submission/approval/retirement transitions, WhatsApp template validation (dltTemplateId + waTemplateName), send creation without approved template fails, adapter not configured raises EX-MKT-011, recipient outcome events (delivered/opened/clicked/bounced/unsubscribed), bounce/unsub rate alarms.
- `tests/marketingJourneys.test.ts`: journey enrolment on trigger (audience_join, lead_created, form_submitted, event_registered, enrolment, manual), step advancement per delay + condition, run stuck detection (nextAt overdue 2 days = EX-MKT-015).
- `tests/marketingCapture.test.ts`: public form submission (active token, honeypot check, rate-limit 30/min/ip), conversion creates person+lead via findOrCreatePerson, submission unconverted 24h = EX-MKT-007, touchpoint immutability (corrections = new rows), attribution compute per model, lead with no source = EX-MKT-001, score = sum of rule matches with score_reasons[].
- `tests/marketingEvents.test.ts`: event state transitions (planned→open→closed→live→completed or cancelled), registration capacity check, completed event with pending follow-ups after 3 days = EX-MKT-008, check-in sets checkedInAt + status=attended.
- `tests/marketingAssets.test.ts`: asset state transitions (draft→in_review→approved→retired), usage rights expiry check = EX-MKT-012, social post only uses approved assets.
- `tests/marketingReferrals.test.ts`: referral state transitions (issued→used→qualified→rewarded or void), referral code unique per tenant, reward pending 30 days = EX-MKT-013, reward references Finance transaction.
- `tests/marketingBudget.test.ts`: budget with linked spends (planned/committed/spent), spend over planned = EX-MKT-002, spend without approved budget = EX-MKT-014, spend transitions (recorded→reconciled).
- `tests/marketingAnalytics.test.ts`: overview KPIs (live campaigns, attributed leads, cost-per-lead trend, consent coverage), funnel stages (touchpoints/leads/qualified/opportunities/won/enrolments), channel performance (spend + touchpoints + ROI), attribution models computed and stored.
- `tests/marketingIntegration.test.ts`: route mounting under `/api/marketing`, public routes before auth (form submission, webhooks, short link click, unsubscribe), inbound webhook processing + retry, adapter status checking.

## Files by Area

```
apps/api/src/domains/marketing/
  ├── campaigns.ts
  ├── audiences.ts
  ├── preferences.ts
  ├── messaging.ts
  ├── journeys.ts
  ├── capture.ts
  ├── attribution.ts
  ├── scoring.ts
  ├── events.ts
  ├── assets.ts
  ├── social.ts
  ├── referrals.ts
  ├── budget.ts
  ├── analytics.ts
  ├── settings.ts
  └── index.ts (re-export all)

apps/api/src/routes/marketing/
  ├── campaigns.routes.ts
  ├── audiences.routes.ts
  ├── preferences.routes.ts
  ├── messaging.routes.ts
  ├── journeys.routes.ts
  ├── capture.routes.ts
  ├── events.routes.ts
  ├── assets.routes.ts
  ├── social.routes.ts
  ├── referrals.routes.ts
  ├── budget.routes.ts
  ├── analytics.routes.ts
  ├── settings.routes.ts
  ├── plans.routes.ts
  └── index.ts (mounts all)

apps/api/src/
  ├── jobs/marketing.ts
  └── adapter/marketing/ (channel provider implementations)

apps/web/src/
  ├── pages/marketing/
  │   ├── MarketingOverview.tsx
  │   ├── Campaigns.tsx
  │   ├── CampaignDetail.tsx
  │   ├── Audiences.tsx
  │   ├── Consent.tsx
  │   ├── Templates.tsx
  │   ├── Sends.tsx
  │   ├── Journeys.tsx
  │   ├── Forms.tsx
  │   ├── MarketingEvents.tsx
  │   ├── Assets.tsx
  │   ├── Social.tsx
  │   ├── Referrals.tsx
  │   ├── Budget.tsx
  │   ├── Analytics.tsx
  │   ├── MarketingSettings.tsx
  │   └── Calendar.tsx
  └── lib/marketingApi.ts

packages/shared/src/
  ├── marketing.ts (vocabulary, views, transitions)
  ├── permissions.ts (RESOURCES + grants added)
  ├── domain.ts (EX-MKT-* codes added)
  └── events.ts (kz.mkt.* canonical events added)

apps/api/prisma/schema/
  └── marketing.prisma (all 28 tables)
```

## Requirements (68 total)

| ID | Feature | PASS/FAIL Criterion | Test File |
|---|---|---|---|
| MKT-CMP-001 | A campaign is created in draft with division, objective and channel mix | Campaign created with status=draft, division, objective in CAMPAIGN_OBJECTIVES, channelMix non-empty | tests/marketingCampaigns.test.ts |
| MKT-CMP-002 | Campaign above approval threshold cannot be scheduled without approval | Campaign with budgetPlanned > threshold is pending_approval, blocks transition to scheduled until approved | tests/marketingCampaigns.test.ts |
| MKT-CMP-003 | Campaign proposer can never approve their own, even chairman | Self-dealing bar rejects proposer as approver; self-dealing middleware invoked | tests/marketingCampaigns.test.ts |
| MKT-CMP-004 | Only CAMPAIGN_TRANSITIONS-listed moves are accepted | Any unlisted transition is rejected with 400 error; only valid transitions succeed | tests/marketingCampaigns.test.ts |
| MKT-CMP-005 | budgetActual is computed from linked spends, never hand-edited | budgetActual equals SUM(MarketingSpend.amount) for campaign; PATCH rejects budgetActual edit | tests/marketingCampaigns.test.ts |
| MKT-CMP-006 | Live campaign past endAt raises EX-MKT-010 | Exception EX-MKT-010 recorded when campaign.status=live and now > endAt | tests/marketingCampaigns.test.ts |
| MKT-CMP-007 | Live campaign with no touchpoints for 7 days raises EX-MKT-004 | Exception EX-MKT-004 recorded when campaign.status=live and lastTouchpointAt < now - 7d | tests/marketingCampaigns.test.ts |
| MKT-CMP-008 | Cancelling campaign cancels queued sends and pauses journeys | Cancel transitions queued sends to cancelled; active journeys to paused | tests/marketingCampaigns.test.ts |
| MKT-CMP-009 | utmCampaign is unique slug per tenant, generated from name | utmCampaign unique (tenantId, utmCampaign); generated from campaign name via slug function | tests/marketingCampaigns.test.ts |
| MKT-CMP-010 | Campaign links at most one offering, one course, one audience | Campaign.offeringId, .courseId, .audienceId all optional; only one of each allowed | tests/marketingCampaigns.test.ts |
| MKT-AUD-001 | Dynamic audience evaluates rule tree into MarketingAudienceMember rows | POST /audiences/:id/evaluate populates members from rules; memberCount matches | tests/marketingAudiences.test.ts |
| MKT-AUD-002 | Static audience accepts only manual add/remove, never rule evaluation | kind=static audience ignores evaluate; POST /audiences/:id/members adds members; DELETE removes | tests/marketingAudiences.test.ts |
| MKT-AUD-003 | Suppression audience member is excluded from every send regardless | Send skips recipient if any suppression audience contains them; skip reason recorded | tests/marketingAudiences.test.ts |
| MKT-AUD-004 | Rule conditions restricted to AUDIENCE_RULE_OPS set | Rule op outside [eq,ne,in,contains,gt,lt,between,is_null,not_null,before,after] rejected | tests/marketingAudiences.test.ts |
| MKT-AUD-005 | memberCount and lastEvaluatedAt updated only by evaluation job | Only job can update these fields; API POST /evaluate updates them; manual member add/remove does not | tests/marketingAudiences.test.ts |
| MKT-AUD-006 | Audience declares exactly one AUDIENCE_ENTITY_TYPES value | entityType in [person,student,organization,institution,lead]; required, single value | tests/marketingAudiences.test.ts |
| MKT-CON-001 | Send never reaches person lacking marketing Consent | Send skips recipient without Consent(purposeCode=marketing, status=granted); skip reason recorded | tests/marketingConsent.test.ts |
| MKT-CON-002 | Recipient with doNotContact=true is skipped with reason | Send skips recipient where MarketingPreference.doNotContact=true; skip reason=skipped_dnc | tests/marketingConsent.test.ts |
| MKT-CON-003 | Opt-out via unsubscribe link updates MarketingPreference, never deletes | GET /public/unsubscribe/:token shows form; POST /public/unsubscribe/:token updates optedIn=false, never deletes row | tests/marketingConsent.test.ts |
| MKT-CON-004 | Preference change always names source (self_service/agent/import/unsubscribe_link/admin) | MarketingPreference.source in [self_service,agent,import,unsubscribe_link,admin]; required | tests/marketingConsent.test.ts |
| MKT-CON-005 | Consent coverage is H_MKT consent-coverage factor input | H_MKT factor: (consented recipients / contacted recipients) * 100; drill to /preferences/coverage | tests/marketingConsent.test.ts |
| MKT-MSG-001 | Template moves only along TEMPLATE_TRANSITIONS; retired cannot be sent | Template status in [draft,pending_review,approved,retired]; only approved templates sendable | tests/marketingMessaging.test.ts |
| MKT-MSG-002 | WhatsApp template requires waTemplateName and dltTemplateId before approval | WhatsApp template pending_review without both fields rejects approval; both required | tests/marketingMessaging.test.ts |
| MKT-MSG-003 | Send requires approved template and configured channel adapter | Send creation with retired/draft template or unconfigured channel raises error | tests/marketingMessaging.test.ts |
| MKT-MSG-004 | Unconfigured channel adapter raises EX-MKT-011 not silent queue | POST /sends/:id/request with providerAdapter=null raises EX-MKT-011, stays draft | tests/marketingMessaging.test.ts |
| MKT-MSG-005 | Every recipient outcome is distinct event | Each of [delivered,opened,clicked,bounced,unsubscribed] fires separate kz.mkt.send.recipient_* event | tests/marketingMessaging.test.ts |
| MKT-MSG-006 | Bounce rate above 5% on send raises EX-MKT-005 | bouncedCount / recipientCount > 0.05 fires EX-MKT-005 exception | tests/marketingMessaging.test.ts |
| MKT-MSG-007 | Unsubscribe spike above 2% on send raises EX-MKT-006 | unsubscribedCount / recipientCount > 0.02 fires EX-MKT-006 exception | tests/marketingMessaging.test.ts |
| MKT-MSG-008 | Journey enrols person on triggerKind, advances steps on delayDays and condition | Journey triggered creates JourneyRun; tick job advances currentStep per delayDays + condition match | tests/marketingJourneys.test.ts |
| MKT-MSG-009 | Journey run overdue by 2 days raises EX-MKT-015 | JourneyRun.nextAt < now - 2d fires EX-MKT-015 exception | tests/marketingJourneys.test.ts |
| MKT-MSG-010 | Every outbound send carries X-Purpose: marketing header | All adapter calls include X-Purpose: marketing in request headers | tests/marketingMessaging.test.ts |
| MKT-CAP-001 | Public form submission accepted only with active publicToken | POST /public/forms/:token/submit with inactive/missing token rejected; active token succeeds | tests/marketingCapture.test.ts |
| MKT-CAP-002 | Converted submission creates Person via findOrCreatePerson, never duplicate | Convert via findOrCreatePerson ensures no duplicate; Lead created with source=form, campaignId | tests/marketingCapture.test.ts |
| MKT-CAP-003 | Submission unconverted for 24h raises EX-MKT-007 | FormSubmission.status=received and createdAt < now - 24h fires EX-MKT-007 | tests/marketingCapture.test.ts |
| MKT-CAP-004 | Touchpoint immutable once recorded; corrections are new rows | MarketingTouchpoint deletedAt always null; corrections = new row with same personId/campaignId | tests/marketingCapture.test.ts |
| MKT-CAP-005 | Attribution computed per model and stored, never derived at render | POST /attribution/recompute computes all four models; stored in MarketingAttribution; GET /attribution/:leadId reads stored | tests/marketingCapture.test.ts |
| MKT-CAP-006 | Lead with no attributable touchpoint at creation raises EX-MKT-001 | Lead created with no MarketingTouchpoint record fires EX-MKT-001 | tests/marketingCapture.test.ts |
| MKT-CAP-007 | Lead score is sum of active rule matches; score_reasons[] names each | Lead.score = SUM(MarketingLeadScoreRule.points WHERE condition matches); each in scoreReasons[] | tests/marketingCapture.test.ts |
| MKT-CAP-008 | Marketing never writes Lead.ownerPartyId, never routes lead | Domain code has no assignment to Lead.ownerPartyId; Lead.status never changed by marketing routes | tests/marketingCapture.test.ts |
| MKT-EVT-001 | Marketing event moves only along MARKETING_EVENT_TRANSITIONS | Status in [planned,open,closed,live,completed,cancelled]; only listed transitions accepted | tests/marketingEvents.test.ts |
| MKT-EVT-002 | Registration cannot exceed capacity-bound event | capacity set and currentRegistrations == capacity rejects new registration | tests/marketingEvents.test.ts |
| MKT-EVT-003 | Completed event with follow-ups outstanding after 3 days raises EX-MKT-008 | MarketingEventRegistration.followUpDone=false 3 days after event.endAt fires EX-MKT-008 | tests/marketingEvents.test.ts |
| MKT-EVT-004 | Check-in sets checkedInAt and flips status to attended | POST /events/:id/registrations/:regId/check-in sets checkedInAt=now, status=attended | tests/marketingEvents.test.ts |

| MKT-AST-001 | Asset moves only along ASSET_TRANSITIONS; only approved used in send/post | status in [draft,in_review,approved,retired]; send/post rejects unapproved assetIds | tests/marketingAssets.test.ts |
| MKT-AST-002 | Asset used past usageRights expiresAt raises EX-MKT-012 | Send/post with asset where expiresAt < now fires EX-MKT-012 exception | tests/marketingAssets.test.ts |
| MKT-AST-003 | Social post publishes only assetIds that resolve to approved assets | POST /social-posts/:id/publish validates all assetIds exist and status=approved; rejects otherwise | tests/marketingAssets.test.ts |
| MKT-AST-004 | Short link records every click and rolls up onto clickCount | GET /public/l/:slug increments clickCount each time; auditable in MarketingTouchpoint.events Json | tests/marketingAssets.test.ts |
| MKT-AST-005 | Claim moves only along CLAIM_TRANSITIONS; only approved claims publishable | status in [proposed,approved,rejected,retired]; only approved usable in print/publish | tests/marketingAssets.test.ts |
| MKT-REF-001 | Referral moves only along REFERRAL_TRANSITIONS | status in [issued,used,qualified,rewarded,void]; only listed transitions accepted | tests/marketingReferrals.test.ts |
| MKT-REF-002 | Referral code unique per tenant, resolves to exactly one program | code unique (tenantId, code); POST /referrals/redeem resolves to one MarketingReferralProgram | tests/marketingReferrals.test.ts |
| MKT-REF-003 | Reward pending beyond 30 days raises EX-MKT-013 | MarketingReferral.status=qualified 30+ days without reward=rewarded fires EX-MKT-013 | tests/marketingReferrals.test.ts |
| MKT-REF-004 | Rewarding referral references Finance transaction; never posts money | POST /referrals/:id/reward requires transactionId; marketing only records, never creates Transaction | tests/marketingReferrals.test.ts |
| MKT-BUD-001 | Budget with linked spends; planned/committed/spent reconciled | GET /budgets/:id sums MarketingSpend.amount per status; committed = recorded+reconciled, spent = reconciled | tests/marketingBudget.test.ts |
| MKT-BUD-002 | Spend exceeding planned campaign budget raises EX-MKT-002 | SUM(spends for campaign) > campaign.budgetPlanned fires EX-MKT-002 exception | tests/marketingBudget.test.ts |
| MKT-BUD-003 | Spend recorded against budget period with no approved budget raises EX-MKT-014 | Spend for period with no approved MarketingBudget fires EX-MKT-014 exception | tests/marketingBudget.test.ts |
| MKT-BUD-004 | Spend moves only along SPEND_TRANSITIONS; reconciliation references books | status in [recorded,reconciled]; reconcile requires transactionId or vendorBillId reference | tests/marketingBudget.test.ts |
| MKT-BUD-005 | Vendor is specialisation of existing Organization, never new party type | MarketingVendor.organizationId foreign key; vendor reuses Organization, no separate VendorParty | tests/marketingBudget.test.ts |
| MKT-ANA-001 | H_MKT not measured while no campaign ever went live | H_MKT factors falsifiable=false until first campaign.status=live; initial overview shows "not yet measured" | tests/marketingAnalytics.test.ts |
| MKT-ANA-002 | Each H_MKT factor falsifiable with drill path to source rows | Attributed-lead share, campaign-to-opportunity rate, cost-per-lead trend all queryable; drill links work | tests/marketingAnalytics.test.ts |
| MKT-ANA-003 | MarketingOverviewView renders same KPI figures as drill opens | Overview KPI tiles use same computation as detail drill views; consistency verified | tests/marketingAnalytics.test.ts |
| MKT-ANA-004 | Channel performance computed per model from touchpoints/spend/attribution | ChannelPerformanceView: touchpoints, leadsAttributed, spend, costPerLead, ROI per channel | tests/marketingAnalytics.test.ts |
| MKT-GOV-001 | Every RESOURCES entry granted per Role cells, no other role | 12 resources; grants per skeleton spec; chairman SUPERADMIN_CELL, others per cell rules | tests/marketingGrants.test.ts |
| MKT-GOV-002 | Every state transition emits kz.mkt.<entity>.<verb> event | All campaign/send/journey/event/template/asset/referral/budget transitions fire canonical events | tests/marketingEvents.test.ts |
| MKT-GOV-003 | AI-MKT-007 (send approval) and AI-MKT-008 (budget approval) PROHIBITED | AI tier for send/budget approval is PROHIBITED; AgentAction.propose rejects | tests/marketingGovernance.test.ts |
| MKT-GOV-004 | Marketing never approves own campaign/budget; self-dealing bar applies | platform/approvals.ts reroutes interested approver away from self | tests/marketingGovernance.test.ts |
| MKT-INT-001 | Inbound webhook accepted only from recognised provider, recorded before processing | POST /public/webhooks/:provider validates provider in [email,sms,whatsapp,forms]; stores MarketingWebhookInbound before parse | tests/marketingIntegration.test.ts |
| MKT-INT-002 | Provider webhook failure retried, never silently dropped | Webhook parse error recorded in status; job retries; error field populated | tests/marketingIntegration.test.ts |
| MKT-INT-003 | Channel with providerAdapter null treated as not configured, never silent no-op | Send with providerAdapter=null raises EX-MKT-011, not queued silently | tests/marketingIntegration.test.ts |

## How to Verify

Run these commands in sequence to verify the implementation:

```bash
# 1. Build shared package (vocabulary, types, permissions)
pnpm --filter @kaizen/shared build

# 2. Type-check API layer (domains, routes, adapters)
pnpm --filter @kaizen/api typecheck

# 3. Type-check web layer (pages, components, client library)
pnpm --filter @kaizen/web typecheck

# 4. Set up test database (schema migration)
./scripts/test-db.sh

# 5. Run marketing domain and integration tests
cd apps/api && npx vitest run src/tests/marketing
```

When all tests pass, the module is ready for:
- Local development: `pnpm dev`
- Tenant seeding: channels, default lead score rules, navigation
- Integration testing: end-to-end campaign creation through send dispatch
- Performance baseline: concurrent send dispatch, audience evaluation, attribution recompute

