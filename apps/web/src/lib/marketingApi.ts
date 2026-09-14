/**
 * Marketing API client — typed functions (the `mk` namespace) plus the
 * react-query hooks every Marketing screen imports.
 *
 * Mirrors the conventions in `lib/api.ts`: `{ items, total }` for lists, the
 * bare View for a single record, a mutation returns the updated View. Every
 * list endpoint accepts the same `?q&status&division&campaignId&from&to&page&pageSize`
 * shape the contract fixes.
 *
 * `X-Purpose: marketing` rides on sends and consent/preference mutations —
 * the two families the contract calls out by name — via `purposePost`, a
 * thin sibling of `api.post` that adds the one header `api.ts` does not
 * support passing per-call.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import type {
  AssetKind,
  AssetStatus,
  AssetView,
  AttributionModel,
  AttributionView,
  AudienceEntityType,
  AudienceKind,
  AudienceRule,
  AudienceView,
  BudgetView,
  CampaignObjective,
  CampaignStatus,
  CampaignView,
  ChannelKey,
  ChannelKind,
  ChannelView,
  ClaimStatus,
  ClaimView,
  FormSubmissionStatus,
  FormSubmissionView,
  FormView,
  JourneyStep,
  JourneyStatus,
  JourneyTriggerKind,
  JourneyView,
  MarketingEventKind,
  MarketingEventStatus,
  MarketingEventView,
  PlanStatus,
  PlanView,
  PreferenceChangeSource,
  PreferenceView,
  ReferralProgramKind,
  ReferralProgramView,
  ReferralStatus,
  ReferralView,
  RegistrationStatus,
  RegistrationView,
  RewardKind,
  SendStatus,
  SendView,
  ShortLinkView,
  SocialPostStatus,
  SocialPostView,
  SpendStatus,
  SpendView,
  TemplateStatus,
  TemplateView,
  TouchKind,
  TouchpointView,
  VendorView,
} from '@kaizen/shared';
import { ApiClientError, api, getToken } from './api.js';

// ---------------------------------------------------------------------------
// Purpose-tagged POST — the same request shape as `api.post`, plus one header
// ---------------------------------------------------------------------------

async function purposePost<T>(path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Purpose': 'marketing',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = parsed?.error ?? {};
    throw new ApiClientError({
      status: res.status,
      code: err.code ?? 'UNKNOWN',
      message: err.message ?? res.statusText,
      details: err.details,
    });
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Query-string helper
// ---------------------------------------------------------------------------

type Params = Record<string, string | number | boolean | undefined | null>;

function qs(params?: Params): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * Tolerates a bare array in place of `{ items, total }`. Most list routes
 * return their full, unpaginated set today rather than a real page (see
 * review-web.md #7) — as `{ items, total }` in some places and a plain array
 * in others — so every list call runs through this one normaliser instead of
 * each hook guessing at the shape for itself.
 */
function normalizePage<T>(raw: Page<T> | T[]): Page<T> {
  return Array.isArray(raw) ? { items: raw, total: raw.length } : raw;
}

const BASE = '/marketing';

// ---------------------------------------------------------------------------
// Local response shapes — the contract's composite/analytics payloads that
// have no 1:1 View type in @kaizen/shared (that package models the entity
// records; these are the read-model shapes the analytics/settings routes
// return, each carrying the `measured` flag a KPI tile must respect).
// ---------------------------------------------------------------------------

export interface MeasuredKpi {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  delta?: number | null;
  measured: boolean;
}

export interface FunnelStage {
  key: 'touchpoints' | 'leads' | 'qualified' | 'opportunities' | 'won' | 'enrolments';
  label: string;
  count: number;
  measured: boolean;
}

export interface ConversionRate {
  from: string;
  to: string;
  rate: number | null;
}

export interface FunnelResponse {
  stages: FunnelStage[];
  conversionRates: ConversionRate[];
}

export interface AttentionItem {
  code: string;
  label: string;
  count: number;
}

export interface MarketingOverviewResponse {
  kpis: MeasuredKpi[];
  funnel: FunnelResponse;
  liveCampaigns: CampaignView[];
  attention: AttentionItem[];
}

export interface ChannelPerfRow {
  channelKey: ChannelKey;
  label: string;
  touchpoints: number;
  leads: number;
  opportunities: number;
  won: number;
  spend: number;
  costPerLead: number | null;
  roi: number | null;
  measured: boolean;
}

export interface CampaignPerfRow {
  campaignId: string;
  recordCode: string;
  name: string;
  status: CampaignStatus;
  division: string;
  leads: number;
  opportunities: number;
  won: number;
  enrolments: number;
  pipelineValue: number;
  spend: number;
  budgetPlanned: number;
  costPerLead: number | null;
  romi: number | null;
}

export interface AttributionRow {
  campaignId: string | null;
  campaignName: string;
  channelKey: ChannelKey | null;
  weightedLeads: number;
  weightedWon: number;
  weightedValue: number;
}

export interface AttributionAnalyticsResponse {
  model: AttributionModel;
  rows: AttributionRow[];
}

export interface CohortRow {
  cohort: string;
  leads: number;
  converted: number;
  enrolled: number;
  rate: number | null;
}

export interface CampaignTimelineItem {
  at: string;
  kind: string;
  label: string;
  ref: string | null;
}

export interface CampaignUtmLink {
  channelKey: ChannelKey;
  url: string;
}

export interface CampaignUtmResponse {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  links: CampaignUtmLink[];
}

export interface CampaignApprovalView {
  id: string;
  campaignId: string;
  requestedById: string;
  requestedByName: string;
  decidedById: string | null;
  decidedByName: string | null;
  decision: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  thresholdAmount: number;
  createdAt: string;
}

export interface CampaignDetailView extends CampaignView {
  approvals: CampaignApprovalView[];
  spendTotal: number;
  touchpointCount: number;
  leadCount: number;
  events: Array<{ id: string; name: string; startAt: string; status: MarketingEventStatus }>;
}

export interface CalendarItem {
  id: string;
  kind: 'campaign' | 'event' | 'send' | 'social_post';
  label: string;
  startAt: string;
  endAt: string;
  status: string;
  division: string;
}

export interface BudgetVarianceRow {
  division: string;
  channelKey: ChannelKey | null;
  campaignId: string | null;
  planned: number;
  committed: number;
  actual: number;
  variance: number;
  measured: boolean;
}

export interface AudienceDetailView extends AudienceView {
  members: Array<{ id: string; entityType: string; entityId: string; addedAt: string; source: string; suppressed: boolean }>;
}

export interface AudienceField {
  field: string;
  label: string;
  type: string;
  ops: string[];
}

export interface AudiencePreviewResponse {
  count: number;
  sample: Array<{ entityId: string; label: string }>;
}

export interface AudienceEvaluateResponse {
  memberCount: number;
  addedCount: number;
  removedCount: number;
  evaluatedAt: string;
}

export interface ConsentInfo {
  status: string;
  purposeCode: 'marketing';
  recordedAt: string;
  channel: string;
  evidence: unknown;
}

export interface PreferencesResponse {
  personId: string;
  consent: ConsentInfo | null;
  channels: PreferenceView[];
  doNotContact: boolean;
}

export interface PreferenceCoverageResponse {
  contacted: number;
  consented: number;
  missing: number;
  measured: boolean;
}

export interface TemplatePreviewResponse {
  subject: string | null;
  body: string;
  missing: string[];
}

export interface MergeField {
  key: string;
  label: string;
  example: string;
}

export interface SendRecipientView {
  id: string;
  sendId: string;
  personId: string;
  personName: string;
  status: string;
  reason: string | null;
  providerMessageId: string | null;
}

export interface SendDetailView extends SendView {
  recipientStatusBreakdown: Record<string, number>;
}

