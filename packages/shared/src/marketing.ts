/**
 * Marketing (bounded context `mkt`, plane P2) — health domain H_MKT.
 *
 * Campaigns, audiences, sends and the touchpoint log that attribution and lead
 * scoring read from. Marketing never writes `Lead.ownerPartyId`, never routes a
 * lead, never creates a `Person` directly (it calls `findOrCreatePerson`),
 * never records money movement (it references Finance's `Transaction`, never
 * posts beside it), never sets a pipeline stage, and never sends to a person
 * without a granted `marketing` Consent — the same consent purpose code
 * `compliance/privacy.ts` already declares, never duplicated here.
 *
 * Everything below is pure vocabulary: enums, transition maps, label maps and
 * the flat, denormalised View shapes the web reads, in the same shape `api.ts`
 * uses for `LeadView`. No I/O, no Prisma.
 */

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = [
  'draft', 'pending_approval', 'scheduled', 'live', 'paused', 'completed', 'archived', 'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  live: 'Live',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

/**
 * A campaign's proposer never approves it, even the chairman — the self-dealing
 * bar in `platform/approvals.ts` reroutes an interested approver, the same
 * mechanism EQT's allotment approval uses.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['pending_approval', 'scheduled', 'cancelled'],
  pending_approval: ['scheduled', 'draft', 'cancelled'],
  scheduled: ['live', 'paused', 'cancelled'],
  live: ['paused', 'completed', 'cancelled'],
  paused: ['live', 'completed', 'cancelled'],
  completed: ['archived'],
  archived: [],
  cancelled: [],
};

export const CAMPAIGN_OBJECTIVES = [
  'awareness', 'lead_gen', 'enrolment', 'partnership', 'placement', 'retention', 'event',
] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

export const CAMPAIGN_OBJECTIVE_LABELS: Record<CampaignObjective, string> = {
  awareness: 'Awareness',
  lead_gen: 'Lead generation',
  enrolment: 'Enrolment',
  partnership: 'Partnership',
  placement: 'Placement',
  retention: 'Retention',
  event: 'Event',
};

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const CHANNEL_KEYS = [
  'email', 'sms', 'whatsapp', 'social_meta', 'social_linkedin', 'social_youtube',
  'google_ads', 'website', 'event', 'referral', 'partner', 'print', 'walk_in', 'phone', 'other',
] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_KEY_LABELS: Record<ChannelKey, string> = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  social_meta: 'Meta (Facebook/Instagram)',
  social_linkedin: 'LinkedIn',
  social_youtube: 'YouTube',
  google_ads: 'Google Ads',
  website: 'Website',
  event: 'Event',
  referral: 'Referral',
  partner: 'Partner',
  print: 'Print',
  walk_in: 'Walk-in',
  phone: 'Phone',
  other: 'Other',
};

export const CHANNEL_KINDS = ['owned', 'paid', 'earned', 'direct'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  owned: 'Owned',
  paid: 'Paid',
  earned: 'Earned',
  direct: 'Direct',
};

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

export const AUDIENCE_KINDS = ['dynamic', 'static', 'suppression'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const AUDIENCE_KIND_LABELS: Record<AudienceKind, string> = {
  dynamic: 'Dynamic (rule-evaluated)',
  static: 'Static (manual list)',
  suppression: 'Suppression list',
};

export const AUDIENCE_ENTITY_TYPES = ['person', 'student', 'organization', 'institution', 'lead'] as const;
export type AudienceEntityType = (typeof AUDIENCE_ENTITY_TYPES)[number];

/**
 * The audience rule tree. Stored as `rules Json` on `MarketingAudience` and
 * evaluated by the audiences domain into `MarketingAudienceMember` rows — the
 * membership is materialised, never computed at send time, so a send can
 * always say exactly who it reached.
 */
export const AUDIENCE_RULE_OPS = [
  'eq', 'ne', 'in', 'contains', 'gt', 'lt', 'between', 'is_null', 'not_null', 'before', 'after',
] as const;
export type AudienceRuleOp = (typeof AUDIENCE_RULE_OPS)[number];

export interface AudienceCondition {
  field: string;
  op: AudienceRuleOp;
  value?: unknown;
}

export interface AudienceRule {
  all?: AudienceCondition[];
  any?: AudienceCondition[];
}

export const AUDIENCE_MEMBER_SOURCES = ['rule', 'manual', 'import'] as const;
export type AudienceMemberSource = (typeof AUDIENCE_MEMBER_SOURCES)[number];

// ---------------------------------------------------------------------------
// Preferences (MarketingConsent reuses the existing Consent model with
// purposeCode 'marketing' from compliance/privacy.ts — never duplicated here)
// ---------------------------------------------------------------------------

export const PREFERENCE_CHANGE_SOURCES = ['self_service', 'agent', 'import', 'unsubscribe_link', 'admin'] as const;
export type PreferenceChangeSource = (typeof PREFERENCE_CHANGE_SOURCES)[number];

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const TEMPLATE_STATUSES = ['draft', 'pending_review', 'approved', 'retired'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_STATUS_LABELS: Record<TemplateStatus, string> = {
  draft: 'Draft',
  pending_review: 'Pending review',
  approved: 'Approved',
  retired: 'Retired',
};

export const TEMPLATE_TRANSITIONS: Record<TemplateStatus, TemplateStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'draft'],
  approved: ['retired'],
  retired: [],
};

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export const SEND_STATUSES = ['draft', 'queued', 'sending', 'sent', 'failed', 'cancelled'] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

