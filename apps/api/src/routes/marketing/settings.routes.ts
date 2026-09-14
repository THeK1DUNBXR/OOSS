import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listChannels,
  createChannel,
  updateChannel,
  listAdapterStatus,
  getPolicy,
  patchPolicy,
  createClaim,
  listClaims,
  approveClaim,
  rejectClaim,
  retireClaim,
  recentWebhooks,
  aiTouchpoints,
} from '../../domains/marketing/settings.js';

const router = Router();

router.get('/channels', handler(async () => listChannels()));

router.post(
  '/channels',
  handler(async (req) => {
    const schema = z.object({
      key: z.string(),
      label: z.string(),
      kind: z.string(),
      providerAdapter: z.string().nullish(),
      config: z.record(z.unknown()).optional(),
      senderIds: z.array(z.string()).optional(),
    });
    return createChannel(schema.parse(req.body));
  }),
);

router.patch(
  '/channels/:id',
  handler(async (req) => {
    const schema = z.object({
      label: z.string().optional(),
      active: z.boolean().optional(),
      senderIds: z.array(z.string()).optional(),
      dltEntityId: z.string().nullish(),
      config: z.record(z.unknown()).optional(),
      providerAdapter: z.string().nullish(),
    });
    return updateChannel(req.params.id, schema.parse(req.body));
  }),
);

router.get('/adapters', handler(async () => listAdapterStatus()));

router.get('/policy', handler(async () => getPolicy()));

router.patch(
  '/policy',
  handler(async (req) => {
    const schema = z.object({
      campaignApprovalThreshold: z.number().optional(),
      sendApprovalThreshold: z.number().optional(),
      bounceAlertRate: z.number().optional(),
      unsubscribeAlertRate: z.number().optional(),
      staleCampaignDays: z.number().optional(),
      formConvertSlaHours: z.number().optional(),
    });
    return patchPolicy(schema.parse(req.body));
  }),
);

router.get('/webhooks', handler(async () => recentWebhooks()));

router.get('/ai-touchpoints', handler(async () => aiTouchpoints()));

router.get(
  '/claims',
  handler(async (req) => {
    const items = await listClaims({ status: str(req.query.status) });
    return { items, total: items.length };
  }),
);

router.post(
  '/claims',
  handler(async (req) => {
    const schema = z.object({ text: z.string(), evidenceRef: z.string().nullish(), assetIds: z.array(z.string()).optional() });
    return createClaim(schema.parse(req.body));
  }),
);

router.post('/claims/:id/approve', handler(async (req) => approveClaim(req.params.id)));

router.post(
  '/claims/:id/reject',
  handler(async (req) => {
    const schema = z.object({ reason: z.string() });
    const input = schema.parse(req.body);
    return rejectClaim(req.params.id, input.reason);
  }),
);

router.post('/claims/:id/retire', handler(async (req) => retireClaim(req.params.id)));

export default router;
