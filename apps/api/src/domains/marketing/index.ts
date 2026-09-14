/**
 * Marketing domain — the fourth commercial pillar alongside CRM, HR and Finance.
 *
 * Marketing owns reach (audiences, channels, campaigns), spend (budgets, vendor
 * spend), consent (preferences, DLT registration), and attribution (touchpoints,
 * lead scoring, journey automation). It never books money (Finance owns that)
 * and never owns a pipeline stage (CRM owns that); it exports scored, attributed
 * leads to CRM and cost lines to Finance.
 *
 * Module code: mkt | Bounded context: mkt | Plane: P2 (World Model)
 * Health domain: H_MKT | Event prefix: kz.mkt.<entity>.<verb>
 * Routes base: /api/marketing | Nav group: Marketing
 */

// Campaigns
export {
  createCampaign,
  listCampaigns,
  loadCampaign,
  updateCampaign,
  requestApproval,
  approveCampaign,
  rejectCampaign,
  scheduleCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  archiveCampaign,
  cloneCampaign,
  type CampaignInput,
  type CampaignView,
} from './campaigns.js';

// Audiences & Segmentation
export {
  createAudience,
  listAudiences,
  loadAudience,
  updateAudience,
  evaluateAudience,
  addAudienceMember,
  suppressMember,
  listAudienceMembers,
  type AudienceInput,
  type AudienceView,
} from './audiences.js';

// Consent & Preferences
export {
  recordConsent,
  recordPreference,
  listPreferences,
  updatePreference,
  consentHistoryFor,
  type PreferenceInput,
  type PreferenceView,
} from './preferences.js';

// Messaging (Templates & Sends)
export {
  createTemplate,
  listTemplates,
  loadTemplate,
  updateTemplate,
  submitForReview,
  approveTemplate,
  rejectTemplate,
  retireTemplate,
  previewTemplate,
  mergeFieldsCatalogue,
  createSend,
  listSends,
  loadSend,
  requestSend,
  approveSend,
  cancelSend,
  dispatchSend,
  dryRunSend,
  applyDeliveryEvents,
  checkSendHealth,
  sendTest,
  listSendRecipients,
  type TemplateInput,
  type TemplateView,
  type SendInput,
  type SendView,
  type SendRecipientView,
} from './messaging.js';

// Journeys
export {
  createJourney,
  listJourneys,
  loadJourney,
  updateJourney,
  activateJourney,
  pauseJourney,
  resumeJourney,
  retireJourney,
  listJourneyRuns,
  enrolPerson,
  exitRun,
  tick,
  detectStuckRuns,
  onLeadCreated,
  onFormSubmitted,
  onEventRegistered,
  onEnrolment,
  type JourneyInput,
  type JourneyView,
  type JourneyRunView,
} from './journeys.js';

// Forms & Lead Capture
export {
  createForm,
  listForms,
  loadForm,
  updateForm,
  publishForm,
  archiveForm,
  submitFormResponse,
  listFormSubmissions,
  type FormInput,
  type FormView,
} from './capture.js';

// Attribution & Scoring
export {
  recordTouchpoint,
  computeAttribution,
  updateLeadScoreRule,
  listLeadScoreRules,
  scoreLeadNow,
  type TouchpointInput,
} from './attribution.js';

// Events & Registrations
export {
  createEvent,
  listEvents,
  loadEvent,
  updateEvent,
  openEvent,
  closeEvent,
  startEvent,
  completeEvent,
  cancelEvent,
  registerForEvent,
  listEventRegistrations,
  confirmRegistration,
  checkInRegistration,
  markNoShow,
  cancelRegistration,
  followUpRegistration,
  convertAttendees,
  exportRegistrations,
  detectFollowUpsOutstanding,
  type EventInput,
  type EventView,
  type RegisterInput,
} from './events.js';

// Assets, Content Library & Social Posts
export {
  createAsset,
  listAssets,
  loadAsset,
  updateAsset,
  submitForApproval,
  approveAsset,
  rejectAsset,
  retireAsset,
  detectExpiredAssetsInUse,
  createSocialPost,
  listSocialPosts,
  loadSocialPost,
  updateSocialPost,
  scheduleSocialPost,
  publishSocialPost,
  cancelSocialPost,
  recordSocialMetrics,
  type AssetInput,
  type AssetView,
  type SocialPostInput,
} from './assets.js';

// Referrals & Affiliate Programs
export {
  createReferralProgram,
  listReferralPrograms,
  loadReferralProgram,
  updateReferralProgram,
  activateReferralProgram,
  deactivateReferralProgram,
  issueReferral,
  redeemReferral,
  listReferrals,
  qualifyReferral,
  rewardReferral,
  voidReferral,
  leaderboard,
  detectRewardsPending,
  type ReferralProgramInput,
  type ReferralInput,
} from './referrals.js';

// Budget & Spend
export {
  setPeriodBudget,
  approveBudget,
  recordSpend,
  listBudgets,
  listSpend,
  reconcileSpend,
  type BudgetInput,
  type SpendInput,
} from './budget.js';

// Analytics & Health
export {
  overview,
  funnel,
  channels,
  campaigns as campaignPerformance,
  attributionSummary,
  cohorts,
  exportCsv,
  type KpiTile,
  type MarketingOverviewView,
  type MarketingFunnelView,
  type ChannelPerformanceView,
  type CampaignPerformanceView,
  type AttributionSummaryView,
  type CohortRow,
} from './analytics.js';

// Settings (Channels, Vendors, Webhooks)
export {
  configureChannel,
  listChannels,
  activateChannel,
  deactivateChannel,
  createVendor,
  listVendors,
  recordWebhookEvent,
  listWebhooks,
  type ChannelInput,
  type VendorInput,
} from './settings.js';

// Pluggable adapters
export { type ChannelAdapter, type OutboundMessage, type SendResult } from './adapters/types.js';
export { renderMergeFields, extractMergeFields } from './adapters/merge.js';
export { ConsoleAdapter } from './adapters/console.js';
export { NotConfiguredAdapter } from './adapters/notConfigured.js';
