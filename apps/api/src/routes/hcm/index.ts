/**
 * HCM/HRMS (docs/plan/hcm.md). One router per workstream, each in its own
 * file so the workstreams can be built side by side. Mounted at /api/hcm by
 * routes/index.ts, behind requireAuth.
 */
import { Router } from 'express';
import workforce from './workforce.routes.js';
import time from './time.routes.js';
import leavepolicy from './leavepolicy.routes.js';
import recruiting from './recruiting.routes.js';
import performance from './performance.routes.js';
import learning from './learning.routes.js';
import compensation from './compensation.routes.js';
import payrollops from './payrollops.routes.js';
import engagement from './engagement.routes.js';
import separations from './separations.routes.js';
import assets from './assets.routes.js';
import analytics from './analytics.routes.js';
import workflow from './workflow.routes.js';

const router = Router();
router.use('/workforce', workforce);
router.use('/time', time);
router.use('/leavepolicy', leavepolicy);
router.use('/recruiting', recruiting);
router.use('/performance', performance);
router.use('/learning', learning);
router.use('/compensation', compensation);
router.use('/payrollops', payrollops);
router.use('/engagement', engagement);
router.use('/separations', separations);
router.use('/assets', assets);
router.use('/analytics', analytics);
router.use('/workflow', workflow);

export default router;
