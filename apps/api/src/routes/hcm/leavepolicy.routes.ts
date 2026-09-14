/**
 * HCM — leavepolicy (docs/hcm/leavepolicy.md). Mounted at /api/hcm/leavepolicy.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listLeavePolicies,
  getLeavePolicy,
  createLeavePolicy,
  updateLeavePolicy,
  listPolicyRules,
  createPolicyRule,
  updatePolicyRule,
  deletePolicyRule,
  resolveApplicablePolicy,
  validateLeaveRequest,
  runAccrualForRule,
  listAccrualRuns,
  listApprovalChains,
  createApprovalChain,
  updateApprovalChain,
  deleteApprovalChain,
  initiateApprovalChain,
  listApprovalsForRequest,
  listMyInbox,
  decideApprovalLevel,
  listRestrictedHolidayElections,
  electRestrictedHoliday,
  withdrawRestrictedHolidayElection,
  teamCalendar,
} from '../../domains/hcm/leavepolicy.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'leavepolicy', ready: true })));

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

router.get('/policies', handler(async (req) => listLeavePolicies({ status: str(req.query.status) })));

router.post(
  '/policies',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().nullish(),
        engagementTypes: z.array(z.string()).optional(),
        orgUnitIds: z.array(z.string()).optional(),
        gradeCodes: z.array(z.string()).optional(),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return createLeavePolicy(body);
  }),
);

router.get(
  '/policies/applicable',
  handler(async (req) => {
    const employmentRelationshipId = str(req.query.employmentRelationshipId);
    const leaveTypeId = str(req.query.leaveTypeId);
    if (!employmentRelationshipId || !leaveTypeId) {
      return null;
    }
    return resolveApplicablePolicy(employmentRelationshipId, leaveTypeId);
  }),
);

router.get('/policies/:id', handler(async (req) => getLeavePolicy(req.params.id)));

router.patch(
  '/policies/:id',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().nullish(),
        engagementTypes: z.array(z.string()).optional(),
        orgUnitIds: z.array(z.string()).optional(),
        gradeCodes: z.array(z.string()).optional(),
        effectiveFrom: z.coerce.date().optional(),
        effectiveTo: z.coerce.date().nullish(),
        status: z.string().optional(),
      })
      .parse(req.body);
    return updateLeavePolicy(req.params.id, body);
  }),
);

router.get('/policies/:id/rules', handler(async (req) => listPolicyRules(req.params.id)));

const ruleBody = z.object({
  leaveTypeId: z.string(),
  accrualFrequency: z.string().optional(),
  accrualDays: z.number().optional(),
  prorateOnJoin: z.boolean().optional(),
  maxBalanceDays: z.number().nullish(),
  carryForwardCapDays: z.number().nullish(),
  negativeAllowed: z.boolean().optional(),
  minNoticeDays: z.number().int().optional(),
  maxConsecutiveDays: z.number().int().nullish(),
  sandwichRule: z.boolean().optional(),
  requiresDocumentAfterDays: z.number().int().nullish(),
  applicableGender: z.string().nullish(),
});

router.post(
  '/policies/:id/rules',
  handler(async (req) => createPolicyRule(req.params.id, ruleBody.parse(req.body))),
);

router.patch(
  '/rules/:id',
  handler(async (req) => updatePolicyRule(req.params.id, ruleBody.partial().parse(req.body))),
);

router.delete('/rules/:id', handler(async (req) => deletePolicyRule(req.params.id)));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

router.post(
  '/validate',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        leaveTypeId: z.string(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        hasDocument: z.boolean().optional(),
        gender: z.string().nullish(),
      })
      .parse(req.body);
    return validateLeaveRequest(body);
  }),
);

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

router.post(
  '/accrual-runs',
  handler(async (req) => {
    const body = z.object({ leavePolicyRuleId: z.string(), period: z.string() }).parse(req.body);
    return runAccrualForRule(body.leavePolicyRuleId, body.period);
  }),
);

router.get(
  '/accrual-runs',
  handler(async (req) =>
    listAccrualRuns({ leavePolicyRuleId: str(req.query.leavePolicyRuleId), period: str(req.query.period) }),
  ),
);

// ---------------------------------------------------------------------------
// Approval chains
// ---------------------------------------------------------------------------

router.get('/approval-chains', handler(async () => listApprovalChains()));

router.post(
  '/approval-chains',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        leavePolicyId: z.string().nullish(),
        levels: z.array(z.record(z.unknown())),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    return createApprovalChain(body);
  }),
);

router.patch(
  '/approval-chains/:id',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        levels: z.array(z.record(z.unknown())).optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    return updateApprovalChain(req.params.id, body);
  }),
);

router.delete('/approval-chains/:id', handler(async (req) => deleteApprovalChain(req.params.id)));

router.post(
  '/leave-requests/:id/initiate-chain',
  handler(async (req) => {
    const body = z.object({ chainId: z.string().optional() }).parse(req.body ?? {});
    return initiateApprovalChain(req.params.id, body.chainId);
  }),
);

router.get('/leave-requests/:id/approvals', handler(async (req) => listApprovalsForRequest(req.params.id)));

router.get('/approvals/inbox', handler(async () => listMyInbox()));

router.post(
  '/approvals/:id/decide',
  handler(async (req) => {
    const body = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }).parse(req.body);
    return decideApprovalLevel(req.params.id, body.decision, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Restricted holiday elections
// ---------------------------------------------------------------------------

router.get(
  '/restricted-holiday-elections',
  handler(async (req) => {
    const employmentRelationshipId = str(req.query.employmentRelationshipId);
    if (!employmentRelationshipId) return [];
    return listRestrictedHolidayElections(employmentRelationshipId);
  }),
);

router.post(
  '/restricted-holiday-elections',
  handler(async (req) => {
    const body = z
      .object({ employmentRelationshipId: z.string(), holidayId: z.string(), fy: z.string() })
      .parse(req.body);
    return electRestrictedHoliday(body);
  }),
);

router.delete('/restricted-holiday-elections/:id', handler(async (req) => withdrawRestrictedHolidayElection(req.params.id)));

// ---------------------------------------------------------------------------
// Team calendar
// ---------------------------------------------------------------------------

router.get(
  '/team-calendar',
  handler(async (req) => {
    const month = str(req.query.month) ?? new Date().toISOString().slice(0, 7);
    return teamCalendar(month, str(req.query.orgUnitId));
  }),
);

export default router;
