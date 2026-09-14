import { Router } from 'express';
import { z } from 'zod';
import { handler, str, numeric } from '../../lib/http.js';
import {
  createPlan,
  updatePlan,
  transitionPlan,
  listPlans,
  planDetail,
  recordTest,
  listTests,
  recordAvailabilityReading,
  listAvailabilityReadings,
  createMaintenanceWindow,
  listMaintenanceWindows,
  maintenanceWindowDetail,
  cancelMaintenanceWindow,
  continuitySummary,
  availabilitySummary,
} from '../../domains/it/continuity.js';

/** Technology — continuity and operations (docs/plan/cio.md, workstream H).
 * Mounted at /api/it/ — every segment declared in full. */
const router = Router();

// ---------------------------------------------------------------------------
// Continuity plans
// ---------------------------------------------------------------------------

const createPlanBody = z.object({
  applicationId: z.string().min(1),
  applicationName: z.string().min(1),
  applicationTier: z.number().int().min(1).max(4),
  rtoMinutes: z.number().int().positive(),
  rpoMinutes: z.number().int().positive(),
  backupMethod: z.string().min(1),
  backupFrequency: z.string().min(1),
  restoreProcedureDocumentId: z.string().nullish(),
  ownerPartyId: z.string().nullish(),
  testCadenceDays: z.number().int().positive().nullish(),
  note: z.string().nullish(),
});

const updatePlanBody = z.object({
  rtoMinutes: z.number().int().positive().optional(),
  rpoMinutes: z.number().int().positive().optional(),
  backupMethod: z.string().min(1).optional(),
  backupFrequency: z.string().min(1).optional(),
  restoreProcedureDocumentId: z.string().nullish(),
  ownerPartyId: z.string().nullish(),
  testCadenceDays: z.number().int().positive().optional(),
  note: z.string().nullish(),
  status: z.enum(['active', 'retired']).optional(),
});

router.get('/continuity/summary', handler(async () => continuitySummary()));

router.get(
  '/continuity/plans',
  handler(async (req) => listPlans({ tier: numeric(req.query.tier), status: str(req.query.status) })),
);

router.post('/continuity/plans', handler(async (req) => createPlan(createPlanBody.parse(req.body))));

router.get('/continuity/plans/:id', handler(async (req) => planDetail(req.params.id)));

router.patch(
  '/continuity/plans/:id',
  handler(async (req) => {
    const body = updatePlanBody.parse(req.body ?? {});
    const { status, ...rest } = body;
    if (status) return transitionPlan(req.params.id, status);
    return updatePlan(req.params.id, rest);
  }),
);

const recordTestBody = z.object({
  testedAt: z.string().datetime().optional(),
  kind: z.enum(['restore', 'failover', 'tabletop']),
  outcome: z.enum(['pass', 'fail', 'partial']),
  actualRecoveryMinutes: z.number().int().min(0).nullish(),
  actualDataLossMinutes: z.number().int().min(0).nullish(),
  notes: z.string().nullish(),
  evidenceDocumentId: z.string().nullish(),
});

router.get('/continuity/plans/:id/tests', handler(async (req) => listTests(req.params.id)));

router.post(
  '/continuity/plans/:id/tests',
  handler(async (req) => {
    const body = recordTestBody.parse(req.body);
    return recordTest(req.params.id, { ...body, testedAt: body.testedAt ? new Date(body.testedAt) : undefined });
  }),
);

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const recordAvailabilityBody = z.object({
  applicationId: z.string().min(1),
  applicationName: z.string().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  minutesDown: z.number().int().min(0),
  incidentCount: z.number().int().min(0).optional(),
  source: z.enum(['typed', 'incidents']).optional(),
  note: z.string().nullish(),
});

router.get('/availability/summary', handler(async () => availabilitySummary()));

router.get(
  '/availability/readings',
  handler(async (req) => listAvailabilityReadings({ period: str(req.query.period), applicationId: str(req.query.applicationId) })),
);

router.post('/availability/readings', handler(async (req) => recordAvailabilityReading(recordAvailabilityBody.parse(req.body))));

// ---------------------------------------------------------------------------
// Maintenance windows
// ---------------------------------------------------------------------------

const createMaintenanceBody = z.object({
  applicationId: z.string().min(1),
  applicationName: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1),
  changeId: z.string().nullish(),
});

router.get(
  '/maintenance',
  handler(async (req) => {
    const when = str(req.query.when) as 'upcoming' | 'past' | 'all' | undefined;
    return listMaintenanceWindows({ when, status: str(req.query.status) });
  }),
);

router.post(
  '/maintenance',
  handler(async (req) => {
    const body = createMaintenanceBody.parse(req.body);
    return createMaintenanceWindow({ ...body, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) });
  }),
);

router.get('/maintenance/:id', handler(async (req) => maintenanceWindowDetail(req.params.id)));

router.post(
  '/maintenance/:id/cancel',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1, 'Cancelling a maintenance window needs a reason.') }).parse(req.body);
    return cancelMaintenanceWindow(req.params.id, body.reason);
  }),
);

export default router;