export interface DryRunResponse {
  eligible: number;
  skipped: Array<{ personId: string; reason: string }>;
}

export interface ScoreRuleView {
  id: string;
  name: string;
  condition: unknown;
  points: number;
  active: boolean;
  order: number;
}

export interface ScoreRulePreviewResponse {
  score: number;
  reasons: string[];
}

export interface FormDetailView extends FormView {
  conversionRate: number | null;
}

export interface FormEmbedResponse {
  publicUrl: string;
  embedSnippet: string;
}

export interface EventDetailView extends MarketingEventView {
  costPerAttendee: number | null;
}

export interface ReferralLeaderboardRow {
  referrerLabel: string;
  issued: number;
  used: number;
  qualified: number;
  rewarded: number;
}

export interface MarketingPolicy {
  campaignApprovalThreshold: number;
  sendApprovalThreshold: number;
  bounceAlertRate: number;
  unsubscribeAlertRate: number;
  staleCampaignDays: number;
  formConvertSlaHours: number;
}

export interface MarketingWebhookInboundView {
  id: string;
  provider: string;
  eventKind: string;
  receivedAt: string;
  processedAt: string | null;
  status: string;
  error: string | null;
}

export interface AdapterStatusRow {
  channelKey: ChannelKey;
  provider: string | null;
  configured: boolean;
}

export interface AiTouchpointRow {
  code: string;
  label: string;
  tier: string;
}

export interface AiDraftResponse {
  actionId: string;
  tier: string;
  draft: string | string[];
}

// ---------------------------------------------------------------------------
// mk — raw typed functions, one per endpoint
// ---------------------------------------------------------------------------

