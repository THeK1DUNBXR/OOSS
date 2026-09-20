/**
 * Marketing capture — forms, submissions, touchpoints, attribution, score
 * rules and short links. Mounted (with `requireAuth` already applied
 * upstream) under `/api/marketing` by `routes/marketing/index.ts`.
 */

import { Router } from 'express';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  createForm,
  listForms,
  loadForm,
  updateForm,
  publishForm,
  unpublishForm,
  rotateToken,
  formEmbedInfo,
  listFormSubmissions,
  convertSubmission,
  rejectSubmission,
  markSpamSubmission,
  createShortLink,
  listShortLinks,
  type FormInput,
} from '../../domains/marketing/capture.js';
import {
  recordTouchpoint,
  listTouchpoints,
  computeAttribution,
  attributionForLead,
  createScoreRule,
  listScoreRules,
  updateScoreRule,
  deleteScoreRule,
  previewScore,
  applyScores,
} from '../../domains/marketing/attribution.js';

const router = Router();

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

router.get('/forms', handler(async (req) => listForms({ q: str(req.query.q), active: req.query.active === undefined ? undefined : req.query.active === 'true' })));

router.get('/forms/:id', handler(async (req) => loadForm(req.params.id)));

router.post(
  '/forms',
  handler(async (req) => {
    const body = req.body as FormInput;
    if (!body?.name) throw ApiError.badRequest('name is required.');
    if (!body?.vertical) throw ApiError.badRequest('vertical is required.');
    return createForm(body);
  }),
);

router.patch('/forms/:id', handler(async (req) => updateForm(req.params.id, req.body as Partial<FormInput>)));
router.post('/forms/:id/publish', handler(async (req) => publishForm(req.params.id)));
router.post('/forms/:id/unpublish', handler(async (req) => unpublishForm(req.params.id)));
router.post('/forms/:id/rotate-token', handler(async (req) => rotateToken(req.params.id)));
router.get('/forms/:id/embed', handler(async (req) => formEmbedInfo(req.params.id)));

router.get(
  '/forms/:id/submissions',
  handler(async (req) => listFormSubmissions(req.params.id, { status: str(req.query.status) })),
);

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

router.post('/submissions/:id/convert', handler(async (req) => convertSubmission(req.params.id)));
router.post(
  '/submissions/:id/reject',
  handler(async (req) => rejectSubmission(req.params.id, str(req.body?.reason) ?? 'Not specified')),
);
router.post('/submissions/:id/mark-spam', handler(async (req) => markSpamSubmission(req.params.id)));

// ---------------------------------------------------------------------------
// Touchpoints
// ---------------------------------------------------------------------------

router.get(
  '/touchpoints',
  handler(async (req) =>
    listTouchpoints({
      personId: str(req.query.personId),
      leadId: str(req.query.leadId),
      campaignId: str(req.query.campaignId),
      from: date(req.query.from),
      to: date(req.query.to),
    }),
  ),
);

router.post(
  '/touchpoints',
  handler(async (req) => {
    const body = req.body as {
      personId?: string;
      leadId?: string;
      organizationId?: string;
      campaignId?: string;
      channelKey: string;
      touchKind: string;
      occurredAt?: string;
      utm?: Record<string, unknown>;
      sourceRef?: string;
      cost?: number;
    };
    if (!body?.channelKey || !body?.touchKind) throw ApiError.badRequest('channelKey and touchKind are required.');
    return recordTouchpoint({
      ...body,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });
  }),
);

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

router.post(
  '/attribution/recompute',
  handler(async (req) => {
    const from = date(req.query.from) ?? new Date(0);
    const to = date(req.query.to) ?? new Date();
    const computed = await computeAttribution(from, to);
    return { computed };
  }),
);

router.get('/attribution/lead/:leadId', handler(async (req) => attributionForLead(req.params.leadId)));

// ---------------------------------------------------------------------------
// Score rules
// ---------------------------------------------------------------------------

router.get('/score-rules', handler(async () => ({ items: await listScoreRules() })));
router.post(
  '/score-rules',
  handler(async (req) => {
    const body = req.body as { name: string; condition: { field: string; op: string; value: unknown }; points: number; active?: boolean; order?: number };
    if (!body?.name || !body?.condition) throw ApiError.badRequest('name and condition are required.');
    return createScoreRule(body as never);
  }),
);
router.patch('/score-rules/:id', handler(async (req) => updateScoreRule(req.params.id, req.body as never)));
router.delete('/score-rules/:id', handler(async (req) => deleteScoreRule(req.params.id)));
router.post(
  '/score-rules/preview',
  handler(async (req) => {
    const leadId = str(req.body?.leadId);
    if (!leadId) throw ApiError.badRequest('leadId is required.');
    return previewScore(leadId);
  }),
);
router.post('/score-rules/apply', handler(async () => ({ updated: await applyScores() })));

// ---------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------

router.get('/links', handler(async () => listShortLinks()));
router.post(
  '/links',
  handler(async (req) => {
    const body = req.body as { slug?: string; targetUrl: string; campaignId?: string; channelKey?: string; utm?: Record<string, unknown> };
    if (!body?.targetUrl) throw ApiError.badRequest('targetUrl is required.');
    return createShortLink(body as never);
  }),
);

export default router;
