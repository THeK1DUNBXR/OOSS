/**
 * The group's routes. Mounted at `/group`, under `requireAuth`, in
 * `routes/index.ts` (equity-portal plan §6, phase 2). Every one of these
 * reads from the caller's own tenant only — see the header comment in
 * `domains/group.ts`.
 */

import { Router } from 'express';
import {
  groupStructure, groupHolders, groupFinancials, groupCompliance,
  entitySnapshotView, publishNow, refreshGroup,
} from '../domains/group.js';
import { handler } from '../lib/http.js';

const router = Router();

router.get('/structure', handler(async () => groupStructure()));
router.get('/holders', handler(async () => groupHolders()));
router.get('/financials', handler(async () => groupFinancials()));
router.get('/compliance', handler(async () => groupCompliance()));
router.get('/entities/:sourceTenantId', handler(async (req) => entitySnapshotView(req.params.sourceTenantId)));
router.post('/publish', handler(async () => publishNow()));
router.post('/refresh', handler(async () => refreshGroup()));

export default router;