export const SEND_STATUS_LABELS: Record<SendStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const SEND_TRANSITIONS: Record<SendStatus, SendStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['sending', 'cancelled'],
  sending: ['sent', 'failed'],
  sent: [],
  failed: [],
  cancelled: [],
};

export const RECIPIENT_STATUSES = [
  'queued', 'skipped_no_consent', 'skipped_dnc', 'sent', 'delivered',
  'opened', 'clicked', 'bounced', 'unsubscribed', 'failed',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  queued: 'Queued',
  skipped_no_consent: 'Skipped — no consent',
  skipped_dnc: 'Skipped — do not contact',
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Clicked',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  failed: 'Failed',
};

/**
 * The recipient-status thresholds EX-MKT-005 and EX-MKT-006 alarm against.
 * Kept alongside the statuses rather than buried in a job, so a surface can
 * show "how close to the bounce alarm is this send" without re-deriving it.
 */
export const BOUNCE_RATE_ALARM_THRESHOLD = 0.05;
export const UNSUBSCRIBE_RATE_ALARM_THRESHOLD = 0.02;

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

export const JOURNEY_STATUSES = ['draft', 'active', 'paused', 'retired'] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const JOURNEY_STATUS_LABELS: Record<JourneyStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  retired: 'Retired',
};

export const JOURNEY_TRANSITIONS: Record<JourneyStatus, JourneyStatus[]> = {
  draft: ['active'],
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

export const JOURNEY_TRIGGER_KINDS = [
  'audience_join', 'lead_created', 'form_submitted', 'event_registered', 'enrolment', 'manual',
] as const;
export type JourneyTriggerKind = (typeof JOURNEY_TRIGGER_KINDS)[number];

export const JOURNEY_TRIGGER_KIND_LABELS: Record<JourneyTriggerKind, string> = {
  audience_join: 'Joins an audience',
  lead_created: 'Lead created',
  form_submitted: 'Form submitted',
  event_registered: 'Event registration',
  enrolment: 'Enrolment',
  manual: 'Manual enrolment',
};

/** One step of a journey's `steps Json` array. */
export interface JourneyStep {
  delayDays: number;
  templateId: string;
  channelKey: ChannelKey;
  condition?: AudienceRule | null;
}

export const JOURNEY_RUN_STATUSES = ['active', 'completed', 'exited'] as const;
export type JourneyRunStatus = (typeof JOURNEY_RUN_STATUSES)[number];

export const JOURNEY_RUN_STATUS_LABELS: Record<JourneyRunStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  exited: 'Exited',
};

// ---------------------------------------------------------------------------
// Forms & submissions
// ---------------------------------------------------------------------------

export const FORM_SUBMISSION_STATUSES = ['received', 'converted', 'duplicate', 'spam', 'rejected'] as const;
export type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUSES)[number];

export const FORM_SUBMISSION_STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  received: 'Received',
  converted: 'Converted',
  duplicate: 'Duplicate',
  spam: 'Spam',
  rejected: 'Rejected',
};

// ---------------------------------------------------------------------------
// Touchpoints & attribution
// ---------------------------------------------------------------------------

export const TOUCH_KINDS = [
  'impression', 'click', 'visit', 'form', 'call', 'event_attend', 'referral', 'message_reply', 'walk_in',
] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export const TOUCH_KIND_LABELS: Record<TouchKind, string> = {
  impression: 'Impression',
  click: 'Click',
  visit: 'Visit',
  form: 'Form submission',
  call: 'Call',
  event_attend: 'Event attendance',
  referral: 'Referral',
  message_reply: 'Message reply',
  walk_in: 'Walk-in',
};

