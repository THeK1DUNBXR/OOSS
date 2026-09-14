import { Router } from 'express';
import { z } from 'zod';
import { handler, str, numeric } from '../../lib/http.js';
import {
  createApplication,
  listApplications,
  applicationDetail,
  updateApplication,
  transitionApplication,
  createLicence,
  listLicences,
  licenceDetail,
  updateSeats,
  proposeRenewal,
  approveRenewal,
  cancelLicence,
  applicationsSummary,
  licencesSummary,
} from '../../domains/it/software.js';

/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B). Mounted at `/` under `/api/it`, so every path here declares
 * its full segment.
 */
const router = Router();

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

router.get(
  '/applications',
  handler(async (req) =>
    listApplications({
      status: str(req.query.status),
      tier: numeric(req.query.tier),
      hosting: str(req.query.hosting),
    }),
  ),
);

router.get('/applications/summary', handler(async () => applicationsSummary()));

router.post(
  '/applications',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        vendorName: z.string().nullish(),
        vendorId: z.string().nullish(),
        category: z.string().min(1),
        tier: z.number().int().min(1).max(4).optional(),
        hosting: z.enum(['saas', 'on_prem', 'cloud']),
        ownerPartyId: z.string().nullish(),
        dataClassificationHandled: z.enum(['internal', 'confidential', 'restricted', 'regulated']).optional(),
        sso: z.boolean().optional(),
        url: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body);
    return createApplication(body);
  }),
);

router.get('/applications/:id', handler(async (req) => applicationDetail(req.params.id)));

router.patch(
  '/applications/:id',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        vendorName: z.string().nullish(),
        vendorId: z.string().nullish(),
        category: z.string().min(1).optional(),
        tier: z.number().int().min(1).max(4).optional(),
        hosting: z.enum(['saas', 'on_prem', 'cloud']).optional(),
        ownerPartyId: z.string().nullish(),
        dataClassificationHandled: z.enum(['internal', 'confidential', 'restricted', 'regulated']).optional(),
        sso: z.boolean().optional(),
        url: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body);
    return updateApplication(req.params.id, body);
  }),
);

router.post(
  '/applications/:id/transition',
  handler(async (req) => {
    const body = z
      .object({ event: z.enum(['ACTIVATE', 'SUNSET', 'RETIRE', 'REJECT']), note: z.string().nullish() })
      .parse(req.body);
    return transitionApplication(req.params.id, body.event, body.note ?? undefined);
  }),
);

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

router.get(
  '/licences',
  handler(async (req) =>
    listLicences({
      status: str(req.query.status),
      applicationId: str(req.query.applicationId),
      view: str(req.query.view) as 'renewing' | 'over_allocated' | 'all' | undefined,
    }),
  ),
);

router.get('/licences/summary', handler(async () => licencesSummary()));

router.post(
  '/licences',
  handler(async (req) => {
    const body = z
      .object({
        applicationId: z.string().min(1),
        kind: z.enum(['per_seat', 'site', 'perpetual', 'usage']),
        seatsPurchased: z.number().int().min(0).optional(),
        seatsInUse: z.number().int().min(0).optional(),
        costPerPeriod: z.number().min(0),
        currency: z.string().optional(),
        billingCycle: z.enum(['monthly', 'quarterly', 'annual', 'one_off']),
        termStart: z.string().nullish(),
        termEnd: z.string().nullish(),
        renewalDate: z.string().nullish(),
        noticeDays: z.number().int().min(0).optional(),
        autoRenew: z.boolean().optional(),
        vendorContractId: z.string().nullish(),
        lastVendorBillId: z.string().nullish(),
      })
      .parse(req.body);
    return createLicence({
      ...body,
      termStart: body.termStart ? new Date(body.termStart) : null,
      termEnd: body.termEnd ? new Date(body.termEnd) : null,
      renewalDate: body.renewalDate ? new Date(body.renewalDate) : null,
    });
  }),
);

router.get('/licences/:id', handler(async (req) => licenceDetail(req.params.id)));

router.post(
  '/licences/:id/seats',
  handler(async (req) => {
    const body = z.object({ seatsInUse: z.number().int().min(0), note: z.string().nullish() }).parse(req.body);
    return updateSeats(req.params.id, body.seatsInUse, body.note ?? undefined);
  }),
);

router.post(
  '/licences/:id/renew',
  handler(async (req) => {
    const body = z
      .object({
        newTermEnd: z.string().min(1),
        newCostPerPeriod: z.number().min(0).optional(),
        newBillingCycle: z.enum(['monthly', 'quarterly', 'annual', 'one_off']).optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return proposeRenewal(req.params.id, {
      newTermEnd: new Date(body.newTermEnd),
      newCostPerPeriod: body.newCostPerPeriod,
      newBillingCycle: body.newBillingCycle,
      note: body.note ?? undefined,
    });
  }),
);

router.post(
  '/licences/:id/approve-renewal',
  handler(async (req) => {
    const body = z.object({ approve: z.boolean().optional(), note: z.string().nullish() }).parse(req.body ?? {});
    return approveRenewal(req.params.id, body.approve ?? true, body.note ?? '');
  }),
);

router.post(
  '/licences/:id/cancel',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1, 'A cancellation needs a reason.') }).parse(req.body);
    return cancelLicence(req.params.id, body.reason);
  }),
);
export default router;