export const mk = {
  // Overview / analytics -----------------------------------------------------
  getOverview: () => api.get<MarketingOverviewResponse>(`${BASE}/overview`),
  getFunnel: (params?: { from?: string; to?: string; division?: string; campaignId?: string }) =>
    api.get<FunnelResponse>(`${BASE}/analytics/funnel${qs(params)}`),
  getChannelPerformance: (params?: { from?: string; to?: string }) =>
    api.get<ChannelPerfRow[]>(`${BASE}/analytics/channels${qs(params)}`),
  getCampaignPerformance: (params?: { from?: string; to?: string }) =>
    api.get<CampaignPerfRow[]>(`${BASE}/analytics/campaigns${qs(params)}`),
  getAttribution: (params: { model: AttributionModel; from?: string; to?: string }) =>
    api.get<AttributionAnalyticsResponse>(`${BASE}/analytics/attribution${qs(params)}`),
  getCohorts: (params?: { by?: 'month' }) => api.get<CohortRow[]>(`${BASE}/analytics/cohorts${qs(params)}`),
  exportAnalytics: (kind: 'campaigns' | 'channels' | 'leads', fallbackName: string, params?: { from?: string; to?: string }) =>
    api.download(`${BASE}/analytics/export${qs({ kind, ...params })}`, fallbackName),

  // Campaigns ------------------------------------------------------------------
  listCampaigns: (params?: Params) => api.get<Page<CampaignView> | CampaignView[]>(`${BASE}/campaigns${qs(params)}`).then(normalizePage),
  getCampaign: (id: string) => api.get<CampaignDetailView>(`${BASE}/campaigns/${id}`),
  createCampaign: (body: {
    name: string;
    objective: CampaignObjective;
    division: string;
    vertical?: string;
    channelMix: ChannelKey[];
    startAt: string;
    endAt: string;
    budgetPlanned: number;
    currency?: string;
    offeringId?: string;
    courseId?: string;
    audienceId?: string;
    contentBrief?: string;
    tags?: string[];
    targetLeads?: number;
    targetEnrolments?: number;
    targetPipelineValue?: number;
    utmCampaign?: string;
  }) => api.post<CampaignView>(`${BASE}/campaigns`, body),
  updateCampaign: (id: string, body: Partial<Record<string, unknown>>) =>
    api.patch<CampaignView>(`${BASE}/campaigns/${id}`, body),
  deleteCampaign: (id: string) => api.del<void>(`${BASE}/campaigns/${id}`),
  submitCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/submit`),
  approveCampaign: (id: string, reason?: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/approve`, { reason }),
  rejectCampaign: (id: string, reason: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/reject`, { reason }),
  launchCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/launch`),
  pauseCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/pause`),
  resumeCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/resume`),
  completeCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/complete`),
  archiveCampaign: (id: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/archive`),
  cancelCampaign: (id: string, reason: string) => api.post<CampaignView>(`${BASE}/campaigns/${id}/cancel`, { reason }),
  getCampaignTimeline: (id: string) => api.get<CampaignTimelineItem[]>(`${BASE}/campaigns/${id}/timeline`),
  getCampaignUtm: (id: string) => api.get<CampaignUtmResponse>(`${BASE}/campaigns/${id}/utm`),

  // Plans & calendar -------------------------------------------------------------
  listPlans: (params?: Params) => api.get<Page<PlanView> | PlanView[]>(`${BASE}/plans${qs(params)}`).then(normalizePage),
  createPlan: (body: { period: string; division: string; theme: string; goals?: unknown; campaignIds?: string[] }) =>
    api.post<PlanView>(`${BASE}/plans`, body),
  updatePlan: (id: string, body: Partial<Record<string, unknown>>) => api.patch<PlanView>(`${BASE}/plans/${id}`, body),
  approvePlan: (id: string) => api.post<PlanView>(`${BASE}/plans/${id}/approve`),
  closePlan: (id: string) => api.post<PlanView>(`${BASE}/plans/${id}/close`),
  getCalendar: (params: { from: string; to: string }) => api.get<CalendarItem[]>(`${BASE}/calendar${qs(params)}`),

  // Budget & spend ------------------------------------------------------------
  listBudgets: (params?: { period?: string; division?: string }) => api.get<Page<BudgetView> | BudgetView[]>(`${BASE}/budgets${qs(params)}`).then(normalizePage),
  createBudget: (body: { period: string; division: string; channelKey?: ChannelKey; campaignId?: string; planned: number; note?: string }) =>
    api.post<BudgetView>(`${BASE}/budgets`, body),
  updateBudget: (id: string, body: Partial<Record<string, unknown>>) => api.patch<BudgetView>(`${BASE}/budgets/${id}`, body),
  approveBudget: (id: string) => api.post<BudgetView>(`${BASE}/budgets/${id}/approve`),
  listSpends: (params?: { campaignId?: string; from?: string; to?: string }) => api.get<Page<SpendView> | SpendView[]>(`${BASE}/spends${qs(params)}`).then(normalizePage),
  createSpend: (body: {
    campaignId?: string;
    channelKey: ChannelKey;
    division: string;
    amount: number;
    spendDate: string;
    vendorOrganizationId?: string;
    description: string;
    transactionId?: string;
    vendorBillId?: string;
  }) => api.post<SpendView>(`${BASE}/spends`, body),
  reconcileSpend: (id: string, body: { transactionId?: string; vendorBillId?: string }) =>
    api.post<SpendView>(`${BASE}/spends/${id}/reconcile`, body),
  getBudgetVariance: (params: { period: string; division?: string }) => api.get<BudgetVarianceRow[]>(`${BASE}/budgets/variance${qs(params)}`),
  listVendors: () => api.get<Page<VendorView> | VendorView[]>(`${BASE}/vendors`).then(normalizePage),
  createVendor: (body: { organizationId: string; services: string[]; contractRef?: string }) => api.post<VendorView>(`${BASE}/vendors`, body),
  updateVendor: (id: string, body: Partial<Record<string, unknown>>) => api.patch<VendorView>(`${BASE}/vendors/${id}`, body),

  // Audiences ------------------------------------------------------------------
  listAudiences: (params?: Params) => api.get<Page<AudienceView> | AudienceView[]>(`${BASE}/audiences${qs(params)}`).then(normalizePage),
  getAudience: (id: string) => api.get<AudienceDetailView>(`${BASE}/audiences/${id}`),
  createAudience: (body: { name: string; kind: AudienceKind; entityType: AudienceEntityType; rules?: AudienceRule; description?: string }) =>
    api.post<AudienceView>(`${BASE}/audiences`, body),
  updateAudience: (id: string, body: Partial<Record<string, unknown>>) => api.patch<AudienceView>(`${BASE}/audiences/${id}`, body),
  deleteAudience: (id: string) => api.del<void>(`${BASE}/audiences/${id}`),
  evaluateAudience: (id: string) => api.post<AudienceEvaluateResponse>(`${BASE}/audiences/${id}/evaluate`),
  addAudienceMembers: (id: string, members: Array<{ entityType: string; entityId: string }>) =>
    api.post<void>(`${BASE}/audiences/${id}/members`, members),
  removeAudienceMember: (id: string, memberId: string) => api.del<void>(`${BASE}/audiences/${id}/members/${memberId}`),
  suppressAudienceMember: (id: string, memberId: string, reason: string) =>
    api.post<void>(`${BASE}/audiences/${id}/suppress`, { memberId, reason }),
  previewAudience: (body: { entityType: string; rules: AudienceRule }) => api.post<AudiencePreviewResponse>(`${BASE}/audiences/preview`, body),
  getAudienceFields: (entityType: string) => api.get<AudienceField[]>(`${BASE}/audiences/fields${qs({ entityType })}`),

  // Consent & preferences --------------------------------------------------------
  getPreferences: (personId: string) => api.get<PreferencesResponse>(`${BASE}/preferences${qs({ personId })}`),
  recordConsent: (body: { personId: string; channel: 'portal' | 'in_app' | 'paper' | 'verbal' | 'guardian_intake'; evidence?: unknown }) =>
    purposePost<PreferencesResponse>(`${BASE}/preferences/consent`, body),
  withdrawConsent: (body: { personId: string; reason?: string }) => purposePost<PreferencesResponse>(`${BASE}/preferences/withdraw`, body),
  setChannelPreference: (body: { personId: string; channelKey: ChannelKey; optedIn: boolean; source?: PreferenceChangeSource }) =>
    purposePost<PreferenceView>(`${BASE}/preferences/channel`, body),
  setDoNotContact: (body: { personId: string; doNotContact: boolean; reason: string }) =>
    purposePost<PreferencesResponse>(`${BASE}/preferences/do-not-contact`, body),
  getPreferenceCoverage: () => api.get<PreferenceCoverageResponse>(`${BASE}/preferences/coverage`),

  // Templates --------------------------------------------------------------------
  listTemplates: (params?: { channelKey?: ChannelKey; status?: TemplateStatus }) => api.get<Page<TemplateView> | TemplateView[]>(`${BASE}/templates${qs(params)}`).then(normalizePage),
  getTemplate: (id: string) => api.get<TemplateView>(`${BASE}/templates/${id}`),
  createTemplate: (body: { channelKey: ChannelKey; name: string; subject?: string; body: string; language?: string; dltTemplateId?: string; waTemplateName?: string }) =>
    api.post<TemplateView>(`${BASE}/templates`, body),
  updateTemplate: (id: string, body: Partial<Record<string, unknown>>) => api.patch<TemplateView>(`${BASE}/templates/${id}`, body),
  submitTemplate: (id: string) => api.post<TemplateView>(`${BASE}/templates/${id}/submit`),
  approveTemplate: (id: string) => api.post<TemplateView>(`${BASE}/templates/${id}/approve`),
  rejectTemplate: (id: string, reason: string) => api.post<TemplateView>(`${BASE}/templates/${id}/reject`, { reason }),
  retireTemplate: (id: string) => api.post<TemplateView>(`${BASE}/templates/${id}/retire`),
  previewTemplate: (id: string, personId?: string) => api.post<TemplatePreviewResponse>(`${BASE}/templates/${id}/preview`, { personId }),
  getMergeFields: () => api.get<MergeField[]>(`${BASE}/templates/merge-fields`),

  // Sends ----------------------------------------------------------------------
  listSends: (params?: Params) => api.get<Page<SendView> | SendView[]>(`${BASE}/sends${qs(params)}`).then(normalizePage),
  getSend: (id: string) => api.get<SendDetailView>(`${BASE}/sends/${id}`),
  createSend: (body: { campaignId?: string; templateId: string; channelKey: ChannelKey; audienceId: string; scheduledAt?: string }) =>
    purposePost<SendView>(`${BASE}/sends`, body),
  requestSend: (id: string) => purposePost<SendView>(`${BASE}/sends/${id}/request`),
  approveSend: (id: string) => purposePost<SendView>(`${BASE}/sends/${id}/approve`),
  cancelSend: (id: string) => purposePost<SendView>(`${BASE}/sends/${id}/cancel`),
  dispatchSend: (id: string) => purposePost<SendView>(`${BASE}/sends/${id}/dispatch`),
  listSendRecipients: (id: string, status?: string) => api.get<SendRecipientView[]>(`${BASE}/sends/${id}/recipients${qs({ status })}`),
  getSendDryRun: (id: string) => api.get<DryRunResponse>(`${BASE}/sends/${id}/dry-run`),
  sendTest: (body: { templateId: string; channelKey: ChannelKey; to: string }) => purposePost<{ ok: boolean }>(`${BASE}/sends/test`, body),

  // Journeys -----------------------------------------------------------------
  listJourneys: (params?: Params) => api.get<Page<JourneyView> | JourneyView[]>(`${BASE}/journeys${qs(params)}`).then(normalizePage),
  getJourney: (id: string) => api.get<JourneyView>(`${BASE}/journeys/${id}`),
  createJourney: (body: { name: string; triggerKind: JourneyTriggerKind; steps: JourneyStep[]; audienceId?: string }) =>
    api.post<JourneyView>(`${BASE}/journeys`, body),
  updateJourney: (id: string, body: Partial<Record<string, unknown>>) => api.patch<JourneyView>(`${BASE}/journeys/${id}`, body),
  activateJourney: (id: string) => api.post<JourneyView>(`${BASE}/journeys/${id}/activate`),
  pauseJourney: (id: string) => api.post<JourneyView>(`${BASE}/journeys/${id}/pause`),
  retireJourney: (id: string) => api.post<JourneyView>(`${BASE}/journeys/${id}/retire`),
  listJourneyRuns: (id: string, status?: string) => api.get<Page<{ id: string; personId: string; personName: string; currentStep: number; status: string; nextAt: string | null }> | { id: string; personId: string; personName: string; currentStep: number; status: string; nextAt: string | null }[]>(`${BASE}/journeys/${id}/runs${qs({ status })}`).then(normalizePage),
  enrolInJourney: (id: string, personId: string) => api.post<void>(`${BASE}/journeys/${id}/enrol`, { personId }),
  exitJourneyRun: (runId: string, reason: string) => api.post<void>(`${BASE}/journeys/runs/${runId}/exit`, { reason }),

  // Forms, submissions, touchpoints, scoring, links -------------------------
  listForms: (params?: Params) => api.get<Page<FormView> | FormView[]>(`${BASE}/forms${qs(params)}`).then(normalizePage),
  getForm: (id: string) => api.get<FormDetailView>(`${BASE}/forms/${id}`),
  createForm: (body: { name: string; slug: string; fields: unknown[]; vertical: string; defaultCampaignId?: string; thankYouMessage?: string }) =>
    api.post<FormView>(`${BASE}/forms`, body),
  updateForm: (id: string, body: Partial<Record<string, unknown>>) => api.patch<FormView>(`${BASE}/forms/${id}`, body),
  publishForm: (id: string) => api.post<FormView>(`${BASE}/forms/${id}/publish`),
  unpublishForm: (id: string) => api.post<FormView>(`${BASE}/forms/${id}/unpublish`),
  rotateFormToken: (id: string) => api.post<FormView>(`${BASE}/forms/${id}/rotate-token`),
  getFormEmbed: (id: string) => api.get<FormEmbedResponse>(`${BASE}/forms/${id}/embed`),
  listFormSubmissions: (id: string, status?: FormSubmissionStatus) => api.get<Page<FormSubmissionView> | FormSubmissionView[]>(`${BASE}/forms/${id}/submissions${qs({ status })}`).then(normalizePage),
  convertSubmission: (id: string) => api.post<FormSubmissionView>(`${BASE}/submissions/${id}/convert`),
  rejectSubmission: (id: string, reason: string) => api.post<FormSubmissionView>(`${BASE}/submissions/${id}/reject`, { reason }),
  markSubmissionSpam: (id: string) => api.post<FormSubmissionView>(`${BASE}/submissions/${id}/mark-spam`),
  listTouchpoints: (params?: { personId?: string; leadId?: string; campaignId?: string; from?: string; to?: string }) =>
    api.get<Page<TouchpointView> | TouchpointView[]>(`${BASE}/touchpoints${qs(params)}`).then(normalizePage),
  createTouchpoint: (body: {
    personId?: string;
    leadId?: string;
    organizationId?: string;
    campaignId?: string;
    channelKey: ChannelKey;
    touchKind: TouchKind;
    occurredAt?: string;
    utm?: Record<string, string>;
    sourceRef?: string;
    cost?: number;
  }) => api.post<TouchpointView>(`${BASE}/touchpoints`, body),
  recomputeAttribution: (params?: { from?: string; to?: string }) => api.post<{ computed: number }>(`${BASE}/attribution/recompute${qs(params)}`),
  getLeadAttribution: (leadId: string) => api.get<AttributionView[]>(`${BASE}/attribution/lead/${leadId}`),
  listScoreRules: () => api.get<ScoreRuleView[]>(`${BASE}/score-rules`),
  createScoreRule: (body: { name: string; condition: unknown; points: number; order?: number }) => api.post<ScoreRuleView>(`${BASE}/score-rules`, body),
  updateScoreRule: (id: string, body: Partial<Record<string, unknown>>) => api.patch<ScoreRuleView>(`${BASE}/score-rules/${id}`, body),
  deleteScoreRule: (id: string) => api.del<void>(`${BASE}/score-rules/${id}`),
  previewScoreRules: (leadId: string) => api.post<ScoreRulePreviewResponse>(`${BASE}/score-rules/preview`, { leadId }),
  applyScoreRules: () => api.post<{ updated: number }>(`${BASE}/score-rules/apply`),
  listLinks: () => api.get<Page<ShortLinkView> | ShortLinkView[]>(`${BASE}/links`).then(normalizePage),
  createLink: (body: { slug?: string; targetUrl: string; campaignId?: string; channelKey?: ChannelKey; utm?: Record<string, string> }) =>
    api.post<ShortLinkView>(`${BASE}/links`, body),

  // Events -----------------------------------------------------------------
  listEvents: (params?: Params) => api.get<Page<MarketingEventView> | MarketingEventView[]>(`${BASE}/events${qs(params)}`).then(normalizePage),
  getEvent: (id: string) => api.get<EventDetailView>(`${BASE}/events/${id}`),
  createEvent: (body: {
    name: string;
    kind: MarketingEventKind;
    campaignId?: string;
    institutionId?: string;
    venue?: string;
    isOnline: boolean;
    startAt: string;
    endAt: string;
    capacity?: number;
    costPlanned?: number;
    division: string;
  }) => api.post<MarketingEventView>(`${BASE}/events`, body),
  updateEvent: (id: string, body: Partial<Record<string, unknown>>) => api.patch<MarketingEventView>(`${BASE}/events/${id}`, body),
  openEvent: (id: string) => api.post<MarketingEventView>(`${BASE}/events/${id}/open`),
  closeEvent: (id: string) => api.post<MarketingEventView>(`${BASE}/events/${id}/close`),
  startEvent: (id: string) => api.post<MarketingEventView>(`${BASE}/events/${id}/start`),
  completeEvent: (id: string) => api.post<MarketingEventView>(`${BASE}/events/${id}/complete`),
  cancelEvent: (id: string, reason: string) => api.post<MarketingEventView>(`${BASE}/events/${id}/cancel`, { reason }),
  listRegistrations: (id: string) => api.get<Page<RegistrationView> | RegistrationView[]>(`${BASE}/events/${id}/registrations`).then(normalizePage),
  registerForEvent: (id: string, body: { personId?: string; person?: { fullName: string; primaryPhone?: string; primaryEmail?: string }; source?: string }) =>
    api.post<RegistrationView>(`${BASE}/events/${id}/register`, body),
  confirmRegistration: (id: string) => api.post<RegistrationView>(`${BASE}/events/registrations/${id}/confirm`),
  checkInRegistration: (id: string) => api.post<RegistrationView>(`${BASE}/events/registrations/${id}/check-in`),
  noShowRegistration: (id: string) => api.post<RegistrationView>(`${BASE}/events/registrations/${id}/no-show`),
  cancelRegistration: (id: string) => api.post<RegistrationView>(`${BASE}/events/registrations/${id}/cancel`),
  followUpRegistration: (id: string, done: boolean, note?: string) => api.post<RegistrationView>(`${BASE}/events/registrations/${id}/follow-up`, { done, note }),
  convertAttendees: (id: string) => api.post<{ created: number }>(`${BASE}/events/${id}/convert-attendees`),
  exportEvent: (id: string, fallbackName: string) => api.download(`${BASE}/events/${id}/export`, fallbackName),

  // Assets, social, claims --------------------------------------------------
  listAssets: (params?: Params) => api.get<Page<AssetView> | AssetView[]>(`${BASE}/assets${qs(params)}`).then(normalizePage),
  getAsset: (id: string) => api.get<AssetView>(`${BASE}/assets/${id}`),
  createAsset: (body: { name: string; kind: AssetKind; url?: string; campaignId?: string; usageRights?: string; expiresAt?: string; tags?: string[] }) =>
    api.post<AssetView>(`${BASE}/assets`, body),
  updateAsset: (id: string, body: Partial<Record<string, unknown>>) => api.patch<AssetView>(`${BASE}/assets/${id}`, body),
  submitAsset: (id: string) => api.post<AssetView>(`${BASE}/assets/${id}/submit`),
  approveAsset: (id: string) => api.post<AssetView>(`${BASE}/assets/${id}/approve`),
  rejectAsset: (id: string, reason: string) => api.post<AssetView>(`${BASE}/assets/${id}/reject`, { reason }),
  retireAsset: (id: string) => api.post<AssetView>(`${BASE}/assets/${id}/retire`),
  listSocialPosts: (params?: { from?: string; to?: string; channelKey?: ChannelKey }) => api.get<Page<SocialPostView> | SocialPostView[]>(`${BASE}/social-posts${qs(params)}`).then(normalizePage),
  createSocialPost: (body: { channelKey: ChannelKey; campaignId?: string; body: string; assetIds?: string[]; scheduledAt: string }) =>
    api.post<SocialPostView>(`${BASE}/social-posts`, body),
  updateSocialPost: (id: string, body: Partial<Record<string, unknown>>) => api.patch<SocialPostView>(`${BASE}/social-posts/${id}`, body),
  publishSocialPost: (id: string, externalUrl?: string) => api.post<SocialPostView>(`${BASE}/social-posts/${id}/publish`, { externalUrl }),
  cancelSocialPost: (id: string) => api.post<SocialPostView>(`${BASE}/social-posts/${id}/cancel`),
  recordSocialMetrics: (id: string, body: { likes?: number; comments?: number; shares?: number; reach?: number; clicks?: number }) =>
    api.post<SocialPostView>(`${BASE}/social-posts/${id}/metrics`, body),
  listClaims: () => api.get<Page<ClaimView> | ClaimView[]>(`${BASE}/claims`).then(normalizePage),
  createClaim: (body: { text: string; evidenceRef?: string; assetIds?: string[] }) => api.post<ClaimView>(`${BASE}/claims`, body),
  approveClaim: (id: string) => api.post<ClaimView>(`${BASE}/claims/${id}/approve`),
  rejectClaim: (id: string, reason: string) => api.post<ClaimView>(`${BASE}/claims/${id}/reject`, { reason }),
  retireClaim: (id: string) => api.post<ClaimView>(`${BASE}/claims/${id}/retire`),

  // Referrals ----------------------------------------------------------------
  listReferralPrograms: () => api.get<Page<ReferralProgramView> | ReferralProgramView[]>(`${BASE}/referral-programs`).then(normalizePage),
  createReferralProgram: (body: { name: string; kind: ReferralProgramKind; rewardKind: RewardKind; rewardAmount?: number; terms?: string }) =>
    api.post<ReferralProgramView>(`${BASE}/referral-programs`, body),
  updateReferralProgram: (id: string, body: Partial<Record<string, unknown>>) => api.patch<ReferralProgramView>(`${BASE}/referral-programs/${id}`, body),
  activateReferralProgram: (id: string) => api.post<ReferralProgramView>(`${BASE}/referral-programs/${id}/activate`),
  deactivateReferralProgram: (id: string) => api.post<ReferralProgramView>(`${BASE}/referral-programs/${id}/deactivate`),
  listReferrals: (params?: { programId?: string; status?: ReferralStatus }) => api.get<Page<ReferralView> | ReferralView[]>(`${BASE}/referrals${qs(params)}`).then(normalizePage),
  issueReferral: (body: { programId: string; referrerPersonId?: string; referrerOrganizationId?: string }) =>
    api.post<ReferralView>(`${BASE}/referrals/issue`, body),
  redeemReferral: (body: { code: string; referredPersonId?: string; person?: { fullName: string; primaryPhone?: string; primaryEmail?: string } }) =>
    api.post<ReferralView>(`${BASE}/referrals/redeem`, body),
  qualifyReferral: (id: string) => api.post<ReferralView>(`${BASE}/referrals/${id}/qualify`),
  rewardReferral: (id: string, rewardTransactionRef?: string) => api.post<ReferralView>(`${BASE}/referrals/${id}/reward`, { rewardTransactionRef }),
  voidReferral: (id: string, reason: string) => api.post<ReferralView>(`${BASE}/referrals/${id}/void`, { reason }),
  getReferralLeaderboard: (programId: string) => api.get<ReferralLeaderboardRow[]>(`${BASE}/referrals/leaderboard${qs({ programId })}`),

  // Settings --------------------------------------------------------------------
  listChannels: () => api.get<Page<ChannelView> | ChannelView[]>(`${BASE}/settings/channels`).then(normalizePage),
  createChannel: (body: { key: ChannelKey; label: string; kind: ChannelKind; senderIds?: string[]; dltEntityId?: string; config?: unknown }) =>
    api.post<ChannelView>(`${BASE}/settings/channels`, body),
  updateChannel: (id: string, body: Partial<Record<string, unknown>>) => api.patch<ChannelView>(`${BASE}/settings/channels/${id}`, body),
  getAdapterStatus: () => api.get<AdapterStatusRow[]>(`${BASE}/settings/adapters`),
  getPolicy: () => api.get<MarketingPolicy>(`${BASE}/settings/policy`),
  updatePolicy: (body: Partial<MarketingPolicy>) => api.patch<MarketingPolicy>(`${BASE}/settings/policy`, body),
  listWebhooks: () => api.get<MarketingWebhookInboundView[]>(`${BASE}/settings/webhooks`),
  getAiTouchpoints: () => api.get<AiTouchpointRow[]>(`${BASE}/settings/ai-touchpoints`),
  requestAiDraft: (body: { kind: 'campaign_brief' | 'copy' | 'subject_lines' | 'segment' | 'next_best_action'; context: unknown }) =>
    api.post<AiDraftResponse>(`${BASE}/ai/draft`, body),
};

