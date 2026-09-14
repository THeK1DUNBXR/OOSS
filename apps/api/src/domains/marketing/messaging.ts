/**
 * Email, SMS, WhatsApp messaging (MKT-MSG-001 through MKT-MSG-030).
 *
 * Templates are reusable message blueprints with {{merge}} fields. Sends are
 * one-off batch sends to an audience. Both follow approval and consent gates.
 *
 * Versioning: editing an approved template never mutates it in place — it
 * creates a new row at version+1 in `draft`. The previously-approved row keeps
 * serving live sends (`approved`) until the new version clears review, at
 * which point the old one is retired. There is no `familyKey` column on
 * `MarketingTemplate`; the "same template" identity used to find the row to
 * retire is (tenantId, channelKey, name) — the natural key an operator means
 * when they say "the welcome email".
 *
 * DLT/WhatsApp gate: an SMS template needs `dltTemplateId` and a WhatsApp
 * template needs `waTemplateName` before it may be approved (EX-MKT-009 is
 * the send-time consequence of skipping this, not the approval-time block —
 * the block itself is a plain 422).
 */

import { z } from 'zod';
import {
  EVENTS,
  BOUNCE_RATE_ALARM_THRESHOLD,
  UNSUBSCRIBE_RATE_ALARM_THRESHOLD,
  TEMPLATE_TRANSITIONS,
  SEND_TRANSITIONS,
  type ChannelKey,
  type TemplateStatus,
  type SendStatus,
  type RecipientStatus,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { auditWrite } from '../../platform/audit.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { logInteraction } from '../interactions.js';
import { getAdapter } from './adapters/registry.js';
import { extractMergeFields } from './adapters/merge.js';
import type { InboundDeliveryEvent, OutboundMessage } from './adapters/types.js';
import { audiencePersonIds } from './audiences.js';
import { eligibleForChannel, unsubscribeToken, withdrawMarketingConsent } from './preferences.js';
import { marketingPolicy } from './settings.js';

// ============================================================================
// Types & schemas
// ============================================================================

export interface TemplateView {
  id: string;
  recordCode: string;
  channelKey: ChannelKey;
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
  status: TemplateStatus;
  dltTemplateId: string | null;
  waTemplateName: string | null;
  approvedById: string | null;
  version: number;
  language: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SendRecipientView {
  id: string;
  personId: string;
  status: RecipientStatus | string;
  reason: string | null;
  providerMessageId: string | null;
}

export interface SendView {
  id: string;
  recordCode: string;
  campaignId: string | null;
  templateId: string;
  channelKey: ChannelKey;
  audienceId: string | null;
  status: SendStatus;
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  requestedById: string | null;
  approvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const TemplateInputSchema = z.object({
  channelKey: z.enum(['email', 'sms', 'whatsapp']),
  name: z.string().min(1).max(255),
  subject: z.string().optional(),
  body: z.string().min(1),
  language: z.string().default('en'),
  dltTemplateId: z.string().optional(),
  waTemplateName: z.string().optional(),
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export const SendInputSchema = z.object({
  templateId: z.string(),
  channelKey: z.string(),
  audienceId: z.string().optional(),
  campaignId: z.string().optional(),
  scheduledAt: z.coerce.date().optional(),
  /** Internal use only (journeys): bypasses audience resolution with an explicit list. */
  personIds: z.array(z.string()).optional(),
});
export type SendInput = z.infer<typeof SendInputSchema>;

const DISPATCH_BATCH_SIZE = 100;

// ============================================================================
// Helpers
// ============================================================================

function toTemplateView(row: {
  id: string;
  recordCode: string;
  channelKey: string;
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
  status: string;
  dltTemplateId: string | null;
  waTemplateName: string | null;
  approvedById: string | null;
  version: number;
  language: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TemplateView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    channelKey: row.channelKey as ChannelKey,
    name: row.name,
    subject: row.subject,
    body: row.body,
    mergeFields: row.mergeFields,
    status: row.status as TemplateStatus,
    dltTemplateId: row.dltTemplateId,
    waTemplateName: row.waTemplateName,
    approvedById: row.approvedById,
    version: row.version,
    language: row.language,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSendView(row: {
  id: string;
  recordCode: string;
  campaignId: string | null;
  templateId: string;
  channelKey: string;
  audienceId: string | null;
  status: string;
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  requestedById: string | null;
  approvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SendView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    campaignId: row.campaignId,
    templateId: row.templateId,
    channelKey: row.channelKey as ChannelKey,
    audienceId: row.audienceId,
    status: row.status as SendStatus,
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    recipientCount: row.recipientCount,
    deliveredCount: row.deliveredCount,
    openedCount: row.openedCount,
    clickedCount: row.clickedCount,
    bouncedCount: row.bouncedCount,
    unsubscribedCount: row.unsubscribedCount,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireTemplate(id: string) {
  const auth = currentAuth();
  const template = await prisma.marketingTemplate.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!template) throw ApiError.notFound('Template');
  return template;
}

async function requireSend(id: string) {
  const auth = currentAuth();
  const send = await prisma.marketingSend.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!send) throw ApiError.notFound('Send');
  return send;
}

/** DLT/WhatsApp compliance gate — checked before a template may be approved. */
function assertDltReady(channelKey: string, dltTemplateId: string | null, waTemplateName: string | null): void {
  if (channelKey === 'sms' && !dltTemplateId) {
    throw ApiError.unprocessable(
      'An SMS template requires a registered dltTemplateId before it can be approved (India DLT compliance).',
    );
  }
  if (channelKey === 'whatsapp' && !waTemplateName) {
    throw ApiError.unprocessable(
      'A WhatsApp template requires an approved waTemplateName before it can be approved.',
    );
  }
}

// ============================================================================
// Templates
// ============================================================================

export async function createTemplate(data: TemplateInput): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'create' });

  const parsed = TemplateInputSchema.parse(data);
  const mergeFields = extractMergeFields(`${parsed.body} ${parsed.subject ?? ''}`);
  const recordCode = await nextRecordCode('TPL');

  const template = await prisma.marketingTemplate.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      channelKey: parsed.channelKey,
      name: parsed.name,
      subject: parsed.subject ?? null,
      body: parsed.body,
      mergeFields,
      status: 'draft',
      dltTemplateId: parsed.dltTemplateId ?? null,
      waTemplateName: parsed.waTemplateName ?? null,
      version: 1,
      language: parsed.language,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'marketing_template', subjectId: template.id, after: { recordCode, name: template.name } });
  await emit({
    name: EVENTS.MKT_TEMPLATE_CREATED,
    subject: { entityType: 'marketing_template', entityId: template.id, recordCode },
    newState: { channelKey: template.channelKey, status: template.status, version: template.version },
  });

  return toTemplateView(template);
}

export async function listTemplates(opts: { channelKey?: string; status?: string } = {}): Promise<TemplateView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'view' });

  const rows = await prisma.marketingTemplate.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(opts.channelKey ? { channelKey: opts.channelKey } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toTemplateView);
}

