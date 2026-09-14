/**
 * HCM — separations (docs/hcm/separations.md). Mounted at /api/hcm/separations.
 *
 * Stub shipped by the scaffold (WS0). The owning workstream replaces this
 * file's body; the route shape (one router per file, mounted in
 * routes/hcm/index.ts) is the shared contract every other workstream relies
 * on to stay out of this file.
 */
import { Router } from 'express';
import { handler } from '../../lib/http.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'separations', ready: false })));

export default router;
