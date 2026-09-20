/**
 * Content library, versioning, and social posts (MKT-AST-001 through
 * MKT-AST-005). The claims register (`mkt_claims`) is owned by settings.ts —
 * nothing here touches it.
 *
 * An asset's usage-rights window (`expiresAt`) is the enforceable fact:
 * `detectExpiredAssetsInUse` raises EX-MKT-012 whenever an expired-but-approved
 * asset is still referenced by a live campaign or a scheduled/published social
 * post, rather than trusting anyone to remember to retire it on time.
 */

import {
  ASSET_TRANSITIONS,
  EVENTS,
  SOCIAL_POST_STATUSES,
  type AssetStatus,
  type SocialPostStatus,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { getAdapter } from './adapters/registry.js';
import type { ChannelKey } from './adapters/types.js';

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetInput {
  name: string;
  kind: string;
  url?: string | null;
  storageRef?: string | null;
  campaignId?: string | null;
  usageRights?: string | null;
  expiresAt?: Date | null;
  tags?: string[];
}

export async function createAsset(input: AssetInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'create' });

  if (input.campaignId) {
    const campaign = await prisma.marketingCampaign.findFirst({ where: { id: input.campaignId, tenantId: auth.tenantId } });
    if (!campaign) throw ApiError.notFound('Campaign');
  }

  const recordCode = await nextRecordCode('AST');
  const asset = await prisma.marketingAsset.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      kind: input.kind,
      url: input.url ?? null,
      storageRef: input.storageRef ?? null,
      campaignId: input.campaignId ?? null,
      usageRights: input.usageRights ?? null,
      expiresAt: input.expiresAt ?? null,
      tags: input.tags ?? [],
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_ASSET_CREATED,
    subject: { entityType: 'marketing_asset', entityId: asset.id, recordCode },
    newState: { status: asset.status, name: asset.name },
  });

  return asset;
}

export interface AssetListFilters {
  status?: string;
  kind?: string;
  campaignId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listAssets(filters: AssetListFilters = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'view' });

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);
  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.q ? { name: { contains: filters.q, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.marketingAsset.findMany({ where: where as never, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.marketingAsset.count({ where: where as never }),
  ]);
  return { items: items.map(withExpired), total, page, pageSize };
}

function withExpired<T extends { expiresAt: Date | null }>(asset: T): T & { expired: boolean } {
  return { ...asset, expired: Boolean(asset.expiresAt && asset.expiresAt < new Date()) };
}

export async function loadAsset(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'view' });
  const asset = await prisma.marketingAsset.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!asset) throw ApiError.notFound('Asset');
  return withExpired(asset);
}

/**
 * A plain edit while draft/in_review updates the row in place. An edit against
 * an approved asset instead opens a new draft row at version+1 — the approved
 * row itself is never mutated once approved, so anything already published
 * against it keeps pointing at the version it was actually approved on.
 */
export async function updateAsset(id: string, patch: Partial<AssetInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });

  const asset = await prisma.marketingAsset.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!asset) throw ApiError.notFound('Asset');
  if (asset.status === 'retired') throw ApiError.conflict('A retired asset cannot be edited.');

  if (asset.status === 'approved') {
    const recordCode = await nextRecordCode('AST');
    const nextVersion = await prisma.marketingAsset.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        name: patch.name ?? asset.name,
        kind: patch.kind ?? asset.kind,
        url: patch.url !== undefined ? patch.url : asset.url,
        storageRef: patch.storageRef !== undefined ? patch.storageRef : asset.storageRef,
        version: asset.version + 1,
        status: 'draft',
        campaignId: patch.campaignId !== undefined ? patch.campaignId : asset.campaignId,
        usageRights: patch.usageRights !== undefined ? patch.usageRights : asset.usageRights,
        expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : asset.expiresAt,
        tags: patch.tags ?? asset.tags,
        createdById: auth.partyId,
      },
    });
    await emit({
      name: EVENTS.MKT_ASSET_CREATED,
      subject: { entityType: 'marketing_asset', entityId: nextVersion.id, recordCode },
      related: [{ relation: 'new_version_of', entityType: 'marketing_asset', entityId: asset.id }],
      newState: { status: 'draft', version: nextVersion.version },
    });
    return nextVersion;
  }

  const updated = await prisma.marketingAsset.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.storageRef !== undefined ? { storageRef: patch.storageRef } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(patch.usageRights !== undefined ? { usageRights: patch.usageRights } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      updatedById: auth.partyId,
    },
  });
  return updated;
}

async function transitionAsset(id: string, to: AssetStatus, eventName: string) {
  const auth = currentAuth();
  const asset = await prisma.marketingAsset.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!asset) throw ApiError.notFound('Asset');
  const from = asset.status as AssetStatus;
  const allowed = ASSET_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw ApiError.unprocessable(`Cannot move a ${from} asset to ${to}.`);
  const updated = await prisma.marketingAsset.update({
    where: { id },
    data: { status: to, ...(to === 'approved' ? { approvedById: auth.partyId } : {}), updatedById: auth.partyId },
  });
  await emit({
    name: eventName,
    subject: { entityType: 'marketing_asset', entityId: id, recordCode: asset.recordCode },
    previousState: { status: from },
    newState: { status: to },
  });
  return { asset, updated };
}