export async function loadTemplate(id: string): Promise<TemplateView> {
  await assertCan({ resource: 'marketing_templates', verb: 'view' });
  return toTemplateView(await requireTemplate(id));
}

/**
 * Editing a draft mutates in place. Editing an approved template creates a
 * new version+1 row in draft instead — the approved row keeps serving live
 * sends until the new version is itself approved (see `approveTemplate`).
 */
export async function updateTemplate(id: string, data: Partial<TemplateInput>): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'edit' });
  const template = await requireTemplate(id);

  if (template.status === 'pending_review') {
    throw ApiError.unprocessable('A template pending review cannot be edited. Reject it back to draft first.');
  }
  if (template.status === 'retired') {
    throw ApiError.unprocessable('A retired template cannot be edited.');
  }

  const nextBody = data.body ?? template.body;
  const nextSubject = data.subject ?? template.subject ?? undefined;
  const mergeFields = extractMergeFields(`${nextBody} ${nextSubject ?? ''}`);

  if (template.status === 'approved') {
    const recordCode = await nextRecordCode('TPL');
    const created = await prisma.marketingTemplate.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        channelKey: template.channelKey,
        name: data.name ?? template.name,
        subject: data.subject ?? template.subject,
        body: nextBody,
        mergeFields,
        status: 'draft',
        dltTemplateId: data.dltTemplateId ?? null,
        waTemplateName: data.waTemplateName ?? null,
        version: template.version + 1,
        language: data.language ?? template.language,
        createdById: auth.partyId,
      },
    });
    await auditWrite({ action: 'create', subjectType: 'marketing_template', subjectId: created.id, after: { recordCode, version: created.version, previousVersionId: template.id } });
    await emit({
      name: EVENTS.MKT_TEMPLATE_CREATED,
      subject: { entityType: 'marketing_template', entityId: created.id, recordCode },
      related: [{ relation: 'previous_version', entityType: 'marketing_template', entityId: template.id }],
      newState: { version: created.version, status: created.status },
    });
    return toTemplateView(created);
  }

  const updated = await prisma.marketingTemplate.update({
    where: { id },
    data: {
      name: data.name ?? template.name,
      subject: data.subject ?? template.subject,
      body: nextBody,
      mergeFields,
      dltTemplateId: data.dltTemplateId ?? template.dltTemplateId,
      waTemplateName: data.waTemplateName ?? template.waTemplateName,
      language: data.language ?? template.language,
      updatedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'update', subjectType: 'marketing_template', subjectId: id, before: { body: template.body }, after: { body: updated.body } });
  return toTemplateView(updated);
}

