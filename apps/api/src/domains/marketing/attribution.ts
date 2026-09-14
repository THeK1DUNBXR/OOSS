/**
 * Attribution & lead scoring (MKT-CAP-009 through MKT-CAP-014).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Record a touchpoint (MKT-CAP-009).
 */
export async function recordTouchpoint(ctx = getContext(), data: { personId?: string; campaignId?: string; channelKey: string; touchKind: string; utm?: object }): Promise<void> {
  // TODO: Create touchpoint row
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Compute attribution (MKT-CAP-010).
 */
export async function computeAttribution(ctx = getContext(), leadId: string, model: 'first_touch' | 'last_touch' | 'linear' | 'position_based'): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update lead score rule (MKT-CAP-011).
 */
export async function updateLeadScoreRule(ctx = getContext(), data: { name: string; condition: object; points: number; active: boolean }): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List lead score rules (MKT-CAP-011).
 */
export async function listLeadScoreRules(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Score a lead now (MKT-CAP-012).
 */
export async function scoreLeadNow(ctx = getContext(), leadId: string): Promise<{ score: number }> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface TouchpointInput {
  personId?: string;
  campaignId?: string;
  channelKey: string;
  touchKind: string;
  utm?: object;
}
