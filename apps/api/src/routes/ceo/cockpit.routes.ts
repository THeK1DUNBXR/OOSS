/**
 * Chairman's Office — cockpit routes (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Phase 0 wires the mount point and proves it end to end with a stub: every
 * GET returns `{ items: [] }`, every write returns 501. The owning phase
 * replaces this whole file — `routes/ceo/index.ts` never changes to pick it
 * up, since it already imports this file's default export by name.
 */

import { Router } from 'express';
import { handler } from '../../lib/http.js';

const router = Router();

router.get('*', handler(async () => ({ items: [] })));

router.post(
  '*',
  handler(async (_req, res) => {
    res.status(501);
    return { message: 'Not built yet.' };
  }),
);

router.patch(
  '*',
  handler(async (_req, res) => {
    res.status(501);
    return { message: 'Not built yet.' };
  }),
);

router.delete(
  '*',
  handler(async (_req, res) => {
    res.status(501);
    return { message: 'Not built yet.' };
  }),
);

export default router;