export async function submitForReview(id: string): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'edit' });
  const template = await requireTemplate(id);

  if (!TEMPLATE_TRANSITIONS[template.status as TemplateStatus]?.includes('pending_review')) {
    throw ApiError.unprocessable(`Cannot submit a template from status '${template.status}'.`);
  }

  const updated = await prisma.marketingTemplate.update({ where: { id }, data: { status: 'pending_review', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_TEMPLATE_SUBMITTED,
    subject: { entityType: 'marketing_template', entityId: id, recordCode: template.recordCode },
    previousState: { status: template.status },
    newState: { status: 'pending_review' },
  });
  return toTemplateView(updated);
}

/**
 * Approve a template (pending_review → approved). The creator can never
 * approve their own template (self-dealing bar) — see MKT-MSG tests.
 */
export async function approveTemplate(id: string, dltTemplateId?: string, waTemplateName?: string): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'approve' });
  const template = await requireTemplate(id);

  if (template.createdById && template.createdById === auth.partyId) {
    throw ApiError.forbidden("A template's creator can never approve it themselves, even the chairman.", [
      { axis: 'WHO', passed: false, reason: 'self_approval_barred' },
    ]);
  }
  if (!TEMPLATE_TRANSITIONS[template.status as TemplateStatus]?.includes('approved')) {
    throw ApiError.unprocessable(`Cannot approve a template from status '${template.status}'. It must be pending_review.`);
  }

  const finalDlt = dltTemplateId ?? template.dltTemplateId;
  const finalWa = waTemplateName ?? template.waTemplateName;
  assertDltReady(template.channelKey, finalDlt, finalWa);

  const updated = await prisma.marketingTemplate.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, dltTemplateId: finalDlt, waTemplateName: finalWa, updatedById: auth.partyId },
  });

  // Versioning: retire any other row sharing this template's natural key
  // (tenant, channel, name) that is still approved — the new version has
  // just taken over as the live one.
  const siblings = await prisma.marketingTemplate.findMany({
    where: {
      tenantId: auth.tenantId,
      channelKey: template.channelKey,
      name: template.name,
      status: 'approved',
      id: { not: id },
      deletedAt: null,
    },
  });
  for (const sibling of siblings) {
    await prisma.marketingTemplate.update({ where: { id: sibling.id }, data: { status: 'retired' } });
    await emit({
      name: EVENTS.MKT_TEMPLATE_RETIRED,
      subject: { entityType: 'marketing_template', entityId: sibling.id, recordCode: sibling.recordCode },
      previousState: { status: 'approved' },
      newState: { status: 'retired' },
      reason: { reasonCode: 'superseded_by_new_version' },
    });
  }

  await emit({
    name: EVENTS.MKT_TEMPLATE_APPROVED,
    subject: { entityType: 'marketing_template', entityId: id, recordCode: template.recordCode },
    previousState: { status: template.status },
    newState: { status: 'approved', dltTemplateId: finalDlt, waTemplateName: finalWa },
  });
  return toTemplateView(updated);
}

export async function rejectTemplate(id: string, reason: string): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'approve' });
  const template = await requireTemplate(id);
  if (template.status !== 'pending_review') {
    throw ApiError.unprocessable(`Cannot reject a template from status '${template.status}'. It must be pending_review.`);
  }
  const updated = await prisma.marketingTemplate.update({ where: { id }, data: { status: 'draft', updatedById: auth.partyId } });
  await auditWrite({ action: 'update', subjectType: 'marketing_template', subjectId: id, before: { status: 'pending_review' }, after: { status: 'draft', reason } });
  return toTemplateView(updated);
}

export async function retireTemplate(id: string): Promise<TemplateView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_templates', verb: 'edit' });
  const template = await requireTemplate(id);
  if (!TEMPLATE_TRANSITIONS[template.status as TemplateStatus]?.includes('retired')) {
    throw ApiError.unprocessable(`Cannot retire a template from status '${template.status}'.`);
  }
  const updated = await prisma.marketingTemplate.update({ where: { id }, data: { status: 'retired', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_TEMPLATE_RETIRED,
    subject: { entityType: 'marketing_template', entityId: id, recordCode: template.recordCode },
    previousState: { status: template.status },
    newState: { status: 'retired' },
  });
  return toTemplateView(updated);
}

