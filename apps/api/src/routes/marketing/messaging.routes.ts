/**
 * Templates and sends — `/api/marketing/templates`, `/api/marketing/sends`.
 * See docs/plan/marketing-api-contract.md for the exact shapes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  createTemplate,
  listTemplates,
  loadTemplate,
  updateTemplate,
  submitForReview,
  approveTemplate,
  rejectTemplate,
  retireTemplate,
  previewTemplate,
  mergeFieldsCatalogue,
  createSend,
  listSends,
  loadSend,
  requestSend,
  approveSend,
  cancelSend,
  dispatchSend,
  dryRunSend,
  sendTest,
  listSendRecipients,
} from '../../domains/marketing/messaging.js';

const router = Router();

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

router.get(
  '/templates',
  handler(async (req) => {
    const items = await listTemplates({ channelKey: str(req.query.channelKey), status: str(req.query.status) });
    return { items, total: items.length };
  }),
);

router.get('/templates/merge-fields', handler(async () => mergeFieldsCatalogue()));

router.get('/templates/:id', handler(async (req) => loadTemplate(req.params.id)));

router.post('/templates', handler(async (req) => createTemplate(req.body)));

router.patch('/templates/:id', handler(async (req) => updateTemplate(req.params.id, req.body)));

router.post('/templates/:id/submit', handler(async (req) => submitForReview(req.params.id)));

router.post(
  '/templates/:id/approve',
  handler(async (req) => approveTemplate(req.params.id, req.body?.dltTemplateId, req.body?.waTemplateName)),
);

router.post(
  '/templates/:id/reject',
  handler(async (req) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    return rejectTemplate(req.params.id, reason);
  }),
);

router.post('/templates/:id/retire', handler(async (req) => retireTemplate(req.params.id)));

router.post(
  '/templates/:id/preview',
  handler(async (req) => previewTemplate(req.params.id, req.body?.personId)),
);

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

router.get(
  '/sends',
  handler(async (req) => {
    const items = await listSends({ campaignId: str(req.query.campaignId), status: str(req.query.status) });
    return { items, total: items.length };
  }),
);

router.post(
  '/sends/test',
  handler(async (req) => {
    const { templateId, channelKey, to } = z
      .object({ templateId: z.string(), channelKey: z.string(), to: z.string() })
      .parse(req.body);
    return sendTest(templateId, channelKey, to);
  }),
);

router.get('/sends/:id', handler(async (req) => loadSend(req.params.id)));

router.post('/sends', handler(async (req) => createSend(req.body)));

router.post('/sends/:id/request', handler(async (req) => requestSend(req.params.id)));

router.post('/sends/:id/approve', handler(async (req) => approveSend(req.params.id)));

router.post('/sends/:id/cancel', handler(async (req) => cancelSend(req.params.id)));

router.post('/sends/:id/dispatch', handler(async (req) => dispatchSend(req.params.id)));

router.get('/sends/:id/dry-run', handler(async (req) => dryRunSend(req.params.id)));

router.get(
  '/sends/:id/recipients',
  handler(async (req) => {
    const items = await listSendRecipients(req.params.id, { status: str(req.query.status) });
    return { items, total: items.length };
  }),
);

export default router;
export { router };
