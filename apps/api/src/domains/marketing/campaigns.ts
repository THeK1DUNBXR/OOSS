/**
 * Campaign lifecycle management (MKT-CMP-001 through MKT-CMP-015).
 *
 * A campaign is a unit of intent: one objective, one budget, one owner, one
 * division, run across one or more channels, moving through a fixed state
 * machine (draft → scheduled → live → paused → completed → archived, or
 * draft → archived directly).
 *
 * Campaigns are subject to two-person approval above a configurable threshold
 * (per division) and never auto-save — every change is logged and the campaign
 * must be re-saved explicitly.
 */

import { z } from 'zod';
import { prisma } from '../../platform/db.js';
import { currentAuth, getContext, requireAuth } from '../../platform/context.js';
import { ApiError, ForbiddenError } from '../../platform/errors.js';
import { assertCan, can } from '../../platform/permissions.js';
import { handler } from '../../lib/http.js';
import { publishEvent, type EventEnvelope } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';

// ============================================================================
// Types & Schemas
// ============================================================================

/**
 * Campaign visibility and edition. Owned by the creator; visible to Finance,
 * HR, Operations heads, and Chairman per division scope.
 */
export interface CampaignView {
  id: string;
  recordCode: string;
  tenantId: string;
  name: string;
  division: 'software' | 'skill' | 'education' | 'shared';
  objective: 'awareness' | 'lead_gen' | 'enrolment' | 'partnership' | 'placement' | 'retention' | 'event';
  startAt: Date;
  endAt: Date;
  status: 'draft' | 'pending_approval' | 'scheduled' | 'live' | 'paused' | 'completed' | 'archived' | 'cancelled';
  budgetPlanned: number;
  budgetCommitted: number;
  budgetActual: number; // computed from spend lines
  currency: 'INR';
  channelMix: string[]; // ['email', 'sms', ...]
  ownerPartyId: string; // person or organization
  approvedById?: string;
  approvedAt?: Date;
  approvalRequired: boolean;
  utmCampaign: string; // slug
  targetLeads?: number;
  targetEnrolments?: number;
  targetPipelineValue?: number;
  offeringId?: string;
  courseId?: string;
  audienceId?: string;
  contentBrief?: string;
  tags: string[];
  createdBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export const CampaignInputSchema = z.object({
  name: z.string().min(1).max(255),
  division: z.enum(['software', 'skill', 'education', 'shared']),
  objective: z.enum(['awareness', 'lead_gen', 'enrolment', 'partnership', 'placement', 'retention', 'event']),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  budgetPlanned: z.number().positive(),
  currency: z.literal('INR'),
  channelMix: z.array(z.string()).min(1),
  utmCampaign: z.string().regex(/^[a-z0-9\-]+$/, 'must be lowercase slug'),
  approvalRequired: z.boolean().default(true),
  targetLeads: z.number().optional(),
  targetEnrolments: z.number().optional(),
  targetPipelineValue: z.number().optional(),
  offeringId: z.string().cuid().optional(),
  courseId: z.string().cuid().optional(),
  audienceId: z.string().cuid().optional(),
  contentBrief: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type CampaignInput = z.infer<typeof CampaignInputSchema>;

// ============================================================================
// Campaign CRUD
// ============================================================================

/**
 * Create a new campaign in draft state (MKT-CMP-001, MKT-CMP-002).
 *
 * The creator becomes the owner unless explicitly assigned. The campaign
 * starts in draft and can stay there until scheduled. budgetActual is
 * computed; do not supply it.
 */
export async function createCampaign(ctx = getContext(), data: CampaignInput): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'create' });

  const { startAt, endAt } = CampaignInputSchema.parse(data);
  if (endAt <= startAt) {
    throw new ApiError('INVALID_CAMPAIGN_DATES', 'endAt must be after startAt');
  }

  const auth = currentAuth();
  const recordCode = await nextRecordCode('CMP');

  // TODO: Create campaign row once Prisma schema is available
  // const campaign = await prisma.marketingCampaign.create({...});

