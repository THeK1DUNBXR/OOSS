/**
 * HCM — performance (docs/hcm/performance.md). Mounted at /api/hcm/performance.
 */
import { Router } from 'express';
import { z } from 'zod';
import { REVIEW_CYCLE_PHASES } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  listReviewCycles,
  getReviewCycle,
  createReviewCycle,
  advanceReviewCyclePhase,
  listReviewTemplates,
  createReviewTemplate,
  listReviewAssignments,
  createReviewAssignment,
  getReviewAssignment,
  submitReviewResponse,
  listCalibrationSessions,
  openCalibrationSession,
  updateCalibrationDecisions,
  closeCalibrationSession,
  listFinalRatings,
  releaseFinalRating,
  nineBoxForCycle,
  listFeedback,
  giveFeedback,
  listOneOnOnes,
  scheduleOneOnOne,
  updateOneOnOne,
  listPips,
  openPip,
  addPipCheckpoint,
  closePip,
  listSuccessionPlans,
  createSuccessionPlan,
  updateSuccessionPlan,
  myEmploymentContext,
} from '../../domains/hcm/performance.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'performance', ready: true })));

router.get('/my/context', handler(async () => myEmploymentContext()));

// ---------------------------------------------------------------------------
// Review cycles
// ---------------------------------------------------------------------------

router.get('/review-cycles', handler(async () => listReviewCycles()));
router.get('/review-cycles/:id', handler(async (req) => getReviewCycle(req.params.id)));

const createCycleBody = z.object({
  name: z.string().min(1),
  kind: z.string(),
  periodLabel: z.string().min(1),
  startsOn: z.string(),
  endsOn: z.string(),
});

router.post(
  '/review-cycles',
  handler(async (req) => {
    const body = createCycleBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid review cycle payload.', body.error.flatten());
    return createReviewCycle({
      name: body.data.name,
      kind: body.data.kind as never,
      periodLabel: body.data.periodLabel,
      startsOn: new Date(body.data.startsOn),
      endsOn: new Date(body.data.endsOn),
    });
  }),
);

const phaseBody = z.object({ phase: z.string() });

router.post(
  '/review-cycles/:id/phase',
  handler(async (req) => {
    const body = phaseBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('A phase advance needs a `phase`.', body.error.flatten());
    if (!REVIEW_CYCLE_PHASES.includes(body.data.phase as never)) {
      throw ApiError.badRequest(`"${body.data.phase}" is not a review cycle phase.`);
    }
    return advanceReviewCyclePhase(req.params.id, body.data.phase as never);
  }),
);

// ---------------------------------------------------------------------------
// Review templates
// ---------------------------------------------------------------------------

router.get('/review-templates', handler(async () => listReviewTemplates()));

const templateBody = z.object({ name: z.string().min(1), sections: z.array(z.unknown()).min(1), ratingScale: z.array(z.unknown()).min(1) });

router.post(
  '/review-templates',
  handler(async (req) => {
    const body = templateBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid review template payload.', body.error.flatten());
    return createReviewTemplate(body.data);
  }),
);

// ---------------------------------------------------------------------------
// Review assignments + responses
// ---------------------------------------------------------------------------

router.get(
  '/review-assignments',
  handler(async (req) =>
    listReviewAssignments({
      cycleId: str(req.query.cycleId),
      employmentRelationshipId: str(req.query.employmentRelationshipId),
      mine: req.query.mine === 'true',
    }),
  ),
);

router.get('/review-assignments/:id', handler(async (req) => getReviewAssignment(req.params.id)));

const createAssignmentBody = z.object({
  cycleId: z.string().min(1),
  templateId: z.string().optional().nullable(),
  employmentRelationshipId: z.string().min(1),
  reviewerEmploymentRelationshipId: z.string().min(1),
  kind: z.string(),
  dueAt: z.string().optional().nullable(),
});

router.post(
  '/review-assignments',
  handler(async (req) => {
    const body = createAssignmentBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid review assignment payload.', body.error.flatten());
    return createReviewAssignment({
      cycleId: body.data.cycleId,
      templateId: body.data.templateId ?? null,
      employmentRelationshipId: body.data.employmentRelationshipId,
      reviewerEmploymentRelationshipId: body.data.reviewerEmploymentRelationshipId,
      kind: body.data.kind as never,
      dueAt: body.data.dueAt ? new Date(body.data.dueAt) : null,
    });
  }),
);

const responseBody = z.object({ ratings: z.array(z.unknown()).min(1), comments: z.string().optional().nullable() });

router.post(
  '/review-assignments/:id/submit',
  handler(async (req) => {
    const body = responseBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('A review response needs `ratings`.', body.error.flatten());
    return submitReviewResponse(req.params.id, body.data);
  }),
);

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

router.get('/calibrations', handler(async (req) => listCalibrationSessions(str(req.query.cycleId))));

const openCalibrationBody = z.object({
  cycleId: z.string().min(1),
  participants: z.array(z.object({ employmentRelationshipId: z.string().min(1) })).min(1),
});

router.post(
  '/calibrations',
  handler(async (req) => {
    const body = openCalibrationBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid calibration session payload.', body.error.flatten());
    return openCalibrationSession(body.data);
  }),
);

