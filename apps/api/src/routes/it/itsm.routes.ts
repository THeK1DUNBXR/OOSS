/**
 * Technology — incidents, problems and changes (docs/plan/cio.md,
 * workstream E). Mounted at /api/it. Order matters: `/incidents/summary` and
 * `/changes/summary`/`/changes/freezes` must be declared before their `:id`
 * siblings.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  changeDetail,
  changeSummary,
  createChange,
  createProblem,
  declareFreeze,
  declareIncident,
  incidentDetail,
  incidentSummary,
  listChanges,
  listFreezes,
  listIncidents,
  listProblems,
  postIncidentUpdate,
  problemDetail,
  submitIncidentReview,
  transitionChange,
  transitionIncident,
  transitionProblem,
  updateProblem,
} from '../../domains/it/itsm.js';

const router = Router();

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

router.get(
  '/incidents',
  handler(async (req) => listIncidents({ status: str(req.query.status), severity: str(req.query.severity) })),
);

router.get('/incidents/summary', handler(async () => incidentSummary()));

router.post(
  '/incidents',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
        affectedApplicationIds: z.array(z.string()).optional(),
        impact: z.string().nullish(),
        customerFacing: z.boolean().optional(),
        commanderPartyId: z.string().nullish(),
        breachId: z.string().nullish(),
      })
      .parse(req.body);
    return declareIncident(body);
  }),
);

router.get('/incidents/:id', handler(async (req) => incidentDetail(req.params.id)));

router.post(
  '/incidents/:id/transition',
  handler(async (req) => {
    const body = z.object({ event: z.enum(['ACKNOWLEDGE', 'MITIGATE', 'RESOLVE', 'CLOSE']), note: z.string().optional() }).parse(req.body);
    return transitionIncident(req.params.id, body.event, body.note);
  }),
);

router.post(
  '/incidents/:id/updates',
  handler(async (req) => {
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    return postIncidentUpdate(req.params.id, body.body);
  }),
);

router.post(
  '/incidents/:id/review',
  handler(async (req) => {
    const body = z.object({ reviewBody: z.string(), publish: z.boolean().optional() }).parse(req.body);
    return submitIncidentReview(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

router.get('/problems', handler(async (req) => listProblems(str(req.query.status))));

router.post(
  '/problems',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        rootCause: z.string().nullish(),
        knownError: z.boolean().optional(),
        workaround: z.string().nullish(),
        incidentIds: z.array(z.string()).optional(),
        ownerPartyId: z.string().nullish(),
      })
      .parse(req.body);
    return createProblem(body);
  }),
);

router.get('/problems/:id', handler(async (req) => problemDetail(req.params.id)));

router.patch(
  '/problems/:id',
  handler(async (req) => {
    const body = z
      .object({
        rootCause: z.string().nullish(),
        knownError: z.boolean().optional(),
        workaround: z.string().nullish(),
        incidentIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return updateProblem(req.params.id, body);
  }),
);

router.post(
  '/problems/:id/transition',
  handler(async (req) => {
    const body = z.object({ event: z.enum(['ANALYSE', 'MARK_KNOWN_ERROR', 'RESOLVE', 'REOPEN', 'CLOSE']), note: z.string().optional() }).parse(req.body);
    return transitionProblem(req.params.id, body.event, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

router.get(
  '/changes',
  handler(async (req) => listChanges({ status: str(req.query.status), mine: req.query.mine === 'true' })),
);

router.get('/changes/summary', handler(async () => changeSummary()));

router.get('/changes/freezes', handler(async () => listFreezes()));

router.post(
  '/changes/freezes',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        reason: z.string().min(1),
        allowEmergency: z.boolean().optional(),
      })
      .parse(req.body);
    return declareFreeze(body);
  }),
);

router.post(
  '/changes',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        kind: z.enum(['standard', 'normal', 'emergency']),
        risk: z.enum(['low', 'medium', 'high']),
        affectedApplicationIds: z.array(z.string()).optional(),
        plan: z.string().min(1),
        rollbackPlan: z.string().min(1),
        windowStart: z.coerce.date(),
        windowEnd: z.coerce.date(),
      })
      .parse(req.body);
    return createChange(body);
  }),
);

router.get('/changes/:id', handler(async (req) => changeDetail(req.params.id)));

router.post(
  '/changes/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        event: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'SCHEDULE', 'IMPLEMENT', 'FAIL', 'REVIEW', 'ROLLBACK']),
        note: z.string().optional(),
      })
      .parse(req.body);
    return transitionChange(req.params.id, body);
  }),
);

export default router;
