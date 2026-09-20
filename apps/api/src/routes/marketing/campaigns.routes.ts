import { Router } from 'express';
import { z } from 'zod';
import { CAMPAIGN_OBJECTIVES, CHANNEL_KEYS } from '@kaizen/shared';
import { handler, parsePaging, str, date } from '../../lib/http.js';
import {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  submitCampaign,
  approveCampaign,
  rejectCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  archiveCampaign,
  cancelCampaign,
  campaignTimeline,
  campaignUtm,
} from '../../domains/marketing/campaigns.js';

const router = Router();

const CampaignInputSchema = z.object({
  name: z.string().min(1).max(255),
  objective: z.enum(CAMPAIGN_OBJECTIVES),
  division: z.string().min(1),
  vertical: z.string().nullish(),
  channelMix: z.array(z.enum(CHANNEL_KEYS)).min(1),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  budgetPlanned: z.number().nonnegative(),
  currency: z.string().optional(),
  offeringId: z.string().nullish(),
  courseId: z.string().nullish(),
  audienceId: z.string().nullish(),
  contentBrief: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  targetLeads: z.number().nullish(),
  targetEnrolments: z.number().nullish(),
  targetPipelineValue: z.number().nullish(),
  utmCampaign: z.string().regex(/^[a-z0-9-]+$/).nullish(),
});

router.get(
  '/',
  handler(async (req) => {
    const { page, pageSize } = parsePaging(req);
    return listCampaigns({
      q: str(req.query.q),
      status: str(req.query.status),
      division: str(req.query.division),
      from: date(req.query.from),
      to: date(req.query.to),
      page,
      pageSize,
    });
  }),
);

router.get('/:id', handler(async (req) => getCampaign(req.params.id)));

router.post(
  '/',
  handler(async (req, res) => {
    const input = CampaignInputSchema.parse(req.body);
    const campaign = await createCampaign(input as never);
    res.status(201).json(campaign);
    return undefined;
  }),
);

router.patch(
  '/:id',
  handler(async (req) => {
    const input = CampaignInputSchema.omit({ utmCampaign: true }).partial().parse(req.body);
    return updateCampaign(req.params.id, input as never);
  }),
);

router.delete('/:id', handler(async (req) => deleteCampaign(req.params.id)));

router.post('/:id/submit', handler(async (req) => submitCampaign(req.params.id)));

router.post(
  '/:id/approve',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().optional() });
    const input = schema.parse(req.body ?? {});
    return approveCampaign(req.params.id, input.reason);
  }),
);

router.post(
  '/:id/reject',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return rejectCampaign(req.params.id, input.reason);
  }),
);

router.post('/:id/launch', handler(async (req) => launchCampaign(req.params.id)));
router.post('/:id/pause', handler(async (req) => pauseCampaign(req.params.id)));
router.post('/:id/resume', handler(async (req) => resumeCampaign(req.params.id)));
router.post('/:id/complete', handler(async (req) => completeCampaign(req.params.id)));
router.post('/:id/archive', handler(async (req) => archiveCampaign(req.params.id)));

router.post(
  '/:id/cancel',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return cancelCampaign(req.params.id, input.reason);
  }),
);

router.get('/:id/timeline', handler(async (req) => campaignTimeline(req.params.id)));
router.get('/:id/utm', handler(async (req) => campaignUtm(req.params.id)));

export default router;
