/**
 * HCM — payrollops (docs/hcm/payrollops.md). Mounted at /api/hcm/payrollops.
 *
 * Stub shipped by the scaffold (WS0). The owning workstream replaces this
 * file's body; the route shape (one router per file, mounted in
 * routes/hcm/index.ts) is the shared contract every other workstream relies
 * on to stay out of this file.
 */
import { Router } from 'express';
import { handler } from '../../lib/http.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'payrollops', ready: false })));

export default router;
