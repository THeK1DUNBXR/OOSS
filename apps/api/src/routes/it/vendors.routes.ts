/**
 * Technology — vendors and contracts (docs/plan/cio.md, workstream C).
 * Mounted at /api/it (this router owns /vendors* and /contracts*).
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, date, numeric } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import {
  createVendor,
  listVendors,
  vendorDetail,
  transitionVendor,
  recordAssessment,
  createVendorContract,
  listVendorContracts,
  vendorContractDetail,
  transitionVendorContract,
  renewVendorContract,
  terminateVendorContract,
  summaryVendors,
  summaryContracts,
} from '../../domains/it/vendors.js';

const router = Router();

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

router.get(
  '/vendors',
  handler(async (req) => {
    return listVendors({
      status: str(req.query.status),
      tier: numeric(req.query.tier),
      riskRating: str(req.query.riskRating),
    });
  }),
);

router.get('/vendors/summary', handler(async () => summaryVendors()));

router.post(
  '/vendors',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        organizationId: z.string().nullish(),
        category: z.string().min(1),
        tier: z.number().int().min(1).max(4).optional(),
        riskRating: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        contactName: z.string().nullish(),
        contactEmail: z.string().nullish(),
        dpaSigned: z.boolean().optional(),
        notes: z.string().nullish(),
      })
      .parse(req.body);
    return createVendor(body);
  }),
);

router.get('/vendors/:id', handler(async (req) => vendorDetail(req.params.id)));

router.post(
  '/vendors/:id/assess',
  handler(async (req) => {
    const body = z
      .object({
        assessedAt: z.string().nullish(),
        assessor: z.string().min(1),
        score: z.number().int().min(0).max(100).nullish(),
        outcome: z.enum(['in_progress', 'passed', 'failed']),
        questionnaire: z.unknown().nullish(),
        notes: z.string().nullish(),
        evidenceDocumentId: z.string().nullish(),
        riskRating: z.enum(['low', 'medium', 'high', 'critical']).nullish(),
      })
      .parse(req.body);
    return recordAssessment(req.params.id, {
      ...body,
      assessedAt: body.assessedAt ? date(body.assessedAt) ?? null : null,
    });
  }),
);

router.post(
  '/vendors/:id/transition',
  handler(async (req) => {
    const body = z
      .object({ event: z.enum(['SUSPEND', 'REINSTATE', 'OFFBOARD']), note: z.string().nullish() })
      .parse(req.body);
    return transitionVendor(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Vendor contracts
// ---------------------------------------------------------------------------

router.get(
  '/contracts',
  handler(async (req) => {
    return listVendorContracts({ status: str(req.query.status), vendorId: str(req.query.vendorId) });
  }),
);

router.get('/contracts/summary', handler(async () => summaryContracts()));

router.post(
  '/contracts',
  handler(async (req) => {
    const body = z
      .object({
        vendorId: z.string().min(1),
        title: z.string().min(1),
        value: z.number().positive(),
        currency: z.string().optional(),
        termMonths: z.number().int().positive().nullish(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        noticeDays: z.number().int().nonnegative().optional(),
        autoRenew: z.boolean().optional(),
        slaText: z.string().nullish(),
        documentId: z.string().nullish(),
      })
      .parse(req.body);
    return createVendorContract({
      ...body,
      startDate: body.startDate ? date(body.startDate) ?? null : null,
      endDate: body.endDate ? date(body.endDate) ?? null : null,
    });
  }),
);

router.get('/contracts/:id', handler(async (req) => vendorContractDetail(req.params.id)));

router.post(
  '/contracts/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        toStatus: z.enum(['draft', 'proposed', 'approved', 'active', 'terminated']),
        note: z.string().optional(),
      })
      .parse(req.body);
    return transitionVendorContract(req.params.id, body.toStatus, body.note ?? '');
  }),
);

router.post(
  '/contracts/:id/renew',
  handler(async (req) => {
    const body = z
      .object({
        endDate: z.string().min(1),
        value: z.number().positive().nullish(),
        startDate: z.string().nullish(),
        noticeDays: z.number().int().nonnegative().nullish(),
        autoRenew: z.boolean().nullish(),
        slaText: z.string().nullish(),
      })
      .parse(req.body);
    const endDate = date(body.endDate);
    if (!endDate) throw ApiError.badRequest('A renewal needs a valid end date.');
    return renewVendorContract(req.params.id, {
      ...body,
      endDate,
      startDate: body.startDate ? date(body.startDate) ?? null : null,
    });
  }),
);

router.post(
  '/contracts/:id/terminate',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1, 'Terminating a vendor contract needs a reason.') }).parse(req.body);
    return terminateVendorContract(req.params.id, body.reason);
  }),
);

export default router;
