import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  computeVendorTds,
  waiveVendorTds,
  listVendorBillsForTds,
  tdsSectionRates,
  listApplicabilityRules,
  setApplicabilityRule,
  setMsmeTerms,
  msmeExposure,
  listChallans,
  createChallan,
  markChallanPaid,
  upsertDeclaration,
  salaryProjection,
  applySalaryTds,
  advanceTaxEstimateFor,
  recordAdvanceTaxPayment,
  prepareTdsReturn,
  fileTdsReturn,
  listTdsReturns,
  tdsReturnDetail,
  exportTdsReturnCsv,
  issueCertificate,
  listCertificates,
  certificateDocument,
  fyOf,
  type Quarter,
} from '../../domains/compliance/tax.js';
import { profitAndLoss } from '../../domains/books.js';

/** Compliance — tax (docs/plan/compliance.md). Mounted at /api/compliance/tax. */
const router = Router();

const TDS_SECTION = z.enum(['194C_IND', '194C_COMP', '194J_PROF', '194J_TECH', '194H', '194I_LAND', '194I_PLANT', '194Q', '192']);
const QUARTER = z.enum(['Q1', 'Q2', 'Q3', 'Q4']);
const FORM = z.enum(['24Q', '26Q']);
const REGIME = z.enum(['old', 'new']);

// ---- Vendor TDS -------------------------------------------------------------

router.get('/vendor-bills', handler(async (req) => listVendorBillsForTds({ status: str(req.query.status) })));
router.get('/rates', handler(async () => tdsSectionRates()));
router.get('/applicability-rules', handler(async () => listApplicabilityRules()));
router.post(
  '/applicability-rules',
  handler(async (req) => {
    const body = z.object({ categoryId: z.string(), section: TDS_SECTION, active: z.boolean().optional(), note: z.string().nullish() }).parse(req.body);
    return setApplicabilityRule(body);
  }),
);

router.post(
  '/vendor-bills/:id/tds',
  handler(async (req) => {
    const body = z.object({ section: TDS_SECTION, certificateRef: z.string().nullish(), certificateRate: z.number().min(0).max(100).nullish() }).parse(req.body);
    return computeVendorTds(req.params.id, body);
  }),
);

router.post(
  '/vendor-bills/:id/tds/waive',
  handler(async (req) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return waiveVendorTds(req.params.id, body.reason);
  }),
);

router.post(
  '/vendor-bills/:id/msme',
  handler(async (req) => {
    const body = z.object({ udyamNumber: z.string().min(1), agreedTermDays: z.number().int().positive().nullish() }).parse(req.body);
    return setMsmeTerms(req.params.id, body);
  }),
);

router.get('/msme/exposure', handler(async () => msmeExposure()));

// ---- Challans -----------------------------------------------------------

router.get('/challans', handler(async (req) => listChallans({ month: str(req.query.month), status: str(req.query.status) })));
router.post(
  '/challans',
  handler(async (req) => {
    const body = z
      .object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        sectionGroup: z.string().min(1),
        amount: z.number().nonnegative().optional(),
        bsrCode: z.string().nullish(),
        challanNo: z.string().nullish(),
      })
      .parse(req.body);
    return createChallan(body);
  }),
);
router.post(
  '/challans/:id/paid',
  handler(async (req) => {
    const body = z.object({ bsrCode: z.string().min(1), challanNo: z.string().min(1), paidOn: z.coerce.date() }).parse(req.body);
    return markChallanPaid(req.params.id, body);
  }),
);

// ---- Salary TDS -----------------------------------------------------------

router.post(
  '/salary/:employmentId/declaration',
  handler(async (req) => {
    const body = z.object({ fy: z.string(), regime: REGIME, declaredDeductions: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return upsertDeclaration(req.params.employmentId, body);
  }),
);
router.get('/salary/:employmentId/projection', handler(async (req) => salaryProjection(req.params.employmentId, str(req.query.fy))));
router.post('/salary/apply/:payrollRunId', handler(async (req) => applySalaryTds(req.params.payrollRunId)));

// ---- Advance tax ------------------------------------------------------------

router.get(
  '/advance-tax/:fy',
  handler(async (req) => advanceTaxEstimateFor(req.params.fy, profitAndLoss)),
);
router.post(
  '/advance-tax/:fy/payments',
  handler(async (req) => {
    const body = z.object({ instalmentDate: z.coerce.date(), amount: z.number().positive(), paidOn: z.coerce.date(), reference: z.string().nullish() }).parse(req.body);
    return recordAdvanceTaxPayment({ fy: req.params.fy, ...body });
  }),
);

// ---- Returns ----------------------------------------------------------------

router.get('/returns', handler(async (req) => listTdsReturns({ fy: str(req.query.fy), form: str(req.query.form) })));
router.get('/returns/:id', handler(async (req) => tdsReturnDetail(req.params.id)));
router.post(
  '/returns/prepare',
  handler(async (req) => {
    const body = z.object({ fy: z.string(), quarter: QUARTER, form: FORM }).parse(req.body);
    return prepareTdsReturn(body.fy, body.quarter as Quarter, body.form);
  }),
);
router.post(
  '/returns/:id/file',
  handler(async (req) => {
    const body = z.object({ ack: z.string().min(1) }).parse(req.body);
    return fileTdsReturn(req.params.id, body.ack);
  }),
);
router.get(
  '/returns/:id/export',
  handler(async (req, res) => {
    const csv = await exportTdsReturnCsv(req.params.id);
    res.setHeader('content-type', 'text/csv');
    res.send(csv);
  }),
);

// ---- Certificates -------------------------------------------------------------

router.get('/certificates', handler(async (req) => listCertificates({ form: str(req.query.form), fy: str(req.query.fy) })));
router.post(
  '/certificates',
  handler(async (req) => {
    const body = z.object({ form: z.enum(['16', '16A']), deducteeRef: z.string().min(1), fy: z.string(), quarter: QUARTER.nullish() }).parse(req.body);
    return issueCertificate({ ...body, quarter: (body.quarter as Quarter | null) ?? null });
  }),
);
router.get('/certificates/:id/document', handler(async (req) => certificateDocument(req.params.id)));

// ---- Misc -------------------------------------------------------------------

router.get('/current-fy', handler(async () => ({ fy: fyOf(new Date()) })));

export default router;