// ---------------------------------------------------------------------------
// Small generic query/mutation helpers
// ---------------------------------------------------------------------------

function useMkMutation<TVars, TRes>(fn: (vars: TVars) => Promise<TRes>, invalidate: unknown[][]): UseMutationResult<TRes, unknown, TVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of invalidate) qc.invalidateQueries({ queryKey: key });
    },
  });
}

// ---------------------------------------------------------------------------
// Hooks — Overview / analytics
// ---------------------------------------------------------------------------

export function useMarketingOverview(): UseQueryResult<MarketingOverviewResponse> {
  return useQuery({ queryKey: ['mkt', 'overview'], queryFn: mk.getOverview });
}

export function useMarketingFunnel(params?: { from?: string; to?: string; division?: string; campaignId?: string }) {
  return useQuery({ queryKey: ['mkt', 'analytics', 'funnel', params], queryFn: () => mk.getFunnel(params) });
}

export function useChannelPerformance(params?: { from?: string; to?: string }) {
  return useQuery({ queryKey: ['mkt', 'analytics', 'channels', params], queryFn: () => mk.getChannelPerformance(params) });
}

export function useCampaignPerformance(params?: { from?: string; to?: string }) {
  return useQuery({ queryKey: ['mkt', 'analytics', 'campaigns', params], queryFn: () => mk.getCampaignPerformance(params) });
}