export const ATTRIBUTION_MODELS = ['first_touch', 'last_touch', 'linear', 'position_based'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const ATTRIBUTION_MODEL_LABELS: Record<AttributionModel, string> = {
  first_touch: 'First touch',
  last_touch: 'Last touch',
  linear: 'Linear',
  position_based: 'Position-based (U-shaped)',
};

/**
 * `MarketingLeadScoreRule` seeds — a tenant starts with a transparent,
 * reversible rule set (AI-MKT-004 may suggest changes; a human accepts them).
 * Mirrors the shape AI-LEAD-001 already scores against: `score_reasons[]`
 * must be able to name exactly which of these fired.
 */
export interface LeadScoreRuleSeed {
  name: string;
  condition: AudienceCondition;
  points: number;
  order: number;
}

export const DEFAULT_LEAD_SCORE_RULES: LeadScoreRuleSeed[] = [
  { name: 'Submitted a form', condition: { field: 'touchKind', op: 'eq', value: 'form' }, points: 10, order: 1 },
  { name: 'Attended an event', condition: { field: 'touchKind', op: 'eq', value: 'event_attend' }, points: 20, order: 2 },
  { name: 'Clicked a campaign link', condition: { field: 'touchKind', op: 'eq', value: 'click' }, points: 5, order: 3 },
  { name: 'Referred by an existing student', condition: { field: 'touchKind', op: 'eq', value: 'referral' }, points: 25, order: 4 },
  { name: 'Replied to a message', condition: { field: 'touchKind', op: 'eq', value: 'message_reply' }, points: 15, order: 5 },
  { name: 'Walked in', condition: { field: 'touchKind', op: 'eq', value: 'walk_in' }, points: 30, order: 6 },
];

// ---------------------------------------------------------------------------
// Marketing events (seminars/webinars/etc) — not the P4 event-fabric events
// ---------------------------------------------------------------------------

export const MARKETING_EVENT_KINDS = [
  'webinar', 'seminar', 'open_day', 'demo', 'college_visit', 'placement_drive', 'fair', 'other',
] as const;
export type MarketingEventKind = (typeof MARKETING_EVENT_KINDS)[number];

export const MARKETING_EVENT_KIND_LABELS: Record<MarketingEventKind, string> = {
  webinar: 'Webinar',
  seminar: 'Seminar',
  open_day: 'Open day',
  demo: 'Demo',
  college_visit: 'College visit',
  placement_drive: 'Placement drive',
  fair: 'Fair',
  other: 'Other',
};

export const MARKETING_EVENT_STATUSES = ['planned', 'open', 'closed', 'live', 'completed', 'cancelled'] as const;
export type MarketingEventStatus = (typeof MARKETING_EVENT_STATUSES)[number];

export const MARKETING_EVENT_STATUS_LABELS: Record<MarketingEventStatus, string> = {
  planned: 'Planned',
  open: 'Open for registration',
  closed: 'Registration closed',
  live: 'Live',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const MARKETING_EVENT_TRANSITIONS: Record<MarketingEventStatus, MarketingEventStatus[]> = {
  planned: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['live', 'cancelled'],
  live: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const REGISTRATION_STATUSES = ['registered', 'confirmed', 'attended', 'no_show', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  registered: 'Registered',
  confirmed: 'Confirmed',
  attended: 'Attended',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------------------
// Assets, social posts, short links
// ---------------------------------------------------------------------------

export const ASSET_KINDS = [
  'brochure', 'creative', 'video', 'deck', 'copy', 'landing_page', 'email', 'social_post', 'print', 'other',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  brochure: 'Brochure',
  creative: 'Creative',
  video: 'Video',
  deck: 'Deck',
  copy: 'Copy',
  landing_page: 'Landing page',
  email: 'Email',
  social_post: 'Social post',
  print: 'Print',
  other: 'Other',
};

export const ASSET_STATUSES = ['draft', 'in_review', 'approved', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  retired: 'Retired',
};

export const ASSET_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'draft'],
  approved: ['retired'],
  retired: [],
};

export const SOCIAL_POST_STATUSES = ['draft', 'scheduled', 'published', 'failed', 'cancelled'] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export const SOCIAL_POST_STATUS_LABELS: Record<SocialPostStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export const REFERRAL_PROGRAM_KINDS = ['student', 'partner', 'institution', 'employee'] as const;
export type ReferralProgramKind = (typeof REFERRAL_PROGRAM_KINDS)[number];

export const REFERRAL_PROGRAM_KIND_LABELS: Record<ReferralProgramKind, string> = {
  student: 'Student referral',
  partner: 'Partner referral',
  institution: 'Institution referral',
  employee: 'Employee referral',
};

export const REWARD_KINDS = ['cash', 'discount', 'credit', 'none'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export const REWARD_KIND_LABELS: Record<RewardKind, string> = {
  cash: 'Cash',
  discount: 'Discount',
  credit: 'Credit',
  none: 'None',
};

export const REFERRAL_STATUSES = ['issued', 'used', 'qualified', 'rewarded', 'void'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  issued: 'Issued',
  used: 'Used',
  qualified: 'Qualified',
  rewarded: 'Rewarded',
  void: 'Void',
};

export const REFERRAL_TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  issued: ['used', 'void'],
  used: ['qualified', 'void'],
  qualified: ['rewarded', 'void'],
  rewarded: [],
  void: [],
};

// ---------------------------------------------------------------------------
// Budget, spend, vendors, claims, plans
// ---------------------------------------------------------------------------

export const SPEND_STATUSES = ['recorded', 'reconciled'] as const;
export type SpendStatus = (typeof SPEND_STATUSES)[number];

export const SPEND_STATUS_LABELS: Record<SpendStatus, string> = {
  recorded: 'Recorded',
  reconciled: 'Reconciled with the books',
};

export const SPEND_TRANSITIONS: Record<SpendStatus, SpendStatus[]> = {
  recorded: ['reconciled'],
  reconciled: [],
};

export const CLAIM_STATUSES = ['proposed', 'approved', 'rejected', 'retired'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  retired: 'Retired',
};

export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['retired'],
  rejected: [],
  retired: [],
};

export const MARKETING_PLAN_STATUSES = ['draft', 'approved', 'active', 'closed'] as const;
export type MarketingPlanStatus = (typeof MARKETING_PLAN_STATUSES)[number];

export const MARKETING_PLAN_STATUS_LABELS: Record<MarketingPlanStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  active: 'Active',
  closed: 'Closed',
};

