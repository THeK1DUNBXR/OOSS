/**
 * Consent & Preferences (MKT-CON-001 through MKT-CON-012).
 *
 * Reuses the existing Consent model (compliance-privacy.prisma) with
 * purposeCode='marketing'. Additional MarketingPreference rows track
 * per-channel opt-in/opt-out and do-not-contact flags.
 *
 * DPDP Act 2023 compliance: consent is immutable once recorded; withdrawal
 * creates a new row with withdrawn=true, never deletes the original.
 */

import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

export interface PreferenceView {
  id: string;
  personId: string;
  channelKey: string;
  optedIn: boolean;
  doNotContact: boolean;
  changedAt: Date;
  reason?: string;
  evidence?: object;
}

export const PreferenceInputSchema = z.object({
  channelKey: z.enum(['email', 'sms', 'whatsapp', 'social_meta', 'social_linkedin', 'google_ads']),
  optedIn: z.boolean(),
  doNotContact: z.boolean().optional(),
  reason: z.string().optional(),
  evidence: z.unknown().optional(),
});

export type PreferenceInput = z.infer<typeof PreferenceInputSchema>;

/**
 * Record a consent decision (MKT-CON-001).
 *
 * Reuses Consent model with purposeCode='marketing'. Creates an immutable
 * row; consent never overwrites itself.
 */
export async function recordConsent(ctx = getContext(), personId: string, granted: boolean, evidence?: object): Promise<void> {
  // TODO: Create Consent row with purposeCode='marketing'
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Record or update a channel preference (MKT-CON-002).
 *
 * Tracks per-channel opt-in/opt-out and do-not-contact. Creates new
 * MarketingPreference row (immutable history).
 */
export async function recordPreference(ctx = getContext(), personId: string, data: PreferenceInput): Promise<PreferenceView> {
  // TODO: Create MarketingPreference row
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List current preferences for a person (MKT-CON-003).
 */
export async function listPreferences(ctx = getContext(), personId?: string): Promise<PreferenceView[]> {
  await assertCan({ resource: 'marketing_templates', verb: 'view' });

  // TODO: Query and return current preferences
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update a preference (MKT-CON-002).
 *
 * Convenience for recordPreference; creates new row with updated state.
 */
export async function updatePreference(ctx = getContext(), personId: string, channelKey: string, data: Partial<PreferenceInput>): Promise<PreferenceView> {
  // TODO: Create new MarketingPreference row
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Consent history for a person (immutable log) (MKT-CON-004).
 */
export async function consentHistoryFor(ctx = getContext(), personId: string): Promise<Array<{ grantedAt: Date; granted: boolean; evidence?: object }>> {
  // TODO: Query Consent rows with purposeCode='marketing'
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