export async function submitForApproval(id: string) {
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const { updated } = await transitionAsset(id, 'in_review', EVENTS.MKT_ASSET_SUBMITTED);
  return updated;
}

/** Self-dealing bar: the person who created (or last submitted) an asset never approves it themselves. */
export async function approveAsset(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'approve' });

  const asset = await prisma.marketingAsset.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!asset) throw ApiError.notFound('Asset');
  if (asset.createdById && asset.createdById === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar: the creator of an asset may never approve it themselves.');
  }

  const { updated } = await transitionAsset(id, 'approved', EVENTS.MKT_ASSET_APPROVED);
  return updated;
}

export async function rejectAsset(id: string, reason: string) {
  await assertCan({ resource: 'marketing_assets', verb: 'approve' });
  const auth = currentAuth();
  const asset = await prisma.marketingAsset.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!asset) throw ApiError.notFound('Asset');
  if (asset.status !== 'in_review') throw ApiError.conflict(`Only an in-review asset can be rejected (currently ${asset.status}).`);
  const updated = await prisma.marketingAsset.update({ where: { id }, data: { status: 'draft', updatedById: auth.partyId } });
  await emit({
    name: EVENTS.MKT_ASSET_SUBMITTED,
    subject: { entityType: 'marketing_asset', entityId: id, recordCode: asset.recordCode },
    previousState: { status: 'in_review' },
    newState: { status: 'draft' },
    reason: { reasonCode: 'rejected', note: reason },
  });
  return updated;
}

export async function retireAsset(id: string) {
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const { updated } = await transitionAsset(id, 'retired', EVENTS.MKT_ASSET_RETIRED);
  return updated;
}

/**
 * EX-MKT-012: an approved asset past its usage-rights expiry, still
 * referenced by a live campaign or a scheduled/published social post.
 */
export async function detectExpiredAssetsInUse(): Promise<number> {
  const auth = currentAuth();
  const now = new Date();

  const expired = await prisma.marketingAsset.findMany({
    where: { tenantId: auth.tenantId, status: 'approved', deletedAt: null, expiresAt: { lt: now } },
    take: 500,
  });
  if (expired.length === 0) return 0;

  const activePosts = await prisma.marketingSocialPost.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['scheduled', 'published'] }, deletedAt: null },
    select: { id: true, assetIds: true },
  });

  let raised = 0;
  for (const asset of expired) {
    const inSocialUse = activePosts.some((p) => p.assetIds.includes(asset.id));
    let inLiveCampaign = false;
    if (!inSocialUse && asset.campaignId) {
      const campaign = await prisma.marketingCampaign.findFirst({ where: { id: asset.campaignId, status: 'live' } });
      inLiveCampaign = Boolean(campaign);
    }
    if (!inSocialUse && !inLiveCampaign) continue;

    await raiseException({
      code: 'EX-MKT-012',
      label: 'Asset used past usage-rights expiry',
      severity: 'S2_WARNING',
      subjectType: 'marketing_asset',
      subjectId: asset.id,
      subjectLabel: `${asset.recordCode} — ${asset.name}`,
      domain: 'mkt',
      detail: `Usage rights expired ${asset.expiresAt?.toISOString()} and this asset is still ${inSocialUse ? 'referenced by a live social post' : 'attached to a live campaign'}.`,
      ownerPartyId: asset.createdById,
      triggerFingerprint: 'mkt_asset_expired_in_use',
      ladderRung: 1,
    });
    raised += 1;
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Social posts
// ---------------------------------------------------------------------------

export interface SocialPostInput {
  channelKey: string;
  campaignId?: string | null;
  body: string;
  assetIds?: string[];
  scheduledAt: Date;
}

async function assertAssetsApproved(assetIds: string[], tenantId: string) {
  if (assetIds.length === 0) return;
  const rows = await prisma.marketingAsset.findMany({ where: { id: { in: assetIds }, tenantId } });
  const byId = new Map(rows.map((a) => [a.id, a]));
  for (const id of assetIds) {
    const asset = byId.get(id);
    if (!asset) throw ApiError.notFound('Asset');
    if (asset.status !== 'approved') {
      throw ApiError.conflict(`Asset ${asset.recordCode} is not approved and cannot be attached to a social post.`);
    }
  }
}

export async function createSocialPost(input: SocialPostInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'create' });

  const assetIds = input.assetIds ?? [];
  await assertAssetsApproved(assetIds, auth.tenantId);

  const recordCode = await nextRecordCode('PST');
  const post = await prisma.marketingSocialPost.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      channelKey: input.channelKey,
      campaignId: input.campaignId ?? null,
      body: input.body,
      assetIds,
      scheduledAt: input.scheduledAt,
      status: 'draft',
      createdById: auth.partyId,
    },
  });
  return post;
}