export const MARKETING_PLAN_TRANSITIONS: Record<MarketingPlanStatus, MarketingPlanStatus[]> = {
  draft: ['approved'],
  approved: ['active'],
  active: ['closed'],
  closed: [],
};

// ---------------------------------------------------------------------------
// Views — flat, denormalised, names resolved. The shape `LeadView` already
// establishes in api.ts: no ids the surface has to look up a second time.
// ---------------------------------------------------------------------------

export interface CampaignView {
  id: string;
  recordCode: string;
  name: string;
  objective: CampaignObjective;
  channelMix: ChannelKey[];
  division: string;
  vertical: string | null;
  startAt: string;
  endAt: string;
  status: CampaignStatus;
  budgetPlanned: number;
  budgetCommitted: number;
  budgetActual: number;
  currency: string;
  ownerPartyId: string;
  ownerName: string;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  approvalRequired: boolean;
  utmCampaign: string;
  targetLeads: number | null;
  targetEnrolments: number | null;
  targetPipelineValue: number | null;
  offeringId: string | null;
  offeringName: string | null;
  courseId: string | null;
  courseName: string | null;
  audienceId: string | null;
  audienceName: string | null;
  contentBrief: string | null;
  tags: string[];
  createdAt: string;
}

/** One row of `MarketingCampaignApproval`, as GET /campaigns/:id embeds it. */
export interface CampaignApprovalView {
  id: string;
  recordCode: string;
  requestedById: string;
  decidedById: string | null;
  decision: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  thresholdAmount: number | null;
  createdAt: string;
}

/**
 * GET /campaigns/:id — the detail view. Adds the figures a list row has no
 * business computing for every row (spend, touchpoints, attributed leads,
 * events) and the approval trail, on top of the flat `CampaignView` shape a
 * list row already carries.
 */
export interface CampaignDetailView extends CampaignView {
  approvals: CampaignApprovalView[];
  spendTotal: number;
  touchpointCount: number;
  leadCount: number;
  events: Array<{ id: string; recordCode: string; name: string; status: MarketingEventStatus; startAt: string }>;
}

export interface AudienceView {
  id: string;
  recordCode: string;
  name: string;
  kind: AudienceKind;
  entityType: AudienceEntityType;
  rules: AudienceRule;
  memberCount: number | null;
  lastEvaluatedAt: string | null;
  description: string | null;
  createdAt: string;
}

export interface TemplateView {
  id: string;
  recordCode: string;
  channelKey: ChannelKey;
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
  status: TemplateStatus;
  dltTemplateId: string | null;
  waTemplateName: string | null;
  approvedById: string | null;
  approvedByName: string | null;
  version: number;
  language: string;
  createdAt: string;
}

