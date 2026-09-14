import { Router } from 'express';
import { handler } from '../../lib/http.js';
import { overview } from '../../domains/it/overview.js';

/** Technology — overview (docs/plan/cio.md, workstream I). Mounted at /api/it/. */
const router = Router();

router.get('/overview', handler(async () => overview()));

export default router;
