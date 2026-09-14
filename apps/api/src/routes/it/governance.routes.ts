import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  // risks
  createRisk,
  updateRisk,
  listRisks,
  riskDetail,
  transitionRisk,
  risksSummary,
  // policies
  createPolicyDraft,
  updatePolicyDraft,
  listPolicies,
  policyDetail,
  publishPolicy,
  newVersionOf,
  retirePolicy,
  acknowledgePolicy,
  policiesAwaitingCaller,
  acknowledgementsFor,
  policiesSummary,
  // controls
  createControl,
  updateControl,
  listControls,
  controlDetail,
  recordTest,
  controlsSummary,
  // access reviews
  openCampaign,
  listCampaigns,
  campaignDetail,
  decideItem,
  closeCampaign,
  accessReviewsSummary,
  // findings
  createFinding,
  updateFinding,
  listFindings,
  findingDetail,
  transitionFinding,
  findingsSummary,
} from '../../domains/it/governance.js';

/** Technology — governance (docs/plan/cio.md). Mounted at /api/it/. */
const router = Router();

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

router.get(
  '/risks',
  handler(async (req) => listRisks({ status: str(req.query.status), band: str(req.query.band), category: str(req.query.category) })),
);

router.post(
  '/risks',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        category: z.string().min(1),
        ownerPartyId: z.string().min(1),
        likelihoodInherent: z.number().int().min(1).max(5),
        impactInherent: z.number().int().min(1).max(5),
        treatment: z.string(),
        treatmentPlan: z.string().nullish(),
        reviewDueAt: z.coerce.date().nullish(),
        controlIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return createRisk(body);
  }),
);

router.get('/risks/summary', handler(async () => risksSummary()));

router.get('/risks/:id', handler(async (req) => riskDetail(req.params.id)));

router.patch(
  '/risks/:id',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().optional(),
        category: z.string().optional(),
        ownerPartyId: z.string().optional(),
        treatment: z.string().optional(),
        treatmentPlan: z.string().nullish(),
        reviewDueAt: z.coerce.date().nullish(),
        controlIds: z.array(z.string()).optional(),
        likelihoodResidual: z.number().int().min(1).max(5).optional(),
        impactResidual: z.number().int().min(1).max(5).optional(),
      })
      .parse(req.body);
    return updateRisk(req.params.id, body);
  }),
);

router.post(
  '/risks/:id/transition',
  handler(async (req) => {
    const body = z.object({ event: z.string(), note: z.string().nullish() }).parse(req.body);
    return transitionRisk(req.params.id, body.event as never, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

router.get('/policies', handler(async (req) => listPolicies({ status: str(req.query.status), code: str(req.query.code) })));

router.post(
  '/policies',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        title: z.string().min(1),
        body: z.string().min(1),
        appliesToRoleSlugs: z.array(z.string()).optional(),
        reacknowledgeMonths: z.number().int().positive().nullish(),
      })
      .parse(req.body);
    return createPolicyDraft(body);
  }),
);

router.get('/policies/summary', handler(async () => policiesSummary()));

router.get('/policies/awaiting', handler(async () => policiesAwaitingCaller()));

router.get('/policies/:id', handler(async (req) => policyDetail(req.params.id)));

router.patch(
  '/policies/:id',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        appliesToRoleSlugs: z.array(z.string()).optional(),
        reacknowledgeMonths: z.number().int().positive().nullish(),
      })
      .parse(req.body);
    return updatePolicyDraft(req.params.id, body);
  }),
);

router.post('/policies/:id/publish', handler(async (req) => publishPolicy(req.params.id)));

router.post('/policies/:id/new-version', handler(async (req) => newVersionOf(req.params.id)));

router.post('/policies/:id/retire', handler(async (req) => retirePolicy(req.params.id)));

router.post('/policies/:id/acknowledge', handler(async (req) => acknowledgePolicy(req.params.id)));

router.get('/policies/:id/acknowledgements', handler(async (req) => acknowledgementsFor(req.params.id)));

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

router.get('/controls', handler(async (req) => listControls({ status: str(req.query.status), framework: str(req.query.framework) })));

router.post(
  '/controls',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        title: z.string().min(1),
        frameworkRefs: z.array(z.object({ framework: z.string(), ref: z.string() })).default([]),
        ownerPartyId: z.string().min(1),
        frequencyDays: z.number().int().positive(),
      })
      .parse(req.body);
    return createControl(body);
  }),
);

router.get('/controls/summary', handler(async () => controlsSummary()));

router.get('/controls/:id', handler(async (req) => controlDetail(req.params.id)));

router.patch(
  '/controls/:id',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().optional(),
        frameworkRefs: z.array(z.object({ framework: z.string(), ref: z.string() })).optional(),
        ownerPartyId: z.string().optional(),
        frequencyDays: z.number().int().positive().optional(),
        status: z.string().optional(),
      })
      .parse(req.body);
    return updateControl(req.params.id, body);
  }),
);

router.post(
  '/controls/:id/test',
  handler(async (req) => {
    const body = z.object({ result: z.string(), notes: z.string().nullish(), evidenceDocumentId: z.string().nullish() }).parse(req.body);
    return recordTest(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Access reviews
// ---------------------------------------------------------------------------

router.get('/access-reviews', handler(async (req) => listCampaigns({ status: str(req.query.status) })));

router.post(
  '/access-reviews',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        scope: z.string(),
        scopeRef: z.string().nullish(),
        dueAt: z.coerce.date(),
      })
      .parse(req.body);
    return openCampaign(body);
  }),
);

router.get('/access-reviews/summary', handler(async () => accessReviewsSummary()));

router.get('/access-reviews/:id', handler(async (req) => campaignDetail(req.params.id)));

router.post(
  '/access-reviews/:id/items/:itemId/decide',
  handler(async (req) => {
    const body = z.object({ decision: z.string(), note: z.string().nullish() }).parse(req.body);
    return decideItem(req.params.id, req.params.itemId, body);
  }),
);

router.post('/access-reviews/:id/close', handler(async (req) => closeCampaign(req.params.id)));

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

router.get('/findings', handler(async (req) => listFindings({ status: str(req.query.status), severity: str(req.query.severity) })));

router.post(
  '/findings',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        source: z.string(),
        severity: z.string(),
        cvss: z.number().nullish(),
        description: z.string().nullish(),
        applicationId: z.string().nullish(),
        assetId: z.string().nullish(),
      })
      .parse(req.body);
    return createFinding(body);
  }),
);

router.get('/findings/summary', handler(async () => findingsSummary()));

router.get('/findings/:id', handler(async (req) => findingDetail(req.params.id)));

router.patch(
  '/findings/:id',
  handler(async (req) => {
    const body = z.object({ description: z.string().nullish(), changeId: z.string().nullish(), cvss: z.number().nullish() }).parse(req.body);
    return updateFinding(req.params.id, body);
  }),
);

router.post(
  '/findings/:id/transition',
  handler(async (req) => {
    const body = z.object({ event: z.string(), note: z.string().nullish() }).parse(req.body);
    return transitionFinding(req.params.id, body.event as never, body.note);
  }),
);

export default router;
