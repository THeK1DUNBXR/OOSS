/**
 * Technology — assets (docs/plan/cio.md, workstream A). Mounted at
 * /api/it/assets, so every path here is relative to that.
 */
import { Router } from 'express';
import { z } from 'zod';
import { IT_ASSET_KINDS, IT_ASSET_CONDITIONS } from '@kaizen/shared';
import { handler, str, date } from '../../lib/http.js';
import {
  createAsset,
  updateAsset,
  listAssets,
  myAssets,
  assetDetail,
  assignAsset,
  returnAsset,
  transitionAsset,
  addAssetEvent,
  listAssetEvents,
  summary,
} from '../../domains/it/assets.js';

const router = Router();

const kindSchema = z.enum(IT_ASSET_KINDS);
const conditionSchema = z.enum(IT_ASSET_CONDITIONS);

router.get(
  '/',
  handler(async (req) => listAssets({ status: str(req.query.status), kind: str(req.query.kind), search: str(req.query.search) })),
);

router.get('/summary', handler(async () => summary()));

router.get('/mine', handler(async () => myAssets()));

router.post(
  '/',
  handler(async (req) => {
    const body = z
      .object({
        tag: z.string().min(1),
        kind: kindSchema,
        make: z.string().nullish(),
        model: z.string().nullish(),
        serial: z.string().nullish(),
        purchaseDate: z.string().nullish(),
        purchaseCost: z.number().nonnegative().nullish(),
        warrantyEnd: z.string().nullish(),
        supplierName: z.string().nullish(),
        vendorId: z.string().nullish(),
        location: z.string().nullish(),
        division: z.string().nullish(),
        fixedAssetId: z.string().nullish(),
        condition: conditionSchema.nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body);
    return createAsset({
      ...body,
      purchaseDate: date(body.purchaseDate ?? undefined) ?? null,
      warrantyEnd: date(body.warrantyEnd ?? undefined) ?? null,
    });
  }),
);

router.get('/:id', handler(async (req) => assetDetail(req.params.id)));

router.patch(
  '/:id',
  handler(async (req) => {
    const body = z
      .object({
        make: z.string().nullish(),
        model: z.string().nullish(),
        serial: z.string().nullish(),
        purchaseDate: z.string().nullish(),
        purchaseCost: z.number().nonnegative().nullish(),
        warrantyEnd: z.string().nullish(),
        supplierName: z.string().nullish(),
        vendorId: z.string().nullish(),
        location: z.string().nullish(),
        division: z.string().nullish(),
        fixedAssetId: z.string().nullish(),
        condition: conditionSchema.nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body);
    return updateAsset(req.params.id, {
      make: body.make,
      model: body.model,
      serial: body.serial,
      purchaseCost: body.purchaseCost,
      supplierName: body.supplierName,
      vendorId: body.vendorId,
      location: body.location,
      division: body.division,
      fixedAssetId: body.fixedAssetId,
      condition: body.condition,
      notes: body.notes,
      ...(body.purchaseDate !== undefined ? { purchaseDate: date(body.purchaseDate ?? undefined) ?? null } : {}),
      ...(body.warrantyEnd !== undefined ? { warrantyEnd: date(body.warrantyEnd ?? undefined) ?? null } : {}),
    });
  }),
);

router.post(
  '/:id/assign',
  handler(async (req) => {
    const body = z
      .object({ partyId: z.string().min(1), conditionOut: conditionSchema.nullish(), note: z.string().nullish() })
      .parse(req.body);
    return assignAsset(req.params.id, body);
  }),
);

router.post(
  '/:id/return',
  handler(async (req) => {
    const body = z
      .object({ conditionIn: conditionSchema.nullish(), note: z.string().nullish(), acknowledged: z.boolean().optional() })
      .parse(req.body);
    return returnAsset(req.params.id, body);
  }),
);

router.post(
  '/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        event: z.enum(['SEND_TO_REPAIR', 'BACK_FROM_REPAIR', 'RETIRE', 'DISPOSE']),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return transitionAsset(req.params.id, body.event, body.note ?? undefined);
  }),
);

router.get('/:id/events', handler(async (req) => listAssetEvents(req.params.id)));

router.post(
  '/:id/events',
  handler(async (req) => {
    const body = z.object({ kind: z.string().default('note'), detail: z.string().min(1) }).parse(req.body);
    return addAssetEvent(req.params.id, body);
  }),
);

export default router;
