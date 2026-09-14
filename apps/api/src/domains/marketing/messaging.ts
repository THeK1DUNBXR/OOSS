/**
 * Email, SMS, WhatsApp messaging (MKT-MSG-001 through MKT-MSG-030).
 *
 * Templates are reusable message blueprints with {{merge}} fields. Sends are
 * one-off batch sends to an audience. Both follow approval and consent gates.
 *
 * Templates can be submitted for review (DLT/WhatsApp compliance). Sends
 * track delivery, opens, clicks, bounces via channel adapters.
 */

import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { assertCan, getContext } from '../../platform/context.js';

export interface TemplateView {
  id: string;
  recordCode: string;
  channelKey: string;
  name: string;
  subject?: string;
  body: string;
  mergeFields: string[];
  status: 'draft' | 'pending_review' | 'approved' | 'retired';
  version: number;
  language: string;
  dltTemplateId?: string;
  waTemplateName?: string;
  approvedById?: string;
  approvedAt?: Date;
  createdBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface SendView {
  id: string;
  recordCode: string;
  campaignId?: string;
  templateId: string;
  channelKey: string;
  audienceId?: string;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  scheduledAt?: Date;
  sentAt?: Date;
  recipientCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  requestedById: string;
  approvedById?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const TemplateInputSchema = z.object({
  channelKey: z.enum(['email', 'sms', 'whatsapp']),
  name: z.string().min(1).max(255),
  subject: z.string().optional(), // Required for email
  body: z.string().min(1),
  language: z.string().default('en'),
});

export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export const SendInputSchema = z.object({
  templateId: z.string().cuid(),
  channelKey: z.string(),
  audienceId: z.string().cuid().optional(),
  campaignId: z.string().cuid().optional(),
  scheduledAt: z.coerce.date().optional(),
});

export type SendInput = z.infer<typeof SendInputSchema>;

// ============================================================================
// Templates
// ============================================================================

/**
 * Create a new template in draft state (MKT-MSG-001).
 *
 * Merge fields are extracted from the body; do not supply them.
 * DLT and WhatsApp template IDs are optional (filled during approval).
 */
export async function createTemplate(ctx = getContext(), data: TemplateInput): Promise<TemplateView> {
  await assertCan({ resource: 'marketing_templates', verb: 'create' });

  // TODO: Extract merge fields, create template row
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List templates visible to user (MKT-MSG-001).
 */
export async function listTemplates(ctx = getContext(), opts?: { channelKey?: string; status?: string }): Promise<TemplateView[]> {
  // TODO: Query templates
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a template (MKT-MSG-001).
 */
export async function loadTemplate(ctx = getContext(), id: string): Promise<TemplateView> {
  // TODO: Load template
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Update a template in draft state (MKT-MSG-002).
 */
export async function updateTemplate(ctx = getContext(), id: string, data: Partial<TemplateInput>): Promise<TemplateView> {
  await assertCan({ resource: 'marketing_templates', verb: 'edit' });

  // TODO: Update template, re-extract merge fields
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Submit template for review (draft → pending_review) (MKT-MSG-003).
 *
 * For DLT/WhatsApp, this triggers registration and approval with the provider.
 */
export async function submitForReview(ctx = getContext(), id: string): Promise<TemplateView> {
  // TODO: Transition to pending_review
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Approve a template (pending_review → approved) (MKT-MSG-003).
 *
 * Only Operations Head or Chairman. For DLT/WhatsApp, assigns provider IDs.
 */
export async function approveTemplate(ctx = getContext(), id: string, dltTemplateId?: string, waTemplateName?: string): Promise<TemplateView> {
  // TODO: Transition to approved, store provider IDs
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Retire a template (any → retired) (MKT-MSG-004).
 *
 * Retired templates cannot be used in new sends; existing sends continue.
 */
export async function retireTemplate(ctx = getContext(), id: string): Promise<TemplateView> {
  // TODO: Transition to retired
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Duplicate a template (create new version) (MKT-MSG-005).
 *
 * Copies subject, body, merge fields; starts in draft.
 */
export async function duplicateTemplate(ctx = getContext(), id: string): Promise<TemplateView> {
  // TODO: Clone template to new version
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Preview a template with sample merge data (MKT-MSG-002).
 */
export async function previewTemplate(ctx = getContext(), id: string, mergeData: Record<string, unknown>): Promise<{ subject?: string; body: string; missing: string[] }> {
  // TODO: Load template, render with merge data
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

// ============================================================================
// Sends
// ============================================================================

/**
 * Create a send in draft state (MKT-MSG-008).
 *
 * Does not validate consent or audience at creation; validation happens at
 * queue/approval time.
 */
export async function createSend(ctx = getContext(), data: SendInput): Promise<SendView> {
  await assertCan({ resource: 'marketing_sends', verb: 'create' });

  // TODO: Create send row, set status = draft
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List sends (MKT-MSG-008).
 */
export async function listSends(ctx = getContext(), opts?: { campaignId?: string; status?: string }): Promise<SendView[]> {
  // TODO: Query sends
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Load a send (MKT-MSG-008).
 */
export async function loadSend(ctx = getContext(), id: string): Promise<SendView> {
  // TODO: Load send
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Approve a send (MKT-MSG-010).
 *
 * Validates consent. Raises EX-MKT-003 if any recipient lacks consent.
 * Only applies if send is over a threshold (per segment + channel combo).
 */
export async function approveSend(ctx = getContext(), id: string): Promise<SendView> {
  // TODO: Validate consent, transition to approved state
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Queue a send (draft → queued) (MKT-MSG-009).
 *
 * Requires approval if over threshold. Enqueues actual delivery async;
 * adapters begin sending (or queue sends in their provider).
 */
export async function queueSend(ctx = getContext(), id: string): Promise<SendView> {
  // TODO: Transition to queued, enqueue delivery job
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * Cancel a send (any → cancelled) (MKT-MSG-011).
 *
 * Prevents queued/sending sends from continuing.
 */
export async function cancelSend(ctx = getContext(), id: string): Promise<SendView> {
  // TODO: Transition to cancelled
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}

/**
 * List recipients of a send with delivery status (MKT-MSG-012).
 */
export async function listSendRecipients(ctx = getContext(), sendId: string, opts?: { status?: string; page?: number }): Promise<Array<{ personId: string; status: string; deliveredAt?: Date }>> {
  // TODO: Query send recipients
  throw new ApiError('NOT_IMPLEMENTED', 'Awaiting Prisma schema completion');
}