/** MKT-MSG-002 merge-field catalogue for the template editor. */
export function mergeFieldsCatalogue(): Array<{ key: string; label: string; example: string }> {
  return [
    { key: 'person.fullName', label: 'Full name', example: 'Anita Rao' },
    { key: 'person.firstName', label: 'First name', example: 'Anita' },
    { key: 'person.primaryEmail', label: 'Email', example: 'anita@example.com' },
    { key: 'person.primaryPhone', label: 'Phone', example: '+91 98765 43210' },
    { key: 'tenant.companyName', label: 'Company name', example: 'Kaizen Learning' },
    { key: 'unsubscribeUrl', label: 'Unsubscribe link', example: 'https://app.kaizen.example/u/abc123' },
  ];
}

async function buildMergeData(personId: string | null | undefined): Promise<Record<string, unknown>> {
  const auth = currentAuth();
  const tenant = await prisma.tenant.findFirst({ where: { id: auth.tenantId }, select: { name: true } });
  const merge: Record<string, unknown> = {
    tenant: { companyName: tenant?.name ?? '' },
    unsubscribeUrl: '',
  };
  if (personId) {
    const person = await prisma.person.findFirst({ where: { id: personId, tenantId: auth.tenantId } });
    if (person) {
      merge.person = {
        fullName: person.fullName,
        firstName: person.fullName.split(' ')[0] ?? person.fullName,
        primaryEmail: person.primaryEmail,
        primaryPhone: person.primaryPhone,
      };
      merge.unsubscribeUrl = `/api/marketing/public/unsubscribe/${unsubscribeToken(personId)}`;
    }
  }
  return merge;
}

export async function previewTemplate(id: string, personId?: string): Promise<{ subject?: string; body: string; missing: string[] }> {
  await assertCan({ resource: 'marketing_templates', verb: 'view' });
  const template = await requireTemplate(id);
  const mergeData = await buildMergeData(personId ?? null);
  const adapter = getAdapter(template.channelKey as ChannelKey);
  const rendered = adapter.renderTemplate(template.body, template.subject ?? undefined, mergeData);
  return { subject: rendered.subject, body: rendered.body, missing: rendered.missing };
}

// ============================================================================
// Sends
// ============================================================================

/** Maps a channel key to the InteractionType logged for a send against it. */
function interactionTypeFor(channelKey: string): 'email' | 'sms' | 'whatsapp' {
  if (channelKey === 'sms') return 'sms';
  if (channelKey === 'whatsapp') return 'whatsapp';
  return 'email';
}

async function resolveRecipients(input: {
  audienceId?: string | null;
  personIds?: string[] | null;
  channelKey: string;
}): Promise<{ eligible: string[]; skipped: { personId: string; reason: string }[] }> {
  const candidateIds =
    input.personIds && input.personIds.length > 0
      ? input.personIds
      : input.audienceId
        ? await audiencePersonIds(input.audienceId)
        : [];
  return eligibleForChannel(candidateIds, input.channelKey as ChannelKey);
}

function recipientStatusForSkipReason(reason: string): string {
  return reason === 'dnc' ? 'skipped_dnc' : 'skipped_no_consent';
}

export async function createSend(data: SendInput): Promise<SendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'create' });
  const parsed = SendInputSchema.parse(data);

  const template = await requireTemplate(parsed.templateId);
  if (template.status !== 'approved') {
    await raiseException({
      code: 'EX-MKT-009',
      label: 'DLT/WhatsApp template used before registration/approval',
      severity: 'S3_HIGH_RISK',
      subjectType: 'marketing_template',
      subjectId: template.id,
      subjectLabel: `${template.recordCode} — ${template.name}`,
      detail: `A send was attempted against template '${template.name}' which is '${template.status}', not 'approved'.`,
      ownerPartyId: auth.partyId,
      triggerFingerprint: `mkt_send_unapproved_template:${template.id}`,
    });
    throw ApiError.unprocessable(
      `Template '${template.name}' is '${template.status}', not 'approved'. Only an approved template may be used in a send.`,
    );
  }

  const { eligible, skipped } = await resolveRecipients({
    audienceId: parsed.audienceId,
    personIds: parsed.personIds,
    channelKey: parsed.channelKey,
  });

  const recordCode = await nextRecordCode('SND');
  const send = await prisma.marketingSend.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      campaignId: parsed.campaignId ?? null,
      templateId: template.id,
      channelKey: parsed.channelKey,
      audienceId: parsed.audienceId ?? null,
      status: 'draft',
      scheduledAt: parsed.scheduledAt ?? null,
      recipientCount: eligible.length,
      createdById: auth.partyId,
    },
  });

  for (const personId of eligible) {
    const rc = await nextRecordCode('SND');
    await prisma.marketingSendRecipient.create({
      data: { tenantId: auth.tenantId, recordCode: rc, sendId: send.id, personId, status: 'queued' },
    });
  }
  for (const s of skipped) {
    const rc = await nextRecordCode('SND');
    await prisma.marketingSendRecipient.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: rc,
        sendId: send.id,
        personId: s.personId,
        status: recipientStatusForSkipReason(s.reason),
        reason: s.reason,
      },
    });
  }

  await auditWrite({ action: 'create', subjectType: 'marketing_send', subjectId: send.id, after: { recordCode, recipientCount: eligible.length } });
  return toSendView(send);
}