  // TODO: Publish kz.mkt.campaign.created event
  // await publishEvent('kz.mkt.campaign.created', { campaignId: campaign.id, ... });

  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List campaigns visible to the current user, filtered by division, status,
 * and owner (MKT-CMP-001).
 */
export async function listCampaigns(
  ctx = getContext(),
  opts?: { division?: string; status?: string; ownerId?: string },
): Promise<CampaignView[]> {
  await assertCan({ resource: 'campaigns', verb: 'view' });

  // TODO: Query and filter campaigns
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a single campaign by ID, checking permissions (MKT-CMP-001).
 */
export async function loadCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });

  // TODO: Load and return campaign
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update campaign fields (name, budget, content brief) while in draft state
 * (MKT-CMP-001, MKT-CMP-6).
 *
 * Raises EX-MKT-010 if the campaign is live past its endAt time.
 */
export async function updateCampaign(ctx = getContext(), id: string, data: Partial<CampaignInput>): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Validate campaign is in draft, update fields, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

// ============================================================================
// Approval Workflow (MKT-CMP-007, MKT-CMP-008, MKT-CMP-010)
// ============================================================================

/**
 * Request approval for a draft campaign (MKT-CMP-007).
 *
 * Moves campaign from draft to pending_approval if it meets the threshold
 * for the division. Finance Head evaluates against configured thresholds;
 * the creator cannot approve their own campaign (self-dealing bar).
 */
export async function requestApproval(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });

  // TODO: Check status = draft, threshold for division, publish approval-requested event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Approve a pending campaign (MKT-CMP-007).
 *
 * Only Finance Head or Chairman can approve. The approver must be different
 * from the creator (enforced by platform approvals.ts).
 */
export async function approveCampaign(ctx = getContext(), id: string, reason?: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });

  // TODO: Check can approve, validate self-dealing bar, create approval row, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Reject a pending campaign, returning to draft (MKT-CMP-007).
 */
export async function rejectCampaign(ctx = getContext(), id: string, reason: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'view' });

  // TODO: Check status = pending_approval, revert to draft, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

// ============================================================================
// State Machine (MKT-CMP-003, MKT-CMP-004, MKT-CMP-005, MKT-CMP-006)
// ============================================================================

/**
 * Schedule a campaign for launch at a future time (draft → scheduled).
 *
 * Requires approval if over threshold. Optionally sets scheduledAt (else
 * uses now). The scheduler job (jobs/scheduler.ts) will flip scheduled
 * campaigns to live at their scheduled time without human intervention.
 */
export async function scheduleCampaign(ctx = getContext(), id: string, scheduledAt?: Date): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Validate approval if needed, set state and scheduledAt, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Launch a campaign immediately (scheduled → live).
 *
 * If already scheduled for a past time and the server restarts, this runs
 * exactly once (idempotent via event log). The campaign begins sending
 * (channels/adapters start accepting messages).
 */
export async function launchCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Transition scheduled → live, set liveAt, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Pause a running campaign (live → paused).
 *
 * Paused campaigns can resume. All pending sends are held; no new sends
 * are queued until resumed.
 */
export async function pauseCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Transition live → paused, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Resume a paused campaign (paused → live).
 */
export async function resumeCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Transition paused → live, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Mark a campaign as complete (live → completed or manual completion).
 *
 * Completed campaigns can only move to archived; no further sends,
 * approvals, or budget changes are allowed.
 */
export async function completeCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Transition to completed, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Archive a campaign (completed → archived or draft → archived directly).
 *
 * Archived campaigns retain all history (sends, spend, approvals) and remain
 * queryable in analytics; nothing is deleted.
 */
export async function archiveCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'edit' });

  // TODO: Transition to archived, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Clone a campaign (deep copy of structure, shallow of references).
 *
 * Copies channels, creative references, and UTM template but not spend-to-date,
 * sends, or approval. The clone always starts in draft and needs its own
 * approval if over threshold (MKT-CMP-014).
 */
export async function cloneCampaign(ctx = getContext(), id: string): Promise<CampaignView> {
  await assertCan({ resource: 'campaigns', verb: 'create' });

  // TODO: Load source, clone to new campaign, publish event
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