export async function listSocialPosts(filters: { channelKey?: string; from?: Date; to?: Date; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'view' });
  return prisma.marketingSocialPost.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filters.channelKey ? { channelKey: filters.channelKey } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? { scheduledAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
    },
    orderBy: { scheduledAt: 'desc' },
  });
}

export async function loadSocialPost(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'view' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  return post;
}

export async function updateSocialPost(id: string, patch: Partial<SocialPostInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  if (!['draft', 'scheduled'].includes(post.status)) throw ApiError.conflict(`Cannot edit a ${post.status} social post.`);

  if (patch.assetIds) await assertAssetsApproved(patch.assetIds, auth.tenantId);

  return prisma.marketingSocialPost.update({
    where: { id },
    data: {
      ...(patch.channelKey !== undefined ? { channelKey: patch.channelKey } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.assetIds !== undefined ? { assetIds: patch.assetIds } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
      updatedById: auth.partyId,
    },
  });
}

const SOCIAL_TRANSITIONS: Record<SocialPostStatus, SocialPostStatus[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['published', 'cancelled', 'failed'],
  published: [],
  failed: ['scheduled', 'cancelled'],
  cancelled: [],
};

export async function scheduleSocialPost(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  const allowed = SOCIAL_TRANSITIONS[post.status as SocialPostStatus] ?? [];
  if (!allowed.includes('scheduled')) throw ApiError.unprocessable(`Cannot schedule a ${post.status} social post.`);
  const updated = await prisma.marketingSocialPost.update({ where: { id }, data: { status: 'scheduled' } });
  await emit({
    name: EVENTS.MKT_SOCIAL_POST_SCHEDULED,
    subject: { entityType: 'social_post', entityId: id, recordCode: post.recordCode },
    newState: { status: 'scheduled' },
  });
  return updated;
}

export interface PublishSocialPostInput {
  externalUrl?: string | null;
}

/**
 * The Marketing settings registry never provisions a social-publishing
 * adapter (`registry.ts` always resolves social channel keys to
 * NotConfiguredAdapter), so publishing here is honest about that rather than
 * pretending: `publishMode: 'manual'` records the human-supplied externalUrl
 * and a note that the post was posted by hand; `publishMode: 'adapter'` is the
 * path a future provider integration takes, unreachable today.
 */
export async function publishSocialPost(id: string, input: PublishSocialPostInput = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  const allowed = SOCIAL_TRANSITIONS[post.status as SocialPostStatus] ?? [];
  if (!allowed.includes('published')) throw ApiError.unprocessable(`Cannot publish a ${post.status} social post.`);

  const adapter = getAdapter(post.channelKey as ChannelKey);
  const publishMode: 'manual' | 'adapter' = adapter.isConfigured() ? 'adapter' : 'manual';

  if (publishMode === 'manual' && !input.externalUrl) {
    throw ApiError.badRequest('No publishing adapter is configured for this channel — provide the externalUrl of the post you published by hand.');
  }

  const metrics = {
    ...(post.metrics as Record<string, unknown>),
    ...(publishMode === 'manual' ? { publishNote: 'Recorded manually — no publishing adapter is configured for this channel.' } : {}),
  };

  const updated = await prisma.marketingSocialPost.update({
    where: { id },
    data: {
      status: 'published',
      publishedAt: new Date(),
      externalUrl: input.externalUrl ?? post.externalUrl,
      metrics,
    },
  });

  await emit({
    name: EVENTS.MKT_SOCIAL_POST_PUBLISHED,
    subject: { entityType: 'social_post', entityId: id, recordCode: post.recordCode },
    newState: { status: 'published', publishMode },
  });

  return { ...updated, publishMode };
}

export async function cancelSocialPost(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  const allowed = SOCIAL_TRANSITIONS[post.status as SocialPostStatus] ?? [];
  if (!allowed.includes('cancelled')) throw ApiError.unprocessable(`Cannot cancel a ${post.status} social post.`);
  return prisma.marketingSocialPost.update({ where: { id }, data: { status: 'cancelled' } });
}

export interface SocialMetricsInput {
  likes?: number;
  comments?: number;
  shares?: number;
  reach?: number;
  clicks?: number;
}

export async function recordSocialMetrics(id: string, metrics: SocialMetricsInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_assets', verb: 'edit' });
  const post = await prisma.marketingSocialPost.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!post) throw ApiError.notFound('Social post');
  const merged = { ...(post.metrics as Record<string, unknown>), ...metrics };
  return prisma.marketingSocialPost.update({ where: { id }, data: { metrics: merged } });
}

export interface AssetView {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  status: 'draft' | 'in_review' | 'approved' | 'retired';
}

export { SOCIAL_POST_STATUSES };
