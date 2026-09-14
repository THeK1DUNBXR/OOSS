/**
 * HCM — separations (docs/hcm/separations.md). Mounted at /api/hcm/separations.
 */
import { Router } from 'express';
import { z } from 'zod';
import { RESIGNATION_REASON_CATEGORIES } from '@kaizen/shared';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  listNoticePolicies,
  createNoticePolicy,
  setNoticePolicyActive,
  noticeDaysFor,
  listResignations,
  getResignation,
  submitResignation,
  acceptResignation,
  rejectResignation,
  withdrawResignation,
  listExitClearances,
  initiateClearance,
  clearDepartment,
  blockDepartment,
  getNoDues,
  issueNoDues,
  listAlumni,
  recordAlumni,
  getOffboardingForEmployment,
  assetsPendingCount,
} from '../../domains/hcm/separations.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'separations', ready: true })));

// ---------------------------------------------------------------------------
// Notice policy
// ---------------------------------------------------------------------------

router.get('/notice-policies', handler(async () => listNoticePolicies()));

const noticePolicyBody = z.object({
  name: z.string().min(1),
  grade: z.string().optional(),
  engagementType: z.string().optional(),
  noticeDays: z.number().int().min(0),
  buyoutAllowed: z.boolean().optional(),
});

router.post(
  '/notice-policies',
  handler(async (req) => {
    const parsed = noticePolicyBody.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid notice policy.', parsed.error.flatten());
    return createNoticePolicy(parsed.data);
  }),
);

router.patch(
  '/notice-policies/:id/active',
  handler(async (req) => {
    const active = Boolean(req.body?.active);
    return setNoticePolicyActive(req.params.id, active);
  }),
);

router.get('/notice-policies/for/:employmentId', handler(async (req) => noticeDaysFor(req.params.employmentId)));

// ---------------------------------------------------------------------------
// Resignation
// ---------------------------------------------------------------------------

router.get('/resignations', handler(async (req) => listResignations({ status: str(req.query.status) })));

router.get('/resignations/:id', handler(async (req) => getResignation(req.params.id)));

const submitResignationBody = z.object({
  employmentRelationshipId: z.string().min(1),
  requestedLastDay: z.string().min(1),
  reasonCategory: z.enum(RESIGNATION_REASON_CATEGORIES),
  reasonNote: z.string().optional(),
});

router.post(
  '/resignations',
  handler(async (req) => {
    const parsed = submitResignationBody.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid resignation.', parsed.error.flatten());
    const requestedLastDay = date(parsed.data.requestedLastDay);
    if (!requestedLastDay) throw ApiError.badRequest('requestedLastDay must be a valid date.');
    return submitResignation({ ...parsed.data, requestedLastDay });
  }),
);

router.post(
  '/resignations/:id/accept',
  handler(async (req) => {
    const agreedLastDay = date(req.body?.agreedLastDay);
    return acceptResignation(req.params.id, agreedLastDay, str(req.body?.note));
  }),
);

router.post(
  '/resignations/:id/reject',
  handler(async (req) => {
    const reason = str(req.body?.reason);
    if (!reason) throw ApiError.badRequest('A rejection needs a reason.');
    return rejectResignation(req.params.id, reason);
  }),
);

router.post('/resignations/:id/withdraw', handler(async (req) => withdrawResignation(req.params.id)));

// ---------------------------------------------------------------------------
// Offboarding / clearance / no-dues, addressed by employment id for the "my
// exit" screen and by offboarding id for the HR clearance queue.
// ---------------------------------------------------------------------------

router.get('/offboarding/by-employment/:employmentId', handler(async (req) => getOffboardingForEmployment(req.params.employmentId)));

router.get('/offboarding/:offboardingId/clearances', handler(async (req) => listExitClearances(req.params.offboardingId)));

router.post('/offboarding/:offboardingId/clearances/initiate', handler(async (req) => initiateClearance(req.params.offboardingId)));

router.post(
  '/clearances/:id/clear',
  handler(async (req) => clearDepartment(req.params.id, str(req.body?.note))),
);

router.post(
  '/clearances/:id/block',
  handler(async (req) => {
    const reason = str(req.body?.note);
    if (!reason) throw ApiError.badRequest('Blocking a department needs a reason.');
    return blockDepartment(req.params.id, reason);
  }),
);

router.get('/offboarding/:offboardingId/no-dues', handler(async (req) => getNoDues(req.params.offboardingId)));
router.post('/offboarding/:offboardingId/no-dues', handler(async (req) => issueNoDues(req.params.offboardingId)));

router.get('/assets-pending/:employmentId', handler(async (req) => ({ count: await assetsPendingCount(req.params.employmentId) })));

// ---------------------------------------------------------------------------
// Alumni
// ---------------------------------------------------------------------------

router.get('/alumni', handler(async () => listAlumni()));

router.post(
  '/alumni',
  handler(async (req) => {
    const body = req.body ?? {};
    if (!body.employmentRelationshipId) throw ApiError.badRequest('employmentRelationshipId is required.');
    return recordAlumni({
      employmentRelationshipId: body.employmentRelationshipId,
      rehireEligible: typeof body.rehireEligible === 'boolean' ? body.rehireEligible : null,
      rehireNote: str(body.rehireNote) ?? null,
      contactConsent: Boolean(body.contactConsent),
      contactEmail: str(body.contactEmail) ?? null,
      contactPhone: str(body.contactPhone) ?? null,
    });
  }),
);

export default router;
