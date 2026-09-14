/**
 * Referral & affiliate programs (MKT-REF-001 through MKT-REF-010).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Create a referral program (MKT-REF-001).
 */
export async function createReferralProgram(ctx = getContext(), data: { name: string; kind: string; rewardKind: string; rewardAmount?: number }): Promise<object> {
  await assertCan({ resource: 'marketing_referrals', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Issue a referral code (MKT-REF-002).
 */
export async function issueReferralCode(ctx = getContext(), programId: string, referrerPersonId?: string): Promise<{ code: string }> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Use a referral code (MKT-REF-003).
 */
export async function useReferralCode(ctx = getContext(), code: string, referredPersonId?: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List referrals (MKT-REF-004).
 */
export async function listReferrals(ctx = getContext(), programId?: string): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Record a reward (MKT-REF-005).
 */
export async function recordReward(ctx = getContext(), referralId: string, transactionRef?: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface ReferralProgramInput {
  name: string;
  kind: string;
  rewardKind: string;
}

export interface ReferralInput {
  code: string;
  referredPersonId?: string;
}
