/**
 * Settings (MKT-GOV-001…). Canon: docs/plan/marketing-skeleton.md.
 *
 * Channel registry (with live adapter status merged in), the tenant-wide
 * marketing policy (stored on `Tenant.config.marketing`, never its own
 * table), the claims register (ASCI/brand-compliance, self-dealing barred),
 * recent inbound webhooks, and the AI-MKT touchpoint catalogue.
 */

import { AI_TOUCHPOINTS, CHANNEL_KEY_LABELS, CHANNEL_KEYS, EVENTS, type ChannelKey, type ChannelKind } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { adapterStatus } from './adapters/registry.js';

registerGovernedEntities('mkt', ['channel', 'claim']);

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** `owned | paid | earned | direct`, per the skeleton — distinct from the adapter registry's `email|sms|whatsapp|social|ads` kind. */
const DEFAULT_CHANNEL_KIND: Record<ChannelKey, string> = {
  email: 'owned',
  sms: 'owned',
  whatsapp: 'owned',
  social_meta: 'paid',
  social_linkedin: 'paid',
  social_youtube: 'earned',
  google_ads: 'paid',
  website: 'owned',
  event: 'owned',
  referral: 'earned',
  partner: 'earned',
  print: 'paid',
  walk_in: 'direct',
  phone: 'owned',
  other: 'direct',
};

/** Idempotently seeds the 15 channel keys with labels/kinds — called by the bootstrap agent on boot. Calling this twice never duplicates or resets an already-configured channel's `active`/`config`. */
export async function ensureDefaultChannels(tenantId: string): Promise<number> {
  let created = 0;
  for (const key of CHANNEL_KEYS) {
    const existing = await prisma.marketingChannel.findFirst({ where: { tenantId, key } });
    if (existing) continue;
    const recordCode = await nextRecordCode('CHN');
    await prisma.marketingChannel.create({
      data: {
        tenantId,
        recordCode,
        key,
        label: CHANNEL_KEY_LABELS[key],
        kind: DEFAULT_CHANNEL_KIND[key],
        active: true,
      },
    });
    created += 1;
  }
  return created;
}

export async function listChannels() {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'view' });
  const channels = await prisma.marketingChannel.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { key: 'asc' } });
  const statuses = new Map(adapterStatus().map((s) => [s.channelKey, s]));

  return channels.map((c) => {
    const status = statuses.get(c.key as ChannelKey);
    return {
      ...c,
      configured: status?.configured ?? Boolean(c.providerAdapter),
      adapterProvider: status?.provider ?? null,
    };
  });
}

export async function createChannel(input: { key: string; label: string; kind: string; providerAdapter?: string | null; config?: Record<string, unknown>; senderIds?: string[] }) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'create' });

  const existing = await prisma.marketingChannel.findFirst({ where: { tenantId: auth.tenantId, key: input.key } });
  if (existing) throw ApiError.conflict(`Channel '${input.key}' already exists.`);

  const recordCode = await nextRecordCode('CHN');
  const channel = await prisma.marketingChannel.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      key: input.key,
      label: input.label,
      kind: input.kind,
      providerAdapter: input.providerAdapter ?? null,
      config: (input.config ?? {}) as never,
      senderIds: input.senderIds ?? [],
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'channel', subjectId: channel.id, after: { key: channel.key } });
  return channel;
}

export async function updateChannel(id: string, patch: { label?: string; active?: boolean; senderIds?: string[]; dltEntityId?: string | null; config?: Record<string, unknown>; providerAdapter?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  const channel = await prisma.marketingChannel.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!channel) throw ApiError.notFound('Channel');

  const updated = await prisma.marketingChannel.update({
    where: { id },
    data: {
      label: patch.label ?? undefined,
      active: patch.active ?? undefined,
      senderIds: patch.senderIds ?? undefined,
      dltEntityId: patch.dltEntityId === undefined ? undefined : patch.dltEntityId,
      config: patch.config === undefined ? undefined : (patch.config as never),
      providerAdapter: patch.providerAdapter === undefined ? undefined : patch.providerAdapter,
      updatedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'update', subjectType: 'channel', subjectId: id, before: { active: channel.active }, after: { active: updated.active } });
  return updated;
}

export function listAdapterStatus() {
  return adapterStatus();
}

// ---------------------------------------------------------------------------
// Policy — stored on Tenant.config.marketing, never its own table.
// ---------------------------------------------------------------------------

export interface MarketingPolicy {
  campaignApprovalThreshold: number;
  sendApprovalThreshold: number;
  bounceAlertRate: number;
  unsubscribeAlertRate: number;
  staleCampaignDays: number;
  formConvertSlaHours: number;
}

export const DEFAULT_MARKETING_POLICY: MarketingPolicy = {
  campaignApprovalThreshold: 50_000,
  sendApprovalThreshold: 500,
  bounceAlertRate: 0.05,
  unsubscribeAlertRate: 0.02,
  staleCampaignDays: 7,
  formConvertSlaHours: 24,
};

/** For other marketing domains to read the tenant's policy without re-deriving the storage shape. */
export async function marketingPolicy(tenantId?: string): Promise<MarketingPolicy> {
  const tid = tenantId ?? currentAuth().tenantId;
  const tenant = await prisma.tenant.findFirst({ where: { id: tid } });
  const config = (tenant?.config as { marketing?: Partial<MarketingPolicy> } | null) ?? {};
  return { ...DEFAULT_MARKETING_POLICY, ...(config.marketing ?? {}) };
}

export async function getPolicy() {
  await assertCan({ resource: 'marketing_settings', verb: 'view' });
  return marketingPolicy();
}

export async function patchPolicy(patch: Partial<MarketingPolicy>) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const config = (tenant.config as Record<string, unknown>) ?? {};
  const current = { ...DEFAULT_MARKETING_POLICY, ...((config.marketing as Partial<MarketingPolicy>) ?? {}) };
  const next = { ...current, ...patch };

  await prisma.tenant.update({ where: { id: auth.tenantId }, data: { config: { ...config, marketing: next } as never } });
  await auditWrite({ action: 'update', subjectType: 'tenant', subjectId: auth.tenantId, before: { marketingPolicy: current }, after: { marketingPolicy: next }, force: true });
  return next;
}

