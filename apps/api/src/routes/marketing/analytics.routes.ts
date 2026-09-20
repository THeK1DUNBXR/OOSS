import { Router } from 'express';
import { ATTRIBUTION_MODELS, type AttributionModel } from '@kaizen/shared';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import { overview, funnel, channels, campaigns, attributionSummary, cohorts, exportCsv, type ExportKind } from '../../domains/marketing/analytics.js';

const router = Router();

router.get('/overview', handler(async () => overview()));

router.get(
  '/analytics/funnel',
  handler(async (req) =>
    funnel({
      from: date(req.query.from),
      to: date(req.query.to),
      division: str(req.query.division),
      campaignId: str(req.query.campaignId),
    }),
  ),
);

router.get(
  '/analytics/channels',
  handler(async (req) => channels({ from: date(req.query.from), to: date(req.query.to) })),
);

router.get(
  '/analytics/campaigns',
  handler(async (req) => campaigns({ from: date(req.query.from), to: date(req.query.to) })),
);

router.get(
  '/analytics/attribution',
  handler(async (req) => {
    const model = (str(req.query.model) ?? 'last_touch') as AttributionModel;
    if (!ATTRIBUTION_MODELS.includes(model)) throw ApiError.badRequest(`Unknown attribution model '${model}'.`);
    return attributionSummary(model, { from: date(req.query.from), to: date(req.query.to) });
  }),
);

router.get('/analytics/cohorts', handler(async (req) => cohorts({ by: (str(req.query.by) as 'month' | undefined) ?? 'month' })));

router.get(
  '/analytics/export',
  handler(async (req, res) => {
    const kind = (str(req.query.kind) ?? 'campaigns') as ExportKind;
    if (!['campaigns', 'channels', 'leads'].includes(kind)) throw ApiError.badRequest(`Unknown export kind '${kind}'.`);
    const csv = await exportCsv(kind, { from: date(req.query.from), to: date(req.query.to) });
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  }),
);

export default router;
