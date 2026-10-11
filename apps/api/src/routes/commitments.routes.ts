/**
 * Commitment routes (Wave 6, OP:115). Thin zod, then the domain, which owns every rule.
 *
 * Each command is its own POST so the audit trail and the state table name the
 * action a person took, rather than a PATCH whose meaning depends on the body.
 */

import { Router } from 'express';
import { z } from 'zod';
import { COMMITMENT_SOURCE_TYPES, COMMITMENT_STATES } from '../domains/commitments.js';
import {
  cancelCommitment,
  confirmCommitment,
  getCommitment,
  listCommitments,
  markCommitmentMet,
  markCommitmentMissed,
  proposeCommitment,
  reassignCommitment,
} from '../domains/commitments.js';
import { handler, parsePaging, str } from '../lib/http.js';

const router = Router();

const proposeBody = z.object({
  title: z.string().trim().min(1).max(200),
  ownerPartyId: z.string().min(1),
  backupPartyId: z.string().min(1).nullable().optional(),
  nextAction: z.string().trim().max(500).nullable().optional(),
  dueAt: z.coerce.date(),
  sourceType: z.enum(COMMITMENT_SOURCE_TYPES),
  sourceId: z.string().min(1).nullable().optional(),
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
});

const reasonBody = z.object({ reason: z.string().trim().max(1000).nullable().optional() });

router.get(
  '/',
  handler(async (req) => {
    const state = z.enum(COMMITMENT_STATES).optional().parse(str(req.query.state));
    const { page, pageSize } = parsePaging(req);
    return {
      items: await listCommitments({ state, ownerPartyId: str(req.query.ownerPartyId), page, pageSize }),
    };
  }),
);

router.post(
  '/',
  handler(async (req) => {
    const body = proposeBody.parse(req.body);
    return proposeCommitment({ ...body, backupPartyId: body.backupPartyId ?? null });
  }),
);

router.get(
  '/:id',
  handler(async (req) => getCommitment(req.params.id)),
);

router.post(
  '/:id/confirm',
  handler(async (req) => confirmCommitment(req.params.id)),
);

router.post(
  '/:id/met',
  handler(async (req) => {
    const body = reasonBody.parse(req.body ?? {});
    return markCommitmentMet(req.params.id, body.reason ?? null);
  }),
);

router.post(
  '/:id/missed',
  handler(async (req) => {
    const body = reasonBody.parse(req.body ?? {});
    return markCommitmentMissed(req.params.id, body.reason ?? null);
  }),
);

router.post(
  '/:id/cancel',
  handler(async (req) => {
    const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
    return cancelCommitment(req.params.id, body.reason);
  }),
);

router.post(
  '/:id/reassign',
  handler(async (req) => {
    const body = z
      .object({ ownerPartyId: z.string().min(1), reason: z.string().trim().max(1000).nullable().optional() })
      .parse(req.body);
    return reassignCommitment(req.params.id, body.ownerPartyId, body.reason ?? null);
  }),
);

export default router;
