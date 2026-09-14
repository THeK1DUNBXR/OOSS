/**
 * HCM — payrollops (docs/hcm/payrollops.md). Mounted at /api/hcm/payrollops.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listPayItems, createPayItem, setPayItemActive,
  listAdHocPayLines, createAdHocPayLine, approveAdHocPayLine, rejectAdHocPayLine,
  listArrears, createArrear, approveArrear, rejectArrear, markArrearPaid,
  listPayrollJournals, getPayrollJournal, generatePayrollJournal, postPayrollJournal,
  listBankAdvices, getBankAdvice, generateBankAdvice,
  listPayrollReconciliations, getPayrollReconciliation, generatePayrollReconciliation,
  listPayrollCalendar, upsertPayrollCalendarEntry,
  listPayrollQueries, createPayrollQuery, respondToPayrollQuery, closePayrollQuery,
} from '../../domains/hcm/payrollops.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'payrollops', ready: true })));

// ---------------------------------------------------------------------------
// Pay items
// ---------------------------------------------------------------------------

router.get('/pay-items', handler(async () => listPayItems()));
router.post(
  '/pay-items',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        kind: z.string(),
        taxable: z.boolean().optional(),
        statutoryBasis: z.boolean().optional(),
        glAccountCode: z.string().min(1),
      })
      .parse(req.body);
    return createPayItem(body);
  }),
);
router.patch(
  '/pay-items/:id/active',
  handler(async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    return setPayItemActive(req.params.id, body.active);
  }),
);

// ---------------------------------------------------------------------------
// Ad-hoc pay
// ---------------------------------------------------------------------------

router.get(
  '/adhoc-pay',
  handler(async (req) =>
    listAdHocPayLines({
      payPeriod: str(req.query.payPeriod),
      employmentRelationshipId: str(req.query.employmentRelationshipId),
      status: str(req.query.status),
    }),
  ),
);
router.post(
  '/adhoc-pay',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        payItemId: z.string(),
        payPeriod: z.string(),
        amount: z.number().positive(),
        reason: z.string().min(1),
      })
      .parse(req.body);
    return createAdHocPayLine(body);
  }),
);
router.post('/adhoc-pay/:id/approve', handler(async (req) => approveAdHocPayLine(req.params.id, str(req.body?.note))));
router.post('/adhoc-pay/:id/reject', handler(async (req) => rejectAdHocPayLine(req.params.id, str(req.body?.note))));

// ---------------------------------------------------------------------------
// Arrears
// ---------------------------------------------------------------------------

router.get(
  '/arrears',
  handler(async (req) => listArrears({ employmentRelationshipId: str(req.query.employmentRelationshipId), status: str(req.query.status) })),
);
router.post(
  '/arrears',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        fromPeriod: z.string(),
        amount: z.number().positive(),
        reason: z.string().min(1),
      })
      .parse(req.body);
    return createArrear(body);
  }),
);
router.post('/arrears/:id/approve', handler(async (req) => approveArrear(req.params.id)));
router.post('/arrears/:id/reject', handler(async (req) => rejectArrear(req.params.id)));
router.post(
  '/arrears/:id/mark-paid',
  handler(async (req) => {
    const body = z.object({ payPeriod: z.string() }).parse(req.body);
    return markArrearPaid(req.params.id, body.payPeriod);
  }),
);

// ---------------------------------------------------------------------------
// Payroll journal
// ---------------------------------------------------------------------------

router.get('/journals', handler(async () => listPayrollJournals()));
router.get('/journals/:id', handler(async (req) => getPayrollJournal(req.params.id)));
router.post(
  '/journals/generate',
  handler(async (req) => {
    const body = z.object({ payrollRunId: z.string() }).parse(req.body);
    return generatePayrollJournal(body.payrollRunId);
  }),
);
router.post(
  '/journals/:id/post',
  handler(async (req) => {
    const body = z.object({ accountId: z.string() }).parse(req.body);
    return postPayrollJournal(req.params.id, body.accountId);
  }),
);

// ---------------------------------------------------------------------------
// Bank advice
// ---------------------------------------------------------------------------

router.get('/bank-advices', handler(async () => listBankAdvices()));
router.get('/bank-advices/:id', handler(async (req) => getBankAdvice(req.params.id)));
router.post(
  '/bank-advices/generate',
  handler(async (req) => {
    const body = z.object({ payrollRunId: z.string() }).parse(req.body);
    return generateBankAdvice(body.payrollRunId);
  }),
);

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

router.get('/reconciliations', handler(async () => listPayrollReconciliations()));
router.get('/reconciliations/:id', handler(async (req) => getPayrollReconciliation(req.params.id)));
router.post(
  '/reconciliations/generate',
  handler(async (req) => {
    const body = z.object({ payrollRunId: z.string(), previousPayrollRunId: z.string().optional() }).parse(req.body);
    return generatePayrollReconciliation(body.payrollRunId, body.previousPayrollRunId);
  }),
);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

router.get('/calendar', handler(async () => listPayrollCalendar()));
router.post(
  '/calendar',
  handler(async (req) => {
    const body = z
      .object({
        payPeriod: z.string(),
        attendanceLockAt: z.coerce.date(),
        inputFreezeAt: z.coerce.date(),
        runByAt: z.coerce.date(),
        approveByAt: z.coerce.date(),
        payDate: z.coerce.date(),
        note: z.string().optional(),
      })
      .parse(req.body);
    return upsertPayrollCalendarEntry(body);
  }),
);

// ---------------------------------------------------------------------------
// Payroll queries
// ---------------------------------------------------------------------------

router.get('/queries', handler(async (req) => listPayrollQueries({ status: str(req.query.status), employmentRelationshipId: str(req.query.employmentRelationshipId) })));
router.post(
  '/queries',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        payslipId: z.string().optional(),
        payPeriod: z.string(),
        subject: z.string().min(1),
        message: z.string().min(1),
      })
      .parse(req.body);
    return createPayrollQuery(body);
  }),
);
router.post(
  '/queries/:id/respond',
  handler(async (req) => {
    const body = z.object({ response: z.string().min(1), close: z.boolean().optional() }).parse(req.body);
    return respondToPayrollQuery(req.params.id, body.response, body.close ?? false);
  }),
);
router.post('/queries/:id/close', handler(async (req) => closePayrollQuery(req.params.id)));

export default router;
