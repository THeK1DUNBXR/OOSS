/**
 * HCM — WS11 assets (docs/hcm/assets.md). Mounted at /api/hcm/assets.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listAssets, createAsset, transitionAsset,
  listAssetAssignments, assignAsset, returnAsset,
  listTravelRequests, createTravelRequest, decideTravelRequest, settleTravelRequest,
  listLetterRequests, createLetterRequest, fulfilLetterRequest, rejectLetterRequest, listIssuedHrLetters,
  listIdCards, issueIdCard, reportIdCardLost, returnIdCard,
  assetsPendingCount, assetsPendingForEmployment, myEmployment,
} from '../../domains/hcm/assets.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'assets', ready: true })));

router.get('/me/employment', handler(async () => myEmployment()));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

router.get('/inventory', handler(async (req) => listAssets({ status: str(req.query.status) })));

router.post(
  '/inventory',
  handler(async (req) => {
    const body = z
      .object({
        tag: z.string().min(1),
        category: z.enum(['laptop', 'phone', 'access_card', 'other']),
        serial: z.string().nullish(),
        purchaseDate: z.coerce.date().nullish(),
        cost: z.number().nonnegative().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return createAsset(body);
  }),
);

router.post(
  '/inventory/:id/transition',
  handler(async (req) => {
    const body = z.object({ status: z.enum(['in_stock', 'repair', 'retired']) }).parse(req.body);
    return transitionAsset(req.params.id, body.status);
  }),
);

router.get('/pending', handler(async () => assetsPendingCount()));
router.get('/pending/:employmentId', handler(async (req) => ({ pending: await assetsPendingForEmployment(req.params.employmentId) })));

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

router.get(
  '/assignments',
  handler(async (req) =>
    listAssetAssignments({ employmentRelationshipId: str(req.query.employmentId), assetId: str(req.query.assetId) }),
  ),
);

router.post(
  '/assignments',
  handler(async (req) => {
    const body = z
      .object({
        assetId: z.string().min(1),
        employmentRelationshipId: z.string().min(1),
        condition: z.enum(['good', 'fair', 'poor']).optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return assignAsset(body);
  }),
);

router.post(
  '/assignments/:id/return',
  handler(async (req) => {
    const body = z.object({ condition: z.enum(['good', 'fair', 'poor']), note: z.string().nullish() }).parse(req.body);
    return returnAsset(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Travel requests
// ---------------------------------------------------------------------------

router.get(
  '/travel',
  handler(async (req) => listTravelRequests({ employmentRelationshipId: str(req.query.employmentId), status: str(req.query.status) })),
);

router.post(
  '/travel',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        purpose: z.string().min(1),
        fromLocation: z.string().min(1),
        toLocation: z.string().min(1),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        mode: z.enum(['flight', 'train', 'road', 'other']),
        estimatedCost: z.number().nonnegative(),
        advanceRequested: z.number().nonnegative().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return createTravelRequest(body);
  }),
);

router.post(
  '/travel/:id/decide',
  handler(async (req) => {
    const body = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }).parse(req.body);
    return decideTravelRequest(req.params.id, body.decision, body.note);
  }),
);

router.post(
  '/travel/:id/settle',
  handler(async (req) => {
    const body = z.object({ expenseClaimId: z.string().min(1) }).parse(req.body);
    return settleTravelRequest(req.params.id, body.expenseClaimId);
  }),
);

// ---------------------------------------------------------------------------
// Letter requests
// ---------------------------------------------------------------------------

router.get(
  '/letters',
  handler(async (req) => listLetterRequests({ employmentRelationshipId: str(req.query.employmentId), status: str(req.query.status) })),
);

router.get('/letters/issued/:employmentId', handler(async (req) => listIssuedHrLetters(req.params.employmentId)));

router.post(
  '/letters',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        kind: z.enum(['address_proof', 'salary_certificate', 'noc', 'visa', 'experience']),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return createLetterRequest(body);
  }),
);

router.post('/letters/:id/fulfil', handler(async (req) => fulfilLetterRequest(req.params.id)));

router.post(
  '/letters/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectLetterRequest(req.params.id, body.note);
  }),
);

// ---------------------------------------------------------------------------
// ID cards
// ---------------------------------------------------------------------------

router.get('/idcards', handler(async (req) => listIdCards({ employmentRelationshipId: str(req.query.employmentId) })));

router.post(
  '/idcards',
  handler(async (req) => {
    const body = z.object({ employmentRelationshipId: z.string().min(1) }).parse(req.body);
    return issueIdCard(body.employmentRelationshipId);
  }),
);

router.post('/idcards/:id/lost', handler(async (req) => reportIdCardLost(req.params.id)));
router.post('/idcards/:id/return', handler(async (req) => returnIdCard(req.params.id)));

export default router;
