/**
 * Journeys — `/api/marketing/journeys`. See docs/plan/marketing-api-contract.md.
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  createJourney,
  listJourneys,
  loadJourney,
  updateJourney,
  activateJourney,
  pauseJourney,
  retireJourney,
  listJourneyRuns,
  enrolPerson,
  exitRun,
  tick,
} from '../../domains/marketing/journeys.js';

const router = Router();

router.get('/journeys', handler(async () => {
  const items = await listJourneys();
  return { items, total: items.length };
}));

router.get('/journeys/:id', handler(async (req) => loadJourney(req.params.id)));

router.post('/journeys', handler(async (req) => createJourney(req.body)));

router.patch('/journeys/:id', handler(async (req) => updateJourney(req.params.id, req.body)));

router.post('/journeys/:id/activate', handler(async (req) => activateJourney(req.params.id)));

router.post('/journeys/:id/pause', handler(async (req) => pauseJourney(req.params.id)));

router.post('/journeys/:id/retire', handler(async (req) => retireJourney(req.params.id)));

router.get(
  '/journeys/:id/runs',
  handler(async (req) => {
    const items = await listJourneyRuns(req.params.id, { status: str(req.query.status) });
    return { items, total: items.length };
  }),
);

router.post(
  '/journeys/:id/enrol',
  handler(async (req) => {
    const { personId } = z.object({ personId: z.string() }).parse(req.body);
    return enrolPerson(req.params.id, personId);
  }),
);

router.post(
  '/journeys/runs/:runId/exit',
  handler(async (req) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    return exitRun(req.params.runId, reason);
  }),
);

router.post('/journeys/tick', handler(async () => tick()));

export default router;
export { router };
