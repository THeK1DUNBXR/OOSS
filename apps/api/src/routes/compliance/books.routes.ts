/**
 * Compliance — books and audit (docs/plan/compliance.md, D). Mounted at
 * /api/compliance/books.
 */

import { Router } from 'express';
import { z } from 'zod';
import { handler, str, date, numeric } from '../../lib/http.js';
import { assertCan } from '../../platform/permissions.js';
import { currentAuth } from '../../platform/context.js';
import {
  listPeriods,
  requestClosePeriod,
  closePeriod,
  reopenPeriod,
  verifyAuditChain,
  retentionReport,
  sweepRetention,
  statementForFy,
  depreciationReport,
  trialBalance,
  trialBalanceCsv,
  generalLedgerCsv,
  tallyExportXml,
  importBankStatement,
  matchBankLines,
  reconciliationReport,
} from '../../domains/compliance/books.js';
import { auditExport } from '../../platform/audit.js';

const router = Router();

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a period as YYYY-MM');

// ---------------------------------------------------------------------------
// Accounting periods
// ---------------------------------------------------------------------------

router.get('/periods', handler(async (req) => listPeriods(str(req.query.fy))));

router.post(
  '/periods/:period/request-close',
  handler(async (req) => {
    period.parse(req.params.period);
    return requestClosePeriod(req.params.period);
  }),
);

router.post(
  '/periods/:period/close',
  handler(async (req) => {
    period.parse(req.params.period);
    return closePeriod(req.params.period);
  }),
);

router.post(
  '/periods/:period/reopen',
  handler(async (req) => {
    period.parse(req.params.period);
    const body = z.object({ reason: z.string().min(1, 'Reopening a closed period needs a reason.') }).parse(req.body);
    return reopenPeriod(req.params.period, body.reason);
  }),
);

// ---------------------------------------------------------------------------
// Audit chain
// ---------------------------------------------------------------------------

router.get(
  '/audit/verify',
  handler(async (req) => {
    const auth = currentAuth();
    const from = str(req.query.from);
    const to = str(req.query.to);
    return verifyAuditChain(auth.tenantId, 10_000, from ? new Date(from) : undefined, to ? new Date(to) : undefined);
  }),
);

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

router.get('/retention', handler(async () => retentionReport()));

/** Runs the sweep on demand rather than only waiting for the monthly job — useful right after seeding a demo dataset. */
router.post(
  '/retention/sweep',
  handler(async () => {
    await assertCan({ resource: 'audit', verb: 'view' });
    const flagged = await sweepRetention();
    return { flagged };
  }),
);

// ---------------------------------------------------------------------------
// Schedule III statements
// ---------------------------------------------------------------------------

router.get(
  '/statements/:fy',
  handler(async (req) => {
    const fyStartYear = numeric(req.params.fy);
    if (!fyStartYear) throw new Error('fy must be the FY start year, e.g. 2025 for FY2025-26.');
    return statementForFy(fyStartYear);
  }),
);

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

router.get(
  '/depreciation/:fy',
  handler(async (req) => {
    const fyStartYear = numeric(req.params.fy);
    if (!fyStartYear) throw new Error('fy must be the FY start year, e.g. 2025 for FY2025-26.');
    return depreciationReport(fyStartYear);
  }),
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

router.get(
  '/trial-balance/:asOf',
  handler(async (req, res) => {
    const asOf = date(req.params.asOf) ?? new Date();
    if (str(req.query.format) === 'csv') {
      const csv = await trialBalanceCsv(asOf);
      await auditExport('transaction', `trial-balance:${req.params.asOf}`, csv.split('\n').length - 1);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="trial-balance-${req.params.asOf}.csv"`);
      res.send(csv);
      return undefined;
    }
    const tb = await trialBalance(asOf);
    await auditExport('transaction', `trial-balance:${req.params.asOf}`, tb.rows.length);
    return tb;
  }),
);

router.get(
  '/general-ledger',
  handler(async (req, res) => {
    const from = date(req.query.from) ?? new Date(0);
    const to = date(req.query.to) ?? new Date();
    const accountId = str(req.query.accountId);
    const csv = await generalLedgerCsv({ from, to, accountId });
    await auditExport('transaction', `general-ledger:${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`, csv.split('\n').length - 1);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="general-ledger.csv"');
    res.send(csv);
    return undefined;
  }),
);

router.get(
  '/tally-export',
  handler(async (req, res) => {
    const from = date(req.query.from) ?? new Date(0);
    const to = date(req.query.to) ?? new Date();
    const { xml, count } = await tallyExportXml({ from, to });
    await auditExport('transaction', `tally-export:${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`, count);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="tally-export.xml"');
    res.send(xml);
    return undefined;
  }),
);

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

router.post(
  '/bank/:accountId/statement',
  handler(async (req) => {
    const body = z
      .object({
        rows: z
          .array(
            z.object({
              date: z.coerce.date(),
              amount: z.number().positive(),
              direction: z.enum(['in', 'out']),
              reference: z.string().nullish(),
              narration: z.string().nullish(),
            }),
          )
          .min(1),
      })
      .parse(req.body);
    return importBankStatement(req.params.accountId, body.rows);
  }),
);

router.post('/bank/:accountId/match', handler(async (req) => matchBankLines(req.params.accountId)));

router.get('/bank/:accountId/reconciliation', handler(async (req) => reconciliationReport(req.params.accountId)));

export default router;