export async function listSends(opts: { campaignId?: string; status?: string } = {}): Promise<SendView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'view' });
  const rows = await prisma.marketingSend.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toSendView);
}

export async function loadSend(id: string): Promise<SendView & { recipientStatusBreakdown: Record<string, number> }> {
  await assertCan({ resource: 'marketing_sends', verb: 'view' });
  const send = await requireSend(id);
  const grouped = await prisma.marketingSendRecipient.groupBy({
    by: ['status'],
    where: { sendId: id, tenantId: send.tenantId },
    _count: { _all: true },
  });
  const recipientStatusBreakdown: Record<string, number> = {};
  for (const g of grouped) recipientStatusBreakdown[g.status] = g._count._all;
  return { ...toSendView(send), recipientStatusBreakdown };
}

export async function listSendRecipients(sendId: string, opts: { status?: string } = {}): Promise<SendRecipientView[]> {
  await assertCan({ resource: 'marketing_sends', verb: 'view' });
  const send = await requireSend(sendId);
  const rows = await prisma.marketingSendRecipient.findMany({
    where: { sendId: send.id, tenantId: send.tenantId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, personId: r.personId, status: r.status, reason: r.reason, providerMessageId: r.providerMessageId }));
}

export async function dryRunSend(id: string): Promise<{ eligible: number; skipped: { personId: string; reason: string }[] }> {
  await assertCan({ resource: 'marketing_sends', verb: 'view' });
  const send = await requireSend(id);
  const { eligible, skipped } = await resolveRecipients({
    audienceId: send.audienceId,
    personIds: null,
    channelKey: send.channelKey,
  });
  return { eligible: eligible.length, skipped };
}

/**
 * POST /sends/:id/request. Raises EX-MKT-011 (and leaves the send in draft)
 * when the channel adapter is not configured. When it is configured, a send
 * at or below the policy's approval threshold goes straight to `queued`;
 * above it, the send stays `draft` — with `requestedById` now set — awaiting
 * `approveSend`.
 */
export async function requestSend(id: string): Promise<SendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'edit' });
  const send = await requireSend(id);
  if (send.status !== 'draft') {
    throw ApiError.unprocessable(`Cannot request a send from status '${send.status}'.`);
  }

  const template = await requireTemplate(send.templateId);
  if (template.status !== 'approved') {
    await raiseException({
      code: 'EX-MKT-009',
      label: 'DLT/WhatsApp template used before registration/approval',
      severity: 'S3_HIGH_RISK',
      subjectType: 'marketing_send',
      subjectId: send.id,
      subjectLabel: send.recordCode,
      detail: `Send ${send.recordCode} requested against template '${template.name}' which is '${template.status}'.`,
      ownerPartyId: auth.partyId,
      triggerFingerprint: `mkt_send_unapproved_template:${send.id}`,
    });
    throw ApiError.unprocessable(`Template '${template.name}' is not approved. Cannot request this send.`);
  }

  const adapter = getAdapter(send.channelKey as ChannelKey);
  if (!adapter.isConfigured()) {
    await raiseException({
      code: 'EX-MKT-011',
      label: 'Channel adapter not configured but send requested',
      severity: 'S1_ATTENTION',
      subjectType: 'marketing_send',
      subjectId: send.id,
      subjectLabel: send.recordCode,
      detail: `No adapter is configured for channel '${send.channelKey}'. The send remains in draft.`,
      ownerPartyId: auth.partyId,
      triggerFingerprint: `mkt_send_adapter_not_configured:${send.id}`,
    });
    // No suitable column exists on MarketingSend to persist a structured
    // "blockedReason" (schema carries no notes/failureReason field on this
    // model) — the exception record above is the durable trail instead.
    throw ApiError.unprocessable(
      `No adapter is configured for channel '${send.channelKey}'. Configure it under Settings before requesting this send.`,
    );
  }

  const policy = await marketingPolicy();
  const requestedRow = await prisma.marketingSend.update({
    where: { id: send.id },
    data: { requestedById: auth.partyId },
  });

  if (send.recipientCount > policy.sendApprovalThreshold) {
    await emit({
      name: EVENTS.MKT_SEND_REQUESTED,
      subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
      newState: { status: 'draft', recipientCount: send.recipientCount, awaitingApproval: true },
    });
    return toSendView(requestedRow);
  }

  const queued = await prisma.marketingSend.update({ where: { id: send.id }, data: { status: 'queued' } });
  await emit({
    name: EVENTS.MKT_SEND_REQUESTED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    newState: { status: 'queued' },
  });
  await emit({
    name: EVENTS.MKT_SEND_QUEUED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    previousState: { status: 'draft' },
    newState: { status: 'queued' },
  });
  return toSendView(queued);
}

