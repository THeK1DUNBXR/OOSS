/**
 * Budget & spend (MKT-BUD-001 through MKT-BUD-012).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Set period budget (MKT-BUD-001).
 */
export async function setPeriodBudget(ctx = getContext(), data: { period: string; division: string; channelKey?: string; planned: number }): Promise<object> {
  await assertCan({ resource: 'marketing_budgets', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Approve budget (MKT-BUD-002).
 */
export async function approveBudget(ctx = getContext(), budgetId: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Record spend (MKT-BUD-003).
 */
export async function recordSpend(ctx = getContext(), data: { campaignId?: string; channelKey: string; amount: number; division: string; spendDate: Date }): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List budgets (MKT-BUD-004).
 */
export async function listBudgets(ctx = getContext(), division?: string): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List spend (MKT-BUD-005).
 */
export async function listSpend(ctx = getContext(), opts?: { campaignId?: string; division?: string }): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Reconcile spend (MKT-BUD-006).
 */
export async function reconcileSpend(ctx = getContext(), spendId: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface BudgetInput {
  period: string;
  division: string;
  planned: number;
}

export interface SpendInput {
  campaignId?: string;
  channelKey: string;
  amount: number;
}
