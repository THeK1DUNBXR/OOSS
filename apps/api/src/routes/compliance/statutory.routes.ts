import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { handler, str } from '../../lib/http.js';
import {
  approveStatutoryRule,
  assignDuty,
  createStatutoryRule,
  endDuty,
  holdStatutoryRule,
  listStatutoryRules,
  getDutyHolder,
} from '../../domains/statutory.js';

/**
 * Compliance — statutory rule data and duty holders (ORDERED-PLAN 3.1; round 27 c).
 * Mounted at /api/compliance/statutory. Approval is a duty held by a person named per
 * tenant, so the approve route refuses anyone else; nothing here names a holder.
 */
const router = Router();

const DUTY_KEY = z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/);

router.get(
  '/rules',
  handler(async (req) =>
    listStatutoryRules({
      domain: str(req.query.domain),
      key: str(req.query.key),
      jurisdiction: str(req.query.jurisdiction),
    }),
  ),
);

router.post(
  '/rules',
  handler(async (req) => {
    const body = z
      .object({
        domain: z.string().min(1),
        key: z.string().min(1),
        jurisdiction: z.string().min(1),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().nullish(),
        value: z.unknown().refine((v) => v !== undefined, 'value is required'),
        source: z.string(),
      })
      .parse(req.body);
    return createStatutoryRule({
      ...body,
      effectiveTo: body.effectiveTo ?? null,
      value: body.value as Prisma.InputJsonValue,
    });
  }),
);

router.post(
  '/rules/:id/approve',
  handler(async (req) => {
    // source is accepted only for a rule whose citation is UNVERIFIED; the domain says so.
    const body = z.object({ source: z.string().optional() }).parse(req.body ?? {});
    return approveStatutoryRule(req.params.id, body);
  }),
);

router.post(
  '/rules/:id/hold',
  handler(async (req) => holdStatutoryRule(req.params.id)),
);

router.get(
  '/duties/:dutyKey/holder',
  handler(async (req) => {
    const dutyKey = DUTY_KEY.parse(req.params.dutyKey);
    const holder = await getDutyHolder(dutyKey);
    return holder ?? { holder: null };
  }),
);

router.post(
  '/duties/:dutyKey/holder',
  handler(async (req) => {
    const dutyKey = DUTY_KEY.parse(req.params.dutyKey);
    const body = z.object({ partyId: z.string().min(1), effectiveFrom: z.coerce.date().optional() }).parse(req.body);
    return assignDuty({ dutyKey, partyId: body.partyId, effectiveFrom: body.effectiveFrom });
  }),
);

router.post(
  '/duties/assignments/:id/end',
  handler(async (req) => endDuty(req.params.id)),
);

export default router;