/** Required only when recipientCount exceeds the policy threshold. Self-dealing barred. */
export async function approveSend(id: string): Promise<SendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'approve' });
  const send = await requireSend(id);

  if (!send.requestedById) {
    throw ApiError.unprocessable('This send has not been requested yet.');
  }
  if (send.requestedById === auth.partyId) {
    throw ApiError.forbidden('The requester of a send can never also approve it.', [
      { axis: 'WHO', passed: false, reason: 'self_approval_barred' },
    ]);
  }
  const policy = await marketingPolicy();
  if (send.status !== 'draft' || send.recipientCount <= policy.sendApprovalThreshold) {
    throw ApiError.unprocessable('This send does not require approval.');
  }

  const updated = await prisma.marketingSend.update({
    where: { id: send.id },
    data: { status: 'queued', approvedById: auth.partyId },
  });
  await emit({
    name: EVENTS.MKT_SEND_APPROVED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    newState: { status: 'queued', approvedById: auth.partyId },
  });
  await emit({
    name: EVENTS.MKT_SEND_QUEUED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    previousState: { status: 'draft' },
    newState: { status: 'queued' },
  });
  return toSendView(updated);
}

export async function cancelSend(id: string): Promise<SendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'edit' });
  const send = await requireSend(id);
  if (!SEND_TRANSITIONS[send.status as SendStatus]?.includes('cancelled')) {
    throw ApiError.unprocessable(`Cannot cancel a send from status '${send.status}'.`);
  }
  const updated = await prisma.marketingSend.update({ where: { id: send.id }, data: { status: 'cancelled', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_SEND_CANCELLED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    previousState: { status: send.status },
    newState: { status: 'cancelled' },
  });
  return toSendView(updated);
}

/**
 * Runs the adapter over every `queued` recipient of a send, in batches of
 * 100. Also what the scheduled job calls. Logs one outbound Interaction per
 * recipient, updates counters, and runs `checkSendHealth` at the end.
 */
