/**
 * Assets, content library and social posts. Mounted at `/api/marketing`
 * (this router owns both `/assets` and `/social-posts`).
 */

import { Router } from 'express';
import { z } from 'zod';
import { ASSET_KINDS, CHANNEL_KEYS } from '@kaizen/shared';
import { handler, parsePaging, str, date } from '../../lib/http.js';
import {
  createAsset,
  listAssets,
  loadAsset,
  updateAsset,
  submitForApproval,
  approveAsset,
  rejectAsset,
  retireAsset,
  createSocialPost,
  listSocialPosts,
  loadSocialPost,
  updateSocialPost,
  scheduleSocialPost,
  publishSocialPost,
  cancelSocialPost,
  recordSocialMetrics,
} from '../../domains/marketing/assets.js';

const router = Router();

const AssetInputSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(ASSET_KINDS),
  url: z.string().nullish(),
  campaignId: z.string().nullish(),
  usageRights: z.string().nullish(),
  expiresAt: z.coerce.date().nullish(),
  tags: z.array(z.string()).optional(),
});

router.get(
  '/assets',
  handler(async (req) => {
    const { page, pageSize } = parsePaging(req);
    return listAssets({
      status: str(req.query.status),
      kind: str(req.query.kind),
      campaignId: str(req.query.campaignId),
      q: str(req.query.q),
      page,
      pageSize,
    });
  }),
);

router.get('/assets/:id', handler(async (req) => loadAsset(req.params.id)));

router.post(
  '/assets',
  handler(async (req, res) => {
    const input = AssetInputSchema.parse(req.body);
    const asset = await createAsset(input);
    res.status(201).json(asset);
    return undefined;
  }),
);

router.patch(
  '/assets/:id',
  handler(async (req) => {
    const input = AssetInputSchema.partial().parse(req.body);
    return updateAsset(req.params.id, input);
  }),
);

router.post('/assets/:id/submit', handler(async (req) => submitForApproval(req.params.id)));
router.post('/assets/:id/approve', handler(async (req) => approveAsset(req.params.id)));

router.post(
  '/assets/:id/reject',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return rejectAsset(req.params.id, input.reason);
  }),
);

router.post('/assets/:id/retire', handler(async (req) => retireAsset(req.params.id)));

// ---------------------------------------------------------------------------
// Social posts
// ---------------------------------------------------------------------------

const SocialPostInputSchema = z.object({
  channelKey: z.enum(CHANNEL_KEYS),
  campaignId: z.string().nullish(),
  body: z.string().min(1),
  assetIds: z.array(z.string()).optional(),
  scheduledAt: z.coerce.date(),
});

router.get(
  '/social-posts',
  handler(async (req) =>
    listSocialPosts({
      channelKey: str(req.query.channelKey),
      status: str(req.query.status),
      from: date(req.query.from),
      to: date(req.query.to),
    }),
  ),
);

router.get('/social-posts/:id', handler(async (req) => loadSocialPost(req.params.id)));

router.post(
  '/social-posts',
  handler(async (req, res) => {
    const input = SocialPostInputSchema.parse(req.body);
    const post = await createSocialPost(input);
    res.status(201).json(post);
    return undefined;
  }),
);

router.patch(
  '/social-posts/:id',
  handler(async (req) => {
    const input = SocialPostInputSchema.partial().parse(req.body);
    return updateSocialPost(req.params.id, input);
  }),
);

router.post('/social-posts/:id/schedule', handler(async (req) => scheduleSocialPost(req.params.id)));

router.post(
  '/social-posts/:id/publish',
  handler(async (req) => {
    const schema = z.object({ externalUrl: z.string().nullish() });
    const input = schema.parse(req.body ?? {});
    return publishSocialPost(req.params.id, input);
  }),
);

router.post('/social-posts/:id/cancel', handler(async (req) => cancelSocialPost(req.params.id)));

router.post(
  '/social-posts/:id/metrics',
  handler(async (req) => {
    const schema = z.object({
      likes: z.number().optional(),
      comments: z.number().optional(),
      shares: z.number().optional(),
      reach: z.number().optional(),
      clicks: z.number().optional(),
    });
    const input = schema.parse(req.body ?? {});
    return recordSocialMetrics(req.params.id, input);
  }),
);

export default router;
