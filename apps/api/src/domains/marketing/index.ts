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
 *
 * Each domain file has its own vocabulary (several reuse names like
 * `listChannels` or `campaigns` across files), so this aggregator re-exports
 * each file as its own namespace rather than flattening everything into one
 * name table — callers that want the flat names already import directly from
 * the domain file (see every routes/marketing/*.routes.ts).
 */

export * as campaigns from './campaigns.js';
export * as plans from './plans.js';
export * as audiences from './audiences.js';
export * as preferences from './preferences.js';
export * as messaging from './messaging.js';
export * as journeys from './journeys.js';
export * as capture from './capture.js';
export * as attribution from './attribution.js';
export * as events from './events.js';
export * as assets from './assets.js';
export * as referrals from './referrals.js';
export * as budget from './budget.js';
export * as analytics from './analytics.js';
export * as settings from './settings.js';
export * as ai from './ai.js';

// Pluggable adapters
export { type ChannelAdapter, type OutboundMessage, type SendResult } from './adapters/types.js';
export { renderMergeFields, extractMergeFields } from './adapters/merge.js';
export { ConsoleAdapter } from './adapters/console.js';
export { NotConfiguredAdapter } from './adapters/notConfigured.js';