export function useAttributionAnalytics(params: { model: AttributionModel; from?: string; to?: string }) {
  return useQuery({ queryKey: ['mkt', 'analytics', 'attribution', params], queryFn: () => mk.getAttribution(params) });
}

export function useCohorts(params?: { by?: 'month' }) {
  return useQuery({ queryKey: ['mkt', 'analytics', 'cohorts', params], queryFn: () => mk.getCohorts(params) });
}

// ---------------------------------------------------------------------------
// Hooks — Campaigns
// ---------------------------------------------------------------------------

export function useCampaigns(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'campaigns', params], queryFn: () => mk.listCampaigns(params) });
}

export function useCampaign(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'campaign', id], queryFn: () => mk.getCampaign(id as string), enabled: Boolean(id) });
}

export function useCreateCampaign() {
  return useMkMutation(mk.createCampaign, [['mkt', 'campaigns']]);
}

export function useUpdateCampaign(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateCampaign(id, body), [['mkt', 'campaigns'], ['mkt', 'campaign', id]]);
}

export function useDeleteCampaign() {
  return useMkMutation(mk.deleteCampaign, [['mkt', 'campaigns']]);
}

function useCampaignAction(fn: (id: string) => Promise<CampaignView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['mkt', 'campaigns'] });
      qc.invalidateQueries({ queryKey: ['mkt', 'campaign', id] });
      qc.invalidateQueries({ queryKey: ['mkt', 'overview'] });
    },
  });
}

export function useSubmitCampaign() {
  return useCampaignAction(mk.submitCampaign);
}
export function useLaunchCampaign() {
  return useCampaignAction(mk.launchCampaign);
}
export function usePauseCampaign() {
  return useCampaignAction(mk.pauseCampaign);
}
export function useResumeCampaign() {
  return useCampaignAction(mk.resumeCampaign);
}
export function useCompleteCampaign() {
  return useCampaignAction(mk.completeCampaign);
}
export function useArchiveCampaign() {
  return useCampaignAction(mk.archiveCampaign);
}

