/**
 * The group's routes. Thin — the only surface here is the read-only
 * spin-out preview (equity-portal plan §6b); mounted at `/group` under
 * `requireAuth` in `routes/index.ts`.
 */

import { Router } from 'express';
import { handler, str } from '../lib/http.js';
import { spinOutPreview, spinOutDivisionsSummary } from '../domains/group.js';

const router = Router();

router.get('/spin-out/preview', handler(async (req) => {
  const division = str(req.query.division);
  if (!division) return spinOutDivisionsSummary();
  return spinOutPreview(division);
}));

export default router;
