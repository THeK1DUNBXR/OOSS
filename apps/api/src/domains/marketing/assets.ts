/**
 * Content library & assets (MKT-AST-001 through MKT-AST-012).
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Create an asset (MKT-AST-001).
 */
export async function createAsset(ctx = getContext(), data: { name: string; kind: string; url?: string; storageRef?: string }): Promise<object> {
  await assertCan({ resource: 'marketing_assets', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List assets (MKT-AST-001).
 */
export async function listAssets(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load an asset (MKT-AST-001).
 */
export async function loadAsset(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update an asset (MKT-AST-002).
 */
export async function updateAsset(ctx = getContext(), id: string, data: Partial<object>): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Submit for approval (MKT-AST-003).
 */
export async function submitForApproval(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Approve an asset (MKT-AST-004).
 */
export async function approveAsset(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Retire an asset (MKT-AST-005).
 */
export async function retireAsset(ctx = getContext(), id: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface AssetView {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  status: 'draft' | 'in_review' | 'approved' | 'retired';
}

export interface AssetInput {
  name: string;
  kind: string;
}
