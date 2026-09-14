/**
 * Statutory exports, demat and FEMA routes. Thin zod → domain, mounted at
 * `/equity/filings` (`routes/equity.routes.ts` → `routes/index.ts`).
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../lib/http.js';
import { FILING_FORMS, FILING_STATUSES } from '@kaizen/shared';
import {
  mgt1Register, mgt1Export, mgt2Register, mgt2Export,
  pas3AllotteeList, pas3Export, sh4Data, pas6,
  recordFiling, listFilings,
} from '../domains/filings.js';

const router = Router();

router.get('/mgt-1', handler(async (req) => ({ items: await mgt1Register(str(req.query.shareClassId)) })));
router.get(
  '/mgt-1.xlsx',
  handler(async (req, res) => {
    const file = await mgt1Export(str(req.query.shareClassId));
    res
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="mgt-1-register.xlsx"',
        'content-length': String(file.length),
        'cache-control': 'no-store',
      })
      .send(file);
    return undefined;
  }),
);

router.get('/mgt-2', handler(async () => ({ items: await mgt2Register() })));
router.get(
  '/mgt-2.xlsx',
  handler(async (_req, res) => {
    const file = await mgt2Export();
    res
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="mgt-2-register.xlsx"',
        'content-length': String(file.length),
        'cache-control': 'no-store',
      })
      .send(file);
    return undefined;
  }),
);

router.get('/pas-3', handler(async (req) => pas3AllotteeList(String(req.query.roundId ?? ''))));
router.get(
  '/pas-3.xlsx',
  handler(async (req, res) => {
    const file = await pas3Export(String(req.query.roundId ?? ''));
    res
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="pas-3-allottees.xlsx"',
        'content-length': String(file.length),
        'cache-control': 'no-store',
      })
      .send(file);
    return undefined;
  }),
);

router.get('/sh-4.pdf-data', handler(async (req) => sh4Data(String(req.query.transactionId ?? ''))));

router.get('/pas-6.json', handler(async () => pas6()));

router.get('/log', handler(async (req) => ({ items: await listFilings(str(req.query.form)) })));

router.post(
  '/log',
  handler(async (req) => {
    const body = z
      .object({
        form: z.enum(FILING_FORMS),
        relatedType: z.string().nullish(),
        relatedId: z.string().nullish(),
        periodOrEvent: z.string().min(1),
        srn: z.string().nullish(),
        filedOn: z.string().nullish(),
        dueOn: z.string().nullish(),
        status: z.enum(FILING_STATUSES),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return recordFiling(body);
  }),
);

export default router;
