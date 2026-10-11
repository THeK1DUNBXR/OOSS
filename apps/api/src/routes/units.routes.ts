/**
 * Business-line units (SPINE-CONTRACT s.1.0). Mounted at `/units`, under
 * requireAuth, in `routes/index.ts`. Each write is checked and audited in
 * `domains/units.ts`; these routes only read the body and the asOf day.
 */

import { Router } from 'express';
import { closeUnit, listUnits, moveUnit, openUnit } from '../domains/units.js';
import { handler, str } from '../lib/http.js';

const router = Router();

/** A body field that is a string, or absent. Anything else is absent, so the domain names what is missing. */
function field(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A body field that is a string or an explicit null (no line, no parent). */
function nullableField(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' ? v : undefined;
}

router.get(
  '/',
  handler(async (req) => listUnits({ asOf: str(req.query.asOf) })),
);

router.post(
  '/',
  handler(async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return openUnit({
      code: field(b.code) ?? '',
      name: field(b.name) ?? '',
      lineId: nullableField(b.lineId) ?? null,
      parentUnitId: nullableField(b.parentUnitId) ?? null,
      effectiveFrom: field(b.effectiveFrom),
      reason: field(b.reason) ?? '',
    });
  }),
);

router.post(
  '/:id/close',
  handler(async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return closeUnit({
      id: req.params.id,
      effectiveTo: field(b.effectiveTo) ?? '',
      reason: field(b.reason) ?? '',
    });
  }),
);

router.post(
  '/:id/move',
  handler(async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return moveUnit({
      id: req.params.id,
      toLineId: nullableField(b.toLineId) ?? null,
      parentUnitId: nullableField(b.parentUnitId),
      effectiveFrom: field(b.effectiveFrom) ?? '',
      reason: field(b.reason) ?? '',
    });
  }),
);

export default router;