const decisionsBody = z.object({
  decisions: z
    .array(
      z.object({
        employmentRelationshipId: z.string().min(1),
        rating: z.string().min(1),
        potential: z.string(),
        band: z.string().optional().nullable(),
        promotionRecommended: z.boolean().optional(),
        incrementRecommendedPct: z.number().optional().nullable(),
        note: z.string().optional().nullable(),
      }),
    )
    .min(1),
});

router.patch(
  '/calibrations/:id',
  handler(async (req) => {
    const body = decisionsBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid calibration decisions payload.', body.error.flatten());
    return updateCalibrationDecisions(req.params.id, body.data.decisions as never);
  }),
);

router.post('/calibrations/:id/close', handler(async (req) => closeCalibrationSession(req.params.id)));

// ---------------------------------------------------------------------------
// Final ratings + 9-box
// ---------------------------------------------------------------------------

router.get(
  '/final-ratings',
  handler(async (req) => listFinalRatings({ cycleId: str(req.query.cycleId), employmentRelationshipId: str(req.query.employmentRelationshipId) })),
);

router.post('/final-ratings/:id/release', handler(async (req) => releaseFinalRating(req.params.id)));

router.get('/nine-box', handler(async (req) => {
  const cycleId = str(req.query.cycleId);
  if (!cycleId) throw ApiError.badRequest('The 9-box needs a `cycleId`.');
  return nineBoxForCycle(cycleId);
}));

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

router.get(
  '/feedback',
  handler(async (req) =>
    listFeedback({
      employmentRelationshipId: str(req.query.employmentRelationshipId),
      direction: req.query.direction === 'given' ? 'given' : req.query.direction === 'received' ? 'received' : undefined,
    }),
  ),
);

const feedbackBody = z.object({
  fromEmploymentRelationshipId: z.string().min(1),
  toEmploymentRelationshipId: z.string().min(1),
  kind: z.string(),
  message: z.string().min(1),
  visibility: z.string().optional(),
});

router.post(
  '/feedback',
  handler(async (req) => {
    const body = feedbackBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid feedback payload.', body.error.flatten());
    return giveFeedback({ ...body.data, kind: body.data.kind as never, visibility: body.data.visibility as never });
  }),
);

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

router.get('/one-on-ones', handler(async (req) => listOneOnOnes({ employmentRelationshipId: str(req.query.employmentRelationshipId) })));

const oneOnOneBody = z.object({
  managerEmploymentRelationshipId: z.string().min(1),
  reportEmploymentRelationshipId: z.string().min(1),
  scheduledAt: z.string(),
  agenda: z.unknown().optional(),
});

router.post(
  '/one-on-ones',
  handler(async (req) => {
    const body = oneOnOneBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid 1:1 payload.', body.error.flatten());
    return scheduleOneOnOne({ ...body.data, scheduledAt: new Date(body.data.scheduledAt) });
  }),
);

const oneOnOnePatchBody = z.object({
  notes: z.unknown().optional(),
  actions: z.unknown().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
});

router.patch(
  '/one-on-ones/:id',
  handler(async (req) => {
    const body = oneOnOnePatchBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid 1:1 update.', body.error.flatten());
    return updateOneOnOne(req.params.id, body.data);
  }),
);

// ---------------------------------------------------------------------------
// PIPs
// ---------------------------------------------------------------------------

router.get('/pips', handler(async (req) => listPips({ employmentRelationshipId: str(req.query.employmentRelationshipId) })));

const pipBody = z.object({
  employmentRelationshipId: z.string().min(1),
  managerEmploymentRelationshipId: z.string().optional().nullable(),
  startsOn: z.string(),
  endsOn: z.string(),
  objectives: z.array(z.unknown()).min(1),
});

router.post(
  '/pips',
  handler(async (req) => {
    const body = pipBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid PIP payload.', body.error.flatten());
    return openPip({ ...body.data, startsOn: new Date(body.data.startsOn), endsOn: new Date(body.data.endsOn) });
  }),
);

const checkpointBody = z.object({ note: z.string().min(1), onTrack: z.boolean() });

router.post(
  '/pips/:id/checkpoints',
  handler(async (req) => {
    const body = checkpointBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('A checkpoint needs a `note` and `onTrack`.', body.error.flatten());
    return addPipCheckpoint(req.params.id, body.data);
  }),
);

const closePipBody = z.object({ outcome: z.string(), note: z.string().optional() });

router.post(
  '/pips/:id/close',
  handler(async (req) => {
    const body = closePipBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Closing a PIP needs an `outcome`.', body.error.flatten());
    return closePip(req.params.id, body.data.outcome as never, body.data.note);
  }),
);

// ---------------------------------------------------------------------------
// Succession
// ---------------------------------------------------------------------------

router.get('/succession-plans', handler(async () => listSuccessionPlans()));

const successorSchema = z.object({ employmentRelationshipId: z.string().min(1), readiness: z.string(), note: z.string().optional().nullable() });
const successionBody = z.object({ positionTitle: z.string().min(1), positionId: z.string().optional().nullable(), successors: z.array(successorSchema) });

router.post(
  '/succession-plans',
  handler(async (req) => {
    const body = successionBody.safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid succession plan payload.', body.error.flatten());
    return createSuccessionPlan(body.data as never);
  }),
);

router.patch(
  '/succession-plans/:id',
  handler(async (req) => {
    const body = z.object({ successors: z.array(successorSchema) }).safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid successors payload.', body.error.flatten());
    return updateSuccessionPlan(req.params.id, body.data.successors as never);
  }),
);

export default router;
