/**
 * HCM — compensation (docs/hcm/compensation.md). Mounted at /api/hcm/compensation.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  myEmploymentId,
  listPayGrades, createPayGrade, updatePayGrade, compaRatioFor,
  listRevisionCycles, getRevisionCycle, createRevisionCycle, addRevisionLine, listRevisionLines,
  proposeCycle, approveRevisionLine, rejectRevisionLine, approveCycle, applyCycle, myRevisionLines,
  listVariablePayPlans, createVariablePayPlan, computePayout, listVariablePayouts, approvePayout, markPayoutPaid,
  listBenefitPlans, createBenefitPlan, enrolInBenefit, cancelBenefitEnrollment, listMyBenefitEnrollments, listBenefitEnrollments,
  scheduleFor, requestLoan, listLoans, approveLoan, rejectLoan, disburseLoan, recordLoanRepayment,
  submitExpenseClaim, listExpenseClaims, approveExpenseClaim, rejectExpenseClaim, reimburseExpenseClaim,
} from '../../domains/hcm/compensation.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'compensation', ready: true })));

router.get('/my-employment', handler(async () => ({ employmentRelationshipId: await myEmploymentId() })));

// ---------------------------------------------------------------------------
// Pay grades
// ---------------------------------------------------------------------------

const payGradeBody = z.object({
  code: z.string().min(1),
  level: z.number().int(),
  minPay: z.number().nonnegative(),
  midPay: z.number().nonnegative(),
  maxPay: z.number().nonnegative(),
  currency: z.string().optional(),
  note: z.string().nullable().optional(),
});

router.get('/pay-grades', handler(async () => listPayGrades()));
router.post('/pay-grades', handler(async (req) => createPayGrade(payGradeBody.parse(req.body))));
router.patch('/pay-grades/:id', handler(async (req) => updatePayGrade(req.params.id, payGradeBody.partial().parse(req.body))));
router.get(
  '/pay-grades/:id/compa-ratio/:employmentRelationshipId',
  handler(async (req) => compaRatioFor(req.params.employmentRelationshipId, req.params.id)),
);

// ---------------------------------------------------------------------------
// Salary revision cycles
// ---------------------------------------------------------------------------

router.get('/revision-cycles', handler(async () => listRevisionCycles()));
router.get('/revision-cycles/:id', handler(async (req) => getRevisionCycle(req.params.id)));
router.post(
  '/revision-cycles',
  handler(async (req) => {
    const body = z.object({ name: z.string().min(1), effectiveDate: z.coerce.date(), budgetPct: z.number() }).parse(req.body);
    return createRevisionCycle(body);
  }),
);
router.post('/revision-cycles/:id/propose', handler(async (req) => proposeCycle(req.params.id)));
router.post('/revision-cycles/:id/approve', handler(async (req) => approveCycle(req.params.id)));
router.post('/revision-cycles/:id/apply', handler(async (req) => applyCycle(req.params.id)));

router.get('/revision-cycles/:id/lines', handler(async (req) => listRevisionLines(req.params.id)));
router.post(
  '/revision-cycles/:id/lines',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        currentCtc: z.number().nonnegative(),
        proposedPct: z.number(),
        ratingLink: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .parse(req.body);
    return addRevisionLine({ ...body, cycleId: req.params.id });
  }),
);
router.post(
  '/revision-lines/:id/approve',
  handler(async (req) => {
    const body = z.object({ approvedCtc: z.number().optional(), note: z.string().optional() }).parse(req.body ?? {});
    return approveRevisionLine(req.params.id, body.approvedCtc, body.note);
  }),
);
router.post(
  '/revision-lines/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectRevisionLine(req.params.id, body.note);
  }),
);
router.get('/my-revision-lines/:employmentRelationshipId', handler(async (req) => myRevisionLines(req.params.employmentRelationshipId)));

// ---------------------------------------------------------------------------
// Variable pay
// ---------------------------------------------------------------------------

router.get('/variable-pay-plans', handler(async () => listVariablePayPlans()));
router.post(
  '/variable-pay-plans',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(['bonus', 'commission', 'incentive']),
        period: z.enum(['monthly', 'quarterly', 'annual']),
        formula: z.record(z.any()),
      })
      .parse(req.body);
    return createVariablePayPlan(body as never);
  }),
);
router.get('/variable-payouts', handler(async (req) => listVariablePayouts(str(req.query.employmentRelationshipId))));
router.post(
  '/variable-payouts/compute',
  handler(async (req) => {
    const body = z
      .object({ planId: z.string().min(1), employmentRelationshipId: z.string().min(1), period: z.string().min(1), base: z.number() })
      .parse(req.body);
    return computePayout(body.planId, body.employmentRelationshipId, body.period, body.base);
  }),
);
router.post(
  '/variable-payouts/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return approvePayout(req.params.id, body.note);
  }),
);
router.post('/variable-payouts/:id/pay', handler(async (req) => markPayoutPaid(req.params.id)));

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

router.get('/benefit-plans', handler(async (req) => listBenefitPlans(req.query.activeOnly === 'true')));
router.post(
  '/benefit-plans',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(['health', 'life', 'accident', 'meal', 'fuel', 'nps', 'other']),
        provider: z.string().nullable().optional(),
        employerContribution: z.number().nonnegative(),
        employeeContribution: z.number().nonnegative(),
        enrolmentOpensOn: z.coerce.date().nullable().optional(),
        enrolmentClosesOn: z.coerce.date().nullable().optional(),
      })
      .parse(req.body);
    return createBenefitPlan(body);
  }),
);
router.post(
  '/benefit-plans/:id/enrol',
  handler(async (req) => {
    const body = z.object({ employmentRelationshipId: z.string().min(1), dependants: z.array(z.any()).optional() }).parse(req.body);
    return enrolInBenefit(req.params.id, body.employmentRelationshipId, body.dependants ?? []);
  }),
);
router.get('/benefit-enrollments', handler(async (req) => listBenefitEnrollments(str(req.query.planId))));
router.post('/benefit-enrollments/:id/cancel', handler(async (req) => cancelBenefitEnrollment(req.params.id)));
router.get('/my-benefit-enrollments/:employmentRelationshipId', handler(async (req) => listMyBenefitEnrollments(req.params.employmentRelationshipId)));

// ---------------------------------------------------------------------------
// Employee loans
// ---------------------------------------------------------------------------

router.post(
  '/loans/schedule',
  handler(async (req) => {
    const body = z.object({ principal: z.number(), interestPct: z.number(), tenureMonths: z.number().int() }).parse(req.body);
    return scheduleFor(body.principal, body.interestPct, body.tenureMonths);
  }),
);
router.post(
  '/loans',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        principal: z.number(),
        interestPct: z.number(),
        tenureMonths: z.number().int(),
      })
      .parse(req.body);
    return requestLoan(body);
  }),
);
router.get('/loans', handler(async (req) => listLoans(str(req.query.employmentRelationshipId))));
router.post(
  '/loans/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return approveLoan(req.params.id, body.note);
  }),
);
router.post(
  '/loans/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectLoan(req.params.id, body.note);
  }),
);
router.post(
  '/loans/:id/disburse',
  handler(async (req) => {
    const body = z.object({ startDate: z.coerce.date() }).parse(req.body);
    return disburseLoan(req.params.id, body.startDate);
  }),
);
router.post(
  '/loans/:id/repay',
  handler(async (req) => {
    const body = z.object({ amount: z.number().positive() }).parse(req.body);
    return recordLoanRepayment(req.params.id, body.amount);
  }),
);

// ---------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------

router.post(
  '/expense-claims',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        category: z.enum(['travel', 'food', 'phone', 'other']),
        amount: z.number(),
        receipts: z.array(z.any()).optional(),
        note: z.string().nullable().optional(),
      })
      .parse(req.body);
    return submitExpenseClaim(body);
  }),
);
router.get('/expense-claims', handler(async (req) => listExpenseClaims(str(req.query.employmentRelationshipId))));
router.post(
  '/expense-claims/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return approveExpenseClaim(req.params.id, body.note);
  }),
);
router.post(
  '/expense-claims/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectExpenseClaim(req.params.id, body.note);
  }),
);
router.post(
  '/expense-claims/:id/reimburse',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return reimburseExpenseClaim(req.params.id, body.note);
  }),
);

export default router;