export async function dispatchSend(id: string): Promise<SendView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_sends', verb: 'edit' });
  const send = await requireSend(id);
  if (send.status !== 'queued' && send.status !== 'sending') {
    throw ApiError.unprocessable(`Cannot dispatch a send from status '${send.status}'. It must be queued.`);
  }

  const template = await requireTemplate(send.templateId);
  const adapter = getAdapter(send.channelKey as ChannelKey);
  if (!adapter.isConfigured()) {
    await raiseException({
      code: 'EX-MKT-011',
      label: 'Channel adapter not configured but send requested',
      severity: 'S1_ATTENTION',
      subjectType: 'marketing_send',
      subjectId: send.id,
      subjectLabel: send.recordCode,
      detail: `Dispatch attempted with no adapter configured for channel '${send.channelKey}'.`,
      ownerPartyId: auth.partyId,
      triggerFingerprint: `mkt_send_adapter_not_configured:${send.id}`,
    });
    throw ApiError.unprocessable(`No adapter is configured for channel '${send.channelKey}'.`);
  }

  if (send.status === 'queued') {
    await prisma.marketingSend.update({ where: { id: send.id }, data: { status: 'sending' } });
  }

  let anySent = false;
  let anyFailed = false;

  for (;;) {
    const batch = await prisma.marketingSendRecipient.findMany({
      where: { sendId: send.id, tenantId: send.tenantId, status: 'queued' },
      take: DISPATCH_BATCH_SIZE,
    });
    if (batch.length === 0) break;

    for (const recipient of batch) {
      const person = await prisma.person.findFirst({ where: { id: recipient.personId, tenantId: send.tenantId } });
      const address =
        send.channelKey === 'email' ? (person?.primaryEmail ?? null) : (person?.primaryPhone ?? null);

      if (!person || !address) {
        await prisma.marketingSendRecipient.update({
          where: { id: recipient.id },
          data: { status: 'failed', reason: 'no_contact_address_for_channel' },
        });
        anyFailed = true;
        continue;
      }

      const mergeData = await buildMergeData(person.id);
      const rendered = adapter.renderTemplate(template.body, template.subject ?? undefined, mergeData);
      const message: OutboundMessage = {
        to: { personId: person.id, address },
        subject: rendered.subject,
        body: rendered.body,
        templateRef: template.id,
        dltTemplateId: template.dltTemplateId ?? undefined,
        waTemplateName: template.waTemplateName ?? undefined,
      };
      const result = await adapter.send(message);

      if (result.status === 'sent') {
        anySent = true;
        await prisma.marketingSendRecipient.update({
          where: { id: recipient.id },
          data: { status: 'sent', providerMessageId: result.providerMessageId ?? null },
        });

        const openLead = await prisma.lead.findFirst({ where: { tenantId: send.tenantId, personId: person.id, leadStatus: 'open' } });
        await logInteraction({
          interactionType: interactionTypeFor(send.channelKey),
          direction: 'outbound',
          occurredAt: new Date(),
          subject: template.subject ?? template.name,
          notes: `Marketing send ${send.recordCode} (template ${template.recordCode}).`,
          relatedReferences: [
            { contextCode: 'mkt', entityType: 'person', entityId: person.id },
            ...(openLead ? [{ contextCode: 'mkt', entityType: 'lead', entityId: openLead.id }] : []),
          ],
        });
      } else {
        anyFailed = true;
        await prisma.marketingSendRecipient.update({
          where: { id: recipient.id },
          data: { status: 'failed', reason: result.error ?? 'send_failed' },
        });
      }
    }
  }

  const finalStatus: SendStatus = anySent ? 'sent' : anyFailed ? 'failed' : 'sent';
  const updated = await prisma.marketingSend.update({
    where: { id: send.id },
    data: { status: finalStatus, sentAt: new Date() },
  });

  await emit({
    name: finalStatus === 'sent' ? EVENTS.MKT_SEND_SENT : EVENTS.MKT_SEND_FAILED,
    subject: { entityType: 'marketing_send', entityId: send.id, recordCode: send.recordCode },
    newState: { status: finalStatus },
  });

  await checkSendHealth(send.id);
  return toSendView(updated);
}

/**
 * Maps a channel's inbound webhook delivery events onto recipient rows and
 * rolls the counts up onto the send. Exported for the webhook route another
 * agent writes.
 */
export async function applyDeliveryEvents(channelKey: string, events: InboundDeliveryEvent[]): Promise<{ applied: number }> {
  const auth = currentAuth();
  const affectedSendIds = new Set<string>();
  let applied = 0;

  for (const event of events) {
    const recipient = await prisma.marketingSendRecipient.findFirst({
      where: { tenantId: auth.tenantId, providerMessageId: event.providerMessageId },
    });
    if (!recipient) continue;

    const send = await prisma.marketingSend.findFirst({ where: { id: recipient.sendId, tenantId: auth.tenantId } });
    if (!send) continue;

    const statusMap: Record<InboundDeliveryEvent['kind'], string | null> = {
      delivered: 'delivered',
      opened: 'opened',
      clicked: 'clicked',
      bounced: 'bounced',
      unsubscribed: 'unsubscribed',
      failed: 'failed',
      replied: null,
    };
    const nextStatus = statusMap[event.kind];
    if (!nextStatus) continue;

    const existingEvents = Array.isArray(recipient.events) ? (recipient.events as unknown[]) : [];
    await prisma.marketingSendRecipient.update({
      where: { id: recipient.id },
      data: {
        status: nextStatus,
        events: [...existingEvents, { kind: event.kind, at: event.at.toISOString(), detail: event.detail ?? null }] as never,
      },
    });
    applied += 1;
    affectedSendIds.add(send.id);

    const counterField =
      event.kind === 'delivered'
        ? 'deliveredCount'
        : event.kind === 'opened'
          ? 'openedCount'
          : event.kind === 'clicked'
            ? 'clickedCount'
            : event.kind === 'bounced'
              ? 'bouncedCount'
              : event.kind === 'unsubscribed'
                ? 'unsubscribedCount'
                : null;
    if (counterField) {
      await prisma.marketingSend.update({ where: { id: send.id }, data: { [counterField]: { increment: 1 } } });
    }

    const recipientEventName: Record<string, string | undefined> = {
      delivered: EVENTS.MKT_SEND_RECIPIENT_DELIVERED,
      opened: EVENTS.MKT_SEND_RECIPIENT_OPENED,
      clicked: EVENTS.MKT_SEND_RECIPIENT_CLICKED,
      bounced: EVENTS.MKT_SEND_RECIPIENT_BOUNCED,
      unsubscribed: EVENTS.MKT_SEND_RECIPIENT_UNSUBSCRIBED,
    };
    const eventName = recipientEventName[event.kind];
    if (eventName) {
      await emit({
        name: eventName,
        subject: { entityType: 'marketing_send_recipient', entityId: recipient.id },
        related: [{ relation: 'send', entityType: 'marketing_send', entityId: send.id }, { relation: 'person', entityType: 'person', entityId: recipient.personId }],
        newState: { status: nextStatus },
      });
    }

    if (event.kind === 'clicked') {
      const rc = await nextRecordCode('LNK');
      await prisma.marketingTouchpoint.create({
        data: {
          tenantId: auth.tenantId,
          recordCode: rc,
          personId: recipient.personId,
          campaignId: send.campaignId,
          channelKey,
          touchKind: 'click',
          sourceRef: send.recordCode,
        },
      });
    }

    if (event.kind === 'unsubscribed') {
      await withdrawMarketingConsent(recipient.personId, 'unsubscribe_link');
    }
  }

  for (const sendId of affectedSendIds) {
    await checkSendHealth(sendId);
  }

  return { applied };
}