export function useApproveCampaign(id: string) {
  return useMkMutation((reason?: string) => mk.approveCampaign(id, reason), [['mkt', 'campaigns'], ['mkt', 'campaign', id]]);
}
export function useRejectCampaign(id: string) {
  return useMkMutation((reason: string) => mk.rejectCampaign(id, reason), [['mkt', 'campaigns'], ['mkt', 'campaign', id]]);
}
export function useCancelCampaign(id: string) {
  return useMkMutation((reason: string) => mk.cancelCampaign(id, reason), [['mkt', 'campaigns'], ['mkt', 'campaign', id]]);
}

export function useCampaignTimeline(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'campaign', id, 'timeline'], queryFn: () => mk.getCampaignTimeline(id as string), enabled: Boolean(id) });
}

export function useCampaignUtm(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'campaign', id, 'utm'], queryFn: () => mk.getCampaignUtm(id as string), enabled: Boolean(id) });
}

// ---------------------------------------------------------------------------
// Hooks — Plans & calendar
// ---------------------------------------------------------------------------

export function usePlans(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'plans', params], queryFn: () => mk.listPlans(params) });
}
export function useCreatePlan() {
  return useMkMutation(mk.createPlan, [['mkt', 'plans']]);
}
export function useUpdatePlan(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updatePlan(id, body), [['mkt', 'plans']]);
}
export function useApprovePlan() {
  return useMkMutation(mk.approvePlan, [['mkt', 'plans']]);
}
export function useClosePlan() {
  return useMkMutation(mk.closePlan, [['mkt', 'plans']]);
}
export function useCalendar(params: { from: string; to: string }) {
  return useQuery({ queryKey: ['mkt', 'calendar', params], queryFn: () => mk.getCalendar(params) });
}

// ---------------------------------------------------------------------------
// Hooks — Budget & spend
// ---------------------------------------------------------------------------

export function useBudgets(params?: { period?: string; division?: string }) {
  return useQuery({ queryKey: ['mkt', 'budgets', params], queryFn: () => mk.listBudgets(params) });
}
export function useCreateBudget() {
  return useMkMutation(mk.createBudget, [['mkt', 'budgets'], ['mkt', 'budget', 'variance']]);
}
export function useUpdateBudget(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateBudget(id, body), [['mkt', 'budgets']]);
}
export function useApproveBudget() {
  return useMkMutation(mk.approveBudget, [['mkt', 'budgets'], ['mkt', 'budget', 'variance']]);
}
export function useSpends(params?: { campaignId?: string; from?: string; to?: string }) {
  return useQuery({ queryKey: ['mkt', 'spends', params], queryFn: () => mk.listSpends(params) });
}
export function useCreateSpend() {
  return useMkMutation(mk.createSpend, [['mkt', 'spends'], ['mkt', 'budget', 'variance'], ['mkt', 'campaigns']]);
}
export function useReconcileSpend() {
  return useMkMutation(({ id, body }: { id: string; body: { transactionId?: string; vendorBillId?: string } }) => mk.reconcileSpend(id, body), [
    ['mkt', 'spends'],
  ]);
}
export function useBudgetVariance(params: { period: string; division?: string }) {
  return useQuery({ queryKey: ['mkt', 'budget', 'variance', params], queryFn: () => mk.getBudgetVariance(params) });
}
export function useVendors() {
  return useQuery({ queryKey: ['mkt', 'vendors'], queryFn: mk.listVendors });
}
export function useCreateVendor() {
  return useMkMutation(mk.createVendor, [['mkt', 'vendors']]);
}
export function useUpdateVendor(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateVendor(id, body), [['mkt', 'vendors']]);
}

// ---------------------------------------------------------------------------
// Hooks — Audiences
// ---------------------------------------------------------------------------

export function useAudiences(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'audiences', params], queryFn: () => mk.listAudiences(params) });
}
export function useAudience(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'audience', id], queryFn: () => mk.getAudience(id as string), enabled: Boolean(id) });
}
export function useCreateAudience() {
  return useMkMutation(mk.createAudience, [['mkt', 'audiences']]);
}
export function useUpdateAudience(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateAudience(id, body), [['mkt', 'audiences'], ['mkt', 'audience', id]]);
}
export function useDeleteAudience() {
  return useMkMutation(mk.deleteAudience, [['mkt', 'audiences']]);
}
export function useEvaluateAudience(id: string) {
  return useMkMutation(() => mk.evaluateAudience(id), [['mkt', 'audiences'], ['mkt', 'audience', id]]);
}
export function useAddAudienceMembers(id: string) {
  return useMkMutation((members: Array<{ entityType: string; entityId: string }>) => mk.addAudienceMembers(id, members), [['mkt', 'audience', id]]);
}
export function useRemoveAudienceMember(id: string) {
  return useMkMutation((memberId: string) => mk.removeAudienceMember(id, memberId), [['mkt', 'audience', id]]);
}
export function useSuppressAudienceMember(id: string) {
  return useMkMutation(({ memberId, reason }: { memberId: string; reason: string }) => mk.suppressAudienceMember(id, memberId, reason), [
    ['mkt', 'audience', id],
  ]);
}
export function usePreviewAudience() {
  return useMutation({ mutationFn: mk.previewAudience });
}
export function useAudienceFields(entityType: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'audience-fields', entityType], queryFn: () => mk.getAudienceFields(entityType as string), enabled: Boolean(entityType) });
}

// ---------------------------------------------------------------------------
// Hooks — Consent & preferences
// ---------------------------------------------------------------------------

export function usePreferences(personId: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'preferences', personId], queryFn: () => mk.getPreferences(personId as string), enabled: Boolean(personId) });
}
export function useRecordConsent() {
  return useMkMutation(mk.recordConsent, [['mkt', 'preferences']]);
}
export function useWithdrawConsent() {
  return useMkMutation(mk.withdrawConsent, [['mkt', 'preferences']]);
}
export function useSetChannelPreference() {
  return useMkMutation(mk.setChannelPreference, [['mkt', 'preferences']]);
}
export function useSetDoNotContact() {
  return useMkMutation(mk.setDoNotContact, [['mkt', 'preferences']]);
}
export function usePreferenceCoverage() {
  return useQuery({ queryKey: ['mkt', 'preferences', 'coverage'], queryFn: mk.getPreferenceCoverage });
}

// ---------------------------------------------------------------------------
// Hooks — Templates
// ---------------------------------------------------------------------------

export function useTemplates(params?: { channelKey?: ChannelKey; status?: TemplateStatus }) {
  return useQuery({ queryKey: ['mkt', 'templates', params], queryFn: () => mk.listTemplates(params) });
}
export function useTemplate(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'template', id], queryFn: () => mk.getTemplate(id as string), enabled: Boolean(id) });
}
export function useCreateTemplate() {
  return useMkMutation(mk.createTemplate, [['mkt', 'templates']]);
}
export function useUpdateTemplate(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateTemplate(id, body), [['mkt', 'templates'], ['mkt', 'template', id]]);
}
export function useSubmitTemplate() {
  return useMkMutation(mk.submitTemplate, [['mkt', 'templates']]);
}
export function useApproveTemplate() {
  return useMkMutation(mk.approveTemplate, [['mkt', 'templates']]);
}
export function useRejectTemplate() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.rejectTemplate(id, reason), [['mkt', 'templates']]);
}
export function useRetireTemplate() {
  return useMkMutation(mk.retireTemplate, [['mkt', 'templates']]);
}
export function usePreviewTemplate() {
  return useMutation({ mutationFn: ({ id, personId }: { id: string; personId?: string }) => mk.previewTemplate(id, personId) });
}
export function useMergeFields() {
  return useQuery({ queryKey: ['mkt', 'templates', 'merge-fields'], queryFn: mk.getMergeFields });
}

