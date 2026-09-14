import { Router } from 'express';
import { z } from 'zod';
import { DATA_REQUEST_KINDS, BREACH_STATUSES } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import {
  getCurrentNotice,
  publishNotice,
  acknowledgeNotice,
  grantConsent,
  withdrawConsent,
  listConsentsForPerson,
  raiseDataRequest,
  listDataRequests,
  fulfilDataRequest,
  refuseDataRequest,
  raiseBreach,
  transitionBreach,
  listBreaches,
  getRetention,
  runAccessReview,
  backfillEncryptAtRest,
  encryptionStatus,
} from '../../domains/compliance/privacy.js';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { assertCan } from '../../platform/permissions.js';

/** Compliance — privacy (docs/plan/compliance.md §G). Mounted at /api/compliance/privacy. */
const router = Router();

// ---- Notice -----------------------------------------------------------------

router.get('/notice/current', handler(async () => getCurrentNotice()));

router.post(
  '/notice',
  handler(async (req) => {
    const schema = z.object({
      effectiveFrom: z.string(),
      body: z.string(),
      purposes: z.array(
        z.object({
          code: z.string(),
          label: z.string(),
          lawfulBasis: z.enum(['consent', 'legitimate_use', 'legal_obligation']),
          dataCategories: z.array(z.string()),
          retention: z.string(),
        }),
      ),
    });
    const input = schema.parse(req.body);
    return publishNotice({ effectiveFrom: new Date(input.effectiveFrom), body: input.body, purposes: input.purposes });
  }),
);

router.post(
  '/notice/acknowledge',
  handler(async (req) => {
    const schema = z.object({ personId: z.string().optional(), channel: z.string().default('in_app') });
    const input = schema.parse(req.body);
    return acknowledgeNotice(input);
  }),
);

// ---- Consents -----------------------------------------------------------------

router.get(
  '/consents',
  handler(async (req) => {
    const personId = str(req.query.personId) ?? currentAuth().partyId;
    if (!personId) return [];
    return listConsentsForPerson(personId);
  }),
);

router.post(
  '/consents',
  handler(async (req) => {
    const schema = z.object({
      personId: z.string(),
      purposeCode: z.string(),
      channel: z.string(),
      evidence: z.record(z.unknown()).optional(),
      guardianOfPersonId: z.string().optional(),
      expiresAt: z.string().optional(),
    });
    const input = schema.parse(req.body);
    return grantConsent({
      ...input,
      guardianOfPersonId: input.guardianOfPersonId ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
  }),
);

router.post(
  '/consents/:id/withdraw',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().optional() });
    const input = schema.parse(req.body ?? {});
    return withdrawConsent(req.params.id, input.reason);
  }),
);

// ---- Data-principal requests ----------------------------------------------

router.get(
  '/requests',
  handler(async (req) => listDataRequests({ status: str(req.query.status), personId: str(req.query.personId) })),
);

router.post(
  '/requests',
  handler(async (req) => {
    const schema = z.object({
      personId: z.string(),
      kind: z.enum(DATA_REQUEST_KINDS),
      note: z.string().optional(),
    });
    const input = schema.parse(req.body);
    return raiseDataRequest(input);
  }),
);

router.post(
  '/requests/:id/fulfil',
  handler(async (req) => {
    const schema = z.object({ correction: z.record(z.unknown()).optional() });
    const input = schema.parse(req.body ?? {});
    return fulfilDataRequest(req.params.id, input);
  }),
);

router.post(
  '/requests/:id/refuse',
  handler(async (req) => {
    const schema = z.object({ reason: z.string() });
    const input = schema.parse(req.body);
    return refuseDataRequest(req.params.id, input.reason);
  }),
);

// ---- Breach register --------------------------------------------------------

router.get('/breaches', handler(async (req) => listBreaches({ status: str(req.query.status) })));

router.post(
  '/breaches',
  handler(async (req) => {
    const schema = z.object({
      detectedAt: z.string(),
      description: z.string(),
      categories: z.array(z.string()).optional(),
      principalsAffected: z.number().int().min(0).optional(),
      severity: z.string().default('S4_CRITICAL'),
    });
    const input = schema.parse(req.body);
    return raiseBreach({ ...input, detectedAt: new Date(input.detectedAt) });
  }),
);

router.post(
  '/breaches/:id/transition',
  handler(async (req) => {
    const schema = z.object({ status: z.enum(BREACH_STATUSES), notes: z.string().optional() });
    const input = schema.parse(req.body);
    return transitionBreach(req.params.id, input.status, input.notes);
  }),
);

// ---- Retention ---------------------------------------------------------------

router.get('/retention', handler(async () => getRetention()));

// ---- Access review ------------------------------------------------------------

router.get(
  '/access-review',
  handler(async () => {
    await assertCan({ resource: 'data_requests', verb: 'view' });
    const auth = currentAuth();
    return prisma.accessReview.findFirst({ where: { tenantId: auth.tenantId }, orderBy: { generatedAt: 'desc' } });
  }),
);

router.post(
  '/access-review/run',
  handler(async () => {
    await assertCan({ resource: 'data_requests', verb: 'edit' });
    const staleCount = await runAccessReview();
    return { staleCount };
  }),
);

// ---- Encryption at rest --------------------------------------------------------

router.get('/encrypt-at-rest/status', handler(async () => encryptionStatus()));

router.post('/encrypt-at-rest/backfill', handler(async () => backfillEncryptAtRest()));

export default router;
