/**
 * Analytics & health scoring (MKT-ANA-001 through MKT-ANA-008).
 *
 * Computes the H_MKT health domain (attributed lead share, campaign conversion,
 * cost per lead, consent coverage, deliverability).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

export interface HealthScore {
  domain: 'H_MKT';
  score: number; // 0-100
  factors: Array<{ name: string; value: number; weight: number; drill: string }>;
  status: 'measured' | 'not_yet_measured' | 'incomplete';
  lastComputedAt: Date;
}

export interface MetricsView {
  period: string;
  metrics: Record<string, number>;
}

/**
 * Compute marketing health (MKT-ANA-001).
 *
 * Factors: (1) attributed-lead share, (2) campaign-to-opportunity conversion,
 * (3) cost per lead trend, (4) consent coverage, (5) send deliverability.
 * Returns NOT_YET_MEASURED if no campaign has ever gone live.
 */
export async function computeMarketingHealth(ctx = getContext()): Promise<HealthScore> {
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List metrics (MKT-ANA-002).
 */
export async function listMetrics(ctx = getContext(), opts?: { period?: string; channelKey?: string }): Promise<MetricsView[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Attribution metrics (MKT-ANA-003).
 */
export async function attributionMetrics(ctx = getContext(), campaignId?: string): Promise<Record<string, number>> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Campaign performance (MKT-ANA-004).
 */
export async function campaignPerformance(ctx = getContext(), campaignId: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Channel comparison (MKT-ANA-005).
 */
export async function channelComparison(ctx = getContext(), opts?: { period?: string; division?: string }): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
