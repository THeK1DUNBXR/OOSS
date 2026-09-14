import { Router } from 'express';
import { z } from 'zod';
import { handler, str, numeric } from '../../lib/http.js';
import {
  listTypes,
  listObligations,
  obligationDetail,
  generateObligations,
  markFiled,
  waive,
  summary,
} from '../../domains/compliance/calendar.js';

/** Compliance — calendar (docs/plan/compliance.md). Mounted at /api/compliance/calendar. */
const router = Router();

router.get('/types', handler(async () => listTypes()));

router.get(
  '/',
  handler(async (req) => {
    return listObligations({
      status: str(req.query.status),
      domain: str(req.query.domain),
      period: str(req.query.period),
      typeId: str(req.query.typeId),
    });
  }),
);

router.get('/summary', handler(async () => summary()));

router.get('/:id', handler(async (req) => obligationDetail(req.params.id)));

router.post(
  '/generate',
  handler(async (req) => {
    const body = z.object({ horizonMonths: z.number().int().positive().max(24).optional() }).parse(req.body ?? {});
    return generateObligations(body.horizonMonths ?? numeric(req.query.horizonMonths));
  }),
);

router.post(
  '/:id/file',
  handler(async (req) => {
    const body = z
      .object({
        reference: z.string().min(1),
        evidenceDocumentId: z.string().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return markFiled(req.params.id, body);
  }),
);

router.post(
  '/:id/waive',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1, 'A waiver needs a reason.') }).parse(req.body);
    return waive(req.params.id, body.reason);
  }),
);

export default router;
