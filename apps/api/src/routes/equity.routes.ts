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
import {
  createRound, updateRound, listRounds, round, openRound, closeRound, cancelRound,
  proposeConversion, proposeRedemption, proposeBuyback, proposeBonus,
  createRightsOffers, listRightsOffers, acceptRightsOffer, renounceRightsOffer,
  scenarioRound, scenarioWaterfall,
} from '../domains/rounds.js';
import filingsRoutes from './filings.routes.js';

const router = Router();

// ---- Filings, demat, FEMA (phase 6a) -----------------------------------------

router.use('/filings', filingsRoutes);

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
        redemptionTerms: z.record(z.unknown()).nullish(),
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
        redemptionTerms: z.record(z.unknown()).nullish(),
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
        roundId: z.string().nullish(),
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
        roundId: z.string().nullish(),
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

// ---- Rounds (phase 4) ---------------------------------------------------------

const roundKindEnum = z.enum([
  'seed', 'series', 'rights_issue', 'bonus', 'preferential', 'private_placement',
  'sweat_equity', 'esop_top_up', 'buyback', 'capital_reduction', 'conversion',
]);

const roundInputSchema = z.object({
  name: z.string().min(1).optional(),
  kind: roundKindEnum.optional(),
  preMoneyValuation: z.number().nonnegative().nullish(),
  pricePerShareByClass: z.record(z.number()).nullish(),
  valuationId: z.string().nullish(),
  boardResolutionRef: z.string().nullish(),
  shareholderResolutionRef: z.string().nullish(),
  mgt14Srn: z.string().nullish(),
  offerLetterSerial: z.string().nullish(),
  separateBankAccountRef: z.string().nullish(),
  offereeCount: z.number().int().nonnegative().nullish(),
  renunciationAllowed: z.boolean().nullish(),
  sourceOfBonus: z.enum(['free_reserves', 'securities_premium', 'capital_redemption_reserve']).nullish(),
  valuationReportRef: z.string().nullish(),
  tribunalOrderRef: z.string().nullish(),
  notes: z.string().nullish(),
});

router.get('/rounds', handler(async () => ({ items: await listRounds() })));
router.get('/rounds/:id', handler(async (req) => round(req.params.id)));

router.post(
  '/rounds',
  handler(async (req) => {
    const body = roundInputSchema.required({ name: true, kind: true }).parse(req.body);
    return createRound(body);
  }),
);

router.patch('/rounds/:id', handler(async (req) => updateRound(req.params.id, roundInputSchema.parse(req.body))));

router.post('/rounds/:id/open', handler(async (req) => openRound(req.params.id)));
router.post('/rounds/:id/close', handler(async (req) => closeRound(req.params.id)));
router.post('/rounds/:id/cancel', handler(async (req) => cancelRound(req.params.id)));

router.post(
  '/rounds/:id/bonus',
  handler(async (req) => {
    const body = z
      .object({
        shareClassId: z.string(),
        ratioNumerator: z.number().positive(),
        ratioDenominator: z.number().positive(),
        effectiveOn: z.string(),
      })
      .parse(req.body);
    return proposeBonus({ roundId: req.params.id, ...body });
  }),
);

router.post(
  '/rounds/:id/rights',
  handler(async (req) => {
    const body = z
      .object({ shareClassId: z.string(), ratioNumerator: z.number().positive(), ratioDenominator: z.number().positive() })
      .parse(req.body);
    return createRightsOffers({ roundId: req.params.id, ...body });
  }),
);

router.get('/rounds/:id/rights', handler(async (req) => listRightsOffers(req.params.id)));

router.post(
  '/rights/:offerId/accept',
  handler(async (req) => {
    const body = z.object({ roundId: z.string(), count: z.number().positive() }).parse(req.body);
    return acceptRightsOffer(body.roundId, req.params.offerId, body.count);
  }),
);

router.post(
  '/rights/:offerId/renounce',
  handler(async (req) => {
    const body = z.object({ roundId: z.string(), toHolderId: z.string() }).parse(req.body);
    return renounceRightsOffer(body.roundId, req.params.offerId, body.toHolderId);
  }),
);

// ---- Instruments: conversions, redemptions, buy-backs (phase 4) ---------------

router.post(
  '/ledger/conversions',
  handler(async (req) => {
    const body = z
      .object({
        holderId: z.string(),
        fromClassId: z.string(),
        count: z.number().positive(),
        effectiveOn: z.string(),
        roundId: z.string().nullish(),
      })
      .parse(req.body);
    return proposeConversion(body);
  }),
);

router.post(
  '/ledger/redemptions',
  handler(async (req) => {
    const body = z
      .object({
        holderId: z.string(),
        shareClassId: z.string(),
        count: z.number().positive(),
        effectiveOn: z.string(),
        fromReserves: z.boolean(),
        roundId: z.string().nullish(),
      })
      .parse(req.body);
    return proposeRedemption(body);
  }),
);

router.post(
  '/ledger/buybacks',
  handler(async (req) => {
    const body = z
      .object({
        roundId: z.string(),
        holderId: z.string(),
        shareClassId: z.string(),
        count: z.number().positive(),
        pricePerShare: z.number().nonnegative(),
        effectiveOn: z.string(),
      })
      .parse(req.body);
    return proposeBuyback(body);
  }),
);

// ---- Scenarios (phase 4) — computed live, never persisted (EQT-RND-008) -------

router.post(
  '/scenarios/round',
  handler(async (req) => {
    const body = z
      .object({
        newMoney: z.number().nonnegative(),
        preMoney: z.number().nonnegative(),
        newClass: z.object({
          name: z.string().min(1),
          liquidationPreferenceMultiple: z.number().nonnegative(),
          participating: z.boolean(),
          seniority: z.number().int(),
        }),
        optionPoolTopUpPct: z.number().nonnegative().max(100).optional(),
      })
      .parse(req.body);
    return scenarioRound(body);
  }),
);

router.post(
  '/scenarios/waterfall',
  handler(async (req) => {
    const body = z.object({ exitValue: z.number().nonnegative() }).parse(req.body);
    return scenarioWaterfall(body.exitValue);
  }),
);

export default router;
