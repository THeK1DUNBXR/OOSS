/**
 * HCM — workflow (docs/hcm/workflow.md). Mounted at /api/hcm/workflow.
 *
 * The generic HR request & approval engine other workstreams reach by id
 * only. `/inbox` and `/:id/decide` are what `/people/approvals` and the
 * `RequestInbox` component call.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, bool } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  listRequestTypes,
  createRequestType,
  submitRequest,
  getRequest,
  listMyRequests,
  listInbox,
  decide,
  withdrawRequest,
  listDelegations,
  createDelegation,
  revokeDelegation,
} from '../../domains/hcm/workflow.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'workflow', ready: true })));

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

router.get('/request-types', handler(async (req) => listRequestTypes(bool(req.query.activeOnly))));

const chainStepSchema = z.object({
  level: z.number().int().positive(),
  resolver: z.enum(['manager', 'hr_grant', 'finance_grant', 'specific']),
  partyId: z.string().optional(),
});

router.post(
  '/request-types',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        approvalChain: z.array(chainStepSchema).min(1),
        slaHours: z.number().int().positive().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid request type payload.', body.error.flatten());
    return createRequestType(body.data);
  }),
);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

router.get('/requests/mine', handler(async () => listMyRequests()));

router.get('/requests/:id', handler(async (req) => getRequest(req.params.id)));

router.post(
  '/requests',
  handler(async (req) => {
    const body = z
      .object({
        typeId: z.string().min(1),
        subjectEmploymentId: z.string().min(1),
        payload: z.unknown().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid request payload.', body.error.flatten());
    return submitRequest({ ...body.data, payload: body.data.payload ?? {} });
  }),
);

router.post('/requests/:id/withdraw', handler(async (req) => withdrawRequest(req.params.id)));

router.post(
  '/requests/:id/decide',
  handler(async (req) => {
    const body = z.object({ approve: z.boolean(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('A decision needs `approve` (boolean).', body.error.flatten());
    return decide(req.params.id, body.data.approve, body.data.note);
  }),
);

// ---------------------------------------------------------------------------
// Inbox — what /people/approvals and RequestInbox.tsx render.
// ---------------------------------------------------------------------------

router.get('/inbox', handler(async (req) => listInbox(str(req.query.forParty))));

// ---------------------------------------------------------------------------
// Delegation of authority
// ---------------------------------------------------------------------------

router.get('/delegations', handler(async () => listDelegations()));

router.post(
  '/delegations',
  handler(async (req) => {
    const body = z
      .object({
        toPartyId: z.string().min(1),
        fromDate: z.string().min(1),
        toDate: z.string().min(1),
        scope: z.enum(['all', 'manager', 'hr_grant', 'finance_grant']).optional(),
        note: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw ApiError.badRequest('Invalid delegation payload.', body.error.flatten());
    return createDelegation({
      toPartyId: body.data.toPartyId,
      fromDate: new Date(body.data.fromDate),
      toDate: new Date(body.data.toDate),
      scope: body.data.scope,
      note: body.data.note,
    });
  }),
);

router.post('/delegations/:id/revoke', handler(async (req) => revokeDelegation(req.params.id)));

export default router;
