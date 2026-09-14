/**
 * The group's routes. Mounted at `/group`, under `requireAuth`, in
 * `routes/index.ts` (equity-portal plan §6, phase 2). Every one of these
 * reads from the caller's own tenant only — see the header comment in
 * `domains/group.ts`.
 */

import { Router } from 'express';
import { spinOutPreview, spinOutDivisionsSummary } from '../domains/spinOutPreview.js';
import {
  groupStructure, groupHolders, groupFinancials, groupCompliance,
  entitySnapshotView, publishNow, refreshGroup,
} from '../domains/group.js';
import { handler, str } from '../lib/http.js';

const router = Router();

router.get('/structure', handler(async () => groupStructure()));
router.get('/holders', handler(async () => groupHolders()));
router.get('/financials', handler(async () => groupFinancials()));
router.get('/compliance', handler(async () => groupCompliance()));
router.get('/entities/:sourceTenantId', handler(async (req) => entitySnapshotView(req.params.sourceTenantId)));
router.post('/publish', handler(async () => publishNow()));
router.post('/refresh', handler(async () => refreshGroup()));

/** The spin-out preview (plan §6b): what a division would carry into its own subsidiary. Read-only; the commit is a script. */
router.get('/spin-out/preview', handler(async (req) => {
  const division = str(req.query.division);
  if (!division) return spinOutDivisionsSummary();
  return spinOutPreview(division);
}));

export default router;