export interface SendView {
  id: string;
  recordCode: string;
  campaignId: string | null;
  campaignName: string | null;
  templateId: string;
  templateName: string;
  channelKey: ChannelKey;
  audienceId: string | null;
  audienceName: string | null;
  status: SendStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  bounceRate: number;
  unsubscribeRate: number;
  requestedById: string;
  requestedByName: string;
  approvedById: string | null;
  approvedByName: string | null;
  createdAt: string;
}

export interface JourneyView {
  id: string;
  recordCode: string;
  name: string;
  triggerKind: JourneyTriggerKind;
  steps: JourneyStep[];
  status: JourneyStatus;
  activeRunCount: number;
  completedRunCount: number;
  exitedRunCount: number;
  createdAt: string;
}

export interface FormView {
  id: string;
  recordCode: string;
  name: string;
  slug: string;
  fields: unknown;
  vertical: string;
  defaultCampaignId: string | null;
  defaultCampaignName: string | null;
  thankYouMessage: string;
  active: boolean;
  publicToken: string;
  submissionCount: number;
  createdAt: string;
}

export interface FormSubmissionView {
  id: string;
  formId: string;
  formName: string;
  payload: unknown;
  utm: Record<string, string | null>;
  personId: string | null;
  personName: string | null;
  leadId: string | null;
  leadRecordCode: string | null;
  status: FormSubmissionStatus;
  ip: string | null;
  userAgent: string | null;
  receivedAt: string;
}

export interface TouchpointView {
  id: string;
  personId: string | null;
  personName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  leadId: string | null;
  leadRecordCode: string | null;
  campaignId: string | null;
  campaignName: string | null;
  channelKey: ChannelKey;
  touchKind: TouchKind;
  occurredAt: string;
  utm: Record<string, string | null>;
  sourceRef: string | null;
  cost: number | null;
}

export interface AttributionView {
  id: string;
  leadId: string | null;
  leadRecordCode: string | null;
  opportunityId: string | null;
  opportunityRecordCode: string | null;
  enrollmentId: string | null;
  model: AttributionModel;
  campaignId: string | null;
  campaignName: string | null;
  channelKey: ChannelKey;
  weight: number;
  computedAt: string;
}

export interface MarketingEventView {
  id: string;
  recordCode: string;
  name: string;
  kind: MarketingEventKind;
  campaignId: string | null;
  campaignName: string | null;
  institutionId: string | null;
  institutionName: string | null;
  venue: string;
  isOnline: boolean;
  startAt: string;
  endAt: string;
  capacity: number | null;
  registeredCount: number;
  attendedCount: number;
  status: MarketingEventStatus;
  costPlanned: number;
  costActual: number;
  division: string;
  createdAt: string;
}

export interface RegistrationView {
  id: string;
  eventId: string;
  eventName: string;
  personId: string;
  personName: string;
  status: RegistrationStatus;
  source: string;
  leadId: string | null;
  leadRecordCode: string | null;
  checkedInAt: string | null;
  followUpDone: boolean;
}

export interface AssetView {
  id: string;
  recordCode: string;
  name: string;
  kind: AssetKind;
  url: string | null;
  storageRef: string | null;
  version: number;
  status: AssetStatus;
  campaignId: string | null;
  campaignName: string | null;
  usageRights: string | null;
  expiresAt: string | null;
  expired: boolean;
  approvedById: string | null;
  approvedByName: string | null;
  tags: string[];
  createdAt: string;
}

export interface SocialPostView {
  id: string;
  channelKey: ChannelKey;
  campaignId: string | null;
  campaignName: string | null;
  body: string;
  assetIds: string[];
  scheduledAt: string;
  publishedAt: string | null;
  status: SocialPostStatus;
  externalUrl: string | null;
  metrics: Record<string, number>;
}

export interface ShortLinkView {
  id: string;
  slug: string;
  targetUrl: string;
  campaignId: string | null;
  campaignName: string | null;
  channelKey: ChannelKey | null;
  utm: Record<string, string | null>;
  clickCount: number;
}

export interface ReferralProgramView {
  id: string;
  recordCode: string;
  name: string;
  kind: ReferralProgramKind;
  rewardKind: RewardKind;
  rewardAmount: number | null;
  active: boolean;
  terms: string;
}

export interface ReferralView {
  id: string;
  recordCode: string;
  programId: string;
  programName: string;
  referrerPersonId: string | null;
  referrerName: string | null;
  referrerOrganizationId: string | null;
  referrerOrganizationName: string | null;
  code: string;
  referredPersonId: string | null;
  referredName: string | null;
  leadId: string | null;
  leadRecordCode: string | null;
  status: ReferralStatus;
  rewardTransactionRef: string | null;
  createdAt: string;
}