/** EX-MKT-005 (bounce) / EX-MKT-006 (unsubscribe spike), checked after every dispatch/delivery batch. */
export async function checkSendHealth(sendId: string): Promise<void> {
  const auth = currentAuth();
  const send = await prisma.marketingSend.findFirst({ where: { id: sendId, tenantId: auth.tenantId } });
  if (!send || send.recipientCount === 0) return;

  const policy = await marketingPolicy();
  const bounceThreshold = policy.bounceAlertRate ?? BOUNCE_RATE_ALARM_THRESHOLD;
  const unsubscribeThreshold = policy.unsubscribeAlertRate ?? UNSUBSCRIBE_RATE_ALARM_THRESHOLD;

  const bounceRate = send.bouncedCount / send.recipientCount;
  const unsubscribeRate = send.unsubscribedCount / send.recipientCount;

  if (bounceRate > bounceThreshold) {
    await raiseException({
      code: 'EX-MKT-005',
      label: 'Bounce rate above 5% on a send',
      severity: 'S2_WARNING',
      subjectType: 'marketing_send',
      subjectId: send.id,
      subjectLabel: send.recordCode,
      detail: `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds the ${(bounceThreshold * 100).toFixed(1)}% alarm threshold.`,
      ownerPartyId: send.requestedById,
      triggerFingerprint: `mkt_send_bounce:${send.id}`,
    });
  }
  if (unsubscribeRate > unsubscribeThreshold) {
    await raiseException({
      code: 'EX-MKT-006',
      label: 'Unsubscribe spike on a send (>2%)',
      severity: 'S2_WARNING',
      subjectType: 'marketing_send',
      subjectId: send.id,
      subjectLabel: send.recordCode,
      detail: `Unsubscribe rate ${(unsubscribeRate * 100).toFixed(1)}% exceeds the ${(unsubscribeThreshold * 100).toFixed(1)}% alarm threshold.`,
      ownerPartyId: send.requestedById,
      triggerFingerprint: `mkt_send_unsubscribe:${send.id}`,
    });
  }
}

/** Sends one test message to a specific address, bypassing recipients/consent entirely. Adapter status is honest. */
export async function sendTest(templateId: string, channelKey: string, to: string): Promise<{ status: string; providerMessageId?: string; error?: string }> {
  await assertCan({ resource: 'marketing_sends', verb: 'create' });
  const template = await requireTemplate(templateId);
  const adapter = getAdapter(channelKey as ChannelKey);
  const mergeData: Record<string, unknown> = {
    person: { fullName: 'Test Recipient', firstName: 'Test', primaryEmail: to, primaryPhone: to },
    tenant: { companyName: (await prisma.tenant.findFirst({ where: { id: currentAuth().tenantId } }))?.name ?? '' },
    unsubscribeUrl: '#',
  };
  const rendered = adapter.renderTemplate(template.body, template.subject ?? undefined, mergeData);
  const result = await adapter.send({
    to: { personId: 'test', address: to },
    subject: rendered.subject,
    body: rendered.body,
    templateRef: template.id,
    dltTemplateId: template.dltTemplateId ?? undefined,
    waTemplateName: template.waTemplateName ?? undefined,
  });
  return result;
}

export { buildMergeData };
