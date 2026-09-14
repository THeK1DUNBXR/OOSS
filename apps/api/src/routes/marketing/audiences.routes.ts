import { Router } from 'express';
import { z } from 'zod';
import { AUDIENCE_ENTITY_TYPES, AUDIENCE_KINDS } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  createAudience,
  listAudiences,
  loadAudience,
  updateAudience,
  deleteAudience,
  evaluateAudience,
  addAudienceMember,
  removeAudienceMember,
  suppressMember,
  previewAudience,
  audienceFields,
} from '../../domains/marketing/audiences.js';

const router = Router();

const RuleConditionSchema = z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() });
const RuleSchema = z.object({ all: z.array(RuleConditionSchema).optional(), any: z.array(RuleConditionSchema).optional() });

const AudienceInputSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(AUDIENCE_KINDS),
  entityType: z.enum(AUDIENCE_ENTITY_TYPES),
  rules: RuleSchema.optional().nullable(),
  description: z.string().optional().nullable(),
});

router.get(
  '/fields',
  handler(async (req) => {
    const entityType = str(req.query.entityType);
    if (!entityType) throw ApiError.badRequest('entityType is required.');
    return audienceFields(entityType as never);
  }),
);

router.post(
  '/preview',
  handler(async (req) => {
    const schema = z.object({ entityType: z.enum(AUDIENCE_ENTITY_TYPES), rules: RuleSchema.optional().nullable() });
    const input = schema.parse(req.body);
    return previewAudience(input.entityType, input.rules as never);
  }),
);

router.get(
  '/',
  handler(async (req) => {
    const items = await listAudiences({ kind: str(req.query.kind), entityType: str(req.query.entityType), q: str(req.query.q) });
    return { items, total: items.length };
  }),
);

router.get('/:id', handler(async (req) => loadAudience(req.params.id)));

router.post(
  '/',
  handler(async (req) => {
    const input = AudienceInputSchema.parse(req.body);
    return createAudience(input as never);
  }),
);

router.patch(
  '/:id',
  handler(async (req) => {
    const input = AudienceInputSchema.partial().parse(req.body);
    return updateAudience(req.params.id, input as never);
  }),
);

router.delete('/:id', handler(async (req) => deleteAudience(req.params.id)));

router.post('/:id/evaluate', handler(async (req) => evaluateAudience(req.params.id)));

router.post(
  '/:id/members',
  handler(async (req) => {
    const schema = z.object({ entityType: z.enum(AUDIENCE_ENTITY_TYPES), entityId: z.string() });
    const bodyItems = Array.isArray(req.body) ? req.body : [req.body];
    const items = bodyItems.map((b) => schema.parse(b));
    const created = [];
    for (const item of items) created.push(await addAudienceMember(req.params.id, item.entityType, item.entityId));
    return { created };
  }),
);

router.delete('/:id/members/:memberId', handler(async (req) => removeAudienceMember(req.params.id, req.params.memberId)));

router.post(
  '/:id/suppress',
  handler(async (req) => {
    const schema = z.object({ memberId: z.string(), reason: z.string().optional() });
    const input = schema.parse(req.body);
    return suppressMember(req.params.id, input.memberId, input.reason);
  }),
);

export default router;