export interface BudgetView {
  id: string;
  recordCode: string;
  period: string;
  division: string;
  channelKey: ChannelKey | null;
  campaignId: string | null;
  campaignName: string | null;
  planned: number;
  committed: number;
  spent: number;
  remaining: number;
  note: string | null;
  /** Derived from the event log (`kz.mkt.budget.approved` not superseded by a later `kz.mkt.budget.set`) — MarketingBudget carries no status field of its own. */
  approved: boolean;
  approvedById: string | null;
}

/** GET /budgets/variance — one row per MarketingBudget matching the period/division filter. */
export interface BudgetVarianceRow {
  division: string;
  channelKey: ChannelKey | null;
  campaignId: string | null;
  planned: number;
  committed: number;
  actual: number;
  variance: number;
  /** false when this period/division/channel/campaign has no *approved* budget yet. */
  measured: boolean;
}

/** GET /calendar — one row per campaign, marketing event, send or social post overlapping the range. */
export interface MarketingCalendarItem {
  id: string;
  kind: 'campaign' | 'event' | 'send' | 'social_post';
  label: string;
  startAt: string;
  endAt: string | null;
  status: string;
  division: string | null;
}

export interface SpendView {
  id: string;
  recordCode: string;
  campaignId: string | null;
  campaignName: string | null;
  channelKey: ChannelKey;
  division: string;
  amount: number;
  spendDate: string;
  vendorOrganizationId: string | null;
  vendorName: string | null;
  description: string;
  transactionId: string | null;
  vendorBillId: string | null;
  status: SpendStatus;
}

export interface VendorView {
  id: string;
  organizationId: string;
  organizationName: string;
  services: string[];
  contractRef: string | null;
  active: boolean;
  rating: number | null;
}

export interface ClaimView {
  id: string;
  recordCode: string;
  text: string;
  evidenceRef: string;
  status: ClaimStatus;
  approvedById: string | null;
  approvedByName: string | null;
  assetIds: string[];
}

export interface PlanView {
  id: string;
  recordCode: string;
  period: string;
  division: string;
  theme: string;
  goals: unknown;
  campaignIds: string[];
  status: MarketingPlanStatus;
}

export interface ChannelView {
  id: string;
  recordCode: string;
  key: ChannelKey;
  label: string;
  kind: ChannelKind;
  providerAdapter: string | null;
  configured: boolean;
  active: boolean;
  dltEntityId: string | null;
  senderIds: string[];
}

export interface PreferenceView {
  id: string;
  personId: string;
  personName: string;
  channelKey: ChannelKey;
  optedIn: boolean;
  source: PreferenceChangeSource;
  changedAt: string;
  doNotContact: boolean;
  reason: string | null;
}

/** One tile on the Marketing Overview's KPI row. */
export interface MarketingKpiTile {
  code: string;
  label: string;
  value: number;
  format: 'number' | 'currency' | 'percent';
  trend: 'up' | 'down' | 'flat' | null;
  changeVsPriorPeriod: number | null;
}

/** One stage of the marketing-to-enrolment funnel. */
export interface MarketingFunnelStage {
  stage: 'touched' | 'form_submitted' | 'lead_created' | 'qualified' | 'enrolled';
  label: string;
  count: number;
  conversionFromPrevious: number | null;
}

export interface MarketingFunnelView {
  periodLabel: string;
  stages: MarketingFunnelStage[];
}

export interface ChannelPerformanceView {
  channelKey: ChannelKey;
  channelLabel: string;
  touchpoints: number;
  leadsAttributed: number;
  costPerLead: number | null;
  spend: number;
  conversions: number;
}

export interface MarketingOverviewView {
  periodLabel: string;
  kpiTiles: MarketingKpiTile[];
  funnel: MarketingFunnelView;
  channelPerformance: ChannelPerformanceView[];
  liveCampaignCount: number;
  openExceptionCount: number;
}

// ---------------------------------------------------------------------------
// Requirement IDs (MKT-CMP-001…). Grouped by the prefixes the skeleton
// declares: MKT-CMP, MKT-AUD, MKT-CON, MKT-MSG, MKT-CAP, MKT-EVT, MKT-AST,
// MKT-REF, MKT-BUD, MKT-ANA, MKT-GOV, MKT-INT.
// ---------------------------------------------------------------------------

export interface MarketingRequirement {
  id: string;
  title: string;
}