// ---------------------------------------------------------------------------
// Claims register (ASCI/brand compliance)
// ---------------------------------------------------------------------------

export async function createClaim(input: { text: string; evidenceRef?: string | null; assetIds?: string[] }) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'create' });
  if (!input.text.trim()) throw ApiError.badRequest('A claim needs text.');

  const recordCode = await nextRecordCode('CPG');
  const claim = await prisma.marketingClaim.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      text: input.text,
      evidenceRef: input.evidenceRef ?? null,
      assetIds: input.assetIds ?? [],
      status: 'proposed',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'claim', subjectId: claim.id, after: { text: claim.text } });
  await emit({ name: EVENTS.MKT_CLAIM_PROPOSED, subject: { entityType: 'claim', entityId: claim.id, recordCode }, impact: { domains: ['mkt'] } });
  return claim;
}

export async function listClaims(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'view' });
  return prisma.marketingClaim.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

async function getClaimOr404(id: string) {
  const auth = currentAuth();
  const claim = await prisma.marketingClaim.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!claim) throw ApiError.notFound('Claim');
  return claim;
}

/** Self-dealing bar: the proposer never approves their own claim, even the chairman. */
export async function approveClaim(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'approve' });
  const claim = await getClaimOr404(id);
  if (claim.status !== 'proposed') throw ApiError.unprocessable(`A claim at '${claim.status}' cannot be approved.`);
  if (claim.createdById && claim.createdById === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: a proposer may never approve their own claim.');
  }

  const updated = await prisma.marketingClaim.update({ where: { id }, data: { status: 'approved', approvedById: auth.partyId } });
  await auditWrite({ action: 'update', subjectType: 'claim', subjectId: id, before: { status: 'proposed' }, after: { status: 'approved' } });
  await emit({ name: EVENTS.MKT_CLAIM_APPROVED, subject: { entityType: 'claim', entityId: id, recordCode: claim.recordCode }, impact: { domains: ['mkt'] } });
  return updated;
}

export async function rejectClaim(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'approve' });
  const claim = await getClaimOr404(id);
  if (claim.status !== 'proposed') throw ApiError.unprocessable(`A claim at '${claim.status}' cannot be rejected.`);

  const updated = await prisma.marketingClaim.update({ where: { id }, data: { status: 'rejected' } });
  await auditWrite({ action: 'update', subjectType: 'claim', subjectId: id, before: { status: 'proposed' }, after: { status: 'rejected', reason } });
  await emit({
    name: EVENTS.MKT_CLAIM_REJECTED,
    subject: { entityType: 'claim', entityId: id, recordCode: claim.recordCode },
    reason: { reasonCode: 'rejected', note: reason },
    impact: { domains: ['mkt'] },
  });
  void auth;
  return updated;
}

export async function retireClaim(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const claim = await getClaimOr404(id);
  if (claim.status !== 'approved') throw ApiError.unprocessable(`Only an approved claim can be retired (currently '${claim.status}').`);

  const updated = await prisma.marketingClaim.update({ where: { id }, data: { status: 'retired' } });
  await auditWrite({ action: 'update', subjectType: 'claim', subjectId: id, before: { status: 'approved' }, after: { status: 'retired' } });
  void auth;
  return updated;
}

// ---------------------------------------------------------------------------
// Inbound webhooks — recent, read-only from settings
// ---------------------------------------------------------------------------

export async function recentWebhooks(limit = 50) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'view' });
  return prisma.marketingWebhookInbound.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

// ---------------------------------------------------------------------------
// AI touchpoints
// ---------------------------------------------------------------------------

export function aiTouchpoints() {
  return AI_TOUCHPOINTS.filter((t) => t.code.startsWith('AI-MKT-'));
}

export type { ChannelKind };
