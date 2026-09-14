import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listPfRateTables, createPfRateTable,
  listEsiRateTables, createEsiRateTable,
  listPtSlabTables, createPtSlabTable,
  listLwfRateTables, createLwfRateTable,
  listMinimumWageTables, createMinimumWageTable,
  listSalaryStructures, proposeSalaryStructure, approveSalaryStructure,
  computeInstruction,
  listPayslips, getPayslip, payslipDocument,
  exportEcr, exportEsic,
  settleOffboarding,
  setEngagementType, setBankDetails,
} from '../../domains/compliance/payroll.js';

/** Compliance — payroll (docs/plan/compliance.md). Mounted at /api/compliance/payroll. */
const router = Router();

// ---------------------------------------------------------------------------
// Rate tables
// ---------------------------------------------------------------------------

router.get('/rate-tables/pf', handler(async () => listPfRateTables()));
router.post(
  '/rate-tables/pf',
  handler(async (req) => {
    const body = z
      .object({
        effectiveFrom: z.coerce.date(),
        employeeRate: z.number(),
        employerRate: z.number(),
        epsRate: z.number(),
        edliRate: z.number(),
        adminRate: z.number(),
        wageCeiling: z.number(),
        voluntary: z.boolean().optional(),
      })
      .parse(req.body);
    return createPfRateTable(body);
  }),
);

router.get('/rate-tables/esi', handler(async () => listEsiRateTables()));
router.post(
  '/rate-tables/esi',
  handler(async (req) => {
    const body = z
      .object({ effectiveFrom: z.coerce.date(), employeeRate: z.number(), employerRate: z.number(), wageCeiling: z.number() })
      .parse(req.body);
    return createEsiRateTable(body);
  }),
);

router.get('/rate-tables/pt', handler(async () => listPtSlabTables()));
router.post(
  '/rate-tables/pt',
  handler(async (req) => {
    const body = z
      .object({
        state: z.string().optional(),
        effectiveFrom: z.coerce.date(),
        slabs: z.array(z.object({ minGross: z.number(), maxGross: z.number().nullable(), halfYearlyAmount: z.number() })),
        confirmNote: z.string().optional(),
      })
      .parse(req.body);
    return createPtSlabTable(body);
  }),
);

router.get('/rate-tables/lwf', handler(async () => listLwfRateTables()));
router.post(
  '/rate-tables/lwf',
  handler(async (req) => {
    const body = z
      .object({
        state: z.string().optional(),
        effectiveFrom: z.coerce.date(),
        employeeAmount: z.number(),
        employerAmount: z.number(),
        dueMonth: z.number().int().min(1).max(12).optional(),
        confirmNote: z.string().optional(),
      })
      .parse(req.body);
    return createLwfRateTable(body);
  }),
);

router.get('/rate-tables/minimum-wage', handler(async () => listMinimumWageTables()));
router.post(
  '/rate-tables/minimum-wage',
  handler(async (req) => {
    const body = z
      .object({ state: z.string(), category: z.string(), monthlyAmount: z.number(), effectiveFrom: z.coerce.date() })
      .parse(req.body);
    return createMinimumWageTable(body);
  }),
);

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

router.get('/salary-structures', handler(async (req) => listSalaryStructures(str(req.query.employmentRelationshipId))));
router.post(
  '/salary-structures',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        effectiveFrom: z.coerce.date(),
        ctcAnnual: z.number(),
        basic: z.number(),
        hra: z.number(),
        specialAllowance: z.number().optional(),
        conveyance: z.number().optional(),
        otherAllowances: z.record(z.number()).optional(),
      })
      .parse(req.body);
    return proposeSalaryStructure(body);
  }),
);
router.post('/salary-structures/:id/approve', handler(async (req) => approveSalaryStructure(req.params.id)));

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

router.post('/runs/:id/compute', handler(async (req) => computeInstruction(req.params.id)));
router.get('/runs/:id/ecr', handler(async (req) => {
  const text = await exportEcr(req.params.id);
  return { text };
}));
router.get('/runs/:id/esic', handler(async (req) => {
  const text = await exportEsic(req.params.id);
  return { text };
}));

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

router.get('/payslips', handler(async (req) => listPayslips({ employmentRelationshipId: str(req.query.employmentRelationshipId), payPeriod: str(req.query.payPeriod) })));
router.get('/payslips/:id', handler(async (req) => getPayslip(req.params.id)));
router.get('/payslips/:id/document', handler(async (req) => payslipDocument(req.params.id)));

// ---------------------------------------------------------------------------
// Offboarding settlement
// ---------------------------------------------------------------------------

router.post('/offboarding/:id/settle', handler(async (req) => settleOffboarding(req.params.id)));

// ---------------------------------------------------------------------------
// Engagement type and bank/nominee details
// ---------------------------------------------------------------------------

router.patch(
  '/employees/:id/engagement',
  handler(async (req) => {
    const body = z.object({ engagementType: z.string() }).parse(req.body);
    return setEngagementType(req.params.id, body.engagementType);
  }),
);
router.patch(
  '/employees/:id/bank',
  handler(async (req) => {
    const body = z
      .object({
        bankAccountNumber: z.string().optional(),
        bankIfsc: z.string().optional(),
        bankAccountName: z.string().optional(),
        nomineeName: z.string().optional(),
        nomineeRelationship: z.string().optional(),
        esicNumber: z.string().optional(),
      })
      .parse(req.body);
    return setBankDetails(req.params.id, body);
  }),
);

export default router;