export const MARKETING_REQUIREMENTS: MarketingRequirement[] = [
  // MKT-CMP — campaigns
  { id: 'MKT-CMP-001', title: 'A campaign is created in draft with a division, objective and channel mix.' },
  { id: 'MKT-CMP-002', title: 'A campaign above the approval threshold cannot be scheduled without approval.' },
  { id: 'MKT-CMP-003', title: "A campaign's proposer can never approve their own campaign, even the chairman." },
  { id: 'MKT-CMP-004', title: 'Only CAMPAIGN_TRANSITIONS-listed moves are accepted; anything else is rejected.' },
  { id: 'MKT-CMP-005', title: 'budgetActual is computed from linked MarketingSpend rows, never hand-edited.' },
  { id: 'MKT-CMP-006', title: 'A live campaign past its endAt raises EX-MKT-010.' },
  { id: 'MKT-CMP-007', title: 'A live campaign with no touchpoints for 7 days raises EX-MKT-004.' },
  { id: 'MKT-CMP-008', title: 'Cancelling a campaign cancels its queued sends and pauses its journeys.' },
  { id: 'MKT-CMP-009', title: 'utmCampaign is a unique slug per tenant, generated from the campaign name.' },
  { id: 'MKT-CMP-010', title: 'A campaign links at most one offering, one course and one audience.' },
  // MKT-AUD — audiences
  { id: 'MKT-AUD-001', title: 'A dynamic audience evaluates its rule tree into MarketingAudienceMember rows.' },
  { id: 'MKT-AUD-002', title: 'A static audience accepts only manual add/remove, never rule evaluation.' },
  { id: 'MKT-AUD-003', title: 'A suppression audience member is excluded from every send regardless of other audiences.' },
  { id: 'MKT-AUD-004', title: 'Rule conditions are restricted to the closed AUDIENCE_RULE_OPS set.' },
  { id: 'MKT-AUD-005', title: 'memberCount and lastEvaluatedAt are updated only by the evaluation job.' },
  { id: 'MKT-AUD-006', title: 'An audience declares exactly one AUDIENCE_ENTITY_TYPES value.' },
  // MKT-CON — consent & preferences
  { id: 'MKT-CON-001', title: "A send never reaches a person lacking a granted 'marketing' Consent." },
  { id: 'MKT-CON-002', title: 'A recipient with doNotContact=true on MarketingPreference is skipped, reason recorded.' },
  { id: 'MKT-CON-003', title: 'An opt-out via unsubscribe link updates MarketingPreference and never deletes history.' },
  { id: 'MKT-CON-004', title: 'A preference change always names its source (self_service/agent/import/unsubscribe_link/admin).' },
  { id: 'MKT-CON-005', title: 'Consent coverage of contacted people is the H_MKT consent-coverage factor input.' },
  // MKT-MSG — templates, sends, journeys
  { id: 'MKT-MSG-001', title: 'A template moves only along TEMPLATE_TRANSITIONS; retired templates cannot be sent.' },
  { id: 'MKT-MSG-002', title: 'A WhatsApp template requires waTemplateName and dltTemplateId before approval.' },
  { id: 'MKT-MSG-003', title: 'A send requires an approved template and a channel with a configured adapter.' },
  { id: 'MKT-MSG-004', title: 'A send with no configured channel adapter raises EX-MKT-011 rather than silently queuing.' },
  { id: 'MKT-MSG-005', title: 'Every recipient outcome (delivered/opened/clicked/bounced/unsubscribed) is a distinct event.' },
  { id: 'MKT-MSG-006', title: 'A bounce rate above 5% on a send raises EX-MKT-005.' },
  { id: 'MKT-MSG-007', title: 'An unsubscribe spike above 2% on a send raises EX-MKT-006.' },
  { id: 'MKT-MSG-008', title: 'A journey enrols a person on its triggerKind and advances steps on delayDays and condition.' },
  { id: 'MKT-MSG-009', title: 'A journey run overdue on nextAt by 2 days raises EX-MKT-015.' },
  { id: 'MKT-MSG-010', title: 'Every outbound send carries the X-Purpose: marketing header.' },
  // MKT-CAP — forms, capture, attribution, scoring
  { id: 'MKT-CAP-001', title: 'A public form submission is accepted only against an active publicToken.' },
  { id: 'MKT-CAP-002', title: 'A converted submission creates or finds a Person via findOrCreatePerson, never a duplicate.' },
  { id: 'MKT-CAP-003', title: 'A submission unconverted for 24h raises EX-MKT-007.' },
  { id: 'MKT-CAP-004', title: 'Every touchpoint is immutable once recorded — corrections are new rows, never edits.' },
  { id: 'MKT-CAP-005', title: 'Attribution is computed per ATTRIBUTION_MODELS and stored, never derived at render time.' },
  { id: 'MKT-CAP-006', title: 'A lead with no attributable touchpoint at creation raises EX-MKT-001.' },
  { id: 'MKT-CAP-007', title: 'Lead score is the sum of active MarketingLeadScoreRule matches, with score_reasons[] naming each.' },
  { id: 'MKT-CAP-008', title: 'Marketing never writes Lead.ownerPartyId and never routes a lead — CRM owns that.' },
  // MKT-EVT — marketing events
  { id: 'MKT-EVT-001', title: 'A marketing event moves only along MARKETING_EVENT_TRANSITIONS.' },
  { id: 'MKT-EVT-002', title: 'A registration cannot exceed a capacity-bound event once full.' },
  { id: 'MKT-EVT-003', title: 'A completed event with follow-ups outstanding after 3 days raises EX-MKT-008.' },
  { id: 'MKT-EVT-004', title: 'Checking in a registrant sets checkedInAt and flips status to attended.' },
  // MKT-AST — assets, social, links, claims
  { id: 'MKT-AST-001', title: 'An asset moves only along ASSET_TRANSITIONS; only approved assets may be used in a send or post.' },
  { id: 'MKT-AST-002', title: 'An asset used past its usageRights expiresAt raises EX-MKT-012.' },
  { id: 'MKT-AST-003', title: 'A social post publishes only assetIds that resolve to approved assets.' },
  { id: 'MKT-AST-004', title: 'A short link records every click and rolls it up onto clickCount.' },
  { id: 'MKT-AST-005', title: 'A claim moves only along CLAIM_TRANSITIONS; only approved claims may be printed or published.' },
  // MKT-REF — referrals
  { id: 'MKT-REF-001', title: 'A referral moves only along REFERRAL_TRANSITIONS.' },
  { id: 'MKT-REF-002', title: 'A referral code is unique per tenant and resolves to exactly one program.' },
  { id: 'MKT-REF-003', title: 'A reward pending beyond 30 days raises EX-MKT-013.' },
  { id: 'MKT-REF-004', title: 'Rewarding a referral references a Finance transaction; marketing never posts money itself.' },
  // MKT-BUD — budget, spend, vendors
  { id: 'MKT-BUD-001', title: 'A budget period has planned/committed/spent reconciled against linked MarketingSpend rows.' },
  { id: 'MKT-BUD-002', title: 'Spend exceeding the planned budget for a campaign raises EX-MKT-002.' },
  { id: 'MKT-BUD-003', title: 'Spend recorded against a budget period with no approved budget raises EX-MKT-014.' },
  { id: 'MKT-BUD-004', title: 'A spend moves only along SPEND_TRANSITIONS; reconciliation references the books Transaction.' },
  { id: 'MKT-BUD-005', title: 'A vendor is a specialisation of the existing Organization record, never a new party type.' },
  // MKT-ANA — analytics / health
  { id: 'MKT-ANA-001', title: 'H_MKT is not yet measured while no campaign has ever gone live.' },
  { id: 'MKT-ANA-002', title: 'Attributed-lead share, campaign-to-opportunity conversion and cost-per-lead trend are each falsifiable and drill to source rows.' },
  { id: 'MKT-ANA-003', title: 'MarketingOverviewView renders KPI tiles and a funnel from the same computed figures the drill path opens.' },
  { id: 'MKT-ANA-004', title: 'Channel performance is computed per ChannelPerformanceView from touchpoints, spend and attribution together.' },
  // MKT-GOV — grants, events, AI
  { id: 'MKT-GOV-001', title: 'Every RESOURCES entry this module adds is granted per the Role cells and no other role.' },
  { id: 'MKT-GOV-002', title: 'Every state transition emits its kz.mkt.<entity>.<verb> canonical event.' },
  { id: 'MKT-GOV-003', title: 'AI-MKT-007 (send approval) and AI-MKT-008 (budget approval) are PROHIBITED at every AUTHORITY_GRANT size.' },
  { id: 'MKT-GOV-004', title: 'Marketing never approves its own campaign or budget — the self-dealing bar applies here too.' },
  // MKT-INT — webhooks / adapters
  { id: 'MKT-INT-001', title: 'An inbound webhook is accepted only from a recognised provider and recorded before processing.' },
  { id: 'MKT-INT-002', title: 'A provider webhook failure is retried and never silently dropped — status and error are recorded.' },
  { id: 'MKT-INT-003', title: 'A channel with providerAdapter null is treated as not configured, never as a silent no-op send.' },
];
