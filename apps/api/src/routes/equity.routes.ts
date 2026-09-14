/**
 * The register's routes. Thin zod → domain, mounted at `/equity` under
 * `requireAuth` in `routes/index.ts`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../lib/http.js';
import {
  createShareClass, updateShareClass, listShareClasses,
  createHolder, updateHolder, listHolders, holder,
  proposeAllotment, proposeTransfer, approveShareTransaction, rejectShareTransaction,
  makeEffective, reverseShareTransaction, listShareLedger,
  capTable, holdingsFor,
  certificate, certificateDocument, listCertificates,
  recordValuation, listValuations,
  publishDocument, listDocuments,
} from '../domains/equity.js';

const router = Router();

// ---- Share classes ---------------------------------------------------------

router.get('/share-classes', handler(async () => ({ items: await listShareClasses() })));

router.post(
  '/share-classes',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(['equity', 'preference', 'debenture']),
        instrument: z.enum([
          'equity', 'sweat_equity', 'ccps', 'ocps', 'rps', 'ccd', 'ocd', 'ncd',
          'convertible_note', 'warrant', 'option', 'phantom',
        ]),
        faceValue: z.number().nonnegative(),
        votesPerShare: z.number().positive().optional(),
        rights: z.record(z.unknown()).optional(),
        conversionTerms: z.record(z.unknown()).nullish(),
        authorisedCount: z.number().nonnegative().nullish(),
      })
      .parse(req.body);
    return createShareClass(body);
  }),
);

router.patch(
  '/share-classes/:id',
  handler(async (req) => {
    const body = z
      .object({
        rights: z.record(z.unknown()).optional(),
        conversionTerms: z.record(z.unknown()).nullish(),
        authorisedCount: z.number().nonnegative().nullish(),
        status: z.enum(['active', 'closed']).optional(),
      })
      .parse(req.body);
    return updateShareClass(req.params.id, body);
  }),
);

// ---- Holders ----------------------------------------------------------------

router.get('/holders', handler(async () => ({ items: await listHolders() })));
router.get('/holders/:id', handler(async (req) => holder(req.params.id)));

router.post(
  '/holders',
  handler(async (req) => {
    const body = z
      .object({
        kind: z.enum(['person', 'organization', 'entity']),
        personId: z.string().optional(),
        organizationId: z.string().optional(),
        heldByTenantId: z.string().optional(),
        person: z.object({ fullName: z.string().min(1), email: z.string().nullish(), phone: z.string().nullish() }).optional(),
        residency: z.enum(['resident', 'non_resident']).optional(),
        investmentBasis: z.enum(['repatriable', 'non_repatriable']).nullish(),
        panNumber: z.string().nullish(),
        nominee: z.record(z.unknown()).nullish(),
        jointHolders: z.array(z.unknown()).nullish(),
      })
      .parse(req.body);
    return createHolder(body);
  }),
);

router.patch(
  '/holders/:id',
  handler(async (req) => {
    const body = z
      .object({
        residency: z.enum(['resident', 'non_resident']).optional(),
        investmentBasis: z.enum(['repatriable', 'non_repatriable']).nullish(),
        panNumber: z.string().nullish(),
        nominee: z.record(z.unknown()).nullish(),
        jointHolders: z.array(z.unknown()).nullish(),
        status: z.enum(['active', 'ceased']).optional(),
      })
      .parse(req.body);
    return updateHolder(req.params.id, body);
  }),
);

// ---- The ledger ---------------------------------------------------------------

router.get('/ledger', handler(async () => ({ items: await listShareLedger() })));

router.post(
  '/ledger/allotments',
  handler(async (req) => {
    const body = z
      .object({
        shareClassId: z.string(),
        toHolderId: z.string(),
        count: z.number().positive(),
        pricePerShare: z.number().nonnegative().nullish(),
        effectiveOn: z.string(),
        considerationTransactionId: z.string().nullish(),
        boardResolutionRef: z.string().nullish(),
      })
      .parse(req.body);
    return proposeAllotment(body);
  }),
);

router.post(
  '/ledger/transfers',
  handler(async (req) => {
    const body = z
      .object({
        shareClassId: z.string(),
        fromHolderId: z.string(),
        toHolderId: z.string(),
        count: z.number().positive(),
        pricePerShare: z.number().nonnegative().nullish(),
        effectiveOn: z.string(),
        considerationTransactionId: z.string().nullish(),
      })
      .parse(req.body);
    return proposeTransfer(body);
  }),
);

router.post('/ledger/:id/approve', handler(async (req) => approveShareTransaction(req.params.id)));

router.post(
  '/ledger/:id/reject',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return rejectShareTransaction(req.params.id, body.reason);
  }),
);

router.post('/ledger/:id/effective', handler(async (req) => makeEffective(req.params.id)));

router.post(
  '/ledger/:id/reverse',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return reverseShareTransaction(req.params.id, body.reason);
  }),
);

// ---- Cap table & holdings ------------------------------------------------------

router.get('/cap-table', handler(async (req) => capTable(str(req.query.asOf))));

router.get('/holdings/me', handler(async () => holdingsFor('me')));
router.get('/holdings/:holderId', handler(async (req) => holdingsFor(req.params.holderId)));

// ---- Certificates ----------------------------------------------------------------

router.get('/certificates', handler(async () => ({ items: await listCertificates() })));
router.get('/certificates/:id', handler(async (req) => certificate(req.params.id)));
router.get('/certificates/:id/document', handler(async (req) => certificateDocument(req.params.id)));

// ---- Valuations --------------------------------------------------------------------

router.get('/valuations', handler(async () => ({ items: await listValuations() })));

router.post(
  '/valuations',
  handler(async (req) => {
    const body = z
      .object({
        asOf: z.string(),
        basis: z.enum(['registered_valuer', 'merchant_banker', 'ca_certificate', 'internal', 'round_price']),
        valuerName: z.string().nullish(),
        perShareByClass: z.record(z.number()),
        equityValue: z.number().nonnegative().nullish(),
        reportRef: z.string().nullish(),
        validUntil: z.string().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return recordValuation(body);
  }),
);

// ---- Entity documents ------------------------------------------------------------

router.get('/documents', handler(async (req) => ({ items: await listDocuments(str(req.query.audience)) })));

router.post(
  '/documents',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        kind: z.enum(['certificate', 'resolution', 'valuation_report', 'agreement', 'filing', 'other']),
        audience: z.enum(['shareholders', 'board', 'secretary']),
        fileRef: z.string().min(1),
        relatedType: z.string().nullish(),
        relatedId: z.string().nullish(),
      })
      .parse(req.body);
    return publishDocument(body);
  }),
);

export default router;