// ---------------------------------------------------------------------------
// Hooks — Sends
// ---------------------------------------------------------------------------

export function useSends(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'sends', params], queryFn: () => mk.listSends(params) });
}
export function useSend(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'send', id], queryFn: () => mk.getSend(id as string), enabled: Boolean(id) });
}
export function useCreateSend() {
  return useMkMutation(mk.createSend, [['mkt', 'sends']]);
}
function useSendAction(fn: (id: string) => Promise<SendView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['mkt', 'sends'] });
      qc.invalidateQueries({ queryKey: ['mkt', 'send', id] });
    },
  });
}
export function useRequestSend() {
  return useSendAction(mk.requestSend);
}
export function useApproveSend() {
  return useSendAction(mk.approveSend);
}
export function useCancelSend() {
  return useSendAction(mk.cancelSend);
}
export function useDispatchSend() {
  return useSendAction(mk.dispatchSend);
}
export function useSendRecipients(id: string | undefined, status?: string) {
  return useQuery({ queryKey: ['mkt', 'send', id, 'recipients', status], queryFn: () => mk.listSendRecipients(id as string, status), enabled: Boolean(id) });
}
export function useSendDryRun(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'send', id, 'dry-run'], queryFn: () => mk.getSendDryRun(id as string), enabled: Boolean(id) });
}
export function useSendTest() {
  return useMutation({ mutationFn: mk.sendTest });
}

// ---------------------------------------------------------------------------
// Hooks — Journeys
// ---------------------------------------------------------------------------

export function useJourneys(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'journeys', params], queryFn: () => mk.listJourneys(params) });
}
export function useJourney(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'journey', id], queryFn: () => mk.getJourney(id as string), enabled: Boolean(id) });
}
export function useCreateJourney() {
  return useMkMutation(mk.createJourney, [['mkt', 'journeys']]);
}
export function useUpdateJourney(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateJourney(id, body), [['mkt', 'journeys'], ['mkt', 'journey', id]]);
}
export function useActivateJourney() {
  return useMkMutation(mk.activateJourney, [['mkt', 'journeys']]);
}
export function usePauseJourney() {
  return useMkMutation(mk.pauseJourney, [['mkt', 'journeys']]);
}
export function useRetireJourney() {
  return useMkMutation(mk.retireJourney, [['mkt', 'journeys']]);
}
export function useJourneyRuns(id: string | undefined, status?: string) {
  return useQuery({ queryKey: ['mkt', 'journey', id, 'runs', status], queryFn: () => mk.listJourneyRuns(id as string, status), enabled: Boolean(id) });
}
export function useEnrolInJourney(id: string) {
  return useMkMutation((personId: string) => mk.enrolInJourney(id, personId), [['mkt', 'journey', id, 'runs']]);
}
export function useExitJourneyRun() {
  return useMutation({ mutationFn: ({ runId, reason }: { runId: string; reason: string }) => mk.exitJourneyRun(runId, reason) });
}

// ---------------------------------------------------------------------------
// Hooks — Forms, submissions, touchpoints, scoring, links
// ---------------------------------------------------------------------------

export function useForms(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'forms', params], queryFn: () => mk.listForms(params) });
}
export function useForm(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'form', id], queryFn: () => mk.getForm(id as string), enabled: Boolean(id) });
}
export function useCreateForm() {
  return useMkMutation(mk.createForm, [['mkt', 'forms']]);
}
export function useUpdateForm(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateForm(id, body), [['mkt', 'forms'], ['mkt', 'form', id]]);
}
export function usePublishForm() {
  return useMkMutation(mk.publishForm, [['mkt', 'forms']]);
}
export function useUnpublishForm() {
  return useMkMutation(mk.unpublishForm, [['mkt', 'forms']]);
}
export function useRotateFormToken() {
  return useMkMutation(mk.rotateFormToken, [['mkt', 'forms']]);
}
export function useFormEmbed(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'form', id, 'embed'], queryFn: () => mk.getFormEmbed(id as string), enabled: Boolean(id) });
}
export function useFormSubmissions(id: string | undefined, status?: FormSubmissionStatus) {
  return useQuery({ queryKey: ['mkt', 'form', id, 'submissions', status], queryFn: () => mk.listFormSubmissions(id as string, status), enabled: Boolean(id) });
}
export function useConvertSubmission() {
  return useMkMutation(mk.convertSubmission, [['mkt', 'form']]);
}
export function useRejectSubmission() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.rejectSubmission(id, reason), [['mkt', 'form']]);
}
export function useMarkSubmissionSpam() {
  return useMkMutation(mk.markSubmissionSpam, [['mkt', 'form']]);
}
export function useTouchpoints(params?: { personId?: string; leadId?: string; campaignId?: string; from?: string; to?: string }) {
  return useQuery({ queryKey: ['mkt', 'touchpoints', params], queryFn: () => mk.listTouchpoints(params) });
}
export function useCreateTouchpoint() {
  return useMkMutation(mk.createTouchpoint, [['mkt', 'touchpoints']]);
}
export function useRecomputeAttribution() {
  return useMutation({ mutationFn: mk.recomputeAttribution });
}
export function useLeadAttribution(leadId: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'attribution', 'lead', leadId], queryFn: () => mk.getLeadAttribution(leadId as string), enabled: Boolean(leadId) });
}
export function useScoreRules() {
  return useQuery({ queryKey: ['mkt', 'score-rules'], queryFn: mk.listScoreRules });
}
export function useCreateScoreRule() {
  return useMkMutation(mk.createScoreRule, [['mkt', 'score-rules']]);
}
export function useUpdateScoreRule(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateScoreRule(id, body), [['mkt', 'score-rules']]);
}
export function useDeleteScoreRule() {
  return useMkMutation(mk.deleteScoreRule, [['mkt', 'score-rules']]);
}
export function usePreviewScoreRules() {
  return useMutation({ mutationFn: mk.previewScoreRules });
}
export function useApplyScoreRules() {
  return useMutation({ mutationFn: mk.applyScoreRules });
}
export function useLinks() {
  return useQuery({ queryKey: ['mkt', 'links'], queryFn: mk.listLinks });
}
export function useCreateLink() {
  return useMkMutation(mk.createLink, [['mkt', 'links']]);
}

// ---------------------------------------------------------------------------
// Hooks — Events
// ---------------------------------------------------------------------------

