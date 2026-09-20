/**
 * HCM — analytics (docs/hcm/analytics.md). Mounted at /api/hcm/analytics.
 *
 * Every route here is a read (or a CSV export of a read) — there is no
 * lifecycle to transition, so there is no `/:id/transition` pattern in this
 * file the way there is in `hr.routes.ts`.
 */
import { Router } from 'express';
import { handler, numeric } from '../../lib/http.js';
import {
  dashboard,
  headcountTrend,
  headcountBy,
  attritionSummary,
  tenureDistribution,
  absenteeism,
  overtimeHours,
  leaveLiability,
  hiringSummary,
  costPerHire,
  spanOfControl,
  payrollCostTrend,
  trainingSummary,
  genderRatio,
  compRatioDistribution,
  engagementEnps,
  openCasesBySla,
  exportHeadcountRegister,
  exportAttritionReport,
  exportLeaveLiabilityReport,
  exportOvertimeRegister,
  exportTrainingRegister,
} from '../../domains/hcm/analytics.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'analytics', ready: true })));

function months(req: { query: Record<string, unknown> }, fallback: number): number {
  return numeric(req.query.months) ?? fallback;
}

router.get('/dashboard', handler(async (req) => dashboard(months(req, 12))));

router.get('/headcount/trend', handler(async (req) => headcountTrend(months(req, 12))));
router.get('/headcount/by-division', handler(async () => headcountBy('division')));
router.get('/headcount/by-location', handler(async () => headcountBy('location')));
router.get('/tenure', handler(async () => tenureDistribution()));

router.get('/attrition', handler(async (req) => attritionSummary(months(req, 12))));

router.get('/absenteeism', handler(async (req) => absenteeism(months(req, 3))));
router.get('/overtime', handler(async (req) => overtimeHours(months(req, 3))));

router.get('/leave-liability', handler(async () => leaveLiability()));

router.get('/hiring', handler(async (req) => hiringSummary(months(req, 12))));
router.get('/hiring/cost-per-hire', handler(async () => costPerHire()));

router.get('/span-of-control', handler(async () => spanOfControl()));

router.get('/payroll-trend', handler(async (req) => payrollCostTrend(months(req, 12))));

router.get('/training', handler(async (req) => trainingSummary(months(req, 12))));

router.get('/gender-ratio', handler(async () => genderRatio()));
router.get('/comp-ratio', handler(async () => compRatioDistribution()));
router.get('/engagement/enps', handler(async () => engagementEnps()));
router.get('/cases/by-sla', handler(async () => openCasesBySla()));

// ---------------------------------------------------------------------------
// Reports (CSV downloads)
// ---------------------------------------------------------------------------

function downloadCsv(res: { setHeader: (k: string, v: string) => void; send: (body: string) => void }, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.send(csv);
}

router.get(
  '/reports/headcount-register.csv',
  handler(async (_req, res) => {
    const { filename, csv } = await exportHeadcountRegister();
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/reports/attrition.csv',
  handler(async (req, res) => {
    const { filename, csv } = await exportAttritionReport(months(req, 12));
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/reports/leave-liability.csv',
  handler(async (_req, res) => {
    const { filename, csv } = await exportLeaveLiabilityReport();
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/reports/overtime.csv',
  handler(async (req, res) => {
    const { filename, csv } = await exportOvertimeRegister(months(req, 3));
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/reports/training.csv',
  handler(async (req, res) => {
    const { filename, csv } = await exportTrainingRegister(months(req, 12));
    downloadCsv(res, filename, csv);
  }),
);

export default router;
