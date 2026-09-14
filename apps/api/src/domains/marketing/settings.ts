/**
 * Settings (MKT-GOV-001 through MKT-GOV-012).
 *
 * Channel configuration, vendor management, score rules, claims/compliance,
 * approval thresholds, webhook configuration.
 */

import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

/**
 * Configure a channel (MKT-GOV-001).
 *
 * Sets provider adapter, env config, sender IDs, etc.
 */
export async function configureChannel(
  ctx = getContext(),
  data: { key: string; label: string; kind: string; providerAdapter?: string; config?: object; senderIds?: string[] },
): Promise<object> {
  await assertCan({ resource: 'marketing_settings', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List channels (MKT-GOV-001).
 */
export async function listChannels(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Activate a channel (MKT-GOV-002).
 */
export async function activateChannel(ctx = getContext(), key: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Deactivate a channel (MKT-GOV-003).
 */
export async function deactivateChannel(ctx = getContext(), key: string): Promise<object> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Create a vendor (MKT-GOV-004).
 */
export async function createVendor(ctx = getContext(), data: { organizationId: string; services: string[]; contractRef?: string }): Promise<object> {
  await assertCan({ resource: 'marketing_settings', verb: 'create' });
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List vendors (MKT-GOV-005).
 */
export async function listVendors(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Record a webhook event (inbound) (MKT-GOV-006).
 */
export async function recordWebhookEvent(ctx = getContext(), provider: string, payload: unknown): Promise<void> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List webhooks (MKT-GOV-007).
 */
export async function listWebhooks(ctx = getContext()): Promise<object[]> {
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

export interface ChannelInput {
  key: string;
  label: string;
  kind: string;
}

export interface VendorInput {
  organizationId: string;
  services: string[];
}