export function useMarketingEvents(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'events', params], queryFn: () => mk.listEvents(params) });
}
export function useMarketingEvent(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'event', id], queryFn: () => mk.getEvent(id as string), enabled: Boolean(id) });
}
export function useCreateMarketingEvent() {
  return useMkMutation(mk.createEvent, [['mkt', 'events']]);
}
export function useUpdateMarketingEvent(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateEvent(id, body), [['mkt', 'events'], ['mkt', 'event', id]]);
}
function useEventAction(fn: (id: string) => Promise<MarketingEventView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['mkt', 'events'] });
      qc.invalidateQueries({ queryKey: ['mkt', 'event', id] });
    },
  });
}
export function useOpenEvent() {
  return useEventAction(mk.openEvent);
}
export function useCloseEvent() {
  return useEventAction(mk.closeEvent);
}
export function useStartEvent() {
  return useEventAction(mk.startEvent);
}
export function useCompleteEvent() {
  return useEventAction(mk.completeEvent);
}
export function useCancelEvent() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.cancelEvent(id, reason), [['mkt', 'events']]);
}
export function useEventRegistrations(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'event', id, 'registrations'], queryFn: () => mk.listRegistrations(id as string), enabled: Boolean(id) });
}
export function useRegisterForEvent(id: string) {
  return useMkMutation(
    (body: { personId?: string; person?: { fullName: string; primaryPhone?: string; primaryEmail?: string }; source?: string }) =>
      mk.registerForEvent(id, body),
    [['mkt', 'event', id, 'registrations'], ['mkt', 'event', id]],
  );
}
function useRegistrationAction(fn: (id: string) => Promise<RegistrationView>, eventId: string) {
  return useMkMutation(fn, [['mkt', 'event', eventId, 'registrations']]);
}
export function useConfirmRegistration(eventId: string) {
  return useRegistrationAction(mk.confirmRegistration, eventId);
}
export function useCheckInRegistration(eventId: string) {
  return useRegistrationAction(mk.checkInRegistration, eventId);
}
export function useNoShowRegistration(eventId: string) {
  return useRegistrationAction(mk.noShowRegistration, eventId);
}
export function useCancelRegistration(eventId: string) {
  return useRegistrationAction(mk.cancelRegistration, eventId);
}
export function useFollowUpRegistration(eventId: string) {
  return useMkMutation(({ id, done, note }: { id: string; done: boolean; note?: string }) => mk.followUpRegistration(id, done, note), [
    ['mkt', 'event', eventId, 'registrations'],
  ]);
}
export function useConvertAttendees(eventId: string) {
  return useMkMutation(() => mk.convertAttendees(eventId), [['mkt', 'event', eventId, 'registrations']]);
}

// ---------------------------------------------------------------------------
// Hooks — Assets, social, claims
// ---------------------------------------------------------------------------

export function useAssets(params?: Params) {
  return useQuery({ queryKey: ['mkt', 'assets', params], queryFn: () => mk.listAssets(params) });
}
export function useAsset(id: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'asset', id], queryFn: () => mk.getAsset(id as string), enabled: Boolean(id) });
}
export function useCreateAsset() {
  return useMkMutation(mk.createAsset, [['mkt', 'assets']]);
}
export function useUpdateAsset(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateAsset(id, body), [['mkt', 'assets'], ['mkt', 'asset', id]]);
}
export function useSubmitAsset() {
  return useMkMutation(mk.submitAsset, [['mkt', 'assets']]);
}
export function useApproveAsset() {
  return useMkMutation(mk.approveAsset, [['mkt', 'assets']]);
}
export function useRejectAsset() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.rejectAsset(id, reason), [['mkt', 'assets']]);
}
export function useRetireAsset() {
  return useMkMutation(mk.retireAsset, [['mkt', 'assets']]);
}
export function useSocialPosts(params?: { from?: string; to?: string; channelKey?: ChannelKey }) {
  return useQuery({ queryKey: ['mkt', 'social-posts', params], queryFn: () => mk.listSocialPosts(params) });
}
export function useCreateSocialPost() {
  return useMkMutation(mk.createSocialPost, [['mkt', 'social-posts']]);
}
export function useUpdateSocialPost(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateSocialPost(id, body), [['mkt', 'social-posts']]);
}
export function usePublishSocialPost() {
  return useMkMutation(({ id, externalUrl }: { id: string; externalUrl?: string }) => mk.publishSocialPost(id, externalUrl), [['mkt', 'social-posts']]);
}
export function useCancelSocialPost() {
  return useMkMutation(mk.cancelSocialPost, [['mkt', 'social-posts']]);
}
export function useRecordSocialMetrics() {
  return useMkMutation(
    ({ id, body }: { id: string; body: { likes?: number; comments?: number; shares?: number; reach?: number; clicks?: number } }) =>
      mk.recordSocialMetrics(id, body),
    [['mkt', 'social-posts']],
  );
}
export function useClaims() {
  return useQuery({ queryKey: ['mkt', 'claims'], queryFn: mk.listClaims });
}
export function useCreateClaim() {
  return useMkMutation(mk.createClaim, [['mkt', 'claims']]);
}
export function useApproveClaim() {
  return useMkMutation(mk.approveClaim, [['mkt', 'claims']]);
}
export function useRejectClaim() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.rejectClaim(id, reason), [['mkt', 'claims']]);
}
export function useRetireClaim() {
  return useMkMutation(mk.retireClaim, [['mkt', 'claims']]);
}

// ---------------------------------------------------------------------------
// Hooks — Referrals
// ---------------------------------------------------------------------------

export function useReferralPrograms() {
  return useQuery({ queryKey: ['mkt', 'referral-programs'], queryFn: mk.listReferralPrograms });
}
export function useCreateReferralProgram() {
  return useMkMutation(mk.createReferralProgram, [['mkt', 'referral-programs']]);
}
export function useUpdateReferralProgram(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateReferralProgram(id, body), [['mkt', 'referral-programs']]);
}
export function useActivateReferralProgram() {
  return useMkMutation(mk.activateReferralProgram, [['mkt', 'referral-programs']]);
}
export function useDeactivateReferralProgram() {
  return useMkMutation(mk.deactivateReferralProgram, [['mkt', 'referral-programs']]);
}
export function useReferrals(params?: { programId?: string; status?: ReferralStatus }) {
  return useQuery({ queryKey: ['mkt', 'referrals', params], queryFn: () => mk.listReferrals(params) });
}
export function useIssueReferral() {
  return useMkMutation(mk.issueReferral, [['mkt', 'referrals']]);
}
export function useRedeemReferral() {
  return useMkMutation(mk.redeemReferral, [['mkt', 'referrals']]);
}
export function useQualifyReferral() {
  return useMkMutation(mk.qualifyReferral, [['mkt', 'referrals']]);
}
export function useRewardReferral() {
  return useMkMutation(({ id, rewardTransactionRef }: { id: string; rewardTransactionRef?: string }) => mk.rewardReferral(id, rewardTransactionRef), [
    ['mkt', 'referrals'],
  ]);
}
export function useVoidReferral() {
  return useMkMutation(({ id, reason }: { id: string; reason: string }) => mk.voidReferral(id, reason), [['mkt', 'referrals']]);
}
export function useReferralLeaderboard(programId: string | undefined) {
  return useQuery({ queryKey: ['mkt', 'referrals', 'leaderboard', programId], queryFn: () => mk.getReferralLeaderboard(programId as string), enabled: Boolean(programId) });
}

// ---------------------------------------------------------------------------
// Hooks — Settings
// ---------------------------------------------------------------------------

export function useChannels() {
  return useQuery({ queryKey: ['mkt', 'settings', 'channels'], queryFn: mk.listChannels });
}
export function useCreateChannel() {
  return useMkMutation(mk.createChannel, [['mkt', 'settings', 'channels']]);
}
export function useUpdateChannel(id: string) {
  return useMkMutation((body: Partial<Record<string, unknown>>) => mk.updateChannel(id, body), [['mkt', 'settings', 'channels']]);
}
export function useAdapterStatus() {
  return useQuery({ queryKey: ['mkt', 'settings', 'adapters'], queryFn: mk.getAdapterStatus });
}
export function useMarketingPolicy() {
  return useQuery({ queryKey: ['mkt', 'settings', 'policy'], queryFn: mk.getPolicy });
}
export function useUpdateMarketingPolicy() {
  return useMkMutation(mk.updatePolicy, [['mkt', 'settings', 'policy']]);
}
export function useWebhookLog() {
  return useQuery({ queryKey: ['mkt', 'settings', 'webhooks'], queryFn: mk.listWebhooks });
}
export function useAiTouchpoints() {
  return useQuery({ queryKey: ['mkt', 'settings', 'ai-touchpoints'], queryFn: mk.getAiTouchpoints });
}
export function useRequestAiDraft() {
  return useMutation({ mutationFn: mk.requestAiDraft });
}
